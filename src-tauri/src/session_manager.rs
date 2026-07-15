use crate::api_client::{ApiClient, ConnectionSessionResponse};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::sync::Arc;

// ============================================================
// Estados da ConnectionSession (Máquina de Estados)
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum SessionStatus {
    Creating,
    StartingProvider,
    WaitingProvider,
    Online,
    Degraded,
    Stopping,
    Stopped,
    Failed,
    Cancelled,
}

impl SessionStatus {
    pub fn to_str(&self) -> &'static str {
        match self {
            SessionStatus::Creating => "creating",
            SessionStatus::StartingProvider => "starting_provider",
            SessionStatus::WaitingProvider => "waiting_provider",
            SessionStatus::Online => "online",
            SessionStatus::Degraded => "degraded",
            SessionStatus::Stopping => "stopping",
            SessionStatus::Stopped => "stopped",
            SessionStatus::Failed => "failed",
            SessionStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "creating" => Some(SessionStatus::Creating),
            "starting_provider" => Some(SessionStatus::StartingProvider),
            "waiting_provider" => Some(SessionStatus::WaitingProvider),
            "online" => Some(SessionStatus::Online),
            "degraded" => Some(SessionStatus::Degraded),
            "stopping" => Some(SessionStatus::Stopping),
            "stopped" => Some(SessionStatus::Stopped),
            "failed" => Some(SessionStatus::Failed),
            "cancelled" => Some(SessionStatus::Cancelled),
            _ => None,
        }
    }
}

// ============================================================
// Razões de Encerramento
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum TerminationReason {
    UserStopped,
    ApplicationClosed,
    ProviderError,
    ApiError,
    Crash,
    Timeout,
    LeaseExpired,
}

impl TerminationReason {
    pub fn to_str(&self) -> &'static str {
        match self {
            TerminationReason::UserStopped => "user_stopped",
            TerminationReason::ApplicationClosed => "application_closed",
            TerminationReason::ProviderError => "provider_error",
            TerminationReason::ApiError => "api_error",
            TerminationReason::Crash => "crash",
            TerminationReason::Timeout => "timeout",
            TerminationReason::LeaseExpired => "lease_expired",
        }
    }
}

// ============================================================
// Timing da Sessão
// ============================================================

#[derive(Debug, Clone)]
pub struct SessionTiming {
    pub api_call_ms: Option<u64>,
    pub provider_start_ms: Option<u64>,
    pub provider_wait_ms: Option<u64>,
    pub total_elapsed_ms: Option<u64>,
    pub started_at: Instant,
}

impl Default for SessionTiming {
    fn default() -> Self {
        Self {
            api_call_ms: None,
            provider_start_ms: None,
            provider_wait_ms: None,
            total_elapsed_ms: None,
            started_at: Instant::now(),
        }
    }
}

// ============================================================
// Estado interno da Sessão
// ============================================================

#[derive(Debug)]
struct SessionState {
    status: SessionStatus,
    session_id: Option<String>,
    short_code: Option<String>,
    correlation_id: Option<String>,
    provider: Option<String>,
    host_ip: Option<String>,
    revision: u64,
    retry_count: u32,
    heartbeat_count: u64,
    timing: SessionTiming,
    termination_reason: Option<TerminationReason>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            status: SessionStatus::Cancelled,
            session_id: None,
            short_code: None,
            correlation_id: None,
            provider: None,
            host_ip: None,
            revision: 0,
            retry_count: 0,
            heartbeat_count: 0,
            timing: SessionTiming::default(),
            termination_reason: None,
        }
    }
}

// ============================================================
// SessionManager — Máquina de Estados
// ============================================================

pub struct SessionManager {
    api: Arc<ApiClient>,
    state: Mutex<SessionState>,
}

impl SessionManager {
    pub fn new(api: Arc<ApiClient>) -> Self {
        Self {
            api,
            state: Mutex::new(SessionState::new()),
        }
    }

    // ============================================================
    // Validação de Transições
    // ============================================================

