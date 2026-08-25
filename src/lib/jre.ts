import { Command } from "@tauri-apps/plugin-shell";
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

  // 1. Get Download URL from Adoptium
  const response = await fetch(
    `https://api.adoptium.net/v3/binary/latest/${version}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`
  );
  
  if (!response.ok) throw new Error("Falha ao consultar a API da Adoptium");
  
  const downloadUrl = response.url;
  const tempZip = await join(runtimeDir, `jre-${version}.zip`);

  onProgress({ status: "Baixando Java (isso pode demorar)...", percent: 30 });

  // 2. Download and Extract using PowerShell (efficient and native)
  // We use PowerShell to avoid bringing big zip libraries to the frontend
  const psScript = `
    # Forçar codificação UTF-8 para evitar erros de decodificação no Tauri
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
    $ProgressPreference = 'SilentlyContinue'

    $url = "${downloadUrl}"
    $dest = "${tempZip}"
    $extractPath = "${jrePath}"
    
    if (Test-Path $extractPath) { Remove-Item -Recurse -Force $extractPath }
    New-Item -ItemType Directory -Path $extractPath | Out-Null
    
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    Expand-Archive -Path $dest -DestinationPath $extractPath -Force
    
    # Move files up if they are inside a subfolder in the zip
    $subfolder = Get-ChildItem -Path $extractPath | Where-Object { $_.PSIsContainer } | Select-Object -First 1
    if ($subfolder) {
      Move-Item -Path "$($subfolder.FullName)\\*" -Destination $extractPath -Force
      Remove-Item -Path $subfolder.FullName -Recurse -Force
    }
    
    Remove-Item -Path $dest -Force
    Write-Output "JRE instalado com sucesso."
  `;

  const command = Command.create("powershell", ["-Command", psScript]);
  
  onProgress({ status: "Instalando e extraindo...", percent: 70 });
  
  const output = await command.execute();

  if (output.code !== 0) {
    console.error(output.stderr);
    // Não deixar um zip parcial ou uma pasta de JRE pela metade entre tentativas —
    // sem isso, a tentativa seguinte podia herdar lixo do download interrompido.
    await remove(tempZip, { recursive: false }).catch(() => {});
    await remove(jrePath, { recursive: true }).catch(() => {});
    throw new Error(`Erro na instalação do JRE: ${output.stderr}`);
  }

  onProgress({ status: "Java instalado com sucesso!", percent: 100 });
}
