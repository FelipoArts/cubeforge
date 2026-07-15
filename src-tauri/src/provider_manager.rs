use crate::api_client::ConnectionSessionResponse;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::mpsc;
use std::io::Write;

/// ProviderManager — sabe qual sidecar iniciar baseado no launcher
/// Recebe credentials como blob opaco — não sabe o formato.
pub struct ProviderManager;

impl ProviderManager {
    pub fn new() -> Self {
        Self
    }

    /// Inicia o sidecar apropriado baseado no launcher.
    pub async fn start_provider(
        &self,
        app: &AppHandle,
        session: &ConnectionSessionResponse,
        mode: &str,
        local_port: u16,
    ) -> Result<(CommandChild, mpsc::Receiver<CommandEvent>), String> {
        match session.launcher.as_str() {
            "tsnet-v1" => {
                self.start_tsnet(app, &session.credentials, mode, local_port, &session.session_id).await
            }
            "mock-v1" => {
                self.start_mock(app, &session.credentials, mode, local_port).await
            }
            other => Err(format!("Launcher '{}' não é suportado pelo ProviderManager.", other)),
        }
    }

    /// Inicia o sidecar tsnet-node (Tailscale) com arquivo temporário
    async fn start_tsnet(
        &self,
        app: &AppHandle,
        credentials: &serde_json::Value,
        mode: &str,
        local_port: u16,
        session_id: &str,
    ) -> Result<(CommandChild, mpsc::Receiver<CommandEvent>), String> {
        let auth_key = credentials.get("auth_key")
            .or_else(|| credentials.get("authKey"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Credenciais não contêm 'authKey'".to_string())?;

        let hostname = credentials.get("hostname")
            .and_then(|v| v.as_str())
            .unwrap_or("cubeforge-node");

        // Criar pasta de dados
        let data_dir = app.path().app_local_data_dir()
            .map_err(|e| format!("Erro ao obter data_dir: {}", e))?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Erro ao criar data_dir: {}", e))?;

        // Criar arquivo temporário de configuração
        let config_path = data_dir.join(format!("tsnet_{}.json", session_id));
        let config = serde_json::json!({
            "authKey": auth_key,
            "hostname": hostname,
            "mode": mode,
            "targetIp": serde_json::Value::Null,
            "localPort": local_port,
        });
        let config_str = serde_json::to_string(&config)
            .map_err(|e| format!("Erro ao serializar config: {}", e))?;
        
        let mut file = std::fs::File::create(&config_path)
            .map_err(|e| format!("Erro ao criar arquivo temp: {}", e))?;
        file.write_all(config_str.as_bytes())
            .map_err(|e| format!("Erro ao escrever config: {}", e))?;

        let config_path_str = config_path.to_string_lossy().to_string();
        let shell = app.shell();
        // Tauri v2 spawn retorna (Receiver<CommandEvent>, CommandChild)
        let (mut rx, child) = shell
            .sidecar("tsnet-node")
            .map_err(|e| format!("Erro ao criar sidecar: {}", e))?
            .args(["--config", &config_path_str])
            .spawn()
            .map_err(|e| format!("Erro ao spawnar sidecar: {}", e))?;

        Ok((child, rx))
    }

    /// Inicia o provider Mock (para desenvolvimento offline)
    async fn start_mock(
        &self,
        _app: &AppHandle,
        credentials: &serde_json::Value,
        _mode: &str,
        _local_port: u16,
    ) -> Result<(CommandChild, mpsc::Receiver<CommandEvent>), String> {
        let _fake_ip = credentials.get("fakeIp")
            .and_then(|v| v.as_str())
            .unwrap_or("100.99.99.99");

        // Mock não precisa de sidecar real
        // Para simplificar, retornamos erro indicando que o mock deve ser tratado separadamente
        Err("Mock provider não requer sidecar. Use o fluxo mock diretamente.".to_string())
    }
}