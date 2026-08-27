# DataCademy Coder - Windows installer
# Usage (PowerShell):  irm https://raw.githubusercontent.com/RasulbekOzodov/datacademy-coder/main/scripts/install.ps1 | iex
# Options via env vars before running:
#   $env:DATACADEMY_MODEL = "qwen2.5-coder:3b"   # local model to pull; default "none" (cloud account first)
#   $env:DATACADEMY_SKIP_OLLAMA = "1"            # do not install Ollama
#
# Everything lives in a function and uses `return` (never `exit`): with `irm | iex` the script runs
# inside the user's own shell, and `exit` would close their terminal.

function Install-DataCademyCoder {
  $ErrorActionPreference = "Continue"
  $Package = "datacademy-coder"
  $NodeVersion = "22.20.0"
  $Model = if ($env:DATACADEMY_MODEL) { $env:DATACADEMY_MODEL } else { "none" }

  function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
  function Write-Bad($msg) { Write-Host "  [X] $msg" -ForegroundColor Red }
  function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
  function Add-SessionPath($dir) {
    if ((Test-Path $dir) -and (($env:Path -split ';') -notcontains $dir)) { $env:Path = "$dir;$env:Path" }
  }
  function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user;$env:Path"
    Add-SessionPath "$env:ProgramFiles\nodejs"
    Add-SessionPath "$env:LOCALAPPDATA\Programs\nodejs"
    Add-SessionPath "$env:APPDATA\npm"
    Add-SessionPath "$env:LOCALAPPDATA\Programs\Ollama"
  }
  function Has-Command($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
  function Node-Ok {
    if (-not (Has-Command node)) { return $false }
    try { $v = (& node --version) -replace "^v", ""; return ([int]($v.Split(".")[0]) -ge 20) } catch { return $false }
  }

  Write-Host ""
  Write-Host "  DATACADEMY CODER installer" -ForegroundColor Magenta
  Write-Host ""
  Refresh-Path

  # ---------- 1. Node.js >= 20
  if (Node-Ok) {
    Write-Step "Node.js $(& node --version) topildi"
  } else {
    $installed = $false
    if (Has-Command winget) {
      Write-Step "Node.js LTS o'rnatilmoqda (winget) - UAC so'rovi chiqishi mumkin"
      $out = & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements 2>&1
      Refresh-Path
      if (Node-Ok) { $installed = $true } else { Write-Host ($out | Select-Object -Last 3 | Out-String).Trim() -ForegroundColor DarkGray }
    }
    if (-not $installed) {
      Write-Step "Node.js $NodeVersion nodejs.org'dan yuklab o'rnatilmoqda"
      $msi = Join-Path $env:TEMP "node-v$NodeVersion-x64.msi"
      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-x64.msi" -OutFile $msi -UseBasicParsing
        $p = Start-Process msiexec.exe -ArgumentList "/i", "`"$msi`"", "/qn", "/norestart" -Wait -PassThru
        Refresh-Path
        if (Node-Ok) { $installed = $true } else { Write-Bad "msiexec kodi: $($p.ExitCode)" }
      } catch { Write-Bad "yuklab bo'lmadi: $($_.Exception.Message)" }
    }
    if (-not $installed) {
      Write-Bad "Node.js o'rnatilmadi. https://nodejs.org/en/download dan LTS (22) ni o'rnating va skriptni qayta ishga tushiring."
      return
    }
    Write-Ok "Node.js $(& node --version)"
  }

  # ---------- 2. The package
  Write-Step "$Package o'rnatilmoqda (npm)"
  $spec = $Package
  $null = & npm view $Package version 2>$null
  if ($LASTEXITCODE -ne 0) {
    # Not on the npm registry yet -> install the GitHub tarball (not github: - npm on Windows mis-links global git installs)
    $spec = "https://github.com/RasulbekOzodov/datacademy-coder/archive/refs/heads/main.tar.gz"
  }
  $out = & npm install -g $spec --no-fund --no-audit 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Bad "npm install xato berdi:"
    Write-Host ($out | Select-Object -Last 8 | Out-String).Trim() -ForegroundColor DarkGray
    return
  }
  Refresh-Path
  if (Has-Command datacademy_coder) {
    Write-Ok "datacademy_coder $(& datacademy_coder --version)"
  } else {
    $prefix = (& npm config get prefix).Trim()
    Add-SessionPath $prefix
    if (Has-Command datacademy_coder) { Write-Ok "datacademy_coder $(& datacademy_coder --version)" }
    else { Write-Host "  npm global papkasi ($prefix) PATH da emas - yangi terminal oching yoki PATH ga qo'shing." -ForegroundColor Yellow }
  }

  # ---------- 3. Ollama + local model (optional)
  if ($env:DATACADEMY_SKIP_OLLAMA -ne "1" -and $Model -ne "none") {
    if (-not (Has-Command ollama)) {
      if (Has-Command winget) {
        Write-Step "Ollama o'rnatilmoqda (winget)"
        $null = & winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements 2>&1
        Refresh-Path
        Start-Sleep -Seconds 3
      } else { Write-Host "  winget yo'q - Ollama'ni https://ollama.com/download dan o'rnating." -ForegroundColor Yellow }
    } else { Write-Step "Ollama topildi" }
    if (Has-Command ollama) {
      Write-Step "Model yuklanmoqda: $Model (bir necha daqiqa)"
      & ollama pull $Model
    }
  }

  Write-Host ""
  Write-Host "Tayyor!" -ForegroundColor Green
  Write-Host "  datacademy_coder login      # DataCademy hisobiga ulash (brauzer ochiladi)"
  Write-Host "  cd loyiha-papkasi; datacademy_coder"
  Write-Host "  datacademy_coder --setup    # lokal model (Ollama) yoki o'z API kalitingiz"
  Write-Host ""
  Write-Host "  Buyruq topilmasa - yangi terminal oching (PATH yangilanadi)." -ForegroundColor DarkGray
  Write-Host ""
}

Install-DataCademyCoder
