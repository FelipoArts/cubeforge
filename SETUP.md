# Ambiente de desenvolvimento — setup em uma máquina nova

Guia para deixar uma máquina Windows pronta para desenvolver o CubeForge Dash,
do zero. Segue a ordem recomendada.

> Os passos 1-5 abaixo estão automatizados em
> [`scripts/setup-new-machine.ps1`](scripts/setup-new-machine.ps1). Copie esse
> arquivo (e, se for usar `-SecretsSource`, uma pasta com `network_session.json`
> e `.dev.vars`) para a máquina nova e rode, por exemplo:
> ```powershell
> .\setup-new-machine.ps1 -InstallPrereqs -SecretsSource D:\cubeforge-secrets
> ```
> Ele checa/instala pré-requisitos, clona, roda `npm install`, copia os
> segredos (ou cria a partir dos templates) e compila o sidecar. O passo 7
> (contas/autenticações) continua manual — veja abaixo.

## 1. Pré-requisitos (instalar antes de clonar)

| Ferramenta | Versão usada no ambiente original | Observação |
|---|---|---|
| Git | qualquer recente | `git --version` |
| Node.js | v24.x (LTS) | inclui npm |
| Rust (via [rustup](https://rustup.rs)) | stable (1.96+), `rust-version` mínimo no Cargo.toml é 1.77.2 | target padrão no Windows já é `x86_64-pc-windows-msvc` |
| Go | 1.26.x (CI usa 1.22, então qualquer versão ≥1.22 serve) | necessário para compilar o sidecar `tsnet-node` |
| Microsoft C++ Build Tools | — | Visual Studio Build Tools com o workload "Desktop development with C++" — exigido pelo toolchain MSVC do Rust/Tauri no Windows |
| WebView2 Runtime | — | normalmente já vem instalado no Windows 11; senão, baixar da Microsoft |

Não é necessário instalar o Tailscale desktop app à parte — o app usa o
sidecar `tsnet-node` (embutido, via Go) para entrar na mesh, não o cliente
oficial. Só instale o Tailscale separadamente se quiser inspecionar a mesh
pela CLI/GUI oficial.

## 2. Clonar o repositório

```bash
git clone https://github.com/FelipoArts/cubeforge.git
cd cubeforge
```

Como o remote é HTTPS, o Git vai pedir autenticação no primeiro `push` —
configure o Git Credential Manager (já vem com o Git for Windows) ou um PAT.

## 3. Instalar dependências

```bash
npm install
```

Isso já traz o Tauri CLI (`@tauri-apps/cli`) como dev dependency — não
precisa instalar globalmente.

## 4. Arquivos que NÃO vêm do git (recriar/copiar manualmente)

Estes estão no `.gitignore` de propósito (segredos ou build local):

- **`network_session.json`** — contém o `authKey` do Tailscale usado em dev.
  Copie o arquivo da máquina antiga (não é seguro recriar do zero sem gerar
  uma nova key). Alternativa mais limpa: gerar uma **auth key nova** no painel
  do Tailscale para a máquina nova, em vez de reutilizar a antiga.
- **`api/.dev.vars`** — segredos do Worker (Cloudflare): `TAILSCALE_OAUTH_CLIENT_ID`,
  `TAILSCALE_OAUTH_CLIENT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`. Copie a partir
  de `api/.dev.vars.example` preenchendo com os valores reais.
- **`test_config.json`** — na verdade este *está* versionado (contém só uma
  key fake `"teste"`), então já vem com o `git clone`.

Copie `network_session.json` e `api/.dev.vars` por um canal seguro (pendrive,
transferência direta, gerenciador de senhas) — nunca por commit, chat ou
colar em serviço de terceiros.

## 5. Build do sidecar (obrigatório antes do primeiro `tauri dev`)

Normalmente automático via `beforeDevCommand`/`beforeBuildCommand` no
`tauri.conf.json`, mas pode rodar manualmente:

```bash
npm run build:sidecar
```

## 6. Rodar

```bash
npm run tauri dev
```

Para trabalhar só na UI sem o shell Tauri: `npm run dev`.

## 7. Contas/autenticações que a máquina nova vai precisar (fora do repo)

- **GitHub** — para `git push`/`pull` no repo (`cubeforge`) e no `play-site`
  (repo separado: `github.com/FelipoArts/cubicase-play`, usado para
  `play.cubicase.net`, publicado via GitHub Pages).
- **Cloudflare (`wrangler login`)** — só se for mexer/deployar o Worker em `api/`.
- **Tailscale** — se for gerar auth key nova (recomendado) em vez de reusar a
  antiga, é só acessar o painel web, não precisa instalar nada localmente.

## 8. O que é opcional / não precisa copiar

- `plans/` — documentos internos de arquitetura (gitignored). Copie a pasta
  se quiser manter o histórico de planejamento; não afeta o funcionamento do
  app.
- `.claude/settings.local.json`, `.claude/skills/`, `.agents/` — cache/config
  local do Claude Code (allowlist de permissões, skills baixadas via
  `skills-lock.json`). Recriam sozinhos com o uso; não precisa copiar.
- `node_modules/`, `.next/`, `out/`, `src-tauri/target/`, `src-tauri/gen/`,
  `src-tauri/binaries/`, `*.exe` do sidecar, `tsconfig.tsbuildinfo`,
  `next-env.d.ts` — tudo gerado por `npm install` / build, não copiar.
