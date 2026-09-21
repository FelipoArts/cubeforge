// ============================================================
// Painel Web Remoto (Cubicase Plus) — espelho de servidores importados
// ============================================================
// panel_agent.rs (Rust) lista sozinho os servidores da pasta padrão
// (Documents/CubicaseServers), mas servidores IMPORTADOS de um caminho
// arbitrário só existem como uma lista de paths no store do Zustand
// (`importedServerPaths`, persistida no localStorage da webview) — o
// backend Rust não tem acesso a isso. Este módulo espelha essa lista num
// arquivo local (mesmo padrão de panel_device.json/network_session.json)
// toda vez que ela muda, pra o agent conseguir incluir esses servidores
// também na mensagem `server_list` do painel.
// ============================================================

import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export async function syncImportedServersMirror(paths: string[]): Promise<void> {
  try {
    const path = await join(await appLocalDataDir(), "imported_servers.json");
    await writeTextFile(path, JSON.stringify({ paths }, null, 2));
  } catch (err) {
    console.error("[panel] Falha ao espelhar servidores importados:", err);
  }
}
