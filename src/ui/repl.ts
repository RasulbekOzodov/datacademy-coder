import readline from 'node:readline';
import pc from 'picocolors';
import type { Agent, AgentUI } from '../agent/loop.js';
import type { Config } from '../config/schema.js';
import { APP_DISPLAY_NAME, VERSION } from '../constants.js';
import type { PermissionAnswer, PermissionManager, PermissionRequest } from '../permissions/manager.js';
import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import { saveSession } from '../agent/session.js';
import { banner } from './banner.js';
import { COMMAND_NAMES, applySession, commandPalette, handleCommand, pickSession } from './commands.js';
import { StatusLine, colorDiff, indent, out, renderToolResult, renderToolResultBody, renderToolStart } from './render.js';

/** Hidden chars generated after the last visible text before we assume a tool call is being written. */
const HIDDEN_CALL_THRESHOLD = 200;

export class TerminalUI implements AgentUI {
  private status = new StatusLine();
  private lastWasText = false;
  /** Visible response text already streamed for the current model turn. */
  private visible = false;
  private streamedChars = 0;
  private charsAtLastText = 0;

  onTurnStart(): void {
    this.visible = false;
    this.streamedChars = 0;
    this.charsAtLastText = 0;
    this.status.start("o'ylanmoqda");
  }
  onFirstToken(): void {
    this.status.stop();
  }
  onStreamProgress(chars: number): void {
    this.streamedChars = chars;
    const approxTokens = Math.round(chars / 3.5);
    if (!this.visible) {
      // Still nothing on screen (thinking, or a tool call being written from the start).
      if (approxTokens > 0) this.status.update(`yozmoqda… ~${approxTokens} token`);
      return;
    }
    // Text was shown, then the model went quiet: it is writing a hidden <tool_call>
    // (e.g. a whole file into write_file args) — bring the status line back on its own line.
    const hidden = chars - this.charsAtLastText;
    if (hidden > HIDDEN_CALL_THRESHOLD) {
      if (!this.status.isActive) {
        if (this.lastWasText) {
          out('\n');
          this.lastWasText = false;
        }
        this.status.start('tool chaqiruvi yozilmoqda');
      } else {
        this.status.update(`tool chaqiruvi yozilmoqda… ~${Math.round(hidden / 3.5)} token`);
      }
    }
  }
  onText(delta: string): void {
    this.status.stop();
    out(delta);
    this.lastWasText = true;
    this.visible = true;
    this.charsAtLastText = this.streamedChars;
  }
  onThinking(_delta: string): void {
    /* hidden; see --debug logs */
  }
  onResponseEnd(): void {
    this.status.stop();
    if (this.lastWasText) out('\n');
    this.lastWasText = false;
  }
  onToolStart(_call: ToolCall, description: string): void {
    this.status.stop();
    out(`${renderToolStart(description)}\n`);
  }
  onToolExecuting(call: ToolCall): void {
    this.status.start(`${call.name} bajarilmoqda`);
  }
  onToolResult(_call: ToolCall, result: ToolResult, ms: number): void {
    this.status.stop();
    out(`${renderToolResult(result, ms)}\n`);
    const body = renderToolResultBody(result);
    if (body) out(`${body}\n`);
  }
  onInfo(message: string): void {
    this.status.stop();
    out(`${pc.dim(`ℹ ${message}`)}\n`);
  }
  onWarn(message: string): void {
    this.status.stop();
    out(`${pc.yellow(`⚠ ${message}`)}\n`);
  }
}

/**
 * Line reader over readline that queues lines arriving while nobody is waiting (piped stdin,
 * fast typing) and resolves `null` once stdin closes, so prompts never throw.
 */
export class LineReader {
  readonly rl: readline.Interface;
  private queue: string[] = [];
  private waiting?: (line: string | null) => void;
  private closed = false;
  private sigintHandlers: Array<() => void> = [];

