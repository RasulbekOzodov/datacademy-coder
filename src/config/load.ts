import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema, type Config, type ConfigInput } from './schema.js';
import { CONFIG_DIR } from '../constants.js';

export interface CliOverrides {
  provider?: string;
  model?: string;
  yolo?: boolean;
  debug?: boolean;
  toolMode?: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Config faylni o'qib bo'lmadi: ${file}: ${(err as Error).message}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merged recursively, arrays/primitives replaced. */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    else out[k] = v;
  }
  return out;
}

export function globalConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR);
}

export function projectConfigDir(cwd: string): string {
  return path.join(cwd, CONFIG_DIR);
}

export interface LoadedConfig {
  config: Config;
  sources: string[];
}

/**
 * Precedence (low -> high): built-in defaults <- ~/.datacademy_coder/config.json <- ./.datacademy_coder/config.json <- env <- CLI flags
 */
export function loadConfig(cwd: string, cli: CliOverrides = {}): LoadedConfig {
  const sources: string[] = [];
  let merged: Record<string, unknown> = {};

  for (const file of [path.join(globalConfigDir(), 'config.json'), path.join(projectConfigDir(cwd), 'config.json')]) {
    const json = readJson(file);
    if (json) {
      merged = deepMerge(merged, json);
      sources.push(file);
    }
  }

  const env = process.env;
  if (env.CODER_PROVIDER) merged.defaultProvider = env.CODER_PROVIDER;
  if (env.CODER_TOOL_MODE) merged.toolMode = env.CODER_TOOL_MODE;

  if (cli.provider) merged.defaultProvider = cli.provider;
  if (cli.toolMode) merged.toolMode = cli.toolMode;
  if (cli.debug) merged.debug = true;
  if (cli.yolo) {
    merged.permissions = { ...(isObject(merged.permissions) ? merged.permissions : {}), mode: 'yolo' };
  }

  const parsed = ConfigSchema.safeParse(merged as ConfigInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Config noto'g'ri:\n${issues}`);
  }
  const config = parsed.data;

  // apiKey may reference an environment variable: "${DEEPSEEK_API_KEY}" or "env:DEEPSEEK_API_KEY".
  for (const [name, p] of Object.entries(config.providers)) {
    if (p.type !== 'openai' || !p.apiKey) continue;
    const m = p.apiKey.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) ?? p.apiKey.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
    if (m) {
      const value = env[m[1]];
      if (!value && name === (cli.provider ?? config.defaultProvider)) {
        throw new Error(`Provider "${name}" uchun API kalit topilmadi: ${m[1]} muhit o'zgaruvchisini o'rnating (masalan PowerShell: $env:${m[1]}="sk-...").`);
      }
      p.apiKey = value;
    }
  }

  const modelOverride = cli.model ?? env.CODER_MODEL;
  const selected = config.providers[config.defaultProvider];
  if (!selected) {
    const names = Object.keys(config.providers).join(', ') || '(none)';
    throw new Error(`Provider "${config.defaultProvider}" topilmadi. Mavjud: ${names}`);
  }
  if (modelOverride) selected.model = modelOverride;

  return { config, sources };
}

export function exampleConfig(): string {
  return JSON.stringify(
    {
      defaultProvider: 'ollama',
      providers: {
        ollama: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5-coder:7b', contextWindow: 16384, keepAlive: '30m' },
        lmstudio: { type: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'local-model', apiKey: 'lm-studio', contextWindow: 16384 },
        llamacpp: { type: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'default', contextWindow: 16384 },
        deepseek: { type: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', apiKey: '${DEEPSEEK_API_KEY}', contextWindow: 131072, maxTokens: 8192 },
        qwen: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder-next', apiKey: '${OPENROUTER_API_KEY}', contextWindow: 131072, maxTokens: 8192 },
      },
      toolMode: 'auto',
      permissions: { mode: 'ask', allow: [] },
      maxIterations: 40,
      shell: 'auto',
      shellTimeoutMs: 120000,
      maxToolResultChars: 30000,
    },
    null,
    2,
  );
}
