# Compila o sidecar tsnet-node (Go) e coloca no caminho que o Tauri espera
# (src-tauri/binaries/tsnet-node-x86_64-pc-windows-msvc.exe). O binário fica
# fora do git (ver .gitignore), então precisa ser gerado localmente antes de
# cada `tauri dev`/`tauri build` — chamado automaticamente por
# beforeDevCommand/beforeBuildCommand em src-tauri/tauri.conf.json.

$ErrorActionPreference = "Stop"

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Write-Error "Go não encontrado no PATH. Instale em https://go.dev/dl/ antes de rodar o Cubicase."
    exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$sidecarDir = Join-Path $root "src-tauri\sidecars\tsnet-node"
$binariesDir = Join-Path $root "src-tauri\binaries"
$target = Join-Path $binariesDir "tsnet-node-x86_64-pc-windows-msvc.exe"

New-Item -ItemType Directory -Force -Path $binariesDir | Out-Null

Push-Location $sidecarDir
try {
    go build -o $target .
} finally {
    Pop-Location
}

Write-Host "Sidecar tsnet-node compilado: $target"
