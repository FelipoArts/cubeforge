import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";

// ============================================================
// Modrinth — busca, checagem de compatibilidade e instalação de mods/plugins
// ============================================================
// Todas as chamadas de leitura (busca, versões, detalhes de projeto) vão
// direto do frontend via @tauri-apps/plugin-http, seguindo o mesmo padrão
// usado para a Fabric Meta API e a API da PaperMC em src/lib/server.ts. O
// download do arquivo em si reaproveita o comando Rust "download_server_jar"
// (já genérico: url, destPath, expectedSha1, expectedSha256), do mesmo jeito
// que os installers do Forge e as builds do Paper já fazem.
// ============================================================

const MODRINTH_API = "https://api.modrinth.com/v2";

/**
 * User-Agent no formato pedido pelas diretrizes da Modrinth
 * (usuario/projeto/versao (contato)) — requests sem um User-Agent
 * identificável podem ser limitados com mais agressividade.
 */
const MODRINTH_USER_AGENT = "FelipoArts/CubeForge/1.0 (+https://cubeforge.dev; contato: suporte@cubeforge.dev)";

const MODRINTH_CACHE_TTL = 5 * 60 * 1000; // 5 min

export interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  icon_url: string | null;
  downloads: number;
  project_type: "mod" | "plugin" | "resourcepack" | "shader" | "datapack";
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[];
  total_hits: number;
}

export interface ModrinthDependency {
  project_id: string | null;
  version_id: string | null;
  dependency_type: "required" | "optional" | "incompatible" | "embedded";
}

export interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
  hashes: { sha1?: string; sha512?: string };
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  version_number: string;
  name: string;
  game_versions: string[];
  loaders: string[];
  dependencies: ModrinthDependency[];
  files: ModrinthVersionFile[];
}

export interface ModrinthLoaderInfo {
  projectType: "mod" | "plugin";
  loader: string;
}

const PLUGIN_LOADER_TYPES = new Set(["paper", "spigot", "purpur", "bukkit"]);
const MOD_LOADER_TYPES = new Set(["forge", "neoforge", "fabric"]);

/**
 * Mapeia o serverType do CubeForge (mesmo conjunto usado em ServerManagePanel.tsx
 * para decidir a pasta "mods" vs "plugins") para o project_type + loader que a
 * API da Modrinth espera. Retorna null para tipos sem suporte a mods/plugins
 * (vanilla) — nesses casos o navegador de mods não deve ser exibido.
 */
export function loaderForServerType(serverType: string): ModrinthLoaderInfo | null {
  if (MOD_LOADER_TYPES.has(serverType)) return { projectType: "mod", loader: serverType };
  if (PLUGIN_LOADER_TYPES.has(serverType)) return { projectType: "plugin", loader: serverType };
  return null;
}

async function modrinthFetch(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": MODRINTH_USER_AGENT }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/**
 * Checa conectividade com a Modrinth com timeout curto, para diferenciar
 * "sem resultados" de "sem internet" na UI (ver checkModrinthReachable em
 * ModBrowserModal.tsx). Mesmo padrão de AbortController+timeout já usado em
 * NeoForgeProviderImpl.fetchVersions (server.ts).
 */
export async function checkModrinthReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${MODRINTH_API}/tag/loader`, {
      headers: { "User-Agent": MODRINTH_USER_AGENT },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const searchCache: Map<string, { hits: ModrinthSearchHit[]; totalHits: number; fetchedAt: number }> = new Map();

/**
 * Busca projetos na Modrinth já filtrados por versão do Minecraft e loader do
 * servidor via facets — resultados incompatíveis nem chegam a aparecer na
 * lista, então a maior parte da checagem de compatibilidade acontece aqui,
 * de graça.
 */
export async function searchModrinthProjects(
  query: string,
  opts: { mcVersion: string; serverType: string; offset?: number }
): Promise<{ hits: ModrinthSearchHit[]; totalHits: number }> {
  const loaderInfo = loaderForServerType(opts.serverType);
  if (!loaderInfo) return { hits: [], totalHits: 0 };

  const offset = opts.offset ?? 0;
  const cacheKey = `${query}|${opts.mcVersion}|${opts.serverType}|${offset}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MODRINTH_CACHE_TTL) {
    return { hits: cached.hits, totalHits: cached.totalHits };
  }

  const facets = JSON.stringify([
    [`project_type:${loaderInfo.projectType}`],
    [`versions:${opts.mcVersion}`],
    [`categories:${loaderInfo.loader}`],
  ]);
  const url = `${MODRINTH_API}/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&limit=20&offset=${offset}`;
  const res = await modrinthFetch(url);
  const data = (await res.json()) as ModrinthSearchResponse;
  searchCache.set(cacheKey, { hits: data.hits, totalHits: data.total_hits, fetchedAt: Date.now() });
  return { hits: data.hits, totalHits: data.total_hits };
}

const versionsCache: Map<string, { versions: ModrinthVersion[]; fetchedAt: number }> = new Map();

/** Lista as versões de um projeto já filtradas por versão do MC + loader do servidor. */
export async function getCompatibleVersions(
  projectId: string,
  mcVersion: string,
  serverType: string
): Promise<ModrinthVersion[]> {
  const loaderInfo = loaderForServerType(serverType);
  if (!loaderInfo) return [];

  const cacheKey = `${projectId}|${mcVersion}|${loaderInfo.loader}`;
  const cached = versionsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MODRINTH_CACHE_TTL) return cached.versions;

  const gameVersions = encodeURIComponent(JSON.stringify([mcVersion]));
  const loaders = encodeURIComponent(JSON.stringify([loaderInfo.loader]));
  const url = `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?game_versions=${gameVersions}&loaders=${loaders}`;
  const res = await modrinthFetch(url);
  const versions = (await res.json()) as ModrinthVersion[];
  versionsCache.set(cacheKey, { versions, fetchedAt: Date.now() });
  return versions;
}

