const LEASE_DURATION_MS = 90_000;  // 90s lease
const SESSION_TTL_SECONDS = 90;    // 90s TTL (em vez de 14400s = 4h)
// O host manda heartbeat a cada 60s exatos (ver o loop em session_manager.rs/lib.rs).
// Isso precisa ser BEM maior que esse intervalo — 60s aqui expirava a sessão do
// KV bem na hora em que o próximo heartbeat estava a caminho (qualquer latência de
// rede/cold start do Worker já era suficiente), e como a entrada é DELETADA (não só
// marcada offline), a sessão nunca se recuperava — mesmo com o túnel real (Tailscale +
// Minecraft) funcionando perfeitamente. 3x o intervalo dá margem real de jitter.
const HEARTBEAT_RENEW_MS = 180_000;
const AUTH_KEY_EXPIRY_MS = 300_000;
const REQUEST_ID_CACHE_TTL = 300;

interface Env {
  CUBEFORGE_REGISTRY: KVNamespace;
  SERVER_TTL_SECONDS: string;
  HEARTBEAT_TIMEOUT_SECONDS: string;
  HEARTBEAT_EXPIRE_SECONDS: string;
  SHORT_CODE_LENGTH: string;
  API_BASE_URL: string;
  ENVIRONMENT: string;
  // OAuth client do Tailscale, restrito ao escopo "Auth Keys: Write" e às tags
  // tag:cf-host/tag:cf-guest (ver Settings > OAuth clients no admin console).
  // Nunca em wrangler.toml — configurar com:
  //   wrangler secret put TAILSCALE_OAUTH_CLIENT_ID
  //   wrangler secret put TAILSCALE_OAUTH_CLIENT_SECRET
  TAILSCALE_OAUTH_CLIENT_ID: string;
  TAILSCALE_OAUTH_CLIENT_SECRET: string;
  // Secret — nunca em wrangler.toml. Configurar com: wrangler secret put CURSEFORGE_API_KEY
  CURSEFORGE_API_KEY?: string;
  // Secrets do Stripe — nunca em wrangler.toml. Configurar com:
  //   wrangler secret put STRIPE_RESTRICTED_KEY   (rk_..., NUNCA a secret key sk_...)
  //   wrangler secret put STRIPE_WEBHOOK_SECRET   (whsec_..., gerado ao criar o
  //     endpoint de webhook em Developers > Webhooks, apontando pra
  //     .../api/v1/donations/webhook, eventos checkout.session.completed e
  //     checkout.session.async_payment_succeeded)
  STRIPE_RESTRICTED_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Secrets do Mercado Pago — nunca em wrangler.toml. Configurar com:
  //   wrangler secret put MERCADOPAGO_ACCESS_TOKEN   (Access Token de produção,
  //     em Suas integrações > [app] > Credenciais de produção)
  //   wrangler secret put MERCADOPAGO_WEBHOOK_SECRET  (chave secreta gerada ao
  //     configurar o webhook em Suas integrações > [app] > Webhooks, apontando
  //     pra .../api/v1/donations/mercadopago/webhook, evento "Pagamentos")
  MERCADOPAGO_ACCESS_TOKEN?: string;
  MERCADOPAGO_WEBHOOK_SECRET?: string;
}

type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed';
type SessionStatus = 'creating' | 'starting_provider' | 'waiting_provider' | 'online' | 'degraded' | 'stopping' | 'stopped' | 'failed' | 'cancelled';
type TerminationReason = 'user_stopped' | 'application_closed' | 'provider_error' | 'api_error' | 'crash' | 'timeout' | 'lease_expired';

interface ServerEntity { shortCode: string; uuid: string; name: string; version: string; serverType: string; description: string; owner: string; createdAt: string; updatedAt: string; forgeVersion?: string | null; modLoaderVersion?: string | null; }

interface SessionEntity { shortCode: string; provider: string; hostIp: string; port: number; status: ServerStatus; currentPlayers: number; maxPlayers: number; lastHeartbeat: string; createdAt: string; expiresAt: string; }

interface ConnectionSessionEntity {
  sessionId: string; shortCode: string; launcher: string; launcherVersion: number; protocolVersion: number;
  credentials: Record<string, any>; hostIp: string | null; port: number; status: SessionStatus; revision: number;
  terminationReason: TerminationReason | null; currentPlayers: number; maxPlayers: number; memoryUsageMb: number | null;
  mcVersion: string | null; lastHeartbeat: string; createdAt: string; expiresAt: string;
  timing: { apiCallMs: number | null; providerStartMs: number | null; providerWaitMs: number | null; totalElapsedMs: number | null; };
  retries: number; heartbeatCount: number; clientVersion: string; installationId: string; correlationId: string;
  // Papel do nó nesta sessão ("host" hospeda, "guest" se conecta) — decide qual
  // tag (tag:cf-host/tag:cf-guest) a authKey mintada carrega.
  mode: 'host' | 'guest';
  // IDs do Tailscale para permitir revogação forte ao encerrar a sessão (ver
  // handleDeleteConnectionSession) em vez de depender só da limpeza automática
  // de nós efêmeros, que tem atraso.
  tailscaleKeyId: string | null;
  tailscaleDeviceId: string | null;
}

interface ApiResponse<T = any> { success: boolean; code: string; message: string; data?: T; details?: Record<string, any>; technicalId?: string; timestamp: string; requestId?: string; }

