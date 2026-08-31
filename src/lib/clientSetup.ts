import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { remove } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { getJavaVersion } from "@/lib/server";
import { getJREPath, isJREInstalled, installJRE, type DownloadProgress } from "@/lib/jre";

// ============================================================
// clientSetup — instalação automática do mod loader no CLIENTE do
// convidado (não confundir com installForgeServer/installFabricServer em
// server.ts, que instalam o lado do servidor no host).
//
// Fabric: qualquer build recente do loader serve (é desenhado pra ser
// compatível entre versões), então usamos sempre a mais recente estável —
// não depende de saber a build exata que o host está usando.
//
// Forge/NeoForge: ao contrário do Fabric, builds diferentes quebram
// compatibilidade com frequência — por isso aqui a versão exata (KnownServer.
// forgeVersion, vinda da API Central) é obrigatória, não "a mais recente".
// ============================================================

export interface ClientSetupProgress {
  status: string;
  percent: number;
}

/**
 * Pasta de instância isolada para os mods/config/saves de um servidor
 * específico (mesmo modelo do CurseForge: versions/libraries continuam
 * compartilhados dentro do .minecraft real, só o conteúdo do modpack em si
 * fica isolado por servidor, pra dois servidores Forge/Fabric diferentes não
 * colidirem na mesma pasta mods/ compartilhada).
 */
export async function getInstanceDir(shortCode: string): Promise<string> {
  return await join(await appLocalDataDir(), "client_instances", shortCode);
}

interface FabricInstallerVersion {
  version: string;
  stable: boolean;
}

/** Verifica se já existe um Fabric Loader instalado para essa versão do Minecraft. */
export async function findInstalledFabricVersion(mcVersion: string): Promise<string | null> {
  const installed = await invoke<string[]>("find_installed_minecraft_versions").catch(() => [] as string[]);
  const suffix = `-${mcVersion}`;
  return installed.find(v => v.startsWith("fabric-loader-") && v.endsWith(suffix)) ?? null;
}

async function getLatestFabricInstallerVersion(): Promise<string> {
  const res = await fetch("https://meta.fabricmc.net/v2/versions/installer");
  if (!res.ok) throw new Error(`Falha ao consultar o instalador do Fabric (HTTP ${res.status}).`);
  const versions = await res.json() as FabricInstallerVersion[];
  const chosen = versions.find(v => v.stable) ?? versions[0];
  if (!chosen) throw new Error("Nenhuma versão do instalador do Fabric disponível no momento.");
  return chosen.version;
}

/**
 * Instala o Fabric Loader no cliente Minecraft do convidado (se ainda não
 * estiver instalado) e retorna o ID da versão resultante (ex:
 * "fabric-loader-0.16.9-1.20.1"), pronto para passar a
 * `prepare_launcher_profile`.
 *
 * Não mexe em mods (isso é Fase 4) nem em launcher_profiles.json (isso é
 * responsabilidade de `prepare_launcher_profile`, chamado separadamente
 * depois com o ID retornado aqui).
 */
