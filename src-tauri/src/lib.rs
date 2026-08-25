use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::fs::File;
use std::io::{Write, BufRead, BufReader};
use std::time::{Duration, Instant};
use std::net::TcpStream;
use serde::{Serialize, Deserialize};
use serde_json;
use std::collections::HashMap;
use tauri::{Manager, Emitter};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use std::thread;
use std::path::PathBuf;
use sysinfo::{System, Pid};

// Módulos da nova arquitetura de rede (scaffold — serão integrados futuramente)
#[allow(dead_code)]
mod api_client;
#[allow(dead_code)]
mod session_manager;
#[allow(dead_code)]
mod provider_manager;
mod job_object;

fn log_to_file(app: &tauri::AppHandle, message: &str) {
    let timestamp = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        Err(_) => 0,
    };
    let formatted = format!("[UNIX:{}] {}\n", timestamp, message);

    // 1. Tenta gravar na pasta do executável (se tiver permissão)
    let mut written = false;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let log_path = exe_dir.join("cubeforge_debug.log");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                if file.write_all(formatted.as_bytes()).is_ok() {
                    written = true;
                }
            }
        }
    }

    // 2. Se falhar, grava no AppData
    if !written {
        if let Ok(data_dir) = app.path().app_local_data_dir() {
            let _ = std::fs::create_dir_all(&data_dir);
            let log_path = data_dir.join("cubeforge_debug.log");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                let _ = file.write_all(formatted.as_bytes());
            }
        }
    }
}

#[derive(Default)]
struct AppState {
    // Processo sidecar do Tailscale (tsnet-node)
    sidecar_process: Mutex<Option<CommandChild>>,
    is_mock_active: Mutex<bool>,

    // Mesmo padrão de minecraft_stop_requested abaixo, mas para o sidecar de rede:
    // diferencia "usuário pediu para desconectar" de "o sidecar morreu sozinho"
    // no handler de CommandEvent::Terminated, para não reportar uma desconexão
    // manual como se fosse um erro de rede na Central de Diagnósticos.
    network_stop_requested: AtomicBool,

    // Causa específica do último erro fatal do sidecar Go (auth inválida, sem
    // internet, hostname duplicado, porta ocupada, etc), extraída do JSON
    // estruturado `{"error": "<código>", "detail": "..."}` que o Go agora imprime
    // no stdout antes de sair. Guarda (título, mensagem) já traduzidos para o
    // usuário; consumida pelo handler de CommandEvent::Terminated para não
    // duplicar um segundo aviso genérico sobre o mesmo evento.
    network_last_error: Mutex<Option<(String, String)>>,

    // Processo do servidor Minecraft (java.exe)
    // stdin é guardado separadamente pois `std::process::Child` não é Clone
    minecraft_process: Mutex<Option<std::process::Child>>,
    minecraft_stdin: Mutex<Option<std::process::ChildStdin>>,
    
    // Flag atômica para saber se a parada foi solicitada pelo usuário
    // (diferencia parada limpa de crash). Usamos AtomicBool em vez de Mutex<bool>
    // para evitar qualquer potencial deadlock com o lock de minecraft_process.
    minecraft_stop_requested: AtomicBool,

    // Flag que indica se o servidor Minecraft já ficou online pelo menos uma vez
    // durante esta sessão. Usada pela thread de polling TCP para não emitir "crashed"
    // quando o servidor é parado após já ter ficado online (a thread de polling TCP
    // pode ainda estar rodando se nunca conseguiu conectar via TCP, mas o servidor
    // já foi detectado como online pelo stdout "Done (").
    minecraft_was_online: AtomicBool,

    // Causa específica do último crash detectada por padrões conhecidos no
    // stdout/stderr do processo Java (OutOfMemoryError, UnsupportedClassVersionError,
    // BindException, EULA não aceito, etc). Guarda (código, título, mensagem); é lida
    // e limpa pela thread de monitoramento ao detectar que o processo encerrou,
    // para emitir um diagnóstico específico em vez do "crashed" genérico.
    minecraft_last_error: Mutex<Option<(String, String, String)>>,

    // Evita rodar o shutdown gracioso (parar MC, parar mesh, notificar API) mais de
    // uma vez, caso o usuário clique "Sair" no tray mais de uma vez rapidamente.
    is_shutting_down: AtomicBool,

    // shortCode do servidor atualmente registrado na API Central (se houver).
    // Usado no shutdown gracioso para notificar a API de que o servidor ficou
    // offline mesmo quando o fechamento acontece antes de qualquer heartbeat do JS.
    active_short_code: Mutex<Option<String>>,

    // Última amostra de RAM/CPU do sistema (e do processo java.exe), atualizada
    // pela thread de amostragem periódica enquanto o servidor está rodando.
    // Usada tanto para o evento "mc-resource-sample" (indicador de saúde na UI)
    // quanto para enriquecer o diagnóstico de crash com o retrato de hardware
    // pouco antes do problema (ver ResourceSample).
    minecraft_last_resource_sample: Mutex<Option<ResourceSample>>,
}

/// Retrato de RAM/CPU do sistema (e do processo do servidor) em um instante,
/// usado para diferenciar "pouca RAM alocada mas o PC tem de sobra" de
/// "o computador não tem RAM/CPU suficiente" nos diagnósticos de OOM e lag.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceSample {
    total_ram_mb: u64,
    available_ram_mb: u64,
    cpu_usage_percent: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_ram_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_cpu_percent: Option<f32>,
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

/// Traduz o código de erro estruturado emitido pelo sidecar Go (ver main.go,
/// função fatalWithCode) para um título/mensagem amigáveis em PT-BR.
fn map_sidecar_error_code(code: &str, detail: &str) -> (String, String) {
    match code {
        "config_missing" | "config_read_failed" | "config_decode_failed" => (
            "Configuração de rede inválida".to_string(),
            "Não foi possível ler a configuração da rede mesh. Tente reiniciar o app; se persistir, reinstale o Cubicase.".to_string(),
        ),
        "mesh_auth_failed" => (
            "Falha de autenticação na rede mesh".to_string(),
            "Não foi possível autenticar na rede mesh (Tailscale). Verifique sua conexão com a internet e tente novamente.".to_string(),
        ),
        "no_ip_assigned" => (
            "Nenhum IP atribuído pela rede mesh".to_string(),
            "A rede mesh não atribuiu um endereço para este dispositivo. Tente reconectar em alguns instantes.".to_string(),
        ),
        "listen_mesh_failed" => (
            "Falha ao abrir a porta na rede mesh".to_string(),
            "Não foi possível abrir a porta do servidor na rede mesh. Tente reconectar; se persistir, pode haver conflito de hostname na malha.".to_string(),
        ),
        "listen_local_failed" => (
            "Porta local já em uso".to_string(),
            format!("Não foi possível abrir a porta local necessária para a conexão — provavelmente já está em uso por outro programa. Detalhe técnico: {}", detail),
        ),
        other => (
            "Erro inesperado na rede mesh".to_string(),
            if detail.is_empty() {
                format!("Código: {}", other)
            } else {
                detail.to_string()
            },
        ),
    }
}

#[tauri::command]
async fn start_network_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mode: String,
    target_ip: Option<String>,
    local_port: u16,
) -> Result<(), String> {
    log_to_file(&app, &format!("=== INÍCIO DE CONEXÃO (Modo: {}, Porta Local: {}, IP Alvo: {:?}) ===", mode, local_port, target_ip));
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
                    match serde_json::from_str::<NetworkSession>(&file_content) {
                        Ok(json_session) => {
                            log_to_file(&app, &format!("network_session.json carregado com sucesso de: {:?}", path));
                            session = Some(json_session);
                            break;
                        }
                        Err(e) => {
                            log_to_file(&app, &format!("Falha ao parsear JSON em {:?}: {}", path, e));
                        }
                    }
                } else {
                    log_to_file(&app, &format!("Falha ao ler o arquivo em {:?}", path));
                }
            } else {
                log_to_file(&app, &format!("Candidato inexistente: {:?}", path));
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
            let err_msg = format!(
                "Não foi possível conectar ao servidor de autenticação do CubeForge. Verifique sua conexão. [DIAGNOSTICO: {}]",
                tried_info.join(" | ")
            );
            log_to_file(&app, &format!("Erro de inicialização: {}", err_msg));
            return Err(err_msg);
        }
    };

    // 3. Execução baseada no Provedor de Rede (Network Provider)
    if session.provider == "tailscale" {
        log_to_file(&app, "Iniciando provedor Tailscale...");
        // Parsear as credenciais do Tailscale
        let creds: TailscaleCredentials = serde_json::from_value(session.credentials)
            .map_err(|e| {
                let err_msg = format!("Credenciais do provedor Tailscale inválidas: {}", e);
                log_to_file(&app, &err_msg);
                err_msg
            })?;

        // Criar pasta local de dados se não existir
        let data_dir = app.path().app_local_data_dir().map_err(|e| {
            let err_msg = e.to_string();
            log_to_file(&app, &format!("Erro criando data_dir: {}", err_msg));
            err_msg
        })?;
        std::fs::create_dir_all(&data_dir).map_err(|e| {
            let err_msg = e.to_string();
            log_to_file(&app, &format!("Erro criando pastas em data_dir: {}", err_msg));
            err_msg
        })?;

        // Gravar arquivo de configuração temporário
        let config_path = data_dir.join("tsnet_config.json");
        let config = SidecarConfig {
            auth_key: creds.auth_key,
            hostname: creds.hostname,
            mode,
            target_ip: target_ip.clone(),
            local_port,
        };
        
        let config_json = serde_json::to_string(&config).map_err(|e| {
            let err_msg = e.to_string();
            log_to_file(&app, &format!("Erro serializando config: {}", err_msg));
            err_msg
        })?;
        let mut file = File::create(&config_path).map_err(|e| {
            let err_msg = e.to_string();
            log_to_file(&app, &format!("Erro criando tsnet_config: {}", err_msg));
            err_msg
        })?;
        file.write_all(config_json.as_bytes()).map_err(|e| {
            let err_msg = e.to_string();
            log_to_file(&app, &format!("Erro escrevendo tsnet_config: {}", err_msg));
            err_msg
        })?;

        // Iniciar o sidecar Go tsnet-node
        log_to_file(&app, "Iniciando sidecar tsnet-node...");
        let shell = app.shell();
        let config_path_str = config_path.to_string_lossy().to_string();
        let (mut rx, child) = shell
            .sidecar("tsnet-node")
            .map_err(|e| {
                let err_msg = e.to_string();
                log_to_file(&app, &format!("Erro ao criar sidecar: {}", err_msg));
                err_msg
            })?
            .args(["--config", &config_path_str])
            .spawn()
            .map_err(|e| {
                let err_msg = e.to_string();
                log_to_file(&app, &format!("Erro ao spawnar sidecar: {}", err_msg));
                err_msg
            })?;

        // Amarrar ao job object: se o app morrer (fechado ou finalizado à força),
        // o Windows mata este sidecar junto em vez de deixá-lo órfão.
        job_object::track_process(child.pid());

        // Guardar o processo filho no estado global
        *state.sidecar_process.lock().unwrap() = Some(child);

        // Escutar eventos do sidecar
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            log_to_file(&app_clone, "Iniciando escuta de eventos do sidecar.");
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes).to_string();
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        
                        log_to_file(&app_clone, &format!("[Sidecar-Stdout] {}", trimmed));
                        
                        // Parsear status do sidecar Go
                        if trimmed.starts_with('{') && trimmed.contains("\"status\"") {
                            if let Ok(status_val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                                if let Some(status_str) = status_val.get("status").and_then(|v| v.as_str()) {
                                    if status_str == "online" {
                                        let ip_str = status_val.get("ip").and_then(|v| v.as_str()).map(|s| s.to_string());
                                        log_to_file(&app_clone, &format!("Rede mesh online! IP virtual: {:?}", ip_str));
                                        let _ = app_clone.emit("network-status", NetworkStatusPayload {
                                            status: "online".to_string(),
                                            ip: ip_str,
                                        });
                                    }
                                }
                            }
                        }

                        // Parsear erro fatal estruturado do sidecar Go (ver fatalWithCode em main.go).
                        // Diferente do "status", isso chega pouco antes do processo sair — guardamos
                        // a causa para o handler de Terminated usar em vez do aviso genérico.
                        if trimmed.starts_with('{') && trimmed.contains("\"error\"") {
                            if let Ok(err_val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                                if let Some(code) = err_val.get("error").and_then(|v| v.as_str()) {
                                    let detail = err_val.get("detail").and_then(|v| v.as_str()).unwrap_or("");
                                    let (title, message) = map_sidecar_error_code(code, detail);
                                    log_to_file(&app_clone, &format!("[Sidecar] Erro estruturado: código={}, detail={}", code, detail));
                                    *app_clone.state::<AppState>().network_last_error.lock().unwrap() =
                                        Some((title.clone(), message.clone()));
                                    let _ = app_clone.emit("network-diagnostic", DiagnosticPayload {
                                        level: "critical".to_string(),
                                        title,
                                        message,
                                        detail: if detail.is_empty() { None } else { Some(detail.to_string()) },
                                        code: Some(code.to_string()),
                                        crash_report_text: None,
                                        crash_report_file: None,
                                        resource_snapshot: None,
                                        allocated_ram_mb: None,
                                    });
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
                            log_to_file(&app_clone, &format!("[Sidecar-Stderr] {}", trimmed));
                            // O sidecar Go usa stderr para logs informativos próprios.
                            // Marcamos como is_error=false para não poluir a interface com [ERR].
                            // Mensagens verdadeiramente críticas (como falhas de conexão) são
                            // emitidas via stdout como JSON.
                            let _ = app_clone.emit("network-log", NetworkLogPayload {
                                message: trimmed.to_string(),
                                is_error: false,
                            });
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        log_to_file(&app_clone, &format!("[Sidecar-Terminated] Código: {:?}", payload.code));
                        let app_state = app_clone.state::<AppState>();
                        // Limpar o handle guardado no estado global — sem isso, get_system_status
                        // continua reportando a rede como "online" para sempre após o sidecar morrer.
                        *app_state.sidecar_process.lock().unwrap() = None;
                        // Diferenciar "usuário pediu para desconectar" (network_stop_requested)
                        // de "o sidecar morreu sozinho" (crash real) para não marcar uma
                        // desconexão manual como erro na Central de Diagnósticos.
                        let was_requested = app_state.network_stop_requested.swap(false, Ordering::SeqCst);
                        // Causa específica já reportada via "network-diagnostic" enquanto o
                        // sidecar ainda rodava (ver parsing do stdout acima)? Se sim, evitar
                        // duplicar um segundo aviso genérico sobre o mesmo evento.
                        let known_cause = app_state.network_last_error.lock().unwrap().take();
                        let _ = app_clone.emit("network-status", NetworkStatusPayload {
                            status: "offline".to_string(),
                            ip: None,
                        });
                        if was_requested {
                            let _ = app_clone.emit("network-log", NetworkLogPayload {
                                message: "Rede mesh desconectada.".to_string(),
                                is_error: false,
                            });
                        } else if let Some((title, _)) = known_cause {
                            let _ = app_clone.emit("network-log", NetworkLogPayload {
                                message: format!("Conexão de rede encerrada: {} (ver Central de Diagnósticos)", title),
                                is_error: false,
                            });
                        } else {
                            let _ = app_clone.emit("network-log", NetworkLogPayload {
                                message: format!("Conexão de rede encerrada inesperadamente (Código: {:?})", payload.code),
                                is_error: true,
                            });
                        }
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
    log_to_file(app, "=== PARANDO NÓ DE REDE ===");
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
    let had_child = child_to_kill.is_some();
    if let Some(child) = child_to_kill {
        // Marcar ANTES de matar o processo: o handler de CommandEvent::Terminated
        // roda em outra task assíncrona e precisa saber que esta morte foi solicitada.
        state.network_stop_requested.store(true, Ordering::SeqCst);
        let _ = child.kill();
    }

    // 3. Remover arquivo JSON de credenciais temporárias do Tailscale
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let config_path = data_dir.join("tsnet_config.json");
    if config_path.exists() {
        let _ = std::fs::remove_file(&config_path);
    }

    // 4. Emitir status offline apenas se havia um processo rodando
    //    (evita resetar isStarting no frontend durante start_network_node)
    if had_child {
        let _ = app.emit("network-status", NetworkStatusPayload {
            status: "offline".to_string(),
            ip: None,
        });
    }

    Ok(())
}

#[tauri::command]
async fn stop_network_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    stop_network_node_internal(&app, &state).await
}

// ============================================================
// Comandos de Gerenciamento do Servidor Minecraft
// ============================================================

/// Baixa o server.jar diretamente via reqwest em Rust.
/// Remove qualquer dependência de PowerShell para o download.
#[tauri::command]
async fn download_server_jar(url: String, dest_path: String, expected_sha1: Option<String>, expected_sha256: Option<String>) -> Result<(), String> {
    // Cria o diretório de destino se necessário (ex: pasta "mods"/"plugins" de um
    // servidor recém-criado, que só existe fisicamente quando o primeiro arquivo é
    // adicionado). A raiz do servidor já existe nos usos originais (server.jar/builds
    // do Paper), então isso é um no-op nesses casos.
    if let Some(parent) = std::path::Path::new(&dest_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    const MAX_ATTEMPTS: u32 = 3;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300)) // 5 minutos de timeout para arquivos grandes
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        let result: Result<(), String> = async {
            let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("Falha no download: HTTP {}", response.status()));
            }
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;

            // Verificar integridade contra o checksum esperado (SHA1 para o manifest da
            // Mojang, SHA256 para builds do PaperMC). Sem isso, um download
            // truncado/corrompido só era percebido bem depois, quando o servidor
            // falhava ao iniciar com um erro genérico e opaco.
            if let Some(expected) = &expected_sha1 {
                let mut hasher = sha1_smol::Sha1::new();
                hasher.update(&bytes);
                let actual = hasher.digest().to_string();
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(format!("Checksum SHA1 não confere (esperado {}, obtido {})", expected, actual));
                }
            }
            if let Some(expected) = &expected_sha256 {
                use sha2::{Digest, Sha256};
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                let actual = format!("{:x}", hasher.finalize());
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(format!("Checksum SHA256 não confere (esperado {}, obtido {})", expected, actual));
                }
            }

            let mut file = File::create(&dest_path).map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            Ok(())
        }.await;

        match result {
            Ok(()) => return Ok(()),
            Err(e) => {
                // Não deixar um arquivo truncado/corrompido no disco entre tentativas.
                let _ = std::fs::remove_file(&dest_path);
                last_err = e;
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt - 1))).await;
                }
            }
        }
    }

    Err(format!("Falha ao baixar após {} tentativas: {}", MAX_ATTEMPTS, last_err))
}

