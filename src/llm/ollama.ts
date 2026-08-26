import type { OllamaProviderConfig } from '../config/schema.js';
import { describeFetchError, fetchJson, isConnectionReset, readNdjson } from './stream-readers.js';
import {
  ProviderHttpError,
  ToolsUnsupportedError,
  type ChatRequest,
  type LLMProvider,
  type Message,
  type ProviderCapabilities,
  type StreamEvent,
  type ToolDef,
} from './types.js';

interface OllamaToolCall {
  id?: string;
  function: { index?: number; name: string; arguments: Record<string, unknown> | string };
}

interface OllamaChunk {
  model?: string;
  message?: { role: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface OllamaShow {
  capabilities?: string[];
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
  model_info?: Record<string, unknown>;
}

interface OllamaTags {
  models?: Array<{ name: string; size?: number; details?: { parameter_size?: string } }>;
}

function toOllamaMessages(messages: Message[]): unknown[] {
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

function toOllamaTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export class OllamaProvider implements LLMProvider {
  readonly type = 'ollama' as const;
  model: string;
  contextWindow: number;
  private caps?: ProviderCapabilities & { family?: string; trainedContext?: number; paramSize?: string; quant?: string };
  private capsModel?: string;
  private callCounter = 0;

  constructor(
    public readonly name: string,
    private cfg: OllamaProviderConfig,
  ) {
    this.model = cfg.model;
    this.contextWindow = cfg.contextWindow;
  }

  private get baseUrl(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  async healthCheck(): Promise<void> {
    try {
      await fetchJson(`${this.baseUrl}/api/tags`, { timeoutMs: 5000 });
    } catch (err) {
      throw new Error(`Ollama ${describeFetchError(err, this.baseUrl)}  (yordam: \`ollama serve\`)`);
    }
  }

  async listModels(): Promise<string[]> {
    const tags = await fetchJson<OllamaTags>(`${this.baseUrl}/api/tags`);
    return (tags.models ?? []).map((m) => m.name);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    if (this.caps && this.capsModel === this.model) return this.caps;
    try {
      const show = await fetchJson<OllamaShow>(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
      });
      const caps = show.capabilities ?? [];
      const family = show.details?.family;
      let trainedContext: number | undefined;
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
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/not found/i.test(msg)) {
        throw new Error(`Model "${this.model}" Ollama'da topilmadi. \`ollama pull ${this.model}\` bajaring.`);
      }
      // Unknown failure: assume no native tools; the text parser covers it.
      this.caps = { nativeTools: false, contextWindow: this.contextWindow };
    }
    this.capsModel = this.model;
    return this.caps;
  }

  async describe(): Promise<string> {
    const c = (await this.capabilities()) as NonNullable<typeof this.caps>;
    const parts = [
      `provider: ${this.name} (ollama @ ${this.baseUrl})`,
      `model: ${this.model}${c.paramSize ? ` (${c.paramSize}${c.quant ? `, ${c.quant}` : ''})` : ''}`,
      `num_ctx: ${this.contextWindow}${c.trainedContext ? ` (model max ${c.trainedContext})` : ''}`,
      `native tools: ${c.nativeTools ? 'yes' : 'no (text mode)'}${c.thinking ? ', thinking: yes' : ''}`,
    ];
    return parts.join('\n');
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const caps = await this.capabilities();
    const body: Record<string, unknown> = {
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
    if (caps.thinking) body.think = false;
    if (req.tools?.length) body.tools = toOllamaTools(req.tools);

    const post = async (attempt = 1): Promise<Response> => {
      try {
        return await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        if (attempt === 1 && isConnectionReset(err)) return post(2); // stale keep-alive socket
        throw new Error(`Ollama ${describeFetchError(err, this.baseUrl)}`);
      }
    };
    const res = await post();
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      if (res.status === 400 && /does not support tools/i.test(text)) {
        throw new ToolsUnsupportedError(`Model ${this.model} does not support native tools`);
      }
      throw new ProviderHttpError(res.status, text, `${this.baseUrl}/api/chat`);
    }

    for await (const chunk of readNdjson<OllamaChunk>(res.body)) {
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const msg = chunk.message;
      if (msg?.thinking) yield { type: 'thinking_delta', text: msg.thinking };
      if (msg?.content) yield { type: 'text_delta', text: msg.content };
      if (msg?.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let args = tc.function.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args) as Record<string, unknown>;
            } catch {
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
