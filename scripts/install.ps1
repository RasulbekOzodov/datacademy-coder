# DataCademy Coder — Windows installer
# Usage (PowerShell):  irm https://raw.githubusercontent.com/RasulbekOzodov/datacademy-coder/main/scripts/install.ps1 | iex
# Options via env vars before running:
#   $env:DATACADEMY_MODEL = "qwen2.5-coder:3b"   # model to pull (default qwen2.5-coder:7b); "none" = skip
#   $env:DATACADEMY_SKIP_OLLAMA = "1"            # do not install Ollama (cloud-only usage)

$ErrorActionPreference = "Stop"
$Package = "datacademy-coder"
$Model = if ($env:DATACADEMY_MODEL) { $env:DATACADEMY_MODEL } else { "qwen2.5-coder:7b" }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}
function Has-Command($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Host ""
Write-Host "  DATACADEMY CODER installer" -ForegroundColor Magenta
Write-Host ""

# 1. Node.js >= 20
$needNode = $true
if (Has-Command node) {
  $v = (node --version) -replace "^v", ""
  if ([int]($v.Split(".")[0]) -ge 20) { $needNode = $false; Write-Step "Node.js $v topildi" }
  else { Write-Step "Node.js $v eski (20+ kerak) — yangilanadi" }
}
if ($needNode) {
  if (-not (Has-Command winget)) {
    Write-Host "winget topilmadi. Node.js 22 LTS ni https://nodejs.org dan o'rnating va skriptni qayta ishga tushiring." -ForegroundColor Red
    exit 1
  }
  Write-Step "Node.js LTS o'rnatilmoqda (winget)"
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements | Out-Null
  Refresh-Path
  if (-not (Has-Command node)) { Write-Host "Node.js o'rnatildi, lekin PATH yangilanmadi — yangi terminal oching va skriptni qayta ishga tushiring." -ForegroundColor Yellow; exit 1 }
}

# 2. The package
Write-Step "$Package o'rnatilmoqda (npm)"
$installed = $false
try { npm install -g $Package --no-fund --no-audit 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $installed = $true } } catch {}
if (-not $installed) {
  Write-Step "npm registry'da topilmadi — GitHub'dan o'rnatilmoqda"
  npm install -g "github:RasulbekOzodov/datacademy-coder" --no-fund --no-audit | Out-Null
}
Refresh-Path
if (-not (Has-Command datacademy_coder)) { Write-Host "npm global papkasi PATH da emas. 'npm config get prefix' papkasini PATH ga qo'shing." -ForegroundColor Yellow }

# 3. Ollama + model (skip for cloud-only)
if ($env:DATACADEMY_SKIP_OLLAMA -ne "1") {
  if (-not (Has-Command ollama)) {
    Write-Step "Ollama o'rnatilmoqda (winget)"
    winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements | Out-Null
    Refresh-Path
    Start-Sleep -Seconds 3
  } else { Write-Step "Ollama topildi" }
  if ($Model -ne "none" -and (Has-Command ollama)) {
    Write-Step "Model yuklanmoqda: $Model (bir necha daqiqa)"
    ollama pull $Model
    if ($Model -ne "qwen2.5-coder:7b") {
      $cfgDir = Join-Path $env:USERPROFILE ".datacademy_coder"
      $cfg = Join-Path $cfgDir "config.json"
      if (-not (Test-Path $cfg)) {
        New-Item -ItemType Directory -Force $cfgDir | Out-Null
        @{ defaultProvider = "ollama"; providers = @{ ollama = @{ type = "ollama"; model = $Model; contextWindow = 16384 } } } | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $cfg
      }
    }
  }
}

Write-Host ""
Write-Host "Tayyor!" -ForegroundColor Green
Write-Host "  cd loyiha-papkasi"
Write-Host "  datacademy_coder            # ishga tushirish"
Write-Host "  datacademy_coder --init     # config namunasi (DeepSeek/Qwen API ham shu yerda)"
Write-Host ""
