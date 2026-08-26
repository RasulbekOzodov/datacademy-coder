import pc from 'picocolors';
/** 5-row block font for the letters used in the banner. Each glyph is 5 columns wide. */
const FONT = {
    D: ['████ ', '█   █', '█   █', '█   █', '████ '],
    A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
    T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
    C: [' ████', '█    ', '█    ', '█    ', ' ████'],
    E: ['█████', '█    ', '████ ', '█    ', '█████'],
    M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
    Y: ['█   █', ' █ █ ', '  █  ', '  █  ', '  █  '],
    U: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
    Z: ['█████', '   █ ', '  █  ', ' █   ', '█████'],
    R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
    O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
    ' ': ['   ', '   ', '   ', '   ', '   '],
};
const ROWS = 5;
export function renderBigText(text) {
    const rows = Array.from({ length: ROWS }, () => '');
    for (const ch of text.toUpperCase()) {
        const glyph = FONT[ch] ?? FONT[' '];
        for (let r = 0; r < ROWS; r++)
            rows[r] += `${glyph[r]} `;
    }
    return rows.map((r) => r.replace(/\s+$/, ''));
}
/** Big "DATACADEMY UZ" banner, split onto two lines when the terminal is narrow. */
export function banner() {
    const width = process.stdout.columns ?? 80;
    const words = ['DATACADEMY', 'UZ'];
    const oneLine = renderBigText(words.join(' '));
    const blocks = oneLine[0].length <= width - 2 ? [oneLine] : words.map((w) => renderBigText(w));
    const colors = [pc.magenta, pc.magenta, pc.blue, pc.blue, pc.cyan];
    const lines = [];
    for (const block of blocks) {
        block.forEach((row, i) => lines.push(`  ${pc.bold(colors[i % colors.length](row))}`));
        lines.push('');
    }
    return lines.join('\n');
}
//# sourceMappingURL=banner.js.map