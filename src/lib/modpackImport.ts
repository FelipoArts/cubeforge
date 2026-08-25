import { invoke } from "@tauri-apps/api/core";
import { join, documentDir } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { installForgeServer, installFabricServer, type ServerInstallProgress } from "@/lib/server";
import { readModInstallRegistry, writeModInstallRegistry } from "@/lib/modrinth";

// ============================================================
// Import de Modpacks — CurseForge (.zip) e Modrinth (.mrpack)
// ============================================================
// Lê o manifest do pack (via comando Rust "read_modpack_manifest"), resolve
// a lista de mods numa forma normalizada comum aos dois formatos, instala o
// loader certo reaproveitando installForgeServer/installFabricServer, baixa
// cada mod com o já existente "download_server_jar" e extrai os overrides
// via "extract_modpack_overrides". CurseForge não expõe URL de download no
// próprio manifest (só {projectID, fileID}) — a resolução passa pelo proxy
// da API central (cubeforge-api.cubeforge.workers.dev/api/v1/curseforge/*),
// que injeta a API key da CurseForge no lado do servidor.
// ============================================================

const CUBEFORGE_WORKER_BASE = "https://cubeforge-api.cubeforge.workers.dev";

/**
 * O acesso à API da CurseForge para terceiros exige preencher um formulário e
 * passar por aprovação manual deles — ainda não temos uma key aprovada. Até lá,
 * modpacks .zip da CurseForge são recusados com uma mensagem clara em vez de
 * tentar resolver via proxy (que falharia com um erro HTTP genérico e confuso).
 * Trocar para `true` assim que a key for aprovada e configurada no Worker.
 */
const CURSEFORGE_IMPORT_ENABLED = false;

const CURSEFORGE_BATCH_SIZE = 50;
/** HashAlgo.Sha1 na API da CurseForge. */
const CURSEFORGE_SHA1_ALGO = 1;

export type ModpackLoader = "forge" | "neoforge" | "fabric";

export interface ModpackModEntry {
  filename: string;
  url: string;
  sha1: string | null;
  source: "curseforge" | "modrinth";
  projectId?: number | string;
  fileOrVersionId?: number | string;
}

/** Mod da CurseForge cujo autor desabilitou distribuição por terceiros — precisa ser baixado manualmente. */
export interface UnresolvedModpackMod {
  projectId: number;
  fileId: number;
  slug: string | null;
}

export interface ParsedModpack {
  format: "curseforge" | "modrinth";
  packName: string;
  packVersion: string;
  mcVersion: string;
  loader: ModpackLoader;
  loaderVersion: string;
  mods: ModpackModEntry[];
  unresolvedMods: UnresolvedModpackMod[];
  overridesFolders: string[];
  zipPath: string;
}

interface RawManifestSummary {
  format: "curseforge" | "modrinth";
  pack_name: string;
  pack_version: string;
  mc_version: string;
  loader: string;
  loader_version: string;
  curseforge_files: { project_id: number; file_id: number; required: boolean }[];
  modrinth_files: { path: string; url: string; sha1: string | null; file_size: number | null }[];
  overrides_folders: string[];
}

interface CurseForgeFileRef {
  project_id: number;
  file_id: number;
  required: boolean;
}

interface CurseForgeFileResponseEntry {
  id: number;
  modId: number;
  fileName: string;
  downloadUrl: string | null;
  hashes?: { algo: number; value: string }[];
}

interface CurseForgeModResponseEntry {
  id: number;
  slug: string;
}

