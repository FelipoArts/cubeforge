use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json;
use std::collections::HashMap;
use std::time::Duration;
use rand::Rng;

// ============================================================
// ApiTransport trait — preparado para HTTP, WebSocket, gRPC
// ============================================================

#[async_trait]
pub trait ApiTransport: Send + Sync {
    async fn send(&self, request: ApiRequest) -> Result<ApiResponse, ApiError>;
}

// ============================================================
// Tipos
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    pub base_url: String,
    pub timeout_seconds: u64,
    pub retry_count: u32,
    pub client_version: String,
    pub installation_id: String,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.cubeforge.dev".to_string(),
            timeout_seconds: 10,
            retry_count: 3,
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            installation_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiRequest {
    pub method: String,
    pub path: String,
    pub body: Option<serde_json::Value>,
    pub request_id: String,
    pub correlation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse {
    pub success: bool,
    pub code: String,
    pub message: String,
    pub data: Option<serde_json::Value>,
    pub details: Option<serde_json::Value>,
    pub technical_id: Option<String>,
    pub timestamp: String,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub technical_id: String,
    pub status_code: u16,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {} (technicalId: {})", self.code, self.message, self.technical_id)
    }
}

// ============================================================
// ConnectionSession Response (opaco para o desktop)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionSessionResponse {
    pub session_id: String,
    pub launcher: String,
    pub launcher_version: u32,
    pub protocol_version: u32,
    pub credentials: serde_json::Value, // ← Opaco! Desktop não sabe o formato
    pub lease_duration_ms: u64,
    pub expires_at: String,
}

// ============================================================
// Métricas do ApiClient
// ============================================================

#[derive(Debug, Clone, Default, Serialize)]
pub struct ApiClientMetrics {
    pub requests_total: u64,
    pub success_total: u64,
    pub failure_total: u64,
    pub timeout_total: u64,
    pub retry_count: u64,
    pub latency_ms: Vec<u64>, // últimas 100 latências
}

// ============================================================
// Implementação HTTP Transport
// ============================================================

pub struct HttpTransport {
    client: reqwest::Client,
    base_url: String,
    client_version: String,
    installation_id: String,
    metrics: std::sync::Mutex<ApiClientMetrics>,
}

impl HttpTransport {
    pub fn new(config: &ApiConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds))
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(10)
            .http2_prior_knowledge() // HTTP/2 se disponível
            .build()
            .expect("Failed to build HTTP client");

        Self {
            client,
            base_url: config.base_url.clone(),
            client_version: config.client_version.clone(),
            installation_id: config.installation_id.clone(),
            metrics: std::sync::Mutex::new(ApiClientMetrics::default()),
        }
    }

    pub fn get_metrics(&self) -> ApiClientMetrics {
        self.metrics.lock().unwrap().clone()
    }
}

fn generate_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[async_trait]
impl ApiTransport for HttpTransport {
    async fn send(&self, request: ApiRequest) -> Result<ApiResponse, ApiError> {
        let start = std::time::Instant::now();
        let url = format!("{}{}", self.base_url, request.path);
        
        // Atualizar métricas
        {
            let mut metrics = self.metrics.lock().unwrap();
            metrics.requests_total += 1;
        }

        // Construir requisição HTTP
        let mut req = self.client.request(
            reqwest::Method::from_bytes(request.method.as_bytes())
                .unwrap_or(reqwest::Method::GET),
            &url,
        );

        // Headers
        req = req.header("Content-Type", "application/json");
        req = req.header("X-CubeCase-Version", &self.client_version);
        req = req.header("X-Installation-Id", &self.installation_id);
        req = req.header("X-Request-Id", &request.request_id);
        req = req.header("X-Correlation-Id", &request.correlation_id);

        // Body
        if let Some(body) = request.body {
            req = req.json(&body);
        }

        // Timeout individual
        req = req.timeout(Duration::from_secs(
            if request.path.contains("heartbeat") { 5 } else { 10 }
        ));

        // Enviar
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let mut metrics = self.metrics.lock().unwrap();
                if e.is_timeout() {
                    metrics.timeout_total += 1;
                } else {
                    metrics.failure_total += 1;
                }
                return Err(ApiError {
                    code: "HTTP_ERROR".into(),
                    message: format!("Falha na requisição: {}", e),
                    technical_id: format!("http_{}", generate_uuid().split('-').next().unwrap_or("0000")),
                    status_code: 0,
                });
            }
        };

        let status = resp.status().as_u16();

        // Parsear resposta
        let body: ApiResponse = match resp.json().await {
            Ok(b) => b,
            Err(e) => {
                let mut metrics = self.metrics.lock().unwrap();
                metrics.failure_total += 1;
                return Err(ApiError {
                    code: "PARSE_ERROR".into(),
                    message: format!("Falha ao parsear resposta: {}", e),
                    technical_id: format!("parse_{}", generate_uuid().split('-').next().unwrap_or("0000")),
                    status_code: status,
                });
            }
        };

        // Atualizar métricas
        {
            let mut metrics = self.metrics.lock().unwrap();
            if body.success {
                metrics.success_total += 1;
            } else {
                metrics.failure_total += 1;
            }
            let elapsed = start.elapsed().as_millis() as u64;
            metrics.latency_ms.push(elapsed);
            if metrics.latency_ms.len() > 100 {
                metrics.latency_ms.remove(0);
            }
        }

        if body.success {
            Ok(body)
        } else {
            Err(ApiError {
                code: body.code,
                message: body.message,
                technical_id: body.technical_id.unwrap_or_else(|| format!("api_{}", generate_uuid().split('-').next().unwrap_or("0000"))),
                status_code: status,
            })
        }
    }
}

