import { invoke } from "@tauri-apps/api/core";
import { join, documentDir } from "@tauri-apps/api/path";
import { exists, mkdir, writeTextFile, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";

// ============================================================
// Tipos exportados
// ============================================================

export interface ServerInfo {
  /** Nome do servidor (nome da pasta) */
  name: string;
  /** Caminho absoluto da pasta do servidor */
  path: string;
  /** Versão do Minecraft instalada (lida do server.properties) */
  version: string | null;
  /** UUID único e permanente do servidor (gerado na criação, nunca muda) */
  uuid: string | null;
  /** Código curto de convite (6 caracteres, gerado na criação, nunca muda) */
  shortCode: string | null;
  /** Tipo do servidor (vanilla, forge, fabric, paper) */
  serverType: string;
  /** Descrição personalizada do servidor */
  description: string;
  /** Versão do schema do cubeforge-meta.json */
  schemaVersion: number;
}

export interface ServerInstallProgress {
  status: string;
  percent: number;
}

export interface MinecraftVersionInfo {
  id: string;
  type: string;
  releaseTime: string;
}

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: MinecraftVersionInfo[];
}

// ============================================================
// Cache do Manifest da Mojang (em memória)
// ============================================================

let cachedManifest: VersionManifest | null = null;
let manifestFetchPromise: Promise<VersionManifest> | null = null;

/**
 * Consulta o manifest oficial de versões da Mojang.
 * Utiliza cache em memória para evitar fetch repetido durante a sessão.
 * Se o fetch falhar, retorna um manifest fallback com versões populares.
 */
export async function fetchVersionManifest(): Promise<VersionManifest> {
  if (cachedManifest) return cachedManifest;

  if (!manifestFetchPromise) {
    manifestFetchPromise = (async () => {
      try {
        const res = await fetch(
          "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as VersionManifest;
        cachedManifest = data;
        return data;
      } catch (err) {
        console.warn("Falha ao buscar manifest da Mojang, usando fallback:", err);
        // Fallback: construir um manifest mínimo com versões populares
        const fallback: VersionManifest = {
          latest: { release: "1.20.1", snapshot: "1.20.1" },
          versions: [
            ...POPULAR_VERSIONS.map(id => ({
              id,
              type: "release",
              releaseTime: new Date().toISOString(),
            })),
            ...CURATED_RECOMMENDED.map(id => ({
              id,
              type: "release",
              releaseTime: new Date().toISOString(),
            })),
          ],
        };
        // Deduplicar
        const seen = new Set<string>();
        fallback.versions = fallback.versions.filter(v => {
          if (seen.has(v.id)) return false;
          seen.add(v.id);
          return true;
        });
        cachedManifest = fallback;
        return fallback;
      }
    })();
  }

  return manifestFetchPromise;
}

// ============================================================
// Versões Recomendadas (curadoria manual + latest)
// ============================================================

/**
 * Lista de versões recomendadas além da latest.
 * A última release (latest.release) é sempre incluída como primeira opção.
 * Esta lista pode ser atualizada conforme o ecossistema do Minecraft evolui.
 */
export const CURATED_RECOMMENDED = [
  "1.21.1",
  "1.20.4",
  "1.20.1",
] as const;

/**
 * Retorna as versões recomendadas: latest.release + CURATED_RECOMMENDED,
 * deduplicado e na ordem correta.
 */
export function getRecommendedVersions(manifest: VersionManifest): string[] {
  const result: string[] = [manifest.latest.release];
  for (const v of CURATED_RECOMMENDED) {
    if (v !== manifest.latest.release) {
      result.push(v);
    }
  }
  return result;
}

// ============================================================
// Versões Populares (hardcoded)
// ============================================================

export const POPULAR_VERSIONS = [
  "1.20.1",
  "1.16.5",
  "1.12.2",
  "1.8.9",
] as const;

export function getPopularVersions(): string[] {
  return [...POPULAR_VERSIONS];
}

// ============================================================
// Filtro de versões mínimas
// ============================================================

/**
 * Versão mínima suportada pelo CubeForge.
 * Tudo abaixo disso é filtrado do manifest.
 */
const MINIMUM_VERSION = "1.8.9";

/**
 * Compara duas versões do Minecraft no formato "X.Y.Z" ou "X.Y".
 * Retorna true se `version >= minimum`.
 *
 * Exemplos:
 *   "1.8.9"  >= "1.8.9"  → true
 *   "1.8.8"  >= "1.8.9"  → false
 *   "1.16.5" >= "1.8.9"  → true
 *   "26.2"   >= "1.8.9"  → true
 */
function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string): number[] => v.split(".").map(Number);
  const a = parse(version);
  const b = parse(minimum);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const na = a[i] ?? 0;
    const nb = b[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return true; // iguais
}

