import pc from 'picocolors';
import type { ToolResult } from '../tools/types.js';

export const out = (s: string) => process.stdout.write(s);

export function colorDiff(diff: string): string {
  return diff
    .split('\n')
    .map((l) => {
      if (l.startsWith('+++') || l.startsWith('---')) return pc.bold(l);
      if (l.startsWith('@@')) return pc.cyan(l);
      if (l.startsWith('+')) return pc.green(l);
      if (l.startsWith('-')) return pc.red(l);
      return pc.dim(l);
    })
    .join('\n');
}

export function renderToolStart(description: string): string {
  return `${pc.cyan('▸')} ${pc.bold(description)}`;
}

export function renderToolResult(result: ToolResult, ms: number): string {
  const time = ms >= 1000 ? pc.dim(` ${(ms / 1000).toFixed(1)}s`) : '';
  if (result.isError) {
    const first = result.content.split('\n').find((l) => l.trim()) ?? 'error';
    return `  ${pc.red('✗')} ${pc.red(first.slice(0, 160))}${time}`;
  }
  const summary = result.summary ?? (result.content.split('\n').find((l) => l.trim()) ?? '').slice(0, 120);
  return `  ${pc.green('✓')} ${pc.dim(summary)}${time}`;
}

export function renderToolResultBody(result: ToolResult, maxLines = 12): string | undefined {
  // Show diffs for edits and shell output briefly.
  const lines = result.content.split('\n');
  const looksLikeDiff = lines.some((l) => l.startsWith('@@'));
  if (looksLikeDiff) {
    const diffStart = lines.findIndex((l) => l.startsWith('@@'));
    const body = lines.slice(diffStart, diffStart + 40).join('\n');
    return indent(colorDiff(body), '    ') + (lines.length - diffStart > 40 ? pc.dim('\n    ...') : '');
  }
  if (result.isError) return undefined;
  if (lines[0]?.startsWith('exit code') || lines[0]?.startsWith('timed out')) {
    const body = lines.slice(1, 1 + maxLines).join('\n');
    return body.trim() ? indent(pc.dim(body), '    ') + (lines.length - 1 > maxLines ? pc.dim('\n    ...') : '') : undefined;
  }
  return undefined;
}

export function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

export function banner(lines: string[]): string {
  return lines.map((l) => pc.dim(l)).join('\n');
}

export class Spinner {
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private static frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private active = false;

  start(label = 'thinking'): void {
    if (this.active || !process.stdout.isTTY) return;
    this.active = true;
    this.timer = setInterval(() => {
      const f = Spinner.frames[this.frame++ % Spinner.frames.length];
      out(`\r${pc.magenta(f)} ${pc.dim(label)}   `);
    }, 80);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    out('\r\x1b[2K');
  }
}