#[derive(Serialize, Clone)]
struct DiagnosticPayload {
    level: String, // "info" | "warning" | "error" | "critical"
    title: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    // Código estável (ex: "java_version_incompatible") para o frontend reagir
    // programaticamente (ex: disparar uma auto-correção) sem parsear o título/mensagem
    // em português, que pode mudar de texto sem aviso.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    // Texto bruto do crash-report novo (ou, na ausência dele, a cauda de
    // logs/latest.log) para o analisador de causas do frontend (crashAnalyzer.ts)
    // examinar padrões que uma única linha de stdout não revela (ex: conflito de mod).
    #[serde(rename = "crashReportText", skip_serializing_if = "Option::is_none")]
    crash_report_text: Option<String>,
    #[serde(rename = "crashReportFile", skip_serializing_if = "Option::is_none")]
    crash_report_file: Option<String>,
    // Retrato de RAM/CPU do sistema pouco antes do crash (última amostra da
    // thread de monitoramento de recursos) + quanto foi alocado (-Xmx) para o
    // servidor — permite ao frontend (resourceDiagnostics.ts) diferenciar
    // "aumente a RAM alocada" de "seu computador não tem RAM suficiente".
    #[serde(rename = "resourceSnapshot", skip_serializing_if = "Option::is_none")]
    resource_snapshot: Option<ResourceSample>,
    #[serde(rename = "allocatedRamMb", skip_serializing_if = "Option::is_none")]
    allocated_ram_mb: Option<u64>,
}

/// Reconhece padrões conhecidos de causa de crash em uma linha de stdout/stderr
/// do processo Java e retorna (código, título, mensagem) prontos para exibição
/// ao usuário — e para o frontend decidir se há uma auto-correção aplicável.
/// Retorna `None` se a linha não corresponder a nenhuma causa conhecida — nesse
/// caso o chamador cai no diagnóstico genérico de "crashed".
fn detect_known_mc_error(line: &str) -> Option<(String, String, String)> {
    if line.contains("OutOfMemoryError") || line.contains("Could not reserve enough space") {
        return Some((
            "out_of_memory".to_string(),
            "Sem memória suficiente (OutOfMemoryError)".to_string(),
            "O servidor Minecraft ficou sem memória durante a execução. Tente aumentar a RAM alocada nas configurações do servidor, ou feche outros programas para liberar memória.".to_string(),
        ));
    }
    if line.contains("UnsupportedClassVersionError") {
        return Some((
            "java_version_incompatible".to_string(),
            "Versão do Java incompatível".to_string(),
            "A versão do Java instalada não é compatível com esta versão do Minecraft. Reinstale a JRE recomendada para este servidor nas configurações.".to_string(),
        ));
    }
    if line.contains("Address already in use") || line.contains("BindException") {
        return Some((
            "port_in_use".to_string(),
            "Porta já em uso".to_string(),
            "Não foi possível abrir a porta do servidor porque ela já está sendo usada por outro processo. Fecha o processo ou altere a porta do servidor nas configurações.".to_string(),
        ));
    }
    if line.contains("You need to agree to the EULA") {
        return Some((
            "eula_not_accepted".to_string(),
            "EULA não aceito".to_string(),
            "O arquivo eula.txt não está marcado como aceito. Isso normalmente é feito automaticamente pelo Cubicase — se persistir, abra a pasta do servidor e defina eula=true em eula.txt.".to_string(),
        ));
    }
    None
}

/// Trunca uma string em um limite de caracteres (não bytes, para não quebrar
/// UTF-8) — usado para caber o texto de crash-reports/logs no payload do evento.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{}\n... (truncado)", truncated)
    }
}

/// Lê as últimas `max_lines` linhas de `<server_dir>/logs/latest.log`, usado
/// como fallback do crash-report quando o crash não gerou um (ex: crash nativo
/// da JVM antes do world carregar, ou OOM muito cedo na inicialização).
fn read_log_tail(server_dir: &str, max_lines: usize) -> Option<String> {
    let log_path = std::path::Path::new(server_dir).join("logs").join("latest.log");
    let content = std::fs::read_to_string(&log_path).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    Some(lines[start..].join("\n"))
}

