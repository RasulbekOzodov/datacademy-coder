import readline from 'node:readline';
import pc from 'picocolors';
import { APP_DISPLAY_NAME, VERSION } from '../constants.js';
import { saveSession } from '../agent/session.js';
import { banner } from './banner.js';
import { applySession, handleCommand, pickSession } from './commands.js';
import { Spinner, colorDiff, indent, out, renderToolResult, renderToolResultBody, renderToolStart } from './render.js';
export class TerminalUI {
    spinner = new Spinner();
    lastWasText = false;
    onTurnStart() {
        this.spinner.start('thinking');
    }
    onFirstToken() {
        this.spinner.stop();
    }
    onText(delta) {
        out(delta);
        this.lastWasText = true;
    }
    onThinking(_delta) {
        /* hidden; see --debug logs */
    }
    onResponseEnd() {
        if (this.lastWasText)
            out('\n');
        this.lastWasText = false;
    }
    onToolStart(_call, description) {
        this.spinner.stop();
        out(`${renderToolStart(description)}\n`);
    }
    onToolResult(_call, result, ms) {
        out(`${renderToolResult(result, ms)}\n`);
        const body = renderToolResultBody(result);
        if (body)
            out(`${body}\n`);
    }
    onInfo(message) {
        this.spinner.stop();
        out(`${pc.dim(`ℹ ${message}`)}\n`);
    }
    onWarn(message) {
        this.spinner.stop();
        out(`${pc.yellow(`⚠ ${message}`)}\n`);
    }
}
/**
 * Line reader over readline that queues lines arriving while nobody is waiting (piped stdin,
 * fast typing) and resolves `null` once stdin closes, so prompts never throw.
 */
