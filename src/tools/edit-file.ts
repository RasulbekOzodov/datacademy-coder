import fs from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import type { Tool, ToolArgs, ToolContext, ToolResult } from './types.js';
import { detectEol, optBool, relPath, reqString, resolvePath } from './util.js';

export type EditOutcome =
  | { ok: true; content: string; line: number; level: 'exact' | 'trailing-ws' | 'indent'; replacements: number }
  | { ok: false; error: string };

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

function indexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

function leadingWs(s: string): string {
  return s.match(/^[ \t]*/)?.[0] ?? '';
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/** Find the window of lines in `content` most similar to `old` (for error messages). */
export function closestMatch(content: string, old: string): { startLine: number; endLine: number; similarity: number; text: string } | undefined {
  const lines = content.split('\n');
  const oldLines = old.split('\n');
  const win = Math.max(1, oldLines.length);
  if (lines.length === 0) return undefined;
  const target = oldLines.map((l) => l.trim()).join('\n');
  let best = { i: 0, sim: -1 };
  const step = lines.length > 4000 ? 2 : 1;
  for (let i = 0; i + win <= Math.max(lines.length, win); i += step) {
    const cand = lines
      .slice(i, i + win)
      .map((l) => l.trim())
      .join('\n');
    const sim = dice(cand, target);
    if (sim > best.sim) best = { i, sim };
  }
  if (best.sim < 0) return undefined;
  return { startLine: best.i + 1, endLine: Math.min(lines.length, best.i + win), similarity: best.sim, text: lines.slice(best.i, best.i + win).join('\n') };
}

/**
 * Matching ladder: exact -> trailing-whitespace-insensitive -> leading-indent-insensitive (re-indents `neu`).
 * Works on LF-normalized text.
 */
export function applyEdit(content: string, oldRaw: string, neuRaw: string, replaceAll = false): EditOutcome {
  const old = oldRaw.replace(/\r\n/g, '\n');
  const neu = neuRaw.replace(/\r\n/g, '\n');
  if (!old) return { ok: false, error: '"old" must not be empty. To create a file use write_file.' };
  if (old === neu) return { ok: false, error: '"old" and "new" are identical; nothing to change.' };

  // 1. Exact.
  const exact = indexes(content, old);
  if (exact.length === 1 || (exact.length > 1 && replaceAll)) {
    const out = replaceAll ? content.split(old).join(neu) : content.slice(0, exact[0]) + neu + content.slice(exact[0] + old.length);
    return { ok: true, content: out, line: lineOf(content, exact[0]), level: 'exact', replacements: replaceAll ? exact.length : 1 };
  }
  if (exact.length > 1) {
    return {
      ok: false,
      error: `"old" matches ${exact.length} times (lines ${exact.map((i) => lineOf(content, i)).join(', ')}). Include more surrounding lines to make it unique, or set replace_all:true.`,
    };
  }

  // 2 & 3. Line-window comparison with normalization.
  const lines = content.split('\n');
  const oldLines = old.split('\n');
  // Drop a trailing empty line from old (models often add a final newline).
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  const win = oldLines.length;
  const norm = (s: string) => s.replace(/[ \t]+$/, '');
  const trimAll = (s: string) => s.trim();

  const matchesAt = (i: number, f: (s: string) => string) => {
    for (let k = 0; k < win; k++) { const l = lines[i + k]; if (l === undefined || f(l) !== f(oldLines[k])) return false; }
    return true;
  };

  for (const [level, f] of [
    ['trailing-ws', norm],
    ['indent', trimAll],
  ] as const) {
    const hits: number[] = [];
    for (let i = 0; i + win <= lines.length; i++) if (matchesAt(i, f)) hits.push(i);
    if (hits.length === 1) {
      const i = hits[0];
      let newLines = neu.split('\n');
      if (level === 'indent') {
        // Re-indent `new` using the real indentation of the matched file lines:
        // a new line identical to an old line takes that line's file indent; other lines take the
        // indent delta of the old line at the same position.
        const fileWin = lines.slice(i, i + win);
        const fileIndentOf = (k: number) => leadingWs(fileWin[Math.min(k, win - 1)]);
        const oldIndentOf = (k: number) => leadingWs(oldLines[Math.min(k, win - 1)]);
        newLines = newLines.map((l, j) => {
          if (!l.trim()) return l;
          const own = leadingWs(l);
          const body = l.slice(own.length);
          const exactK = oldLines.findIndex((o) => o.trim() === l.trim());
          if (exactK >= 0) return fileIndentOf(exactK) + body;
          const oldIndent = oldIndentOf(j);
          const rest = own.startsWith(oldIndent) ? own.slice(oldIndent.length) : own;
          return fileIndentOf(j) + rest + body;
        });
      }
      const out = [...lines.slice(0, i), ...newLines, ...lines.slice(i + win)].join('\n');
      return { ok: true, content: out, line: i + 1, level, replacements: 1 };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        error: `"old" matches ${hits.length} times (ignoring whitespace; lines ${hits.map((h) => h + 1).join(', ')}). Include more surrounding lines to make it unique.`,
      };
    }
  }

  const close = closestMatch(content, old);
  let hint = '';
  if (close && close.similarity > 0.35) {
    hint = `\nClosest match (lines ${close.startLine}-${close.endLine}, ${Math.round(close.similarity * 100)}% similar):\n${close.text}\n`;
  }
  return {
    ok: false,
    error: `"old" text not found in the file.${hint}\nRe-issue edit_file with "old" copied EXACTLY from the read_file output (without line-number prefixes).`,
  };
}