/// Inicia o servidor Minecraft usando o Java instalado pelo CubeForge.
/// Redireciona stdout/stderr para eventos `minecraft-log`.
/// Usa polling TCP para detectar quando o servidor está realmente pronto
/// para aceitar conexões — independente de mensagens de log específicas.
#[tauri::command]
async fn start_minecraft_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server_dir: String,
    java_path: String,
    ram_gb: u32,
    local_port: u16,
    server_jar_name: Option<String>,  // "forge-1.20.1-47.1.0-shim.jar" para Forge (versões antigas)
    launch_args_dir: Option<String>,  // "libraries/net/minecraftforge/forge/1.20.1-47.1.0" para Forge/NeoForge modernos (1.17+), sem JAR único
) -> Result<(), String> {
    let jar_name = server_jar_name.unwrap_or_else(|| "server.jar".to_string());
    log_to_file(&app, &format!(
        "=== INICIANDO SERVIDOR MC (dir={}, porta={}, ram={}GB, jar={}, argsDir={:?}) ===",
        server_dir, local_port, ram_gb, jar_name, launch_args_dir
    ));

    // Parar qualquer servidor que já esteja rodando
    stop_minecraft_server_internal(&app, &state).await;

    // Construir argumentos do Java
    let mut args = vec![
        format!("-Xms512M"),
        format!("-Xmx{}G", ram_gb),
    ];
    if let Some(args_dir) = &launch_args_dir {
        // Forge/NeoForge 1.17+: não há JAR único, o instalador gera libraries/ + run.bat/run.sh
        // que invocam `java @user_jvm_args.txt @libraries/.../win_args.txt` (ver run.bat/run.sh gerados)
        let args_file_name = if cfg!(target_os = "windows") { "win_args.txt" } else { "unix_args.txt" };
        args.push("@user_jvm_args.txt".to_string());
        args.push(format!("@{}/{}", args_dir, args_file_name));
    } else {
        args.push("-jar".to_string());
        args.push(jar_name.clone());
    }
    args.push("nogui".to_string());

    log_to_file(&app, &format!("Executando: {} {:?}", java_path, args));

    // --- Checar porta ocupada ANTES de iniciar o processo ---
    // Lê a porta configurada em server.properties (cai para `local_port` se ausente/ilegível)
    // e testa se algo já está escutando nela. Se estiver, o Java vai falhar ao dar bind
    // (BindException) de qualquer forma — detectar isso antes evita subir o processo à toa
    // e permite uma mensagem de causa específica em vez do "crashed" genérico.
    let server_port = {
        let properties_path = format!("{}/server.properties", server_dir);
        match std::fs::read_to_string(&properties_path) {
            Ok(contents) => {
                let mut port_opt: Option<u16> = None;
                for line in contents.lines() {
                    if let Some(rest) = line.strip_prefix("server-port=") {
                        if let Ok(p) = rest.trim().parse::<u16>() {
                            port_opt = Some(p);
                            break;
                        }
                    }
                }
                port_opt.unwrap_or(local_port)
            }
            Err(_) => local_port,
        }
    };
    // Retry com backoff: é comum a porta aparecer "ocupada" por um instante logo após
    // parar um servidor anterior (socket ainda em TIME_WAIT) — sem isso, o usuário via
    // um erro de porta ocupada mesmo tendo acabado de clicar em "Parar" um segundo antes.
    // Só falha de verdade se continuar ocupada depois de todas as tentativas.
    const PORT_CHECK_ATTEMPTS: u32 = 4;
    let port_addr = format!("127.0.0.1:{}", server_port);
    if let Ok(parsed_addr) = port_addr.parse() {
        for attempt in 1..=PORT_CHECK_ATTEMPTS {
            if TcpStream::connect_timeout(&parsed_addr, Duration::from_millis(300)).is_err() {
                break; // Nada escutando na porta — livre para iniciar.
            }
            if attempt == PORT_CHECK_ATTEMPTS {
                let msg = format!(
                    "A porta {} já está em uso por outro processo. Pare-o ou altere a porta do servidor antes de iniciar.",
                    server_port
                );
                log_to_file(&app, &format!("[MC] Porta ocupada após {} tentativas, abortando início: {}", PORT_CHECK_ATTEMPTS, msg));
                return Err(msg);
            }
            log_to_file(&app, &format!("[MC] Porta {} ainda ocupada (tentativa {}/{}), aguardando...", server_port, attempt, PORT_CHECK_ATTEMPTS));
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
    }

    // Iniciar processo Java com stdin/stdout/stderr redirecionados
    let mut child = std::process::Command::new(&java_path)
        .args(&args)
        .current_dir(&server_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!("Falha ao iniciar Java: {}", e);
            log_to_file(&app, &msg);
            msg
        })?;

    // Amarrar ao job object: se o app morrer (fechado ou finalizado à força),
    // o Windows mata o servidor Minecraft junto em vez de deixá-lo órfão.
    job_object::track_process(child.id());
    // PID capturado aqui (antes de `child` ser movido pro Mutex abaixo) para a
    // thread de amostragem de recursos poder consultar o processo específico.
    let mc_pid = child.id();

    // Extrair stdin antes de mover `child` para o Mutex
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Guardar processo e stdin no estado global
    {
        state.minecraft_stop_requested.store(false, Ordering::SeqCst);
        *state.minecraft_stdin.lock().unwrap() = stdin;
        *state.minecraft_process.lock().unwrap() = Some(child);
        *state.minecraft_last_error.lock().unwrap() = None;
    }

    // --- Nomes dos crash-reports ANTES de o servidor iniciar ---
    // Guardamos os NOMES (não só a contagem) dos arquivos na pasta crash-reports
    // (se existir) para comparar quando o servidor fechar. Isso permite, além de
    // detectar que houve um crash, identificar QUAL arquivo é o novo e ler seu
    // conteúdo para o analisador de causas (crashAnalyzer.ts no frontend).
    let crash_reports_before: std::collections::HashSet<String> = {
        let crash_dir = std::path::Path::new(&server_dir).join("crash-reports");
        if crash_dir.exists() && crash_dir.is_dir() {
            match std::fs::read_dir(&crash_dir) {
                Ok(entries) => entries
                    .flatten()
                    .filter(|e| e.metadata().map(|m| m.is_file()).unwrap_or(false))
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect(),
                Err(_) => std::collections::HashSet::new(),
            }
        } else {
            std::collections::HashSet::new()
        }
    };
    log_to_file(&app, &format!("[MC] Contagem de crash-reports antes de iniciar: {}", crash_reports_before.len()));

    // --- Thread de leitura de stdout ---
    let app_stdout = app.clone();
    let state_stdout_handle = app.state::<AppState>().inner() as *const AppState as usize;
    if let Some(stdout_pipe) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout_pipe);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        log_to_file(&app_stdout, &format!("[MC-Stdout] {}", l));
                        let _ = app_stdout.emit("minecraft-log", &l);
                        let state_ref = unsafe { &*(state_stdout_handle as *const AppState) };
                        // Detect server ready line
                        if l.contains("Done (") && l.contains("INFO") {
                            // Marcar que o servidor ficou online (para a thread de polling TCP
                            // não emitir "crashed" quando o servidor for parado depois)
                            state_ref.minecraft_was_online.store(true, Ordering::SeqCst);
                            let _ = app_stdout.emit("minecraft-status-changed", "online");
                        }
                        // Guardar a causa raiz do crash (primeiro padrão reconhecido vence —
                        // erros em cascata depois costumam ser só consequência do primeiro).
                        if let Some(cause) = detect_known_mc_error(&l) {
                            let mut last_error = state_ref.minecraft_last_error.lock().unwrap();
                            if last_error.is_none() {
                                *last_error = Some(cause);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // --- Thread de leitura de stderr ---
    let app_stderr = app.clone();
    let state_stderr_handle = app.state::<AppState>().inner() as *const AppState as usize;
    if let Some(stderr_pipe) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr_pipe);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        log_to_file(&app_stderr, &format!("[MC-Stderr] {}", l));
                        let _ = app_stderr.emit("minecraft-log", &l);
                        if let Some(cause) = detect_known_mc_error(&l) {
                            let state_ref = unsafe { &*(state_stderr_handle as *const AppState) };
                            let mut last_error = state_ref.minecraft_last_error.lock().unwrap();
                            if last_error.is_none() {
                                *last_error = Some(cause);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // --- Rotina de polling TCP para detectar quando o servidor está online ---
    // Reusa `server_port` já resolvido acima (server.properties, com fallback em local_port).
    let app_tcp = app.clone();
    let state_tcp_handle = app.state::<AppState>().inner() as *const AppState as usize;
    tauri::async_runtime::spawn(async move {
        loop {
            // Verifica se o processo ainda está vivo
            let process_alive = {
                // SAFETY: o ponteiro é válido enquanto o AppState existir (vive todo o app)
                let state_ref = unsafe { &*(state_tcp_handle as *const AppState) };
                let mut guard = state_ref.minecraft_process.lock().unwrap();
                if let Some(ref mut child) = *guard {
                    matches!(child.try_wait(), Ok(None))
                } else {
                    false
                }
            };

            if !process_alive {
                // O processo morreu antes de conseguirmos conectar via TCP.
                // NÃO emitimos "crashed" aqui porque a thread de monitoramento
                // (mais abaixo) já cuida disso usando exit code + crash-reports
                // + flag stop_requested. Esta thread só existe para detectar
                // quando o servidor fica online via TCP.
                log_to_file(&app_tcp, "[MC] Processo Java terminou antes do TCP conectar. Monitor thread cuidará da detecção.");
                break;
            }

            // Tenta conectar na porta do servidor
            let addr = format!("127.0.0.1:{}", server_port);
            if TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(500)).is_ok() {
                log_to_file(&app_tcp, &format!("[MC] Servidor online na porta {}!", server_port));
                // Marcar que o servidor ficou online (para referência)
                let state_ref = unsafe { &*(state_tcp_handle as *const AppState) };
                state_ref.minecraft_was_online.store(true, Ordering::SeqCst);
                let _ = app_tcp.emit("minecraft-status-changed", "online");
                break;
            }

            // Espera 1 segundo antes da próxima tentativa
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });

    // --- Thread de amostragem periódica de RAM/CPU (saúde de hardware) ---
    // Alimenta o evento "mc-resource-sample" (indicador de saúde na UI) e
    // `minecraft_last_resource_sample` (usado para enriquecer o diagnóstico
    // de crash com o retrato de hardware do sistema pouco antes do problema).
    // Um único `System` é mantido vivo entre iterações para que o cálculo de
    // uso de CPU seja um delta correto (não a média desde o boot da máquina).
    let app_resources = app.clone();
    let state_resources_handle = app.state::<AppState>().inner() as *const AppState as usize;
    std::thread::spawn(move || {
        let mut sys = System::new_all();
        let pid = Pid::from_u32(mc_pid);
        loop {
            let state_ref = unsafe { &*(state_resources_handle as *const AppState) };
            let process_alive = {
                let mut guard = state_ref.minecraft_process.lock().unwrap();
                if let Some(ref mut child) = *guard {
                    matches!(child.try_wait(), Ok(None))
                } else {
                    false
                }
            };
            if !process_alive {
                break;
            }

            sys.refresh_cpu_usage();
            sys.refresh_memory();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);

            let (process_ram_mb, process_cpu_percent) = match sys.process(pid) {
                Some(p) => (Some(p.memory() / 1024 / 1024), Some(p.cpu_usage())),
                None => (None, None),
            };

            let sample = ResourceSample {
                total_ram_mb: sys.total_memory() / 1024 / 1024,
                available_ram_mb: sys.available_memory() / 1024 / 1024,
                cpu_usage_percent: sys.global_cpu_usage(),
                process_ram_mb,
                process_cpu_percent,
            };

            *state_ref.minecraft_last_resource_sample.lock().unwrap() = Some(sample.clone());
            let _ = app_resources.emit("mc-resource-sample", sample);

            std::thread::sleep(Duration::from_secs(15));
        }
    });

    // --- Thread de monitoramento de saída (detecção de crash pós-inicialização) ---
    // Usamos TRÊS estratégias para distinguir parada normal de crash:
    //
    // 1. Código de saída (exit code):
    //    - 0: O servidor recebeu "stop" e salvou o mundo normalmente.
    //    - != 0 (ex: 1, 130, -1): O servidor crashou ou foi morto abruptamente.
    //
    // 2. Pasta crash-reports (comparação antes/depois):
    //    - Antes de iniciar o servidor, contamos quantos arquivos existem em crash-reports/.
    //    - Quando o servidor fecha, contamos novamente.
    //    - Se o número aumentou, significa que houve um NOVO crash durante a execução.
    //    - Isso é mais confiável que verificar "últimos 5 segundos", pois a pasta
    //      crash-reports só é criada quando ocorre o primeiro crash.
    //
    // 3. Flag minecraft_stop_requested (AtomicBool - lock-free):
    //    - Fallback: se o usuário clicou em "Parar Servidor" ou digitou "stop" no console.
    //
    // DEBUG: Todas as variáveis são logadas em cubeforge_debug.log para diagnóstico.
    let app_monitor = app.clone();
    let server_dir_monitor = server_dir.clone();
    let state_monitor_handle = app.state::<AppState>().inner() as *const AppState as usize;
    let ram_gb_monitor = ram_gb;
    std::thread::spawn(move || {
        log_to_file(&app_monitor, &format!("[MC-DEBUG] Thread de monitoramento iniciada. crash_reports_before={}", crash_reports_before.len()));
        
        // Aguarda o processo terminar (bloqueante)
        log_to_file(&app_monitor, "[MC-DEBUG] Aguardando child.wait()...");
        let exit_code = {
            let state_ref = unsafe { &*(state_monitor_handle as *const AppState) };
            let mut guard = state_ref.minecraft_process.lock().unwrap();
            log_to_file(&app_monitor, "[MC-DEBUG] Lock minecraft_process adquirido. Chamando child.wait()...");
            if let Some(ref mut child) = *guard {
                let result = child.wait();
                log_to_file(&app_monitor, &format!("[MC-DEBUG] child.wait() retornou. Resultado: {:?}", result));
                result.ok().and_then(|s| {
                    let code = s.code();
                    log_to_file(&app_monitor, &format!("[MC-DEBUG] ExitStatus.code() = {:?}", code));
                    code
                })
            } else {
                log_to_file(&app_monitor, "[MC-DEBUG] minecraft_process = None! Nenhum child para aguardar.");
                None
            }
        };
        log_to_file(&app_monitor, &format!("[MC-DEBUG] Lock minecraft_process liberado após child.wait()."));

        log_to_file(&app_monitor, &format!("[MC] Processo Java encerrado. Código de saída: {:?}", exit_code));

        // Estratégia 1: Exit code
        let exit_code_ok = exit_code == Some(0);
        log_to_file(&app_monitor, &format!("[MC-DEBUG] exit_code_ok (== Some(0)): {}", exit_code_ok));

        // Estratégia 2: Comparar crash-reports antes vs depois (por NOME, não só
        // contagem — assim identificamos QUAL arquivo é novo para ler seu conteúdo).
        let crash_dir_monitor = std::path::Path::new(&server_dir_monitor).join("crash-reports");
        let crash_reports_after: std::collections::HashSet<String> = if crash_dir_monitor.exists() && crash_dir_monitor.is_dir() {
            match std::fs::read_dir(&crash_dir_monitor) {
                Ok(entries) => entries
                    .flatten()
                    .filter(|e| e.metadata().map(|m| m.is_file()).unwrap_or(false))
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect(),
                Err(_) => std::collections::HashSet::new(),
            }
        } else {
            std::collections::HashSet::new()
        };
        let new_crash_report_names: Vec<&String> = crash_reports_after.difference(&crash_reports_before).collect();
        let has_new_crash_report = !new_crash_report_names.is_empty();
        log_to_file(&app_monitor, &format!("[MC-DEBUG] crash_reports_after={}, crash_reports_before={}, has_new_crash_report={}",
            crash_reports_after.len(), crash_reports_before.len(), has_new_crash_report));

        // Entre os arquivos novos (normalmente só um), pega o mais recente por
        // data de modificação e lê seu conteúdo para o analisador de causas do frontend.
        const CRASH_TEXT_CAP: usize = 60_000;
        let newest_crash_report: Option<(String, std::path::PathBuf)> = new_crash_report_names
            .iter()
            .filter_map(|name| {
                let path = crash_dir_monitor.join(name);
                let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
                modified.map(|m| (m, (*name).clone(), path))
            })
            .max_by_key(|(m, _, _)| *m)
            .map(|(_, name, path)| (name, path));
        let crash_report_file = newest_crash_report.as_ref().map(|(name, _)| name.clone());
        let crash_report_text = newest_crash_report
            .as_ref()
            .and_then(|(_, path)| std::fs::read_to_string(path).ok())
            .map(|s| truncate_chars(&s, CRASH_TEXT_CAP));

        // Estratégia 3: Flag de parada solicitada (AtomicBool - lock-free)
        let stop_requested = {
            let state_ref = unsafe { &*(state_monitor_handle as *const AppState) };
            let val = state_ref.minecraft_stop_requested.load(Ordering::SeqCst);
            log_to_file(&app_monitor, &format!("[MC-DEBUG] minecraft_stop_requested (AtomicBool) = {}", val));
            val
        };

        // Lógica de decisão final:
        // - Se exit code == 0: parada NORMAL (servidor salvou e fechou após "stop")
        // - Se crash_reports aumentou: CRASH (Minecraft gerou novo crash-report)
        // - Se stop_requested == true: parada NORMAL (usuário pediu, pode ter sido kill forçado)
        // - Caso contrário: CRASH (exit code != 0, sem crash-report, sem parada solicitada)
        let is_normal_shutdown = exit_code_ok || stop_requested;
        let is_crash_by_report = has_new_crash_report;

        log_to_file(&app_monitor, &format!("[MC-DEBUG] Decisão final: is_normal_shutdown={}, is_crash_by_report={}",
            is_normal_shutdown, is_crash_by_report));

        // Causa específica capturada pelas threads de stdout/stderr (se alguma).
        let known_cause = {
            let state_ref = unsafe { &*(state_monitor_handle as *const AppState) };
            state_ref.minecraft_last_error.lock().unwrap().take()
        };

        if is_normal_shutdown && !is_crash_by_report {
            log_to_file(&app_monitor, "[MC] Parada NORMAL detectada. Emitindo 'offline'.");
            let _ = app_monitor.emit("minecraft-status-changed", "offline");
        } else {
            let reason = if is_crash_by_report {
                "via crash-reports".to_string()
            } else {
                format!("exit_code={:?}, stop_requested={}, crash_reports_aumentou={}", exit_code, stop_requested, has_new_crash_report)
            };
            log_to_file(&app_monitor, &format!("[MC] CRASH detectado ({}). Causa conhecida: {:?}. Emitindo 'crashed'.", reason, known_cause));
            let _ = app_monitor.emit("minecraft-status-changed", "crashed");

            // Sem crash-report novo (crash nativo da JVM, OOM muito cedo, etc):
            // cai para a cauda de logs/latest.log, que ainda dá contexto pro analisador.
            let crash_report_text = crash_report_text.or_else(|| read_log_tail(&server_dir_monitor, 200));

            // Última amostra de RAM/CPU do sistema (thread de amostragem periódica) —
            // dá ao frontend o retrato de hardware de pouco antes do crash, para
            // diferenciar "aumente a RAM alocada" de "o computador não tem RAM suficiente".
            let resource_snapshot = {
                let state_ref = unsafe { &*(state_monitor_handle as *const AppState) };
                state_ref.minecraft_last_resource_sample.lock().unwrap().clone()
            };

            let (code, title, message) = known_cause.unwrap_or_else(|| (
                "unknown_crash".to_string(),
                "O servidor Minecraft travou".to_string(),
                "O processo encerrou de forma inesperada. Veja o console do servidor para mais detalhes.".to_string(),
            ));
            let _ = app_monitor.emit("mc-diagnostic", DiagnosticPayload {
                level: "critical".to_string(),
                title,
                message,
                detail: Some(format!("exit_code={:?}", exit_code)),
                code: Some(code),
                crash_report_text,
                crash_report_file,
                resource_snapshot,
                allocated_ram_mb: Some((ram_gb_monitor as u64) * 1024),
            });
        }
    });

    Ok(())
}

/// Executa o instalador do Forge (java -jar installer.jar --installServer).
/// Como o processo de instalação pode demorar vários minutos, este comando
/// roda em background e emite eventos de progresso.
#[tauri::command]
async fn run_forge_installer(
    app: tauri::AppHandle,
    java_path: String,
    installer_path: String,
) -> Result<(), String> {
    log_to_file(&app, &format!("=== INSTALANDO FORGE (java={}, installer={}) ===", java_path, installer_path));
    
    // Extrair diretório do installer
    let server_dir = std::path::Path::new(&installer_path)
        .parent()
        .ok_or_else(|| "Caminho do instalador inválido".to_string())?
        .to_string_lossy()
        .to_string();
    
    // Construir argumentos
    let args = vec![
        "-jar".to_string(),
        installer_path.clone(),
        "--installServer".to_string(),
    ];
    
    log_to_file(&app, &format!("Executando: {} {:?} em {}", java_path, args, server_dir));
    
    // Iniciar processo Java com stdin/stdout/stderr redirecionados
    let mut child = std::process::Command::new(&java_path)
        .args(&args)
        .current_dir(&server_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!("Falha ao iniciar instalador do Forge: {}", e);
            log_to_file(&app, &msg);
            msg
        })?;

    job_object::track_process(child.id());

    // Thread de leitura de stdout
    let app_stdout = app.clone();
    if let Some(stdout_pipe) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout_pipe);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        log_to_file(&app_stdout, &format!("[Forge-Installer] {}", l));
                    }
                    Err(_) => break,
                }
            }
        });
    }
    
    // Thread de leitura de stderr
    let app_stderr = app.clone();
    if let Some(stderr_pipe) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr_pipe);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        log_to_file(&app_stderr, &format!("[Forge-Installer-ERR] {}", l));
                    }
                    Err(_) => break,
                }
            }
        });
    }
    
    // Aguardar o instalador terminar (pode levar vários minutos)
    // Timeout de 10 minutos
    let start = Instant::now();
    let timeout = Duration::from_secs(600); // 10 minutos
    let app_wait = app.clone();
    
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() > timeout {
                    log_to_file(&app_wait, "[Forge-Installer] Timeout de 10 minutos excedido. Matando processo...");
                    let _ = child.kill();
                    return Err("Instalador do Forge excedeu o tempo limite de 10 minutos.".to_string());
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            Err(e) => {
                log_to_file(&app_wait, &format!("[Forge-Installer] Erro ao aguardar: {}", e));
                return Err(format!("Erro ao aguardar instalador do Forge: {}", e));
            }
        }
    };
    
    if !exit_status.success() {
        let msg = format!("Instalador do Forge falhou com código: {:?}", exit_status.code());
        log_to_file(&app, &msg);
        return Err(msg);
    }
    
    log_to_file(&app, "[Forge-Installer] Instalação concluída com sucesso!");
    Ok(())
}

