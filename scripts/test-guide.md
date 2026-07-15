# Guia de Testes — Pós-Implementação

Este guia cobre TUDO que foi implementado. Siga a ordem abaixo: comece pelo que não depende de rede externa e vá evoluindo.

---

## Fase 0 — Pré-requisitos

Antes de testar qualquer coisa, verifique se o projeto compila:

```bash
# 1. TypeScript (frontend)
cd c:\Projetos\CubeForge
npx tsc --noEmit

# 2. Rust (desktop)
cargo check --manifest-path src-tauri\Cargo.toml

# 3. API (Cloudflare Worker)
cd api
npx tsc --noEmit

# 4. Go (sidecar)
cd src-tauri\sidecars\tsnet-node
go build -o tsnet-node.exe .
```

**Resultado esperado:** Todos compilam sem erros.

- [ ] 0.1 TypeScript compila sem erros
- [ ] 0.2 Rust compila sem erros
- [ ] 0.3 API compila sem erros
- [ ] 0.4 Go sidecar compila sem erros

---

## Fase 1 — Testes da API (Cloudflare Worker)

### 1.1 Verificar Health Check
```bash
curl https://cubeforge-api.cubeforge.workers.dev/health
```
**Esperado:** `{ "success": true, "code": "SUCCESS", "data": { "status": "ok" } }`

- [ ] 1.1 Health check funciona

### 1.2 Criar Servidor (POST)
```bash
curl -X POST https://cubeforge-api.cubeforge.workers.dev/api/v1/servers \
  -H "Content-Type: application/json" \
  -d '{"name":"Meu Servidor Teste","version":"1.20.1","serverType":"vanilla"}'
```
**Esperado:** HTTP 201, `code: "SERVER_CREATED"`, retorna `shortCode` (ex: "X7K9M2")

- [ ] 1.2 Servidor criado com shortCode

### 1.3 Descobrir Servidor (GET)
```bash
curl https://cubeforge-api.cubeforge.workers.dev/api/v1/servers/X7K9M2
```
(Substitua X7K9M2 pelo shortCode obtido acima)
**Esperado:** HTTP 200, retorna dados do servidor + session null

- [ ] 1.3 Servidor encontrado via GET

### 1.4 Criar ConnectionSession (POST — endpoint NOVO)
```bash
curl -X POST https://cubeforge-api.cubeforge.workers.dev/api/v1/servers/X7K9M2/connection-sessions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId":"11111111-1111-1111-1111-111111111111",
    "correlationId":"22222222-2222-2222-2222-222222222222",
    "installationId":"33333333-3333-3333-3333-333333333333",
    "clientVersion":"1.0.0"
  }'
```
**Esperado:** HTTP 201, retorna `{ sessionId, launcher, launcherVersion, protocolVersion, credentials, leaseDurationMs }`

**Importante:** Note que o request NÃO envia "provider". A API decide.

- [ ] 1.4 ConnectionSession criada sem enviar provider
- [ ] 1.5 Resposta contém `launcher: "tsnet-v1"` (driver opaco)
- [ ] 1.6 Resposta contém `credentials` como blob
- [ ] 1.7 Resposta contém `protocolVersion: 1`

### 1.5 Testar Idempotência (mesmo requestId)
Repita o passo 1.4 com o MESMO `requestId`.
**Esperado:** HTTP 201, MESMA resposta (não cria duplicata)

- [ ] 1.8 Idempotência funciona (requestId cacheado)

### 1.6 Testar OPERATION_IN_PROGRESS
Repita o passo 1.4 com um NOVO `requestId` (mesmo shortCode).
**Esperado:** HTTP 409, `code: "OPERATION_IN_PROGRESS"`

- [ ] 1.9 Bloqueio de sessão concorrente funciona

### 1.7 Atualizar ConnectionSession (PATCH)
```bash
curl -X PATCH https://cubeforge-api.cubeforge.workers.dev/api/v1/connection-sessions/{sessionId} \
  -H "Content-Type: application/json" \
  -d '{
    "requestId":"44444444-4444-4444-4444-444444444444",
    "correlationId":"55555555-5555-5555-5555-555555555555",
    "status":"online",
    "hostIp":"100.84.21.10",
    "revision":1,
    "timing":{"apiCallMs":450,"providerStartMs":1200,"totalElapsedMs":3200}
  }'
```
**Esperado:** HTTP 200, `code: "CONNECTION_SESSION_UPDATED"`

- [ ] 1.10 PATCH funciona com status e hostIp

### 1.8 Testar STALE_WRITE (revision errada)
Faça o PATCH acima com `"revision":0` (menor que a atual).
**Esperado:** HTTP 409, `code: "STALE_WRITE"`

- [ ] 1.11 Stale write prevention funciona

