import { invoke } from "@tauri-apps/api/core";
import { join, documentDir } from "@tauri-apps/api/path";
import { exists, mkdir, writeTextFile, readDir, readTextFile, remove } from "@tauri-apps/plugin-fs";
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
  /** Versão do schema do cubicase-meta.json */
  schemaVersion: number;
  /** Indica se o EULA do Minecraft foi aceito (eula=true no eula.txt) */
  eulaAccepted: boolean;
  /** Nome do JAR principal (ex: "server.jar", "forge-1.20.1-47.1.0-shim.jar") */
  serverJar: string | null;
  /** Pasta (relativa à raiz do servidor) com win_args.txt/unix_args.txt, para Forge/NeoForge modernos (1.17+) que não geram um JAR único */
  launchArgsDir: string | null;
  /** Versão do Forge/NeoForge instalada (ex: "47.1.0"), null para servidores Vanilla */
  forgeVersion: string | null;
  /** Versão do mod loader para Fabric (ex: "0.19.3") ou número da build para Paper (ex: "2"). Null para os demais tipos. */
  modLoaderVersion: string | null;
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
 * Versão mínima suportada pelo Cubicase.
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
 * Versões de JRE suportadas pelo Cubicase.
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
export interface MinecraftServerDownloadInfo {
  url: string;
  /** SHA1 oficial do server.jar publicado pela Mojang — usado para verificar integridade do download. */
  sha1: string | null;
}

export async function getMinecraftServerUrl(version: string): Promise<MinecraftServerDownloadInfo> {
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
    downloads: { server: { url: string; sha1?: string } };
  };

  if (!versionData?.downloads?.server?.url) {
    throw new Error(`URL do server.jar não encontrada para a versão ${version}.`);
  }

  return {
    url: versionData.downloads.server.url,
    sha1: versionData.downloads.server.sha1 ?? null,
  };
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
  const serversRoot = await join(docsDir, "CubicaseServers");
  const serverPath = await join(serversRoot, serverName);
  const jarPath = await join(serverPath, "server.jar");

  // --- Criar pasta ---
  onProgress({ status: "Criando pasta do servidor...", percent: 5 });
  if (!(await exists(serversRoot))) await mkdir(serversRoot, { recursive: true });
  if (await exists(serverPath)) throw new Error(`Já existe um servidor com o nome "${serverName}".`);
  await mkdir(serverPath, { recursive: true });

  // A partir daqui a pasta do servidor já existe — se qualquer etapa falhar,
  // apagamos a pasta parcial em vez de deixá-la pela metade bloqueando uma
  // nova tentativa com o mesmo nome (que antes só via "já existe um servidor").
  try {
    // --- Resolver URL do server.jar ---
    onProgress({ status: "Consultando API da Mojang...", percent: 15 });
    const { url: jarUrl, sha1: jarSha1 } = await getMinecraftServerUrl(version);

    // --- Baixar server.jar via Rust (reqwest, sem PowerShell) ---
    // O Rust já retenta com backoff e verifica o SHA1 contra o manifest oficial,
    // apagando o arquivo se vier corrompido/truncado.
    onProgress({ status: "Baixando server.jar...", percent: 25 });
    await invoke("download_server_jar", { url: jarUrl, destPath: jarPath, expectedSha1: jarSha1 });
    onProgress({ status: "Download concluído.", percent: 75 });

    // --- Aceitar EULA automaticamente ---
    onProgress({ status: "Aceitando EULA...", percent: 80 });
    const eulaPath = await join(serverPath, "eula.txt");
    await writeTextFile(eulaPath, "# Aceito automaticamente pelo Cubicase\neula=true\n");

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
    const metaPath = await join(serverPath, "cubicase-meta.json");
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
      motd: `Servidor Cubicase - ${serverName}`,
      lastPlayedAt: null,
    }, null, 2));

    onProgress({ status: "Servidor criado com sucesso!", percent: 100 });
  } catch (err) {
    await remove(serverPath, { recursive: true }).catch(() => {});
    throw err;
  }
}

/**
 * Gera o conteúdo do server.properties com configurações adequadas para
 * uso com o Cubicase: offline-mode e porta padrão 25565 local.
 */
function generateServerProperties(version: string, _ramGb: number): string {
  return [
    `# Gerado pelo Cubicase - versao ${version}`,
    `# Nao altere server-port manualmente; o Cubicase gerencia as portas.`,
    `online-mode=false`,
    `server-port=25565`,
    `max-players=20`,
    `view-distance=10`,
    `simulation-distance=10`,
    `difficulty=easy`,
    `gamemode=survival`,
    `enable-command-block=false`,
    `motd=Servidor Cubicase`,
    `spawn-protection=0`,
    `enforce-whitelist=false`,
    `white-list=false`,
  ].join("\n") + "\n";
}

// ============================================================
// Listagem de servidores locais
// ============================================================

/**
 * Detecta a versão do Minecraft em uma pasta de servidor.
 * Usa múltiplas estratégias de fallback:
 * 1. cubicase-meta.json
 * 2. Comentário no server.properties
 * 3. Pasta versions/
 * 4. Nome de arquivos .jar
 */
export async function detectServerVersion(serverPath: string): Promise<string | null> {
  // Estratégia 1: cubicase-meta.json
  const metaPath = await join(serverPath, "cubicase-meta.json");
  if (await exists(metaPath)) {
    try {
      const metaContent = await readTextFile(metaPath);
      const meta = JSON.parse(metaContent) as { version?: string };
      if (meta.version) return meta.version;
    } catch { /* ignora */ }
  }

  // Estratégia 2: Comentário no server.properties
  const propsPath = await join(serverPath, "server.properties");
  if (await exists(propsPath)) {
    try {
      const propsContent = await readTextFile(propsPath);
      const patterns = [
        /^#\s*Gerado pelo Cubicase\s*[-–]\s*vers[ãa]o\s+([\d.]+)/mi,
        /^#\s*Cubicase\s+version\s+([\d.]+)/mi,
        /^#\s*vers[ãa]o\s+([\d.]+)/mi,
        /^#.*?(\d+\.\d+(?:\.\d+)?)/m,
      ];
      for (const pattern of patterns) {
        const match = propsContent.match(pattern);
        if (match) return match[1];
      }
    } catch { /* ignora */ }
  }

  // Estratégia 3: Pasta versions/
  try {
    const versionsPath = await join(serverPath, 'versions');
    if (await exists(versionsPath)) {
      const versionEntries = await readDir(versionsPath);
      for (const ve of versionEntries) {
        if (ve.isDirectory) {
          const verMatch = ve.name.match(/^\d+\.\d+(?:\.\d+)?$/);
          if (verMatch) return verMatch[0];
        }
      }
    }
  } catch { /* ignora */ }

  // Estratégia 4: Nome de arquivos .jar
  try {
    const dirEntries = await readDir(serverPath);
    for (const dirEntry of dirEntries) {
      if (!dirEntry.isDirectory && dirEntry.name.endsWith('.jar')) {
        const jarMatch = dirEntry.name.match(/(\d+\.\d+(?:\.\d+)?)/);
        if (jarMatch) return jarMatch[1];
      }
    }
  } catch { /* ignora */ }

  return null;
}