const ResponseCodes = {
  SUCCESS: 'SUCCESS', SERVER_CREATED: 'SERVER_CREATED', SERVER_UPDATED: 'SERVER_UPDATED', SERVER_DELETED: 'SERVER_DELETED',
  SESSION_CREATED: 'SESSION_CREATED', SESSION_UPDATED: 'SESSION_UPDATED', SESSION_DELETED: 'SESSION_DELETED',
  CONNECTION_SESSION_CREATED: 'CONNECTION_SESSION_CREATED', HEARTBEAT_RECEIVED: 'HEARTBEAT_RECEIVED',
  BAD_REQUEST: 'BAD_REQUEST', NOT_FOUND: 'NOT_FOUND', SERVER_NOT_FOUND: 'SERVER_NOT_FOUND', SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  CONFLICT: 'CONFLICT', INTERNAL_ERROR: 'INTERNAL_ERROR', VALIDATION_ERROR: 'VALIDATION_ERROR',
  STALE_WRITE: 'STALE_WRITE', OPERATION_IN_PROGRESS: 'OPERATION_IN_PROGRESS',
} as const;

const SHORT_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let technicalIdCounter = 0;

function makeTechId(): string { technicalIdCounter++; const ts = Date.now().toString(36).slice(-4); const r = Math.random().toString(36).slice(2, 6); return `err_${ts}${r}`; }

function ok(code: string, msg: string, d?: any, rid?: string): ApiResponse {
  return { success: true, code, message: msg, data: d, timestamp: new Date().toISOString(), requestId: rid };
}

function fail(code: string, msg: string, d?: any, rid?: string): ApiResponse {
  return { success: false, code, message: msg, details: d, technicalId: makeTechId(), timestamp: new Date().toISOString(), requestId: rid };
}

function json(body: ApiResponse, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

async function genCode(env: Env, len: number): Promise<string> {
  for (let a = 0; a < 5; a++) {
    let c = ''; const arr = new Uint8Array(len); crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) c += SHORT_CODE_CHARS[arr[i] % SHORT_CODE_CHARS.length];
    if (!(await env.CUBEFORGE_REGISTRY.get(`server:${c}`))) return c;
  }
  return Date.now().toString(36).toUpperCase().slice(-len);
}

function uuid(): string { return crypto.randomUUID(); }

// ============================================================
// TAILSCALE — mint/revoke de authKeys via OAuth client
// ============================================================
//
// O client OAuth (TAILSCALE_OAUTH_CLIENT_ID/SECRET) tem escopo "Auth Keys:
// Write" restrito às tags tag:cf-host/tag:cf-guest (ver Settings > OAuth
// clients no admin console) — mesmo que esse secret vaze, só dá pra mintar
// dispositivos com essas duas tags, nunca editar a ACL ou virar admin.
//
// Cada key é ephemeral (some da tailnet pouco depois de desconectar),
// reusable:false (só registra um dispositivo, uma vez) e preauthorized:true
// (não precisa aprovação manual). expirySeconds é só a janela de validade da
// STRING da key para registro — não afeta quanto tempo o nó já registrado
// fica conectado (isso é controlado por deleteTailscaleDevice no fim da
// sessão, ver handleDeleteConnectionSession).
//
// "-" no lugar do nome da tailnet é o valor especial da API do Tailscale que
// resolve para a tailnet dona das credenciais usadas na chamada.

const TAILSCALE_API_BASE = 'https://api.tailscale.com/api/v2';

async function getTailscaleAccessToken(env: Env): Promise<string> {
  const resp = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TAILSCALE_OAUTH_CLIENT_ID,
      client_secret: env.TAILSCALE_OAUTH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }).toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Falha ao obter token OAuth do Tailscale (${resp.status}): ${text}`);
  }
  const data: any = await resp.json();
  return data.access_token as string;
}

interface TailscaleKeyResult { keyId: string; authKey: string; }

async function mintTailscaleKey(env: Env, tag: 'tag:cf-host' | 'tag:cf-guest', description: string, expirySeconds: number): Promise<TailscaleKeyResult> {
  const token = await getTailscaleAccessToken(env);
  const resp = await fetch(`${TAILSCALE_API_BASE}/tailnet/-/keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: [tag] } } },
      expirySeconds,
      description,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Falha ao criar authKey no Tailscale (${resp.status}): ${text}`);
  }
  const data: any = await resp.json();
  return { keyId: data.id as string, authKey: data.key as string };
}

/** Revoga uma authKey ainda não usada para registrar nenhum dispositivo. */
async function revokeTailscaleKey(env: Env, keyId: string): Promise<void> {
  try {
    const token = await getTailscaleAccessToken(env);
    await fetch(`${TAILSCALE_API_BASE}/tailnet/-/keys/${keyId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  } catch (e) { console.error('Falha ao revogar authKey do Tailscale:', e); }
}

