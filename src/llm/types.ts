export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface MessageMeta {
  kind?: 'tool_result' | 'context' | 'interrupt' | 'parse_retry';
  toolName?: string;
  stubbed?: boolean;
}

export interface Message {
  role: Role;
  content: string;
  /** assistant: native tool calls made in this message */
  toolCalls?: ToolCall[];
  /** tool: which call this result answers */
  toolCallId?: string;
  toolName?: string;
  /** Agent-internal bookkeeping. Providers ignore it. */
  meta?: MessageMeta;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason?: string };

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface ChatRequest {
  messages: Message[];
  /** When present, native tool calling is requested. */
  tools?: ToolDef[];
  signal?: AbortSignal;
  options?: ChatOptions;
}

export interface ProviderCapabilities {
  nativeTools: boolean;
  /** Effective server-side context window if the provider can report it. */
  contextWindow?: number;
  thinking?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  readonly type: 'ollama' | 'openai';
  model: string;
  /** Context window we ask the server to use / budget against. */
  contextWindow: number;
  chat(req: ChatRequest): AsyncIterable<StreamEvent>;
  listModels(): Promise<string[]>;
  capabilities(): Promise<ProviderCapabilities>;
  /** Throws a human-readable error when the server is unreachable. */
  healthCheck(): Promise<void>;
  /** Human-readable info for /model. */
  describe(): Promise<string>;
}

/** Normalized result of one model response, regardless of how tool calls were transported. */
export interface AssistantTurn {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
  aborted?: boolean;
}

/** Raised by providers when the server rejects the `tools` parameter for this model. */
export class ToolsUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolsUnsupportedError';
  }
}

export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 500)}`);
    this.name = 'ProviderHttpError';
  }
}
