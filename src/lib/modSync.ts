import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

// ============================================================
// modSync — sincronização de mods do CLIENTE do convidado com o que o
// servidor Fabric/Forge/NeoForge realmente tem na pasta mods/ agora.
// ============================================================
// Camadas de resolução (feitas do lado do HOST, em Rust — ver
// resolve_server_mods/handle_mods_list em lib.rs, exposto pela mesh em
// "GET /mods"): cache por arquivo -> hash SHA1 batido contra o Modrinth
// (API pública, sem key — reconhece mods "soltos" na pasta, não só os
// instalados pelo próprio CubeForge) -> "unknown" quando nada bate.
//
// Este módulo só orquestra o lado do CONVIDADO: busca essa lista pela mesh,
// compara com o que já existe na instância isolada local (por hash, não só
// nome), e baixa o que falta — direto do CDN do Modrinth quando a origem é
// conhecida (não passa pelo host), ou do próprio host via mesh como
// fallback (mods "unknown"). Nunca decide sozinho abrir o launcher — quem
// chama isso decide o que fazer com o resultado.
// ============================================================

// Porta local fixa (só loopback, na máquina do convidado) que o sidecar Go
// encaminha pela mesh até a porta 25566 do host — ver modsHttpLocalPort em
// src-tauri/sidecars/tsnet-node/main.go. Só responde enquanto uma sessão de
// convidado está conectada; se a mesh cair, as chamadas abaixo falham com
// erro de conexão recusada, tratado como "host inalcançável".
const MODS_PROXY_BASE = "http://127.0.0.1:25568";

/** Um mod da pasta mods/ do host, como a rota "GET /mods" devolve (ver ModManifestEntry em lib.rs). */
export interface RemoteModEntry {
  filename: string;
  size_bytes: number;
  sha1: string;
  source: "modrinth" | "unknown";
  url: string | null;
}

export type ModSyncEntryStatus = "pending" | "downloading" | "ok" | "failed";

export interface ModSyncEntry {
  filename: string;
  sizeBytes: number;
  /** De onde este mod específico vai ser baixado — só informativo pra UI (mostrar a origem no progresso). "local" = cópia direta da pasta do próprio servidor no disco, sem rede (ver planLocalModSync). */
  source: "modrinth" | "mesh" | "local";
  status: ModSyncEntryStatus;
  error?: string;
}

export interface ModSyncPlan {
  /** Mods que precisam ser baixados (já filtrados dos que já batem localmente). */
  entries: ModSyncEntry[];
  alreadyInstalledCount: number;
  totalBytesToDownload: number;
  /** Lista crua do host, guardada pra runModSync não precisar buscar de novo. */
  remoteMods: RemoteModEntry[];
}

/** Busca, pela mesh, a lista de mods que o servidor hospedado precisa agora. Lança se o host não responder. */
export async function fetchRemoteModsList(shortCode: string): Promise<RemoteModEntry[]> {
  let res: Response;
  try {
    res = await fetch(`${MODS_PROXY_BASE}/mods?code=${encodeURIComponent(shortCode)}`);
  } catch {
    throw new Error("Não foi possível falar com o host para checar os mods — a rede mesh pode estar instável ou o host offline.");
  }
  if (res.status === 404) {
    throw new Error("O host não está hospedando este servidor agora (ou você já não está mais conectado a ele).");
  }
  if (!res.ok) {
    throw new Error(`O host respondeu com erro ao listar os mods (HTTP ${res.status}).`);
  }
  return (await res.json()) as RemoteModEntry[];
}

/** Mapa nome-do-arquivo -> sha1 dos .jar já presentes na pasta mods/ da instância isolada local. */
async function listLocalModHashes(instanceModsDir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!(await exists(instanceModsDir))) return result;

  const entries = await readDir(instanceModsDir);
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name?.toLowerCase().endsWith(".jar")) continue;
    try {
      const path = await join(instanceModsDir, entry.name);
      const sha1 = await invoke<string>("compute_file_sha1", { path });
      result.set(entry.name, sha1);
    } catch {
      // Arquivo ilegível/corrompido localmente — trata como "não instalado" (será rebaixado).
    }
  }
  return result;
}