/** Remove um dispositivo já conectado — revogação imediata, sem esperar a limpeza automática de nós efêmeros. */
async function deleteTailscaleDevice(env: Env, deviceId: string): Promise<void> {
  try {
    const token = await getTailscaleAccessToken(env);
    await fetch(`${TAILSCALE_API_BASE}/device/${deviceId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  } catch (e) { console.error('Falha ao remover dispositivo do Tailscale:', e); }
}

/** Resolve o deviceId do Tailscale a partir do IP de malha (100.x.x.x) que o nó recebeu, para permitir revogação forte depois. */
async function findTailscaleDeviceByIp(env: Env, tailscaleIp: string): Promise<string | null> {
  try {
    const token = await getTailscaleAccessToken(env);
    const resp = await fetch(`${TAILSCALE_API_BASE}/tailnet/-/devices?fields=all`, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const data: any = await resp.json().catch(() => null);
    const devices: any[] = data?.devices || [];
    const match = devices.find((d) => Array.isArray(d.addresses) && d.addresses.includes(tailscaleIp));
    return match?.id ?? null;
  } catch (e) { console.error('Falha ao resolver deviceId do Tailscale:', e); return null; }
}

// ============================================================
// HEARTBEAT — cria sessão legada se não existir
// ============================================================

async function handleHeartbeat(shortCode: string, req: Request, env: Env, cfg: { ttlSeconds: number }, cors: Record<string, string>): Promise<Response> {
  let body: any; try { body = await req.json(); } catch { body = {}; }
  const now = new Date(); const exp = new Date(now.getTime() + cfg.ttlSeconds * 1000);
  const key = `session:${shortCode}`;
  const existing = await env.CUBEFORGE_REGISTRY.get(key);
  if (existing) {
    const s: SessionEntity = JSON.parse(existing);
    s.lastHeartbeat = now.toISOString();
    if (body.status) s.status = body.status;
    if (body.currentPlayers !== undefined) s.currentPlayers = body.currentPlayers;
    s.expiresAt = exp.toISOString();
    await env.CUBEFORGE_REGISTRY.put(key, JSON.stringify(s), { expirationTtl: cfg.ttlSeconds });
  } else {
    const ns: SessionEntity = { shortCode, provider: 'tailscale', hostIp: body.hostIp || '0.0.0.0', port: body.port || 25565, status: body.status || 'starting', currentPlayers: body.currentPlayers || 0, maxPlayers: body.maxPlayers || 20, lastHeartbeat: now.toISOString(), createdAt: now.toISOString(), expiresAt: exp.toISOString() };
    await env.CUBEFORGE_REGISTRY.put(key, JSON.stringify(ns), { expirationTtl: cfg.ttlSeconds });
  }
  return json(ok(ResponseCodes.HEARTBEAT_RECEIVED, 'Heartbeat recebido.', { shortCode, expiresAt: exp.toISOString() }), 200, cors);
}

// ============================================================
// CREATE SERVER
// ============================================================

async function handleCreateServer(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: any; try { body = await req.json(); } catch { return json(fail(ResponseCodes.BAD_REQUEST, 'JSON inválido.'), 400, cors); }
  if (!body.name || !body.version || !body.serverType) return json(fail(ResponseCodes.VALIDATION_ERROR, 'name, version, serverType obrigatórios.'), 400, cors);
  const sc = body.shortCode || await genCode(env, parseInt(env.SHORT_CODE_LENGTH || '6'));
  const id = uuid();
  const sv: ServerEntity = { shortCode: sc, uuid: id, name: body.name, version: body.version, serverType: body.serverType, description: body.description || '', owner: body.owner || id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), forgeVersion: body.forgeVersion ?? null, modLoaderVersion: body.modLoaderVersion ?? null };
  await env.CUBEFORGE_REGISTRY.put(`server:${sc}`, JSON.stringify(sv));
  await env.CUBEFORGE_REGISTRY.put(`shortCode:${id}`, sc);
  return json(ok(ResponseCodes.SERVER_CREATED, 'Servidor criado.', sv), 201, cors);
}

// ============================================================
// DISCOVER SERVER
// ============================================================

async function handleDiscoverServer(shortCode: string, env: Env, cors: Record<string, string>): Promise<Response> {
  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!sj) return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.'), 404, cors);
  const sv: ServerEntity = JSON.parse(sj);
  // "host" porque este endpoint existe pra convidados descobrirem o status do
  // servidor antes de entrar — a sessão relevante é sempre a de quem hospeda.
  const csid = await env.CUBEFORGE_REGISTRY.get(`csession-by-shortcode:${shortCode}:host`);
  let se: SessionEntity | null = null;
  if (csid) {
    const csj = await env.CUBEFORGE_REGISTRY.get(`csession:${csid}`);
    if (csj) { const cs: ConnectionSessionEntity = JSON.parse(csj); se = { shortCode: cs.shortCode, provider: cs.launcher, hostIp: cs.hostIp || '', port: cs.port, status: cs.status as ServerStatus, currentPlayers: cs.currentPlayers, maxPlayers: cs.maxPlayers, lastHeartbeat: cs.lastHeartbeat, createdAt: cs.createdAt, expiresAt: cs.expiresAt }; }
  }
  if (!se) { const lj = await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`); if (lj) se = JSON.parse(lj); }
  return json(ok(ResponseCodes.SUCCESS, 'Servidor encontrado.', { server: sv, session: se ? { provider: se.provider, hostIp: se.hostIp, port: se.port, status: se.status, currentPlayers: se.currentPlayers, maxPlayers: se.maxPlayers, lastHeartbeat: se.lastHeartbeat } : null }), 200, cors);
}

// ============================================================
// DELETE SERVER
// ============================================================

async function handleDeleteServer(shortCode: string, env: Env, cors: Record<string, string>): Promise<Response> {
  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (sj) { const sv: ServerEntity = JSON.parse(sj); await env.CUBEFORGE_REGISTRY.delete(`server:${shortCode}`); await env.CUBEFORGE_REGISTRY.delete(`shortCode:${sv.uuid}`); }
  // Host e guest têm sessões independentes (ver handleCreateConnectionSession) — limpa as duas.
  for (const m of ['host', 'guest'] as const) {
    const csid = await env.CUBEFORGE_REGISTRY.get(`csession-by-shortcode:${shortCode}:${m}`);
    if (csid) { await env.CUBEFORGE_REGISTRY.delete(`csession:${csid}`); await env.CUBEFORGE_REGISTRY.delete(`csession-by-shortcode:${shortCode}:${m}`); }
  }
  await env.CUBEFORGE_REGISTRY.delete(`session:${shortCode}`);
  return json(ok(ResponseCodes.SERVER_DELETED, 'Servidor removido.'), 200, cors);
}

// ============================================================
// CREATE CONNECTION SESSION
// ============================================================