async function curseForgeProxyFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CUBEFORGE_WORKER_BASE}/api/v1/curseforge${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Falha ao consultar a CurseForge (HTTP ${res.status}). O serviço de import pode estar temporariamente indisponível.`);
  }
  const data = (await res.json()) as { data: T };
  return data.data;
}

/**
 * Resolve {projectID, fileID} do manifest da CurseForge em URLs de download
 * reais via o proxy da API central, em lotes (a API da CurseForge tem limite
 * prático de itens por chamada em lote). Mods cujo autor desabilitou
 * distribuição por terceiros voltam com downloadUrl nulo — são separados em
 * "unresolved" (nunca falham o import inteiro) e, quando possível, ganham um
 * link manual de download via o slug do projeto.
 */
async function resolveCurseForgeFiles(
  files: CurseForgeFileRef[]
): Promise<{ resolved: ModpackModEntry[]; unresolved: UnresolvedModpackMod[] }> {
  if (files.length === 0) return { resolved: [], unresolved: [] };

  const byFileId = new Map<number, CurseForgeFileRef>();
  for (const f of files) byFileId.set(f.file_id, f);

  const resolvedFiles: CurseForgeFileResponseEntry[] = [];
  for (let i = 0; i < files.length; i += CURSEFORGE_BATCH_SIZE) {
    const batch = files.slice(i, i + CURSEFORGE_BATCH_SIZE);
    const data = await curseForgeProxyFetch<CurseForgeFileResponseEntry[]>("/v1/mods/files", {
      fileIds: batch.map((f) => f.file_id),
    });
    resolvedFiles.push(...data);
  }

  const resolved: ModpackModEntry[] = [];
  const unresolvedProjectIds = new Set<number>();
  const unresolvedRefs: { projectId: number; fileId: number }[] = [];

  for (const [fileId, ref] of byFileId) {
    const match = resolvedFiles.find((f) => f.id === fileId);
    if (match?.downloadUrl) {
      const sha1 = match.hashes?.find((h) => h.algo === CURSEFORGE_SHA1_ALGO)?.value ?? null;
      resolved.push({
        filename: match.fileName,
        url: match.downloadUrl,
        sha1,
        source: "curseforge",
        projectId: ref.project_id,
        fileOrVersionId: fileId,
      });
    } else {
      unresolvedProjectIds.add(ref.project_id);
      unresolvedRefs.push({ projectId: ref.project_id, fileId });
    }
  }

  if (unresolvedProjectIds.size === 0) return { resolved, unresolved: [] };

  let slugs = new Map<number, string>();
  try {
    const modData = await curseForgeProxyFetch<CurseForgeModResponseEntry[]>("/v1/mods", {
      modIds: Array.from(unresolvedProjectIds),
    });
    slugs = new Map(modData.map((m) => [m.id, m.slug]));
  } catch {
    // Sem o slug ainda mostramos o aviso de "baixe manualmente" — só sem o link direto.
  }

  const unresolved: UnresolvedModpackMod[] = unresolvedRefs.map((r) => ({
    projectId: r.projectId,
    fileId: r.fileId,
    slug: slugs.get(r.projectId) ?? null,
  }));

  return { resolved, unresolved };
}

/**
 * Lê e normaliza o manifest de um modpack (.zip da CurseForge ou .mrpack do
 * Modrinth) para a tela de confirmação — não baixa nem instala nada ainda.
 */
export async function parseModpack(zipPath: string): Promise<ParsedModpack> {
  const raw = await invoke<RawManifestSummary>("read_modpack_manifest", { zipPath });
  const loader = raw.loader as ModpackLoader;

  if (raw.format === "modrinth") {
    const mods: ModpackModEntry[] = raw.modrinth_files.map((f) => ({
      filename: f.path.split("/").pop() || f.path,
      url: f.url,
      sha1: f.sha1,
      source: "modrinth",
    }));
    return {
      format: "modrinth",
      packName: raw.pack_name,
      packVersion: raw.pack_version,
      mcVersion: raw.mc_version,
      loader,
      loaderVersion: raw.loader_version,
      mods,
      unresolvedMods: [],
      overridesFolders: raw.overrides_folders,
      zipPath,
    };
  }

  if (!CURSEFORGE_IMPORT_ENABLED) {
    throw new Error(
      "Import de modpacks da CurseForge ainda não está disponível (aguardando aprovação de acesso à API deles). Por enquanto, use um pacote .mrpack do Modrinth."
    );
  }

  const { resolved, unresolved } = await resolveCurseForgeFiles(raw.curseforge_files);
  return {
    format: "curseforge",
    packName: raw.pack_name,
    packVersion: raw.pack_version,
    mcVersion: raw.mc_version,
    loader,
    loaderVersion: raw.loader_version,
    mods: resolved,
    unresolvedMods: unresolved,
    overridesFolders: raw.overrides_folders,
    zipPath,
  };
}

export interface ModpackInstallProgress {
  status: string;
  percent: number;
}

/** Encaixa o progresso 0-100 de uma etapa interna dentro de uma faixa [start, end] do progresso geral. */
function subProgress(
  onProgress: (p: ModpackInstallProgress) => void,
  start: number,
  end: number
): (p: ServerInstallProgress) => void {
  return (inner) => {
    onProgress({ status: inner.status, percent: Math.round(start + (inner.percent / 100) * (end - start)) });
  };
}

/**
 * Instala um servidor completo a partir de um modpack já parseado: loader,
 * mods e overrides. Segue o mesmo padrão dos install*Server em server.ts —
 * em qualquer erro, apaga a pasta parcial em vez de deixá-la pela metade.
 */
export async function installModpack(
  serverName: string,
  parsed: ParsedModpack,
  ramGb: number,
  onProgress: (p: ModpackInstallProgress) => void
): Promise<void> {
  const docsDir = await documentDir();
  const serverPath = await join(docsDir, "CubicaseServers", serverName);
  if (await exists(serverPath)) {
    throw new Error(`Já existe um servidor com o nome "${serverName}".`);
  }

  try {
    onProgress({ status: "Instalando mod loader...", percent: 2 });
    if (parsed.loader === "forge" || parsed.loader === "neoforge") {
      await installForgeServer(
        serverName,
        parsed.mcVersion,
        parsed.loaderVersion,
        parsed.loader,
        ramGb,
        subProgress(onProgress, 2, 40),
        { strict: true }
      );
    } else {
      await installFabricServer(serverName, parsed.mcVersion, parsed.loaderVersion, ramGb, subProgress(onProgress, 2, 40));
    }

    const registry = await readModInstallRegistry(serverPath);
    const total = parsed.mods.length;
    for (let i = 0; i < total; i++) {
      const mod = parsed.mods[i];
      onProgress({
        status: `Baixando ${mod.filename} (${i + 1}/${total})...`,
        percent: 40 + Math.round((i / Math.max(total, 1)) * 45),
      });
      const destPath = await join(serverPath, "mods", mod.filename);
      await invoke("download_server_jar", { url: mod.url, destPath, expectedSha1: mod.sha1, expectedSha256: null });
      registry[mod.filename] = {
        source: mod.source,
        installedViaModpack: parsed.packName,
        projectId: mod.projectId,
        fileOrVersionId: mod.fileOrVersionId,
      };
    }
    await writeModInstallRegistry(serverPath, registry);

    if (parsed.overridesFolders.length > 0) {
      onProgress({ status: "Extraindo arquivos adicionais do modpack...", percent: 88 });
      for (const folder of parsed.overridesFolders) {
        await invoke("extract_modpack_overrides", { zipPath: parsed.zipPath, destDir: serverPath, overridesFolder: folder });
      }
    }

    onProgress({ status: "Finalizando...", percent: 96 });
    const metaPath = await join(serverPath, "cubicase-meta.json");
    try {
      const meta = JSON.parse(await readTextFile(metaPath));
      meta.description = parsed.packVersion ? `Modpack: ${parsed.packName} (${parsed.packVersion})` : `Modpack: ${parsed.packName}`;
      meta.motd = `Servidor Cubicase [${parsed.packName}] - ${serverName}`;
      await writeTextFile(metaPath, JSON.stringify(meta, null, 2));
    } catch {
      // Não crítico — o servidor já está funcional mesmo sem essa personalização.
    }

    onProgress({ status: "Modpack importado com sucesso!", percent: 100 });
  } catch (err) {
    await remove(serverPath, { recursive: true }).catch(() => {});
    throw err;
  }
}
