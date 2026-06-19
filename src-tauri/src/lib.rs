use std::sync::Mutex;
use std::fs::File;
use std::io::Write;
use std::time::Duration;
use serde::{Serialize, Deserialize};
use tauri::{Manager, Emitter};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

#[derive(Default)]
struct AppState {
    sidecar_process: Mutex<Option<CommandChild>>,
    is_mock_active: Mutex<bool>,
}

#[derive(Serialize, Deserialize)]
struct SidecarConfig {
    #[serde(rename = "authKey")]
    auth_key: String,
    hostname: String,
    mode: String,
    #[serde(rename = "targetIp", skip_serializing_if = "Option::is_none")]
    target_ip: Option<String>,
    #[serde(rename = "localPort")]
    local_port: u16,
}

#[derive(Serialize, Deserialize, Clone)]
struct NetworkSession {
    provider: String,
    credentials: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
struct TailscaleCredentials {
    #[serde(rename = "authKey")]
    auth_key: String,
    hostname: String,
}

#[derive(Serialize, Clone)]
struct NetworkStatusPayload {
    status: String,
    ip: Option<String>,
}

#[derive(Serialize, Clone)]
struct NetworkLogPayload {
    message: String,
    is_error: bool,
}

#[tauri::command]
async fn start_network_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mode: String,
    target_ip: Option<String>,
    local_port: u16,
) -> Result<(), String> {
    // 1. Parar qualquer nó que já esteja rodando
    stop_network_node_internal(&app, &state).await?;

    // 2. Tentar obter a sessão de rede (NetworkSession)
    let api_url = "https://api.cubeforge.dev/network/session";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let mut session: Option<NetworkSession> = None;

    // Tenta obter via chamada HTTP para a API Central
    if let Ok(res) = client.get(api_url).send().await {
        if res.status().is_success() {
            if let Ok(json_session) = res.json::<NetworkSession>().await {
                session = Some(json_session);
            }
        }
    }

    // Fallback: Procura o arquivo local `network_session.json` se a API falhar.
    // Durante `tauri dev`, o binário roda de src-tauri/, então também buscamos
    // no diretório pai (raiz do projeto) e no diretório do executável.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if session.is_none() {
        let file_name = "network_session.json";

        // 1. Diretório de trabalho atual (raiz em produção, src-tauri/ em dev)
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join(file_name));
            // 2. Diretório pai do cwd (raiz do projeto em dev)
            if let Some(parent) = cwd.parent() {
                candidates.push(parent.join(file_name));
            }
        }

        // 3. Diretório do executável (útil em produção)
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                candidates.push(exe_dir.join(file_name));
            }
        }

        // 4. AppData local (configuração persistente do usuário)
        if let Ok(data_dir) = app.path().app_local_data_dir() {
            candidates.push(data_dir.join(file_name));
        }

        // Tenta cada candidato em ordem
        for path in &candidates {
            if path.exists() {
                if let Ok(file_content) = std::fs::read_to_string(path) {
                    if let Ok(json_session) = serde_json::from_str::<NetworkSession>(&file_content) {
                        log::info!("network_session.json carregado de: {:?}", path);
                        session = Some(json_session);
                        break;
                    }
                }
            }
        }
    }

    // Se falhar a API e o fallback, retorna a mensagem de erro amigável com diagnóstico
    let session = match session {
        Some(s) => s,
        None => {
            let mut tried_info = Vec::new();
            if let Ok(cwd) = std::env::current_dir() {
                tried_info.push(format!("cwd: {:?}", cwd));
            } else {
                tried_info.push("cwd: failed".to_string());
            }
            for (i, path) in candidates.iter().enumerate() {
                let exists = path.exists();
                let mut read_ok = false;
                let mut parse_ok = false;
                if exists {
                    if let Ok(file_content) = std::fs::read_to_string(path) {
                        read_ok = true;
                        if serde_json::from_str::<NetworkSession>(&file_content).is_ok() {
                            parse_ok = true;
                        }
                    }
                }
                tried_info.push(format!("cand{}: {:?} (exists={}, read={}, parse={})", i, path, exists, read_ok, parse_ok));
            }
            return Err(format!(
                "Não foi possível conectar ao servidor de autenticação do CubeForge. Verifique sua conexão. [DIAGNOSTICO: {}]",
                tried_info.join(" | ")
            ));
        }
    };

    // 3. Execução baseada no Provedor de Rede (Network Provider)
    if session.provider == "tailscale" {
        // Parsear as credenciais do Tailscale
        let creds: TailscaleCredentials = serde_json::from_value(session.credentials)
            .map_err(|e| format!("Credenciais do provedor Tailscale inválidas: {}", e))?;

        // Criar pasta local de dados se não existir
        let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

        // Gravar arquivo de configuração temporário
        let config_path = data_dir.join("tsnet_config.json");
        let config = SidecarConfig {
            auth_key: creds.auth_key,
            hostname: creds.hostname,
            mode,
            target_ip,
            local_port,
        };
        
        let config_json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
        let mut file = File::create(&config_path).map_err(|e| e.to_string())?;
        file.write_all(config_json.as_bytes()).map_err(|e| e.to_string())?;

        // Iniciar o sidecar Go tsnet-node
        let shell = app.shell();
        let config_path_str = config_path.to_string_lossy().to_string();
        let (mut rx, child) = shell
            .sidecar("tsnet-node")
            .map_err(|e| e.to_string())?
            .args(["--config", &config_path_str])
            .spawn()
            .map_err(|e| e.to_string())?;

        // Guardar o processo filho no estado global
        *state.sidecar_process.lock().unwrap() = Some(child);

        // Escutar eventos do sidecar
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes).to_string();
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        
                        // Parsear status do sidecar Go
                        if trimmed.starts_with('{') && trimmed.contains("\"status\"") {
                            if let Ok(status_val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                                if let Some(status_str) = status_val.get("status").and_then(|v| v.as_str()) {
                                    if status_str == "online" {
                                        let ip_str = status_val.get("ip").and_then(|v| v.as_str()).map(|s| s.to_string());
                                        let _ = app_clone.emit("network-status", NetworkStatusPayload {
                                            status: "online".to_string(),
                                            ip: ip_str,
                                        });
                                    }
                                }
                            }
                        }
                        
                        // Filtrar logs técnicos poluídos do Tailscale na interface, repassando logs informativos
                        let display_message = if trimmed.contains("magicsock:") || trimmed.contains("control:") || trimmed.contains("derp:") {
                            // Suprime logs muito detalhados de debug do Tailscale
                            "".to_string()
                        } else {
                            trimmed.to_string()
                        };

                        if !display_message.is_empty() {
                            let _ = app_clone.emit("network-log", NetworkLogPayload {
                                message: display_message,
                                is_error: false,
                            });
                        }
                    }
                    CommandEvent::Stderr(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes).to_string();
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            let _ = app_clone.emit("network-log", NetworkLogPayload {
                                message: trimmed.to_string(),
                                is_error: true,
                            });
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let _ = app_clone.emit("network-status", NetworkStatusPayload {
                            status: "offline".to_string(),
                            ip: None,
                        });
                        let _ = app_clone.emit("network-log", NetworkLogPayload {
                            message: format!("Conexão de rede encerrada (Código: {:?})", payload.code),
                            is_error: true,
                        });
                    }
                    _ => {}
                }
            }
        });
    } else if session.provider == "mock" {
        // Implementação do provedor simulado (Mock) para fins de teste sem internet ou Tailscale
        *state.is_mock_active.lock().unwrap() = true;

        let app_clone = app.clone();
        let fake_ip = session.credentials.get("fakeIp")
            .and_then(|v| v.as_str())
            .unwrap_or("100.99.99.99")
            .to_string();

        tauri::async_runtime::spawn(async move {
            let _ = app_clone.emit("network-log", NetworkLogPayload {
                message: "[mock-provider] Inicializando provedor de testes (Mock)...".to_string(),
                is_error: false,
            });
            tokio::time::sleep(Duration::from_millis(600)).await;
            
            let _ = app_clone.emit("network-log", NetworkLogPayload {
                message: "[mock-provider] Autenticando nó virtual de rede mesh simulado...".to_string(),
                is_error: false,
            });
            tokio::time::sleep(Duration::from_millis(800)).await;

            let _ = app_clone.emit("network-log", NetworkLogPayload {
                message: format!("[mock-provider] Nó registrado com IP virtual simulado: {}", fake_ip),
                is_error: false,
            });
            let _ = app_clone.emit("network-log", NetworkLogPayload {
                message: format!("[mock-provider] Proxy reverso simulado escutando em localhost:{}", local_port),
                is_error: false,
            });

            let _ = app_clone.emit("network-status", NetworkStatusPayload {
                status: "online".to_string(),
                ip: Some(fake_ip),
            });
        });
    } else {
        return Err(format!("Provedor de rede '{}' não é suportado na versão atual.", session.provider));
    }

    Ok(())
}

