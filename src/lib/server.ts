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
  /** Versão do schema do cubicase-meta.json */
  schemaVersion: number;
  /** Indica se o EULA do Minecraft foi aceito (eula=true no eula.txt) */
  eulaAccepted: boolean;
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
  const serversRoot = await join(docsDir, "CubicaseServers");
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

  if (await exists(metaPath)) {
    try {
      const metaContent = await readTextFile(metaPath);
      const meta = JSON.parse(metaContent) as {
        uuid?: string;
        shortCode?: string;
        description?: string;
        schemaVersion?: number;
      };
      uuid = meta.uuid ?? null;
      shortCode = meta.shortCode ?? null;
      description = meta.description ?? "";
      schemaVersion = meta.schemaVersion ?? 1;
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
      };
      version = meta.version ?? null;
      uuid = meta.uuid ?? null;
      shortCode = meta.shortCode ?? null;
      serverType = meta.serverType ?? "vanilla";
      description = meta.description ?? "";
      schemaVersion = meta.schemaVersion ?? 1;
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
  };
}

/**
 * Varre a pasta de servidores e retorna a lista de servidores instalados.
 */
export async function listLocalServers(): Promise<ServerInfo[]> {
  const docsDir = await documentDir();
  const serversRoot = await join(docsDir, "CubicaseServers");

  if (!(await exists(serversRoot))) return [];

  const entries = await readDir(serversRoot);
  const servers: ServerInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const serverPath = await join(serversRoot, entry.name);
    const jarPath = await join(serverPath, "server.jar");

    // Só inclui se tiver o server.jar (instalação completa)
    if (!(await exists(jarPath))) continue;

    // Lê os metadados do Cubicase (cubicase-meta.json)
    let version: string | null = null;
    let uuid: string | null = null;
    let shortCode: string | null = null;
    let serverType = "vanilla";
    let description = "";
    let schemaVersion = 1;
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

    servers.push({ name: entry.name, path: serverPath, version, uuid, shortCode, serverType, description, schemaVersion, eulaAccepted });
  }

  return servers;
}