/**
 * Monta o plano a partir de uma lista de mods já resolvida (remota ou
 * local) — compartilhado por planModSync/planLocalModSync. Para o modo
 * local, `preferModrinth` é false: o arquivo já está no disco do próprio
 * host, então copiar direto é sempre melhor do que baixar de novo do
 * Modrinth (mesmo que a origem tenha sido identificada).
 */
function buildSyncPlan(
  mods: RemoteModEntry[],
  localHashes: Map<string, string>,
  fallbackSource: "mesh" | "local",
  preferModrinth: boolean
): ModSyncPlan {
  const entries: ModSyncEntry[] = [];
  let alreadyInstalledCount = 0;
  let totalBytesToDownload = 0;

  for (const mod of mods) {
    const localSha1 = localHashes.get(mod.filename);
    if (localSha1 && localSha1.toLowerCase() === mod.sha1.toLowerCase()) {
      alreadyInstalledCount++;
      continue;
    }
    entries.push({
      filename: mod.filename,
      sizeBytes: mod.size_bytes,
      source: preferModrinth && mod.source === "modrinth" && mod.url ? "modrinth" : fallbackSource,
      status: "pending",
    });
    totalBytesToDownload += mod.size_bytes;
  }

  return { entries, alreadyInstalledCount, totalBytesToDownload, remoteMods: mods };
}

/**
 * Monta o plano de sincronização: busca a lista do host pela mesh, compara
 * com o que já existe localmente (por hash, não só nome — um arquivo com
 * nome certo mas conteúdo errado NÃO conta como já instalado) e retorna só
 * o que falta baixar, já com a origem de cada um. Não baixa nada — isso é
 * runModSync, chamado só depois que o usuário confirmar no modal.
 */
export async function planModSync(shortCode: string, instanceModsDir: string): Promise<ModSyncPlan> {
  const [remoteMods, localHashes] = await Promise.all([
    fetchRemoteModsList(shortCode),
    listLocalModHashes(instanceModsDir),
  ]);
  return buildSyncPlan(remoteMods, localHashes, "mesh", true);
}

/** Busca, direto no disco (sem mesh), a lista de mods da pasta mods/ de um servidor local — usado quando o próprio host quer jogar no seu servidor. */
export async function fetchLocalServerMods(serverDir: string): Promise<RemoteModEntry[]> {
  return await invoke<RemoteModEntry[]>("list_local_server_mods", { serverDir });
}

/** Mesmo papel de planModSync, mas para o servidor do próprio host: lê a lista de mods direto da pasta do servidor no disco, sem passar pela mesh. */
export async function planLocalModSync(serverDir: string, instanceModsDir: string): Promise<ModSyncPlan> {
  const [localMods, localHashes] = await Promise.all([
    fetchLocalServerMods(serverDir),
    listLocalModHashes(instanceModsDir),
  ]);
  return buildSyncPlan(localMods, localHashes, "local", false);
}

export interface RunModSyncOptions {
  shortCode: string;
  instanceModsDir: string;
  remoteMods: RemoteModEntry[];
  entries: ModSyncEntry[];
  onProgress: (entries: ModSyncEntry[]) => void;
}

/**
 * Baixa, um de cada vez, todo mod em `entries` (mutados in-place — status
 * avança pending -> downloading -> ok/failed). Sequencial de propósito: mods
 * "mesh" competem pelo upload do próprio host (não sobrecarregar), e mods
 * "modrinth" não precisam de paralelismo pra já serem rápidos (CDN). Nunca
 * lança — falhas individuais ficam registradas em `entry.error`, quem
 * chamou decide o que fazer (tentar de novo, continuar mesmo assim, etc).
 */
