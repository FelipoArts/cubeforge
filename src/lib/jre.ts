import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, remove } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type JREVersion = 8 | 17 | 21 | 25;

export interface DownloadProgress {
  status: string;
  percent: number;
}

export async function getJREPath(version: JREVersion): Promise<string> {
  const dataDir = await appLocalDataDir();
  return await join(dataDir, "runtime", `java-${version}`);
}

export async function isJREInstalled(version: JREVersion): Promise<boolean> {
  const jrePath = await getJREPath(version);
  const javaExe = await join(jrePath, "bin", "java.exe");
  return await exists(javaExe);
}

const MAX_INSTALL_ATTEMPTS = 3;

export async function installJRE(
  version: JREVersion,
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_INSTALL_ATTEMPTS; attempt++) {
    try {
      await installJREOnce(version, onProgress, attempt, MAX_INSTALL_ATTEMPTS);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[JRE] Tentativa ${attempt}/${MAX_INSTALL_ATTEMPTS} falhou:`, err);
      if (attempt < MAX_INSTALL_ATTEMPTS) {
        onProgress({ status: `Falha no download, tentando novamente (${attempt}/${MAX_INSTALL_ATTEMPTS})...`, percent: 5 });
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }
  throw new Error(`Falha ao instalar a JRE ${version} após ${MAX_INSTALL_ATTEMPTS} tentativas: ${lastErr}`);
}

async function installJREOnce(
  version: JREVersion,
  onProgress: (p: DownloadProgress) => void,
  attempt: number,
  maxAttempts: number
): Promise<void> {
  const jrePath = await getJREPath(version);
  const runtimeDir = await join(await appLocalDataDir(), "runtime");

  if (!(await exists(runtimeDir))) {
    await mkdir(runtimeDir, { recursive: true });
  }

  const attemptSuffix = maxAttempts > 1 ? ` (tentativa ${attempt}/${maxAttempts})` : "";
  onProgress({ status: `Consultando API Adoptium...${attemptSuffix}`, percent: 10 });

  // 1. Resolve a URL de download e o checksum SHA256 esperado via API JSON da
  // Adoptium (em vez de só seguir o redirect do endpoint /binary/latest, que não
  // dá nenhum jeito de verificar integridade depois).
  const assetsResponse = await fetch(
    `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?vendor=eclipse&os=windows&architecture=x64&image_type=jdk`
  );

  if (!assetsResponse.ok) throw new Error("Falha ao consultar a API da Adoptium");

  const assets = (await assetsResponse.json()) as Array<{
    binary: { package: { link: string; checksum: string } };
  }>;
  const asset = assets[0];
  if (!asset) throw new Error("Nenhum build de JRE disponível na API da Adoptium para esta versão.");

  const downloadUrl = asset.binary.package.link;
  const expectedSha256 = asset.binary.package.checksum;
  const tempZip = await join(runtimeDir, `jre-${version}.zip`);

  onProgress({ status: "Baixando Java (isso pode demorar)...", percent: 30 });

  try {
    // 2. Download via Rust (reqwest), com verificação de SHA256 — mesmo comando
    // já usado para o server.jar, sem depender de PowerShell nem interpolar a
    // URL da resposta da API diretamente em um script.
    await invoke("download_server_jar", {
      url: downloadUrl,
      destPath: tempZip,
      expectedSha1: null,
      expectedSha256,
    });

    onProgress({ status: "Instalando e extraindo...", percent: 70 });

    // 3. Extração em Rust com proteção contra zip-slip (enclosed_name), e já
    // achata a pasta-raiz do JDK para dentro de jrePath.
    await invoke("extract_jre_zip", { zipPath: tempZip, extractPath: jrePath });
  } catch (err) {
    // Não deixar um zip parcial ou uma pasta de JRE pela metade entre tentativas —
    // sem isso, a tentativa seguinte podia herdar lixo do download interrompido.
    await remove(tempZip, { recursive: false }).catch(() => {});
    await remove(jrePath, { recursive: true }).catch(() => {});
    throw new Error(`Erro na instalação do JRE: ${err}`);
  }

  onProgress({ status: "Java instalado com sucesso!", percent: 100 });
}