/// Para o servidor de Minecraft enviando o comando `stop` via stdin.
/// Força a finalização se demorar mais de 15 segundos.
#[tauri::command]
async fn stop_minecraft_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    stop_minecraft_server_internal(&app, &state).await;
    Ok(())
}

async fn stop_minecraft_server_internal(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
) {
    log_to_file(app, "=== PARANDO SERVIDOR MC ===");
    
    // Marcar que a parada foi solicitada pelo usuário (não é crash)
    // Usamos AtomicBool (lock-free) para evitar deadlock com o lock de minecraft_process
    state.minecraft_stop_requested.store(true, Ordering::SeqCst);

    // Enviar comando `stop` para o stdin do servidor
    let has_stdin = {
        let mut stdin_guard = state.minecraft_stdin.lock().unwrap();
        if let Some(ref mut stdin) = *stdin_guard {
            let _ = stdin.write_all(b"stop\n");
            let _ = stdin.flush();
            true
        } else {
            false
        }
    };

    if !has_stdin {
        // Nenhum servidor rodando
        return;
    }

    // Emitir status de parada
    let _ = app.emit("minecraft-status-changed", "stopping");

    // Aguardar até 15 segundos pelo processo encerrar de forma limpa
    for _ in 0..15 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let still_running = {
            let mut guard = state.minecraft_process.lock().unwrap();
            if let Some(ref mut child) = *guard {
                matches!(child.try_wait(), Ok(None))
            } else {
                false
            }
        };
        if !still_running { break; }
    }

    // Forçar finalização se ainda estiver rodando
    {
        let mut guard = state.minecraft_process.lock().unwrap();
        if let Some(ref mut child) = *guard {
            if matches!(child.try_wait(), Ok(None)) {
                log_to_file(app, "[MC] Forçando encerramento do processo Java.");
                let _ = child.kill();
            }
        }
        // Limpar o processo do estado
        *guard = None;
    }
    *state.minecraft_stdin.lock().unwrap() = None;
}

/// Envia um comando de texto para o stdin do servidor Minecraft.
/// Permite controlar o servidor diretamente pelo console do CubeForge.
#[tauri::command]
async fn send_minecraft_command(
    state: tauri::State<'_, AppState>,
    command: String,
) -> Result<(), String> {
    let trimmed = command.trim();
    
    // Se o comando for "stop" ou "/stop", marca como parada intencional
    if trimmed == "stop" || trimmed == "/stop" {
        state.minecraft_stop_requested.store(true, Ordering::SeqCst);
    }
    
    let mut stdin_guard = state.minecraft_stdin.lock().unwrap();
    if let Some(ref mut stdin) = *stdin_guard {
        let line = format!("{}\n", trimmed);
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Nenhum servidor Minecraft está em execução.".to_string())
    }
}

/// Verifica o estado atual do sistema (servidor MC e rede mesh)
/// para restaurar o estado do frontend após recarga (Ctrl+R).
///
/// IMPORTANTE: Usa try_lock() em vez de lock() para evitar deadlock com
/// a thread de monitoramento do Minecraft, que segura o lock enquanto
/// chama child.wait() (bloqueante). Se o lock estiver ocupado, faz
/// uma verificação via TCP na porta padrão (25565).
#[tauri::command]
async fn get_system_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Verificar se o servidor Minecraft ainda está rodando
    // Usamos try_lock() para não travar se a monitor thread estiver com o lock
    let mc_status = {
        match state.minecraft_process.try_lock() {
            Ok(mut guard) => {
                if let Some(ref mut child) = *guard {
                    match child.try_wait() {
                        Ok(None) => { // processo ainda vivo
                            drop(guard);
                            "online"
                        },
                        Ok(Some(status)) => {
                            drop(guard);
                            if status.success() { "offline" } else { "crashed" }
                        }
                        Err(_) => {
                            drop(guard);
                            "offline"
                        }
                    }
                } else {
                    drop(guard);
                    // Processo handle é None, mas tentar TCP como fallback
                    "offline"
                }
            }
            Err(_) => {
                // Lock está ocupado pela thread de monitoramento.
                // Isso significa que o processo Minecraft ainda está vivo
                // (a thread só segura o lock durante child.wait()).
                log_to_file(&app, "[get_system_status] Lock minecraft_process ocupado. Assumindo ONLINE.");
                "online"
            }
        }
    };

    // Verificar se o sidecar de rede ainda está rodando
    let net_status = {
        let process = state.sidecar_process.lock().unwrap();
        if process.is_some() {
            "online"
        } else {
            let mock_active = state.is_mock_active.lock().unwrap();
            if *mock_active { "online" } else { "offline" }
        }
    };

    log_to_file(&app, &format!("[get_system_status] MC={}, Net={}", mc_status, net_status));

    Ok(serde_json::json!({
        "minecraftStatus": mc_status,
        "netStatus": net_status,
        "ip": null,
    }))
}

/// Retorna o total de memória RAM do sistema em bytes.
#[tauri::command]
fn get_total_memory() -> Result<u64, String> {
    let mut sys = System::new();
    sys.refresh_memory();
    let total = sys.total_memory();
    if total > 0 {
        return Ok(total);
    }
    // Default fallback (8GB) — só deve acontecer se a leitura falhar de vez.
    Ok(8 * 1024 * 1024 * 1024)
}

/// Reads the `server.properties` file and returns a JSON map of key/value pairs.
#[tauri::command]
async fn read_server_properties(server_dir: String) -> Result<serde_json::Value, String> {
    let path = format!("{}/server.properties", server_dir);
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut map = serde_json::Map::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            map.insert(k.trim().to_string(), serde_json::Value::String(v.trim().to_string()));
        }
    }
    Ok(serde_json::Value::Object(map))
}

/// Writes supplied properties to `server.properties`, preserving existing comments and order where possible.
#[tauri::command]
async fn write_server_properties(server_dir: String, props: HashMap<String, String>) -> Result<(), String> {
    let path = format!("{}/server.properties", server_dir);
    // Read existing file lines if present
    let mut lines: Vec<String> = if let Ok(content) = std::fs::read_to_string(&path) {
        content.lines().map(|s| s.to_string()).collect()
    } else {
        Vec::new()
    };
    // Update or append each property
    for (key, value) in props.iter() {
        let mut found = false;
        for line in lines.iter_mut() {
            if line.starts_with(&format!("{}=", key)) {
                *line = format!("{}={}", key, value);
                found = true;
                break;
            }
        }
        if !found {
            lines.push(format!("{}={}", key, value));
        }
    }
    let new_content = lines.join("\n");
    std::fs::write(&path, new_content).map_err(|e| e.to_string())
}

/// Recorta a imagem para um quadrado centralizado e redimensiona para o tamanho
/// de ícone do Minecraft (64x64), evitando distorção em imagens não-quadradas.
fn crop_and_resize_icon(img: image::DynamicImage) -> image::DynamicImage {
    let (w, h) = (img.width(), img.height());
    let side = w.min(h);
    let x = (w - side) / 2;
    let y = (h - side) / 2;
    img.crop_imm(x, y, side, side)
        .resize_exact(64, 64, image::imageops::FilterType::Lanczos3)
}

/// Define o ícone exibido na lista de servidores do Minecraft (server-icon.png).
/// A imagem de origem pode estar em qualquer formato suportado (PNG, JPEG, WEBP, BMP, GIF);
/// é recortada em um quadrado central e redimensionada para 64x64 antes de salvar.
#[tauri::command]
async fn set_server_icon(server_dir: String, image_path: String) -> Result<(), String> {
    let img = image::open(&image_path)
        .map_err(|e| format!("Não foi possível abrir a imagem: {}", e))?;
    let icon = crop_and_resize_icon(img);
    let dest = PathBuf::from(&server_dir).join("server-icon.png");
    icon.save_with_format(&dest, image::ImageFormat::Png)
        .map_err(|e| format!("Não foi possível salvar o ícone: {}", e))
}

/// Lê o server-icon.png atual (se existir) e retorna como data URL base64 para preview no frontend.
#[tauri::command]
async fn get_server_icon(server_dir: String) -> Result<Option<String>, String> {
    let path = PathBuf::from(&server_dir).join("server-icon.png");
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:image/png;base64,{}", encoded)))
}

/// Remove o ícone customizado do servidor, voltando ao ícone padrão do Minecraft.
#[tauri::command]
async fn remove_server_icon(server_dir: String) -> Result<(), String> {
    let path = PathBuf::from(&server_dir).join("server-icon.png");
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================================
// Gerenciamento de Mods e Mundo (backups)
// ============================================================
//
// Comandos nativos em Rust (não usam @tauri-apps/plugin-fs no frontend) para que
// funcionem igualmente em servidores criados pelo app e em servidores importados
// (fora do escopo de capabilities/default.json).

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ModInfo {
    file_name: String,
    display_name: String,
    size_bytes: u64,
    enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct BackupInfo {
    file_name: String,
    size_bytes: u64,
    created_at: String,
}

/// Lê o `level-name` do server.properties; usa "world" como padrão.
fn read_level_name(server_dir: &str) -> String {
    let path = format!("{}/server.properties", server_dir);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        for line in contents.lines() {
            let trimmed = line.trim();
            if let Some((k, v)) = trimmed.split_once('=') {
                if k.trim() == "level-name" {
                    let name = v.trim();
                    if !name.is_empty() {
                        return name.to_string();
                    }
                }
            }
        }
    }
    "world".to_string()
}

/// Retorna os caminhos das pastas de mundo existentes (principal + nether + the_end).
fn world_folder_paths(server_dir: &str, level_name: &str) -> Vec<PathBuf> {
    [
        level_name.to_string(),
        format!("{}_nether", level_name),
        format!("{}_the_end", level_name),
    ]
    .iter()
    .map(|name| PathBuf::from(server_dir).join(name))
    .filter(|p| p.is_dir())
    .collect()
}

#[tauri::command]
async fn list_mods(server_dir: String, folder_name: Option<String>) -> Result<Vec<ModInfo>, String> {
    let mods_dir = PathBuf::from(&server_dir).join(folder_name.as_deref().unwrap_or("mods"));
    if !mods_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut mods = Vec::new();
    let entries = std::fs::read_dir(&mods_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let lower = file_name.to_lowercase();
        if !lower.ends_with(".jar") && !lower.ends_with(".jar.disabled") {
            continue;
        }
        let enabled = !lower.ends_with(".disabled");
        let display_name = if enabled {
            file_name.clone()
        } else {
            file_name.trim_end_matches(".disabled").to_string()
        };
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        mods.push(ModInfo { file_name, display_name, size_bytes, enabled });
    }
    mods.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(mods)
}

#[tauri::command]
async fn toggle_mod(server_dir: String, file_name: String, folder_name: Option<String>) -> Result<(), String> {
    let mods_dir = PathBuf::from(&server_dir).join(folder_name.as_deref().unwrap_or("mods"));
    let from = mods_dir.join(&file_name);
    if !from.is_file() {
        return Err(format!("Mod não encontrado: {}", file_name));
    }
    let to = if file_name.to_lowercase().ends_with(".disabled") {
        mods_dir.join(file_name.trim_end_matches(".disabled"))
    } else {
        mods_dir.join(format!("{}.disabled", file_name))
    };
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_mod(server_dir: String, file_name: String, folder_name: Option<String>) -> Result<(), String> {
    let path = PathBuf::from(&server_dir).join(folder_name.as_deref().unwrap_or("mods")).join(&file_name);
    if !path.is_file() {
        return Err(format!("Mod não encontrado: {}", file_name));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Abre uma pasta no gerenciador de arquivos do sistema, criando-a se ainda não existir.
#[tauri::command]
fn open_path_in_explorer(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    }
    let result = if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(&path).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&path).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&path).spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_world_backups(server_dir: String) -> Result<Vec<BackupInfo>, String> {
    let backups_dir = PathBuf::from(&server_dir).join("backups");
    if !backups_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut backups = Vec::new();
    let entries = std::fs::read_dir(&backups_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().map(|e| e != "zip").unwrap_or(true) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let size_bytes = metadata.len();
        let created_at = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0))
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();
        backups.push(BackupInfo { file_name, size_bytes, created_at });
    }
    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(backups)
}