### 1.9 Enviar Heartbeat (POST — endpoint separado)
```bash
curl -X POST https://cubeforge-api.cubeforge.workers.dev/api/v1/connection-sessions/{sessionId}/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "requestId":"66666666-6666-6666-6666-666666666666",
    "correlationId":"77777777-7777-7777-7777-777777777777",
    "metrics":{"currentPlayers":3,"memoryUsageMb":2048}
  }'
```
**Esperado:** HTTP 200, `code: "HEARTBEAT_RECEIVED"`, retorna `heartbeatCount`

- [ ] 1.12 Heartbeat endpoint separado funciona
- [ ] 1.13 Resposta contém `heartbeatCount` e `revision`

### 1.10 Encerrar ConnectionSession (DELETE)
```bash
curl -X DELETE "https://cubeforge-api.cubeforge.workers.dev/api/v1/connection-sessions/{sessionId}?reason=user_stopped"
```
**Esperado:** HTTP 200, `code: "CONNECTION_SESSION_DELETED"`, retorna `durationMs`

- [ ] 1.14 DELETE com reason funciona
- [ ] 1.15 Resposta contém `durationMs`

### 1.16 Testar Erro 404 (session inexistente)
```bash
curl -X PATCH https://cubeforge-api.cubeforge.workers.dev/api/v1/connection-sessions/sessao-inexistente \
  -H "Content-Type: application/json" \
  -d '{"requestId":"aaa","correlationId":"bbb","status":"online","revision":1}'
```
**Esperado:** HTTP 404, `code: "SESSION_NOT_FOUND"`, contém `technicalId`

- [ ] 1.17 Erro 404 com technicalId

---

## Fase 2 — Testes do Rust (Desktop)

### 2.1 Verificar Build
```bash
cd c:\Projetos\CubeForge
cargo check --manifest-path src-tauri\Cargo.toml
```
**Esperado:** Compila sem erros (apenas warnings são aceitáveis)

- [ ] 2.1 Rust compila

### 2.2 Verificar Módulos
Confira se os 3 novos arquivos existem:
- `src-tauri/src/api_client.rs` ✓
- `src-tauri/src/session_manager.rs` ✓
- `src-tauri/src/provider_manager.rs` ✓

- [ ] 2.2 api_client.rs existe
- [ ] 2.3 session_manager.rs existe
- [ ] 2.4 provider_manager.rs existe

### 2.3 Verificar Cargo.toml
```bash
cd src-tauri && cargo tree | findstr async-trait
```
**Esperado:** Mostra `async-trait v0.1.89`

- [ ] 2.5 async-trait na árvore de dependências

### 2.4 Verificar lib.rs imports
Abra `src-tauri/src/lib.rs` e confira as linhas:
```rust
mod api_client;
mod session_manager;
mod provider_manager;
use api_client::{ApiClient, ApiConfig};
use session_manager::SessionManager;
use provider_manager::ProviderManager;
```

- [ ] 2.6 lib.rs importa os 3 módulos

---

## Fase 3 — Testes do Sidecar Go

### 3.1 Compilar
```bash
cd c:\Projetos\CubeForge\src-tauri\sidecars\tsnet-node
go build -o tsnet-node.exe .
```
**Esperado:** `tsnet-node.exe` gerado sem erros

- [ ] 3.1 Sidecar compila

### 3.2 Testar --stdin (modo novo)
```bash
echo "{\"authKey\":\"teste\",\"hostname\":\"cf-teste\",\"mode\":\"host\",\"targetIp\":null,\"localPort\":25565}" | tsnet-node.exe --stdin
```
**Esperado:** O sidecar tenta conectar (vai falhar porque authKey é inválida, mas a leitura do stdin funciona)

- [ ] 3.2 Leitura de stdin funciona (não importa se falha depois)

### 3.3 Testar --config (modo legado)
```bash
echo "{\"authKey\":\"teste\",\"hostname\":\"cf-teste\",\"mode\":\"host\",\"targetIp\":null,\"localPort\":25565}" > test_config.json
tsnet-node.exe --config test_config.json
```
**Esperado:** Mesmo comportamento (tenta conectar, falha, mas leu o arquivo)

- [ ] 3.3 Leitura de arquivo funciona

---

## Fase 4 — Testes do Frontend

### 4.1 Verificar Build
```bash
cd c:\Projetos\CubeForge
npx tsc --noEmit
```
**Esperado:** Sem erros

- [ ] 4.1 TypeScript compila

### 4.2 Verificar page.tsx
Abra `src/app/page.tsx` e confira:
- [ ] 4.2 `sync_create_session` foi removido (não aparece no arquivo)
- [ ] 4.3 `sync_update_session` ainda aparece (mantido como heartbeat)
- [ ] 4.4 `sync_register_server` ainda aparece (mantido)
- [ ] 4.5 `sync_send_heartbeat` ainda aparece (mantido)