async function handleCreateConnectionSession(shortCode: string, req: Request, env: Env, cfg: { leaseTtlSeconds: number }, cors: Record<string, string>): Promise<Response> {
  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!sj) return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.'), 404, cors);
  let body: any; try { body = await req.json(); } catch { return json(fail(ResponseCodes.BAD_REQUEST, 'JSON inválido.'), 400, cors); }
  if (!body.requestId) return json(fail(ResponseCodes.VALIDATION_ERROR, 'requestId obrigatório.'), 400, cors);
  const cached = await env.CUBEFORGE_REGISTRY.get(`requestId:${body.requestId}`);
  if (cached) { const c = JSON.parse(cached); return json(c, c._status || 201, cors); }
  if (!body.correlationId || !body.clientVersion || !body.installationId) return json(fail(ResponseCodes.VALIDATION_ERROR, 'correlationId, clientVersion, installationId obrigatórios.'), 400, cors);
  if (body.mode !== 'host' && body.mode !== 'guest') return json(fail(ResponseCodes.VALIDATION_ERROR, 'mode precisa ser "host" ou "guest".'), 400, cors);
  const mode: 'host' | 'guest' = body.mode;
  // Host e guest mintam AuthKeys/identidades Tailscale independentes (tag:cf-host
  // vs tag:cf-guest) — cada um precisa da própria ConnectionSession. Sem o
  // ":mode" aqui, a sessão do host (sempre ativa enquanto a rede mesh dele
  // estiver de pé) bloqueava todo guest que tentasse entrar com 409
  // OPERATION_IN_PROGRESS, achando que era uma segunda criação duplicada.
  const existingSessionId = await env.CUBEFORGE_REGISTRY.get(`csession-by-shortcode:${shortCode}:${mode}`);
  if (existingSessionId) {
    const esj = await env.CUBEFORGE_REGISTRY.get(`csession:${existingSessionId}`);
    if (esj) { const es: ConnectionSessionEntity = JSON.parse(esj); if (es.status === 'online' || es.status === 'starting_provider' || es.status === 'waiting_provider') return json(fail(ResponseCodes.OPERATION_IN_PROGRESS, 'Sessão já ativa para este servidor.', { existingSessionId, status: es.status }), 409, cors); }
  }

  const sid = uuid(); const now = new Date(); const exp = new Date(now.getTime() + cfg.leaseTtlSeconds * 1000);
  const tag = mode === 'host' ? 'tag:cf-host' : 'tag:cf-guest';
  const hostname = `cf-${mode}-${sid.slice(0, 8)}`;

  let minted: TailscaleKeyResult;
  try {
    minted = await mintTailscaleKey(env, tag, hostname, Math.ceil(AUTH_KEY_EXPIRY_MS / 1000));
  } catch (e) {
    console.error('Falha ao mintar authKey do Tailscale:', e);
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Não foi possível gerar as credenciais de rede. Tente novamente em instantes.', { error: String(e) }, body.requestId), 502, cors);
  }

  const session: ConnectionSessionEntity = {
    sessionId: sid, shortCode, launcher: 'tsnet-v1', launcherVersion: 1, protocolVersion: 1,
    credentials: { authKey: minted.authKey, hostname }, hostIp: null, port: 25565, status: 'creating', revision: 1,
    terminationReason: null, currentPlayers: 0, maxPlayers: 20, memoryUsageMb: null, mcVersion: null,
    lastHeartbeat: now.toISOString(), createdAt: now.toISOString(), expiresAt: exp.toISOString(),
    timing: { apiCallMs: null, providerStartMs: null, providerWaitMs: null, totalElapsedMs: null },
    retries: 0, heartbeatCount: 0, clientVersion: body.clientVersion, installationId: body.installationId, correlationId: body.correlationId,
    mode, tailscaleKeyId: minted.keyId, tailscaleDeviceId: null,
  };
  await env.CUBEFORGE_REGISTRY.put(`csession:${sid}`, JSON.stringify(session), { expirationTtl: cfg.leaseTtlSeconds });
  await env.CUBEFORGE_REGISTRY.put(`csession-by-shortcode:${shortCode}:${mode}`, sid);
  const payload = ok(ResponseCodes.CONNECTION_SESSION_CREATED, 'Sessão criada.', { sessionId: sid, launcher: 'tsnet-v1', launcherVersion: 1, protocolVersion: 1, credentials: session.credentials, leaseDurationMs: LEASE_DURATION_MS, expiresAt: exp.toISOString() }, body.requestId);
  await env.CUBEFORGE_REGISTRY.put(`requestId:${body.requestId}`, JSON.stringify({ ...payload, _status: 201 }), { expirationTtl: REQUEST_ID_CACHE_TTL });
  return json(payload, 201, cors);
}

// ============================================================
// UPDATE / HEARTBEAT / DELETE CONNECTION SESSION
// ============================================================

