import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { globalConfigDir } from '../config/load.js';
import type { ProviderConfig } from '../config/schema.js';
import { APP_DISPLAY_NAME, APP_NAME } from '../constants.js';
import { createProvider } from '../llm/registry.js';
import { fetchJson } from '../llm/stream-readers.js';
import type { LineReader } from './repl.js';
import { out } from './render.js';

interface CloudPreset {
  key: string;
  label: string;
  baseUrl: string;
  model: string;
  keyHint: string;
  contextWindow: number;
}

const CLOUD_PRESETS: CloudPreset[] = [
  { key: 'deepseek', label: 'DeepSeek V4 Pro — arzon va kuchli (api.deepseek.com)', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', keyHint: 'platform.deepseek.com → API keys', contextWindow: 131072 },
  { key: 'qwen', label: 'Qwen3-Coder-Next — eng arzon (OpenRouter orqali)', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder-next', keyHint: 'openrouter.ai/keys', contextWindow: 131072 },
  { key: 'openai', label: 'OpenAI GPT-5.6 Luna (api.openai.com)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna', keyHint: 'platform.openai.com/api-keys', contextWindow: 131072 },
  { key: 'custom', label: "Boshqa OpenAI-uyg'un server (manzil + model o'zingiz kiritasiz)", baseUrl: '', model: '', keyHint: '', contextWindow: 131072 },
];

const DEFAULT_LOCAL_MODEL = 'qwen2.5-coder:7b';

export function hasAnyConfig(cwd: string): boolean {
  return fs.existsSync(path.join(globalConfigDir(), 'config.json')) || fs.existsSync(path.join(cwd, '.datacademy_coder', 'config.json'));
}

async function pick(reader: LineReader, prompt: string, max: number, def = 1): Promise<number | null> {
  for (;;) {
    const a = await reader.ask(pc.yellow(`${prompt} [1-${max}, Enter = ${def}]: `));
    if (a === null) return null;
    const t = a.trim();
    if (!t) return def;
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= max) return n;
    out(pc.dim(`  1 dan ${max} gacha raqam kiriting\n`));
  }
}

async function askText(reader: LineReader, prompt: string, def?: string): Promise<string | null> {
  const a = await reader.ask(pc.yellow(`${prompt}${def ? ` [${def}]` : ''}: `));
  if (a === null) return null;
  return a.trim() || def || '';
}

function writeGlobalConfig(defaultProvider: string, providers: Record<string, ProviderConfig>): string {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* overwrite unreadable config */
  }
  const merged = {
    ...existing,
    defaultProvider,
    providers: { ...((existing.providers as Record<string, unknown>) ?? {}), ...providers },
    toolMode: existing.toolMode ?? 'auto',
    permissions: existing.permissions ?? { mode: 'ask', allow: [] },
  };
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * First-run wizard. Returns true when a config was written.
 */
export async function runSetupWizard(reader: LineReader): Promise<boolean> {
  out(`\n${pc.bold(pc.magenta(`${APP_DISPLAY_NAME} — birinchi sozlash`))}\n`);
  out(pc.dim("Model qayerda ishlaydi? (keyin istalgan vaqt: datacademy_coder --setup yoki config faylni tahrirlash)\n\n"));
  out(`  ${pc.cyan('1')}. Lokal model (Ollama) — bepul, oflayn; 7b uchun ~6 GB RAM, GPU bo'lsa tez\n`);
  out(`  ${pc.cyan('2')}. Bulut API (DeepSeek / Qwen / OpenAI / boshqa) — tez va kuchli, API kalit kerak\n\n`);
  const mode = await pick(reader, 'Tanlang', 2, 1);
  if (mode === null) return false;

  if (mode === 1) {
    const baseUrl = 'http://localhost:11434';
    let models: string[] = [];
    let reachable = false;
    try {
      const tags = await fetchJson<{ models?: Array<{ name: string }> }>(`${baseUrl}/api/tags`, { timeoutMs: 4000 });
      reachable = true;
      models = (tags.models ?? []).map((m) => m.name);
    } catch {
      /* not running */
    }
    if (!reachable) {
      out(pc.yellow("\nOllama ishlamayapti yoki o'rnatilmagan. O'rnatish: https://ollama.com/download (Windows: winget install Ollama.Ollama)\n"));
    }
    let model = DEFAULT_LOCAL_MODEL;
    if (models.length) {
      out('\nOllama\'dagi modellar:\n');
      models.forEach((m, i) => out(`  ${pc.cyan(String(i + 1))}. ${m}\n`));
      out(`  ${pc.cyan(String(models.length + 1))}. boshqa (nomini kiritasiz, keyin ollama pull qilinadi)\n\n`);
      const n = await pick(reader, 'Model', models.length + 1, 1);
      if (n === null) return false;
      model = n <= models.length ? models[n - 1] : ((await askText(reader, 'Model nomi', DEFAULT_LOCAL_MODEL)) ?? DEFAULT_LOCAL_MODEL);
    } else {
      const m = await askText(reader, 'Model nomi', DEFAULT_LOCAL_MODEL);
      if (m === null) return false;
      model = m;
    }
    const file = writeGlobalConfig('ollama', {
      ollama: { type: 'ollama', baseUrl, model, contextWindow: 16384, keepAlive: '30m', temperature: 0.1, maxTokens: 2048 },
    });
    out(`\n${pc.green('✓')} config yozildi: ${file}\n`);
    if (!models.includes(model)) out(pc.dim(`  modelni yuklang: ollama pull ${model}\n`));
    return true;
  }

  // Cloud API
  out('\nProvider:\n');
  CLOUD_PRESETS.forEach((p, i) => out(`  ${pc.cyan(String(i + 1))}. ${p.label}\n`));
  out('\n');
  const n = await pick(reader, 'Tanlang', CLOUD_PRESETS.length, 1);
  if (n === null) return false;
  const preset = CLOUD_PRESETS[n - 1];
  let baseUrl = preset.baseUrl;
  let model = preset.model;
  let name = preset.key;
  if (preset.key === 'custom') {
    const b = await askText(reader, 'Base URL (masalan https://api.example.com/v1)');
    if (!b) return false;
    baseUrl = b.replace(/\/+$/, '');
    const m = await askText(reader, 'Model nomi');
    if (!m) return false;
    model = m;
    name = (await askText(reader, 'Provider nomi (config uchun)', 'custom')) ?? 'custom';
  } else {
    const m = await askText(reader, 'Model', preset.model);
    if (m === null) return false;
    model = m;
  }

  let apiKey: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    out(pc.dim(`\nAPI kalit${preset.keyHint ? ` (${preset.keyHint})` : ''}. Kalit ${path.join(globalConfigDir(), 'config.json')} ga saqlanadi.\n`));
    const k = await askText(reader, 'API kalit');
    if (k === null) return false;
    if (!k) {
      out(pc.dim("  bo'sh — kalit muhit o'zgaruvchisidan olinadi (config'da ${" + name.toUpperCase() + '_API_KEY})\n'));
      apiKey = `\${${name.toUpperCase()}_API_KEY}`;
      break;
    }
    out(pc.dim('  tekshirilmoqda...\n'));
    const probe = createProvider(name, { type: 'openai', baseUrl, apiKey: k, model, contextWindow: preset.contextWindow, temperature: 0.1, maxTokens: 8192 });
    try {
      await probe.healthCheck();
      apiKey = k;
      out(`${pc.green('✓')} ulandi\n`);
      break;
    } catch (err) {
      out(pc.red(`  ✗ ${(err as Error).message.split('\n')[0].slice(0, 160)}\n`));
      if (attempt === 3) return false;
      out(pc.dim('  qayta urinib ko\'ring (Enter = muhit o\'zgaruvchisidan olish)\n'));
    }
  }

  const file = writeGlobalConfig(name, {
    [name]: { type: 'openai', baseUrl, apiKey, model, contextWindow: preset.contextWindow, temperature: 0.1, maxTokens: 8192 },
    ollama: { type: 'ollama', baseUrl: 'http://localhost:11434', model: DEFAULT_LOCAL_MODEL, contextWindow: 16384, keepAlive: '30m', temperature: 0.1, maxTokens: 2048 },
  });
  out(`\n${pc.green('✓')} config yozildi: ${file}\n`);
  out(pc.dim(`  default provider: ${name} (${model}); lokal Ollama ham qo'shildi: ${APP_NAME} --provider ollama\n`));
  return true;
}