fn zip_add_dir(
    zip: &mut zip::ZipWriter<File>,
    base_dir: &PathBuf,
    dir: &PathBuf,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let relative = path.strip_prefix(base_dir).map_err(|e| e.to_string())?;
        let name = relative.to_string_lossy().replace('\\', "/");
        if name.is_empty() {
            continue;
        }
        if path.is_dir() {
            zip.add_directory(name, options).map_err(|e| e.to_string())?;
        } else {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            let mut f = File::open(path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Compacta as pastas do mundo atual (principal + nether + the_end, as que existirem)
/// em um novo arquivo .zip dentro de `{server_dir}/backups`.
#[tauri::command]
async fn backup_world(server_dir: String) -> Result<BackupInfo, String> {
    let level_name = read_level_name(&server_dir);
    let folders = world_folder_paths(&server_dir, &level_name);
    if folders.is_empty() {
        return Err("Nenhuma pasta de mundo encontrada para fazer backup.".to_string());
    }

    let backups_dir = PathBuf::from(&server_dir).join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;

    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let file_name = format!("{}_{}.zip", level_name, timestamp);
    let zip_path = backups_dir.join(&file_name);

    let file = File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let server_root = PathBuf::from(&server_dir);
    for folder in &folders {
        zip_add_dir(&mut zip, &server_root, folder, options)?;
    }
    zip.finish().map_err(|e| e.to_string())?;

    let size_bytes = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    Ok(BackupInfo {
        file_name,
        size_bytes,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Substitui o mundo atual pelo conteúdo do backup escolhido.
///
/// Antes de tocar no mundo atual, o zip é aberto e todas as entradas são
/// validadas (backup corrompido é rejeitado sem apagar nada). O mundo atual
/// é movido para uma pasta de staging (não apagado) durante a extração; se a
/// extração falhar no meio, o mundo original é restaurado automaticamente.
#[tauri::command]
async fn restore_world_backup(server_dir: String, file_name: String) -> Result<(), String> {
    let zip_path = PathBuf::from(&server_dir).join("backups").join(&file_name);
    if !zip_path.is_file() {
        return Err(format!("Backup não encontrado: {}", file_name));
    }

    // 1. Validar integridade do backup ANTES de tocar no mundo atual.
    let file = File::open(&zip_path).map_err(|e| format!("Não foi possível abrir o backup: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Backup corrompido ou inválido — mundo atual preservado: {}", e))?;
    for i in 0..archive.len() {
        archive.by_index(i).map_err(|e| {
            format!("Backup corrompido (entrada {} ilegível) — mundo atual preservado: {}", i, e)
        })?;
    }

    let level_name = read_level_name(&server_dir);
    let folders = world_folder_paths(&server_dir, &level_name);

    // 2. Mover (não apagar) as pastas do mundo atual para uma área de staging,
    //    permitindo rollback caso a extração falhe no meio.
    let staging_dir = PathBuf::from(&server_dir)
        .join(format!(".restore_staging_{}", chrono::Utc::now().timestamp_millis()));
    std::fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for folder in &folders {
        let dest = staging_dir.join(folder.file_name().unwrap());
        if let Err(e) = std::fs::rename(folder, &dest) {
            // Rollback do que já foi movido antes de propagar o erro.
            for (original, staged) in moved.iter().rev() {
                let _ = std::fs::rename(staged, original);
            }
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(format!("Não foi possível preparar a restauração (mundo atual preservado): {}", e));
        }
        moved.push((folder.clone(), dest));
    }

    // 3. Extrair o backup; em caso de falha, restaurar o mundo original a partir do staging.
    let server_root = PathBuf::from(&server_dir);
    let extract_result: Result<(), String> = (|| {
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let out_path = match entry.enclosed_name() {
                Some(p) => server_root.join(p),
                None => continue,
            };
            if entry.is_dir() {
                std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut out_file = File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();

    match extract_result {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&staging_dir);
            Ok(())
        }
        Err(e) => {
            for (original, staged) in moved.iter().rev() {
                let _ = std::fs::remove_dir_all(original);
                let _ = std::fs::rename(staged, original);
            }
            let _ = std::fs::remove_dir_all(&staging_dir);
            Err(format!("Falha ao extrair o backup — mundo original restaurado: {}", e))
        }
    }
}

#[tauri::command]
async fn delete_world_backup(server_dir: String, file_name: String) -> Result<(), String> {
    let path = PathBuf::from(&server_dir).join("backups").join(&file_name);
    if !path.is_file() {
        return Err(format!("Backup não encontrado: {}", file_name));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Apaga as pastas do mundo atual sem gerar backup; o Minecraft regenera no próximo start.
#[tauri::command]
async fn reset_world(server_dir: String) -> Result<(), String> {
    let level_name = read_level_name(&server_dir);
    let folders = world_folder_paths(&server_dir, &level_name);
    if folders.is_empty() {
        return Err("Nenhuma pasta de mundo encontrada para resetar.".to_string());
    }
    for folder in folders {
        std::fs::remove_dir_all(&folder).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================================
// Import de Modpacks — CurseForge (.zip) e Modrinth (.mrpack)
// ============================================================
//
// Ambos os formatos são arquivos zip com um manifest na raiz:
// - CurseForge: "manifest.json" ({projectID, fileID} por mod — a resolução
//   em URL de download passa pelo proxy da API central, já que a CurseForge
//   exige uma API key que não pode ir no cliente distribuído publicamente)
// - Modrinth: "modrinth.index.json" (já traz URL de download direta por
//   arquivo + hash, nenhuma resolução externa necessária)
//
// Este módulo só lê o manifest (preview antes de baixar qualquer coisa) e
// extrai a pasta de overrides; o download dos mods em si reusa o comando
// genérico `download_server_jar` já existente, chamado em loop pelo lado TS
// (mesmo padrão que a instalação de mods individuais via Modrinth já usa).

#[derive(Serialize, Clone)]
struct CurseForgeManifestFile {
    project_id: u32,
    file_id: u32,
    required: bool,
}

#[derive(Serialize, Clone)]
struct ModrinthManifestFile {
    path: String,
    url: String,
    sha1: Option<String>,
    file_size: Option<u64>,
}

#[derive(Serialize, Clone)]
struct ModpackManifestSummary {
    format: String, // "curseforge" | "modrinth"
    pack_name: String,
    pack_version: String,
    mc_version: String,
    loader: String, // "forge" | "neoforge" | "fabric"
    loader_version: String,
    curseforge_files: Vec<CurseForgeManifestFile>,
    modrinth_files: Vec<ModrinthManifestFile>,
    overrides_folders: Vec<String>,
}

#[derive(Deserialize)]
struct CfManifest {
    minecraft: CfMinecraft,
    name: Option<String>,
    version: Option<String>,
    files: Vec<CfFileEntry>,
    overrides: Option<String>,
}

#[derive(Deserialize)]
struct CfMinecraft {
    version: String,
    #[serde(rename = "modLoaders")]
    mod_loaders: Vec<CfModLoader>,
}

#[derive(Deserialize)]
struct CfModLoader {
    id: String,
    #[serde(default)]
    primary: bool,
}

fn default_true() -> bool { true }

#[derive(Deserialize)]
struct CfFileEntry {
    #[serde(rename = "projectID")]
    project_id: u32,
    #[serde(rename = "fileID")]
    file_id: u32,
    #[serde(default = "default_true")]
    required: bool,
}

#[derive(Deserialize)]
struct MrIndex {
    name: Option<String>,
    #[serde(rename = "versionId")]
    version_id: Option<String>,
    files: Vec<MrFileEntry>,
    dependencies: HashMap<String, String>,
}

#[derive(Deserialize)]
struct MrFileEntry {
    path: String,
    hashes: Option<MrHashes>,
    #[serde(default)]
    downloads: Vec<String>,
    #[serde(rename = "fileSize")]
    file_size: Option<u64>,
    env: Option<MrEnv>,
}

#[derive(Deserialize)]
struct MrHashes {
    sha1: Option<String>,
}

#[derive(Deserialize)]
struct MrEnv {
    server: Option<String>,
}

/// Checa se existe alguma entrada no zip cujo nome comece com o prefixo dado
/// (usado para detectar se uma pasta de overrides realmente existe).
fn zip_has_prefix(archive: &mut zip::ZipArchive<File>, prefix: &str) -> bool {
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            if entry.name().starts_with(prefix) {
                return true;
            }
        }
    }
    false
}

/// Lê o manifest de um modpack (.zip da CurseForge ou .mrpack do Modrinth)
/// sem extrair nada — usado para a tela de confirmação antes do import real.
#[tauri::command]
async fn read_modpack_manifest(zip_path: String) -> Result<ModpackManifestSummary, String> {
    use std::io::Read;

    let file = File::open(&zip_path).map_err(|e| format!("Não foi possível abrir o arquivo: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Arquivo inválido ou corrompido: {}", e))?;

    if archive.by_name("manifest.json").is_ok() {
        let manifest: CfManifest = {
            let mut entry = archive.by_name("manifest.json").map_err(|e| e.to_string())?;
            let mut contents = String::new();
            entry.read_to_string(&mut contents).map_err(|e| e.to_string())?;
            serde_json::from_str(&contents).map_err(|e| format!("manifest.json inválido: {}", e))?
        };

        let primary = manifest.minecraft.mod_loaders.iter()
            .find(|l| l.primary)
            .or_else(|| manifest.minecraft.mod_loaders.first())
            .ok_or("Modpack não especifica um mod loader (Forge/Fabric/NeoForge).")?;

        let (loader_raw, loader_version) = primary.id.split_once('-')
            .map(|(l, v)| (l.to_string(), v.to_string()))
            .ok_or_else(|| format!("Não foi possível interpretar o mod loader \"{}\".", primary.id))?;

        let loader = match loader_raw.as_str() {
            "forge" => "forge",
            "neoforge" => "neoforge",
            "fabric" => "fabric",
            other => return Err(format!("Mod loader \"{}\" não é suportado pelo CubeForge.", other)),
        }.to_string();

        let overrides_dir = manifest.overrides.clone().unwrap_or_else(|| "overrides".to_string());
        let overrides_prefix = format!("{}/", overrides_dir);
        let overrides_folders = if zip_has_prefix(&mut archive, &overrides_prefix) {
            vec![overrides_dir]
        } else {
            vec![]
        };

        Ok(ModpackManifestSummary {
            format: "curseforge".to_string(),
            pack_name: manifest.name.unwrap_or_else(|| "Modpack".to_string()),
            pack_version: manifest.version.unwrap_or_default(),
            mc_version: manifest.minecraft.version,
            loader,
            loader_version,
            curseforge_files: manifest.files.into_iter().map(|f| CurseForgeManifestFile {
                project_id: f.project_id,
                file_id: f.file_id,
                required: f.required,
            }).collect(),
            modrinth_files: vec![],
            overrides_folders,
        })
    } else if archive.by_name("modrinth.index.json").is_ok() {
        let index: MrIndex = {
            let mut entry = archive.by_name("modrinth.index.json").map_err(|e| e.to_string())?;
            let mut contents = String::new();
            entry.read_to_string(&mut contents).map_err(|e| e.to_string())?;
            serde_json::from_str(&contents).map_err(|e| format!("modrinth.index.json inválido: {}", e))?
        };

        let mc_version = index.dependencies.get("minecraft").cloned()
            .ok_or("Modpack não especifica a versão do Minecraft.")?;

        let (loader, loader_version) = if let Some(v) = index.dependencies.get("forge") {
            ("forge".to_string(), v.clone())
        } else if let Some(v) = index.dependencies.get("neoforge") {
            ("neoforge".to_string(), v.clone())
        } else if let Some(v) = index.dependencies.get("fabric-loader") {
            ("fabric".to_string(), v.clone())
        } else if index.dependencies.contains_key("quilt-loader") {
            return Err("Modpacks Quilt não são suportados pelo CubeForge no momento.".to_string());
        } else {
            return Err("Modpack não especifica um mod loader suportado (Forge/Fabric/NeoForge).".to_string());
        };

        let modrinth_files: Vec<ModrinthManifestFile> = index.files.into_iter()
            .filter(|f| f.env.as_ref().and_then(|e| e.server.as_deref()) != Some("unsupported"))
            .filter_map(|f| {
                let url = f.downloads.first().cloned()?;
                Some(ModrinthManifestFile {
                    path: f.path,
                    url,
                    sha1: f.hashes.and_then(|h| h.sha1),
                    file_size: f.file_size,
                })
            })
            .collect();

        let mut overrides_folders = vec![];
        if zip_has_prefix(&mut archive, "overrides/") {
            overrides_folders.push("overrides".to_string());
        }
        if zip_has_prefix(&mut archive, "server-overrides/") {
            overrides_folders.push("server-overrides".to_string());
        }

        Ok(ModpackManifestSummary {
            format: "modrinth".to_string(),
            pack_name: index.name.unwrap_or_else(|| "Modpack".to_string()),
            pack_version: index.version_id.unwrap_or_default(),
            mc_version,
            loader,
            loader_version,
            curseforge_files: vec![],
            modrinth_files,
            overrides_folders,
        })
    } else {
        Err("Arquivo não é um modpack CurseForge (.zip) ou Modrinth (.mrpack) válido — manifest.json ou modrinth.index.json não encontrado.".to_string())
    }
}

/// Extrai o conteúdo de uma pasta de overrides (ex.: "overrides", "server-overrides")
/// de dentro do zip do modpack diretamente para a raiz da pasta do servidor.
///
/// Sempre aplicado sobre uma pasta de servidor recém-criada e ainda vazia — em
/// caso de erro, o chamador (TS) apaga a pasta inteira, então não há rollback
/// próprio aqui (diferente de `restore_world_backup`, que precisa preservar um
/// mundo já existente enquanto restaura).
#[tauri::command]
async fn extract_modpack_overrides(zip_path: String, dest_dir: String, overrides_folder: String) -> Result<u32, String> {
    let file = File::open(&zip_path).map_err(|e| format!("Não foi possível abrir o arquivo: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Arquivo inválido ou corrompido: {}", e))?;

    let prefix = format!("{}/", overrides_folder);
    let dest_root = PathBuf::from(&dest_dir);
    let mut extracted: u32 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if !entry.name().starts_with(&prefix) {
            continue;
        }
        // enclosed_name() valida e normaliza o caminho (bloqueia "../" e paths
        // absolutos) antes de qualquer escrita em disco.
        let enclosed = match entry.enclosed_name() {
            Some(p) => p,
            None => continue,
        };
        let relative = match enclosed.strip_prefix(&overrides_folder) {
            Ok(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => continue,
        };
        let out_path = dest_root.join(&relative);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out_file = File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
            extracted += 1;
        }
    }

    Ok(extracted)
}

// ============================================================
// Server Registry — Servidor HTTP local para descoberta de servidores
// ============================================================
//
// O Rust mantém um registro em memória dos servidores Minecraft disponíveis.
// Um servidor HTTP local (127.0.0.1:25567) expõe endpoints para:
//
// - GET /registry/resolve?code={shortCode} → retorna metadados do servidor
// - POST /registry/update                → atualiza o registro
//
// O sidecar Go consulta este servidor HTTP local para responder requisições
// que chegam via Tailscale (na porta 25566).

use std::collections::BTreeMap;

/// Estrutura de metadados de um servidor no registro
#[derive(Serialize, Deserialize, Clone, Debug)]
struct ServerRegistryEntry {
    short_code: String,
    name: String,
    version: String,
    server_type: String,
    description: String,
    status: String, // "offline" | "starting" | "online" | "stopping" | "crashed"
    port: u16,
}

/// Estado global do registro de servidores (thread-safe)
struct ServerRegistry {
    entries: Mutex<BTreeMap<String, ServerRegistryEntry>>, // key = shortCode
}

/// Inicia o servidor HTTP de registro em uma thread separada.
/// Escuta em 127.0.0.1:25567 (para o sidecar Go) e em 0.0.0.0:25566 (para o guest via Tailscale).
fn start_registry_http_server(registry: Arc<ServerRegistry>) {
    // Servidor interno (127.0.0.1:25567) — usado pelo sidecar Go como proxy
    let registry_internal = registry.clone();
    thread::spawn(move || {
        let addr = "127.0.0.1:25567";
        let server = match tiny_http::Server::http(addr) {
            Ok(s) => {
                eprintln!("[Registry] Servidor HTTP interno iniciado em {}", addr);
                s
            }
            Err(e) => {
                eprintln!("[Registry] Falha ao iniciar servidor HTTP interno em {}: {}", addr, e);
                return;
            }
        };
        
        loop {
            match server.recv() {
                Ok(mut request) => {
                    let url = request.url().to_string();
                    let method = request.method().as_str().to_string();
                    eprintln!("[Registry] Requisição recebida (interno): {} {}", method, url);
                    
                    let response = handle_registry_request(&registry_internal, &method, &url, &mut request);
                    let _ = request.respond(tiny_http::Response::from_string(response));
                }
                Err(e) => {
                    eprintln!("[Registry] Erro no servidor HTTP interno: {}", e);
                }
            }
        }
    });
    
    // Servidor externo (0.0.0.0:25566) — acessível via Tailscale pelo guest
    // O Tailscale roteia conexões para o IP virtual do host, e qualquer processo
    // escutando em 0.0.0.0:PORT receberá essas conexões.
    thread::spawn(move || {
        let addr = "0.0.0.0:25566";
        let server = match tiny_http::Server::http(addr) {
            Ok(s) => {
                eprintln!("[Registry] Servidor HTTP externo iniciado em {}", addr);
                s
            }
            Err(e) => {
                eprintln!("[Registry] Falha ao iniciar servidor HTTP externo em {}: {}", addr, e);
                return;
            }
        };
        
        loop {
            match server.recv() {
                Ok(mut request) => {
                    let url = request.url().to_string();
                    let method = request.method().as_str().to_string();
                    eprintln!("[Registry] Requisição recebida (externo): {} {} de {:?}", method, url, request.remote_addr());
                    
                    let response = handle_registry_request(&registry, &method, &url, &mut request);
                    let _ = request.respond(tiny_http::Response::from_string(response));
                }
                Err(e) => {
                    eprintln!("[Registry] Erro no servidor HTTP externo: {}", e);
                }
            }
        }
    });
}

/// Processa uma requisição HTTP do registro e retorna a resposta como string.
fn handle_registry_request(registry: &ServerRegistry, method: &str, url: &str, request: &mut tiny_http::Request) -> String {
    match (method, url) {
        // GET /registry/resolve?code={shortCode}
        ("GET", url_str) if url_str.starts_with("/registry/resolve") || url_str.starts_with("/resolve") => {
            let code = url_str.split("?code=").nth(1).unwrap_or("").to_string();
            eprintln!("[Registry] Resolvendo código: '{}'", code);
            let entries = registry.entries.lock().unwrap();
            eprintln!("[Registry] Entradas no registro: {:?}", entries.keys().collect::<Vec<_>>());
            match entries.get(&code) {
                Some(entry) => {
                    eprintln!("[Registry] Servidor encontrado: {:?}", entry);
                    let json = serde_json::to_string(entry).unwrap_or_default();
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}", json)
                }
                None => {
                    eprintln!("[Registry] Código '{}' não encontrado no registro!", code);
                    format!("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{{\"error\":\"Servidor não encontrado para o código: {}\"}}", code)
                }
            }
        }
        // GET /registry/list — lista todos os servidores
        ("GET", "/registry/list") | ("GET", "/list") => {
            let entries = registry.entries.lock().unwrap();
            let list: Vec<&ServerRegistryEntry> = entries.values().collect();
            let json = serde_json::to_string(&list).unwrap_or_default();
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}", json)
        }
        // GET /status — health check
        ("GET", "/status") => {
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{{\"status\":\"ok\"}}")
        }
        // POST /registry/update — atualiza ou adiciona um servidor
        ("POST", "/registry/update") | ("POST", "/update") => {
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            if let Ok(entry) = serde_json::from_str::<ServerRegistryEntry>(&body) {
                let code = entry.short_code.clone();
                let mut entries = registry.entries.lock().unwrap();
                entries.insert(code, entry);
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{{\"status\":\"updated\"}}")
            } else {
                format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{{\"error\":\"JSON inválido\"}}")
            }
        }
        // POST /registry/remove — remove um servidor pelo shortCode
        ("POST", url_str) if url_str.starts_with("/registry/remove") || url_str.starts_with("/remove") => {
            let code = url_str.split("?code=").nth(1).unwrap_or("").to_string();
            let mut entries = registry.entries.lock().unwrap();
            entries.remove(&code);
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{{\"status\":\"removed\"}}")
        }
        // Qualquer outro endpoint
        _ => {
            format!("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{{\"error\":\"Endpoint não encontrado\"}}")
        }
    }
}

/// Comando Tauri: atualiza o registro de servidores.
/// Chamado pelo frontend quando um servidor é criado, iniciado ou parado.
#[tauri::command]
async fn update_server_registry(
    app: tauri::AppHandle,
    short_code: String,
    name: String,
    version: String,
    server_type: String,
    description: String,
    status: String,
    port: u16,
) -> Result<(), String> {
    let registry = app.state::<Arc<ServerRegistry>>();
    let entry = ServerRegistryEntry {
        short_code: short_code.clone(),
        name,
        version,
        server_type,
        description,
        status,
        port,
    };
    let mut entries = registry.entries.lock().unwrap();
    entries.insert(short_code, entry);
    Ok(())
}

/// Comando Tauri: remove um servidor do registro.
#[tauri::command]
async fn remove_server_registry(
    app: tauri::AppHandle,
    short_code: String,
) -> Result<(), String> {
    let registry = app.state::<Arc<ServerRegistry>>();
    let mut entries = registry.entries.lock().unwrap();
    entries.remove(&short_code);
    Ok(())
}

/// Comando Tauri: descobre informações de um servidor pelo código de convite completo.
/// O guest chama este comando APÓS conectar na mesh para obter metadados.
/// Faz uma requisição HTTP para o host via Tailscale (porta 25566).
/// O sidecar Go extrai o shortCode e consulta o registro do Rust.
///
/// Inclui retry automático com backoff para dar tempo do servidor HTTP iniciar.
#[tauri::command]
async fn discover_server(
    app: tauri::AppHandle,
    host_ip: String,
    short_code: String,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, &format!("[discover_server] Iniciando descoberta: host_ip={}, short_code={}", host_ip, short_code));
    
    let url = format!("http://{}:25566/resolve?code={}", host_ip, short_code);
    log_to_file(&app, &format!("[discover_server] URL da requisição: {}", url));
    
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| {
            let msg = format!("[discover_server] Erro ao criar cliente HTTP: {}", e);
            log_to_file(&app, &msg);
            e.to_string()
        })?;
    
    // Tentar com retry: até 5 tentativas com 1 segundo de intervalo
    let max_attempts = 5;
    let mut last_error = String::new();
    
    for attempt in 1..=max_attempts {
        log_to_file(&app, &format!("[discover_server] Tentativa {}/{} - Enviando requisição GET...", attempt, max_attempts));
        
        match client.get(&url).send().await {
            Ok(response) => {
                log_to_file(&app, &format!("[discover_server] Resposta recebida: HTTP {}", response.status()));
                
                let status_code = response.status();
                if !status_code.is_success() {
                    let body = response.text().await.unwrap_or_default();
                    let msg = format!("[discover_server] Host retornou erro: HTTP {}. Body: {}", status_code, body);
                    log_to_file(&app, &msg);
                    return Err(msg);
                }
                
                let data: serde_json::Value = response.json().await.map_err(|e| {
                    let msg = format!("[discover_server] Falha ao parsear resposta do host: {}", e);
                    log_to_file(&app, &msg);
                    msg
                })?;
                
                log_to_file(&app, &format!("[discover_server] Servidor encontrado: {:?}", data));
                return Ok(data);
            }
            Err(e) => {
                last_error = format!("[discover_server] Falha ao conectar ao host {}:25566 (tentativa {}/{}): {}", host_ip, attempt, max_attempts, e);
                log_to_file(&app, &last_error);
                
                if attempt < max_attempts {
                    log_to_file(&app, &format!("[discover_server] Aguardando 1s antes da próxima tentativa..."));
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }
    
    Err(last_error)
}

// ============================================================
// Camada de Sincronização com API Central (SyncEngine)
// ============================================================
//
// Esta camada substitui os comandos diretos de API por um sistema
// robusto de fila persistente com retry, backoff exponencial e
// telemetria operacional.
//
// Conceitos:
// - SyncQueue: Fila persistente em disco de operações pendentes
// - SyncEngine: Motor que processa a fila periodicamente
// - SyncTelemetry: Métricas de diagnóstico operacional
//
// Fluxo:
// 1. Comando Tauri → enfileira operação + tenta executar imediatamente
// 2. Se falhar (sem internet, API indisponível), fica na fila
// 3. SyncEngine processa a fila a cada 30s com backoff exponencial
// 4. Quando a conexão voltar, as operações são sincronizadas automaticamente

use uuid::Uuid;

/// URL base da API Central do CubeForge
const API_BASE_URL: &str = "https://cubeforge-api.cubeforge.workers.dev";

// ============================================================
// Tipos da Fila de Sincronização
// ============================================================

/// Tipos de operação suportados pela fila de sincronização
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
enum SyncOperationType {
    RegisterServer,
    UpdateServer,
    DeleteServer,
    CreateSession,
    UpdateSession,
    DeleteSession,
    Heartbeat,
}

/// Uma operação na fila de sincronização
#[derive(Serialize, Deserialize, Clone, Debug)]
struct SyncOperation {
    id: String,                    // UUID único da operação
    op_type: SyncOperationType,    // Tipo da operação
    payload: serde_json::Value,    // Payload da operação
    created_at: String,            // Timestamp ISO de criação
    retry_count: u32,              // Número de tentativas já realizadas
    last_attempt: Option<String>,  // Timestamp ISO da última tentativa
}

/// Estado da fila de sincronização
#[derive(Serialize, Deserialize, Clone, Debug)]
struct SyncQueueState {
    operations: Vec<SyncOperation>,
}

/// Métricas de telemetria operacional
#[derive(Serialize, Deserialize, Clone, Debug)]
struct SyncTelemetry {
    total_sync_attempts: u64,
    total_sync_success: u64,
    total_sync_failures: u64,
    total_retries: u64,
    pending_operations: usize,
    failed_operations: usize,
    avg_response_time_ms: f64,
    last_sync_time: Option<String>,
    api_available: bool,
}

impl Default for SyncTelemetry {
    fn default() -> Self {
        Self {
            total_sync_attempts: 0,
            total_sync_success: 0,
            total_sync_failures: 0,
            total_retries: 0,
            pending_operations: 0,
            failed_operations: 0,
            avg_response_time_ms: 0.0,
            last_sync_time: None,
            api_available: false,
        }
    }
}

// ============================================================
// Gerenciamento da Fila Persistente
// ============================================================

/// Obtém o caminho do arquivo de fila de sincronização
fn get_sync_queue_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(data_dir.join("cubeforge_sync_queue.json"))
}

/// Carrega a fila de sincronização do disco
fn load_sync_queue(app: &tauri::AppHandle) -> SyncQueueState {
    let path = match get_sync_queue_path(app) {
        Ok(p) => p,
        Err(_) => return SyncQueueState { operations: Vec::new() },
    };
    
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                serde_json::from_str(&content).unwrap_or(SyncQueueState { operations: Vec::new() })
            }
            Err(_) => SyncQueueState { operations: Vec::new() },
        }
    } else {
        SyncQueueState { operations: Vec::new() }
    }
}

/// Salva a fila de sincronização no disco
fn save_sync_queue(app: &tauri::AppHandle, state: &SyncQueueState) {
    let path = match get_sync_queue_path(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    
    if let Ok(content) = serde_json::to_string(state) {
        let _ = std::fs::write(&path, &content);
    }
}

/// Adiciona uma operação à fila de sincronização
fn enqueue_operation(
    app: &tauri::AppHandle,
    op_type: SyncOperationType,
    payload: serde_json::Value,
) -> String {
    let mut queue = load_sync_queue(app);
    let id = Uuid::new_v4().to_string();
    
    let operation = SyncOperation {
        id: id.clone(),
        op_type,
        payload,
        created_at: chrono::Utc::now().to_rfc3339(),
        retry_count: 0,
        last_attempt: None,
    };
    
    // Limitar a 100 operações na fila (descarta as mais antigas)
    if queue.operations.len() >= 100 {
        queue.operations.remove(0);
    }
    
    queue.operations.push(operation);
    save_sync_queue(app, &queue);
    
    id
}

/// Remove uma operação da fila pelo ID
fn remove_operation(app: &tauri::AppHandle, operation_id: &str) {
    let mut queue = load_sync_queue(app);
    queue.operations.retain(|op| op.id != operation_id);
    save_sync_queue(app, &queue);
}

/// Remove operações expiradas (> 24h) da fila
fn cleanup_expired_operations(app: &tauri::AppHandle) {
    let mut queue = load_sync_queue(app);
    let cutoff = chrono::Utc::now() - chrono::Duration::hours(24);
    
    queue.operations.retain(|op| {
        if let Ok(created) = chrono::DateTime::parse_from_rfc3339(&op.created_at) {
            created > cutoff
        } else {
            true
        }
    });
    
    save_sync_queue(app, &queue);
}

// ============================================================
// Execução de Operações Individuais
// ============================================================

/// Executa uma operação de sincronização contra a API Central.
/// Retorna Ok(()) se bem-sucedido, Err(String) se falhou.
async fn execute_sync_operation(
    app: &tauri::AppHandle,
    op: &SyncOperation,
    telemetry: &Arc<Mutex<SyncTelemetry>>,
) -> Result<(), String> {
    let start = Instant::now();
    
    let result = match op.op_type {
        SyncOperationType::RegisterServer => {
            execute_register_server(app, &op.payload).await
        }
        SyncOperationType::UpdateServer => {
            execute_update_server(app, &op.payload).await
        }
        SyncOperationType::DeleteServer => {
            execute_delete_server(app, &op.payload).await
        }
        SyncOperationType::CreateSession => {
            execute_create_session(app, &op.payload).await
        }
        SyncOperationType::UpdateSession => {
            execute_update_session(app, &op.payload).await
        }
        SyncOperationType::DeleteSession => {
            execute_delete_session(app, &op.payload).await
        }
        SyncOperationType::Heartbeat => {
            execute_heartbeat(app, &op.payload).await
        }
    };
    
    let elapsed = start.elapsed().as_millis() as f64;
    
    // Atualizar telemetria
    {
        let mut t = telemetry.lock().unwrap();
        t.total_sync_attempts += 1;
        t.last_sync_time = Some(chrono::Utc::now().to_rfc3339());
        
        // Média móvel do tempo de resposta
        if t.avg_response_time_ms == 0.0 {
            t.avg_response_time_ms = elapsed;
        } else {
            t.avg_response_time_ms = (t.avg_response_time_ms * 0.9) + (elapsed * 0.1);
        }
        
        match &result {
            Ok(_) => {
                t.total_sync_success += 1;
                t.api_available = true;
            }
            Err(_) => {
                t.total_sync_failures += 1;
                t.api_available = false;
            }
        }
    }
    
    result
}

/// POST /api/v1/servers — Criar servidor
async fn execute_register_server(app: &tauri::AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let url = format!("{}/api/v1/servers", API_BASE_URL);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client.post(&url)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão: {}", e))?;
    
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }
    
    log_to_file(app, &format!("[SYNC] Servidor registrado: {:?}", body.get("data").and_then(|d| d.get("shortCode"))));
    Ok(())
}

/// PATCH /api/v1/servers/:shortCode — Atualizar servidor
async fn execute_update_server(app: &tauri::AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let short_code = payload.get("shortCode").and_then(|v| v.as_str()).ok_or("shortCode obrigatório")?;
    let url = format!("{}/api/v1/servers/{}", API_BASE_URL, short_code);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client.patch(&url)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão: {}", e))?;
    
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body));
    }
    
    log_to_file(app, &format!("[SYNC] Servidor atualizado: {}", short_code));
    Ok(())
}

/// DELETE /api/v1/servers/:shortCode — Remover servidor
async fn execute_delete_server(app: &tauri::AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let short_code = payload.get("shortCode").and_then(|v| v.as_str()).ok_or("shortCode obrigatório")?;
    let url = format!("{}/api/v1/servers/{}", API_BASE_URL, short_code);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client.delete(&url)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão: {}", e))?;
    
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body));
    }
    
    log_to_file(app, &format!("[SYNC] Servidor removido: {}", short_code));
    Ok(())
}

/// POST /api/v1/servers/:shortCode/sessions — Criar/atualizar sessão
async fn execute_create_session(app: &tauri::AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let short_code = payload.get("shortCode").and_then(|v| v.as_str()).ok_or("shortCode obrigatório")?;
    let url = format!("{}/api/v1/servers/{}/sessions", API_BASE_URL, short_code);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client.post(&url)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão: {}", e))?;
    
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body));
    }
    
    log_to_file(app, &format!("[SYNC] Sessão criada: {}", short_code));
    Ok(())
}