async function handleUpdateConnectionSession(sessionId: string, req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const key = `csession:${sessionId}`;
  const raw = await env.CUBEFORGE_REGISTRY.get(key);
  if (!raw) return json(fail(ResponseCodes.SESSION_NOT_FOUND, 'Sessão não encontrada.'), 404, cors);
  let body: any; try { body = await req.json(); } catch { return json(fail(ResponseCodes.BAD_REQUEST, 'JSON inválido.'), 400, cors); }
  const session: ConnectionSessionEntity = JSON.parse(raw);

  if (typeof body.revision === 'number' && body.revision < session.revision) {
    return json(fail(ResponseCodes.STALE_WRITE, 'Revisão desatualizada.', { currentRevision: session.revision }), 409, cors);
  }
  if (body.status) session.status = body.status;
  if (body.hostIp) {
    session.hostIp = body.hostIp;
    // Assim que soubermos o IP de malha real do host, resolvemos o deviceId
    // correspondente — necessário pra poder revogar de verdade (DELETE device)
    // quando a sessão terminar, em vez de só esperar a limpeza automática.
    if (!session.tailscaleDeviceId) {
      session.tailscaleDeviceId = await findTailscaleDeviceByIp(env, body.hostIp);
    }
  }
  if (body.metrics?.currentPlayers !== undefined) session.currentPlayers = body.metrics.currentPlayers;
  if (body.timing) session.timing = { ...session.timing, ...body.timing };
  if (typeof body.retries === 'number') session.retries = body.retries;
  if (body.terminationReason) session.terminationReason = body.terminationReason;
  session.revision = session.revision + 1;

  const ttlSeconds = Math.max(60, Math.ceil((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
  await env.CUBEFORGE_REGISTRY.put(key, JSON.stringify(session), { expirationTtl: ttlSeconds });
  return json(ok(ResponseCodes.SESSION_UPDATED, 'Sessão atualizada.', { revision: session.revision }), 200, cors);
}

async function handleConnectionSessionHeartbeat(sessionId: string, req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const key = `csession:${sessionId}`;
  const raw = await env.CUBEFORGE_REGISTRY.get(key);
  if (!raw) return json(fail(ResponseCodes.SESSION_NOT_FOUND, 'Sessão não encontrada.'), 404, cors);
  const session: ConnectionSessionEntity = JSON.parse(raw);
  let body: any; try { body = await req.json(); } catch { body = {}; }

  session.lastHeartbeat = new Date().toISOString();
  session.heartbeatCount += 1;
  if (body.metrics?.currentPlayers !== undefined) session.currentPlayers = body.metrics.currentPlayers;
  const exp = new Date(Date.now() + HEARTBEAT_RENEW_MS);
  session.expiresAt = exp.toISOString();
  await env.CUBEFORGE_REGISTRY.put(key, JSON.stringify(session), { expirationTtl: Math.ceil(HEARTBEAT_RENEW_MS / 1000) });
  return json(ok(ResponseCodes.HEARTBEAT_RECEIVED, 'Heartbeat recebido.', { expiresAt: exp.toISOString() }), 200, cors);
}

async function handleDeleteConnectionSession(sessionId: string, env: Env, cors: Record<string, string>): Promise<Response> {
  const key = `csession:${sessionId}`;
  const raw = await env.CUBEFORGE_REGISTRY.get(key);
  if (!raw) return json(ok(ResponseCodes.SESSION_DELETED, 'Sessão já não existe.'), 200, cors);
  const session: ConnectionSessionEntity = JSON.parse(raw);

  // Revogação forte: se o nó chegou a se conectar (temos deviceId), remove o
  // dispositivo na hora — não espera a limpeza automática de efêmeros, que tem
  // atraso. Se a key nunca chegou a ser usada, revoga a key em si.
  if (session.tailscaleDeviceId) await deleteTailscaleDevice(env, session.tailscaleDeviceId);
  else if (session.tailscaleKeyId) await revokeTailscaleKey(env, session.tailscaleKeyId);

  await env.CUBEFORGE_REGISTRY.delete(key);
  const shortcodeKey = `csession-by-shortcode:${session.shortCode}:${session.mode}`;
  const csid = await env.CUBEFORGE_REGISTRY.get(shortcodeKey);
  if (csid === sessionId) await env.CUBEFORGE_REGISTRY.delete(shortcodeKey);
  return json(ok(ResponseCodes.SESSION_DELETED, 'Sessão encerrada.'), 200, cors);
}

// ============================================================
// LEGACY DISCOVER (v0 format)
// ============================================================

async function handleLegacyDiscover(shortCode: string, env: Env, cors: Record<string, string>): Promise<Response> {
  const r = await handleDiscoverServer(shortCode, env, cors);
  const d = await r.json() as ApiResponse;
  if (d.success && d.data) {
    const { server, session } = d.data;
    return new Response(JSON.stringify({ shortCode: server.shortCode, name: server.name, version: server.version, serverType: server.serverType, description: server.description, status: session?.status || 'offline', port: session?.port || 25565, maxPlayers: session?.maxPlayers || 20, currentPlayers: session?.currentPlayers || 0, networkProvider: session ? { provider: session.provider, connectionInfo: { hostIp: session.hostIp } } : null, ttlSeconds: parseInt(env.SERVER_TTL_SECONDS || '14400'), expiresAt: session?.expiresAt || null }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });
  }
  return r;
}

// ============================================================
// CURSEFORGE PROXY — resolve modpacks .zip da CurseForge
// ============================================================
//
// A API da CurseForge exige uma API key (x-api-key) para qualquer chamada.
// Essa key nunca pode ir para o cliente desktop, já que o CubeForge Dash é
// distribuído publicamente. Este proxy injeta a key aqui no Worker (via
// Cloudflare secret, `wrangler secret put CURSEFORGE_API_KEY` — nunca em
// wrangler.toml/git) e só repassa um allowlist fixo de endpoints
// somente-leitura que o import de modpacks precisa:
//
//  - POST /v1/mods/files   → resolve {fileIds:[...]} em downloadUrl/fileName
//  - POST /v1/mods         → resolve {modIds:[...]} em slug (link manual
//                             quando o autor desabilitou distribuição 3rd-party)
//  - GET  /v1/mods/{modId}/files/{fileId}/download-url → fallback pontual
//
// Não é um proxy genérico de propósito — qualquer outro path da CurseForge
// retorna 404. CORS segue igual ao resto do Worker (cliente é um app
// desktop via Tauri, não um navegador, então a origem não é um limite de
// segurança real aqui); não há autenticação própria do Worker além desse
// allowlist, já que os endpoints expostos são somente-leitura e o pior caso
// de abuso é consumir a cota de rate-limit da key, não expor/alterar dados.
// Se isso virar um problema, uma regra de rate-limit por IP no dashboard da
// Cloudflare (sem mudança de código) é o próximo passo natural.

const CURSEFORGE_BASE = 'https://api.curseforge.com';

function isCurseForgePathAllowed(method: string, subpath: string): boolean {
  if (method === 'POST' && (subpath === '/v1/mods/files' || subpath === '/v1/mods')) return true;
  if (method === 'GET' && /^\/v1\/mods\/\d+\/files\/\d+\/download-url$/.test(subpath)) return true;
  return false;
}

async function handleCurseForgeProxy(req: Request, env: Env, subpath: string, cors: Record<string, string>): Promise<Response> {
  const method = req.method;
  if (!isCurseForgePathAllowed(method, subpath)) {
    return json(fail(ResponseCodes.NOT_FOUND, 'Endpoint CurseForge não permitido.'), 404, cors);
  }
  if (!env.CURSEFORGE_API_KEY) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Import de modpacks CurseForge não está configurado neste servidor.'), 503, cors);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${CURSEFORGE_BASE}${subpath}`, {
      method,
      headers: { 'x-api-key': env.CURSEFORGE_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: method === 'GET' ? undefined : await req.text(),
    });
  } catch (e) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Falha ao contatar a CurseForge.', { error: String(e) }), 502, cors);
  }

  const bodyText = await upstream.text();
  return new Response(bodyText, { status: upstream.status, headers: { 'Content-Type': 'application/json', ...cors } });
}