/**
 * Detecta o tipo do servidor Minecraft baseado nos arquivos presentes.
 */
export async function detectServerType(serverPath: string): Promise<string> {
  // Verificar presença de loaders/modloaders específicos
  const markers: [string, string][] = [
    ['forge', 'forge-*.jar'],
    ['fabric-server-launch.jar', 'fabric'],
    ['paper-*.jar', 'paper'],
    ['purpur-*.jar', 'purpur'],
    ['spigot-*.jar', 'spigot'],
    ['bukkit-*.jar', 'bukkit'],
  ];

  try {
    const entries = await readDir(serverPath);
    const fileNames = entries.map(e => e.name.toLowerCase());

    // Papel/Pufferfish/Purpur/Spigot/Bukkit (baseados em Paper)
    if (fileNames.some(n => n.startsWith('purpur-'))) return 'purpur';
    if (fileNames.some(n => n.startsWith('paper-'))) return 'paper';
    if (fileNames.some(n => n.startsWith('spigot-'))) return 'spigot';
    if (fileNames.some(n => n.startsWith('bukkit-'))) return 'bukkit';

    // Fabric
    if (fileNames.some(n => n.startsWith('fabric-server-launch'))) return 'fabric';

    // Forge (pela pasta mods ou pelo jar)
    if (await exists(await join(serverPath, 'mods'))) {
      const modsDir = await readDir(await join(serverPath, 'mods'));
      if (modsDir.some(e => e.name.toLowerCase().includes('forge'))) return 'forge';
    }
    if (fileNames.some(n => n.startsWith('forge-'))) return 'forge';
  } catch { /* ignora */ }

  return 'vanilla';
}

// ============================================================
// Instalação de servidor Forge
// ============================================================

/** Resultado da detecção pós-instalação do Forge/NeoForge. */
interface ForgeLaunchInfo {
  mode: 'jar' | 'argfile';
  /** Nome do JAR (modo 'jar') */
  jarName?: string;
  /** Pasta relativa (com '/') contendo win_args.txt/unix_args.txt (modo 'argfile') */
  argsDir?: string;
}

/**
 * Procura por win_args.txt/unix_args.txt sob `libraries/` (Forge/NeoForge 1.17+).
 * Esses modloaders modernos não geram mais um JAR único: o servidor é iniciado via
 * `java @user_jvm_args.txt @libraries/.../win_args.txt` (ver run.bat/run.sh gerados pelo instalador).
 */