/// POST /api/v1/servers/:shortCode/heartbeat — Atualizar sessão (via heartbeat com status)
/// A API Central não tem PATCH /sessions. O heartbeat aceita status e currentPlayers no body.
async fn execute_update_session(app: &tauri::AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let short_code = payload.get("shortCode").and_then(|v| v.as_str()).ok_or("shortCode obrigatório")?;
    let url = format!("{}/api/v1/servers/{}/heartbeat", API_BASE_URL, short_code);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client.post(&url)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão: {}", e))?;
    
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body));
    }
    
    log_to_file(app, &format!("[SYNC] Sessão atualizada via heartbeat: {}", short_code));
    Ok(())
}

/// DELETE /api/v1/servers/:shortCode/sessions — Encerrar sessão
async fn execute_delete_session(app: &tauri::AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let short_code = payload.get("shortCode").and_then(|v| v.as_str()).ok_or("shortCode obrigatório")?;
    let url = format!("{}/api/v1/servers/{}/sessions", API_BASE_URL, short_code);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client.delete(&url)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão: {}", e))?;
    
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body));
    }
    
    log_to_file(app, &format!("[SYNC] Sessão encerrada: {}", short_code));
    Ok(())
}

/// POST /api/v1/servers/:shortCode/heartbeat — Heartbeat
async fn execute_heartbeat(_app: &tauri::AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let short_code = payload.get("shortCode").and_then(|v| v.as_str()).ok_or("shortCode obrigatório")?;
    let url = format!("{}/api/v1/servers/{}/heartbeat", API_BASE_URL, short_code);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client.post(&url)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão: {}", e))?;
    
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body));
    }
    
    Ok(())
}

