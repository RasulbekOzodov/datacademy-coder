import fs from 'node:fs/promises';
import { isProbablyBinary, optNumber, relPath, reqString, resolvePath } from './util.js';
const DEFAULT_LIMIT = 400;
export const readFileTool = {
    name: 'read_file',
    description: 'Read a text file with line numbers. Use offset/limit for large files. You MUST read a file before editing it with edit_file.',
    permission: 'read',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path (relative to the working directory or absolute)' },
            offset: { type: 'integer', description: '1-based line number to start from (default 1)' },
            limit: { type: 'integer', description: `Max lines to return (default ${DEFAULT_LIMIT})` },
        },
        required: ['path'],
    },
    describeCall(args) {
        const off = optNumber(args, 'offset');
        return `read_file ${String(args.path ?? '')}${off && off > 1 ? ` (from line ${off})` : ''}`;
    },
    async execute(args, ctx) {
        const abs = resolvePath(ctx.cwd, reqString(args, 'path', ['file', 'filename', 'file_path']));
        const rel = relPath(ctx.cwd, abs);
        let buf;
        try {
            buf = await fs.readFile(abs);
        }
        catch (err) {
            const code = err.code;
            if (code === 'ENOENT')
                return { content: `File not found: ${rel}. Paths are relative to the working directory; use list_dir or glob to find the correct path.`, isError: true };
            if (code === 'EISDIR')
                return { content: `${rel} is a directory. Use list_dir to see its contents.`, isError: true };
            return { content: `Cannot read ${rel}: ${err.message}`, isError: true };
        }
        if (isProbablyBinary(buf))
            return { content: `${rel} appears to be a binary file (${buf.length} bytes); not shown.`, isError: true };
        const text = buf.toString('utf8').replace(/^\uFEFF/, '');
        const lines = text.split(/\r?\n/);
        if (lines.length && lines[lines.length - 1] === '')
            lines.pop();
        const total = lines.length;
        const offset = Math.max(1, Math.floor(optNumber(args, 'offset', ['start', 'start_line']) ?? 1));
        let limit = Math.max(1, Math.floor(optNumber(args, 'limit', ['lines', 'max_lines']) ?? DEFAULT_LIMIT));
        const maxChars = ctx.config.maxToolResultChars;
        const start = offset - 1;
        let slice = lines.slice(start, start + limit);
        let joined = slice.map((l, i) => `${String(start + i + 1).padStart(5)}| ${l}`).join('\n');
        while (joined.length > maxChars && slice.length > 1) {
            limit = Math.max(1, Math.floor(slice.length / 2));
            slice = lines.slice(start, start + limit);
            joined = slice.map((l, i) => `${String(start + i + 1).padStart(5)}| ${l}`).join('\n');
        }
        const end = start + slice.length;
        ctx.readFiles.add(abs);
        if (total === 0)
            return { content: `${rel} is empty.`, summary: 'empty' };
        if (start >= total)
            return { content: `Offset ${offset} is beyond the end of file (${total} lines).`, isError: true };
        const header = end < total || start > 0 ? `[${rel}: showing lines ${start + 1}-${end} of ${total}]\n` : `[${rel}: ${total} lines]\n`;
        const footer = end < total ? `\n[... ${total - end} more lines. Call read_file with offset=${end + 1} to continue]` : '';
        return { content: header + joined + footer, summary: `${slice.length}/${total} lines` };
    },
};
//# sourceMappingURL=read-file.js.map