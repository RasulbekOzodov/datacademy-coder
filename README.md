# DataCademy Coder

Terminalda ishlaydigan coding-agent (Claude Code / Codex uslubida). Papkaga kirib `datacademy_coder` deb ishga tushirasiz — agent fayllarni o'qiydi, yozadi, tahrirlaydi, shell buyruqlar bajaradi. Farqi: **bulut API o'rniga lokal ishlayotgan LLM** (Ollama, LM Studio, llama.cpp server, vLLM, LocalAI …) ulanadi.

## O'rnatish

Bir qatorli o'rnatish (Node.js, paket, Ollama va modelni o'zi o'rnatadi):

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/RasulbekOzodov/datacademy-coder/main/scripts/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/RasulbekOzodov/datacademy-coder/main/scripts/install.sh | bash
```
Variantlar: `DATACADEMY_MODEL=qwen2.5-coder:3b` (kichik model), `DATACADEMY_SKIP_OLLAMA=1` (faqat bulut API).

Yoki Node.js 20+ bo'lsa to'g'ridan-to'g'ri npm'dan (yoki, paket npm'ga chiqmagan bo'lsa, GitHub tarball'dan):

```powershell
npm install -g datacademy-coder
npm install -g https://github.com/RasulbekOzodov/datacademy-coder/archive/refs/heads/main.tar.gz
```

Manbadan (dasturchilar uchun):

```powershell
npm install
npm run build
npm link          # "datacademy_coder" buyrug'ini global qiladi
```

Ishga tushirishdan oldin lokal model kerak. Ollama bilan:

```powershell
ollama pull qwen2.5-coder:7b     # CPU da sekinroq, sifatliroq
ollama pull qwen2.5-coder:3b     # tezroq — minimal tavsiya etiladigan hajm
ollama serve                     # odatda avtomatik ishlaydi
```

> 0.5b/1.5b modellar tool-calling uchun juda zaif (bir xil chaqiruvni takrorlaydi, cwd'ni noto'g'ri nusxalaydi) — ular faqat ulanishni tekshirish uchun. Ish uchun kamida 3b, iloji bo'lsa 7b (`qwen2.5-coder`, `qwen3`, `devstral`, `codellama` kabi tool-qo'llaydigan modellar).

## Birinchi ishga tushirish

Config bo'lmasa `datacademy_coder` avtomatik **sozlash ustasini** ochadi (keyin istalgan vaqt `datacademy_coder --setup`):

```
DataCademy Coder — birinchi sozlash
  1. DataCademy hisobi (coder.datacademy.uz) — eng oson: brauzerda kirasiz, API kalit shart emas
  2. Lokal model (Ollama) — bepul, oflayn
  3. O'z API kalitingiz (DeepSeek / Qwen / OpenAI / boshqa)
