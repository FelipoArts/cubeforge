// ============================================================
// Painel Web Remoto (Cubicase Plus) — Fase 0 + Fase 1
// ============================================================
// Ver plans/remote-web-panel-plan.md para o desenho completo. Este módulo é
// o lado "agent" do protocolo: conecta (sempre de dentro pra fora, contorna
// CGNAT/firewall igual ao tsnet) no Durable Object HostChannel do Worker
// (api/src/durable-objects/host-channel.ts) e envia status/console/lista de
// servidores locais em tempo real — só leitura nesta fase, nenhum comando
// vindo do painel é executado ainda (a rota de mensagens já existe do lado
// do relay, mas o loop abaixo só ignora o que chega).
//
// Autenticação: usa um `device_token` (não é sessão de usuário) persistido
// em `panel_device.json` na pasta de dados do app — o mesmo arquivo é
// escrito pelo frontend (src/lib/panelDevice.ts) depois de registrar o
// dispositivo no Supabase com a sessão do usuário logado. Mesmo padrão já
// usado pelo `network_session.json` (ver CLAUDE.md): arquivo local lido
// pelo backend, sem o Rust precisar falar com o Supabase diretamente.
//
// Só conecta enquanto: (a) o arquivo do dispositivo existe, e (b) esta
// instalação está hospedando pela rede mesh (active_network_mode == "host").
// Não tenta adivinhar se a assinatura Plus está ativa — isso é responsabilidade
// do Durable Object (ver verifyDeviceToken em host-channel.ts), que fecha a
// conexão se a assinatura tiver expirado mesmo com o device_token válido.
// ============================================================

use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Listener, Manager};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::{log_to_file, AppState};

const PANEL_RELAY_WS_BASE: &str = "wss://cubeforge-api.cubeforge.workers.dev/panel/ws";
// 2s, 5s, 10s, 30s (máx) — mesma progressão descrita no plano, em vez de
// backoff exponencial puro (que demoraria demais pra tentar de novo em
// quedas curtas de rede, comuns num link doméstico).
const BACKOFF_STEPS_SECS: [u64; 4] = [2, 5, 10, 30];
const NO_DEVICE_RETRY_SECS: u64 = 5;
const STATUS_HEARTBEAT_SECS: u64 = 20;

#[derive(Deserialize, Clone)]
struct PanelDeviceFile {
    id: String,
    device_token: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalServerSummary {
    id: String,
    name: String,
    version: String,
    server_type: String,
    description: String,
    status: String, // "running" | "stopped"
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn load_panel_device(app: &AppHandle) -> Option<PanelDeviceFile> {
    let data_dir = app.path().app_local_data_dir().ok()?;
    let content = std::fs::read_to_string(data_dir.join("panel_device.json")).ok()?;
    serde_json::from_str(&content).ok()
}

fn is_hosting(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let mode = state.active_network_mode.lock().unwrap_or_else(|e| e.into_inner());
    mode.as_deref() == Some("host")
}

/// Réplica em Rust de listLocalServers (src/lib/server.ts) — o agent roda no
/// backend e não pode depender da webview estar carregada para saber quais
/// servidores existem localmente na pasta CubicaseServers.
fn scan_local_servers(app: &AppHandle) -> Vec<LocalServerSummary> {
    let mut servers = Vec::new();
    let Ok(docs_dir) = app.path().document_dir() else {
        return servers;
    };
    let Ok(entries) = std::fs::read_dir(docs_dir.join("CubicaseServers")) else {
        return servers;
    };

    let state = app.state::<AppState>();
    let active_dir = state
        .active_server_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let has_running_process = state
        .minecraft_process
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();

        let mut version = "desconhecida".to_string();
        let mut server_type = "vanilla".to_string();
        let mut description = String::new();
        let mut id = name.clone();

        if let Ok(content) = std::fs::read_to_string(path.join("cubicase-meta.json")) {
            if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(v) = meta.get("version").and_then(|v| v.as_str()) {
                    version = v.to_string();
                }
                if let Some(v) = meta.get("serverType").and_then(|v| v.as_str()) {
                    server_type = v.to_string();
                }
                if let Some(v) = meta.get("description").and_then(|v| v.as_str()) {
                    description = v.to_string();
                }
                if let Some(v) = meta.get("uuid").and_then(|v| v.as_str()) {
                    id = v.to_string();
                }
            }
        }

        let path_str = path.to_string_lossy().to_string();
        let is_running = has_running_process && active_dir.as_deref() == Some(path_str.as_str());

        servers.push(LocalServerSummary {
            id,
            name,
            version,
            server_type,
            description,
            status: if is_running { "running".into() } else { "stopped".into() },
        });
    }

    servers
}

