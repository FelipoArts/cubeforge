use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::fs::File;
use std::io::{Write, BufRead, BufReader};
use std::time::Duration;
use std::net::TcpStream;
use serde::{Serialize, Deserialize};
use serde_json;
use std::collections::HashMap;
use tauri::{Manager, Emitter};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

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

    // Flag para evitar loop infinito no CloseRequested:
    // Quando o shutdown gracioso termina e chama win.close(), o evento
    // CloseRequested é disparado novamente. Esta flag impede reentrância.
    is_shutting_down: AtomicBool,
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
async fn download_server_jar(url: String, dest_path: String) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300)) // 5 minutos de timeout para arquivos grandes
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Falha no download: HTTP {}", response.status()));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let mut file = File::create(&dest_path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
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
) -> Result<(), String> {
    log_to_file(&app, &format!("=== INICIANDO SERVIDOR MC (dir={}, porta={}, ram={}GB) ===", server_dir, local_port, ram_gb));

    // Parar qualquer servidor que já esteja rodando
    stop_minecraft_server_internal(&app, &state).await;

    // Construir argumentos do Java
    let args = vec![
        format!("-Xms512M"),
        format!("-Xmx{}G", ram_gb),
        "-jar".to_string(),
        "server.jar".to_string(),
        "nogui".to_string(),
    ];

    log_to_file(&app, &format!("Executando: {} {:?}", java_path, args));

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

    // Extrair stdin antes de mover `child` para o Mutex
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Guardar processo e stdin no estado global
    {
        state.minecraft_stop_requested.store(false, Ordering::SeqCst);
        *state.minecraft_stdin.lock().unwrap() = stdin;
        *state.minecraft_process.lock().unwrap() = Some(child);
    }

    // --- Contagem de crash-reports ANTES de o servidor iniciar ---
    // Salvamos o número de arquivos na pasta crash-reports (se existir)
    // para comparar quando o servidor fechar. Se houver MAIS arquivos
    // no momento do fechamento, significa que houve um crash.
    let crash_reports_before = {
        let crash_dir = std::path::Path::new(&server_dir).join("crash-reports");
        if crash_dir.exists() && crash_dir.is_dir() {
            match std::fs::read_dir(&crash_dir) {
                Ok(entries) => entries.flatten().filter(|e| e.metadata().map(|m| m.is_file()).unwrap_or(false)).count(),
                Err(_) => 0,
            }
        } else {
            0
        }
    };
    log_to_file(&app, &format!("[MC] Contagem de crash-reports antes de iniciar: {}", crash_reports_before));

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
                        // Detect server ready line
                        if l.contains("Done (") && l.contains("INFO") {
                            // Marcar que o servidor ficou online (para a thread de polling TCP
                            // não emitir "crashed" quando o servidor for parado depois)
                            let state_ref = unsafe { &*(state_stdout_handle as *const AppState) };
                            state_ref.minecraft_was_online.store(true, Ordering::SeqCst);
                            let _ = app_stdout.emit("minecraft-status-changed", "online");
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // --- Thread de leitura de stderr ---
    let app_stderr = app.clone();
    if let Some(stderr_pipe) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr_pipe);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        log_to_file(&app_stderr, &format!("[MC-Stderr] {}", l));
                        let _ = app_stderr.emit("minecraft-log", &l);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // --- Rotina de polling TCP para detectar quando o servidor está online ---
    // Primeiro tenta ler a porta configurada em server.properties, se existir.
    // Caso falhe, usa a porta fornecida via parâmetro `local_port`.
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
    std::thread::spawn(move || {
        log_to_file(&app_monitor, &format!("[MC-DEBUG] Thread de monitoramento iniciada. crash_reports_before={}", crash_reports_before));
        
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

        // Estratégia 2: Comparar crash-reports antes vs depois
        let crash_reports_after = {
            let crash_dir = std::path::Path::new(&server_dir_monitor).join("crash-reports");
            if crash_dir.exists() && crash_dir.is_dir() {
                match std::fs::read_dir(&crash_dir) {
                    Ok(entries) => entries.flatten().filter(|e| e.metadata().map(|m| m.is_file()).unwrap_or(false)).count(),
                    Err(_) => 0,
                }
            } else {
                0
            }
        };
        let has_new_crash_report = crash_reports_after > crash_reports_before;
        log_to_file(&app_monitor, &format!("[MC-DEBUG] crash_reports_after={}, crash_reports_before={}, has_new_crash_report={}",
            crash_reports_after, crash_reports_before, has_new_crash_report));

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

        if is_normal_shutdown && !is_crash_by_report {
            log_to_file(&app_monitor, "[MC] Parada NORMAL detectada. Emitindo 'offline'.");
            let _ = app_monitor.emit("minecraft-status-changed", "offline");
        } else if is_crash_by_report {
            log_to_file(&app_monitor, "[MC] CRASH detectado via crash-reports. Emitindo 'crashed'.");
            let _ = app_monitor.emit("minecraft-status-changed", "crashed");
        } else {
            log_to_file(&app_monitor, &format!("[MC] CRASH detectado: exit_code={:?}, stop_requested={}, crash_reports_aumentou={}. Emitindo 'crashed'.",
                exit_code, stop_requested, has_new_crash_report));
            let _ = app_monitor.emit("minecraft-status-changed", "crashed");
        }
    });

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

/// Retorna o total de memória RAM do sistema em bytes.
#[tauri::command]
fn get_total_memory() -> Result<u64, String> {
    if cfg!(target_os = "windows") {
        let output = std::process::Command::new("wmic")
            .args(&["computersystem", "get", "totalphysicalmemory"])
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                let clean = line.trim();
                if !clean.is_empty() && clean.chars().all(|c| c.is_digit(10)) {
                    if let Ok(bytes) = clean.parse::<u64>() {
                        return Ok(bytes);
                    }
                }
            }
        }
        // Fallback para PowerShell se wmic falhar
        let output = std::process::Command::new("powershell")
            .args(&["-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"])
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Ok(bytes) = stdout.trim().parse::<u64>() {
                return Ok(bytes);
            }
        }
    }
    // Default fallback (8GB)
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
    .invoke_handler(tauri::generate_handler![
       start_network_node,
       stop_network_node,
       download_server_jar,
       start_minecraft_server,
       stop_minecraft_server,
       send_minecraft_command,
       get_total_memory,
       read_server_properties,
       write_server_properties,
    ])
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
      // Interceptar CloseRequested para fazer shutdown gracioso:
      // 1. Parar servidor Minecraft (enviar comando stop)
      // 2. Parar rede mesh (sidecar Tailscale)
      // 3. Só então permitir o fechamento da janela
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let state_ref = app.state::<AppState>();
        
        // Verificar se já estamos no processo de shutdown (evita loop infinito
        // quando chamamos win.close() após o cleanup)
        if state_ref.is_shutting_down.load(Ordering::SeqCst) {
          // Já estamos desligando, permitir o fechamento
          return;
        }
        
        // Marcar que estamos em shutdown e prevenir fechamento imediato
        state_ref.is_shutting_down.store(true, Ordering::SeqCst);
        api.prevent_close();
        
        // Spawnar uma task assíncrona para fazer o shutdown gracioso
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
          log_to_file(&app_clone, "=== SHUTDOWN GRACIOSO (fechamento de janela) ===");
          
          // 1. Encerrar servidor Minecraft se ainda estiver rodando
          {
            let state_ref = app_clone.state::<AppState>();
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
              log_to_file(&app_clone, "[SHUTDOWN] Comando stop enviado ao servidor Minecraft. Aguardando 5s...");
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
                  log_to_file(&app_clone, "[SHUTDOWN] Forçando kill do servidor Minecraft.");
                  let _ = child.kill();
                }
              }
              *guard = None;
              *state_ref.minecraft_stdin.lock().unwrap() = None;
            }
          }
          
          // 2. Parar sidecar Tailscale
          {
            let state_ref = app_clone.state::<AppState>();
            let mut process = state_ref.sidecar_process.lock().unwrap();
            if let Some(child) = process.take() {
              log_to_file(&app_clone, "[SHUTDOWN] Encerrando sidecar Tailscale.");
              let _ = child.kill();
            }
          }
          
          // 3. Remover arquivo JSON temporário do Tailscale
          if let Ok(data_dir) = app_clone.path().app_local_data_dir() {
            let config_path = data_dir.join("tsnet_config.json");
            if config_path.exists() {
              let _ = std::fs::remove_file(&config_path);
            }
          }
          
          log_to_file(&app_clone, "[SHUTDOWN] Cleanup concluído. Fechando janela.");
          
          // Agora podemos fechar a janela de verdade
          // A flag is_shutting_down já está true, então o próximo CloseRequested
          // será ignorado e a janela fechará normalmente.
          if let Some(win) = app_clone.get_webview_window("main") {
            let _ = win.close();
          }
        });
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