export function makeDiff(rel: string, before: string, after: string, maxLines = 120): string {
  const patch = createTwoFilesPatch(rel, rel, before, after, '', '', { context: 3 });
  const lines = patch.split('\n').slice(4).filter((l) => l !== '\\ No newline at end of file');
  if (lines.length > maxLines) return `${lines.slice(0, maxLines).join('\n')}\n... (diff truncated, ${lines.length - maxLines} more lines)`;
  return lines.join('\n');
}

async function prepare(args: ToolArgs, ctx: ToolContext) {
  const abs = resolvePath(ctx.cwd, reqString(args, 'path', ['file', 'filename', 'file_path']));
  const rel = relPath(ctx.cwd, abs);
  const old = reqString(args, 'old', ['old_string', 'old_text', 'search', 'from', 'target']);
  const neu = reqString(args, 'new', ['new_string', 'new_text', 'replace', 'replacement', 'to']);
  const replaceAll = optBool(args, 'replace_all') ?? false;
  return { abs, rel, old, neu, replaceAll };
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact snippet of text in a file. "old" must match the file content exactly (copy it from read_file output, without the line-number prefix) and must be unique. Read the file first.',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit' },
      old: { type: 'string', description: 'Exact existing text to replace (unique in the file)' },
      new: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old', 'new'],
  },
  describeCall(args: ToolArgs) {
    return `edit_file ${String(args.path ?? '')}`;
  },
  async preview(args: ToolArgs, ctx: ToolContext) {
    const { abs, rel, old, neu, replaceAll } = await prepare(args, ctx);
    let raw: string;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch {
      return undefined;
    }
    const lf = raw.replace(/\r\n/g, '\n');
    const res = applyEdit(lf, old, neu, replaceAll);
    return res.ok ? makeDiff(rel, lf, res.content) : `(edit will fail: ${res.error.split('\n')[0]})`;
  },
  async execute(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
    const { abs, rel, old, neu, replaceAll } = await prepare(args, ctx);
    if (!ctx.readFiles.has(abs)) {
      return { content: `You have not read ${rel} in this session. Call read_file on it first, then edit.`, isError: true };
    }
    let raw: string;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch (err) {
      return { content: `Cannot read ${rel}: ${(err as Error).message}`, isError: true };
    }
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = bom ? raw.slice(1) : raw;
    const eol = detectEol(body);
    const lf = body.replace(/\r\n/g, '\n');

    const res = applyEdit(lf, old, neu, replaceAll);
    if (!res.ok) return { content: `edit_file failed for ${rel}: ${res.error}`, isError: true };

    const out = bom + (eol === '\r\n' ? res.content.replace(/\n/g, '\r\n') : res.content);
    await fs.writeFile(abs, out, 'utf8');
    ctx.undoStack.push({ path: abs, previous: raw });

    const diff = makeDiff(rel, lf, res.content);
    const note = res.level === 'indent' ? ' (matched ignoring indentation; re-indented)' : res.level === 'trailing-ws' ? ' (matched ignoring trailing whitespace)' : '';
    return {
      content: `Edited ${rel} at line ${res.line}${res.replacements > 1 ? ` (${res.replacements} replacements)` : ''}${note}.\n${diff}`,
      summary: `line ${res.line}${res.replacements > 1 ? `, ${res.replacements}x` : ''}`,
    };
  },
};
