import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { globalConfigDir } from '../config/load.js';
import { APP_DISPLAY_NAME, APP_NAME } from '../constants.js';
import { fetchJson } from '../llm/stream-readers.js';
import { gatewayUrl, runLogin } from './login.js';
import { out } from './render.js';
const OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_LOCAL_MODEL = 'qwen2.5-coder:7b';
const LOCAL_MODEL_CHOICES = [
    { id: 'qwen2.5-coder:7b', note: '4.7 GB — sifatli, ~6 GB RAM (GPU bo\'lsa tez)' },
    { id: 'qwen2.5-coder:3b', note: '1.9 GB — tezroq, kuchsiz kompyuterlar uchun' },
    { id: 'qwen2.5-coder:14b', note: '9 GB — eng sifatli, 16 GB+ RAM / GPU' },
];
export function hasAnyConfig(cwd) {
    return fs.existsSync(path.join(globalConfigDir(), 'config.json')) || fs.existsSync(path.join(cwd, '.datacademy_coder', 'config.json'));
}
async function pick(reader, prompt, max, def = 1) {
    for (;;) {
        const a = await reader.ask(pc.yellow(`${prompt} [1-${max}, Enter = ${def}]: `));
        if (a === null)
            return null;
        const t = a.trim();
        if (!t)
            return def;
        const n = Number(t);
        if (Number.isInteger(n) && n >= 1 && n <= max)
            return n;
        out(pc.dim(`  1 dan ${max} gacha raqam kiriting\n`));
    }
}
async function yesNo(reader, prompt, def = true) {
    const a = await reader.ask(pc.yellow(`${prompt} [${def ? 'Y/n' : 'y/N'}]: `));
    if (a === null)
        return null;
    const t = a.trim().toLowerCase();
    if (!t)
        return def;
    return t === 'y' || t === 'yes' || t === 'ha';
}
export function writeGlobalConfig(defaultProvider, providers) {
    const dir = globalConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.json');
    let existing = {};
    try {
        if (fs.existsSync(file))
            existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        /* overwrite unreadable config */
    }
    const merged = {
        ...existing,
        defaultProvider,
        providers: { ...(existing.providers ?? {}), ...providers },
        toolMode: existing.toolMode ?? 'auto',
        permissions: existing.permissions ?? { mode: 'ask', allow: [] },
    };
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return file;
}
// ---------------------------------------------------------------- Ollama helpers
async function ollamaModels() {
    try {
        const tags = await fetchJson(`${OLLAMA_URL}/api/tags`, { timeoutMs: 3000 });
        return (tags.models ?? []).map((m) => m.name);
    }
    catch {
        return undefined;
    }
}
function ollamaInstalled() {
    try {
        const r = spawnSync(process.platform === 'win32' ? 'ollama.exe' : 'ollama', ['--version'], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
        if (r.status === 0)
            return true;
    }
    catch {
        /* not on PATH */
    }
    if (process.platform === 'win32') {
        const local = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe');
        if (fs.existsSync(local)) {
            process.env.PATH = `${path.dirname(local)}${path.delimiter}${process.env.PATH ?? ''}`;
            return true;
        }
    }
    return false;
}
function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: 'inherit', windowsHide: true, shell: opts.shell ?? false });
        p.on('error', () => resolve(127));
        p.on('close', (code) => resolve(code ?? 1));
    });
}
async function waitForOllama(seconds) {
    for (let i = 0; i < seconds; i++) {
        if (await ollamaModels())
            return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}
/** Make sure the Ollama server answers; offers to install it and starts it when needed. */
async function ensureOllama(reader) {
    if (await ollamaModels())
        return true;
    if (!ollamaInstalled()) {
        out(pc.yellow("\nOllama o'rnatilmagan.\n"));
        const yes = await yesNo(reader, "Ollama'ni hozir o'rnataymi?", true);
        if (!yes) {
            out(pc.dim("  Qo'lda: https://ollama.com/download , keyin: datacademy_coder --setup\n"));
            return false;
        }
        out(pc.dim("  o'rnatilmoqda (bir necha daqiqa; UAC so'rovi chiqishi mumkin)...\n"));
        let code = 1;
        if (process.platform === 'win32')
            code = await run('winget', ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements']);
        else if (process.platform === 'darwin')
            code = await run('brew', ['install', 'ollama']);
        else
            code = await run('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh']);
        if (code !== 0 || !ollamaInstalled()) {
            out(pc.red("  o'rnatib bo'lmadi. Qo'lda: https://ollama.com/download , keyin: datacademy_coder --setup\n"));
            return false;
        }
        out(`${pc.green('✓')} Ollama o'rnatildi\n`);
    }
    // Installed but not answering: start the server in the background.
    out(pc.dim('  Ollama serveri ishga tushirilmoqda...\n'));
    try {
        const p = spawn(process.platform === 'win32' ? 'ollama.exe' : 'ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
        p.unref();
    }
    catch {
        /* maybe the desktop app starts it */
    }
    if (await waitForOllama(30))
        return true;
    out(pc.red(`  Ollama ${OLLAMA_URL} da javob bermayapti. Boshqa terminalda \`ollama serve\` ni ishga tushiring, keyin: ${APP_NAME} --setup\n`));
    return false;
}
/** Download the model if it is missing (shows Ollama's own progress bar). */
async function ensureModel(reader, model) {
    const models = (await ollamaModels()) ?? [];
    if (models.some((m) => m === model || m.startsWith(`${model}:`)))
        return true;
    const yes = await yesNo(reader, `Model ${model} yo'q. Hozir yuklaymi?`, true);
    if (!yes) {
        out(pc.dim(`  keyin: ollama pull ${model}\n`));
        return false;
    }
    const code = await run(process.platform === 'win32' ? 'ollama.exe' : 'ollama', ['pull', model]);
    if (code !== 0) {
        out(pc.red(`  yuklab bo'lmadi (kod ${code}). Qayta: ollama pull ${model}\n`));
        return false;
    }
    return true;
}
// ---------------------------------------------------------------- wizard
/**
 * First-run wizard: DataCademy account (cloud) or local Ollama. Returns true when the agent is ready to run.
 * (Own API keys are still supported through the config file — see README.)
 */
export async function runSetupWizard(reader) {
    out(`\n${pc.bold(pc.magenta(`${APP_DISPLAY_NAME} — birinchi sozlash`))}\n`);
    out(pc.dim(`Model qayerda ishlaydi? (keyin istalgan vaqt: ${APP_NAME} --setup)\n\n`));
    out(`  ${pc.cyan('1')}. DataCademy hisobi (${gatewayUrl().replace(/^https?:\/\//, '')}) — eng oson: brauzerda kirasiz, kuchli modellar, API kalit shart emas\n`);
    out(`  ${pc.cyan('2')}. Lokal model (Ollama) — bepul, oflayn; kompyuter resursiga bog'liq (7b uchun ~6 GB RAM)\n\n`);
    const mode = await pick(reader, 'Tanlang', 2, 1);
    if (mode === null)
        return false;
    if (mode === 1)
        return runLogin();
    // ---- local
    if (!(await ensureOllama(reader)))
        return false;
    const installed = (await ollamaModels()) ?? [];
    let model = DEFAULT_LOCAL_MODEL;
    if (installed.length) {
        out("\nOllama'dagi modellar:\n");
        installed.forEach((m, i) => out(`  ${pc.cyan(String(i + 1))}. ${m}\n`));
        out(`  ${pc.cyan(String(installed.length + 1))}. boshqa (ro'yxatdan tanlab yuklash)\n\n`);
        const n = await pick(reader, 'Model', installed.length + 1, 1);
        if (n === null)
            return false;
        if (n <= installed.length)
            model = installed[n - 1];
        else {
            const c = await chooseModelToPull(reader);
            if (!c)
                return false;
            model = c;
        }
    }
    else {
        const c = await chooseModelToPull(reader);
        if (!c)
            return false;
        model = c;
    }
    if (!(await ensureModel(reader, model)))
        return false;
    const file = writeGlobalConfig('ollama', {
        ollama: { type: 'ollama', baseUrl: OLLAMA_URL, model, contextWindow: 16384, keepAlive: '30m', temperature: 0.1, maxTokens: 2048 },
    });
    out(`\n${pc.green('✓')} tayyor — lokal model ${pc.bold(model)} ${pc.dim(`(config: ${file})`)}\n`);
    return true;
}
async function chooseModelToPull(reader) {
    out('\nQaysi modelni yuklaymiz?\n');
    LOCAL_MODEL_CHOICES.forEach((m, i) => out(`  ${pc.cyan(String(i + 1))}. ${m.id}  ${pc.dim(m.note)}\n`));
    out(`  ${pc.cyan(String(LOCAL_MODEL_CHOICES.length + 1))}. boshqa nom kiritaman\n\n`);
    const n = await pick(reader, 'Model', LOCAL_MODEL_CHOICES.length + 1, 1);
    if (n === null)
        return null;
    if (n <= LOCAL_MODEL_CHOICES.length)
        return LOCAL_MODEL_CHOICES[n - 1].id;
    const a = await reader.ask(pc.yellow(`Model nomi [${DEFAULT_LOCAL_MODEL}]: `));
    if (a === null)
        return null;
    return a.trim() || DEFAULT_LOCAL_MODEL;
}
//# sourceMappingURL=setup.js.map