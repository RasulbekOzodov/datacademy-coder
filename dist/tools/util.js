import fs from 'node:fs';
import path from 'node:path';
import ignoreImport from 'ignore';
const ignore = ignoreImport.default ?? ignoreImport;
export function resolvePath(cwd, p) {
    const cleaned = (p ?? '').trim().replace(/^["']|["']$/g, '');
    if (!cleaned || cleaned === '.')
        return path.resolve(cwd);
    return path.resolve(cwd, cleaned);
}
export function relPath(cwd, abs) {
    const r = path.relative(cwd, abs);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : abs;
}
export function isInside(root, target) {
    const r = path.resolve(root);
    const t = path.resolve(target);
    const rel = path.relative(r, t);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
export function reqString(args, key, aliases = []) {
    for (const k of [key, ...aliases]) {
        const v = args[k];
        if (typeof v === 'string')
            return v;
        if (typeof v === 'number' || typeof v === 'boolean')
            return String(v);
    }
    throw new Error(`Missing required string argument "${key}"`);
}
export function optString(args, key, aliases = []) {
    for (const k of [key, ...aliases]) {
        const v = args[k];
        if (typeof v === 'string')
            return v;
    }
    return undefined;
}
export function optNumber(args, key, aliases = []) {
    for (const k of [key, ...aliases]) {
        const v = args[k];
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
        if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)))
            return Number(v);
    }
    return undefined;
}
export function optBool(args, key) {
    const v = args[key];
    if (typeof v === 'boolean')
        return v;
    if (typeof v === 'string')
        return /^(true|yes|1)$/i.test(v);
    return undefined;
}
/** Keep head (2/3) and tail (1/3) of an over-long text. */
export function truncateText(text, maxChars, maxLines = 500) {
    const lines = text.split('\n');
    const tooLong = text.length > maxChars || lines.length > maxLines;
    if (!tooLong)
        return { text, truncated: false, droppedLines: 0 };
    // Line-based first.
    let keepLines = lines;
    if (lines.length > maxLines) {
        const head = Math.floor((maxLines * 2) / 3);
        const tail = maxLines - head;
        keepLines = [...lines.slice(0, head), `... [${lines.length - head - tail} lines truncated] ...`, ...lines.slice(-tail)];
    }
    let out = keepLines.join('\n');
    if (out.length > maxChars) {
        const head = Math.floor((maxChars * 2) / 3);
        const tail = maxChars - head;
        out = `${out.slice(0, head)}\n... [${out.length - head - tail} chars truncated] ...\n${out.slice(-tail)}`;
    }
    return { text: out, truncated: true, droppedLines: Math.max(0, lines.length - keepLines.length) };
}
export const ALWAYS_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.datacademy_coder'];
export function loadIgnore(cwd) {
    const ig = ignore();
    ig.add(ALWAYS_IGNORE.map((d) => `${d}/`));
    const gi = path.join(cwd, '.gitignore');
    try {
        if (fs.existsSync(gi))
            ig.add(fs.readFileSync(gi, 'utf8'));
    }
    catch {
        /* ignore */
    }
    return ig;
}
export function detectEol(text) {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
    return crlf > lf ? '\r\n' : '\n';
}
export function isProbablyBinary(buf) {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++)
        if (buf[i] === 0)
            return true;
    return false;
}
export function tmpDir(cwd) {
    const dir = path.join(cwd, '.datacademy_coder', 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
//# sourceMappingURL=util.js.map