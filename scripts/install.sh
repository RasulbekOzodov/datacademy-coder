#!/usr/bin/env bash
# DataCademy Coder — macOS / Linux installer
# Usage:  curl -fsSL https://raw.githubusercontent.com/RasulbekOzodov/datacademy-coder/main/scripts/install.sh | bash
# Options (env vars):
#   DATACADEMY_MODEL=qwen2.5-coder:3b   # model to pull (default qwen2.5-coder:7b); "none" = skip
#   DATACADEMY_SKIP_OLLAMA=1            # do not install Ollama (cloud-only usage)
set -euo pipefail

PACKAGE="datacademy-coder"
MODEL="${DATACADEMY_MODEL:-qwen2.5-coder:7b}"
step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

printf '\n\033[35m  DATACADEMY CODER installer\033[0m\n\n'

# 1. Node.js >= 20
need_node=1
if have node; then
  major=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [ "$major" -ge 20 ]; then need_node=0; step "Node.js $(node --version) topildi"; else step "Node.js $(node --version) eski (20+ kerak)"; fi
fi
if [ "$need_node" = 1 ]; then
  if [ "$(uname -s)" = "Darwin" ] && have brew; then
    step "Node.js o'rnatilmoqda (brew)"; brew install node@22 >/dev/null; brew link --overwrite node@22 >/dev/null 2>&1 || true
  elif have apt-get; then
    step "Node.js 22 o'rnatilmoqda (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
    sudo apt-get install -y nodejs >/dev/null
  else
    echo "Node.js 20+ topilmadi. https://nodejs.org dan o'rnating va skriptni qayta ishga tushiring." >&2; exit 1
  fi
fi

# 2. The package
step "$PACKAGE o'rnatilmoqda (npm)"
SPEC="$PACKAGE"
if ! npm view "$PACKAGE" version >/dev/null 2>&1; then
  step "npm registry'da topilmadi — GitHub'dan o'rnatiladi"
  SPEC="https://github.com/RasulbekOzodov/datacademy-coder/archive/refs/heads/main.tar.gz"
fi
if npm install -g "$SPEC" --no-fund --no-audit >/dev/null 2>&1; then :; else
  step "ruxsat kerak — sudo bilan qayta"; sudo npm install -g "$SPEC" --no-fund --no-audit >/dev/null
fi

# 3. Ollama + model
if [ "${DATACADEMY_SKIP_OLLAMA:-0}" != "1" ]; then
  if ! have ollama; then
    if [ "$(uname -s)" = "Darwin" ] && have brew; then step "Ollama o'rnatilmoqda (brew)"; brew install ollama >/dev/null; brew services start ollama >/dev/null 2>&1 || true
    else step "Ollama o'rnatilmoqda"; curl -fsSL https://ollama.com/install.sh | sh; fi
  else step "Ollama topildi"; fi
  if [ "$MODEL" != "none" ] && have ollama; then
    step "Model yuklanmoqda: $MODEL (bir necha daqiqa)"
    ollama pull "$MODEL"
    if [ "$MODEL" != "qwen2.5-coder:7b" ] && [ ! -f "$HOME/.datacademy_coder/config.json" ]; then
      mkdir -p "$HOME/.datacademy_coder"
      printf '{ "defaultProvider": "ollama", "providers": { "ollama": { "type": "ollama", "model": "%s", "contextWindow": 16384 } } }\n' "$MODEL" > "$HOME/.datacademy_coder/config.json"
    fi
  fi
fi

printf '\n\033[32mTayyor!\033[0m\n'
echo "  cd loyiha-papkasi"
echo "  datacademy_coder            # ishga tushirish"
echo "  datacademy_coder --init     # config namunasi (DeepSeek/Qwen API ham shu yerda)"
echo