Tanlang [1-3, Enter = 1]:
```

- **DataCademy hisobi** (`datacademy_coder login`): terminalda kod va havola chiqadi, brauzerda kirib tasdiqlaysiz — kalit avtomatik config'ga tushadi. Modellar: `datacademy-pro` (DeepSeek V4 Pro) va `datacademy-fast` (Qwen3-Coder-Next). Balans: `/usage`. Tariflar va kabinet: https://coder.datacademy.uz. Gateway (server tomoni) — alohida repo: `datacademy-gateway`.
- **Lokal**: Ollama'dagi modellar ro'yxatidan tanlaysiz (yoki nom kiritasiz); Ollama ishlamayotgan bo'lsa o'rnatish havolasi ko'rsatiladi.
- **O'z kalitingiz**: provider (DeepSeek / Qwen via OpenRouter / OpenAI / boshqa OpenAI-uyg'un manzil) → model → API kalit. Kalit darhol tekshiriladi va `~/.datacademy_coder/config.json` ga yoziladi; bo'sh qoldirsangiz muhit o'zgaruvchisidan (`DEEPSEEK_API_KEY` kabi) olinadi. Lokal Ollama ham zaxira sifatida config'ga qo'shiladi (`--provider ollama`).

## Ishlatish

```powershell
cd loyiha-papkasi
datacademy_coder                  # interaktiv REPL
datacademy_coder --setup          # sozlash ustasi (lokal ↔ API)
datacademy_coder -p "package.json dagi skriptlarni sanab ber"   # bitta so'rov, chiqish
datacademy_coder --model qwen2.5-coder:3b
datacademy_coder --provider lmstudio
datacademy_coder --yolo           # ruxsat so'ramasdan ishlaydi
datacademy_coder --debug          # xom so'rov/javoblar .datacademy_coder/logs/ ga yoziladi
datacademy_coder --init           # namuna config yaratadi
```

REPL ichida: `/help /model /models /provider /status /compact /clear /undo /yolo /resume /sessions /save /load /exit`.
Ctrl+C — joriy javobni to'xtatadi; ikki marta — chiqish.

**Suhbatlar** har javobdan keyin avtomatik `.datacademy_coder/sessions/` ga saqlanadi:
- `datacademy_coder --continue` (`-c`) — shu papkadagi oxirgi suhbatni davom ettirish
- `datacademy_coder --resume` (`-r`) — ro'yxatdan tanlash; `--resume <id>` — aniq suhbat
- REPL ichida `/resume` — xuddi shu ro'yxat

**Context (xotira):** `contextWindow` (default 16 384 token; Ollama'ga `num_ctx`). Har javobdan keyin `ctx ~N/W tokens (P%)` ko'rsatiladi; 50% dan oshganda eski tool natijalari qisqartiriladi, 70% da eng eski turnlar tashlanadi; `/compact` qo'lda. Kattaroq xotira: `"contextWindow": 32768` (RAM ~+1 GB, prompt sekinroq).

## Config

`~/.datacademy_coder/config.json` (global) ← `./.datacademy_coder/config.json` (loyiha) ← env (`CODER_PROVIDER`, `CODER_MODEL`, `CODER_TOOL_MODE`) ← CLI flaglar.

```json
{
  "defaultProvider": "ollama",
  "providers": {
    "ollama":   { "type": "ollama", "baseUrl": "http://localhost:11434", "model": "qwen2.5-coder:7b", "contextWindow": 16384, "keepAlive": "30m" },
    "lmstudio": { "type": "openai", "baseUrl": "http://localhost:1234/v1", "model": "local-model", "apiKey": "lm-studio", "contextWindow": 16384 },
    "llamacpp": { "type": "openai", "baseUrl": "http://localhost:8080/v1", "model": "default", "contextWindow": 16384 }
  },
  "toolMode": "auto",
  "permissions": { "mode": "ask", "allow": ["shell:npm test", "shell:git status"] },
  "maxIterations": 40,
  "shell": "auto",
  "shellTimeoutMs": 120000,
  "maxToolResultChars": 30000
}
```

- `type: "openai"` — istalgan OpenAI-uyg'un manzil (LM Studio, llama.cpp `llama-server`, vLLM, LocalAI, hatto bulut API).
- `apiKey` muhit o'zgaruvchisiga ishora qilishi mumkin: `"${DEEPSEEK_API_KEY}"` yoki `"env:DEEPSEEK_API_KEY"` — kalit config faylga yozilmaydi.

### Bulut providerlar (ixtiyoriy, qiyin vazifalar uchun)

```json
"deepseek": { "type": "openai", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-v4-pro", "apiKey": "${DEEPSEEK_API_KEY}", "contextWindow": 131072, "maxTokens": 8192 },
"qwen":     { "type": "openai", "baseUrl": "https://openrouter.ai/api/v1", "model": "qwen/qwen3-coder-next", "apiKey": "${OPENROUTER_API_KEY}", "contextWindow": 131072, "maxTokens": 8192 }
```

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."          # faqat shu terminal uchun
setx DEEPSEEK_API_KEY "sk-..."            # doimiy (yangi terminalda kuchga kiradi)
datacademy_coder --provider deepseek      # yoki REPL ichida: /provider deepseek
```
- `contextWindow` — Ollama uchun `num_ctx` sifatida yuboriladi. **Muhim:** Ollama default 4096 bo'lib, sig'magan promptni jimgina kesadi; 16384 tavsiya etiladi.
- `toolMode`: `auto` (model native tool qo'llasa native, bo'lmasa text), `native`, `text`.
- `permissions.allow`: `"write_file"`, `"shell"` yoki `"shell:<prefix>"`.

## Tool'lar

| Tool | Ruxsat | Vazifa |
|---|---|---|
| `read_file` | avto | Fayl o'qish (offset/limit, 400 qator cap) |
| `list_dir` | avto | Papka ro'yxati (.gitignore hisobga olinadi) |
| `glob` | avto | Pattern bo'yicha fayl qidirish |
| `grep` | avto | Regex bo'yicha kontent qidirish (`rg` bo'lsa undan foydalanadi) |
| `write_file` | so'raydi | Yangi fayl / to'liq qayta yozish |
| `edit_file` | so'raydi | Aniq matnni almashtirish (old → new), diff preview |
| `shell` | so'raydi | PowerShell/bash buyruq, timeout, exit code |

Xavfli buyruqlar (`rm -rf`, `git push --force`, `Remove-Item -Recurse` …) `--yolo` da ham tasdiq so'raydi. Yozish faqat ish papkasi ichida.

Shell tanlovi (`shell` config): `auto` — Windows'da `pwsh` → `powershell` → (8 soniyada ishga tushmasa) `cmd`; boshqa OS'da `bash`. Qat'iy belgilash: `"shell": "powershell" | "pwsh" | "cmd" | "bash"`.

## Loyiha ko'rsatmalari

Loyiha ildizidagi `AGENT.md` (yoki `AGENTS.md`, `CLAUDE.md`) system promptga qo'shiladi — kod uslubi, test buyruqlari, qoidalar shu yerda.

## Kichik modellar bilan ishlash haqida

- Agent har xabarda **bitta** tool chaqiruvi bajaradi; text rejimda `</tool_call>` stop-sequence sifatida yuboriladi, shunda model tool natijasini o'zi to'qib yubormaydi.
- Parser `<tool_call>` bloklarini, ```json fence'larni va "yalang'och" JSON obyektlarni tushunadi; buzilgan JSON `jsonrepair` bilan tuzatiladi.
- `edit_file` — aniq moslik → CRLF → trailing whitespace → indent-ga chidamli moslik; topilmasa eng yaqin joyni ko'rsatadi, model o'zini tuzatadi. Fayl o'qilmasdan tahrirlab bo'lmaydi.
- Context 50% dan oshsa eski tool natijalari qisqartiriladi, 70% da eski turnlar tashlanadi. `/compact` bilan qo'lda.
- Muammo bo'lsa `--debug` bilan ishga tushiring va `.datacademy_coder/logs/*.jsonl` ni ko'ring.

## Dasturlash

```powershell
npm run dev        # tsx orqali ishga tushirish (build'siz)
npm test           # parser, edit-file, OpenAI delta assembler testlari
npm run typecheck
```

Struktura: `src/llm` (providerlar, parser), `src/tools`, `src/agent` (loop, prompt, context), `src/permissions`, `src/ui` (REPL), `src/config`.
