const KEEP_FULL_TOOL_RESULTS = 3;
const STUB_AT = 0.5; // of context window
const TRIM_AT = 0.7;
const TRIM_TO = 0.55;
const RESERVE_FOR_RESPONSE = 0.2;
export class ContextManager {
    getWindow;
    /** chars per token; calibrated from prompt_eval_count when available */
    ratio = 3.5;
    constructor(getWindow) {
        this.getWindow = getWindow;
    }
    get contextWindow() {
        return this.getWindow();
    }
    estimateText(text) {
        return Math.ceil(text.length / this.ratio);
    }
    estimate(messages, tools, systemPrompt) {
        let chars = systemPrompt?.length ?? 0;
        for (const m of messages) {
            chars += m.content.length + 16;
            if (m.toolCalls)
                chars += JSON.stringify(m.toolCalls).length;
        }
        if (tools?.length)
            chars += JSON.stringify(tools).length;
        return Math.ceil(chars / this.ratio) + messages.length * 4;
    }
    /** Learn the real chars/token ratio from the server's prompt token count. */
    calibrate(promptTokens, estimatedTokens) {
        if (!promptTokens || promptTokens < 200 || estimatedTokens < 50)
            return;
        const observed = (estimatedTokens * this.ratio) / promptTokens;
        const next = this.ratio * 0.7 + observed * 0.3;
        this.ratio = Math.min(6, Math.max(2, next));
    }
    get charsPerToken() {
        return this.ratio;
    }
    /**
     * Keep the conversation within budget. Mutates `messages` (system prompt excluded).
     * 1) stub old tool results, 2) drop the oldest turns. Returns human-readable notes.
     */
    ensureBudget(messages, tools, systemPrompt) {
        const notes = [];
        const window = this.getWindow();
        const budget = window * (1 - RESERVE_FOR_RESPONSE);
        let est = this.estimate(messages, tools, systemPrompt);
        if (est <= window * STUB_AT)
            return notes;
        const stubbed = this.stubOldToolResults(messages);
        if (stubbed) {
            est = this.estimate(messages, tools, systemPrompt);
            notes.push(`context: ${stubbed} old tool result(s) truncated (${est}/${window} tokens est.)`);
        }
        if (est <= window * TRIM_AT)
            return notes;
        const dropped = this.dropOldestTurns(messages, () => this.estimate(messages, tools, systemPrompt) <= Math.min(budget, window * TRIM_TO));
        if (dropped) {
            est = this.estimate(messages, tools, systemPrompt);
            notes.push(`context: ${dropped} old message(s) dropped to fit the window (${est}/${window} tokens est.)`);
        }
        return notes;
    }
    /** Manual /compact: stub everything except the last tool result and drop turns down to ~30%. */
    compact(messages, tools, systemPrompt) {
        const before = this.estimate(messages, tools, systemPrompt);
        this.stubOldToolResults(messages, 1);
        const window = this.getWindow();
        this.dropOldestTurns(messages, () => this.estimate(messages, tools, systemPrompt) <= window * 0.3);
        const after = this.estimate(messages, tools, systemPrompt);
        return `compacted: ~${before} -> ~${after} tokens (window ${window})`;
    }
    stubOldToolResults(messages, keep = KEEP_FULL_TOOL_RESULTS) {
        const results = messages.filter((m) => m.meta?.kind === 'tool_result' && !m.meta.stubbed);
        const toStub = results.slice(0, Math.max(0, results.length - keep));
        for (const m of toStub) {
            if (m.content.length < 300)
                continue;
            const firstLine = m.content.split('\n').find((l) => l.trim() && !l.startsWith('<tool_result')) ?? '';
            const stub = `${firstLine.slice(0, 120)}\n[... ${m.content.length} chars of ${m.meta?.toolName ?? 'tool'} output truncated to save context. Call the tool again if you need it.]`;
            m.content = m.role === 'user' && m.content.startsWith('<tool_result') ? `<tool_result name="${m.meta?.toolName ?? 'tool'}">\n${stub}\n</tool_result>` : stub;
            m.meta = { ...(m.meta ?? {}), stubbed: true };
        }
        return toStub.filter((m) => m.meta?.stubbed).length;
    }
    /**
     * Drop whole turns from the front (a user message and everything up to the next real user message)
     * so assistant tool calls never lose their matching results.
     */
    dropOldestTurns(messages, fits) {
        let dropped = 0;
        const isUserTurn = (m) => m.role === 'user' && m.meta?.kind !== 'tool_result' && m.meta?.kind !== 'parse_retry' && m.meta?.kind !== 'context';
        while (!fits() && messages.length > 2) {
            // Never drop the last user turn.
            const lastUserIdx = findLastIndex(messages, isUserTurn);
            let start = messages[0]?.meta?.kind === 'context' ? 1 : 0;
            if (start >= lastUserIdx)
                break;
            let end = start + 1;
            while (end < messages.length && !isUserTurn(messages[end]))
                end++;
            if (end > lastUserIdx)
                break;
            messages.splice(start, end - start);
            dropped += end - start;
            if (messages[0]?.meta?.kind !== 'context') {
                messages.unshift({ role: 'user', content: '[Earlier parts of this conversation were removed to fit the context window.]', meta: { kind: 'context' } });
            }
        }
        return dropped;
    }
    /** Warn when the server likely truncated the prompt or we are at the edge of the window. */
    truncationWarned = false;
    lowCountStreak = 0;
    checkUsage(usage, estimatedPrompt) {
        if (!usage?.promptTokens)
            return undefined;
        const window = this.getWindow();
        const total = usage.promptTokens + (usage.completionTokens ?? 0);
        if (total >= window * 0.98)
            return `context window nearly full (${total}/${window} tokens). Use /compact or /clear.`;
        if (estimatedPrompt > 400 && usage.promptTokens < estimatedPrompt * 0.6) {
            // Warn once, and only when the mismatch persists after calibration had a chance to adapt.
            this.lowCountStreak++;
            if (this.lowCountStreak >= 2 && !this.truncationWarned) {
                this.truncationWarned = true;
                return `server reported ${usage.promptTokens} prompt tokens but ~${estimatedPrompt} were sent — the server may be silently truncating the conversation. Increase contextWindow (num_ctx) in config.`;
            }
            return undefined;
        }
        this.lowCountStreak = 0;
        return undefined;
    }
}
function findLastIndex(arr, pred) {
    for (let i = arr.length - 1; i >= 0; i--)
        if (pred(arr[i]))
            return i;
    return -1;
}
//# sourceMappingURL=context.js.map