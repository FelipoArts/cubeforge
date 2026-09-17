# Automatiza os passos 1-5 do SETUP.md numa máquina nova: checa/instala
# pré-requisitos, clona o repo, instala dependências, copia os segredos
# locais (se fornecidos) e compila o sidecar.
#
# Pensado pra rodar ANTES de o repo existir na máquina nova — por isso não
# fica só em scripts/, baixe/copie este arquivo isolado pra máquina nova
# (junto com os segredos, se for por pendrive) e rode a partir dali:
#
#   .\setup-new-machine.ps1 -SecretsSource D:\cubeforge-secrets
#
# Parâmetros:
#   -RepoUrl        URL do repo (default: github.com/FelipoArts/cubeforge)
#   -TargetDir      Pasta destino do clone (default: .\cubeforge)
#   -SecretsSource  Pasta contendo network_session.json e .dev.vars
#                    (ex: uma pasta copiada da máquina antiga via pendrive)
#   -InstallPrereqs Tenta instalar via winget o que estiver faltando
#                    (Git, Node, Rust, Go). Sem essa flag, o script só avisa.

param(
    [string]$RepoUrl = "https://github.com/FelipoArts/cubeforge.git",
    [string]$TargetDir = ".\cubeforge",
    [string]$SecretsSource = "",
    [switch]$InstallPrereqs
)

$ErrorActionPreference = "Stop"

function Test-Cmd($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Install-Winget($id, $label) {
    if (-not (Test-Cmd "winget")) {
        Write-Warning "$label não encontrado e winget não está disponível. Instale manualmente."
        return
    }
    Write-Host "Instalando $label via winget..."
    winget install --id $id --silent --accept-package-agreements --accept-source-agreements
}

# ---------------------------------------------------------------------------
# 1. Pré-requisitos
# ---------------------------------------------------------------------------
Write-Host "== Passo 1: verificando pre-requisitos ==" -ForegroundColor Cyan

$prereqs = @(
    @{ Name = "git";    Cmd = "git";    WingetId = "Git.Git";              Label = "Git" }
    @{ Name = "node";   Cmd = "node";   WingetId = "OpenJS.NodeJS.LTS";    Label = "Node.js" }
    @{ Name = "cargo";  Cmd = "cargo";  WingetId = "Rustlang.Rustup";      Label = "Rust (rustup)" }
    @{ Name = "go";     Cmd = "go";     WingetId = "GoLang.Go";            Label = "Go" }
)

$missing = @()
foreach ($p in $prereqs) {
    if (Test-Cmd $p.Cmd) {
        Write-Host "  OK: $($p.Label)" -ForegroundColor Green
    } else {
        Write-Host "  FALTANDO: $($p.Label)" -ForegroundColor Yellow
        $missing += $p
    }
}

if (-not (Test-Cmd "cl")) {
    Write-Host "  ATENCAO: cl.exe (MSVC Build Tools) nao encontrado no PATH." -ForegroundColor Yellow
    Write-Host "  Instale o 'Visual Studio Build Tools' com o workload 'Desktop development with C++':" -ForegroundColor Yellow
    Write-Host "  https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Yellow
    Write-Host "  (nao tem instalador silencioso simples via winget para o workload certo - instale manualmente)" -ForegroundColor Yellow
}

if ($missing.Count -gt 0) {
    if ($InstallPrereqs) {
        foreach ($p in $missing) {
            Install-Winget $p.WingetId $p.Label
        }
        Write-Warning "Pre-requisitos instalados. Feche e reabra o PowerShell (PATH atualizado) antes de rodar este script de novo, ou pule direto para o clone."
        exit 0
    } else {
        Write-Warning "Faltam pre-requisitos: $($missing.Label -join ', '). Rode de novo com -InstallPrereqs para instalar via winget, ou instale manualmente."
    }
}

# ---------------------------------------------------------------------------
# 2. Clonar o repositorio
# ---------------------------------------------------------------------------
Write-Host "== Passo 2: clonando repositorio ==" -ForegroundColor Cyan

if (Test-Path (Join-Path $TargetDir ".git")) {
    Write-Host "  $TargetDir ja existe e tem .git - pulando clone."
} else {
    git clone $RepoUrl $TargetDir
}

Push-Location $TargetDir
try {
    # -----------------------------------------------------------------------
    # 3. Instalar dependencias
    # -----------------------------------------------------------------------
    Write-Host "== Passo 3: npm install ==" -ForegroundColor Cyan
    npm install

    # -----------------------------------------------------------------------
    # 4. Segredos locais (network_session.json / api/.dev.vars)
    # -----------------------------------------------------------------------
    Write-Host "== Passo 4: arquivos locais (segredos) ==" -ForegroundColor Cyan

    $sessionDest = "network_session.json"
    $devVarsDest = "api\.dev.vars"

    if ($SecretsSource -ne "") {
        $sessionSrc = Join-Path $SecretsSource "network_session.json"
        $devVarsSrc = Join-Path $SecretsSource ".dev.vars"

        if (Test-Path $sessionSrc) {
            Copy-Item $sessionSrc $sessionDest -Force
            Write-Host "  network_session.json copiado de $SecretsSource"
        } else {
            Write-Warning "  $sessionSrc nao encontrado em SecretsSource."
        }

        if (Test-Path $devVarsSrc) {
            Copy-Item $devVarsSrc $devVarsDest -Force
            Write-Host "  api\.dev.vars copiado de $SecretsSource"
        } else {
            Write-Warning "  $devVarsSrc nao encontrado em SecretsSource."
        }
    } else {
        if (-not (Test-Path $sessionDest)) {
            Copy-Item "network_session.template.json" $sessionDest
            Write-Warning "  network_session.json criado a partir do template - preencha o authKey real (idealmente uma key NOVA do Tailscale) antes de rodar o app."
        }
        if (-not (Test-Path $devVarsDest)) {
            Copy-Item "api\.dev.vars.example" $devVarsDest
            Write-Warning "  api\.dev.vars criado a partir do template - preencha TAILSCALE_OAUTH_CLIENT_ID/SECRET e SUPABASE_SERVICE_ROLE_KEY antes de usar a API."
        }
    }

    # -----------------------------------------------------------------------
    # 5. Build do sidecar
    # -----------------------------------------------------------------------
    Write-Host "== Passo 5: build do sidecar (tsnet-node) ==" -ForegroundColor Cyan
    if (Test-Cmd "go") {
        npm run build:sidecar
    } else {
        Write-Warning "  Go nao esta no PATH ainda - rode 'npm run build:sidecar' manualmente depois de instalar o Go."
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Setup concluido. Para rodar o app:" -ForegroundColor Cyan
Write-Host "  cd $TargetDir"
Write-Host "  npm run tauri dev"
