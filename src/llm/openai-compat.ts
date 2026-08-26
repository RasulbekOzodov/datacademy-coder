import { jsonrepair } from 'jsonrepair';
import type { OpenAIProviderConfig } from '../config/schema.js';
import { describeFetchError, fetchJson, isConnectionReset, readSse } from './stream-readers.js';
import {
  ProviderHttpError,
  ToolsUnsupportedError,
  type ChatRequest,
  type LLMProvider,
  type Message,
  type ProviderCapabilities,
  type StreamEvent,
  type ToolCall,
  type ToolDef,
} from './types.js';

export interface OpenAIDeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIChunk {
  choices?: Array<{
    index?: number;
    delta?: { content?: string | null; reasoning_content?: string; reasoning?: string; tool_calls?: OpenAIDeltaToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
}

function toOpenAIMessages(messages: Message[]): unknown[] {
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

function toOpenAITools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function parseArguments(raw: string): Record<string, unknown> {
  const s = (raw ?? '').trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { _raw: s };
  } catch {
    try {
      const v = JSON.parse(jsonrepair(s));
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { _raw: s };
    } catch {
      return { _raw: s };
    }
  }
}

/**
 * Pure stream processor: turns OpenAI-style chunks into StreamEvents, assembling tool calls
 * from deltas by `index`. Exported so it can be unit-tested with recorded chunk arrays.
 */
export async function* processOpenAIChunks(chunks: AsyncIterable<OpenAIChunk> | Iterable<OpenAIChunk>, makeId: () => string): AsyncGenerator<StreamEvent> {
  const pending = new Map<number, { id?: string; name: string; args: string }>();
  let finish: string | undefined;
  let usage: { promptTokens?: number; completionTokens?: number } | undefined;

  for await (const chunk of chunks as AsyncIterable<OpenAIChunk>) {
    if (chunk.error) {
      const msg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message;
      throw new Error(`Server error: ${msg}`);
    }
    if (chunk.usage) {
      usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) yield { type: 'thinking_delta', text: reasoning };
    if (delta.content) yield { type: 'text_delta', text: delta.content };
    if (delta.tool_calls?.length) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = pending.get(idx);
        if (!entry) {
          entry = { id: tc.id, name: tc.function?.name ?? '', args: '' };
          pending.set(idx, entry);
        }
        if (tc.id && !entry.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = entry.name ? entry.name : tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  for (const [, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entry.name) continue;
    const call: ToolCall = { id: entry.id ?? makeId(), name: entry.name, arguments: parseArguments(entry.args) };
    yield { type: 'tool_call', call };
  }
  if (usage) yield { type: 'usage', usage };
  yield { type: 'done', finishReason: finish };
}

export class OpenAICompatProvider implements LLMProvider {
  readonly type = 'openai' as const;
  model: string;
  contextWindow: number;
  private caps?: ProviderCapabilities;
  private callCounter = 0;
  private supportsStreamOptions?: boolean;

  constructor(
    public readonly name: string,
    private cfg: OpenAIProviderConfig,
  ) {
    this.model = cfg.model;
    this.contextWindow = cfg.contextWindow;
  }

  private get baseUrl(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  async healthCheck(): Promise<void> {
    try {
      await fetchJson(`${this.baseUrl}/models`, { headers: this.headers(), timeoutMs: 5000 });
    } catch (err) {
      throw new Error(`OpenAI-compatible server ${describeFetchError(err, this.baseUrl)}`);
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetchJson<{ data?: Array<{ id: string }> }>(`${this.baseUrl}/models`, { headers: this.headers() });
    return (res.data ?? []).map((m) => m.id);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    if (this.caps) return this.caps;
    let contextWindow: number | undefined;
    // llama.cpp server exposes /props with the active n_ctx.
    try {
      const root = this.baseUrl.replace(/\/v1$/, '');
      const props = await fetchJson<{ default_generation_settings?: { n_ctx?: number } }>(`${root}/props`, { headers: this.headers(), timeoutMs: 3000 });
      const n = props.default_generation_settings?.n_ctx;
      if (typeof n === 'number' && n > 0) contextWindow = n;
    } catch {
      /* not llama.cpp */
    }
    if (contextWindow && contextWindow < this.contextWindow) this.contextWindow = contextWindow;
    this.caps = { nativeTools: this.cfg.nativeTools ?? true, contextWindow: this.contextWindow };
    return this.caps;
  }

  /** DataCademy gateway (and any compatible server) exposes GET /usage next to /chat/completions. */
  async usage(): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(`${this.baseUrl}/usage`, { headers: this.headers(), timeoutMs: 8000 });
  }

  async describe(): Promise<string> {
    const c = await this.capabilities();
    return [
      `provider: ${this.name} (openai-compatible @ ${this.baseUrl})`,
      `model: ${this.model}`,
      `context budget: ${this.contextWindow}`,
      `native tools: ${c.nativeTools ? 'assumed yes (text parser also active)' : 'no (text mode)'}`,
    ].join('\n');
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req.messages),
      stream: true,
      ...(this.supportsStreamOptions === false ? {} : { stream_options: { include_usage: true } }),
      temperature: req.options?.temperature ?? this.cfg.temperature,
      max_tokens: req.options?.maxTokens ?? this.cfg.maxTokens,
    };
    if (req.options?.stop?.length) body.stop = req.options.stop;
    if (req.tools?.length) body.tools = toOpenAITools(req.tools);

    const post = async (payload: Record<string, unknown>, attempt = 1): Promise<Response> => {
      try {
        return await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: req.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        // A stale keep-alive socket (server closed it while we were idle) resets on first use; retry once.
        if (attempt === 1 && isConnectionReset(err)) return post(payload, 2);
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
    yield* processOpenAIChunks(readSse<OpenAIChunk>(res.body), () => `call_${++this.callCounter}`);
  }
}