// ============================================================
// Motor de Sincronização (SyncEngine)
// ============================================================

/// Processa a fila de sincronização, executando operações pendentes.
/// Usa backoff exponencial para retry: 30s, 1min, 2min, 4min, 8min, 16min (max)
async fn process_sync_queue(
    app: tauri::AppHandle,
    telemetry: Arc<Mutex<SyncTelemetry>>,
) {
    let queue = load_sync_queue(&app);
    if queue.operations.is_empty() {
        return;
    }
    
    log_to_file(&app, &format!("[SYNC] Processando {} operações pendentes...", queue.operations.len()));
    
    let mut remaining = Vec::new();
    
    for op in queue.operations {
        // Calcular backoff: 30s * 2^retry_count, max 16 min
        let backoff_seconds = std::cmp::min(30 * (2u64.pow(op.retry_count)), 960); // 16 min
        let should_retry = match &op.last_attempt {
            Some(last) => {
                if let Ok(last_time) = chrono::DateTime::parse_from_rfc3339(last) {
                    let elapsed = chrono::Utc::now().signed_duration_since(last_time);
                    elapsed.num_seconds() >= backoff_seconds as i64
                } else {
                    true
                }
            }
            None => true, // Nunca tentou, pode tentar agora
        };
        
        if !should_retry {
            remaining.push(op);
            continue;
        }
        
        // Máximo de 5 tentativas
        if op.retry_count >= 5 {
            log_to_file(&app, &format!("[SYNC] Operação {} excedeu 5 tentativas. Removendo da fila.", op.id));
            {
                let mut t = telemetry.lock().unwrap();
                t.failed_operations += 1;
            }
            continue;
        }
        
        // Tentar executar
        match execute_sync_operation(&app, &op, &telemetry).await {
            Ok(_) => {
                log_to_file(&app, &format!("[SYNC] Operação {} executada com sucesso.", op.id));
                // Não adiciona a `remaining` — foi removida com sucesso
            }
            Err(e) => {
                log_to_file(&app, &format!("[SYNC] Operação {} falhou (tentativa {}/5): {}", op.id, op.retry_count + 1, e));
                let mut updated_op = op.clone();
                updated_op.retry_count += 1;
                updated_op.last_attempt = Some(chrono::Utc::now().to_rfc3339());
                
                {
                    let mut t = telemetry.lock().unwrap();
                    t.total_retries += 1;
                }
                
                remaining.push(updated_op);
            }
        }
    }
    
    // Salvar operações restantes
    let new_queue = SyncQueueState { operations: remaining };
    save_sync_queue(&app, &new_queue);
    
    // Atualizar telemetria
    {
        let mut t = telemetry.lock().unwrap();
        t.pending_operations = new_queue.operations.len();
    }
    
    // Limpar operações expiradas
    cleanup_expired_operations(&app);
}

// ============================================================
// Comandos Tauri da Camada de Sincronização
// ============================================================

/// Registra um servidor na API Central (via fila de sincronização).
/// Enfileira a operação e tenta executar imediatamente.
#[tauri::command]
async fn sync_register_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
    name: String,
    version: String,
    server_type: String,
    description: String,
    short_code: Option<String>,
    owner: Option<String>,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, &format!("[SYNC] sync_register_server: name={}, version={}", name, version));

    // Guarda o shortCode ativo para que o shutdown gracioso saiba qual servidor
    // notificar como offline caso o app seja fechado sem um heartbeat prévio.
    if let Some(ref sc) = short_code {
        *state.active_short_code.lock().unwrap() = Some(sc.clone());
    }

    let payload = serde_json::json!({
        "name": name,
        "version": version,
        "serverType": server_type,
        "description": description,
        "shortCode": short_code,
        "owner": owner,
    });
    
    let op_id = enqueue_operation(&app, SyncOperationType::RegisterServer, payload.clone());
    log_to_file(&app, &format!("[SYNC] Operação enfileirada: {}", op_id));
    
    // Tentar executar imediatamente
    let op = SyncOperation {
        id: op_id.clone(),
        op_type: SyncOperationType::RegisterServer,
        payload: payload.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        retry_count: 0,
        last_attempt: None,
    };
    
    match execute_sync_operation(&app, &op, &telemetry).await {
        Ok(_) => {
            remove_operation(&app, &op_id);
            log_to_file(&app, "[SYNC] Servidor registrado com sucesso!");
            Ok(serde_json::json!({
                "success": true,
                "code": "SERVER_CREATED",
                "message": "Servidor registrado com sucesso.",
                "data": payload,
            }))
        }
        Err(e) => {
            log_to_file(&app, &format!("[SYNC] Falha ao registrar (ficou na fila): {}", e));
            Ok(serde_json::json!({
                "success": true,
                "code": "QUEUED",
                "message": "Operação enfileirada para sincronização.",
                "data": {
                    "operationId": op_id,
                    "pending": true,
                },
            }))
        }
    }
}

/// Atualiza metadados do servidor na API Central.
#[tauri::command]
async fn sync_update_server(
    app: tauri::AppHandle,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
    short_code: String,
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, &format!("[SYNC] sync_update_server: short_code={}", short_code));
    
    let mut payload = serde_json::json!({
        "shortCode": short_code,
    });
    
    if let Some(n) = name { payload["name"] = serde_json::json!(n); }
    if let Some(v) = version { payload["version"] = serde_json::json!(v); }
    if let Some(d) = description { payload["description"] = serde_json::json!(d); }
    
    let op_id = enqueue_operation(&app, SyncOperationType::UpdateServer, payload);
    
    // Tentar executar imediatamente
    let queue = load_sync_queue(&app);
    if let Some(op) = queue.operations.iter().find(|o| o.id == op_id) {
        match execute_sync_operation(&app, op, &telemetry).await {
            Ok(_) => {
                remove_operation(&app, &op_id);
                Ok(serde_json::json!({ "success": true, "code": "SERVER_UPDATED", "message": "Servidor atualizado." }))
            }
            Err(e) => {
                Ok(serde_json::json!({
                    "success": true, "code": "QUEUED",
                    "message": format!("Operação enfileirada: {}", e),
                    "data": { "operationId": op_id, "pending": true },
                }))
            }
        }
    } else {
        Ok(serde_json::json!({ "success": true, "code": "QUEUED", "message": "Operação enfileirada." }))
    }
}

/// Remove um servidor da API Central.
#[tauri::command]
async fn sync_delete_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
    short_code: String,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, &format!("[SYNC] sync_delete_server: short_code={}", short_code));

    {
        let mut active = state.active_short_code.lock().unwrap();
        if active.as_deref() == Some(short_code.as_str()) {
            *active = None;
        }
    }

    let payload = serde_json::json!({ "shortCode": short_code });
    let op_id = enqueue_operation(&app, SyncOperationType::DeleteServer, payload);
    
    // Tentar executar imediatamente
    let queue = load_sync_queue(&app);
    if let Some(op) = queue.operations.iter().find(|o| o.id == op_id) {
        match execute_sync_operation(&app, op, &telemetry).await {
            Ok(_) => {
                remove_operation(&app, &op_id);
                Ok(serde_json::json!({ "success": true, "code": "SERVER_DELETED", "message": "Servidor removido." }))
            }
            Err(e) => {
                Ok(serde_json::json!({
                    "success": true, "code": "QUEUED",
                    "message": format!("Operação enfileirada: {}", e),
                    "data": { "operationId": op_id, "pending": true },
                }))
            }
        }
    } else {
        Ok(serde_json::json!({ "success": true, "code": "QUEUED", "message": "Operação enfileirada." }))
    }
}

/// Cria/atualiza uma sessão de jogo na API Central.
#[tauri::command]
async fn sync_create_session(
    app: tauri::AppHandle,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
    short_code: String,
    provider: String,
    host_ip: String,
    port: u16,
    status: String,
    current_players: Option<u16>,
    max_players: Option<u16>,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, &format!("[SYNC] sync_create_session: short_code={}, provider={}", short_code, provider));
    
    let payload = serde_json::json!({
        "shortCode": short_code,
        "provider": provider,
        "hostIp": host_ip,
        "port": port,
        "status": status,
        "currentPlayers": current_players,
        "maxPlayers": max_players,
    });
    
    let op_id = enqueue_operation(&app, SyncOperationType::CreateSession, payload);
    
    let queue = load_sync_queue(&app);
    if let Some(op) = queue.operations.iter().find(|o| o.id == op_id) {
        match execute_sync_operation(&app, op, &telemetry).await {
            Ok(_) => {
                remove_operation(&app, &op_id);
                Ok(serde_json::json!({ "success": true, "code": "SESSION_CREATED", "message": "Sessão criada." }))
            }
            Err(e) => {
                Ok(serde_json::json!({
                    "success": true, "code": "QUEUED",
                    "message": format!("Operação enfileirada: {}", e),
                    "data": { "operationId": op_id, "pending": true },
                }))
            }
        }
    } else {
        Ok(serde_json::json!({ "success": true, "code": "QUEUED", "message": "Operação enfileirada." }))
    }
}