// ============================================================
// Doações (Stripe Checkout) — botão "Pagar uma Coquinha"
// ============================================================
// Cria uma Stripe Checkout Session com valor livre (custom_unit_amount —
// o doador escolhe quanto pagar direto na página hospedada do Stripe, sem
// nenhuma UI de pagamento no Cubicase). O app desktop só chama este
// endpoint e abre a `url` retornada no navegador do sistema.
//
// Chamado direto via fetch (sem o SDK oficial do Stripe): o Workers
// runtime não tem os módulos Node que o SDK espera, e a API REST do
// Stripe é simples o bastante pra não precisar disso.
//
// O pagamento em si nunca deve ser confiado a partir do redirect de
// sucesso (o usuário pode fechar a aba antes de voltar) — por isso existe
// o webhook abaixo, que é quem realmente confirma que o pagamento
// aconteceu (ver stripe-best-practices/references/payments.md).

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2026-08-26.dahlia';

// Preço "avulso, cliente escolhe o valor" (mín. R$0,50), criado uma vez no
// Dashboard do Stripe (Products) — "valor livre" (custom_unit_amount) só
// existe em um Price salvo, não dá pra criar isso na hora dentro da sessão
// de checkout. IDs de preço não são segredo (só a chave de API é).
const DONATION_PRICE_ID = 'price_1UBjJpJrnDGUaagENUlVHka3';

function randomLowercaseLetters(n: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function handleCreateDonationCheckout(env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.STRIPE_RESTRICTED_KEY) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Doações não estão configuradas neste servidor.'), 503, cors);
  }

  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('submit_type', 'donate');
  body.set('success_url', 'https://cubicase.net/obrigado/?session_id={CHECKOUT_SESSION_ID}');
  body.set('cancel_url', 'https://cubicase.net/download/');
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price]', DONATION_PRICE_ID);
  // Sem payment_method_types de propósito: deixa o Stripe decidir dinamicamente
  // quais métodos mostrar (cartão, Pix, carteiras digitais, etc conforme o
  // país/moeda do doador) — ver "Dynamic payment methods" no guia oficial.
  body.set('integration_identifier', `cubicase_${randomLowercaseLetters(8)}`);

  let upstream: Response;
  try {
    upstream = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: body.toString(),
    });
  } catch (e) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Falha ao contatar o Stripe.', { error: String(e) }), 502, cors);
  }

  const data: any = await upstream.json().catch(() => null);
  if (!upstream.ok || !data?.url) {
    return json(
      fail(ResponseCodes.INTERNAL_ERROR, 'Não foi possível criar a sessão de pagamento.', { stripeError: data?.error?.message }),
      502,
      cors
    );
  }

  return json(ok(ResponseCodes.SUCCESS, 'Sessão de checkout criada.', { url: data.url }), 200, cors);
}

/** Verifica a assinatura `Stripe-Signature` de um webhook (HMAC-SHA256, via Web Crypto — sem depender do SDK do Stripe). */
async function verifyStripeSignature(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, v];
    })
  );
  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) return false;

  // Proteção contra replay: rejeita eventos com mais de 5 minutos.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Comparação em tempo constante (evita timing attack).
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function handleStripeWebhook(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Webhook do Stripe não está configurado.'), 503, cors);
  }

  const payload = await req.text();
  const validSig = await verifyStripeSignature(payload, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!validSig) {
    return json(fail(ResponseCodes.BAD_REQUEST, 'Assinatura do webhook inválida.'), 400, cors);
  }

  let event: any;
  try {
    event = JSON.parse(payload);
  } catch {
    return json(fail(ResponseCodes.BAD_REQUEST, 'Payload inválido.'), 400, cors);
  }

  // Só os dois eventos que realmente confirmam pagamento — nunca fulfillment
  // baseado na página de sucesso (ver comentário no topo desta seção).
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data?.object;
    if (session && session.payment_status !== 'unpaid') {
      await env.CUBEFORGE_REGISTRY.put(
        `donation:${session.id}`,
        JSON.stringify({
          amountTotal: session.amount_total,
          currency: session.currency,
          createdAt: new Date().toISOString(),
        })
      );
    }
  }

  // Sempre 200 pro Stripe não ficar reenviando eventos que já processamos
  // (ou que não nos interessam) indefinidamente.
  return json(ok(ResponseCodes.SUCCESS, 'ok'), 200, cors);
}