fn build_status_message(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let running = state
        .minecraft_process
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    let player_count = state
        .minecraft_online_players
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .len() as u32;
    let server_name = state
        .active_server_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|n| n.to_string_lossy().to_string());

    serde_json::json!({
        "type": "status",
        "serverRunning": running,
        "serverName": server_name,
        "playerCount": player_count,
        // Fixo por enquanto — igual à mesma simplificação já adotada em
        // plans/network-server-separation-plan.md (não há RCON/consulta de
        // estado disponível para ler o valor real do server.properties aqui).
        "maxPlayers": 20,
        "ts": now_iso(),
    })
    .to_string()
}

fn build_server_list_message(app: &AppHandle) -> String {
    serde_json::json!({ "type": "server_list", "servers": scan_local_servers(app) }).to_string()
}

async fn run_agent_connection(app: &AppHandle, device: &PanelDeviceFile) -> Result<(), String> {
    let url = format!("{}/{}?role=agent", PANEL_RELAY_WS_BASE, device.id);
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let auth_value = HeaderValue::from_str(&format!("Bearer {}", device.device_token))
        .map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", auth_value);

    let (ws_stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    log_to_file(app, "[PANEL] Conectado ao painel web remoto.");
    let (mut write, mut read) = ws_stream.split();

    // Canal interno: os listeners de evento (chamados de forma síncrona pelo
    // Tauri) só empilham a mensagem aqui; quem realmente escreve no
    // WebSocket é o loop principal abaixo, que também lê mensagens
    // recebidas — evita ter duas tasks concorrentes escrevendo no mesmo
    // sink do WebSocket.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let tx_log = tx.clone();
    let unlisten_log = app.listen("minecraft-log", move |event| {
        if let Ok(line) = serde_json::from_str::<String>(event.payload()) {
            let msg = serde_json::json!({ "type": "log_line", "line": line, "ts": now_iso() }).to_string();
            let _ = tx_log.send(msg);
        }
    });

    // Reenvia status E lista de servidores em toda transição (iniciar,
    // parar, crashar) — sem isso, o painel só saberia que outro servidor
    // ficou disponível/indisponível no próximo reconnect, porque o snapshot
    // de server_list logo abaixo só roda uma vez, ao abrir a conexão.
    let app_for_status = app.clone();
    let tx_status = tx.clone();
    let unlisten_status = app.listen("minecraft-status-changed", move |_event| {
        let _ = tx_status.send(build_status_message(&app_for_status));
        let _ = tx_status.send(build_server_list_message(&app_for_status));
    });

    // Snapshot inicial assim que conecta, sem esperar o primeiro heartbeat.
    let _ = tx.send(build_status_message(app));
    let _ = tx.send(build_server_list_message(app));

    let mut heartbeat = tokio::time::interval(Duration::from_secs(STATUS_HEARTBEAT_SECS));
    heartbeat.tick().await; // o primeiro tick é imediato; o snapshot acima já cobriu isso

    let result = loop {
        tokio::select! {
            outgoing = rx.recv() => {
                match outgoing {
                    Some(msg) => {
                        if let Err(e) = write.send(Message::Text(msg.into())).await {
                            break Err(e.to_string());
                        }
                    }
                    None => break Ok(()), // nunca deveria acontecer (tx segue vivo no escopo desta função)
                }
            }
            _ = heartbeat.tick() => {
                let _ = tx.send(build_status_message(app));
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break Ok(()),
                    // Fase 2 vai interpretar "command"/"start_server" aqui.
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break Err(e.to_string()),
                }
            }
        }
    };

    app.unlisten(unlisten_log);
    app.unlisten(unlisten_status);
    result
}

/// Chamado uma vez em `run()` — mantém uma tentativa de conexão viva em
/// segundo plano pela vida inteira do processo, sem bloquear o startup do
/// app (não há nada pra esperar aqui: sem dispositivo pareado ou sem estar
/// hospedando, o loop só fica de prontidão verificando de novo a cada
/// alguns segundos).
pub fn spawn_panel_agent(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff_index = 0usize;
        loop {
            let device = load_panel_device(&app).filter(|_| is_hosting(&app));

            let Some(device) = device else {
                tokio::time::sleep(Duration::from_secs(NO_DEVICE_RETRY_SECS)).await;
                continue;
            };

            match run_agent_connection(&app, &device).await {
                Ok(()) => {
                    backoff_index = 0;
                }
                Err(e) => {
                    let wait = BACKOFF_STEPS_SECS[backoff_index.min(BACKOFF_STEPS_SECS.len() - 1)];
                    log_to_file(
                        &app,
                        &format!(
                            "[PANEL] Conexão com o painel web caiu ({}). Tentando de novo em {}s.",
                            e, wait
                        ),
                    );
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    backoff_index = (backoff_index + 1).min(BACKOFF_STEPS_SECS.len() - 1);
                    continue;
                }
            }

            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}