    fn validate_transition(from: &SessionStatus, to: &SessionStatus) -> Result<(), String> {
        match (from, to) {
            // Transições VÁLIDAS
            (SessionStatus::Cancelled, SessionStatus::Creating) => Ok(()),
            (SessionStatus::Creating, SessionStatus::StartingProvider) => Ok(()),
            (SessionStatus::StartingProvider, SessionStatus::WaitingProvider) => Ok(()),
            (SessionStatus::WaitingProvider, SessionStatus::Online) => Ok(()),
            (SessionStatus::WaitingProvider, SessionStatus::Failed) => Ok(()),
            (SessionStatus::WaitingProvider, SessionStatus::Cancelled) => Ok(()),
            (SessionStatus::Online, SessionStatus::Degraded) => Ok(()),
            (SessionStatus::Online, SessionStatus::Stopping) => Ok(()),
            (SessionStatus::Degraded, SessionStatus::Online) => Ok(()),
            (SessionStatus::Degraded, SessionStatus::Stopping) => Ok(()),
            (SessionStatus::Stopping, SessionStatus::Stopped) => Ok(()),
            (SessionStatus::Failed, SessionStatus::Creating) => Ok(()),
            (SessionStatus::Stopped, SessionStatus::Creating) => Ok(()),
            
            // Transições INVÁLIDAS
            _ => Err(format!(
                "Transição inválida: {:?} → {:?}",
                from, to
            )),
        }
    }

    // ============================================================
    // Iniciar Sessão (ponto de entrada principal)
    // ============================================================