function isSupportedVersion(versionId: string): boolean {
  return isVersionAtLeast(versionId, MINIMUM_VERSION);
}

// ============================================================
// Todas as Versões (do manifest)
// ============================================================

/**
 * Retorna todas as versões do tipo "release" do manifest,
 * ordenadas da mais recente para a mais antiga.
 * Versões anteriores à 1.8.9 são filtradas.
 */
export function getAllReleaseVersions(manifest: VersionManifest): string[] {
  return manifest.versions
    .filter(v => v.type === "release" && isSupportedVersion(v.id))
    .sort((a, b) => b.releaseTime.localeCompare(a.releaseTime))
    .map(v => v.id);
}

/**
 * Filtra versões por texto (case-insensitive).
 * Busca tanto no id da versão quanto no tipo.
 * Versões anteriores à 1.8.9 são filtradas.
 */
export function searchVersions(manifest: VersionManifest, query: string): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return getAllReleaseVersions(manifest);

  return manifest.versions
    .filter(v => v.type === "release" && isSupportedVersion(v.id) && v.id.toLowerCase().includes(q))
    .sort((a, b) => b.releaseTime.localeCompare(a.releaseTime))
    .map(v => v.id);
}

// ============================================================
// Mapa Java x Versão Minecraft
// ============================================================

/**
 * Versões de JRE suportadas pelo CubeForge.
 * Atualizar conforme novas versões do Minecraft exigirem Java mais novo.
 */
export type JREVersion = 8 | 17 | 21 | 25;

/**
 * Determina a versão do Java necessária para uma dada versão do Minecraft.
 *
 * Mapa conhecido:
 * - 1.17.x – 1.20.4 → Java 17
 * - 1.20.5 – 1.21.x → Java 21
 * - 1.16.x e anteriores → Java 8
 *
 * Para versões futuras desconhecidas (minor > 21), usamos Java 21
 * como padrão. Quando uma nova versão do Minecraft exigir Java mais
 * recente (ex: 1.26.x → Java 25), atualize este mapa.
 */
export function getJavaVersion(mcVersion: string): JREVersion {
  // Normalizar: extrair o "minor" (ex: "1.21.4" → minor=21, "26.2" → minor=26)
  const parts = mcVersion.split(".");
  
  let minor: number;
  if (parts[0] === "1") {
    // Formato clássico: "1.minor.patch" (ex: "1.21.4")
    minor = parseInt(parts[1] ?? "20", 10);
  } else {
    // Formato moderno: "major.minor" (ex: "26.2" — a Mojang mudou o esquema de versão)
    minor = parseInt(parts[0] ?? "20", 10);
  }

  // 1.25+ / 25+ (minor >= 25) → Java 25
  if (minor >= 25) return 25;
  // 1.21 – 1.24.x (minor entre 21 e 24) → Java 21
  if (minor >= 21) return 21;
  // 1.17 – 1.20.x (minor entre 17 e 20) → Java 17
  if (minor >= 17) return 17;
  // 1.16.x e anteriores (minor <= 16) → Java 8
  return 8;
}

// ============================================================
// Resolução de URL do server.jar via manifest oficial da Mojang
// ============================================================

/**
 * Consulta o manifest oficial da Mojang para encontrar o URL direto do
 * server.jar de uma versão específica.
 */
