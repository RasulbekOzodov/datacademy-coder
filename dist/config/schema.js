import { z } from 'zod';
export const OllamaProviderSchema = z.object({
    type: z.literal('ollama'),
    baseUrl: z.string().default('http://localhost:11434'),
    model: z.string().default('qwen2.5-coder:7b'),
    contextWindow: z.number().int().positive().default(16384),
    keepAlive: z.union([z.string(), z.number()]).default('30m'),
    temperature: z.number().min(0).max(2).default(0.1),
    maxTokens: z.number().int().positive().default(2048),
});
export const OpenAIProviderSchema = z.object({
    type: z.literal('openai'),
    baseUrl: z.string().default('http://localhost:1234/v1'),
    apiKey: z.string().optional(),
    model: z.string().default('local-model'),
    contextWindow: z.number().int().positive().default(16384),
    /** Whether the server supports native tool_calls. Default: assume yes (parser fallback always active). */
    nativeTools: z.boolean().optional(),
    temperature: z.number().min(0).max(2).default(0.1),
    maxTokens: z.number().int().positive().default(2048),
});
export const ProviderSchema = z.discriminatedUnion('type', [OllamaProviderSchema, OpenAIProviderSchema]);
export const ToolModeSchema = z.enum(['native', 'text', 'auto']);
export const ConfigSchema = z.object({
    defaultProvider: z.string().default('ollama'),
    providers: z.record(ProviderSchema).default({
        ollama: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5-coder:7b', contextWindow: 16384, keepAlive: '30m', temperature: 0.1, maxTokens: 2048 },
    }),
    toolMode: ToolModeSchema.default('auto'),
    permissions: z
        .object({
        mode: z.enum(['ask', 'yolo']).default('ask'),
        /** Entries: tool name ("write_file", "shell") or shell prefix ("shell:npm test"). */
        allow: z.array(z.string()).default([]),
    })
        .default({}),
    maxIterations: z.number().int().positive().default(40),
    shell: z.enum(['auto', 'powershell', 'pwsh', 'cmd', 'bash']).default('auto'),
    shellTimeoutMs: z.number().int().positive().default(120_000),
    maxToolResultChars: z.number().int().positive().default(30_000),
    debug: z.boolean().default(false),
});
//# sourceMappingURL=schema.js.map