async function findForgeArgsDir(serverPath: string): Promise<string | null> {
  const librariesPath = await join(serverPath, "libraries");
  if (!(await exists(librariesPath))) return null;

  async function scan(dirPath: string, relPath: string, depth: number): Promise<string | null> {
    if (depth > 8) return null;
    let entries;
    try {
      entries = await readDir(dirPath);
    } catch {
      return null;
    }
    const hasArgsFile = entries.some(
      e => !e.isDirectory && (e.name === 'win_args.txt' || e.name === 'unix_args.txt')
    );
    if (hasArgsFile) return relPath;
    for (const e of entries) {
      if (e.isDirectory) {
        const found = await scan(`${dirPath}\\${e.name}`, `${relPath}/${e.name}`, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return scan(librariesPath, "libraries", 0);
}

/**
 * Detecta como iniciar o servidor Forge/NeoForge recém-instalado.
 * - Versões modernas (1.17+): não há JAR único, apenas `libraries/.../win_args.txt` + `user_jvm_args.txt`
 * - Versões antigas (≤1.16): procura por shim.jar, universal.jar, ou qualquer forge-*.jar
 */
async function detectForgeJar(serverPath: string): Promise<ForgeLaunchInfo | null> {
  // Layout moderno: user_jvm_args.txt na raiz + args file em libraries/
  const userJvmArgsPath = await join(serverPath, "user_jvm_args.txt");
  if (await exists(userJvmArgsPath)) {
    const argsDir = await findForgeArgsDir(serverPath);
    if (argsDir) {
      console.log(`[detectForgeJar] Layout moderno detectado. argsDir=${argsDir}`);
      return { mode: 'argfile', argsDir };
    }
  }

  const allJars: string[] = [];

  async function scanJars(dirPath: string, depth: number) {
    if (depth > 2) return; // Só 2 níveis de profundidade
    try {
      const entries = await readDir(dirPath);
      for (const e of entries) {
        if (e.isDirectory && depth < 2) {
          await scanJars(`${dirPath}\\${e.name}`, depth + 1);
        } else if (!e.isDirectory && e.name.endsWith('.jar') && !e.name.includes('installer')) {
          allJars.push(e.name);
        }
      }
    } catch { /* ignora */ }
  }

  await scanJars(serverPath, 0);

  console.log(`[detectForgeJar] ${allJars.length} jars (não-installer) encontrados:`, allJars);

  if (allJars.length === 0) {
    // Verificar se existe algum .jar (mesmo installer) para diagnóstico
    try {
      const rawEntries = await readDir(serverPath);
      const rawJars = rawEntries.filter(e => !e.isDirectory && e.name.endsWith('.jar'));
      console.warn(`[detectForgeJar] NENHUM jar não-installer encontrado. Todos os jars:`, rawJars.map(e => e.name));
    } catch { /* ignora */ }
    return null;
  }

  // Prioridade 1: forge-*-shim.jar
  for (const name of allJars) {
    if (name.includes('-shim.jar')) return { mode: 'jar', jarName: name };
  }

  // Prioridade 2: forge-*-universal.jar
  for (const name of allJars) {
    if (name.includes('-universal.jar')) return { mode: 'jar', jarName: name };
  }

  // Prioridade 3: neoforge (próprio installer é o server jar)
  for (const name of allJars) {
    if (name.startsWith('neoforge-')) return { mode: 'jar', jarName: name };
  }

  // Prioridade 4: forge-*.jar (qualquer um, menos installer já filtrado)
  for (const name of allJars) {
    if (name.startsWith('forge-')) return { mode: 'jar', jarName: name };
  }

  // Prioridade 5: minecraft_server.*.jar
  for (const name of allJars) {
    if (name.startsWith('minecraft_server.')) return { mode: 'jar', jarName: name };
  }

  // Prioridade 6: fmlcore (Forge Mod Loader core)
  for (const name of allJars) {
    if (name.startsWith('fmlcore-')) return { mode: 'jar', jarName: name };
  }

  // Prioridade 7: qualquer jar que NÃO seja installer (fallback final)
  if (allJars.length === 1) return { mode: 'jar', jarName: allJars[0] };

  console.warn(`[detectForgeJar] Nenhum padrão específico encontrado entre ${allJars.length} jars.`);
  return null;
}

/**
 * Instala um servidor Forge/NeoForge localmente.
 * 1. Cria a pasta do servidor
 * 2. Confirma que o instalador da build escolhida existe (HEAD); se não existir,
 *    busca a lista de versões de novo e tenta a build mais recente disponível
 * 3. Baixa o installer.jar via Rust
 * 4. Executa java -jar installer.jar --installServer (headless)
 * 5. Detecta o JAR gerado
 * 6. Aceita EULA, gera server.properties
 * 7. Salva cubicase-meta.json com serverType: "forge"/"neoforge" e serverJar
 */
export async function installForgeServer(
  serverName: string,
  mcVersion: string,
  forgeVersion: string,
  providerName: 'forge' | 'neoforge',
  ramGb: number,
  onProgress: (p: ServerInstallProgress) => void,
  opts?: { strict?: boolean }
): Promise<void> {
  const docsDir = await documentDir();
  const serversRoot = await join(docsDir, "CubicaseServers");
  const serverPath = await join(serversRoot, serverName);

  // 1. Criar pasta
  onProgress({ status: "Criando pasta do servidor...", percent: 5 });
  if (!(await exists(serversRoot))) await mkdir(serversRoot, { recursive: true });
  if (await exists(serverPath)) throw new Error(`Já existe um servidor com o nome "${serverName}".`);
  await mkdir(serverPath, { recursive: true });

  // A partir daqui a pasta do servidor já existe — se qualquer etapa falhar,
  // apagamos a pasta parcial em vez de deixá-la pela metade bloqueando uma
  // nova tentativa com o mesmo nome.
  try {
    // 2. Verificar se o instalador da build escolhida ainda existe antes de baixar.
    // Builds podem ser removidas/promovidas entre a listagem e a instalação; sem essa
    // checagem, o usuário só descobria isso com um "HTTP 404" cru no meio da instalação.
    let provider = getProviderByName(providerName);
    let effectiveForgeVersion = forgeVersion;
    onProgress({ status: "Verificando disponibilidade do instalador...", percent: 10 });
    let installerUrl = provider.getInstallerUrl(mcVersion, effectiveForgeVersion);
    if (!(await urlExists(installerUrl))) {
      // Import de modpack: a versão do loader vem do manifest do pack e trocar
      // silenciosamente por outra build pode quebrar compatibilidade com os
      // mods do pack — falha alto em vez de substituir.
      if (opts?.strict) {
        throw new Error(`Este modpack requer ${providerName === 'forge' ? 'Forge' : 'NeoForge'} ${forgeVersion} para Minecraft ${mcVersion}, que não está mais disponível.`);
      }
      onProgress({ status: "Build selecionada indisponível, buscando alternativa...", percent: 12 });
      forgeVersionCache.delete(`${provider.name}:${mcVersion}`);
      const freshBuilds = await getForgeVersions(mcVersion);
      const fallback = freshBuilds.find(b => b.provider === providerName) ?? freshBuilds[0];
      if (!fallback) {
        throw new Error(`Não há nenhuma build de ${providerName === 'forge' ? 'Forge' : 'NeoForge'} disponível para Minecraft ${mcVersion} no momento.`);
      }
      provider = getProviderByName(fallback.provider);
      effectiveForgeVersion = fallback.forgeVersion;
      installerUrl = provider.getInstallerUrl(mcVersion, effectiveForgeVersion);
      if (!(await urlExists(installerUrl))) {
        throw new Error(`Não foi possível encontrar um instalador de ${providerName === 'forge' ? 'Forge' : 'NeoForge'} válido para Minecraft ${mcVersion}.`);
      }
    }

    // 3. Baixar installer.jar
    // Sem SHA1 conhecido de antemão (providers de Forge/NeoForge não publicam um
    // manifest com checksum como a Mojang) — ainda assim se beneficia do retry
    // com backoff e da limpeza de arquivo truncado que o comando já faz.
    onProgress({ status: "Baixando instalador do Forge...", percent: 15 });
    const installerPath = await join(serverPath, "forge-installer.jar");
    await invoke("download_server_jar", { url: installerUrl, destPath: installerPath, expectedSha1: null });

    // 3. Executar instalador headless via Rust (não bloqueia IPC do Tauri)
    onProgress({ status: "Executando instalador do Forge (pode levar alguns minutos)...", percent: 50 });

    // Determinar versão do Java (Forge 1.17+ = Java 17, 1.16- = Java 8)
    const javaVer = getJavaVersion(mcVersion);
    const jrePath = await (await import("@/lib/jre")).getJREPath(javaVer);
    const javaExe = await join(jrePath, "bin", "java.exe");

    // Executa: java -jar installer.jar --installServer no Rust (comando dedicado)
    // O Rust gerencia threads, timeout de 10 min e logs
    await invoke("run_forge_installer", { javaPath: javaExe, installerPath });

    // 4. Detectar como iniciar o Forge (JAR único ou layout moderno com args file)
    onProgress({ status: "Detectando arquivos do Forge...", percent: 80 });
    const launchInfo = await detectForgeJar(serverPath);
    if (!launchInfo) {
      throw new Error("Não foi possível encontrar o JAR do Forge após a instalação.");
    }
    const serverJar = launchInfo.mode === 'jar' ? (launchInfo.jarName ?? null) : null;
    const launchArgsDir = launchInfo.mode === 'argfile' ? (launchInfo.argsDir ?? null) : null;

    // 5. Aceitar EULA
    onProgress({ status: "Aceitando EULA...", percent: 85 });
    const eulaPath = await join(serverPath, "eula.txt");
    await writeTextFile(eulaPath, "# Aceito automaticamente pelo Cubicase\neula=true\n");

    // 6. Gerar server.properties
    onProgress({ status: "Gerando configurações...", percent: 90 });
    const propertiesPath = await join(serverPath, "server.properties");
    const properties = generateServerProperties(mcVersion, ramGb);
    await writeTextFile(propertiesPath, properties);

    // 7. Limpar installer.jar
    await remove(installerPath).catch(() => { /* ignora se falhar */ });

    // 8. Gerar metadados
    const uuid = crypto.randomUUID();
    const shortCode = Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 36).toString(36)
    ).join('').toUpperCase();

    const metaPath = await join(serverPath, "cubicase-meta.json");
    await writeTextFile(metaPath, JSON.stringify({
      schemaVersion: 2,
      uuid,
      shortCode,
      name: serverName,
      version: mcVersion,
      serverType: provider.name, // "forge" ou "neoforge"
      description: `Servidor ${provider.name === 'forge' ? 'Forge' : 'NeoForge'} ${effectiveForgeVersion}`,
      forgeVersion: effectiveForgeVersion,
      ramGb,
      serverJar,
      launchArgsDir,
      createdAt: new Date().toISOString(),
      iconPath: null,
      tags: [],
      motd: `Servidor Cubicase [${provider.name === 'forge' ? 'Forge' : 'NeoForge'}] - ${serverName}`,
      lastPlayedAt: null,
    }, null, 2));

    onProgress({ status: "Servidor Forge criado com sucesso!", percent: 100 });
  } catch (err) {
    await remove(serverPath, { recursive: true }).catch(() => {});
    throw err;
  }
}

// ============================================================
// Fabric — API de Versões e Instalação
// ============================================================

export interface FabricLoaderBuild {
  mcVersion: string;
  loaderVersion: string;
  stable: boolean;
}

interface FabricInstallerVersion {
  version: string;
  stable: boolean;
}

const fabricLoaderCache: Map<string, { builds: FabricLoaderBuild[]; fetchedAt: number }> = new Map();
let fabricInstallerCache: { versions: FabricInstallerVersion[]; fetchedAt: number } | null = null;
const FABRIC_CACHE_TTL = 5 * 60 * 1000; // 5 min
const FABRIC_SERVER_JAR_NAME = "fabric-server-launch.jar";

/**
 * Busca as versões do Fabric Loader compatíveis com uma versão do Minecraft
 * via Fabric Meta API (meta.fabricmc.net). A API já retorna apenas os
 * loaders compatíveis com a versão do jogo pedida, ordenados do mais
 * recente para o mais antigo.
 */
export async function getFabricLoaderVersions(mcVersion: string): Promise<FabricLoaderBuild[]> {
  const cached = fabricLoaderCache.get(mcVersion);
  if (cached && Date.now() - cached.fetchedAt < FABRIC_CACHE_TTL) return cached.builds;

  try {
    const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Array<{ loader: { version: string; stable: boolean } }>;
    const builds: FabricLoaderBuild[] = data.map(entry => ({
      mcVersion,
      loaderVersion: entry.loader.version,
      stable: entry.loader.stable,
    }));
    fabricLoaderCache.set(mcVersion, { builds, fetchedAt: Date.now() });
    return builds;
  } catch (err) {
    console.warn(`[Fabric] Falha ao buscar loaders para ${mcVersion}:`, err);
    return [];
  }
}

/**
 * Busca as versões do Fabric Installer disponíveis. Não é exposto na UI —
 * é um detalhe técnico do processo de geração do server jar; o Cubicase
 * sempre escolhe a build estável mais recente automaticamente.
 */
async function getFabricInstallerVersions(): Promise<FabricInstallerVersion[]> {
  if (fabricInstallerCache && Date.now() - fabricInstallerCache.fetchedAt < FABRIC_CACHE_TTL) {
    return fabricInstallerCache.versions;
  }
  try {
    const res = await fetch("https://meta.fabricmc.net/v2/versions/installer");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as FabricInstallerVersion[];
    fabricInstallerCache = { versions: data, fetchedAt: Date.now() };
    return data;
  } catch (err) {
    console.warn("[Fabric] Falha ao buscar versões do installer:", err);
    return [];
  }
}

/** Escolhe o item estável mais recente de uma lista; cai para o primeiro disponível se nenhum for estável. */
function pickStable<T extends { stable: boolean }>(list: T[]): T | null {
  return list.find(v => v.stable) ?? list[0] ?? null;
}

/**
 * Instala um servidor Fabric localmente.
 * Diferente do Forge, o Fabric não precisa rodar um instalador headless:
 * a Fabric Meta API gera sob demanda um "server launcher jar" já pronto
 * para rodar (mesmo mecanismo usado pelo instalador oficial do site do
 * Fabric). Esse jar é pequeno (algumas centenas de KB) e, no primeiro
 * boot, baixa sozinho o Fabric Loader e o server vanilla correspondentes
 * — por isso o primeiro início demora mais que os seguintes, mesmo com a
 * "instalação" já concluída aqui.
 */
export async function installFabricServer(
  serverName: string,
  mcVersion: string,
  loaderVersion: string,
  ramGb: number,
  onProgress: (p: ServerInstallProgress) => void
): Promise<void> {
  const docsDir = await documentDir();
  const serversRoot = await join(docsDir, "CubicaseServers");
  const serverPath = await join(serversRoot, serverName);

  onProgress({ status: "Criando pasta do servidor...", percent: 5 });
  if (!(await exists(serversRoot))) await mkdir(serversRoot, { recursive: true });
  if (await exists(serverPath)) throw new Error(`Já existe um servidor com o nome "${serverName}".`);
  await mkdir(serverPath, { recursive: true });

  try {
    onProgress({ status: "Selecionando versão do instalador Fabric...", percent: 15 });
    const installers = await getFabricInstallerVersions();
    const installer = pickStable(installers);
    if (!installer) {
      throw new Error("Não foi possível determinar uma versão do Fabric Installer. Verifique sua conexão e tente novamente.");
    }

    const jarPath = await join(serverPath, FABRIC_SERVER_JAR_NAME);
    const jarUrl = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installer.version)}/server/jar`;

    onProgress({ status: "Baixando servidor Fabric...", percent: 30 });
    await invoke("download_server_jar", { url: jarUrl, destPath: jarPath, expectedSha1: null, expectedSha256: null });
    onProgress({ status: "Download concluído.", percent: 75 });

    onProgress({ status: "Aceitando EULA...", percent: 80 });
    const eulaPath = await join(serverPath, "eula.txt");
    await writeTextFile(eulaPath, "# Aceito automaticamente pelo Cubicase\neula=true\n");

    onProgress({ status: "Gerando configurações...", percent: 88 });
    const propertiesPath = await join(serverPath, "server.properties");
    await writeTextFile(propertiesPath, generateServerProperties(mcVersion, ramGb));

    const uuid = crypto.randomUUID();
    const shortCode = Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 36).toString(36)
    ).join('').toUpperCase();

    const metaPath = await join(serverPath, "cubicase-meta.json");
    await writeTextFile(metaPath, JSON.stringify({
      schemaVersion: 2,
      uuid,
      shortCode,
      name: serverName,
      version: mcVersion,
      serverType: "fabric",
      description: `Servidor Fabric ${loaderVersion}`,
      forgeVersion: null,
      modLoaderVersion: loaderVersion,
      ramGb,
      serverJar: FABRIC_SERVER_JAR_NAME,
      launchArgsDir: null,
      createdAt: new Date().toISOString(),
      iconPath: null,
      tags: [],
      motd: `Servidor Cubicase [Fabric] - ${serverName}`,
      lastPlayedAt: null,
    }, null, 2));

    onProgress({ status: "Servidor Fabric criado com sucesso!", percent: 100 });
  } catch (err) {
    await remove(serverPath, { recursive: true }).catch(() => {});
    throw err;
  }
}

// ============================================================
// Paper — API de Versões e Instalação
// ============================================================

/**
 * User-Agent exigido pela Downloads Service da PaperMC (fill.papermc.io):
 * a API rejeita User-Agents genéricos (curl, wget, vazio) e exige um
 * identificador de software com contato. Sem isso, os requests podem ser
 * bloqueados independente da versão/build pedida.
 */
const PAPER_USER_AGENT = "CubicaseDash/1.0 (+https://cubeforge.dev; contato: suporte@cubeforge.dev)";

export interface PaperBuild {
  mcVersion: string;
  build: number;
  /** "STABLE" ou "EXPERIMENTAL" (nomenclatura da própria API da PaperMC) */
  channel: string;
  recommended: boolean;
  jarName: string;
  downloadUrl: string;
  sha256: string | null;
}

const paperBuildCache: Map<string, { builds: PaperBuild[]; fetchedAt: number }> = new Map();
const PAPER_CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * Busca as builds do Paper disponíveis para uma versão do Minecraft via
 * Downloads Service da PaperMC (fill.papermc.io/v3 — sucessora da antiga
 * api.papermc.io/v2, desativada em 2026). As builds já vêm com URL de
 * download direto e checksum SHA256, sem precisar de instalador.
 */
export async function getPaperBuilds(mcVersion: string): Promise<PaperBuild[]> {
  const cached = paperBuildCache.get(mcVersion);
  if (cached && Date.now() - cached.fetchedAt < PAPER_CACHE_TTL) return cached.builds;

  try {
    const res = await fetch(
      `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds`,
      { headers: { "User-Agent": PAPER_USER_AGENT } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Array<{
      id: number;
      channel: string;
      downloads: Record<string, { name: string; url: string; checksums?: { sha256?: string } }>;
    }>;

    const builds: PaperBuild[] = data
      .filter(b => b.downloads && b.downloads["server:default"])
      .map(b => {
        const dl = b.downloads["server:default"];
        return {
          mcVersion,
          build: b.id,
          channel: b.channel,
          recommended: false,
          jarName: dl.name,
          downloadUrl: dl.url,
          sha256: dl.checksums?.sha256 ?? null,
        };
      })
      // A API retorna em ordem crescente (mais antiga primeiro) — inverte para a UI mostrar a mais recente primeiro
      .reverse();

    const firstStable = builds.find(b => b.channel === "STABLE");
    if (firstStable) firstStable.recommended = true;

    paperBuildCache.set(mcVersion, { builds, fetchedAt: Date.now() });
    return builds;
  } catch (err) {
    console.warn(`[Paper] Falha ao buscar builds para ${mcVersion}:`, err);
    return [];
  }
}

/**
 * Instala um servidor Paper localmente.
 * O Paper publica o jar do servidor já pronto (sem instalador): baixamos
 * diretamente via Rust, com verificação de integridade por SHA256 (a
 * PaperMC publica o checksum de cada build, diferente do Forge).
 */
export async function installPaperServer(
  serverName: string,
  mcVersion: string,
  build: number,
  ramGb: number,
  onProgress: (p: ServerInstallProgress) => void
): Promise<void> {
  const docsDir = await documentDir();
  const serversRoot = await join(docsDir, "CubicaseServers");
  const serverPath = await join(serversRoot, serverName);

  onProgress({ status: "Criando pasta do servidor...", percent: 5 });
  if (!(await exists(serversRoot))) await mkdir(serversRoot, { recursive: true });
  if (await exists(serverPath)) throw new Error(`Já existe um servidor com o nome "${serverName}".`);
  await mkdir(serverPath, { recursive: true });

  try {
    onProgress({ status: "Consultando builds do Paper...", percent: 10 });
    let builds = await getPaperBuilds(mcVersion);
    let selected = builds.find(b => b.build === build);
    if (!selected) {
      // A build escolhida pode ter saído da lista entre a seleção na UI e a
      // instalação (promovida/removida) — busca de novo e cai para a mais
      // recente disponível, em vez de falhar com um 404 cru no download.
      paperBuildCache.delete(mcVersion);
      builds = await getPaperBuilds(mcVersion);
      selected = builds.find(b => b.recommended) ?? builds[0];
      if (!selected) {
        throw new Error(`Não há nenhuma build do Paper disponível para Minecraft ${mcVersion} no momento.`);
      }
    }

    const jarPath = await join(serverPath, selected.jarName);
    onProgress({ status: "Baixando servidor Paper...", percent: 25 });
    await invoke("download_server_jar", {
      url: selected.downloadUrl,
      destPath: jarPath,
      expectedSha1: null,
      expectedSha256: selected.sha256,
    });
    onProgress({ status: "Download concluído.", percent: 75 });

    onProgress({ status: "Aceitando EULA...", percent: 80 });
    const eulaPath = await join(serverPath, "eula.txt");
    await writeTextFile(eulaPath, "# Aceito automaticamente pelo Cubicase\neula=true\n");

    onProgress({ status: "Gerando configurações...", percent: 88 });
    const propertiesPath = await join(serverPath, "server.properties");
    await writeTextFile(propertiesPath, generateServerProperties(mcVersion, ramGb));

    const uuid = crypto.randomUUID();
    const shortCode = Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 36).toString(36)
    ).join('').toUpperCase();

    const metaPath = await join(serverPath, "cubicase-meta.json");
    await writeTextFile(metaPath, JSON.stringify({
      schemaVersion: 2,
      uuid,
      shortCode,
      name: serverName,
      version: mcVersion,
      serverType: "paper",
      description: `Servidor Paper build ${selected.build}`,
      forgeVersion: null,
      modLoaderVersion: String(selected.build),
      ramGb,
      serverJar: selected.jarName,
      launchArgsDir: null,
      createdAt: new Date().toISOString(),
      iconPath: null,
      tags: [],
      motd: `Servidor Cubicase [Paper] - ${serverName}`,
      lastPlayedAt: null,
    }, null, 2));

    onProgress({ status: "Servidor Paper criado com sucesso!", percent: 100 });
  } catch (err) {
    await remove(serverPath, { recursive: true }).catch(() => {});
    throw err;
  }
}

/**
 * Valida se uma pasta contém um servidor Minecraft válido.
 * Verifica a presença de server.jar e server.properties.
 */
export async function isValidServerFolder(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  const jarPath = await join(path, 'server.jar');
  if (!(await exists(jarPath))) return false;
  return true;
}

// ============================================================
// Utilitários para EULA do Minecraft
// ============================================================

/**
 * Verifica se o EULA do Minecraft já foi aceito em uma pasta de servidor.
 * Lê o arquivo eula.txt e procura por "eula=true" (case-insensitive).
 *
 * @param serverPath Caminho absoluto da pasta do servidor
 * @returns true se eula=true foi encontrado, false caso contrário
 */
export async function checkEulaAccepted(serverPath: string): Promise<boolean> {
  const eulaPath = await join(serverPath, "eula.txt");
  if (!(await exists(eulaPath))) return false;

  try {
    const content = await readTextFile(eulaPath);
    // Procura por "eula=true" em qualquer linha (ignorando comentários)
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      // Pular comentários e linhas vazias
      if (trimmed.startsWith("#") || trimmed.length === 0) continue;
      // Verificar se a linha contém eula=true (case-insensitive)
      if (/^eula\s*=\s*true\s*$/i.test(trimmed)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Aceita o EULA do Minecraft escrevendo "eula=true" no eula.txt.
 * Se o arquivo já existir, atualiza a linha eula=false → eula=true.
 * Se não existir, cria o arquivo com o conteúdo adequado.
 *
 * @param serverPath Caminho absoluto da pasta do servidor
 */
export async function acceptEula(serverPath: string): Promise<void> {
  const eulaPath = await join(serverPath, "eula.txt");

  if (await exists(eulaPath)) {
    try {
      const content = await readTextFile(eulaPath);
      const lines = content.split(/\r?\n/);
      let modified = false;

      const newLines = lines.map(line => {
        const trimmed = line.trim();
        // Se a linha já for eula=true, não precisa modificar
        if (/^eula\s*=\s*true\s*$/i.test(trimmed)) return line;
        // Se for eula=false, trocar para true
        if (/^eula\s*=\s*false\s*$/i.test(trimmed)) {
          modified = true;
          return line.replace(/eula\s*=\s*false/i, "eula=true");
        }
        return line;
      });

      if (modified) {
        await writeTextFile(eulaPath, newLines.join("\n"));
      }
      // Se não encontrou nenhuma linha eula=, adiciona no final
      if (!modified && !lines.some(l => /^eula\s*=\s*true\s*$/i.test(l.trim()))) {
        await writeTextFile(eulaPath, content.trimEnd() + "\n# Aceito automaticamente pelo Cubicase\neula=true\n");
      }
    } catch {
      // Se falhou ler, sobrescreve
      await writeTextFile(eulaPath, "# Aceito automaticamente pelo Cubicase\neula=true\n");
    }
  } else {
    // Arquivo não existe: criar
    await writeTextFile(eulaPath, "# Aceito automaticamente pelo Cubicase\neula=true\n");
  }
}

/**
 * Importa um servidor Minecraft de uma pasta existente.
 *
 * 1. Valida que a pasta tem server.jar
 * 2. Detecta a versão automaticamente (várias estratégias)
 * 3. Detecta o tipo (vanilla, forge, fabric, paper, etc.)
 * 4. Verifica/aceita a EULA automaticamente (se ainda não aceita)
 * 5. Cria/atualiza cubicase-meta.json com UUID e shortCode
 * 6. Retorna o ServerInfo completo
 */
export async function importExistingServer(path: string): Promise<ServerInfo> {
  // Validar
  if (!(await isValidServerFolder(path))) {
    throw new Error("A pasta selecionada não contém um servidor Minecraft válido (server.jar não encontrado).");
  }

  // Extrair nome da pasta
  const name = path.split('\\').pop()?.split('/').pop() || 'Servidor Importado';

  // Detectar versão
  const version = await detectServerVersion(path);

  // Detectar tipo
  const serverType = await detectServerType(path);

  // Verificar e aceitar EULA automaticamente
  const eulaAccepted = await checkEulaAccepted(path);
  if (!eulaAccepted) {
    await acceptEula(path);
  }

  // Ler ou criar metadados
  const metaPath = await join(path, "cubicase-meta.json");
  let uuid: string | null = null;
  let shortCode: string | null = null;
  let description = "";
  let schemaVersion = 1;
  let forgeVersion: string | null = null;
  let modLoaderVersion: string | null = null;

  if (await exists(metaPath)) {
    try {
      const metaContent = await readTextFile(metaPath);
      const meta = JSON.parse(metaContent) as {
        uuid?: string;
        shortCode?: string;
        description?: string;
        schemaVersion?: number;
        forgeVersion?: string;
        modLoaderVersion?: string;
      };
      uuid = meta.uuid ?? null;
      shortCode = meta.shortCode ?? null;
      description = meta.description ?? "";
      schemaVersion = meta.schemaVersion ?? 1;
      forgeVersion = meta.forgeVersion ?? null;
      modLoaderVersion = meta.modLoaderVersion ?? null;
    } catch { /* ignora */ }
  }

  // Gerar UUID e shortCode se não existirem
  if (!uuid) {
    uuid = crypto.randomUUID();
  }
  if (!shortCode) {
    shortCode = Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 36).toString(36)
    ).join('').toUpperCase();
  }

  // Salvar/atualizar metadados
  const meta = {
    schemaVersion: 2,
    uuid,
    shortCode,
    name,
    version,
    serverType,
    description,
    forgeVersion,
    modLoaderVersion,
    createdAt: new Date().toISOString(),
    tags: [],
    imported: true,
    originalPath: path,
  };
  await writeTextFile(metaPath, JSON.stringify(meta, null, 2));

  return {
    name,
    path,
    version,
    uuid,
    shortCode,
    serverType,
    description,
    schemaVersion: 2,
    eulaAccepted: true,
    serverJar: null,
    launchArgsDir: null,
    forgeVersion,
    modLoaderVersion,
  };
}

/**
 * Escaneia uma única pasta de servidor (qualquer local) e retorna ServerInfo.
 * Útil para recarregar servidores importados sem recriar metadados.
 * Não modifica a pasta.
 */
export async function scanExternalServer(serverPath: string): Promise<ServerInfo | null> {
  if (!(await exists(serverPath))) return null;

  const jarPath = await join(serverPath, "server.jar");
  if (!(await exists(jarPath))) return null;

  const name = serverPath.split('\\').pop()?.split('/').pop() || 'Servidor';

  // Ler metadados
  let version: string | null = null;
  let uuid: string | null = null;
  let shortCode: string | null = null;
  let serverType = "vanilla";
  let description = "";
  let schemaVersion = 1;
  let forgeVersion: string | null = null;
  let modLoaderVersion: string | null = null;

  const metaPath = await join(serverPath, "cubicase-meta.json");
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
          serverJar?: string;
          forgeVersion?: string;
          modLoaderVersion?: string;
        };
        version = meta.version ?? null;
        uuid = meta.uuid ?? null;
        shortCode = meta.shortCode ?? null;
        serverType = meta.serverType ?? "vanilla";
        description = meta.description ?? "";
        schemaVersion = meta.schemaVersion ?? 1;
        forgeVersion = meta.forgeVersion ?? null;
        modLoaderVersion = meta.modLoaderVersion ?? null;
    } catch { /* ignora */ }
  }

  // Detectar versão se não encontrada nos metadados
  if (!version) {
    version = await detectServerVersion(serverPath);
  }

  // Detectar tipo se não encontrado nos metadados
  if (!serverType || serverType === "vanilla") {
    serverType = await detectServerType(serverPath);
  }

  // Verificar status do EULA
  const eulaAccepted = await checkEulaAccepted(serverPath);

  return {
    name,
    path: serverPath,
    version,
    uuid,
    shortCode,
    serverType,
    description,
    schemaVersion,
    eulaAccepted,
    serverJar: null,
    launchArgsDir: null,
    forgeVersion,
    modLoaderVersion,
  };
}

/**
 * Varre a pasta de servidores e retorna a lista de servidores instalados.
 */
// ============================================================
// Forge / NeoForge — API de Versões
// ============================================================

export type ServerType = 'vanilla' | 'forge' | 'neoforge' | 'fabric' | 'paper';

export interface ForgeBuild {
  mcVersion: string;
  forgeVersion: string;
  build: number;
  date: string;
  recommended: boolean;
  downloadUrl: string;
  installerUrl: string;
  /** Qual provedor realmente tem essa build (determina o formato da URL de download) */
  provider: 'forge' | 'neoforge';
}

interface ForgeProvider {
  name: string;
  fetchVersions(mcVersion: string): Promise<ForgeBuild[]>;
  getInstallerUrl(mcVersion: string, forgeVersion: string): string;
}

// Cache em memória para versões Forge
let forgeVersionCache: Map<string, { builds: ForgeBuild[]; fetchedAt: number }> = new Map();
const FORGE_CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * ForgeProvider — lida com versões ≤ 1.20.1 (Maven MinecraftForge)
 */
class ForgeProviderImpl implements ForgeProvider {
  name = 'forge';

  async fetchVersions(mcVersion: string): Promise<ForgeBuild[]> {
    const cacheKey = `forge:${mcVersion}`;
    const cached = forgeVersionCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < FORGE_CACHE_TTL) return cached.builds;

    const builds: ForgeBuild[] = [];

    // Estratégia 1: API de promotions da Forge (mais confiável)
    try {
      const promotionsUrl = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
      const res = await fetch(promotionsUrl);
      if (res.ok) {
        const data = await res.json() as any;
        const promos = data.promos || {};
        // Formato: "1.20.1-recommended": "47.1.0", "1.20.1-latest": "47.1.3"
        const recommendedKey = `${mcVersion}-recommended`;
        const latestKey = `${mcVersion}-latest`;
        const recommended = promos[recommendedKey] as string | undefined;
        const latest = promos[latestKey] as string | undefined;
        
        if (recommended) {
          builds.push({
            mcVersion, forgeVersion: recommended, build: 0,
            date: '', recommended: true,
            downloadUrl: '', installerUrl: this.getInstallerUrl(mcVersion, recommended),
            provider: 'forge',
          });
        }
        if (latest && latest !== recommended) {
          builds.push({
            mcVersion, forgeVersion: latest, build: 0,
            date: '', recommended: false,
            downloadUrl: '', installerUrl: this.getInstallerUrl(mcVersion, latest),
            provider: 'forge',
          });
        }
      }
    } catch (err) {
      console.warn(`[ForgeProvider] Promotions API falhou para ${mcVersion}:`, err);
    }

    // Estratégia 2: Maven metadata XML (fallback se promotions não funcionar)
    if (builds.length === 0) {
      try {
        const mavenUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml`;
        const res = await fetch(mavenUrl);
        if (res.ok) {
          const xml = await res.text();
          // Parse XML simples: <version>1.20.1-47.1.0</version>
          const versionRegex = new RegExp(`<version>${mcVersion.replace('.', '\\.')}-([\\d.]+)<\\/version>`, 'g');
          let match;
          const forgeVersions: string[] = [];
          while ((match = versionRegex.exec(xml)) !== null) {
            forgeVersions.push(match[1]);
          }
          // Últimas builds primeiro
          forgeVersions.reverse();
          for (let i = 0; i < Math.min(forgeVersions.length, 10); i++) {
            builds.push({
              mcVersion, forgeVersion: forgeVersions[i], build: 0,
              date: '', recommended: i === 0,
              downloadUrl: '', installerUrl: this.getInstallerUrl(mcVersion, forgeVersions[i]),
              provider: 'forge',
            });
          }
        }
      } catch (err) {
        console.warn(`[ForgeProvider] Maven XML falhou para ${mcVersion}:`, err);
      }
    }

    if (builds.length > 0) {
      forgeVersionCache.set(cacheKey, { builds, fetchedAt: Date.now() });
      return builds;
    }

    // Fallback offline
    console.warn(`[ForgeProvider] Nenhuma build encontrada para ${mcVersion}, usando fallback.`);
    return getForgeFallbackVersions(mcVersion);
  }

  getInstallerUrl(mcVersion: string, forgeVersion: string): string {
    return `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`;
  }
}