export class LineReader {
    rl;
    queue = [];
    waiting;
    closed = false;
    sigintHandlers = [];
    constructor() {
        // crlfDelay: Infinity -> "\r\n" is always one Enter (Windows terminals can otherwise yield an extra empty line).
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false, crlfDelay: Infinity });
        this.rl.on('line', (line) => {
            if (this.waiting) {
                const w = this.waiting;
                this.waiting = undefined;
                w(line);
            }
            else
                this.queue.push(line);
        });
        this.rl.on('close', () => {
            this.closed = true;
            if (this.waiting) {
                const w = this.waiting;
                this.waiting = undefined;
                w(null);
            }
        });
        this.rl.on('SIGINT', () => {
            for (const h of this.sigintHandlers)
                h();
        });
    }
    get isClosed() {
        return this.closed;
    }
    onSigint(handler) {
        this.sigintHandlers.push(handler);
    }
    /** Drop lines typed before a prompt appeared (they must never answer a permission question). */
    clearQueue() {
        this.queue = [];
    }
    /** Show a prompt and wait for one line. Returns null when stdin is closed. */
    ask(prompt) {
        if (this.queue.length) {
            out(prompt);
            const line = this.queue.shift();
            out(`${line}\n`);
            return Promise.resolve(line);
        }
        if (this.closed)
            return Promise.resolve(null);
        this.rl.setPrompt(prompt);
        this.rl.prompt();
        return new Promise((resolve) => {
            this.waiting = resolve;
        });
    }
    close() {
        if (!this.closed)
            this.rl.close();
    }
}
export function makePrompter(reader) {
    return async (req) => {
        out('\n');
        out(`${pc.yellow('?')} ${pc.bold(req.description)}\n`);
        if (req.preview) {
            const isDiff = /^[-+@]/m.test(req.preview);
            out(`${indent(isDiff ? colorDiff(req.preview) : pc.dim(req.preview), '    ')}\n`);
        }
        if (req.dangerous)
            out(`${pc.red('  This command looks destructive.')}\n`);
        // Only input typed after the question appears may answer it.
        reader.clearQueue();
        for (;;) {
            const raw = await reader.ask(pc.yellow('  Allow? [y] once  [a] always this session  [n] deny: '));
            if (raw === null)
                return 'deny';
            const a = raw.trim().toLowerCase();
            if (a === 'y' || a === 'yes' || a === 'ha')
                return 'once';
            if (a === 'a' || a === 'always')
                return 'always';
            if (a === 'n' || a === 'no' || a === "yo'q" || a === 'yoq')
                return 'deny';
            out(pc.dim('  please answer y, a or n\n'));
        }
    };
}
export async function startRepl(opts, reader) {
    const { agent, config, permissions, cwd } = opts;
    let sessionId = opts.sessionId;
    let createdAt = new Date().toISOString();
    let running;
    let lastSigint = 0;
    const autoSave = () => {
        if (!agent.messages.length)
            return;
        try {
            saveSession(cwd, {
                id: sessionId,
                createdAt,
                updatedAt: '',
                cwd,
                provider: agent.provider.name,
                model: agent.provider.model,
                toolMode: agent.toolMode,
                messages: agent.messages,
            });
        }
        catch {
            /* saving must never break the REPL */
        }
    };
    const contextLine = () => {
        const est = agent.estimatedTokens();
        const win = agent.provider.contextWindow;
        const pct = Math.round((est / win) * 100);
        const color = pct >= 80 ? pc.red : pct >= 60 ? pc.yellow : pc.dim;
        return color(`ctx ~${est.toLocaleString()}/${win.toLocaleString()} tokens (${pct}%)${pct >= 80 ? ' — /compact tavsiya etiladi' : ''}`);
    };
    out(`\n${banner()}\n`);
    out(`${pc.bold(pc.magenta(APP_DISPLAY_NAME))} ${pc.dim(`v${VERSION}`)}\n`);
    out(pc.dim(`cwd: ${cwd}\n`));
    out(pc.dim(`provider: ${agent.provider.name} · model: ${agent.provider.model} · ctx: ${agent.provider.contextWindow}${permissions.yolo ? ' · yolo' : ''}\n`));
    if (opts.configSources.length)
        out(pc.dim(`config: ${opts.configSources.join(', ')}\n`));
    out(pc.dim('type your request, /help for commands, Ctrl+C twice to exit\n\n'));
    const exit = () => {
        out('\n');
        reader.close();
        process.exit(0);
    };
    reader.onSigint(() => {
        const now = Date.now();
        if (running) {
            if (now - lastSigint < 2000)
                exit();
            running.abort();
            out(`\n${pc.yellow('⚠ interrupted (Ctrl+C again to exit)')}\n`);
        }
        else {
            if (now - lastSigint < 2000)
                exit();
            out(`\n${pc.dim('(Ctrl+C again to exit)')}\n`);
            reader.rl.prompt();
        }
        lastSigint = now;
    });
    const print = (s) => out(`${s}\n`);
    const commandCtx = () => ({
        agent,
        config,
        permissions,
        cwd,
        sessionId,
        print,
        ask: (p) => reader.ask(p),
        onSessionLoaded: (id) => {
            sessionId = id;
            createdAt = new Date().toISOString();
        },
    });
    // --continue / --resume: load a previous conversation before the first prompt.
    if (opts.resume) {
        try {
            const id = opts.resume === 'pick' ? await pickSession(cwd, (p) => reader.ask(p), print) : opts.resume;
            if (id) {
                print(pc.dim(applySession(commandCtx(), id)));
                print(contextLine());
            }
            else
                print(pc.dim('starting a new conversation'));
        }
        catch (err) {
            print(pc.red(err.message));
        }
        out('\n');
    }
    for (;;) {
        const line = await reader.ask(pc.bold(pc.green('› ')));
        if (line === null)
            return exit();
        const input = line.trim();
        if (!input)
            continue;
        const outcome = await handleCommand(input, commandCtx());
        if (outcome === 'exit')
            return exit();
        if (outcome === 'handled') {
            out('\n');
            continue;
        }
        running = new AbortController();
        try {
            await agent.run(input, running.signal);
        }
        catch (err) {
            out(`${pc.red(`✗ ${err.message}`)}\n`);
            if (config.debug && err.stack)
                out(pc.dim(`${err.stack}\n`));
        }
        finally {
            running = undefined;
            autoSave();
            out(`${contextLine()}\n\n`);
        }
    }
}
//# sourceMappingURL=repl.js.map