### 4.3 Rodar Dev Server (UI)
```bash
npm run dev
```
Abra http://localhost:3000 no navegador.
- [ ] 4.6 Interface carrega sem erros no console
- [ ] 4.7 Aba Host aparece
- [ ] 4.8 Aba Guest aparece

---

## Fase 5 — Teste Integrado (Tauri + API)

### 5.1 Rodar em Modo Dev
```bash
npm run tauri dev
```
**Observação:** Se não tiver o ambiente Tauri configurado, pule esta fase e teste apenas via curl.

- [ ] 5.1 Tauri inicia sem erros

### 5.2 Testar Fluxo do Host (com Mock Provider)
Use o Mock Provider para testar offline:

1. Crie o arquivo `network_session.json` na raiz do projeto:
```json
{
  "provider": "mock",
  "credentials": {
    "fakeIp": "100.99.99.99"
  }
}
```
2. No Tauri, clique em "Iniciar Rede Mesh"
3. **Esperado:** A rede mesh entra como "online" com IP `100.99.99.99`

- [ ] 5.2 Mock provider funciona

### 5.3 Testar Importação de Servidor
1. Crie uma pasta com `server.jar` e `server.properties` em qualquer lugar
2. No CubeForge, clique no botão "Importar" (ícone de pasta) na sidebar
3. Selecione a pasta
4. **Esperado:** Servidor aparece na lista com versão detectada

- [ ] 5.3 Importação de servidor funciona

### 5.4 Testar EULA na Importação
No mesmo servidor importado:
1. Verifique se o arquivo `eula.txt` foi criado com `eula=true`
2. Se o servidor já tinha eula.txt com `eula=false`, ele foi trocado para `true`

- [ ] 5.4 EULA aceito automaticamente na importação

### 5.5 Testar Remoção de Servidor Importado
1. Clique no "x" ao lado do servidor importado
2. **Esperado:** Modal mostra mensagem: "remover da lista, arquivos não serão deletados"
3. Confirme digitando o nome
4. **Esperado:** Servidor some da lista, mas pasta original continua existindo

- [ ] 5.5 Remoção de servidor importado não deleta arquivos

### 5.6 Testar Remoção de Servidor Padrão
1. Crie um servidor novo
2. Delete-o
3. **Esperado:** Modal mostra mensagem: "deletado permanentemente"

- [ ] 5.6 Remoção de servidor padrão deleta arquivos

### 5.7 Testar Bloqueio de Concorrência
1. Inicie a rede mesh
2. Tente clicar "Iniciar" novamente
3. **Esperado (futuro):** Mensagem "Já existe uma operação em andamento"

- [ ] 5.7 Bloqueio de concorrência funciona

---

## Fase 6 — Testes de Regressão (o que NÃO pode ter quebrado)

### 6.1 Criação de Servidor
- [ ] 6.1 Criar servidor Vanilla 1.20.1 funciona
- [ ] 6.2 server.jar é baixado
- [ ] 6.3 server.properties é gerado
- [ ] 6.4 eula.txt é criado

### 6.2 Iniciar Servidor
- [ ] 6.5 Servidor inicia
- [ ] 6.6 Console mostra logs
- [ ] 6.7 Status muda para "online"
- [ ] 6.8 Comando "stop" funciona

### 6.3 Guest
- [ ] 6.9 Aba Guest carrega
- [ ] 6.10 Código de convite aparece

### 6.4 Sincronização (SyncEngine)
- [ ] 6.11 `sync_register_server` funciona (retorna SERVER_CREATED ou QUEUED)
- [ ] 6.12 `sync_send_heartbeat` funciona
- [ ] 6.13 Fila de sincronização persiste operações offline

---

## Fase 7 — Teste na Nuvem (Wrangler)

Se você quiser testar a API publicada:

```bash
cd c:\Projetos\CubeForge\api
npx wrangler deploy
```

Depois repita os testes da Fase 1 apontando para o domínio do Cloudflare.

- [ ] 7.1 API publicada no Cloudflare
- [ ] 7.2 Todos os testes da Fase 1 passam em produção

---

## Checklist de Verificação Final

| Item | Status |
|------|--------|
| API Cloudflare Worker compila | |
| Rust compila sem erros | |
| TypeScript compila sem erros | |
| Go sidecar compila | |
| POST /connection-sessions funciona | |
| PATCH /connection-sessions/{id} funciona | |
| POST /.../heartbeat funciona | |
| DELETE /.../connection-sessions/{id} funciona | |
| Idempotência (requestId) funciona | |
| Stale write (revision) funciona | |
| OPERATION_IN_PROGRESS bloqueia duplicatas | |
| --stdin no sidecar funciona | |
| --config no sidecar funciona | |
| Importação de servidor funciona | |
| EULA aceito automaticamente | |
| Remoção de importado não deleta arquivos | |
| Remoção de padrão deleta arquivos | |
| sync_create_session removido do frontend | |
| Regressão: criação de servidor funciona | |
| Regressão: iniciar/parar servidor funciona | |