/**
 * NeoForgeProvider — lida com versões ≥ 1.20.4 (NeoForged API)
 */
class NeoForgeProviderImpl implements ForgeProvider {
  name = 'neoforge';

  async fetchVersions(mcVersion: string): Promise<ForgeBuild[]> {
    const cacheKey = `neoforge:${mcVersion}`;
    const cached = forgeVersionCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < FORGE_CACHE_TTL) return cached.builds;

    try {
      // Tentar API principal com timeout mais curto
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const url = `https://neoapi.neoforged.net/api/v1/versions/${mcVersion}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      
      const builds: ForgeBuild[] = (data.versions || []).map((v: any) => ({
        mcVersion,
        forgeVersion: v.version || v.name || '',
        build: v.build || 0,
        date: v.date || v.time || '',
        recommended: v.recommended || v.latest || false,
        downloadUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v.version}/neoforge-${v.version}-installer.jar`,
        installerUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v.version}/neoforge-${v.version}-installer.jar`,
        provider: 'neoforge',
      }));

      builds.sort((a: ForgeBuild, b: ForgeBuild) => {
        if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
        return b.build - a.build;
      });

      forgeVersionCache.set(cacheKey, { builds, fetchedAt: Date.now() });
      return builds;
    } catch (_err) {
      // NeoForged API frequentemente indisponível — usar fallback silenciosamente
      return getForgeFallbackVersions(mcVersion);
    }
  }

  getInstallerUrl(mcVersion: string, forgeVersion: string): string {
    return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${forgeVersion}/neoforge-${forgeVersion}-installer.jar`;
  }
}