export async function getMinecraftServerUrl(version: string): Promise<string> {
  // 1. Buscar o índice de versões da Mojang
  const manifestRes = await fetch(
    "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
  );
  if (!manifestRes.ok) throw new Error("Falha ao baixar o manifest de versões da Mojang.");

  const manifest = await manifestRes.json() as {
    versions: Array<{ id: string; url: string }>;
  };

  // 2. Localizar a versão desejada
  const versionEntry = manifest.versions.find((v) => v.id === version);
  if (!versionEntry) throw new Error(`Versão ${version} não encontrada no manifest da Mojang.`);

  // 3. Buscar o JSON específico da versão para obter o link do server.jar
  const versionRes = await fetch(versionEntry.url);
  if (!versionRes.ok) throw new Error(`Falha ao baixar os detalhes da versão ${version}.`);

  const versionData = await versionRes.json() as {
    downloads: { server: { url: string } };
  };

  if (!versionData?.downloads?.server?.url) {
    throw new Error(`URL do server.jar não encontrada para a versão ${version}.`);
  }

  return versionData.downloads.server.url;
}

// ============================================================
// Instalação de um novo servidor
// ============================================================

/**
 * Instala um novo servidor Minecraft localmente.
 * - Cria a pasta do servidor
 * - Baixa o server.jar via Rust (sem PowerShell)
 * - Aceita a EULA automaticamente
 * - Gera server.properties com configurações seguras para rede mesh
 *
 * O mundo do Minecraft é gerado no PRIMEIRO boot, não aqui.
 * Isso torna a instalação quase instantânea.
 */
export async function installMinecraftServer(
  serverName: string,
  version: string,
  ramGb: number,
  onProgress: (p: ServerInstallProgress) => void
): Promise<void> {
  // --- Caminhos ---
  const docsDir = await documentDir();
  const serversRoot = await join(docsDir, "CubeForgeServers");
  const serverPath = await join(serversRoot, serverName);
  const jarPath = await join(serverPath, "server.jar");

  // --- Criar pasta ---
  onProgress({ status: "Criando pasta do servidor...", percent: 5 });
  if (!(await exists(serversRoot))) await mkdir(serversRoot, { recursive: true });
  if (await exists(serverPath)) throw new Error(`Já existe um servidor com o nome "${serverName}".`);
  await mkdir(serverPath, { recursive: true });

  // --- Resolver URL do server.jar ---
  onProgress({ status: "Consultando API da Mojang...", percent: 15 });
  const jarUrl = await getMinecraftServerUrl(version);

  // --- Baixar server.jar via Rust (reqwest, sem PowerShell) ---
  onProgress({ status: "Baixando server.jar...", percent: 25 });
  await invoke("download_server_jar", { url: jarUrl, destPath: jarPath });
  onProgress({ status: "Download concluído.", percent: 75 });

  // --- Aceitar EULA automaticamente ---
  onProgress({ status: "Aceitando EULA...", percent: 80 });
  const eulaPath = await join(serverPath, "eula.txt");
  await writeTextFile(eulaPath, "# Aceito automaticamente pelo CubeForge\neula=true\n");

  // --- Gerar server.properties ---
  onProgress({ status: "Gerando configurações...", percent: 88 });
  const propertiesPath = await join(serverPath, "server.properties");
  const properties = generateServerProperties(version, ramGb);
  await writeTextFile(propertiesPath, properties);

  // --- Gerar UUID permanente e short code para o servidor ---
  // UUID: identificador real do servidor (nunca muda, usado internamente)
  // shortCode: representação amigável de 6 caracteres (nunca muda, usado pelo usuário)
  const uuid = crypto.randomUUID();
  // Gera um código curto de 6 caracteres base36 (0-9, a-z)
  const shortCode = Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('').toUpperCase();

  // --- Salvar metadados do servidor ---
  const metaPath = await join(serverPath, "cubeforge-meta.json");
  await writeTextFile(metaPath, JSON.stringify({
    schemaVersion: 1,
    uuid,
    shortCode,
    name: serverName,
    version,
    serverType: "vanilla",
    description: "",
    ramGb,
    createdAt: new Date().toISOString(),
    // Campos preparados para futuras extensões (opcionais)
    iconPath: null,
    tags: [],
    motd: `Servidor CubeForge - ${serverName}`,
    lastPlayedAt: null,
  }, null, 2));

  onProgress({ status: "Servidor criado com sucesso!", percent: 100 });
}

/**
 * Gera o conteúdo do server.properties com configurações adequadas para
 * uso com o CubeForge: offline-mode e porta padrão 25565 local.
 */