export async function installFabricClient(
  mcVersion: string,
  onProgress: (p: ClientSetupProgress) => void
): Promise<string> {
  const already = await findInstalledFabricVersion(mcVersion);
  if (already) {
    onProgress({ status: "Fabric já instalado.", percent: 100 });
    return already;
  }

  onProgress({ status: "Verificando o Java...", percent: 5 });
  const javaVer = getJavaVersion(mcVersion);
  if (!(await isJREInstalled(javaVer))) {
    await installJRE(javaVer, (p: DownloadProgress) => {
      // Download do Java ocupa a faixa 5%-35% do progresso total dessa etapa.
      onProgress({ status: p.status, percent: 5 + p.percent * 0.3 });
    });
  }
  const jrePath = await getJREPath(javaVer);
  const javaExe = await join(jrePath, "bin", "java.exe");

  onProgress({ status: "Buscando o instalador do Fabric...", percent: 38 });
  const installerVersion = await getLatestFabricInstallerVersion();
  const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`;

  const tempDir = await join(await appLocalDataDir(), "temp");
  const installerPath = await join(tempDir, `fabric-installer-${installerVersion}.jar`);

  onProgress({ status: "Baixando o instalador do Fabric...", percent: 45 });
  await invoke("download_server_jar", { url: installerUrl, destPath: installerPath, expectedSha1: null, expectedSha256: null });

  onProgress({ status: "Instalando o Fabric no seu Minecraft (pode levar um minuto)...", percent: 60 });
  const versionId = await invoke<string>("run_fabric_client_installer", {
    javaPath: javaExe,
    installerPath,
    mcVersion,
  });

  await remove(installerPath).catch(() => {});

  onProgress({ status: "Fabric instalado!", percent: 100 });
  return versionId;
}

/** Verifica se já existe uma instalação client do Forge/NeoForge pra essa build exata. */
export async function findInstalledForgeVersion(forgeVersion: string): Promise<string | null> {
  const installed = await invoke<string[]>("find_installed_minecraft_versions").catch(() => [] as string[]);
  return installed.find(v => v.includes(forgeVersion)) ?? null;
}

function forgeInstallerUrl(provider: "forge" | "neoforge", mcVersion: string, forgeVersion: string): string {
  // NeoForge usa um esquema de versão próprio que já embute a versão do
  // Minecraft (ex: "21.1.63") — diferente do Forge, que precisa do prefixo
  // "<mcVersion>-" explícito na URL.
  if (provider === "neoforge") {
    return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${forgeVersion}/neoforge-${forgeVersion}-installer.jar`;
  }
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`;
}

/**
 * Instala o Forge/NeoForge no cliente Minecraft do convidado (se ainda não
 * estiver instalado nessa build exata) e retorna o ID da versão resultante,
 * pronto para passar a `prepare_launcher_profile`.
 *
 * `forgeVersion` precisa ser a build EXATA que o host está rodando (não "a
 * mais recente" como no Fabric) — vem de `KnownServer.forgeVersion`. Se o
 * servidor não tiver essa informação (registrado antes da API Central passar
 * a expor forgeVersion, por exemplo), a chamada deve nem acontecer — quem
 * chama essa função é responsável por checar isso antes.
 */
export async function installForgeClient(
  provider: "forge" | "neoforge",
  mcVersion: string,
  forgeVersion: string,
  onProgress: (p: ClientSetupProgress) => void
): Promise<string> {
  const label = provider === "neoforge" ? "NeoForge" : "Forge";

  const already = await findInstalledForgeVersion(forgeVersion);
  if (already) {
    onProgress({ status: `${label} já instalado.`, percent: 100 });
    return already;
  }

  onProgress({ status: "Verificando o Java...", percent: 5 });
  const javaVer = getJavaVersion(mcVersion);
  if (!(await isJREInstalled(javaVer))) {
    await installJRE(javaVer, (p: DownloadProgress) => {
      onProgress({ status: p.status, percent: 5 + p.percent * 0.3 });
    });
  }
  const jrePath = await getJREPath(javaVer);
  const javaExe = await join(jrePath, "bin", "java.exe");

  onProgress({ status: `Baixando o instalador do ${label}...`, percent: 40 });
  const installerUrl = forgeInstallerUrl(provider, mcVersion, forgeVersion);
  const tempDir = await join(await appLocalDataDir(), "temp");
  const installerPath = await join(tempDir, `${provider}-installer-${forgeVersion}.jar`);
  await invoke("download_server_jar", { url: installerUrl, destPath: installerPath, expectedSha1: null, expectedSha256: null });

  onProgress({ status: `Instalando o ${label} no seu Minecraft (pode levar alguns minutos)...`, percent: 55 });
  const versionId = await invoke<string>("run_forge_client_installer", {
    javaPath: javaExe,
    installerPath,
    mcVersion,
    forgeVersion,
  });

  await remove(installerPath).catch(() => {});

  onProgress({ status: `${label} instalado!`, percent: 100 });
  return versionId;
}