export async function runModSync(opts: RunModSyncOptions): Promise<void> {
  const { shortCode, instanceModsDir, remoteMods, entries, onProgress } = opts;
  const byFilename = new Map(remoteMods.map((m) => [m.filename, m]));

  for (const entry of entries) {
    const mod = byFilename.get(entry.filename);
    if (!mod) {
      entry.status = "failed";
      entry.error = "Mod não está mais na lista do host (pode ter sido removido durante a sincronização).";
      onProgress([...entries]);
      continue;
    }

    entry.status = "downloading";
    onProgress([...entries]);

    const destPath = await join(instanceModsDir, entry.filename);
    const url =
      entry.source === "modrinth" && mod.url
        ? mod.url
        : `${MODS_PROXY_BASE}/mods/file?code=${encodeURIComponent(shortCode)}&name=${encodeURIComponent(entry.filename)}`;

    try {
      await invoke("download_mod_file", { url, destPath, expectedSha1: mod.sha1 });
      entry.status = "ok";
    } catch (err) {
      entry.status = "failed";
      entry.error = String(err);
    }
    onProgress([...entries]);
  }
}

export interface RunLocalModSyncOptions {
  /** Pasta raiz do servidor local (contém a pasta mods/) — ver ServerInfo.path em src/lib/server.ts. */
  serverDir: string;
  instanceModsDir: string;
  remoteMods: RemoteModEntry[];
  entries: ModSyncEntry[];
  onProgress: (entries: ModSyncEntry[]) => void;
}

/**
 * Mesmo papel de runModSync, mas para o servidor do próprio host: copia os
 * arquivos direto da pasta mods/ do servidor no disco (sem download por
 * rede) — usado pelo fluxo "Jogar" na aba Convidado, para "Meus Servidores".
 */
export async function runLocalModSync(opts: RunLocalModSyncOptions): Promise<void> {
  const { serverDir, instanceModsDir, remoteMods, entries, onProgress } = opts;
  const byFilename = new Map(remoteMods.map((m) => [m.filename, m]));

  for (const entry of entries) {
    const mod = byFilename.get(entry.filename);
    if (!mod) {
      entry.status = "failed";
      entry.error = "Mod não está mais na pasta do servidor (pode ter sido removido durante a sincronização).";
      onProgress([...entries]);
      continue;
    }

    entry.status = "downloading";
    onProgress([...entries]);

    const fromPath = await join(serverDir, "mods", entry.filename);
    const toPath = await join(instanceModsDir, entry.filename);

    try {
      await invoke("copy_local_mod_file", { fromPath, toPath });
      entry.status = "ok";
    } catch (err) {
      entry.status = "failed";
      entry.error = String(err);
    }
    onProgress([...entries]);
  }
}

// ------------------------------------------------------------
// Estado do fluxo "Preparar e Jogar" (compartilhado entre GuestView, que
// orquestra, e ModSyncModal, que só exibe) — ver design acordado na
// conversa: cada transição de fase é um clique explícito do jogador, nunca
// automática, e o relatório final é sempre visível (sucesso ou falha).
// ------------------------------------------------------------

export type PrepPhase = "checking" | "confirm" | "syncing" | "done" | "error";

export interface PrepState {
  phase: PrepPhase;
  /** Progresso fora da lista de mods (instalação do loader, seleção de perfil no launcher, etc). */
  stageMessage: string;
  stagePercent: number;
  modEntries: ModSyncEntry[];
  /** Lista crua do host guardada pra permitir "tentar de novo" sem refazer a checagem inteira. */
  remoteMods: RemoteModEntry[];
  alreadyInstalledCount: number;
  totalBytesToDownload: number;
  /** Nota sobre o loader a instalar, mostrada na confirmação (null = nada a instalar). */
  loaderNote: string | null;
  /** Erro geral (host inalcançável, etc) — distinto de falha por mod individual. */
  errorMessage?: string;
  /** true depois que o jogador escolhe "Continuar mesmo assim" com mods faltando. */
  acceptedPartial: boolean;
  /** versionId/gameDir já resolvidos pelo loader, prontos pra prepare_launcher_profile. */
  versionId: string;
  gameDir: string | null;
  instanceModsDir: string;
}

export const INITIAL_PREP_STATE: PrepState = {
  phase: "checking",
  stageMessage: "",
  stagePercent: 0,
  modEntries: [],
  remoteMods: [],
  alreadyInstalledCount: 0,
  totalBytesToDownload: 0,
  loaderNote: null,
  acceptedPartial: false,
  versionId: "",
  gameDir: null,
  instanceModsDir: "",
};

/** Formata bytes como "180 MB"/"3.2 GB" pra exibição — sem casas decimais abaixo de 10. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