// Instâncias singleton
const forgeProvider = new ForgeProviderImpl();
const neoforgeProvider = new NeoForgeProviderImpl();

/** Resolve o objeto provider a partir do nome salvo numa build ('forge' ou 'neoforge'). */
function getProviderByName(name: string): ForgeProvider {
  return name === 'neoforge' ? neoforgeProvider : forgeProvider;
}

/**
 * Busca versões do Forge/NeoForge para uma versão do Minecraft.
 *
 * O Forge clássico (MinecraftForge) continua publicando builds no maven oficial
 * para praticamente qualquer versão do Minecraft, não só as antigas — por isso
 * ele é sempre tentado primeiro, independente da versão. Assumir um corte fixo
 * tipo "só existe até 1.20.1" causava falsos negativos (e um 404 na hora de
 * baixar) para versões mais novas que o Forge também suporta. O NeoForge (fork)
 * só entra como alternativa se o Forge realmente não tiver nada para essa versão.
 */
export async function getForgeVersions(mcVersion: string): Promise<ForgeBuild[]> {
  const forgeBuilds = await forgeProvider.fetchVersions(mcVersion);
  if (forgeBuilds.length > 0) return forgeBuilds;

  return neoforgeProvider.fetchVersions(mcVersion);
}

/**
 * Fallback offline com versões conhecidas (usado quando as APIs ao vivo falham).
 * Retorna lista vazia (em vez de uma build fake) quando a versão não é conhecida,
 * para que a UI mostre "nenhuma versão encontrada" em vez de oferecer uma build
 * que garantidamente não existe (URL de instalador vazia → 404 no download).
 */
