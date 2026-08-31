import pc from 'picocolors';
export const out = (s) => process.stdout.write(s);
export function colorDiff(diff) {
    return diff
        .split('\n')
        .map((l) => {
        if (l.startsWith('+++') || l.startsWith('---'))
            return pc.bold(l);
        if (l.startsWith('@@'))
            return pc.cyan(l);
        if (l.startsWith('+'))
            return pc.green(l);
        if (l.startsWith('-'))
            return pc.red(l);
        return pc.dim(l);
    })
        .join('\n');
}
export function renderToolStart(description) {
    return `${pc.cyan('▸')} ${pc.bold(description)}`;
}
export function renderToolResult(result, ms) {
    const time = ms >= 1000 ? pc.dim(` ${(ms / 1000).toFixed(1)}s`) : '';
    if (result.isError) {
        const first = result.content.split('\n').find((l) => l.trim()) ?? 'error';
        return `  ${pc.red('✗')} ${pc.red(first.slice(0, 160))}${time}`;
    }
    const summary = result.summary ?? (result.content.split('\n').find((l) => l.trim()) ?? '').slice(0, 120);
    return `  ${pc.green('✓')} ${pc.dim(summary)}${time}`;
}
export function renderToolResultBody(result, maxLines = 12) {
    // Show diffs for edits and shell output briefly.
    const lines = result.content.split('\n');
    const looksLikeDiff = lines.some((l) => l.startsWith('@@'));
    if (looksLikeDiff) {
        const diffStart = lines.findIndex((l) => l.startsWith('@@'));
        const body = lines.slice(diffStart, diffStart + 40).join('\n');
        return indent(colorDiff(body), '    ') + (lines.length - diffStart > 40 ? pc.dim('\n    ...') : '');
    }
    if (result.isError)
        return undefined;
    if (lines[0]?.startsWith('exit code') || lines[0]?.startsWith('timed out')) {
        const body = lines.slice(1, 1 + maxLines).join('\n');
        return body.trim() ? indent(pc.dim(body), '    ') + (lines.length - 1 > maxLines ? pc.dim('\n    ...') : '') : undefined;
    }
    return undefined;
}
export function indent(text, pad) {
    return text
        .split('\n')
        .map((l) => pad + l)
        .join('\n');
}
export function banner(lines) {
    return lines.map((l) => pc.dim(l)).join('\n');
}
function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}
/**
 * Claude Code-style live status line: `⠋ label (12s · Ctrl+C to'xtatish)`.
 * Keeps redrawing with elapsed time so long model/tool waits never look frozen.
 * `start()` resets the clock (new phase); `update()` only changes the label.
 */
export class StatusLine {
    timer;
    frame = 0;
    static frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    active = false;
    label = '';
    startedAt = 0;
    get isActive() {
        return this.active;
    }
    start(label) {
        if (!process.stdout.isTTY)
            return;
        this.label = label;
        this.startedAt = Date.now();
        if (this.active) {
            this.render();
            return;
        }
        this.active = true;
        this.timer = setInterval(() => this.render(), 100);
        this.render();
    }
    /** Change the label without resetting the elapsed clock (redrawn by the interval, not here). */
    update(label) {
        if (!this.active)
            return;
        this.label = label;
    }
    render() {
        const f = StatusLine.frames[this.frame++ % StatusLine.frames.length];
        const elapsed = formatElapsed(Date.now() - this.startedAt);
        out(`\r\x1b[2K${pc.magenta(f)} ${this.label}${pc.dim(` (${elapsed} · Ctrl+C to'xtatish)`)}`);
    }
    stop() {
        if (!this.active)
            return;
        this.active = false;
        if (this.timer)
            clearInterval(this.timer);
        out('\r\x1b[2K');
    }
}
//# sourceMappingURL=render.js.map