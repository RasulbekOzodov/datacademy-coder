import fg from 'fast-glob';
import path from 'node:path';
import type { Tool, ToolArgs, ToolContext, ToolResult } from './types.js';
import { ALWAYS_IGNORE, loadIgnore, optString, relPath, reqString, resolvePath } from './util.js';

const MAX_RESULTS = 500;

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Returns paths relative to the working directory.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search in (default: working directory)' },
    },
    required: ['pattern'],
  },
  describeCall(args: ToolArgs) {
    return `glob ${String(args.pattern ?? '')}${args.path ? ` in ${String(args.path)}` : ''}`;
  },
  async execute(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
    const pattern = reqString(args, 'pattern', ['glob', 'query']);
    const base = resolvePath(ctx.cwd, optString(args, 'path', ['directory', 'dir']) ?? '.');
    const ig = loadIgnore(ctx.cwd);
    let found: string[];
    try {
      found = await fg(pattern.replace(/\\/g, '/'), {
        cwd: base,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        ignore: ALWAYS_IGNORE.map((d) => `**/${d}/**`),
        suppressErrors: true,
      });
    } catch (err) {
      return { content: `glob failed: ${(err as Error).message}`, isError: true };
    }
    const results = found
      .map((f) => path.join(base, f))
      .filter((abs) => {
        const r = path.relative(ctx.cwd, abs).split(path.sep).join('/');
        return !r || r.startsWith('..') || !ig.ignores(r);
      })
      .map((abs) => relPath(ctx.cwd, abs))
      .sort();
    if (!results.length) return { content: `No files match "${pattern}".`, summary: '0 files' };
    const shown = results.slice(0, MAX_RESULTS);
    const more = results.length > shown.length ? `\n... (${results.length - shown.length} more)` : '';
    return { content: shown.join('\n') + more, summary: `${results.length} files` };
  },
};
