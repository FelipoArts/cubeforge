# Guia de Testes — Suporte a Servidores Forge

Este guia cobre todos os cenários da nova implementação de Forge. Siga a ordem: comece pelo que não depende de rede externa e vá evoluindo.

---

## Fase 0 — Compilação

Verifique se tudo compila antes de qualquer teste:

```bash
# TypeScript
cd c:\Projetos\CubeForge
npx tsc --noEmit

# Rust
cd src-tauri
cargo check
```

- [ ] 0.1 TypeScript compila sem erros
- [ ] 0.2 Rust compila sem erros

---

## Fase 1 — API de Versões Forge/NeoForge

### 1.1 Testar ForgeProvider (versões ≤ 1.20.1)
```javascript
const { getForgeVersions } = await import("@/lib/server");
const builds = await getForgeVersions("1.20.1");
console.log(builds);
```
**Esperado:** Array de builds Forge para 1.20.1, recommended primeiro

- [ ] 1.1 `getForgeVersions("1.20.1")` retorna builds do Forge
- [ ] 1.2 A primeira build tem `recommended: true`
- [ ] 1.3 Cada build tem `forgeVersion`, `installerUrl`, `mcVersion`

### 1.2 Testar NeoForgeProvider (versões ≥ 1.20.4)
```javascript
const builds = await getForgeVersions("1.21.1");
console.log(builds);
```

- [ ] 1.4 `getForgeVersions("1.21.1")` retorna builds do NeoForge
- [ ] 1.5 O provider correto é selecionado automaticamente

### 1.3 Testar Fallback Offline
Desligue a internet ou bloqueie as URLs e repita os testes acima.

- [ ] 1.6 Fallback offline funciona para 1.20.1
- [ ] 1.7 Fallback offline funciona para 1.16.5
- [ ] 1.8 Fallback para versão sem fallback retorna "unknown"

---

## Fase 2 — ServerInfo.serverJar

- [ ] 2.1 `ServerInfo` tem campo `serverJar: string | null`
- [ ] 2.2 `importExistingServer()` retorna `serverJar: null`
- [ ] 2.3 `scanExternalServer()` retorna `serverJar: null`
- [ ] 2.4 `listLocalServers()` retorna `serverJar: null`

---

## Fase 3 — Rust: server_jar_name

- [ ] 3.1 `start_minecraft_server` aceita `server_jar_name: Option<String>`
- [ ] 3.2 Quando None, usa `"server.jar"`
- [ ] 3.3 Quando Some, usa o valor passado
- [ ] 3.4 `cargo check` compila

---

## Fase 4 — Criar Servidor Vanilla (regressão)

- [ ] 4.1 Modal de criação abre
- [ ] 4.2 Servidor Vanilla é criado com sucesso
- [ ] 4.3 server.jar é baixado
- [ ] 4.4 eula.txt é criado
- [ ] 4.5 server.properties é gerado
- [ ] 4.6 cubicase-meta.json contém `serverType: "vanilla"`

---

## Fase 5 — Iniciar Servidor Vanilla (regressão)

- [ ] 5.1 Servidor Vanilla inicia
- [ ] 5.2 Console mostra logs
- [ ] 5.3 Status muda para "online"
- [ ] 5.4 Comando "stop" funciona

---

## Fase 6 — Importar Servidor Forge Existente

Crie um servidor Forge manualmente fora do CubeCase e importe:

```bash
# Exemplo: baixar e instalar Forge 1.20.1
java -jar forge-1.20.1-47.1.0-installer.jar --installServer
```

- [ ] 6.1 Importação de servidor Forge funciona
- [ ] 6.2 O tipo aparece como "forge" na sidebar
- [ ] 6.3 A versão é detectada corretamente
- [ ] 6.4 O EULA é aceito automaticamente
- [ ] 6.5 `cubicase-meta.json` contém `serverType: "forge"`

---

## Fase 7 — GuestView: Badge de Tipo

| Tipo | Cor esperada |
|------|-------------|
| vanilla | 🟢 Verde |
| forge | 🟠 Laranja |
| fabric | 🟣 Roxo |
| paper | 🔵 Azul |
| neoforge | 🟣 Violeta |

- [ ] 7.1 Badge "vanilla" aparece em verde
- [ ] 7.2 Badge "forge" aparece em laranja
- [ ] 7.3 Badge "Meu Servidor" aparece em indigo

---

## Fase 8 — Testes de Regressão Gerais

- [ ] 8.1 Servidor Vanilla inicia/para
- [ ] 8.2 Aba Guest carrega
- [ ] 8.3 Código de convite aparece
- [ ] 8.4 Heartbeat funciona
- [ ] 8.5 Registro na API funciona
- [ ] 8.6 Importar servidor Vanilla funciona
- [ ] 8.7 Remover servidor importado não deleta arquivos
- [ ] 8.8 Remover servidor padrão deleta arquivos

---

## Checklist de Verificação Final

| Item | Status |
|------|--------|
| TypeScript compila | |
| Rust compila | |
| getForgeVersions("1.20.1") funciona | |
| getForgeVersions("1.21.1") funciona (NeoForge) | |
| Fallback offline funciona | |
| Criar servidor Vanilla funciona | |
| Iniciar servidor Vanilla funciona | |
| Importar servidor Forge funciona | |
| Badge "forge" em laranja no Guest | |
| Badge "Meu" em indigo no Guest | |
| Regressão: iniciar/parar servidor | |
| Regressão: heartbeat | |
| Regressão: API Central | |