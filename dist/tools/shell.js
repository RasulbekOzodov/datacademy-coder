import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { optNumber, reqString, tmpDir, truncateText } from './util.js';
const found = new Map();
function onPath(exe) {
    if (found.has(exe))
        return found.get(exe);
    const probe = process.platform === 'win32' ? spawnSync('where', [exe], { windowsHide: true, stdio: 'ignore' }) : spawnSync('which', [exe], { stdio: 'ignore' });
    const ok = probe.status === 0;
    found.set(exe, ok);
    return ok;
}
/**
 * Quick startup probe: some environments (no console, locked-down hosts) make powershell.exe hang.
 * Async so the event loop keeps running (a blocked loop makes HTTP keep-alive sockets go stale).
 */
function shellStarts(exe, args, timeoutMs = 8000) {
    return new Promise((resolve) => {
        let out = '';
        let child;
        try {
            child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        }
        catch {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => {
            killTree(child.pid);
            resolve(false);
        }, timeoutMs);
        child.stdout?.on('data', (d) => (out += d.toString('utf8')));
        child.on('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve(code === 0 && /ok/.test(out));
        });
    });
}
/** Set when `auto` had to fall back to another shell; the CLI shows it once. */
export let shellFallbackNote;
export async function resolveShell(config) {
    let kind;
    if (config.shell === 'auto') {
        if (process.platform === 'win32') {
            if (onPath('pwsh') && (await shellStarts('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'echo ok'])))
                kind = 'pwsh';
            else if (await shellStarts('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'echo ok']))
                kind = 'powershell';
            else {
                kind = 'cmd';
                shellFallbackNote = 'PowerShell did not start within 8s in this environment — using cmd.exe for the shell tool (set "shell" in config to override).';
            }
        }
        else
            kind = 'bash';
    }
    else
        kind = config.shell;
    return shellFor(kind);
}
export function shellFor(kind) {
    switch (kind) {
        case 'pwsh':
        case 'powershell': {
            const exe = kind === 'pwsh' ? 'pwsh' : 'powershell.exe';
            return {
                kind,
                exe,
                displayName: kind === 'pwsh' ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell 5.1',
                buildArgs(command) {
                    const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}\nexit $LASTEXITCODE`;
                    const encoded = Buffer.from(script, 'utf16le').toString('base64');
                    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
                },
            };
        }
        case 'cmd':
            return {
                kind,
                exe: 'cmd.exe',
                displayName: 'Windows cmd.exe',
                // chcp switches the console to UTF-8 so non-ASCII output decodes correctly.
                buildArgs: (command) => ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`],
            };
        case 'bash':
        default:
            return { kind: 'bash', exe: 'bash', displayName: 'bash', buildArgs: (command) => ['-lc', command] };
    }
}
function killTree(pid) {
    if (!pid)
        return;
    try {
        if (process.platform === 'win32')
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else
            process.kill(-pid, 'SIGKILL');
    }
    catch {
        /* already gone */
    }
}
export function runShell(command, opts) {
    const { cwd, shell, timeoutMs, signal } = opts;
    const started = Date.now();
    return new Promise((resolve) => {
        const useCmdShell = shell.kind === 'cmd';
        const child = spawn(shell.exe, shell.buildArgs(command), {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            shell: useCmdShell ? false : false,
            windowsVerbatimArguments: useCmdShell,
            env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', CI: process.env.CI ?? '1', GIT_TERMINAL_PROMPT: '0', PYTHONIOENCODING: 'utf-8' },
        });
        const chunks = [];
        let size = 0;
        const cap = (opts.maxOutput ?? 30_000) * 4;
        const onData = (d) => {
            if (size < cap) {
                chunks.push(d);
                size += d.length;
            }
            else if (size < cap * 2) {
                // Keep a rolling tail beyond the cap.
                chunks.push(d);
                size += d.length;
                while (size > cap * 1.5 && chunks.length > 1)
                    size -= chunks.shift().length;
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        let timedOut = false;
        let aborted = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
        }, timeoutMs);
        const onAbort = () => {
            aborted = true;
            killTree(child.pid);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (code) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve({ exitCode: code, output: Buffer.concat(chunks).toString('utf8'), timedOut, aborted, durationMs: Date.now() - started });
        };
        child.on('error', (err) => {
            chunks.push(Buffer.from(`Failed to start ${shell.exe}: ${err.message}\n`));
            finish(127);
        });
        child.on('close', (code) => finish(code));
    });
}
export const DANGEROUS_PATTERNS = [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
    /\brm\s+-rf?\s+[\/~]/i,
    /Remove-Item\b[^\n]*-Recurse/i,
    /\brd\s+\/s\b|\brmdir\s+\/s\b/i,
    /\bdel\s+\/[sq]\b/i,
    /\bgit\s+push\b[^\n]*(--force|-f)\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\b[^\n]*-[a-z]*f/i,
    /\bgit\s+checkout\s+--\s+\./i,
    /\bformat(\.com)?\s+[a-z]:/i,
    /\bmkfs\b|\bdd\s+if=/i,
    /\b(shutdown|reboot|Restart-Computer|Stop-Computer)\b/i,
    /\bDROP\s+(TABLE|DATABASE)\b/i,
];
export function isDangerousCommand(command) {
    return DANGEROUS_PATTERNS.some((re) => re.test(command));
}
/** Commands that normally never exit (dev servers, watchers). They get a short timeout instead of hanging. */
const LONG_RUNNING_PATTERNS = [
    /\bhttp\.server\b/i,
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(start|dev|serve|watch|preview)\b/i,
    /\b(npx\s+)?(vite|serve|http-server|live-server|nodemon|webpack(-dev-server)?\s+serve|next\s+dev|astro\s+dev|ng\s+serve|parcel)\b/i,
    /\b(flask\s+run|uvicorn|gunicorn|django-admin\s+runserver|manage\.py\s+runserver|rails\s+s(erver)?|php\s+-S)\b/i,
    /\bnode\s+[^\n]*\b(server|app|index)\.(js|mjs|ts)\b/i,
    /\b(tail\s+-f|--watch|-w\b\s+)/i,
    /\bpython3?\s+[^\n]*\b(server|app)\.py\b/i,
    /\bstart\s+[^\n]*\.html\b/i,
];
export function isLongRunningCommand(command) {
    return LONG_RUNNING_PATTERNS.some((re) => re.test(command));
}
const LONG_RUNNING_TIMEOUT_MS = 8000;
export function makeShellTool(shell) {
    return {
        name: 'shell',
        description: `Run a ${shell.displayName} command in the working directory and return its output and exit code. Not interactive. ${shell.kind === 'powershell' ? 'Chain commands with ";" (not "&&").' : shell.kind === 'cmd' ? 'Use cmd.exe syntax.' : ''}`.trim(),
        permission: 'exec',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command line to execute' },
                timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000)' },
            },
            required: ['command'],
        },
        describeCall(args) {
            return `shell: ${String(args.command ?? args.cmd ?? '')}`;
        },
        async preview(args) {
            const cmd = String(args.command ?? args.cmd ?? '');
            return isDangerousCommand(cmd) ? `!! potentially destructive command:\n${cmd}` : undefined;
        },
        async execute(args, ctx) {
            const command = reqString(args, 'command', ['cmd', 'script']).trim();
            if (!command)
                return { content: 'Empty command.', isError: true };
            const longRunning = isLongRunningCommand(command);
            const timeoutMs = longRunning
                ? LONG_RUNNING_TIMEOUT_MS
                : Math.min(600_000, Math.max(1000, Math.floor(optNumber(args, 'timeout_ms', ['timeout']) ?? ctx.config.shellTimeoutMs)));
            const res = await runShell(command, { cwd: ctx.cwd, shell, timeoutMs, signal: ctx.signal, maxOutput: ctx.config.maxToolResultChars });
            if (longRunning && res.timedOut) {
                const out = res.output.replace(/\r\n/g, '\n').trim();
                return {
                    content: `This looks like a long-running server/watch command; it was stopped after ${LONG_RUNNING_TIMEOUT_MS / 1000}s (the agent cannot keep background processes). Output so far:\n${out || '(no output)'}\n\nDo not start servers or open browsers yourself — finish the files and tell the user the command to run.`,
                    isError: false,
                    summary: `stopped after ${LONG_RUNNING_TIMEOUT_MS / 1000}s (long-running command)`,
                };
            }
            let output = res.output.replace(/\r\n/g, '\n').trimEnd();
            const { text, truncated } = truncateText(output, ctx.config.maxToolResultChars, 500);
            let note = '';
            if (truncated) {
                const file = path.join(tmpDir(ctx.cwd), `shell-${Date.now().toString(36)}.log`);
                try {
                    fs.writeFileSync(file, res.output, 'utf8');
                    note = `\n[output truncated; full output saved to ${path.relative(ctx.cwd, file).split(path.sep).join('/')} — use grep/read_file on it if needed]`;
                }
                catch {
                    note = '\n[output truncated]';
                }
            }
            output = text;
            const status = res.aborted
                ? 'aborted by user'
                : res.timedOut
                    ? `timed out after ${Math.round(timeoutMs / 1000)}s (process killed)`
                    : `exit code: ${res.exitCode ?? 'unknown'}`;
            const isError = res.aborted || res.timedOut || (res.exitCode !== 0 && res.exitCode !== null);
            return {
                content: `${status}\n${output || '(no output)'}${note}`,
                isError,
                summary: `${status} · ${(res.durationMs / 1000).toFixed(1)}s`,
            };
        },
    };
}
//# sourceMappingURL=shell.js.map