  constructor() {
    // crlfDelay: Infinity -> "\r\n" is always one Enter (Windows terminals can otherwise yield an extra empty line).
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
      crlfDelay: Infinity,
      // Tab completion for slash commands.
      completer: (line: string): [string[], string] => {
        if (!line.startsWith('/') || line.includes(' ')) return [[], line];
        const hits = COMMAND_NAMES.filter((n) => `/${n}`.startsWith(line)).map((n) => `/${n} `);
        return [hits, line];
      },
    });
    // "/" palette: as soon as the input is exactly "/", show the command list under the prompt.
    if (process.stdin.isTTY) {
      let shownFor = '';
      process.stdin.on('keypress', () => {
        const line = this.rl.line;
        if (line === '/' && shownFor !== '/') {
          shownFor = '/';
          out(`\n${commandPalette()}\n`);
          this.rl.prompt(true);
        } else if (line !== '/') shownFor = '';
      });
    }
    this.rl.on('line', (line) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w(line);
      } else this.queue.push(line);
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
      for (const h of this.sigintHandlers) h();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onSigint(handler: () => void): void {
    this.sigintHandlers.push(handler);
  }

  /** Drop lines typed before a prompt appeared (they must never answer a permission question). */
  clearQueue(): void {
    this.queue = [];
  }

  /** Show a prompt and wait for one line. Returns null when stdin is closed. */
  ask(prompt: string): Promise<string | null> {
    if (this.queue.length) {
      out(prompt);
      const line = this.queue.shift()!;
      out(`${line}\n`);
      return Promise.resolve(line);
    }
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  close(): void {
    if (!this.closed) this.rl.close();
  }
}

export function makePrompter(reader: LineReader): (req: PermissionRequest) => Promise<PermissionAnswer> {
  return async (req) => {
    out('\n');
    out(`${pc.yellow('?')} ${pc.bold(req.description)}\n`);
    if (req.preview) {
      const isDiff = /^[-+@]/m.test(req.preview);
      out(`${indent(isDiff ? colorDiff(req.preview) : pc.dim(req.preview), '    ')}\n`);
    }
    if (req.dangerous) out(`${pc.red('  This command looks destructive.')}\n`);
    // Only input typed after the question appears may answer it.
    reader.clearQueue();
    for (;;) {
      const raw = await reader.ask(pc.yellow('  Allow? [y] once  [a] always this session  [n] deny: '));
      if (raw === null) return 'deny';
      const a = raw.trim().toLowerCase();
      if (a === 'y' || a === 'yes' || a === 'ha') return 'once';
      if (a === 'a' || a === 'always') return 'always';
      if (a === 'n' || a === 'no' || a === "yo'q" || a === 'yoq') return 'deny';
      out(pc.dim('  please answer y, a or n\n'));
    }
  };
}

export interface ReplOptions {
  agent: Agent;
  config: Config;
  permissions: PermissionManager;
  cwd: string;
  sessionId: string;
  configSources: string[];
  /** Session id to load at start, or 'pick' to show the picker. */
  resume?: string;
}

export async function startRepl(opts: ReplOptions, reader: LineReader): Promise<void> {
  const { agent, config, permissions, cwd } = opts;
  let sessionId = opts.sessionId;
  let createdAt = new Date().toISOString();
  let running: AbortController | undefined;
  let lastSigint = 0;

  const autoSave = () => {
    if (!agent.messages.length) return;
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
    } catch {
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
  if (opts.configSources.length) out(pc.dim(`config: ${opts.configSources.join(', ')}\n`));
  out(pc.dim('type your request, /help for commands, Ctrl+C twice to exit\n\n'));

  const exit = (): never => {
    out('\n');
    reader.close();
    process.exit(0);
  };

  reader.onSigint(() => {
    const now = Date.now();
    if (running) {
      if (now - lastSigint < 2000) exit();
      running.abort();
      out(`\n${pc.yellow('⚠ interrupted (Ctrl+C again to exit)')}\n`);
    } else {
      if (now - lastSigint < 2000) exit();
      out(`\n${pc.dim('(Ctrl+C again to exit)')}\n`);
      reader.rl.prompt();
    }
    lastSigint = now;
  });

  const print = (s: string) => out(`${s}\n`);
  const commandCtx = () => ({
    agent,
    config,
    permissions,
    cwd,
    sessionId,
    print,
    ask: (p: string) => reader.ask(p),
    onSessionLoaded: (id: string) => {
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
      } else print(pc.dim('starting a new conversation'));
    } catch (err) {
      print(pc.red((err as Error).message));
    }
    out('\n');
  }

  for (;;) {
    const line = await reader.ask(pc.bold(pc.green('› ')));
    if (line === null) return exit();
    const input = line.trim();
    if (!input) continue;

    const outcome = await handleCommand(input, commandCtx());
    if (outcome === 'exit') return exit();
    if (outcome === 'handled') {
      out('\n');
      continue;
    }

    running = new AbortController();
    try {
      await agent.run(input, running.signal);
    } catch (err) {
      out(`${pc.red(`✗ ${(err as Error).message}`)}\n`);
      if (config.debug && (err as Error).stack) out(pc.dim(`${(err as Error).stack}\n`));
    } finally {
      running = undefined;
      autoSave();
      out(`${contextLine()}\n\n`);
    }
  }
}