// ============================================================
// Doações via Pix (Mercado Pago) — complemento ao Stripe
// ============================================================
// O Stripe (acima) não libera Pix pra contas pessoa física novas — pra não
// perder quem prefere Pix a preencher cartão, esse segundo caminho usa o
// Checkout Pro do Mercado Pago, que aceita conta de pessoa física sem
// carência. O app mostra as duas opções (Cartão → Stripe, Pix → Mercado
// Pago) e cada uma abre sua própria página hospedada no navegador.
//
// Diferença importante em relação ao Stripe: o Checkout Pro do Mercado
// Pago não tem "o cliente escolhe o valor" — o valor precisa vir fixo na
// criação da preferência. Por isso este endpoint recebe o valor (em
// centavos, mesma unidade que o resto do app usa) no corpo da requisição;
// a escolha do valor acontece numa etapa curta dentro do próprio Cubicase
// (não é dado de pagamento, só um número).

const MERCADOPAGO_API_BASE = 'https://api.mercadopago.com';
const DONATION_MIN_CENTS = 50; // R$0,50 — mesmo mínimo do Price do Stripe
const DONATION_MAX_CENTS = 100_000; // R$1.000,00 — mesmo teto do Stripe

async function handleCreateMercadoPagoCheckout(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.MERCADOPAGO_ACCESS_TOKEN) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Doações via Pix não estão configuradas neste servidor.'), 503, cors);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const amountCents = Math.round(Number(body?.amountCents));
  if (!Number.isFinite(amountCents) || amountCents < DONATION_MIN_CENTS || amountCents > DONATION_MAX_CENTS) {
    return json(fail(ResponseCodes.VALIDATION_ERROR, `O valor precisa estar entre R$${(DONATION_MIN_CENTS / 100).toFixed(2)} e R$${(DONATION_MAX_CENTS / 100).toFixed(2)}.`), 400, cors);
  }

  const preference = {
    items: [
      {
        title: 'Doação para o Cubicase',
        quantity: 1,
        unit_price: amountCents / 100,
        currency_id: 'BRL',
      },
    ],
    back_urls: {
      success: 'https://cubicase.net/obrigado/',
      failure: 'https://cubicase.net/download/',
      pending: 'https://cubicase.net/obrigado/',
    },
    auto_return: 'approved',
    notification_url: 'https://cubeforge-api.cubeforge.workers.dev/api/v1/donations/mercadopago/webhook',
    // Restringe ao Pix — cartão já é coberto pelo Stripe, não faz sentido
    // duplicar aqui (e evita confundir o doador com métodos redundantes).
    payment_methods: {
      excluded_payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }, { id: 'ticket' }, { id: 'atm' }],
    },
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${MERCADOPAGO_API_BASE}/checkout/preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(preference),
    });
  } catch (e) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Falha ao contatar o Mercado Pago.', { error: String(e) }), 502, cors);
  }

  const data: any = await upstream.json().catch(() => null);
  if (!upstream.ok || !data?.init_point) {
    return json(
      fail(ResponseCodes.INTERNAL_ERROR, 'Não foi possível criar a cobrança Pix.', { mercadoPagoError: data?.message || data }),
      502,
      cors
    );
  }

  return json(ok(ResponseCodes.SUCCESS, 'Cobrança Pix criada.', { url: data.init_point }), 200, cors);
}

/** Verifica a assinatura `x-signature` de um webhook do Mercado Pago (HMAC-SHA256 sobre um manifest fixo — ver docs.mercadopago.com/webhooks). */
async function verifyMercadoPagoSignature(dataId: string, requestId: string | null, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader || !requestId) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k?.trim(), v?.trim()];
    })
  );
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest));
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