async fn stop_network_node_internal(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    // 1. Tratar limpeza do provedor simulado Mock
    // IMPORTANTE: O MutexGuard não é `Send` e não pode ser mantido vivo
    // durante um `.await`. Por isso, extraímos o valor e liberamos o lock
    // dentro de um bloco de escopo `{ }` antes de qualquer ponto de suspensão.
    let was_mock_active = {
        let mut mock_active = state.is_mock_active.lock().unwrap();
        let was_active = *mock_active;
        *mock_active = false; // Desativa o mock e libera o guard ao sair do bloco
        was_active
    };

    if was_mock_active {
        let _ = app.emit("network-log", NetworkLogPayload {
            message: "[mock-provider] Finalizando sessão simulada...".to_string(),
            is_error: false,
        });
        tokio::time::sleep(Duration::from_millis(200)).await; // Guard já foi liberado, seguro!
        let _ = app.emit("network-log", NetworkLogPayload {
            message: "[mock-provider] Rede mesh simulada encerrada.".to_string(),
            is_error: false,
        });
    }

    // 2. Tratar limpeza do processo do provedor Tailscale
    // Mesmo padrão: extrair e liberar o guard antes de qualquer operação assíncrona
    let child_to_kill = {
        let mut process = state.sidecar_process.lock().unwrap();
        process.take() // Remove o processo do estado e libera o guard
    };
    if let Some(child) = child_to_kill {
        let _ = child.kill();
    }

    // 3. Remover arquivo JSON de credenciais temporárias do Tailscale
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let config_path = data_dir.join("tsnet_config.json");
    if config_path.exists() {
        let _ = std::fs::remove_file(&config_path);
    }

    // 4. Emitir status offline
    let _ = app.emit("network-status", NetworkStatusPayload {
        status: "offline".to_string(),
        ip: None,
    });

    Ok(())
}

#[tauri::command]
async fn stop_network_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    stop_network_node_internal(&app, &state).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_process::init())
    .manage(AppState::default())
    .invoke_handler(tauri::generate_handler![start_network_node, stop_network_node])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Destroyed = event {
        let app = window.app_handle();
        let state = app.state::<AppState>();
        
        // 1. Matar processo do sidecar
        let mut process = state.sidecar_process.lock().unwrap();
        if let Some(child) = process.take() {
          let _ = child.kill();
        }
        
        // 2. Remover arquivo JSON temporário
        if let Ok(data_dir) = app.path().app_local_data_dir() {
          let config_path = data_dir.join("tsnet_config.json");
          if config_path.exists() {
            let _ = std::fs::remove_file(&config_path);
          }
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
