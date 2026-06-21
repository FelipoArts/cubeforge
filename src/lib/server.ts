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
}

export interface ServerInstallProgress {
  status: string;
  percent: number;
}

// Versões disponíveis para criação de servidor.
// Para adicionar novas versões no futuro, basta adicionar o ID aqui.
export const SUPPORTED_VERSIONS = ["1.20.1", "1.20.4", "1.21", "1.21.4"] as const;
export type MinecraftVersion = (typeof SUPPORTED_VERSIONS)[number];

// Memória Java necessária por versão (Java 17 para 1.20.x, Java 21 para 1.21+)
export function getJavaVersion(mcVersion: string): 17 | 21 {
  const major = parseInt(mcVersion.split(".")[1] ?? "20", 10);
  return major >= 21 ? 21 : 17;
}

// ============================================================
// Resolução de URL do server.jar via manifest oficial da Mojang
// ============================================================

/**
 * Consulta o manifest oficial da Mojang para encontrar o URL direto do
 * server.jar de uma versão específica.
 * Arquitetura dinâmica: adicionar nova versão no SUPPORTED_VERSIONS é suficiente.
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
  version: MinecraftVersion,
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

  // --- Salvar metadados do servidor ---
  const metaPath = await join(serverPath, "cubeforge-meta.json");
  await writeTextFile(metaPath, JSON.stringify({ version, ramGb, createdAt: new Date().toISOString() }, null, 2));

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

    // Lê a versão dos metadados do CubeForge (cubeforge-meta.json)
    let version: string | null = null;
    const metaPath = await join(serverPath, "cubeforge-meta.json");
    if (await exists(metaPath)) {
      try {
        const metaContent = await readTextFile(metaPath);
        const meta = JSON.parse(metaContent) as { version?: string };
        version = meta.version ?? null;
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

    servers.push({ name: entry.name, path: serverPath, version });
  }

  return servers;
}
