import fs from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { optBool, relPath, reqString, resolvePath } from './util.js';
const OVERWRITE_GUARD_LINES = 50;
async function readExisting(abs) {
    try {
        return await fs.readFile(abs, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
}
export const writeFileTool = {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing one with the given content. Parent directories are created. For small changes to existing files prefer edit_file.',
    permission: 'write',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path to write' },
            content: { type: 'string', description: 'Full file content' },
            overwrite: { type: 'boolean', description: 'Set true to overwrite a large existing file you have not read' },
        },
        required: ['path', 'content'],
    },
    describeCall(args) {
        const content = typeof args.content === 'string' ? args.content : '';
        return `write_file ${String(args.path ?? '')} (${content.split('\n').length} lines)`;
    },
    async preview(args, ctx) {
        const abs = resolvePath(ctx.cwd, reqString(args, 'path', ['file', 'filename', 'file_path']));
        const rel = relPath(ctx.cwd, abs);
        const content = reqString(args, 'content', ['text', 'contents']);
        const existing = await readExisting(abs);
        if (existing === null) {
            const lines = content.split('\n');
            const shown = lines.slice(0, 40).join('\n');
            return `new file ${rel}:\n${shown}${lines.length > 40 ? `\n... (${lines.length - 40} more lines)` : ''}`;
        }
        const patch = createTwoFilesPatch(rel, rel, existing, content, '', '', { context: 3 });
        const lines = patch.split('\n').slice(4);
        return lines.length > 200 ? `${lines.slice(0, 200).join('\n')}\n... (diff truncated)` : lines.join('\n');
    },
    async execute(args, ctx) {
        const abs = resolvePath(ctx.cwd, reqString(args, 'path', ['file', 'filename', 'file_path']));
        const rel = relPath(ctx.cwd, abs);
        const content = reqString(args, 'content', ['text', 'contents']);
        const existing = await readExisting(abs);
        if (existing !== null && !ctx.readFiles.has(abs) && !optBool(args, 'overwrite')) {
            const n = existing.split('\n').length;
            if (n > OVERWRITE_GUARD_LINES) {
                return {
                    content: `${rel} already exists (${n} lines) and you have not read it. Read it first with read_file and use edit_file for changes, or pass overwrite:true to replace it entirely.`,
                    isError: true,
                };
            }
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
        ctx.undoStack.push({ path: abs, previous: existing });
        ctx.readFiles.add(abs);
        const lines = content.split('\n').length;
        return {
            content: `${existing === null ? 'Created' : 'Overwrote'} ${rel} (${lines} lines).`,
            summary: `${existing === null ? 'created' : 'overwrote'} ${lines} lines`,
        };
    },
};
//# sourceMappingURL=write-file.js.map