function getForgeFallbackVersions(mcVersion: string): ForgeBuild[] {
  const knownForge: Record<string, { provider: 'forge' | 'neoforge'; versions: string[] }> = {
    '1.20.1': { provider: 'forge', versions: ['47.1.0', '47.0.35', '47.0.23', '47.0.15'] },
    '1.19.4': { provider: 'forge', versions: ['45.1.0', '45.0.49', '45.0.43'] },
    '1.19.2': { provider: 'forge', versions: ['43.2.0', '43.1.49', '43.1.32'] },
    '1.18.2': { provider: 'forge', versions: ['40.2.0', '40.1.80', '40.1.73'] },
    '1.16.5': { provider: 'forge', versions: ['36.2.0', '36.1.82', '36.1.62'] },
    '1.12.2': { provider: 'forge', versions: ['14.23.5.2860', '14.23.5.2859', '14.23.5.2854'] },
    '1.21.1': { provider: 'neoforge', versions: ['21.0.0-beta', '21.0.0-alpha'] },
  };

  const entry = knownForge[mcVersion];
  if (!entry) return [];

  const provider = getProviderByName(entry.provider);
  return entry.versions.map((v, i) => ({
    mcVersion,
    forgeVersion: v,
    build: 0,
    date: '',
    recommended: i === 0,
    downloadUrl: provider.getInstallerUrl(mcVersion, v),
    installerUrl: provider.getInstallerUrl(mcVersion, v),
    provider: entry.provider,
  }));
}

