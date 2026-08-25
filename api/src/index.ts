const LEASE_DURATION_MS = 90_000;  // 90s lease
const SESSION_TTL_SECONDS = 90;    // 90s TTL (em vez de 14400s = 4h)
const HEARTBEAT_RENEW_MS = 60_000;
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
  TAILSCALE_API_KEY: string;
  // Secret — nunca em wrangler.toml. Configurar com: wrangler secret put CURSEFORGE_API_KEY
  CURSEFORGE_API_KEY?: string;
}

type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed';
type SessionStatus = 'creating' | 'starting_provider' | 'waiting_provider' | 'online' | 'degraded' | 'stopping' | 'stopped' | 'failed' | 'cancelled';
type TerminationReason = 'user_stopped' | 'application_closed' | 'provider_error' | 'api_error' | 'crash' | 'timeout' | 'lease_expired';

interface ServerEntity { shortCode: string; uuid: string; name: string; version: string; serverType: string; description: string; owner: string; createdAt: string; updatedAt: string; }

interface SessionEntity { shortCode: string; provider: string; hostIp: string; port: number; status: ServerStatus; currentPlayers: number; maxPlayers: number; lastHeartbeat: string; createdAt: string; expiresAt: string; }

interface ConnectionSessionEntity {
  sessionId: string; shortCode: string; launcher: string; launcherVersion: number; protocolVersion: number;
  credentials: Record<string, any>; hostIp: string | null; port: number; status: SessionStatus; revision: number;
  terminationReason: TerminationReason | null; currentPlayers: number; maxPlayers: number; memoryUsageMb: number | null;
  mcVersion: string | null; lastHeartbeat: string; createdAt: string; expiresAt: string;
  timing: { apiCallMs: number | null; providerStartMs: number | null; providerWaitMs: number | null; totalElapsedMs: number | null; };
  retries: number; heartbeatCount: number; clientVersion: string; installationId: string; correlationId: string;
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
  const sv: ServerEntity = { shortCode: sc, uuid: id, name: body.name, version: body.version, serverType: body.serverType, description: body.description || '', owner: body.owner || id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
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
  const csid = await env.CUBEFORGE_REGISTRY.get(`csession-by-shortcode:${shortCode}`);
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
  const csid = await env.CUBEFORGE_REGISTRY.get(`csession-by-shortcode:${shortCode}`);
  if (csid) { await env.CUBEFORGE_REGISTRY.delete(`csession:${csid}`); await env.CUBEFORGE_REGISTRY.delete(`csession-by-shortcode:${shortCode}`); }
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
  const existingSessionId = await env.CUBEFORGE_REGISTRY.get(`csession-by-shortcode:${shortCode}`);
  if (existingSessionId) {
    const esj = await env.CUBEFORGE_REGISTRY.get(`csession:${existingSessionId}`);
    if (esj) { const es: ConnectionSessionEntity = JSON.parse(esj); if (es.status === 'online' || es.status === 'starting_provider' || es.status === 'waiting_provider') return json(fail(ResponseCodes.OPERATION_IN_PROGRESS, 'Sessão já ativa para este servidor.', { existingSessionId, status: es.status }), 409, cors); }
  }
  const sid = uuid(); const now = new Date(); const exp = new Date(now.getTime() + cfg.leaseTtlSeconds * 1000);
  const session: ConnectionSessionEntity = { sessionId: sid, shortCode, launcher: 'tsnet-v1', launcherVersion: 1, protocolVersion: 1, credentials: {}, hostIp: null, port: 25565, status: 'creating', revision: 1, terminationReason: null, currentPlayers: 0, maxPlayers: 20, memoryUsageMb: null, mcVersion: null, lastHeartbeat: now.toISOString(), createdAt: now.toISOString(), expiresAt: exp.toISOString(), timing: { apiCallMs: null, providerStartMs: null, providerWaitMs: null, totalElapsedMs: null }, retries: 0, heartbeatCount: 0, clientVersion: body.clientVersion, installationId: body.installationId, correlationId: body.correlationId };
  await env.CUBEFORGE_REGISTRY.put(`csession:${sid}`, JSON.stringify(session), { expirationTtl: cfg.leaseTtlSeconds });
  await env.CUBEFORGE_REGISTRY.put(`csession-by-shortcode:${shortCode}`, sid);
  const payload = ok(ResponseCodes.CONNECTION_SESSION_CREATED, 'Sessão criada.', { sessionId: sid, launcher: 'tsnet-v1', launcherVersion: 1, protocolVersion: 1, credentials: {}, leaseDurationMs: LEASE_DURATION_MS, expiresAt: exp.toISOString() }, body.requestId);
  await env.CUBEFORGE_REGISTRY.put(`requestId:${body.requestId}`, JSON.stringify({ ...payload, _status: 201 }), { expirationTtl: REQUEST_ID_CACHE_TTL });
  return json(payload, 201, cors);
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

      if (m === 'GET' && p === '/health') return new Response(JSON.stringify(ok(ResponseCodes.SUCCESS, 'OK', { status: 'ok', version: 'v1' })), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });

      return json(fail(ResponseCodes.NOT_FOUND, 'Endpoint não encontrado.', { path: p, method: m }), 404, cors);
    } catch (e) { console.error('Unhandled:', e); return json(fail(ResponseCodes.INTERNAL_ERROR, 'Erro interno.', { error: String(e) }), 500, cors); }
  },
};