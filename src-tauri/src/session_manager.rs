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

    pub async fn start(&self, short_code: &str, mode: &str, local_port: u16) -> Result<ConnectionSessionResponse, String> {
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
        let result = self.api.create_connection_session(short_code, mode).await;

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

        // Notificar API. Com retry curto: a ConnectionSession acabou de ser
        // criada (POST /connection-sessions) segundos antes — se esse PATCH
        // bater num edge do Cloudflare que ainda não replicou a escrita no KV
        // (consistência eventual, não imediata), a API responde
        // SESSION_NOT_FOUND mesmo a sessão existindo de verdade. Sem retry,
        // isso deixava a sessão travada em DEGRADED pra sempre — nenhum
        // heartbeat depois disso corrige o hostIp/status nunca reportados, e
        // ela só some (expira) da API central, sem o convidado nunca ver
        // "online" de verdade. Descoberto testando o wake-on-demand, mas o
        // race já existia antes disso, em qualquer início de hospedagem.
        if let Some(sid) = session_id {
            let mut timing_map = HashMap::new();
            timing_map.insert("apiCallMs".into(), serde_json::json!(timing.api_call_ms));
            timing_map.insert("providerStartMs".into(), serde_json::json!(timing.provider_start_ms));
            timing_map.insert("providerWaitMs".into(), serde_json::json!(timing.provider_wait_ms));
            timing_map.insert("totalElapsedMs".into(), serde_json::json!(timing.total_elapsed_ms));

            const MAX_ATTEMPTS: u32 = 4;
            let mut last_err = String::new();
            let mut succeeded = false;
            for attempt in 1..=MAX_ATTEMPTS {
                match self.api.update_connection_session(
                    &sid, "online", Some(host_ip), revision,
                    None, Some(timing_map.clone()), None, None,
                ).await {
                    Ok(_) => { succeeded = true; break; }
                    Err(e) => {
                        last_err = e.to_string();
                        if attempt < MAX_ATTEMPTS {
                            tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
                        }
                    }
                }
            }
            if !succeeded {
                // Se falhar ao notificar mesmo após as tentativas, entra em DEGRADED
                let mut state = self.state.lock().unwrap();
                state.status = SessionStatus::Degraded;
                return Err(format!("Sidecar online, mas API falhou: {}", last_err));
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

    pub async fn send_heartbeat(&self, players: u32) -> Result<(), String> {
        let (session_id, status) = {
            let state = self.state.lock().unwrap();
            (state.session_id.clone(), state.status)
        };

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

// ============================================================
// Testes automatizados — lógica de retry/estado, sem rede real
// ============================================================
// `ApiTransport` já é um trait (pensado pra HTTP/WebSocket/gRPC — ver
// api_client.rs), então dá pra injetar um transporte roteirizado aqui e
// testar exatamente o comportamento de retry do SessionManager sem
// depender de rede/Tailscale/Worker de verdade. O que NÃO dá (e não deveria
// tentar) pra testar assim: subir o processo Java de verdade ou o sidecar
// do Tailscale de verdade — isso continua sendo teste manual com duas
// máquinas.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_client::{ApiClient, ApiConfig, ApiError, ApiRequest, ApiResponse, ApiTransport};
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;

    /// Transporte falso que devolve, em ordem, uma lista pré-definida de
    /// respostas — uma por chamada a `send`, independente do endpoint.
    struct ScriptedTransport {
        responses: StdMutex<VecDeque<Result<ApiResponse, ApiError>>>,
    }

    impl ScriptedTransport {
        fn new(responses: Vec<Result<ApiResponse, ApiError>>) -> Self {
            Self { responses: StdMutex::new(responses.into_iter().collect()) }
        }
    }

    #[async_trait]
    impl ApiTransport for ScriptedTransport {
        async fn send(&self, _request: ApiRequest) -> Result<ApiResponse, ApiError> {
            self.responses.lock().unwrap().pop_front().unwrap_or_else(|| {
                fake_err("EXHAUSTED", "ScriptedTransport sem mais respostas roteirizadas")
            })
        }
    }

    fn fake_err(code: &str, message: &str) -> Result<ApiResponse, ApiError> {
        Err(ApiError { code: code.into(), message: message.into(), technical_id: "test".into(), status_code: 500 })
    }

    fn fake_ok(data: serde_json::Value) -> Result<ApiResponse, ApiError> {
        Ok(ApiResponse {
            success: true,
            code: "SUCCESS".into(),
            message: "ok".into(),
            data: Some(data),
            details: None,
            technical_id: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
            request_id: None,
        })
    }

    fn connection_session_json(session_id: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": session_id,
            "launcher": "tsnet-v1",
            "launcherVersion": 1,
            "protocolVersion": 1,
            "credentials": {},
            "leaseDurationMs": 90000,
            "expiresAt": "2026-01-01T00:01:30Z",
        })
    }

    fn session_manager_with(responses: Vec<Result<ApiResponse, ApiError>>) -> SessionManager {
        let client = ApiClient::with_transport(Box::new(ScriptedTransport::new(responses)), ApiConfig::default());
        SessionManager::new(Arc::new(client))
    }

    #[tokio::test]
    async fn set_online_retries_past_a_transient_session_not_found() {
        // Regressão do incidente de 2026-09-14/15: a ConnectionSession
        // tinha acabado de ser criada quando o PATCH pra "online" batia num
        // edge do Cloudflare que ainda não via a escrita (KV é eventualmente
        // consistente, não imediato) — sem retry, isso travava a sessão em
        // DEGRADED pra sempre, sem o convidado nunca ver a rede "online".
        // Simula exatamente essa falha transitória: as duas primeiras
        // tentativas do PATCH falham, a terceira funciona.
        let sm = session_manager_with(vec![
            fake_ok(connection_session_json("sess-1")), // create_connection_session
            fake_err("SESSION_NOT_FOUND", "not found"), // update_connection_session, tentativa 1
            fake_err("SESSION_NOT_FOUND", "not found"), // tentativa 2
            fake_ok(serde_json::json!({})),             // tentativa 3 — sucesso
        ]);

        sm.start("ABCDEF", "host", 25565).await.expect("start deveria funcionar");
        sm.set_waiting_provider().expect("set_waiting_provider deveria funcionar");
        let result = sm.set_online("100.64.0.1").await;

        assert!(result.is_ok(), "set_online deveria ter se recuperado após retries: {:?}", result);
        assert_eq!(sm.get_status(), SessionStatus::Online);
    }

    #[tokio::test]
    async fn set_online_degrades_after_exhausting_retries() {
        // O mesmo cenário, mas a falha não é transitória (persiste em todas
        // as tentativas) — precisa continuar caindo em DEGRADED de verdade,
        // não travar num loop nem reportar sucesso falso.
        let sm = session_manager_with(vec![
            fake_ok(connection_session_json("sess-2")),
            fake_err("SESSION_NOT_FOUND", "not found"),
            fake_err("SESSION_NOT_FOUND", "not found"),
            fake_err("SESSION_NOT_FOUND", "not found"),
            fake_err("SESSION_NOT_FOUND", "not found"),
        ]);

        sm.start("ABCDEF", "host", 25565).await.expect("start deveria funcionar");
        sm.set_waiting_provider().expect("set_waiting_provider deveria funcionar");
        let result = sm.set_online("100.64.0.1").await;

        assert!(result.is_err());
        assert_eq!(sm.get_status(), SessionStatus::Degraded);
    }

    #[tokio::test]
    async fn start_then_set_online_succeeds_on_first_try() {
        // Caminho feliz, sem nenhuma falha — garante que o retry novo não
        // atrapalha (nem atrasa) o caso comum.
        let sm = session_manager_with(vec![
            fake_ok(connection_session_json("sess-3")),
            fake_ok(serde_json::json!({})),
        ]);

        sm.start("ABCDEF", "host", 25565).await.expect("start deveria funcionar");
        sm.set_waiting_provider().expect("set_waiting_provider deveria funcionar");
        sm.set_online("100.64.0.1").await.expect("set_online deveria funcionar de primeira");

        assert_eq!(sm.get_status(), SessionStatus::Online);
        assert_eq!(sm.get_session_id(), Some("sess-3".to_string()));
    }
}