const projectTitleCache: Map<string, { title: string; fetchedAt: number }> = new Map();

/** Busca o título legível de um projeto pelo id (usado para nomear dependências faltando). */
export async function getModrinthProjectTitle(projectId: string): Promise<string> {
  const cached = projectTitleCache.get(projectId);
  if (cached && Date.now() - cached.fetchedAt < MODRINTH_CACHE_TTL) return cached.title;
  try {
    const res = await modrinthFetch(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}`);
    const data = (await res.json()) as { title: string };
    projectTitleCache.set(projectId, { title: data.title, fetchedAt: Date.now() });
    return data.title;
  } catch {
    return projectId;
  }
}

// ------------------------------------------------------------
// Registro de proveniência (cubeforge-mods.json)
// ------------------------------------------------------------
// Arquivo próprio por servidor (ao lado de cubicase-meta.json) que só
// registra mods instalados por este navegador — não tenta inferir
// dependências de .jar colocados manualmente. Serve para a checagem de
// dependência "já instalado?" e para uma futura verificação de atualização.

export interface ModInstallRecord {
  projectId: string;
  versionId: string;
  projectTitle: string;
  versionNumber: string;
  requiredDependencyProjectIds: string[];
}

/**
 * Registro mais enxuto para mods que vieram de um import de modpack (ver
 * src/lib/modpackImport.ts) — nem sempre há um projectId/versionId no
 * formato do Modrinth disponível (o .mrpack só garante URL+hash por arquivo,
 * sem IDs de projeto), então esses campos ficam opcionais.
 */
export interface ModpackInstallRecord {
  source: "curseforge" | "modrinth";
  installedViaModpack: string;
  projectId?: number | string;
  fileOrVersionId?: number | string;
}

/** Registro de mods instalados via Modrinth (busca manual) ou via import de modpack, indexado pelo nome do arquivo .jar. */
export type ModInstallRegistry = Record<string, ModInstallRecord | ModpackInstallRecord>;

export async function readModInstallRegistry(serverDir: string): Promise<ModInstallRegistry> {
  const path = await join(serverDir, "cubeforge-mods.json");
  if (!(await exists(path))) return {};
  try {
    return JSON.parse(await readTextFile(path)) as ModInstallRegistry;
  } catch {
    return {};
  }
}

export async function writeModInstallRegistry(serverDir: string, registry: ModInstallRegistry): Promise<void> {
  const path = await join(serverDir, "cubeforge-mods.json");
  await writeTextFile(path, JSON.stringify(registry, null, 2));
}

export interface MissingDependency {
  projectId: string;
  title: string;
}

/**
 * Cruza as dependências obrigatórias da versão escolhida contra o registro
 * local de instalações feitas por este navegador. Limitação conhecida: mods
 * colocados manualmente na pasta não entram nesse registro, então podem
 * aparecer aqui como "faltando" mesmo já estando presentes — por isso a UI
 * trata isso como "não detectado", não como certeza de ausência.
 */
export async function resolveRequiredDependencies(
  version: ModrinthVersion,
  serverDir: string
): Promise<MissingDependency[]> {
  const required = version.dependencies.filter(
    (d): d is ModrinthDependency & { project_id: string } => d.dependency_type === "required" && !!d.project_id
  );
  if (required.length === 0) return [];

  const registry = await readModInstallRegistry(serverDir);
  const installedProjectIds = new Set(Object.values(registry).map((r) => r.projectId));
  const missing = required.filter((d) => !installedProjectIds.has(d.project_id));

  return Promise.all(
    missing.map(async (d) => ({
      projectId: d.project_id,
      title: await getModrinthProjectTitle(d.project_id),
    }))
  );
}

export interface ModrinthInstallProgress {
  status: string;
  percent: number;
}

/**
 * Baixa o arquivo primário de uma versão para a pasta mods/plugins do
 * servidor (reaproveitando o comando Rust "download_server_jar", que já faz
 * retry, verificação de checksum e cria o diretório de destino se preciso) e
 * grava a proveniência no registro local.
 */
export async function installModrinthFile(
  version: ModrinthVersion,
  projectTitle: string,
  serverDir: string,
  itemsFolder: string,
  onProgress: (p: ModrinthInstallProgress) => void
): Promise<void> {
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) throw new Error("Esta versão não possui nenhum arquivo para download.");

  onProgress({ status: `Baixando ${file.filename}...`, percent: 20 });
  const destPath = await join(serverDir, itemsFolder, file.filename);
  await invoke("download_server_jar", {
    url: file.url,
    destPath,
    expectedSha1: file.hashes.sha1 ?? null,
    expectedSha256: null,
  });
  onProgress({ status: "Download concluído.", percent: 80 });

  const registry = await readModInstallRegistry(serverDir);
  registry[file.filename] = {
    projectId: version.project_id,
    versionId: version.id,
    projectTitle,
    versionNumber: version.version_number,
    requiredDependencyProjectIds: version.dependencies
      .filter((d) => d.dependency_type === "required" && !!d.project_id)
      .map((d) => d.project_id as string),
  };
  await writeModInstallRegistry(serverDir, registry);
  onProgress({ status: "Mod instalado.", percent: 100 });
}