/// Atualiza o status de uma sessão na API Central.
#[tauri::command]
async fn sync_update_session(
    app: tauri::AppHandle,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
    short_code: String,
    status: String,
    current_players: Option<u16>,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, &format!("[SYNC] sync_update_session: short_code={}, status={}", short_code, status));
    
    let payload = serde_json::json!({
        "shortCode": short_code,
        "status": status,
        "currentPlayers": current_players,
    });
    
    let op_id = enqueue_operation(&app, SyncOperationType::UpdateSession, payload);
    
    let queue = load_sync_queue(&app);
    if let Some(op) = queue.operations.iter().find(|o| o.id == op_id) {
        match execute_sync_operation(&app, op, &telemetry).await {
            Ok(_) => {
                remove_operation(&app, &op_id);
                Ok(serde_json::json!({ "success": true, "code": "SESSION_UPDATED", "message": "Sessão atualizada." }))
            }
            Err(e) => {
                Ok(serde_json::json!({
                    "success": true, "code": "QUEUED",
                    "message": format!("Operação enfileirada: {}", e),
                    "data": { "operationId": op_id, "pending": true },
                }))
            }
        }
    } else {
        Ok(serde_json::json!({ "success": true, "code": "QUEUED", "message": "Operação enfileirada." }))
    }
}

/// Encerra uma sessão na API Central.
#[tauri::command]
async fn sync_delete_session(
    app: tauri::AppHandle,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
    short_code: String,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, &format!("[SYNC] sync_delete_session: short_code={}", short_code));
    
    let payload = serde_json::json!({ "shortCode": short_code });
    let op_id = enqueue_operation(&app, SyncOperationType::DeleteSession, payload);
    
    let queue = load_sync_queue(&app);
    if let Some(op) = queue.operations.iter().find(|o| o.id == op_id) {
        match execute_sync_operation(&app, op, &telemetry).await {
            Ok(_) => {
                remove_operation(&app, &op_id);
                Ok(serde_json::json!({ "success": true, "code": "SESSION_DELETED", "message": "Sessão encerrada." }))
            }
            Err(e) => {
                Ok(serde_json::json!({
                    "success": true, "code": "QUEUED",
                    "message": format!("Operação enfileirada: {}", e),
                    "data": { "operationId": op_id, "pending": true },
                }))
            }
        }
    } else {
        Ok(serde_json::json!({ "success": true, "code": "QUEUED", "message": "Operação enfileirada." }))
    }
}

/// Envia heartbeat para a API Central (via fila de sincronização).
#[tauri::command]
async fn sync_send_heartbeat(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
    short_code: String,
    status: String,
    current_players: Option<u16>,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, &format!("[SYNC] sync_send_heartbeat: short_code={}, status={}", short_code, status));

    *state.active_short_code.lock().unwrap() = Some(short_code.clone());

    let payload = serde_json::json!({
        "shortCode": short_code,
        "status": status,
        "currentPlayers": current_players,
    });
    
    let op_id = enqueue_operation(&app, SyncOperationType::Heartbeat, payload);
    
    let queue = load_sync_queue(&app);
    if let Some(op) = queue.operations.iter().find(|o| o.id == op_id) {
        match execute_sync_operation(&app, op, &telemetry).await {
            Ok(_) => {
                remove_operation(&app, &op_id);
                Ok(serde_json::json!({ "success": true, "code": "HEARTBEAT_RECEIVED", "message": "Heartbeat enviado." }))
            }
            Err(e) => {
                Ok(serde_json::json!({
                    "success": true, "code": "QUEUED",
                    "message": format!("Heartbeat enfileirado: {}", e),
                    "data": { "operationId": op_id, "pending": true },
                }))
            }
        }
    } else {
        Ok(serde_json::json!({ "success": true, "code": "QUEUED", "message": "Heartbeat enfileirado." }))
    }
}

/// Retorna o estado atual da fila de sincronização.
#[tauri::command]
async fn get_sync_queue_status(
    app: tauri::AppHandle,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
) -> Result<serde_json::Value, String> {
    let queue = load_sync_queue(&app);
    let t = telemetry.lock().unwrap();
    
    Ok(serde_json::json!({
        "pendingOperations": queue.operations.len(),
        "operations": queue.operations.iter().map(|op| {
            serde_json::json!({
                "id": op.id,
                "type": format!("{:?}", op.op_type),
                "retryCount": op.retry_count,
                "createdAt": op.created_at,
                "lastAttempt": op.last_attempt,
            })
        }).collect::<Vec<_>>(),
        "telemetry": {
            "totalSyncAttempts": t.total_sync_attempts,
            "totalSyncSuccess": t.total_sync_success,
            "totalSyncFailures": t.total_sync_failures,
            "totalRetries": t.total_retries,
            "pendingOperations": t.pending_operations,
            "failedOperations": t.failed_operations,
            "avgResponseTimeMs": t.avg_response_time_ms,
            "lastSyncTime": t.last_sync_time,
            "apiAvailable": t.api_available,
        },
    }))
}

/// Força o processamento imediato da fila de sincronização.
#[tauri::command]
async fn force_sync_now(
    app: tauri::AppHandle,
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
) -> Result<serde_json::Value, String> {
    log_to_file(&app, "[SYNC] force_sync_now: Processando fila imediatamente...");
    process_sync_queue(app.clone(), telemetry.inner().clone()).await;
    
    let queue = load_sync_queue(&app);
    Ok(serde_json::json!({
        "success": true,
        "remainingOperations": queue.operations.len(),
    }))
}

/// Retorna as métricas de telemetria operacional.
#[tauri::command]
async fn get_sync_telemetry(
    telemetry: tauri::State<'_, Arc<Mutex<SyncTelemetry>>>,
) -> Result<serde_json::Value, String> {
    let t = telemetry.lock().unwrap();
    Ok(serde_json::json!({
        "totalSyncAttempts": t.total_sync_attempts,
        "totalSyncSuccess": t.total_sync_success,
        "totalSyncFailures": t.total_sync_failures,
        "totalRetries": t.total_retries,
        "pendingOperations": t.pending_operations,
        "failedOperations": t.failed_operations,
        "avgResponseTimeMs": t.avg_response_time_ms,
        "lastSyncTime": t.last_sync_time,
        "apiAvailable": t.api_available,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Shutdown gracioso completo: para o servidor Minecraft, encerra o sidecar
/// Tailscale, notifica a API Central e então finaliza o processo do app de vez.
/// Só é chamado a partir do "Sair" do tray — fechar a janela (X) agora apenas
/// esconde o app para o system tray, mantendo servidor e rede mesh no ar.
async fn graceful_shutdown_and_exit(app: tauri::AppHandle) {
  log_to_file(&app, "=== SHUTDOWN GRACIOSO (Sair pelo tray) ===");

  // 1. Encerrar servidor Minecraft se ainda estiver rodando
  {
    let state_ref = app.state::<AppState>();
    state_ref.minecraft_stop_requested.store(true, Ordering::SeqCst);

    let has_stdin = {
      let mut stdin_guard = state_ref.minecraft_stdin.lock().unwrap();
      if let Some(ref mut stdin) = *stdin_guard {
        let _ = stdin.write_all(b"stop\n");
        let _ = stdin.flush();
        true
      } else {
        false
      }
    };

    if has_stdin {
      log_to_file(&app, "[SHUTDOWN] Comando stop enviado ao servidor Minecraft. Aguardando 5s...");
      // Aguarda até 5 segundos pelo servidor fechar
      for _ in 0..5 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let still_running = {
          let mut guard = state_ref.minecraft_process.lock().unwrap();
          if let Some(ref mut child) = *guard {
            matches!(child.try_wait(), Ok(None))
          } else {
            false
          }
        };
        if !still_running { break; }
      }

      // Forçar kill se ainda estiver rodando
      let mut guard = state_ref.minecraft_process.lock().unwrap();
      if let Some(ref mut child) = *guard {
        if matches!(child.try_wait(), Ok(None)) {
          log_to_file(&app, "[SHUTDOWN] Forçando kill do servidor Minecraft.");
          let _ = child.kill();
        }
      }
      *guard = None;
      *state_ref.minecraft_stdin.lock().unwrap() = None;
    }
  }

  // 2. Parar sidecar Tailscale
  {
    let state_ref = app.state::<AppState>();
    let mut process = state_ref.sidecar_process.lock().unwrap();
    if let Some(child) = process.take() {
      log_to_file(&app, "[SHUTDOWN] Encerrando sidecar Tailscale.");
      let _ = child.kill();
    }
  }

  // 3. Remover arquivo JSON temporário do Tailscale
  if let Ok(data_dir) = app.path().app_local_data_dir() {
    let config_path = data_dir.join("tsnet_config.json");
    if config_path.exists() {
      let _ = std::fs::remove_file(&config_path);
    }
  }

  // 4. Notificar a API Central que o servidor ficou offline (best-effort,
  // timeout curto para não travar o fechamento em caso de rede lenta/indisponível).
  // Sem isso, fechar o app deixava o status "online" na API até o timeout de
  // 5min do lado do servidor, mostrando informação falsa para os convidados.
  let short_code_opt = {
    let state_ref = app.state::<AppState>();
    let sc = state_ref.active_short_code.lock().unwrap().clone();
    sc
  };
  if let Some(short_code) = short_code_opt {
    log_to_file(&app, &format!("[SHUTDOWN] Notificando API Central: {} está offline...", short_code));
    let payload = serde_json::json!({
      "shortCode": short_code,
      "status": "offline",
      "currentPlayers": null,
    });
    if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(3)).build() {
      let url = format!("{}/api/v1/servers/{}/heartbeat", API_BASE_URL, short_code);
      match client.post(&url).json(&payload).send().await {
        Ok(_) => log_to_file(&app, "[SHUTDOWN] API Central notificada com sucesso."),
        Err(e) => log_to_file(&app, &format!("[SHUTDOWN] Falha ao notificar API Central (offline): {}", e)),
      }
    }
  }

  log_to_file(&app, "[SHUTDOWN] Cleanup concluído. Encerrando processo.");
  app.exit(0);
}

pub fn run() {
  let registry = Arc::new(ServerRegistry {
      entries: Mutex::new(BTreeMap::new()),
  });
  
  let telemetry = Arc::new(Mutex::new(SyncTelemetry::default()));
  
  // Iniciar servidor HTTP de registro em background
  start_registry_http_server(registry.clone());
  
  // Iniciar motor de sincronização periódico (a cada 30 segundos)
  let telemetry_clone = telemetry.clone();
  
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_process::init())
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      
      // Limpar operações obsoletas da fila (que usavam PATCH /sessions, agora inexistente)
      // e operações com mais de 5 tentativas para não poluir a fila com lixo
      {
        let mut queue = load_sync_queue(app.handle());
        let before = queue.operations.len();
        queue.operations.retain(|op| {
          // Remover UpdateSession antigos (que tentavam PATCH /sessions - endpoint removido)
          if op.op_type == SyncOperationType::UpdateSession && op.retry_count >= 1 {
            return false;
          }
          // Remover Heartbeat com retry_count >= 3 (provavelmente sessão não existe)
          if op.op_type == SyncOperationType::Heartbeat && op.retry_count >= 3 {
            return false;
          }
          true
        });
        let removed = before - queue.operations.len();
        if removed > 0 {
          log_to_file(app.handle(), &format!("[SYNC] Cleanup: {} operações obsoletas removidas da fila.", removed));
        }
        save_sync_queue(app.handle(), &queue);
      }
      
      // Iniciar o motor de sincronização periódico (a cada 30 segundos)
      let app_handle = app.handle().clone();
      let telemetry = telemetry_clone.clone();
      tauri::async_runtime::spawn(async move {
        loop {
          tokio::time::sleep(Duration::from_secs(30)).await;
          process_sync_queue(app_handle.clone(), telemetry.clone()).await;
        }
      });

      // --- System tray ---
      // Fechar a janela (X) esconde o app em vez de encerrá-lo (ver on_window_event);
      // o tray é o que fica visível para o usuário voltar ao app ou realmente sair.
      let tray_menu = MenuBuilder::new(app)
        .text("show", "Abrir Cubicase")
        .separator()
        .text("quit", "Sair (encerra servidor e rede mesh)")
        .build()?;

      TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Cubicase")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
          match event.id().as_ref() {
            "show" => {
              if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
              }
            }
            "quit" => {
              let state_ref = app.state::<AppState>();
              // swap garante que o cleanup só roda uma vez mesmo se o usuário
              // clicar "Sair" mais de uma vez rapidamente.
              if !state_ref.is_shutting_down.swap(true, Ordering::SeqCst) {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(graceful_shutdown_and_exit(app_clone));
              }
            }
            _ => {}
          }
        })
        .on_tray_icon_event(|tray, event| {
          // Clique esquerdo no ícone reabre a janela (padrão de apps como
          // Discord/Steam), sem precisar abrir o menu do tray.
          if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            let app = tray.app_handle();
            if let Some(win) = app.get_webview_window("main") {
              let _ = win.show();
              let _ = win.set_focus();
            }
          }
        })
        .build(app)?;

      Ok(())
    })
    .manage(AppState::default())
    .manage(registry)
    .manage(telemetry)
    .invoke_handler(tauri::generate_handler![
       start_network_node,
       stop_network_node,
       download_server_jar,
       start_minecraft_server,
       run_forge_installer,
       stop_minecraft_server,
       send_minecraft_command,
       get_system_status,
       get_total_memory,
       read_server_properties,
       write_server_properties,
       set_server_icon,
       get_server_icon,
       remove_server_icon,
       update_server_registry,
       remove_server_registry,
       discover_server,
       // Comandos de gerenciamento de mods e mundo
       list_mods,
       toggle_mod,
       delete_mod,
       open_path_in_explorer,
       list_world_backups,
       backup_world,
       restore_world_backup,
       delete_world_backup,
       reset_world,
       // Comandos de import de modpacks (CurseForge/Modrinth)
       read_modpack_manifest,
       extract_modpack_overrides,
       // Comandos de sincronização com API Central
       sync_register_server,
       sync_update_server,
       sync_delete_server,
       sync_create_session,
       sync_update_session,
       sync_delete_session,
       sync_send_heartbeat,
       get_sync_queue_status,
       force_sync_now,
       get_sync_telemetry,
    ])
    .on_window_event(|window, event| {
      // Fechar a janela (X) não encerra mais o app: só esconde para o system tray.
      // Servidor Minecraft e rede mesh continuam rodando em segundo plano — só param
      // de verdade pelo "Sair" do menu do tray (ver setup() para o tray) ou se o
      // processo for finalizado à força (o job_object garante que os filhos também
      // morrem nesse caso, ver job_object.rs).
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
