import { describeFetchError, fetchJson, readNdjson } from './stream-readers.js';
import { ProviderHttpError, ToolsUnsupportedError, } from './types.js';
function toOllamaMessages(messages) {
    return messages.map((m) => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
                role: 'assistant',
                content: m.content ?? '',
                tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
            };
        }
        if (m.role === 'tool') {
            return { role: 'tool', content: m.content, tool_name: m.toolName, ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}) };
        }
        return { role: m.role, content: m.content };
    });
}
function toOllamaTools(tools) {
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
export class OllamaProvider {
    name;
    cfg;
    type = 'ollama';
    model;
    contextWindow;
    caps;
    capsModel;
    callCounter = 0;
    constructor(name, cfg) {
        this.name = name;
        this.cfg = cfg;
        this.model = cfg.model;
        this.contextWindow = cfg.contextWindow;
    }
    get baseUrl() {
        return this.cfg.baseUrl.replace(/\/+$/, '');
    }
    async healthCheck() {
        try {
            await fetchJson(`${this.baseUrl}/api/tags`, { timeoutMs: 5000 });
        }
        catch (err) {
            throw new Error(`Ollama ${describeFetchError(err, this.baseUrl)}  (yordam: \`ollama serve\`)`);
        }
    }
    async listModels() {
        const tags = await fetchJson(`${this.baseUrl}/api/tags`);
        return (tags.models ?? []).map((m) => m.name);
    }
    async capabilities() {
        if (this.caps && this.capsModel === this.model)
            return this.caps;
        try {
            const show = await fetchJson(`${this.baseUrl}/api/show`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model: this.model }),
            });
            const caps = show.capabilities ?? [];
            const family = show.details?.family;
            let trainedContext;
            if (show.model_info) {
                for (const [k, v] of Object.entries(show.model_info)) {
                    if (k.endsWith('.context_length') && typeof v === 'number') {
                        trainedContext = v;
                        break;
                    }
                }
            }
            this.caps = {
                nativeTools: caps.includes('tools'),
                thinking: caps.includes('thinking'),
                contextWindow: this.contextWindow,
                family,
                trainedContext,
                paramSize: show.details?.parameter_size,
                quant: show.details?.quantization_level,
            };
        }
        catch (err) {
            const msg = err.message ?? '';
            if (/not found/i.test(msg)) {
                throw new Error(`Model "${this.model}" Ollama'da topilmadi. \`ollama pull ${this.model}\` bajaring.`);
            }
            // Unknown failure: assume no native tools; the text parser covers it.
            this.caps = { nativeTools: false, contextWindow: this.contextWindow };
        }
        this.capsModel = this.model;
        return this.caps;
    }
    async describe() {
        const c = (await this.capabilities());
        const parts = [
            `provider: ${this.name} (ollama @ ${this.baseUrl})`,
            `model: ${this.model}${c.paramSize ? ` (${c.paramSize}${c.quant ? `, ${c.quant}` : ''})` : ''}`,
            `num_ctx: ${this.contextWindow}${c.trainedContext ? ` (model max ${c.trainedContext})` : ''}`,
            `native tools: ${c.nativeTools ? 'yes' : 'no (text mode)'}${c.thinking ? ', thinking: yes' : ''}`,
        ];
        return parts.join('\n');
    }
    async *chat(req) {
        const caps = await this.capabilities();
        const body = {
            model: this.model,
            messages: toOllamaMessages(req.messages),
            stream: true,
            keep_alive: this.cfg.keepAlive,
            options: {
                num_ctx: this.contextWindow,
                temperature: req.options?.temperature ?? this.cfg.temperature,
                num_predict: req.options?.maxTokens ?? this.cfg.maxTokens,
                repeat_penalty: 1.0,
                ...(req.options?.stop?.length ? { stop: req.options.stop } : {}),
            },
        };
        if (caps.thinking)
            body.think = false;
        if (req.tools?.length)
            body.tools = toOllamaTools(req.tools);
        let res;
        try {
            res = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: req.signal,
            });
        }
        catch (err) {
            if (err.name === 'AbortError')
                throw err;
            throw new Error(`Ollama ${describeFetchError(err, this.baseUrl)}`);
        }
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => '');
            if (res.status === 400 && /does not support tools/i.test(text)) {
                throw new ToolsUnsupportedError(`Model ${this.model} does not support native tools`);
            }
            throw new ProviderHttpError(res.status, text, `${this.baseUrl}/api/chat`);
        }
        for await (const chunk of readNdjson(res.body)) {
            if (chunk.error)
                throw new Error(`Ollama: ${chunk.error}`);
            const msg = chunk.message;
            if (msg?.thinking)
                yield { type: 'thinking_delta', text: msg.thinking };
            if (msg?.content)
                yield { type: 'text_delta', text: msg.content };
            if (msg?.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    let args = tc.function.arguments;
                    if (typeof args === 'string') {
                        try {
                            args = JSON.parse(args);
                        }
                        catch {
                            args = { _raw: args };
                        }
                    }
                    yield {
                        type: 'tool_call',
                        call: { id: tc.id ?? `call_${++this.callCounter}`, name: tc.function.name, arguments: args ?? {} },
                    };
                }
            }
            if (chunk.done) {
                yield { type: 'usage', usage: { promptTokens: chunk.prompt_eval_count, completionTokens: chunk.eval_count } };
                yield { type: 'done', finishReason: chunk.done_reason };
            }
        }
    }
}
//# sourceMappingURL=ollama.js.map