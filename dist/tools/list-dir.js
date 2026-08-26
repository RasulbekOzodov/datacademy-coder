import fs from 'node:fs/promises';
import path from 'node:path';
import { loadIgnore, optNumber, optString, relPath, resolvePath } from './util.js';
const MAX_ENTRIES = 500;
export const listDirTool = {
    name: 'list_dir',
    description: 'List files and folders in a directory (respects .gitignore). Use depth to recurse.',
    permission: 'read',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Directory path (default: working directory)' },
            depth: { type: 'integer', description: 'Recursion depth, 1 = only direct children (default 1, max 4)' },
        },
    },
    describeCall(args) {
        return `list_dir ${String(args.path ?? '.')}`;
    },
    async execute(args, ctx) {
        const abs = resolvePath(ctx.cwd, optString(args, 'path', ['directory', 'dir']) ?? '.');
        const rel = relPath(ctx.cwd, abs) || '.';
        const depth = Math.min(4, Math.max(1, Math.floor(optNumber(args, 'depth') ?? 1)));
        const ig = loadIgnore(ctx.cwd);
        const out = [];
        let total = 0;
        const walk = async (dir, level, prefix) => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            }
            catch (err) {
                const code = err.code;
                if (code === 'ENOENT')
                    throw new Error(`Directory not found: ${relPath(ctx.cwd, dir)}. Paths are relative to the working directory — use "." for it.`);
                if (code === 'ENOTDIR')
                    throw new Error(`${relPath(ctx.cwd, dir)} is a file, not a directory. Use read_file.`);
                throw err;
            }
            entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
            for (const e of entries) {
                const full = path.join(dir, e.name);
                const relToRoot = path.relative(ctx.cwd, full).split(path.sep).join('/');
                const isDir = e.isDirectory();
                if (relToRoot && !relToRoot.startsWith('..') && ig.ignores(isDir ? `${relToRoot}/` : relToRoot))
                    continue;
                total++;
                if (out.length >= MAX_ENTRIES)
                    continue;
                let extra = '';
                if (!isDir) {
                    try {
                        const st = await fs.stat(full);
                        extra = `  (${formatSize(st.size)})`;
                    }
                    catch {
                        /* ignore */
                    }
                }
                out.push(`${prefix}${e.name}${isDir ? '/' : extra}`);
                if (isDir && level < depth)
                    await walk(full, level + 1, `${prefix}  `);
            }
        };
        try {
            await walk(abs, 1, '');
        }
        catch (err) {
            return { content: err.message, isError: true };
        }
        if (!out.length)
            return { content: `${rel} is empty.`, summary: 'empty' };
        const more = total > out.length ? `\n... (${total - out.length} more entries not shown)` : '';
        return { content: `${rel}/\n${out.join('\n')}${more}`, summary: `${total} entries` };
    },
};
function formatSize(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
//# sourceMappingURL=list-dir.js.map