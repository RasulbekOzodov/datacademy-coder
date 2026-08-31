import fs from 'node:fs';
import path from 'node:path';
import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN, ToolCallGate, defaultIdGen, formatToolCallText, parseToolCalls } from '../llm/tool-parser.js';
import { ToolsUnsupportedError } from '../llm/types.js';
import { ContextManager } from './context.js';
import { buildSystemPrompt, buildTurnContext, loadProjectInstructions } from './prompt.js';
const MAX_PARSE_RETRIES = 2;
const MAX_IDENTICAL_FAILURES = 3;
const MAX_IDENTICAL_REPEATS = 4;
const MAX_ACTION_NUDGES = 3;
/** Tool calls executed from a single model message (models like Qwen-7B batch independent writes). */
const MAX_CALLS_PER_TURN = 6;
/**
 * File names the answer talks about creating/writing that do not exist in cwd yet —
 * a strong sign the model narrated the work instead of doing it.
 */
function missingReferencedFiles(answer, cwd) {
    if (!/\b(create|creating|write|writing|add|adding|make|making|generate|save|yarat|yoz|qo'sh)\b/i.test(answer))
        return [];
    const names = new Set();
    for (const m of answer.matchAll(/(?<![\w/.:-])([\w][\w.-]*\/)*[\w][\w-]*\.(html|css|js|mjs|cjs|ts|tsx|jsx|py|json|md|txt|yml|yaml|toml|env|sh|ps1|java|go|rs|c|cpp|h)\b/gi)) {
        const name = m[0];
        if (/^https?:/i.test(name) || name.length > 80)
            continue;
        names.add(name);
    }
    const missing = [];
    for (const name of names) {
        try {
            if (!fs.existsSync(path.resolve(cwd, name)))
                missing.push(name);
        }
        catch {
            /* ignore odd names */
        }
    }
    return missing.slice(0, 6);
}
/** Names small models invent when they want to "return" a final message instead of writing plain text. */
const FINAL_ANSWER_TOOL_RE = /^(summary|summarize|final|final_answer|finalanswer|answer|respond|response|reply|done|finish|finished|complete|message|report|conclude|conclusion|output)$/i;
/**
 * Heuristic: the user asked for something to be built/changed, and the answer reads like
 * instructions ("Create the index.html file…", code fences, numbered steps) without any tool use.
 */
function looksLikePlanOnly(answer, userInput) {
    const a = answer.trim();
    if (a.length < 40)
        return false;
    const q = userInput.trim();
    if (/\?\s*$/.test(q))
        return false; // plain questions may legitimately be answered in text
    const wantsAction = /\b(create|make|build|write|add|implement|generate|fix|change|update|refactor|run|install|setup|set up|yarat|qil|qur|yoz|tuzat|o'zgartir|qo'sh|ishga tushir)\b/i.test(q);
    if (!wantsAction)
        return false;
    const hasFence = /```/.test(a);
    const stepTalk = /\b(create|add|write|open|save|run)\b[^\n]{0,60}\b(file|folder|directory|\.html|\.css|\.js|\.ts|\.py|\.json|\.md)\b/i.test(a);
    const numbered = (a.match(/^\s*\d+\.\s/gm) ?? []).length >= 2;
    return hasFence || stepTalk || numbered;
}
function repeatNudge(userInput) {
    return `You repeated your previous answer instead of addressing the new message. The user's new message is: "${userInput.trim().slice(0, 300)}". Do not repeat yourself: use read_file to inspect the relevant files, fix problems with edit_file, and then answer this specific message.`;
}
function extractMessage(args) {
    for (const k of ['message', 'text', 'content', 'answer', 'summary', 'response', 'result', 'output']) {
        const v = args[k];
        if (typeof v === 'string' && v.trim())
            return v.trim();
    }
    const strings = Object.values(args).filter((v) => typeof v === 'string' && v.trim().length > 0);
    return strings.length === 1 ? strings[0].trim() : undefined;
}
export class Agent {
    opts;
    messages = [];
    provider;
    ctx;
    context;
    resolvedMode;
    systemPromptCache;
    makeId = defaultIdGen();
    lastUsage;
    /** Final answer of the previous run — used to catch small models parroting themselves. */
    lastFinalText;
    constructor(opts) {
        this.opts = opts;
        this.provider = opts.provider;
        this.ctx = { cwd: opts.cwd, config: opts.config, readFiles: new Set(), undoStack: [] };
        this.context = new ContextManager(() => this.provider.contextWindow);
    }
    get config() {
        return this.opts.config;
    }
    get toolMode() {
        return this.resolvedMode;
    }
    setProvider(provider) {
        this.provider = provider;
        this.resolvedMode = undefined;
        this.systemPromptCache = undefined;
    }
    setModel(model) {
        this.provider.model = model;
        this.resolvedMode = undefined;
    }
    clear() {
        this.messages = [];
        this.ctx.readFiles.clear();
        this.lastUsage = undefined;
    }
    compact() {
        return this.context.compact(this.messages, this.toolDefsFor(this.resolvedMode ?? 'native'), this.systemPrompt(this.resolvedMode ?? 'native'));
    }
    /** Restore the last file changed by write_file/edit_file. */
    async undo() {
        const entry = this.ctx.undoStack.pop();
        if (!entry)
            return undefined;
        const fs = await import('node:fs/promises');
        if (entry.previous === null) {
            await fs.rm(entry.path, { force: true });
            return `deleted ${entry.path} (it was created by the agent)`;
        }
        await fs.writeFile(entry.path, entry.previous, 'utf8');
        return `restored ${entry.path}`;
    }
    estimatedTokens() {
        const mode = this.resolvedMode ?? 'native';
        return this.context.estimate(this.messages, this.toolDefsFor(mode), this.systemPrompt(mode));
    }
    get lastPromptTokens() {
        return this.lastUsage?.promptTokens;
    }
    async resolveToolMode() {
        if (this.resolvedMode)
            return this.resolvedMode;
        const configured = this.config.toolMode;
        if (configured === 'native' || configured === 'text') {
            this.resolvedMode = configured;
        }
        else {
            const caps = await this.provider.capabilities();
            this.resolvedMode = caps.nativeTools ? 'native' : 'text';
            if (!caps.nativeTools)
                this.opts.ui.onInfo(`model has no native tool support — using text tool-calling`);
        }
        return this.resolvedMode;
    }
    toolDefsFor(mode) {
        return mode === 'native' ? this.opts.tools.defs() : undefined;
    }
    systemPrompt(mode) {
        const key = `${mode}:${this.provider.name}:${this.provider.model}`;
        if (this.systemPromptCache?.key === key)
            return this.systemPromptCache.prompt;
        const prompt = buildSystemPrompt({
            cwd: this.opts.cwd,
            shell: this.opts.shell,
            tools: this.opts.tools.defs(),
            toolMode: mode,
            projectInstructions: loadProjectInstructions(this.opts.cwd),
        });
        this.systemPromptCache = { key, prompt };
        return prompt;
    }
    /** Run one user request to completion (the agentic loop). */
    async run(userInput, signal) {
        const ui = this.opts.ui;
        const isFirst = !this.messages.some((m) => m.role === 'user' && m.meta?.kind !== 'tool_result');
        const content = isFirst ? `${userInput.trim()}\n\n${buildTurnContext(this.opts.cwd)}` : userInput.trim();
        this.messages.push({ role: 'user', content });
        let parseRetries = 0;
        let iterations = 0;
        const failedCalls = new Map();
        const repeatedCalls = new Map();
        let usedTools = false;
        let nudgedForSummary = false;
        let nudgedForRepeat = false;
        let actionNudges = 0;
        while (iterations < this.config.maxIterations) {
            if (signal.aborted)
                break;
            iterations++;
            const mode = await this.resolveToolMode();
            const systemPrompt = this.systemPrompt(mode);
            const toolDefs = this.toolDefsFor(mode);
            for (const note of this.context.ensureBudget(this.messages, toolDefs, systemPrompt))
                ui.onInfo(note);
            const estimated = this.context.estimate(this.messages, toolDefs, systemPrompt);
            let turn;
            try {
                turn = await this.streamTurn(mode, systemPrompt, signal);
            }
            catch (err) {
                if (err instanceof ToolsUnsupportedError) {
                    ui.onInfo(`server rejected native tools (${err.message}) — switching to text tool-calling`);
                    this.resolvedMode = 'text';
                    this.systemPromptCache = undefined;
                    continue;
                }
                if (isAbort(err) || signal.aborted) {
                    this.recordInterrupt('');
                    break;
                }
                throw err;
            }
            this.opts.debug.write({ type: 'turn', mode, model: this.provider.model, estimatedPrompt: estimated, usage: turn.usage, rawText: turn.rawText, calls: turn.toolCalls, parseErrors: turn.parseErrors, finish: turn.finishReason });
            if (turn.usage) {
                this.lastUsage = turn.usage;
                this.context.calibrate(turn.usage.promptTokens, estimated);
                const warn = this.context.checkUsage(turn.usage, estimated);
                if (warn)
                    ui.onWarn(warn);
            }
            if (turn.aborted) {
                this.recordInterrupt(turn.text);
                break;
            }
            const calls = turn.toolCalls.slice(0, MAX_CALLS_PER_TURN);
            const call = calls[0];
            // Record the assistant message (with every call we are going to execute).
            if (mode === 'native') {
                this.messages.push({ role: 'assistant', content: turn.text, ...(call ? { toolCalls: calls } : {}) });
            }
            else {
                const body = call ? `${turn.text ? `${turn.text}\n` : ''}${calls.map(formatToolCallText).join('\n')}` : turn.text;
                this.messages.push({ role: 'assistant', content: body, ...(call ? { toolCalls: calls } : {}) });
            }
            // Small models often "call" a non-existent summary/final_answer tool to finish. Treat it as the answer.
            if (call && !this.opts.tools.get(call.name) && FINAL_ANSWER_TOOL_RE.test(call.name)) {
                const text = extractMessage(call.arguments);
                if (text) {
                    this.messages[this.messages.length - 1] = { role: 'assistant', content: text };
                    if (this.isParroting(text) && !nudgedForRepeat) {
                        nudgedForRepeat = true;
                        ui.onWarn('the model repeated its previous answer — asking it to address the new request');
                        this.messages.push({ role: 'user', content: repeatNudge(userInput), meta: { kind: 'parse_retry' } });
                        continue;
                    }
                    ui.onFirstToken();
                    ui.onText(text);
                    ui.onResponseEnd();
                    this.lastFinalText = text;
                    break;
                }
            }
            if (!call) {
                if (turn.text.trim() && this.isParroting(turn.text) && !nudgedForRepeat) {
                    nudgedForRepeat = true;
                    ui.onWarn('the model repeated its previous answer — asking it to address the new request');
                    this.messages.push({ role: 'user', content: repeatNudge(userInput), meta: { kind: 'parse_retry' } });
                    continue;
                }
                // "Here is how you would do it..." / "Create the style.css file" without doing it: push the model to act.
                if (actionNudges < MAX_ACTION_NUDGES) {
                    const missing = missingReferencedFiles(turn.text, this.opts.cwd);
                    const planOnly = !usedTools && looksLikePlanOnly(turn.text, userInput);
                    if (missing.length || planOnly) {
                        actionNudges++;
                        ui.onWarn(missing.length
                            ? `the model mentioned ${missing.join(', ')} but did not create ${missing.length > 1 ? 'them' : 'it'} — asking it to act`
                            : 'the model described the steps instead of doing them — asking it to act');
                        const what = missing.length
                            ? `These files you mentioned do not exist yet: ${missing.join(', ')}. Showing code in your answer does NOT create files. Create each of them now with write_file (one call per file, full contents in the "content" argument).`
                            : 'You described the steps but did not do them. Showing code in your answer does NOT create files. Do the work now using tools: write_file for each file (full contents in "content"), edit_file for changes, shell to run commands.';
                        this.messages.push({
                            role: 'user',
                            content: `${what} One tool call per message. Do not show file contents in your answer; put them in the tool call. Continue until everything you planned is actually done, then give a short summary.`,
                            meta: { kind: 'parse_retry' },
                        });
                        continue;
                    }
                }
                if (turn.text.trim())
                    this.lastFinalText = turn.text;
                if (!turn.text.trim() && usedTools && !nudgedForSummary && !turn.parseErrors.length) {
                    // Work was done but no final message: ask once for a short plain-text summary.
                    nudgedForSummary = true;
                    this.messages.push({ role: 'user', content: 'Now reply in plain text (no tool call) with a short summary of what you did and the result.', meta: { kind: 'parse_retry' } });
                    continue;
                }
                if (turn.parseErrors.length && parseRetries < MAX_PARSE_RETRIES) {
                    parseRetries++;
                    ui.onWarn(`could not parse the tool call (${turn.parseErrors[0].slice(0, 120)}) — asking the model to retry`);
                    this.messages.push({
                        role: 'user',
                        content: `Your tool call could not be parsed: ${turn.parseErrors[0]}\nRe-emit it as a single ${TOOL_CALL_OPEN} block containing one JSON object with "name" and "arguments".`,
                        meta: { kind: 'parse_retry' },
                    });
                    continue;
                }
                if (!turn.text.trim() && turn.finishReason === 'length')
                    ui.onWarn('the response was cut off by the max token limit');
                break; // final answer
            }
            parseRetries = 0;
            // Execute every call of this turn in order. Each gets its own permission check and result;
            // after a failure the remaining calls are skipped (they usually depend on it).
            let stopRun = false;
            let skipReason;
            for (let i = 0; i < calls.length; i++) {
                const c = calls[i];
                if (skipReason) {
                    this.messages.push(this.toolResultMessage(mode, c, `Not executed: ${skipReason}`));
                    continue;
                }
                const callKey = `${c.name}:${JSON.stringify(c.arguments)}`;
                const priorFailures = failedCalls.get(callKey) ?? 0;
                const priorRepeats = repeatedCalls.get(callKey) ?? 0;
                if (priorFailures >= MAX_IDENTICAL_FAILURES || priorRepeats >= MAX_IDENTICAL_REPEATS) {
                    ui.onWarn(`the model keeps repeating the same call (${c.name}) — stopping. Give it more specific instructions or try a larger model.`);
                    this.messages.push(this.toolResultMessage(mode, c, 'Not executed: this exact call was already made several times. Stopped; answer the user with what you know.'));
                    skipReason = 'stopped after repeated identical calls.';
                    stopRun = true;
                    continue;
                }
                const result = await this.executeCall(c, signal);
                usedTools = true;
                repeatedCalls.set(callKey, priorRepeats + 1);
                let resultText = result.content;
                if (result.isError) {
                    failedCalls.set(callKey, priorFailures + 1);
                    if (priorFailures >= 1) {
                        resultText += `\n\n[You already made this exact call ${priorFailures + 1} times and it failed each time. Do NOT repeat it. Change your approach: read the file with read_file and copy the "old" text exactly, or ask the user.]`;
                    }
                    if (i < calls.length - 1)
                        skipReason = `the previous call (${c.name}) failed; ${calls.length - 1 - i} later call(s) were skipped. Fix the problem, then call them again.`;
                }
                else if (priorRepeats >= 1) {
                    resultText += `\n\n[You already made this exact call ${priorRepeats + 1} times; the result is the same. Do not call it again — use this result and continue, or give your final answer.]`;
                }
                if (turn.toolCalls.length > MAX_CALLS_PER_TURN && i === calls.length - 1) {
                    resultText += `\n\n[Note: you requested ${turn.toolCalls.length} tool calls in one message; only the first ${MAX_CALLS_PER_TURN} were executed. Call the rest now.]`;
                }
                this.messages.push(this.toolResultMessage(mode, c, resultText));
                if (signal.aborted) {
                    skipReason = 'aborted by user.';
                    stopRun = true;
                }
            }
            if (stopRun || signal.aborted)
                break;
        }
        if (iterations >= this.config.maxIterations)
            ui.onWarn(`stopped after ${iterations} iterations (maxIterations). Ask me to continue if needed.`);
    }
    /** True when a new final answer is (nearly) identical to the previous run's final answer. */
    isParroting(text) {
        if (!this.lastFinalText)
            return false;
        const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const a = norm(text);
        const b = norm(this.lastFinalText);
        if (a.length < 20)
            return false;
        return a === b || (a.length > 60 && (a.includes(b) || b.includes(a)));
    }
    recordInterrupt(partialText) {
        const text = `${partialText}${partialText ? '\n' : ''}[Interrupted by user]`;
        this.messages.push({ role: 'assistant', content: text, meta: { kind: 'interrupt' } });
    }
    toolResultMessage(mode, call, content) {
        if (mode === 'native') {
            return { role: 'tool', content, toolCallId: call.id, toolName: call.name, meta: { kind: 'tool_result', toolName: call.name } };
        }
        return { role: 'user', content: `<tool_result name="${call.name}">\n${content}\n</tool_result>`, meta: { kind: 'tool_result', toolName: call.name } };
    }
    async executeCall(call, signal) {
        const ui = this.opts.ui;
        const tool = this.opts.tools.get(call.name);
        if (!tool) {
            const res = { content: `Unknown tool "${call.name}". Available tools: ${this.opts.tools.names().join(', ')}.`, isError: true };
            ui.onToolStart(call, `${call.name} (unknown tool)`);
            ui.onToolResult(call, res, 0);
            return res;
        }
        const description = safe(() => tool.describeCall(call.arguments), call.name);
        ui.onToolStart(call, description);
        const started = Date.now();
        let result;
        try {
            const decision = await this.opts.permissions.check(tool, call.arguments, this.ctx);
            if (!decision.allowed)
                result = { content: decision.reason ?? 'Denied.', isError: true };
            else {
                ui.onToolExecuting?.(call);
                this.ctx.signal = signal;
                result = await tool.execute(call.arguments, this.ctx);
            }
        }
        catch (err) {
            result = { content: `${tool.name} failed: ${err.message}`, isError: true };
        }
        finally {
            this.ctx.signal = undefined;
        }
        if (signal.aborted && !result.isError)
            result = { ...result, content: `${result.content}\n[aborted by user]` };
        ui.onToolResult(call, result, Date.now() - started);
        this.opts.debug.write({ type: 'tool', name: call.name, args: call.arguments, isError: result.isError, chars: result.content.length });
        return result;
    }
    async streamTurn(mode, systemPrompt, signal) {
        const ui = this.opts.ui;
        const messages = [{ role: 'system', content: systemPrompt }, ...this.messages];
        const toolDefs = this.toolDefsFor(mode);
        const gate = new ToolCallGate();
        let rawText = '';
        let thinking = '';
        let shownAny = false;
        let firstToken = false;
        let receivedChars = 0;
        const nativeCalls = [];
        let usage;
        let finishReason;
        let aborted = false;
        const show = (s) => {
            if (!s)
                return;
            if (!firstToken) {
                firstToken = true;
                ui.onFirstToken();
            }
            shownAny = true;
            ui.onText(s);
        };
        // Local controller so we can cut off a runaway (repeating) generation without it counting as a user abort.
        const local = new AbortController();
        const onUserAbort = () => local.abort();
        signal.addEventListener('abort', onUserAbort, { once: true });
        let cutByGuard = false;
        const repetition = new RepetitionGuard();
        ui.onTurnStart();
        this.opts.debug.write({ type: 'request', mode, model: this.provider.model, messages: messages.length, tools: toolDefs?.map((t) => t.name) });
        try {
            for await (const ev of this.provider.chat({
                messages,
                tools: toolDefs,
                signal: local.signal,
                options: mode === 'text' ? { stop: [TOOL_CALL_CLOSE] } : undefined,
            })) {
                switch (ev.type) {
                    case 'text_delta':
                        rawText += ev.text;
                        receivedChars += ev.text.length;
                        ui.onStreamProgress?.(receivedChars);
                        show(gate.push(ev.text));
                        if (repetition.push(ev.text)) {
                            cutByGuard = true;
                            local.abort();
                        }
                        break;
                    case 'thinking_delta':
                        // Thinking is hidden in the terminal UI — keep the status line alive (no onFirstToken).
                        thinking += ev.text;
                        receivedChars += ev.text.length;
                        ui.onStreamProgress?.(receivedChars);
                        ui.onThinking(ev.text);
                        break;
                    case 'tool_call':
                        if (!firstToken) {
                            firstToken = true;
                            ui.onFirstToken();
                        }
                        nativeCalls.push(ev.call);
                        break;
                    case 'usage':
                        usage = ev.usage;
                        break;
                    case 'done':
                        finishReason = ev.finishReason;
                        break;
                }
            }
        }
        catch (err) {
            if (signal.aborted)
                aborted = true;
            else if (isAbort(err) && cutByGuard) {
                /* runaway generation cut short; treat what we have as the turn */
            }
            else
                throw err;
        }
        finally {
            signal.removeEventListener('abort', onUserAbort);
            show(gate.flush());
            if (!firstToken)
                ui.onFirstToken();
            if (shownAny)
                ui.onResponseEnd();
            if (cutByGuard)
                ui.onWarn('the model started repeating itself — generation cut short');
        }
        // The stop sequence eats the closing tag; restore it so history stays well-formed.
        if (rawText.includes(TOOL_CALL_OPEN) && !rawText.includes(TOOL_CALL_CLOSE))
            rawText += `\n${TOOL_CALL_CLOSE}`;
        const parsed = parseToolCalls(rawText, this.makeId);
        const toolCalls = nativeCalls.length ? nativeCalls : parsed.calls;
        return {
            text: parsed.text,
            thinking,
            toolCalls,
            usage,
            finishReason,
            aborted,
            rawText,
            parseErrors: nativeCalls.length ? [] : parsed.errors,
        };
    }
}
/**
 * Detects degenerate generations (small models looping the same line / JSON object) so the turn
 * can be cut off early instead of burning the whole max-token budget on CPU.
 */
export class RepetitionGuard {
    maxConsecutive;
    maxTotal;
    buf = '';
    lastLine = '';
    repeats = 0;
    seen = new Map();
    constructor(maxConsecutive = 3, maxTotal = 6) {
        this.maxConsecutive = maxConsecutive;
        this.maxTotal = maxTotal;
    }
    /** Feed a delta; returns true when the output should be cut. */
    push(delta) {
        this.buf += delta;
        let idx;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, idx).trim();
            this.buf = this.buf.slice(idx + 1);
            if (line.length < 24)
                continue;
            if (line === this.lastLine)
                this.repeats++;
            else {
                this.lastLine = line;
                this.repeats = 1;
            }
            const total = (this.seen.get(line) ?? 0) + 1;
            this.seen.set(line, total);
            if (this.repeats >= this.maxConsecutive || total >= this.maxTotal)
                return true;
        }
        return false;
    }
}
function isAbort(err) {
    const e = err;
    return e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
}
function safe(fn, fallback) {
    try {
        return fn();
    }
    catch {
        return fallback;
    }
}
//# sourceMappingURL=loop.js.map