/** Verifica via HEAD se uma URL de instalador realmente existe antes de tentar baixá-la. */
async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listLocalServers(): Promise<ServerInfo[]> {
  const docsDir = await documentDir();
  const serversRoot = await join(docsDir, "CubicaseServers");

  if (!(await exists(serversRoot))) return [];

  const entries = await readDir(serversRoot);
  const servers: ServerInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const serverPath = await join(serversRoot, entry.name);

    // Lê os metadados do Cubicase (cubicase-meta.json) PRIMEIRO
    // para saber qual arquivo JAR procurar (server.jar para Vanilla,
    // forge-*-shim.jar para Forge, etc.)
    let version: string | null = null;
    let uuid: string | null = null;
    let shortCode: string | null = null;
    let serverType = "vanilla";
    let description = "";
    let schemaVersion = 1;
    let serverJar: string | null = null;
    let launchArgsDir: string | null = null;
    let forgeVersion: string | null = null;
    let modLoaderVersion: string | null = null;
    const metaPath = await join(serverPath, "cubicase-meta.json");
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
          serverJar?: string;
          launchArgsDir?: string;
          forgeVersion?: string;
          modLoaderVersion?: string;
        };
        version = meta.version ?? null;
        uuid = meta.uuid ?? null;
        shortCode = meta.shortCode ?? null;
        serverType = meta.serverType ?? "vanilla";
        description = meta.description ?? "";
        schemaVersion = meta.schemaVersion ?? 1;
        serverJar = meta.serverJar ?? null;
        launchArgsDir = meta.launchArgsDir ?? null;
        forgeVersion = meta.forgeVersion ?? null;
        modLoaderVersion = meta.modLoaderVersion ?? null;
      } catch { /* ignora erros de parse */ }
    }

    // Fallback 1: tenta extrair a versão do comentário no server.properties
    if (!version) {
      const propsPath = await join(serverPath, "server.properties");
      if (await exists(propsPath)) {
        try {
          const propsContent = await readTextFile(propsPath);
          const patterns = [
            /^#\s*Gerado pelo Cubicase\s*[-–]\s*vers[ãa]o\s+([\d.]+)/mi,
            /^#\s*Cubicase\s+version\s+([\d.]+)/mi,
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

    // Fallback 2: tenta extrair a versão da pasta versions/
    if (!version) {
      version = await detectServerVersion(serverPath);
    }

    // Verificar status do EULA
    const eulaAccepted = await checkEulaAccepted(serverPath);

    servers.push({ name: entry.name, path: serverPath, version, uuid, shortCode, serverType, description, schemaVersion, eulaAccepted, serverJar, launchArgsDir, forgeVersion, modLoaderVersion });
  }

  return servers;
}
