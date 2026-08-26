import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { ALWAYS_IGNORE, isProbablyBinary, loadIgnore, optNumber, optString, relPath, reqString, resolvePath } from './util.js';
let rgAvailable;
async function hasRg() {
    if (rgAvailable !== undefined)
        return rgAvailable;
    rgAvailable = await new Promise((resolve) => {
        try {
            const p = spawn('rg', ['--version'], { windowsHide: true, stdio: 'ignore' });
            p.on('error', () => resolve(false));
            p.on('exit', (code) => resolve(code === 0));
        }
        catch {
            resolve(false);
        }
    });
    return rgAvailable;
}
function runRg(args, cwd, signal) {
    return new Promise((resolve, reject) => {
        const p = spawn('rg', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString('utf8')));
        p.stderr.on('data', (d) => (out += d.toString('utf8')));
        p.on('error', reject);
        p.on('exit', (code) => resolve({ code, out }));
        signal?.addEventListener('abort', () => p.kill(), { once: true });
    });
}
export const grepTool = {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns "path:line: text" matches.',
    permission: 'read',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Regular expression (case-insensitive by default)' },
            path: { type: 'string', description: 'File or directory to search (default: working directory)' },
            include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
            max_results: { type: 'integer', description: 'Maximum matches to return (default 100)' },
        },
        required: ['pattern'],
    },
    describeCall(args) {
        return `grep /${String(args.pattern ?? '')}/${args.include ? ` --include ${String(args.include)}` : ''}${args.path ? ` in ${String(args.path)}` : ''}`;
    },
    async execute(args, ctx) {
        const pattern = reqString(args, 'pattern', ['regex', 'query', 'search']);
        const target = resolvePath(ctx.cwd, optString(args, 'path', ['directory', 'dir', 'file']) ?? '.');
        const include = optString(args, 'include', ['glob', 'file_pattern']);
        const max = Math.max(1, Math.min(1000, Math.floor(optNumber(args, 'max_results', ['limit']) ?? 100)));
        let re;
        try {
            re = new RegExp(pattern, 'i');
        }
        catch (err) {
            return { content: `Invalid regular expression: ${err.message}`, isError: true };
        }
        if (await hasRg()) {
            const rgArgs = ['--no-heading', '--line-number', '--color', 'never', '-i', '--max-count', '50', '-e', pattern];
            if (include)
                rgArgs.push('--glob', include);
            for (const d of ALWAYS_IGNORE)
                rgArgs.push('--glob', `!${d}`);
            rgArgs.push(target);
            try {
                const { code, out } = await runRg(rgArgs, ctx.cwd, ctx.signal);
                if (code === 2)
                    return { content: `rg error: ${out.slice(0, 500)}`, isError: true };
                const lines = out.split(/\r?\n/).filter(Boolean);
                return formatMatches(lines, max, ctx.cwd);
            }
            catch {
                /* fall through to JS search */
            }
        }
        // JS fallback.
        const ig = loadIgnore(ctx.cwd);
        let files = [];
        try {
            const st = await fs.stat(target);
            if (st.isFile())
                files = [target];
            else {
                const found = await fg(include ? `**/${include}` : '**/*', {
                    cwd: target,
                    dot: true,
                    onlyFiles: true,
                    followSymbolicLinks: false,
                    ignore: ALWAYS_IGNORE.map((d) => `**/${d}/**`),
                    suppressErrors: true,
                });
                files = found.map((f) => path.join(target, f)).filter((abs) => {
                    const r = path.relative(ctx.cwd, abs).split(path.sep).join('/');
                    return !r || r.startsWith('..') || !ig.ignores(r);
                });
            }
        }
        catch (err) {
            return { content: `Cannot search ${relPath(ctx.cwd, target)}: ${err.message}`, isError: true };
        }
        const lines = [];
        for (const abs of files) {
            if (ctx.signal?.aborted)
                break;
            if (lines.length >= max)
                break;
            let buf;
            try {
                const st = await fs.stat(abs);
                if (st.size > 2 * 1024 * 1024)
                    continue;
                buf = await fs.readFile(abs);
            }
            catch {
                continue;
            }
            if (isProbablyBinary(buf))
                continue;
            const text = buf.toString('utf8');
            const rel = relPath(ctx.cwd, abs);
            let n = 0;
            let perFile = 0;
            for (const line of text.split(/\r?\n/)) {
                n++;
                if (re.test(line)) {
                    lines.push(`${rel}:${n}: ${line.trim().slice(0, 300)}`);
                    if (++perFile >= 50 || lines.length >= max)
                        break;
                }
            }
        }
        return formatMatches(lines, max, ctx.cwd);
    },
};
function formatMatches(lines, max, cwd) {
    const norm = lines.map((l) => {
        const m = l.match(/^(.*?):(\d+):(.*)$/);
        if (!m)
            return l;
        const rel = path.isAbsolute(m[1]) ? relPath(cwd, m[1]) : m[1].split(path.sep).join('/');
        return `${rel}:${m[2]}: ${m[3].trim().slice(0, 300)}`;
    });
    if (!norm.length)
        return { content: 'No matches.', summary: '0 matches' };
    const shown = norm.slice(0, max);
    const more = norm.length > max ? `\n... (${norm.length - max} more matches; narrow the pattern or path)` : '';
    return { content: shown.join('\n') + more, summary: `${norm.length} matches` };
}
//# sourceMappingURL=grep.js.map