function generateServerProperties(version: string, _ramGb: number): string {
  return [
    `# Gerado pelo CubeForge - versao ${version}`,
    `# Nao altere server-port manualmente; o CubeForge gerencia as portas.`,
    `online-mode=false`,
    `server-port=25565`,
    `max-players=20`,
    `view-distance=10`,
    `simulation-distance=10`,
    `difficulty=easy`,
    `gamemode=survival`,
    `enable-command-block=false`,
    `motd=Servidor CubeForge`,
    `spawn-protection=0`,
    `enforce-whitelist=false`,
    `white-list=false`,
  ].join("\n") + "\n";
}

// ============================================================
// Listagem de servidores locais
// ============================================================

/**
 * Varre a pasta de servidores e retorna a lista de servidores instalados.
 */
export async function listLocalServers(): Promise<ServerInfo[]> {
  const docsDir = await documentDir();
  const serversRoot = await join(docsDir, "CubeForgeServers");

  if (!(await exists(serversRoot))) return [];

  const entries = await readDir(serversRoot);
  const servers: ServerInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const serverPath = await join(serversRoot, entry.name);
    const jarPath = await join(serverPath, "server.jar");

    // Só inclui se tiver o server.jar (instalação completa)
    if (!(await exists(jarPath))) continue;

    // Lê os metadados do CubeForge (cubeforge-meta.json)
    let version: string | null = null;
    let uuid: string | null = null;
    let shortCode: string | null = null;
    let serverType = "vanilla";
    let description = "";
    let schemaVersion = 1;
    const metaPath = await join(serverPath, "cubeforge-meta.json");
    if (await exists(metaPath)) {
      try {
        const metaContent = await readTextFile(metaPath);
        const meta = JSON.parse(metaContent) as {
          version?: string;
          uuid?: string;
          shortCode?: string;
          serverType?: string;
          description?: string;
          schemaVersion?: number;
        };
        version = meta.version ?? null;
        uuid = meta.uuid ?? null;
        shortCode = meta.shortCode ?? null;
        serverType = meta.serverType ?? "vanilla";
        description = meta.description ?? "";
        schemaVersion = meta.schemaVersion ?? 1;
      } catch { /* ignora erros de parse */ }
    }

    // Fallback 1: tenta extrair a versão do comentário no server.properties
    if (!version) {
      const propsPath = await join(serverPath, "server.properties");
      if (await exists(propsPath)) {
        try {
          const propsContent = await readTextFile(propsPath);
          // Tenta vários padrões de comentário (com ou sem acento, maiúsculo/minúsculo)
          const patterns = [
            /^#\s*Gerado pelo CubeForge\s*[-–]\s*vers[ãa]o\s+([\d.]+)/mi,
            /^#\s*CubeForge\s+version\s+([\d.]+)/mi,
            /^#\s*vers[ãa]o\s+([\d.]+)/mi,
            /^#.*?(\d+\.\d+(?:\.\d+)?)/m,
          ];
          for (const pattern of patterns) {
            const match = propsContent.match(pattern);
            if (match) {
              version = match[1];
              break;
            }
          }
        } catch { /* ignora */ }
      }
    }

    // Fallback 2: tenta extrair a versão da pasta versions/ (criada pelo servidor na primeira execução)
    // Ex: versions/1.20.1/1.20.1.json
    if (!version) {
      try {
        const versionsPath = await join(serverPath, 'versions');
        if (await exists(versionsPath)) {
          const versionEntries = await readDir(versionsPath);
          for (const ve of versionEntries) {
            if (ve.isDirectory) {
              // O nome da subpasta é a versão (ex: "1.20.1")
              const verMatch = ve.name.match(/^\d+\.\d+(?:\.\d+)?$/);
              if (verMatch) {
                version = verMatch[0];
                break;
              }
            }
          }
        }
      } catch { /* ignora */ }
    }

    // Fallback 3: tenta extrair a versão do nome de arquivos .jar na pasta
    if (!version) {
      try {
        const dirEntries = await readDir(serverPath);
        for (const dirEntry of dirEntries) {
          if (!dirEntry.isDirectory && dirEntry.name.endsWith('.jar')) {
            const jarMatch = dirEntry.name.match(/(\d+\.\d+(?:\.\d+)?)/);
            if (jarMatch) {
              version = jarMatch[1];
              break;
            }
          }
        }
      } catch { /* ignora */ }
    }

    servers.push({ name: entry.name, path: serverPath, version, uuid, shortCode, serverType, description, schemaVersion });
  }

  return servers;
}