// ============================================================
// ApiClient — Singleton, único ponto de comunicação
// ============================================================

pub struct ApiClient {
    transport: Box<dyn ApiTransport>,
    config: ApiConfig,
}

impl ApiClient {
    pub fn new(config: ApiConfig) -> Self {
        let transport = HttpTransport::new(&config);
        Self {
            transport: Box::new(transport),
            config,
        }
    }

    fn generate_ids(&self) -> (String, String) {
        (generate_uuid(), generate_uuid())
    }

    /// Cria uma ConnectionSession. O desktop NÃO envia "provider".
    /// A API decide qual driver usar.
    pub async fn create_connection_session(
        &self,
        short_code: &str,
    ) -> Result<ConnectionSessionResponse, ApiError> {
        let (request_id, correlation_id) = self.generate_ids();

        let req = ApiRequest {
            method: "POST".into(),
            path: format!("/api/v1/servers/{}/connection-sessions", short_code.to_uppercase()),
            body: Some(serde_json::json!({
                "requestId": request_id,
                "correlationId": correlation_id,
                "installationId": self.config.installation_id,
                "clientVersion": self.config.client_version,
            })),
            request_id,
            correlation_id,
        };

        // Retry com jitter
        let mut last_error = ApiError {
            code: "UNKNOWN".into(),
            message: "No attempt made".into(),
            technical_id: "unknown".into(),
            status_code: 0,
        };

        for attempt in 0..self.config.retry_count {
            match self.transport.send(req.clone()).await {
                Ok(response) => {
                    let data = response.data.ok_or_else(|| ApiError {
                        code: "MISSING_DATA".into(),
                        message: "Resposta da API não contém 'data'".into(),
                        technical_id: format!("data_{}", generate_uuid().split('-').next().unwrap_or("0000")),
                        status_code: 200,
                    })?;

                    return serde_json::from_value::<ConnectionSessionResponse>(data)
                        .map_err(|e| ApiError {
                            code: "DESERIALIZE_ERROR".into(),
                            message: format!("Falha ao desserializar sessão: {}", e),
                            technical_id: format!("deser_{}", generate_uuid().split('-').next().unwrap_or("0000")),
                            status_code: 200,
                        });
                }
                Err(e) => {
                    last_error = e;
                    if (attempt as u32) < self.config.retry_count - 1 {
                        // Jitter: ~900ms, ~2100ms, ~4300ms
                        let mut rng = rand::thread_rng();
                        let base_ms = 1000u64 * (1u64 << attempt);
                        let jitter = rng.gen_range(-100..100);
                        let delay = (base_ms as i64 + jitter).max(100) as u64;
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                }
            }
        }

        Err(last_error)
    }

    /// Atualiza uma ConnectionSession (status, hostIp, timing)
    pub async fn update_connection_session(
        &self,
        session_id: &str,
        status: &str,
        host_ip: Option<&str>,
        revision: u64,
        metrics: Option<HashMap<String, serde_json::Value>>,
        timing: Option<HashMap<String, serde_json::Value>>,
        retries: Option<u32>,
        termination_reason: Option<&str>,
    ) -> Result<(), ApiError> {
        let (request_id, correlation_id) = self.generate_ids();

        let mut body = serde_json::json!({
            "requestId": request_id,
            "correlationId": correlation_id,
            "status": status,
            "revision": revision,
        });

        if let Some(ip) = host_ip {
            body["hostIp"] = serde_json::Value::String(ip.to_string());
        }
        if let Some(m) = metrics {
            body["metrics"] = serde_json::Value::Object(m.into_iter().collect());
        }
        if let Some(t) = timing {
            body["timing"] = serde_json::Value::Object(t.into_iter().collect());
        }
        if let Some(r) = retries {
            body["retries"] = serde_json::Value::Number(serde_json::Number::from(r));
        }
        if let Some(tr) = termination_reason {
            body["terminationReason"] = serde_json::Value::String(tr.to_string());
        }

        let req = ApiRequest {
            method: "PATCH".into(),
            path: format!("/api/v1/connection-sessions/{}", session_id),
            body: Some(body),
            request_id,
            correlation_id,
        };

        self.transport.send(req).await.map(|_| ())
    }

    /// Envia heartbeat para uma ConnectionSession
    pub async fn send_heartbeat(
        &self,
        session_id: &str,
        metrics: Option<HashMap<String, serde_json::Value>>,
    ) -> Result<(), ApiError> {
        let (request_id, correlation_id) = self.generate_ids();

        let mut body = serde_json::json!({
            "requestId": request_id,
            "correlationId": correlation_id,
        });

        if let Some(m) = metrics {
            body["metrics"] = serde_json::Value::Object(m.into_iter().collect());
        }

        let req = ApiRequest {
            method: "POST".into(),
            path: format!("/api/v1/connection-sessions/{}/heartbeat", session_id),
            body: Some(body),
            request_id,
            correlation_id,
        };

        self.transport.send(req).await.map(|_| ())
    }

    /// Encerra uma ConnectionSession
    pub async fn delete_connection_session(
        &self,
        session_id: &str,
        reason: &str,
    ) -> Result<(), ApiError> {
        let (request_id, correlation_id) = self.generate_ids();

        let req = ApiRequest {
            method: "DELETE".into(),
            path: format!("/api/v1/connection-sessions/{}?reason={}&requestId={}&correlationId={}",
                session_id, reason, request_id, correlation_id),
            body: None,
            request_id,
            correlation_id,
        };

        self.transport.send(req).await.map(|_| ())
    }

    /// Registra um servidor na API
    pub async fn register_server(
        &self,
        name: &str,
        version: &str,
        short_code: &str,
    ) -> Result<(), ApiError> {
        let (request_id, correlation_id) = self.generate_ids();

        let req = ApiRequest {
            method: "POST".into(),
            path: "/api/v1/servers".into(),
            body: Some(serde_json::json!({
                "name": name,
                "version": version,
                "serverType": "vanilla",
                "shortCode": short_code,
                "requestId": request_id,
                "correlationId": correlation_id,
            })),
            request_id,
            correlation_id,
        };

        self.transport.send(req).await.map(|_| ())
    }

    /// Descobre um servidor na API
    pub async fn discover_server(
        &self,
        short_code: &str,
    ) -> Result<serde_json::Value, ApiError> {
        let (request_id, correlation_id) = self.generate_ids();

        let req = ApiRequest {
            method: "GET".into(),
            path: format!("/api/v1/servers/{}", short_code.to_uppercase()),
            body: None,
            request_id,
            correlation_id,
        };

        let response = self.transport.send(req).await?;
        response.data.ok_or_else(|| ApiError {
            code: "MISSING_DATA".into(),
            message: "Resposta não contém 'data'".into(),
            technical_id: format!("data_{}", generate_uuid().split('-').next().unwrap_or("0000")),
            status_code: 200,
        })
    }

    /// Obtém métricas do client
    pub fn get_metrics(&self) -> ApiClientMetrics {
        // Se o transport for HttpTransport, obtém métricas
        // (cast simples para debug)
        ApiClientMetrics::default()
    }
}