    pub async fn start(&self, short_code: &str, local_port: u16) -> Result<ConnectionSessionResponse, String> {
        // Verificar concorrência
        {
            let state = self.state.lock().unwrap();
            if state.status == SessionStatus::Creating
                || state.status == SessionStatus::StartingProvider
                || state.status == SessionStatus::WaitingProvider
                || state.status == SessionStatus::Online
                || state.status == SessionStatus::Degraded
            {
                return Err("Já existe uma operação em andamento. Pare a sessão atual antes de iniciar outra.".into());
            }
        }

        // Transição: CANCELLED → CREATING
        Self::validate_transition(&SessionStatus::Cancelled, &SessionStatus::Creating)
            .map_err(|e| format!("Erro interno: {}", e))?;

        {
            let mut state = self.state.lock().unwrap();
            state.status = SessionStatus::Creating;
            state.short_code = Some(short_code.to_string());
            state.timing = SessionTiming::default();
            state.timing.started_at = Instant::now();
        }

        // Chamar API para criar sessão
        let result = self.api.create_connection_session(short_code).await;

        match result {
            Ok(session) => {
                // Transição: CREATING → STARTING_PROVIDER
                {
                    let mut state = self.state.lock().unwrap();
                    state.session_id = Some(session.session_id.clone());
                    state.provider = Some(session.launcher.clone());
                    state.revision = 1;
                    state.timing.api_call_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);
                    state.status = SessionStatus::StartingProvider;
                }

                Ok(session)
            }
            Err(err) => {
                // Transição: CREATING → FAILED
                let mut state = self.state.lock().unwrap();
                state.status = SessionStatus::Failed;
                state.termination_reason = Some(TerminationReason::ApiError);
                state.timing.total_elapsed_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);

                Err(format!("{}", err))
            }
        }
    }

    // ============================================================
    // Atualizar para WaitingProvider
    // ============================================================

    pub fn set_waiting_provider(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        Self::validate_transition(&state.status, &SessionStatus::WaitingProvider)?;
        state.timing.provider_start_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);
        state.status = SessionStatus::WaitingProvider;
        Ok(())
    }

    // ============================================================
    // Notificar que o sidecar conectou (ONLINE)
    // ============================================================

    pub async fn set_online(&self, host_ip: &str) -> Result<(), String> {
        let session_id;
        let revision;
        let timing;

        {
            let mut state = self.state.lock().unwrap();
            Self::validate_transition(&state.status, &SessionStatus::Online)?;
            state.status = SessionStatus::Online;
            state.host_ip = Some(host_ip.to_string());
            state.timing.provider_wait_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);
            state.timing.total_elapsed_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);

            session_id = state.session_id.clone();
            revision = state.revision;
            timing = state.timing.clone();
        }

        // Notificar API
        if let Some(sid) = session_id {
            let mut timing_map = HashMap::new();
            timing_map.insert("apiCallMs".into(), serde_json::json!(timing.api_call_ms));
            timing_map.insert("providerStartMs".into(), serde_json::json!(timing.provider_start_ms));
            timing_map.insert("providerWaitMs".into(), serde_json::json!(timing.provider_wait_ms));
            timing_map.insert("totalElapsedMs".into(), serde_json::json!(timing.total_elapsed_ms));

            if let Err(e) = self.api.update_connection_session(
                &sid, "online", Some(host_ip), revision,
                None, Some(timing_map), None, None,
            ).await {
                // Se falhar ao notificar, entra em DEGRADED
                let mut state = self.state.lock().unwrap();
                state.status = SessionStatus::Degraded;
                return Err(format!("Sidecar online, mas API falhou: {}", e));
            }
        }

        // Incrementar revision
        {
            let mut state = self.state.lock().unwrap();
            state.revision += 1;
        }

        Ok(())
    }

    // ============================================================
    // Notificar falha (FAILED)
    // ============================================================

    pub async fn set_failed(&self, reason: TerminationReason, error_msg: &str) {
        let session_id;

        {
            let mut state = self.state.lock().unwrap();
            state.status = SessionStatus::Failed;
            state.termination_reason = Some(reason);
            state.timing.total_elapsed_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);
            session_id = state.session_id.clone();
        }

        // Avisar API
        if let Some(sid) = session_id {
            let _ = self.api.delete_connection_session(&sid, reason.to_str()).await;
        }
    }

    // ============================================================
    // Parar a sessão
    // ============================================================

    pub async fn stop(&self) -> Result<(), String> {
        let session_id;
        let revision;

        {
            let mut state = self.state.lock().unwrap();
            Self::validate_transition(&state.status, &SessionStatus::Stopping)?;
            state.status = SessionStatus::Stopping;
            session_id = state.session_id.clone();
            revision = state.revision;
        }

        // Notificar API
        if let Some(sid) = session_id {
            let _ = self.api.update_connection_session(
                &sid, "stopping", None, revision,
                None, None, None, Some("user_stopped"),
            ).await;
            let _ = self.api.delete_connection_session(&sid, "user_stopped").await;
        }

        {
            let mut state = self.state.lock().unwrap();
            state.status = SessionStatus::Stopped;
            state.termination_reason = Some(TerminationReason::UserStopped);
            state.revision += 1;
        }

        Ok(())
    }

    // ============================================================
    // Cleanup (onCloseRequested)
    // ============================================================

    pub async fn cleanup(&self) {
        let session_id;

        {
            let state = self.state.lock().unwrap();
            session_id = state.session_id.clone();
        }

        if let Some(sid) = session_id {
            let _ = self.api.delete_connection_session(&sid, "application_closed").await;
        }

        let mut state = self.state.lock().unwrap();
        state.status = SessionStatus::Cancelled;
        state.termination_reason = Some(TerminationReason::ApplicationClosed);
    }

    // ============================================================
    // Enviar Heartbeat
    // ============================================================

    pub async fn send_heartbeat(&self) -> Result<(), String> {
        let state = self.state.lock().unwrap();
        let session_id = state.session_id.clone();
        let status = state.status;
        let players = 0; // TODO: obter do Minecraft
        drop(state);

        if status != SessionStatus::Online && status != SessionStatus::Degraded {
            return Ok(()); // Só manda heartbeat se estiver ativa
        }

        if let Some(sid) = session_id {
            let mut metrics = HashMap::new();
            metrics.insert("currentPlayers".into(), serde_json::json!(players));

            self.api.send_heartbeat(&sid, Some(metrics)).await
                .map_err(|e| format!("Heartbeat falhou: {}", e))?;

            let mut state = self.state.lock().unwrap();
            state.heartbeat_count += 1;
        }

        Ok(())
    }

    // ============================================================
    // Getters
    // ============================================================

    pub fn get_status(&self) -> SessionStatus {
        self.state.lock().unwrap().status
    }

    pub fn get_session_id(&self) -> Option<String> {
        self.state.lock().unwrap().session_id.clone()
    }

    pub fn get_host_ip(&self) -> Option<String> {
        self.state.lock().unwrap().host_ip.clone()
    }

    pub fn get_heartbeat_count(&self) -> u64 {
        self.state.lock().unwrap().heartbeat_count
    }
}