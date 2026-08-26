import { jsonrepair } from 'jsonrepair';
import { describeFetchError, fetchJson, isConnectionReset, readSse } from './stream-readers.js';
import { ProviderHttpError, ToolsUnsupportedError, } from './types.js';
function toOpenAIMessages(messages) {
    return messages.map((m) => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
                role: 'assistant',
                content: m.content ?? '',
                tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                })),
            };
        }
        if (m.role === 'tool') {
            return { role: 'tool', tool_call_id: m.toolCallId ?? m.toolName ?? 'call_0', content: m.content };
        }
        return { role: m.role, content: m.content };
    });
}
function toOpenAITools(tools) {
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
export function parseArguments(raw) {
    const s = (raw ?? '').trim();
    if (!s)
        return {};
    try {
        const v = JSON.parse(s);
        return typeof v === 'object' && v !== null ? v : { _raw: s };
    }
    catch {
        try {
            const v = JSON.parse(jsonrepair(s));
            return typeof v === 'object' && v !== null ? v : { _raw: s };
        }
        catch {
            return { _raw: s };
        }
    }
}
/**
 * Pure stream processor: turns OpenAI-style chunks into StreamEvents, assembling tool calls
 * from deltas by `index`. Exported so it can be unit-tested with recorded chunk arrays.
 */
export async function* processOpenAIChunks(chunks, makeId) {
    const pending = new Map();
    let finish;
    let usage;
    for await (const chunk of chunks) {
        if (chunk.error) {
            const msg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message;
            throw new Error(`Server error: ${msg}`);
        }
        if (chunk.usage) {
            usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
        }
        const choice = chunk.choices?.[0];
        if (!choice)
            continue;
        const delta = choice.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning)
            yield { type: 'thinking_delta', text: reasoning };
        if (delta.content)
            yield { type: 'text_delta', text: delta.content };
        if (delta.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                let entry = pending.get(idx);
                if (!entry) {
                    entry = { id: tc.id, name: tc.function?.name ?? '', args: '' };
                    pending.set(idx, entry);
                }
                if (tc.id && !entry.id)
                    entry.id = tc.id;
                if (tc.function?.name)
                    entry.name = entry.name ? entry.name : tc.function.name;
                if (tc.function?.arguments)
                    entry.args += tc.function.arguments;
            }
        }
        if (choice.finish_reason)
            finish = choice.finish_reason;
    }
    for (const [, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        if (!entry.name)
            continue;
        const call = { id: entry.id ?? makeId(), name: entry.name, arguments: parseArguments(entry.args) };
        yield { type: 'tool_call', call };
    }
    if (usage)
        yield { type: 'usage', usage };
    yield { type: 'done', finishReason: finish };
}
export class OpenAICompatProvider {
    name;
    cfg;
    type = 'openai';
    model;
    contextWindow;
    caps;
    callCounter = 0;
    supportsStreamOptions;
    constructor(name, cfg) {
        this.name = name;
        this.cfg = cfg;
        this.model = cfg.model;
        this.contextWindow = cfg.contextWindow;
    }
    get baseUrl() {
        return this.cfg.baseUrl.replace(/\/+$/, '');
    }
    headers() {
        const h = { 'content-type': 'application/json' };
        if (this.cfg.apiKey)
            h.authorization = `Bearer ${this.cfg.apiKey}`;
        return h;
    }
    async healthCheck() {
        try {
            await fetchJson(`${this.baseUrl}/models`, { headers: this.headers(), timeoutMs: 5000 });
        }
        catch (err) {
            throw new Error(`OpenAI-compatible server ${describeFetchError(err, this.baseUrl)}`);
        }
    }
    async listModels() {
        const res = await fetchJson(`${this.baseUrl}/models`, { headers: this.headers() });
        return (res.data ?? []).map((m) => m.id);
    }
    async capabilities() {
        if (this.caps)
            return this.caps;
        let contextWindow;
        // llama.cpp server exposes /props with the active n_ctx.
        try {
            const root = this.baseUrl.replace(/\/v1$/, '');
            const props = await fetchJson(`${root}/props`, { headers: this.headers(), timeoutMs: 3000 });
            const n = props.default_generation_settings?.n_ctx;
            if (typeof n === 'number' && n > 0)
                contextWindow = n;
        }
        catch {
            /* not llama.cpp */
        }
        if (contextWindow && contextWindow < this.contextWindow)
            this.contextWindow = contextWindow;
        this.caps = { nativeTools: this.cfg.nativeTools ?? true, contextWindow: this.contextWindow };
        return this.caps;
    }
    /** DataCademy gateway (and any compatible server) exposes GET /usage next to /chat/completions. */
    async usage() {
        return fetchJson(`${this.baseUrl}/usage`, { headers: this.headers(), timeoutMs: 8000 });
    }
    async describe() {
        const c = await this.capabilities();
        return [
            `provider: ${this.name} (openai-compatible @ ${this.baseUrl})`,
            `model: ${this.model}`,
            `context budget: ${this.contextWindow}`,
            `native tools: ${c.nativeTools ? 'assumed yes (text parser also active)' : 'no (text mode)'}`,
        ].join('\n');
    }
    async *chat(req) {
        const body = {
            model: this.model,
            messages: toOpenAIMessages(req.messages),
            stream: true,
            ...(this.supportsStreamOptions === false ? {} : { stream_options: { include_usage: true } }),
            temperature: req.options?.temperature ?? this.cfg.temperature,
            max_tokens: req.options?.maxTokens ?? this.cfg.maxTokens,
        };
        if (req.options?.stop?.length)
            body.stop = req.options.stop;
        if (req.tools?.length)
            body.tools = toOpenAITools(req.tools);
        const post = async (payload, attempt = 1) => {
            try {
                return await fetch(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: this.headers(),
                    body: JSON.stringify(payload),
                    signal: req.signal,
                });
            }
            catch (err) {
                if (err.name === 'AbortError')
                    throw err;
                // A stale keep-alive socket (server closed it while we were idle) resets on first use; retry once.
                if (attempt === 1 && isConnectionReset(err))
                    return post(payload, 2);
                throw new Error(`OpenAI-compatible server ${describeFetchError(err, this.baseUrl)}`);
            }
        };
        let res = await post(body);
        if (!res.ok && res.status === 400 && this.supportsStreamOptions !== false) {
            // Some servers reject stream_options; retry once without it and remember.
            const text = await res.clone().text().catch(() => '');
            if (/stream_options/i.test(text)) {
                this.supportsStreamOptions = false;
                delete body.stream_options;
                res = await post(body);
            }
        }
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => '');
            if (req.tools?.length && res.status === 400 && /tool/i.test(text)) {
                throw new ToolsUnsupportedError(`Server rejected tools for ${this.model}: ${text.slice(0, 200)}`);
            }
            throw new ProviderHttpError(res.status, text, `${this.baseUrl}/chat/completions`);
        }
        yield* processOpenAIChunks(readSse(res.body), () => `call_${++this.callCounter}`);
    }
}
//# sourceMappingURL=openai-compat.js.map