async function handleMercadoPagoWebhook(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.MERCADOPAGO_ACCESS_TOKEN || !env.MERCADOPAGO_WEBHOOK_SECRET) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Webhook do Mercado Pago não está configurado.'), 503, cors);
  }

  const url = new URL(req.url);
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  // O Mercado Pago manda o id do pagamento tanto na query string (formato
  // IPN legado) quanto no corpo (formato webhook novo) — aceita os dois.
  const dataId = payload?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id');
  const topic = payload?.type || url.searchParams.get('type') || url.searchParams.get('topic');

  if (!dataId || topic !== 'payment') {
    // Outros tópicos (merchant_order, etc) não interessam aqui — sempre 200
    // pro Mercado Pago não ficar reentregando.
    return json(ok(ResponseCodes.SUCCESS, 'ok'), 200, cors);
  }

  const validSig = await verifyMercadoPagoSignature(String(dataId), req.headers.get('x-request-id'), req.headers.get('x-signature'), env.MERCADOPAGO_WEBHOOK_SECRET);
  if (!validSig) {
    return json(fail(ResponseCodes.BAD_REQUEST, 'Assinatura do webhook inválida.'), 400, cors);
  }

  // O payload do webhook não traz o status do pagamento — precisa buscar
  // direto na API pra confirmar de verdade (nunca confiar só na notificação).
  let payment: any;
  try {
    const resp = await fetch(`${MERCADOPAGO_API_BASE}/v1/payments/${dataId}`, {
      headers: { Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}` },
    });
    payment = await resp.json().catch(() => null);
  } catch (e) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Falha ao confirmar o pagamento no Mercado Pago.', { error: String(e) }), 502, cors);
  }

  if (payment && payment.status === 'approved') {
    await env.CUBEFORGE_REGISTRY.put(
      `donation:mp_${dataId}`,
      JSON.stringify({
        provider: 'mercadopago',
        amountTotal: Math.round((payment.transaction_amount || 0) * 100),
        currency: payment.currency_id,
        createdAt: new Date().toISOString(),
      })
    );
  }

  return json(ok(ResponseCodes.SUCCESS, 'ok'), 200, cors);
}

// ============================================================
// MAIN ROUTER
// ============================================================

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url); const m = req.method; const p = url.pathname;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CubeCase-Version' };
    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const cfg = { ttlSeconds: SESSION_TTL_SECONDS, leaseTtlSeconds: Math.ceil(LEASE_DURATION_MS / 1000), shortCodeLength: parseInt(env.SHORT_CODE_LENGTH || '6') };

      // POST /api/v1/servers/{sc}/connection-sessions
      const m1 = p.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/connection-sessions$/);
      if (m === 'POST' && m1) return await handleCreateConnectionSession(m1[1].toUpperCase(), req, env, cfg, cors);

      // PATCH/DELETE /api/v1/connection-sessions/{id}
      const m1u = p.match(/^\/api\/v1\/connection-sessions\/([A-Za-z0-9-]+)$/);
      if (m === 'PATCH' && m1u) return await handleUpdateConnectionSession(m1u[1], req, env, cors);
      if (m === 'DELETE' && m1u) return await handleDeleteConnectionSession(m1u[1], env, cors);

      // POST /api/v1/connection-sessions/{id}/heartbeat
      const m1h = p.match(/^\/api\/v1\/connection-sessions\/([A-Za-z0-9-]+)\/heartbeat$/);
      if (m === 'POST' && m1h) return await handleConnectionSessionHeartbeat(m1h[1], req, env, cors);

      // POST /api/v1/servers/{sc}/heartbeat
      const m2 = p.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/heartbeat$/);
      if (m === 'POST' && m2) return await handleHeartbeat(m2[1].toUpperCase(), req, env, cfg, cors);

      // POST /api/v1/servers
      if (m === 'POST' && p === '/api/v1/servers') return await handleCreateServer(req, env, cors);

      // GET /api/v1/servers/{sc}
      const m3 = p.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)$/);
      if (m === 'GET' && m3) return await handleDiscoverServer(m3[1].toUpperCase(), env, cors);

      // DELETE /api/v1/servers/{sc}
      if (m === 'DELETE' && m3) return await handleDeleteServer(m3[1].toUpperCase(), env, cors);

      // LEGADO: GET /api/servers/{sc}
      const m4 = p.match(/^\/api\/servers\/([A-Za-z0-9]+)$/);
      if (m === 'GET' && m4) return await handleLegacyDiscover(m4[1].toUpperCase(), env, cors);
      if (m === 'DELETE' && m4) return await handleDeleteServer(m4[1].toUpperCase(), env, cors);

      // LEGADO: POST /api/servers/{sc}/heartbeat
      const m5 = p.match(/^\/api\/servers\/([A-Za-z0-9]+)\/heartbeat$/);
      if (m === 'POST' && m5) return await handleHeartbeat(m5[1].toUpperCase(), req, env, cfg, cors);

      // LEGADO: PATCH /api/servers/{sc}/status
      const m6 = p.match(/^\/api\/servers\/([A-Za-z0-9]+)\/status$/);
      if (m === 'PATCH' && m6) {
        let body: any; try { body = await req.json(); } catch { body = {}; }
        const sc = m6[1].toUpperCase();
        const sj = await env.CUBEFORGE_REGISTRY.get(`session:${sc}`);
        if (sj && body.status) { const s: SessionEntity = JSON.parse(sj); s.status = body.status; if (body.currentPlayers !== undefined) s.currentPlayers = body.currentPlayers; s.lastHeartbeat = new Date().toISOString(); s.expiresAt = new Date(Date.now() + cfg.ttlSeconds * 1000).toISOString(); await env.CUBEFORGE_REGISTRY.put(`session:${sc}`, JSON.stringify(s), { expirationTtl: cfg.ttlSeconds }); }
        return new Response(JSON.stringify({ status: 'updated' }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });
      }

      // Proxy CurseForge: /api/v1/curseforge/{subpath}
      const mcf = p.match(/^\/api\/v1\/curseforge(\/.*)$/);
      if (mcf) return await handleCurseForgeProxy(req, env, mcf[1], cors);

      // POST /api/v1/donations/checkout-session — botão "Pagar uma Coquinha"
      if (m === 'POST' && p === '/api/v1/donations/checkout-session') return await handleCreateDonationCheckout(env, cors);

      // POST /api/v1/donations/webhook — confirmação de pagamento do Stripe
      if (m === 'POST' && p === '/api/v1/donations/webhook') return await handleStripeWebhook(req, env, cors);

      // POST /api/v1/donations/mercadopago/checkout-session — doação via Pix
      if (m === 'POST' && p === '/api/v1/donations/mercadopago/checkout-session') return await handleCreateMercadoPagoCheckout(req, env, cors);

      // POST /api/v1/donations/mercadopago/webhook — confirmação de pagamento do Mercado Pago
      if (m === 'POST' && p === '/api/v1/donations/mercadopago/webhook') return await handleMercadoPagoWebhook(req, env, cors);

      if (m === 'GET' && p === '/health') return new Response(JSON.stringify(ok(ResponseCodes.SUCCESS, 'OK', { status: 'ok', version: 'v1' })), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });

      return json(fail(ResponseCodes.NOT_FOUND, 'Endpoint não encontrado.', { path: p, method: m }), 404, cors);
    } catch (e) { console.error('Unhandled:', e); return json(fail(ResponseCodes.INTERNAL_ERROR, 'Erro interno.', { error: String(e) }), 500, cors); }
  },
};