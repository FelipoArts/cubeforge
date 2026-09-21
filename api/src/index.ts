import { resolveSupabaseUserId, userHasActiveSubscription, SUPABASE_URL } from './supabase';
export { HostChannel } from './durable-objects/host-channel';

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
  //     checkout.session.async_payment_succeeded — e, desde a assinatura
  //     Cubicase Plus, também customer.subscription.created/updated/deleted)
  STRIPE_RESTRICTED_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Secret — nunca em wrangler.toml. Bypassa RLS inteiro (só o Worker usa,
  // pra gravar assinaturas a partir do webhook do Stripe — ver
  // supabaseRestUpsertSubscription). Configurar com:
  //   wrangler secret put SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_SERVICE_ROLE_KEY?: string;
  // Durable Object do painel web remoto (Cubicase Plus) — um "canal" por
  // dispositivo (panel_devices.id), mantém a conexão WebSocket do app
  // desktop e roteia mensagens para o(s) painel(is) web logados no mesmo
  // usuário. Ver durable-objects/host-channel.ts e plans/remote-web-panel-plan.md.
  HOST_CHANNEL: DurableObjectNamespace;
}

// 'sleeping' = wake-on-demand armado, host de pé só em modo de espera (sem
// Java nem malha rodando) — ver handleHeartbeat/handleWakeServer.
type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed' | 'sleeping';
type SessionStatus = 'creating' | 'starting_provider' | 'waiting_provider' | 'online' | 'degraded' | 'stopping' | 'stopped' | 'failed' | 'cancelled';
type TerminationReason = 'user_stopped' | 'application_closed' | 'provider_error' | 'api_error' | 'crash' | 'timeout' | 'lease_expired';

interface ServerEntity { shortCode: string; uuid: string; name: string; version: string; serverType: string; description: string; owner: string; createdAt: string; updatedAt: string; forgeVersion?: string | null; modLoaderVersion?: string | null; slug?: string | null; connectName?: string | null; }

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
  STALE_WRITE: 'STALE_WRITE', OPERATION_IN_PROGRESS: 'OPERATION_IN_PROGRESS', RATE_LIMITED: 'RATE_LIMITED',
  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',
} as const;

const SHORT_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ============================================================
// LINK DE CONVITE PERSONALIZADO (slug) — Cubicase Plus
// ============================================================
// "play.cubicase.net/<slug>" no lugar do código CF-XXXXXX cru. O slug é só
// um alias público pro shortCode (que continua sendo a credencial real —
// mesmo modelo de confiança do resto da API, ver comentário do rate
// limiting acima): guardado em `slug:<slug>` -> shortCode, pra resolução
// rápida sem varrer todo o registro.
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/; // 3-32 chars, minúsculas/números/hífen, sem hífen nas pontas
const RESERVED_SLUGS = new Set([
  'api', 'app', 'www', 'play', 'download', 'downloads', 'admin', 'assets',
  'entrar', 'login', 'logout', 'obrigado', 'assinatura', 'health', 'join',
  'servers', 'server', 'about', 'sobre', 'termos', 'privacidade', 'null', 'undefined',
]);

function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_REGEX.test(slug) && !RESERVED_SLUGS.has(slug);
}

// ============================================================
// ENDEREÇO DE CONEXÃO PERSONALIZADO (connectName) — Cubicase Plus
// ============================================================
// "<nome>.link.cubicase.net" no lugar de "localhost:<porta>" dentro do
// Minecraft. Campo independente do slug do link de convite (o host pode
// ter nomes diferentes pra cada um) — mesmas regras de formato/reserva
// (isValidSlug) e mesmo modelo de armazenamento (`connect:<nome>` ->
// shortCode), só que num namespace de KV separado.
//
// Só funciona pra convidados na mesh do próprio Cubicase: um registro DNS
// wildcard `*.link.cubicase.net -> A 127.0.0.1`, mantido fora deste Worker
// (painel DNS da HostGator — mesma zona de cubicase.net, ver comentário em
// wrangler.toml), resolve qualquer nome sob esse domínio para o loopback
// onde o tsnet-node do convidado já escuta depois de conectar. Este Worker
// nunca fala com DNS nenhum — só guarda o alias, igual ao slug.
const CONNECT_NAME_DOMAIN = 'link.cubicase.net';

// ============================================================
// RATE LIMITING — proteção básica contra brute-force de shortCode
// ============================================================
// shortCode é a única credencial (6 chars, alfabeto de 32 → ~1.07 bilhão de
// combinações) — sem isso, nada impede um script tentando milhares de
// códigos por minuto contra /servers/{sc} (descoberta) ou mintando sessões
// de convidado à toa via /connection-sessions.
//
// KV não tem incremento atômico (isso exigiria Durable Objects) — sob
// rajadas concorrentes da MESMA origem numa janela de poucos segundos,
// algumas requisições podem escapar da contagem exata. "Best effort" é
// suficiente aqui: o objetivo é inviabilizar brute-force sequencial
// automatizado, não dar uma garantia forte contra um atacante distribuído
// (isso já é papel de uma regra de rate-limit no dashboard da Cloudflare).
const RATE_LIMIT_WINDOW_SECONDS = 60;
const JOIN_RATE_LIMIT = 10;      // connection-sessions: minta uma authKey Tailscale de verdade, mais sensível
const REGEN_CODE_RATE_LIMIT = 5; // regenerar código: ação manual e rara, sem motivo legítimo pra repetir muitas vezes por minuto
const SUB_CHECKOUT_RATE_LIMIT = 5;  // assinar: ação manual e rara, mesmo raciocínio de REGEN_CODE_RATE_LIMIT
const SUB_PORTAL_RATE_LIMIT = 10;   // gerenciar assinatura: pode ser reaberto ao focar o painel de configurações
const WAKE_RATE_LIMIT = 10;         // por IP/min — mesmo raciocínio de JOIN_RATE_LIMIT
// 60, não 20: é o TTL mínimo que o KV do Cloudflare aceita — um valor menor
// falha com "Invalid expiration_ttl" (KV PUT 400), o que derrubava a rota
// inteira com 500 antes de sequer chegar a gravar o pedido de despertar.
const WAKE_COOLDOWN_SECONDS = 60;   // por shortCode, independente do IP — ver handleWakeServer
const SLUG_RATE_LIMIT = 5;          // definir/trocar link de convite: ação manual e rara, mesmo raciocínio de REGEN_CODE_RATE_LIMIT
const CONNECT_NAME_RATE_LIMIT = 5;  // definir/trocar endereço de conexão: mesmo raciocínio de SLUG_RATE_LIMIT
const SLUG_RESOLVE_RATE_LIMIT = 20; // resolver slug->shortCode: chamado pela página de convite (uma vez por visita) — folgado o bastante pra não incomodar visitas legítimas, apertado o bastante pra desanimar varredura de slugs
const PANEL_TICKET_RATE_LIMIT = 20; // painel web (Cubicase Plus): um ticket por tentativa de conexão/reconexão — folgado o bastante para quedas de rede legítimas

function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}

async function checkRateLimit(env: Env, bucket: string, ip: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${bucket}:${ip}`;
  const raw = await env.CUBEFORGE_REGISTRY.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return false;
  await env.CUBEFORGE_REGISTRY.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

function rateLimitedResponse(cors: Record<string, string>): Response {
  return json(fail(ResponseCodes.RATE_LIMITED, 'Muitas tentativas. Aguarde um minuto e tente de novo.'), 429, cors);
}

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
  // Consome (delete) o pedido de despertar, se houver — ver handleWakeServer.
  // Checado incondicionalmente: inofensivo pros chamadores comuns (report_mc_status
  // no Rust), que sempre vão receber wakeRequested:false.
  const wakeKey = `wake:${shortCode}`;
  const wakeRequested = (await env.CUBEFORGE_REGISTRY.get(wakeKey)) !== null;
  if (wakeRequested) await env.CUBEFORGE_REGISTRY.delete(wakeKey);

  return json(ok(ResponseCodes.HEARTBEAT_RECEIVED, 'Heartbeat recebido.', { shortCode, expiresAt: exp.toISOString(), wakeRequested }), 200, cors);
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

  // Rede mesh: vem da ConnectionSession do host ("host" porque este endpoint existe
  // pra convidados descobrirem o status antes de entrar — a sessão relevante é
  // sempre a de quem hospeda), se houver uma ativa agora.
  const csid = await env.CUBEFORGE_REGISTRY.get(`csession-by-shortcode:${shortCode}:host`);
  let networkStatus: SessionStatus | null = null;
  let provider = 'tailscale', hostIp = '', port = 25565, maxPlayers = 20, currentPlayers = 0, lastHeartbeat: string | null = null;
  if (csid) {
    const csj = await env.CUBEFORGE_REGISTRY.get(`csession:${csid}`);
    if (csj) {
      const cs: ConnectionSessionEntity = JSON.parse(csj);
      networkStatus = cs.status;
      provider = cs.launcher; hostIp = cs.hostIp || ''; port = cs.port;
      maxPlayers = cs.maxPlayers; currentPlayers = cs.currentPlayers; lastHeartbeat = cs.lastHeartbeat;
    }
  }

  // Minecraft: vem do heartbeat leve por shortCode (ver handleHeartbeat), que o host
  // manda independente da rede mesh estar ligada — é o que permite dizer "servidor
  // rodando, mas sem malha" ou "malha pronta, servidor desligado" em vez de um
  // único status combinado.
  const mcj = await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`);
  const mc: SessionEntity | null = mcj ? JSON.parse(mcj) : null;
  if (mc) currentPlayers = mc.currentPlayers;

  return json(ok(ResponseCodes.SUCCESS, 'Servidor encontrado.', {
    server: sv,
    session: {
      // Mantido por compatibilidade: builds antigas só conheciam este campo,
      // e ele sempre foi o status da malha, nunca o do Minecraft.
      status: networkStatus,
      networkStatus,
      minecraftStatus: mc?.status ?? null,
      provider, hostIp, port, currentPlayers, maxPlayers, lastHeartbeat,
    },
  }), 200, cors);
}

// ============================================================
// DELETE SERVER
// ============================================================

/**
 * Encerra qualquer ConnectionSession ativa (host e guest) presa a um shortCode,
 * revogando de verdade a credencial Tailscale de cada uma — não só apagando o
 * registro do KV — para que ninguém continue com acesso à malha depois. Usado
 * tanto ao remover um servidor quanto ao regenerar seu código (ver
 * handleRegenerateCode), já que nos dois casos o shortCode antigo deixa de ser
 * válido e qualquer sessão presa a ele precisa cair.
 */
async function terminateActiveSessionsForShortCode(env: Env, shortCode: string): Promise<void> {
  for (const m of ['host', 'guest'] as const) {
    const csid = await env.CUBEFORGE_REGISTRY.get(`csession-by-shortcode:${shortCode}:${m}`);
    if (!csid) continue;
    const csj = await env.CUBEFORGE_REGISTRY.get(`csession:${csid}`);
    if (csj) {
      const cs: ConnectionSessionEntity = JSON.parse(csj);
      if (cs.tailscaleDeviceId) await deleteTailscaleDevice(env, cs.tailscaleDeviceId);
      else if (cs.tailscaleKeyId) await revokeTailscaleKey(env, cs.tailscaleKeyId);
    }
    await env.CUBEFORGE_REGISTRY.delete(`csession:${csid}`);
    await env.CUBEFORGE_REGISTRY.delete(`csession-by-shortcode:${shortCode}:${m}`);
  }
}

async function handleDeleteServer(shortCode: string, env: Env, cors: Record<string, string>): Promise<Response> {
  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (sj) {
    const sv: ServerEntity = JSON.parse(sj);
    await env.CUBEFORGE_REGISTRY.delete(`server:${shortCode}`);
    await env.CUBEFORGE_REGISTRY.delete(`shortCode:${sv.uuid}`);
    if (sv.slug) await env.CUBEFORGE_REGISTRY.delete(`slug:${sv.slug}`);
    if (sv.connectName) await env.CUBEFORGE_REGISTRY.delete(`connect:${sv.connectName}`);
  }
  await terminateActiveSessionsForShortCode(env, shortCode);
  await env.CUBEFORGE_REGISTRY.delete(`session:${shortCode}`);
  return json(ok(ResponseCodes.SERVER_DELETED, 'Servidor removido.'), 200, cors);
}

// ============================================================
// REGENERATE SERVER CODE
// ============================================================
//
// Gera um novo shortCode para um servidor já existente, mantendo uuid e
// metadados intactos — usado quando o código atual vazou (ver discussão de
// segurança da ACL). Só o Worker decide o novo código (via genCode, mesma
// checagem de colisão do cadastro inicial) para nunca haver risco de dois
// clientes gerarem o mesmo valor.
//
// Encerra de propósito qualquer sessão ativa presa ao código antigo — se
// alguém (inclusive um estranho que tinha o código vazado) estava conectado
// na malha, cai na hora. O host precisa reconectar/reiniciar a hospedagem
// depois, o que já re-registra tudo do zero com o código novo.

async function handleRegenerateCode(oldShortCode: string, env: Env, cfg: { shortCodeLength: number }, cors: Record<string, string>): Promise<Response> {
  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${oldShortCode}`);
  if (!sj) return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.'), 404, cors);
  const sv: ServerEntity = JSON.parse(sj);

  const newShortCode = await genCode(env, cfg.shortCodeLength);
  const updated: ServerEntity = { ...sv, shortCode: newShortCode, updatedAt: new Date().toISOString() };

  await env.CUBEFORGE_REGISTRY.put(`server:${newShortCode}`, JSON.stringify(updated));
  await env.CUBEFORGE_REGISTRY.put(`shortCode:${sv.uuid}`, newShortCode);
  await env.CUBEFORGE_REGISTRY.delete(`server:${oldShortCode}`);
  // O link de convite e o endereço de conexão personalizados (se houver)
  // sobrevivem à troca de código — reapontar as reverse-lookups pro
  // shortCode novo, senão ficavam resolvendo pro código antigo (que acabou
  // de deixar de existir).
  if (sv.slug) await env.CUBEFORGE_REGISTRY.put(`slug:${sv.slug}`, newShortCode);
  if (sv.connectName) await env.CUBEFORGE_REGISTRY.put(`connect:${sv.connectName}`, newShortCode);

  // Sessão legada de heartbeat (ver handleHeartbeat) e qualquer ConnectionSession
  // ativa ficam órfãs/inválidas presas ao código antigo — melhor derrubar tudo
  // agora do que deixar lixo (ou, pior, acesso de rede) associado a um código
  // que não existe mais.
  await terminateActiveSessionsForShortCode(env, oldShortCode);
  await env.CUBEFORGE_REGISTRY.delete(`session:${oldShortCode}`);

  return json(ok(ResponseCodes.SERVER_UPDATED, 'Código regenerado.', updated), 200, cors);
}

// ============================================================
// WAKE-ON-DEMAND — acordar servidor em espera (Cubicase Plus)
// ============================================================
// Só grava um "pedido de despertar" (TTL curto) que o host consome no
// próximo heartbeat de "sleeping" que mandar (ver handleHeartbeat) — o
// Worker nunca fala direto com o host, é sempre o host puxando (polling
// curto do lado dele). Duas proteções, não uma: rate limit por IP (padrão
// já usado nas outras rotas) E um cooldown por shortCode — este último é o
// que realmente impede alguém de ficar ligando o PC de um estranho remoto
// repetidamente com um código vazado, independente de trocar de IP.

async function handleWakeServer(shortCode: string, env: Env, cors: Record<string, string>): Promise<Response> {
  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!sj) return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.'), 404, cors);

  const cooldownKey = `wakecooldown:${shortCode}`;
  if (await env.CUBEFORGE_REGISTRY.get(cooldownKey)) {
    return json(fail(ResponseCodes.RATE_LIMITED, 'Pedido de despertar já enviado recentemente. Aguarde alguns segundos.'), 429, cors);
  }
  await env.CUBEFORGE_REGISTRY.put(cooldownKey, '1', { expirationTtl: WAKE_COOLDOWN_SECONDS });
  await env.CUBEFORGE_REGISTRY.put(`wake:${shortCode}`, '1', { expirationTtl: 120 });

  return json(ok(ResponseCodes.SUCCESS, 'Pedido de despertar enviado.'), 200, cors);
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
// Essa key nunca pode ir para o cliente desktop, já que o Cubicase é
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

// ============================================================
// Cubicase Plus (Stripe Subscriptions) — assinatura recorrente
// ============================================================
// Mesmo princípio da doação acima (fetch puro contra a API do Stripe, sem
// SDK), mas com duas diferenças importantes:
//
// 1. Precisa saber QUEM está assinando — diferente da doação (anônima), a
//    entitlement precisa ficar amarrada a um usuário do Supabase. Como o
//    Worker não tem sessão nenhuma do usuário, `resolveSupabaseUserId`
//    valida o próprio access token do Supabase (mandado pelo app no header
//    Authorization) contra o Supabase Auth antes de fazer qualquer coisa —
//    nunca confia num userId vindo solto no body, senão qualquer um
//    conseguiria abrir o Portal de cobrança (ou até "assinar em nome") de
//    outra pessoa só adivinhando o UUID dela.
//
// 2. O vínculo Stripe <-> Supabase viaja em `subscription_data.metadata`
//    na criação da Checkout Session — o Stripe copia isso pro objeto
//    Subscription, então todo evento de webhook da vida útil dessa
//    assinatura (created/updated/deleted) já chega com o supabase_user_id,
//    sem precisar guardar um mapeamento à parte nem consultar o Supabase a
//    cada evento.
//
// A tabela `subscriptions` (ver scripts/supabase-subscriptions.sql) só é
// escrita por aqui, via SUPABASE_SERVICE_ROLE_KEY (bypassa RLS) — o app só
// LÊ, direto do Supabase, com a própria sessão do usuário.

// Criados uma vez no Dashboard do Stripe (Product "Cubicase Plus", dois
// Prices recorrentes) — IDs de preço não são segredo, só a chave de API é.
const SUBSCRIPTION_PRICE_MONTHLY = 'price_1UEtMAJrnDGUaagEswwcRrr0'; // R$14,90/mês
const SUBSCRIPTION_PRICE_ANNUAL = 'price_1UEtMAJrnDGUaagEv7oGwtQq';  // R$149,90/ano

type SubscriptionPlan = 'monthly' | 'annual';

function priceIdForPlan(plan: string): string | null {
  if (plan === 'monthly') return SUBSCRIPTION_PRICE_MONTHLY;
  if (plan === 'annual') return SUBSCRIPTION_PRICE_ANNUAL;
  return null;
}

function planForPriceId(priceId: string | undefined): SubscriptionPlan | null {
  if (priceId === SUBSCRIPTION_PRICE_MONTHLY) return 'monthly';
  if (priceId === SUBSCRIPTION_PRICE_ANNUAL) return 'annual';
  return null;
}

/** Busca o stripe_customer_id já salvo para este usuário (evita duplicar Customer no Stripe ao reassinar). */
async function supabaseRestGetCustomerId(env: Env, userId: string): Promise<string | null> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!resp.ok) return null;
    const rows: any = await resp.json().catch(() => []);
    return rows?.[0]?.stripe_customer_id ?? null;
  } catch {
    return null;
  }
}

/** Upsert (por user_id) da linha de assinatura — chamado a partir do webhook, nunca do fluxo síncrono de checkout. */
async function supabaseRestUpsertSubscription(env: Env, row: {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan: SubscriptionPlan;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY ausente — assinatura não sincronizada com o Supabase.');
    return;
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
    });
    if (!resp.ok) {
      console.error('Falha ao gravar assinatura no Supabase:', resp.status, await resp.text().catch(() => ''));
    }
  } catch (e) {
    console.error('Falha ao contatar o Supabase:', e);
  }
}

/** POST /api/v1/subscriptions/checkout-session — abre o Checkout de assinatura (mensal ou anual). */
async function handleCreateSubscriptionCheckout(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.STRIPE_RESTRICTED_KEY) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Assinaturas não estão configuradas neste servidor.'), 503, cors);
  }
  const userId = await resolveSupabaseUserId(req);
  if (!userId) return json(fail(ResponseCodes.BAD_REQUEST, 'Não autenticado.'), 401, cors);

  let body: any; try { body = await req.json(); } catch { body = {}; }
  const priceId = priceIdForPlan(body.plan);
  if (!priceId) return json(fail(ResponseCodes.VALIDATION_ERROR, 'plan precisa ser "monthly" ou "annual".'), 400, cors);

  const existingCustomerId = await supabaseRestGetCustomerId(env, userId);

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('success_url', 'https://cubicase.net/assinatura/sucesso/?session_id={CHECKOUT_SESSION_ID}');
  params.set('cancel_url', 'https://cubicase.net/download/');
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price]', priceId);
  // client_reference_id é só pra visibilidade no Dashboard — a reconciliação
  // de verdade usa subscription_data.metadata (ver comentário no topo desta
  // seção), que persiste em todo evento de webhook da assinatura.
  params.set('client_reference_id', userId);
  params.set('subscription_data[metadata][supabase_user_id]', userId);
  if (existingCustomerId) params.set('customer', existingCustomerId);
  // Sem payment_method_types de propósito, idem doações.
  params.set('integration_identifier', `cubicase_${randomLowercaseLetters(8)}`);

  let upstream: Response;
  try {
    upstream = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: params.toString(),
    });
  } catch (e) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Falha ao contatar o Stripe.', { error: String(e) }), 502, cors);
  }

  const data: any = await upstream.json().catch(() => null);
  if (!upstream.ok || !data?.url) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Não foi possível criar a sessão de assinatura.', { stripeError: data?.error?.message }), 502, cors);
  }
  return json(ok(ResponseCodes.SUCCESS, 'Sessão de checkout criada.', { url: data.url }), 200, cors);
}

/** POST /api/v1/subscriptions/portal-session — abre o Stripe Billing Portal (gerenciar/cancelar). */
async function handleCreateBillingPortalSession(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.STRIPE_RESTRICTED_KEY) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Portal de assinatura não está configurado neste servidor.'), 503, cors);
  }
  const userId = await resolveSupabaseUserId(req);
  if (!userId) return json(fail(ResponseCodes.BAD_REQUEST, 'Não autenticado.'), 401, cors);

  const customerId = await supabaseRestGetCustomerId(env, userId);
  if (!customerId) return json(fail(ResponseCodes.NOT_FOUND, 'Nenhuma assinatura encontrada.'), 404, cors);

  const params = new URLSearchParams({ customer: customerId, return_url: 'https://cubicase.net/download/' });
  let upstream: Response;
  try {
    upstream = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: params.toString(),
    });
  } catch (e) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Falha ao contatar o Stripe.', { error: String(e) }), 502, cors);
  }

  const data: any = await upstream.json().catch(() => null);
  if (!upstream.ok || !data?.url) {
    return json(fail(ResponseCodes.INTERNAL_ERROR, 'Não foi possível abrir o portal de assinatura.', { stripeError: data?.error?.message }), 502, cors);
  }
  return json(ok(ResponseCodes.SUCCESS, 'Sessão de portal criada.', { url: data.url }), 200, cors);
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

  // Assinatura Cubicase Plus: created/updated cobrem alta (status inicial já
  // vem preenchido, sem precisar de uma chamada de volta ao Stripe pra
  // buscar a subscription) e qualquer mudança de status durante a vida da
  // assinatura (renovação, pagamento atrasado, etc). deleted é o fim de
  // verdade — mantém a linha (status:'canceled') em vez de apagar, pra não
  // perder histórico. Sem handler dedicado pra invoice.payment_failed: uma
  // cobrança falha já reflete em sub.status (ex.: 'past_due') e chega aqui
  // via customer.subscription.updated.
  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const sub = event.data?.object;
    const userId = sub?.metadata?.supabase_user_id;
    if (sub && userId) {
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = planForPriceId(priceId);
      // current_period_end mudou de lugar entre versões da API do Stripe
      // (do topo da Subscription pra dentro de cada item) — lê defensivo.
      const periodEndUnix = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
      await supabaseRestUpsertSubscription(env, {
        user_id: userId,
        stripe_customer_id: sub.customer,
        stripe_subscription_id: sub.id,
        plan: plan ?? 'monthly',
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
        current_period_end: periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null,
        cancel_at_period_end: !!sub.cancel_at_period_end,
      });
    } else {
      console.error('Webhook de assinatura sem metadata.supabase_user_id:', event.id, event.type);
    }
  }

  // Sempre 200 pro Stripe não ficar reenviando eventos que já processamos
  // (ou que não nos interessam) indefinidamente.
  return json(ok(ResponseCodes.SUCCESS, 'ok'), 200, cors);
}

// ============================================================
// LINK DE CONVITE PERSONALIZADO (slug) — handlers
// ============================================================

const INVITE_LINK_DOMAIN = 'play.cubicase.net';

/** PUT /api/v1/servers/{sc}/slug — define/troca o link de convite (login + Cubicase Plus). */
async function handleSetServerSlug(shortCode: string, req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const userId = await resolveSupabaseUserId(req);
  if (!userId) return json(fail(ResponseCodes.BAD_REQUEST, 'Não autenticado.'), 401, cors);
  if (!(await userHasActiveSubscription(env, userId))) {
    return json(fail(ResponseCodes.SUBSCRIPTION_REQUIRED, 'Assine o Cubicase Plus para usar um link de convite personalizado.'), 403, cors);
  }

  let body: any; try { body = await req.json(); } catch { return json(fail(ResponseCodes.BAD_REQUEST, 'JSON inválido.'), 400, cors); }
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  if (!isValidSlug(slug)) {
    return json(fail(ResponseCodes.VALIDATION_ERROR, 'Link inválido — use 3 a 32 letras minúsculas, números ou hífen, sem hífen nas pontas.'), 400, cors);
  }

  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!sj) return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.'), 404, cors);
  const sv: ServerEntity = JSON.parse(sj);

  const existingOwner = await env.CUBEFORGE_REGISTRY.get(`slug:${slug}`);
  if (existingOwner && existingOwner !== shortCode) {
    return json(fail(ResponseCodes.CONFLICT, 'Esse link já está em uso. Escolha outro.'), 409, cors);
  }
  // Todo servidor já responde de graça em play.cubicase.net/<próprio shortCode
  // em minúsculas> (ver handleResolveSlug) — sem isso, alguém poderia "roubar"
  // esse link padrão de outro servidor definindo um slug customizado igual ao
  // shortCode de outro (ex.: slug "a3f9k2" enquanto existe um servidor real
  // com shortCode "A3F9K2"). Só bloqueia se for o shortCode de OUTRO servidor
  // — definir de volta o próprio é redundante, mas inofensivo.
  if (slug.toUpperCase() !== shortCode) {
    const clashingServer = await env.CUBEFORGE_REGISTRY.get(`server:${slug.toUpperCase()}`);
    if (clashingServer) return json(fail(ResponseCodes.CONFLICT, 'Esse link já está em uso. Escolha outro.'), 409, cors);
  }

  if (sv.slug && sv.slug !== slug) await env.CUBEFORGE_REGISTRY.delete(`slug:${sv.slug}`);
  await env.CUBEFORGE_REGISTRY.put(`slug:${slug}`, shortCode);
  const updated: ServerEntity = { ...sv, slug, updatedAt: new Date().toISOString() };
  await env.CUBEFORGE_REGISTRY.put(`server:${shortCode}`, JSON.stringify(updated));

  return json(ok(ResponseCodes.SERVER_UPDATED, 'Link de convite atualizado.', { slug, url: `https://${INVITE_LINK_DOMAIN}/${slug}` }), 200, cors);
}

/** DELETE /api/v1/servers/{sc}/slug — remove o link personalizado (só precisa de login, não exige assinatura ativa). */
async function handleDeleteServerSlug(shortCode: string, req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const userId = await resolveSupabaseUserId(req);
  if (!userId) return json(fail(ResponseCodes.BAD_REQUEST, 'Não autenticado.'), 401, cors);

  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!sj) return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.'), 404, cors);
  const sv: ServerEntity = JSON.parse(sj);

  if (sv.slug) {
    await env.CUBEFORGE_REGISTRY.delete(`slug:${sv.slug}`);
    const updated: ServerEntity = { ...sv, slug: null, updatedAt: new Date().toISOString() };
    await env.CUBEFORGE_REGISTRY.put(`server:${shortCode}`, JSON.stringify(updated));
  }
  return json(ok(ResponseCodes.SERVER_UPDATED, 'Link de convite removido.'), 200, cors);
}

// ============================================================
// ENDEREÇO DE CONEXÃO PERSONALIZADO (connectName) — handlers
// ============================================================

/** PUT /api/v1/servers/{sc}/connect-name — define/troca o endereço usado no Minecraft (login + Cubicase Plus). */
async function handleSetConnectName(shortCode: string, req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const userId = await resolveSupabaseUserId(req);
  if (!userId) return json(fail(ResponseCodes.BAD_REQUEST, 'Não autenticado.'), 401, cors);
  if (!(await userHasActiveSubscription(env, userId))) {
    return json(fail(ResponseCodes.SUBSCRIPTION_REQUIRED, 'Assine o Cubicase Plus para usar um endereço de conexão personalizado.'), 403, cors);
  }

  let body: any; try { body = await req.json(); } catch { return json(fail(ResponseCodes.BAD_REQUEST, 'JSON inválido.'), 400, cors); }
  const name = typeof body.connectName === 'string' ? body.connectName.trim().toLowerCase() : '';
  if (!isValidSlug(name)) {
    return json(fail(ResponseCodes.VALIDATION_ERROR, 'Endereço inválido — use 3 a 32 letras minúsculas, números ou hífen, sem hífen nas pontas.'), 400, cors);
  }

  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!sj) return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.'), 404, cors);
  const sv: ServerEntity = JSON.parse(sj);

  const existingOwner = await env.CUBEFORGE_REGISTRY.get(`connect:${name}`);
  if (existingOwner && existingOwner !== shortCode) {
    return json(fail(ResponseCodes.CONFLICT, 'Esse endereço já está em uso. Escolha outro.'), 409, cors);
  }
  // Mesma proteção anti-sequestro do slug (ver handleSetServerSlug): não
  // deixa ninguém escolher um nome igual ao shortCode em minúsculas de OUTRO
  // servidor, já que esse é o nome padrão grátis dele.
  if (name.toUpperCase() !== shortCode) {
    const clashingServer = await env.CUBEFORGE_REGISTRY.get(`server:${name.toUpperCase()}`);
    if (clashingServer) return json(fail(ResponseCodes.CONFLICT, 'Esse endereço já está em uso. Escolha outro.'), 409, cors);
  }

  if (sv.connectName && sv.connectName !== name) await env.CUBEFORGE_REGISTRY.delete(`connect:${sv.connectName}`);
  await env.CUBEFORGE_REGISTRY.put(`connect:${name}`, shortCode);
  const updated: ServerEntity = { ...sv, connectName: name, updatedAt: new Date().toISOString() };
  await env.CUBEFORGE_REGISTRY.put(`server:${shortCode}`, JSON.stringify(updated));

  return json(ok(ResponseCodes.SERVER_UPDATED, 'Endereço de conexão atualizado.', { connectName: name, address: `${name}.${CONNECT_NAME_DOMAIN}` }), 200, cors);
}

/** DELETE /api/v1/servers/{sc}/connect-name — remove o endereço personalizado (só precisa de login, não exige assinatura ativa). */
async function handleRemoveConnectName(shortCode: string, req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const userId = await resolveSupabaseUserId(req);
  if (!userId) return json(fail(ResponseCodes.BAD_REQUEST, 'Não autenticado.'), 401, cors);

  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!sj) return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.'), 404, cors);
  const sv: ServerEntity = JSON.parse(sj);

  if (sv.connectName) {
    await env.CUBEFORGE_REGISTRY.delete(`connect:${sv.connectName}`);
    const updated: ServerEntity = { ...sv, connectName: null, updatedAt: new Date().toISOString() };
    await env.CUBEFORGE_REGISTRY.put(`server:${shortCode}`, JSON.stringify(updated));
  }
  return json(ok(ResponseCodes.SERVER_UPDATED, 'Endereço de conexão removido.'), 200, cors);
}

// A página de convite em si (play.cubicase.net/<slug>) NÃO mora neste Worker —
// mora num site estático no GitHub Pages (mesmo esquema de docs/entrar/),
// porque a zona DNS de cubicase.net está no HostGator (e-mail e outras coisas
// dependem dela), não no Cloudflare — não dá pra usar "Custom Domain" do
// Workers sem a zona estar aqui. Essa rota é só o que o JS daquela página
// chama pra resolver slug -> shortCode antes de tentar o deep link
// (cubicase://join/<shortCode>) — ver play-site/index.html no repo.

/**
 * GET /api/v1/servers/by-slug/{slug} — resolve um link de convite (público, sem auth).
 *
 * Todo servidor tem um link de graça: o próprio shortCode em minúsculas (ex.:
 * shortCode "A3F9K2" -> play.cubicase.net/a3f9k2), sem precisar de nenhuma
 * escrita extra no KV — só quem assina o Cubicase Plus grava um slug
 * customizado de verdade (ver handleSetServerSlug), então a busca cai aqui
 * primeiro e só tenta o shortCode cru como fallback.
 */
async function handleResolveSlug(slug: string, env: Env, cors: Record<string, string>): Promise<Response> {
  let shortCode = await env.CUBEFORGE_REGISTRY.get(`slug:${slug}`);
  if (!shortCode) {
    const asShortCode = slug.toUpperCase();
    if (await env.CUBEFORGE_REGISTRY.get(`server:${asShortCode}`)) shortCode = asShortCode;
  }
  if (!shortCode) return json(fail(ResponseCodes.NOT_FOUND, 'Link de convite não encontrado.'), 404, cors);

  const sj = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  const name = sj ? (JSON.parse(sj) as ServerEntity).name : null;
  return json(ok(ResponseCodes.SUCCESS, 'Link resolvido.', { shortCode, name }), 200, cors);
}

// ============================================================
// PAINEL WEB REMOTO (Cubicase Plus) — ver plans/remote-web-panel-plan.md
// ============================================================
// O canal em si (WebSocket do app desktop <-> painel web) vive inteiro no
// Durable Object HostChannel (durable-objects/host-channel.ts) — um por
// `panel_devices.id`. Este Worker só faz duas coisas:
//   1. Autentica o painel web (sessão Supabase) e emite um ticket de uso
//      único para a conexão WS, porque o WebSocket nativo do navegador não
//      permite mandar um header Authorization no handshake — só dá pra
//      levar credencial na query string, então evitamos colocar o access
//      token do Supabase (de vida longa) ali, e usamos um ticket efêmero
//      (30s, consumido no primeiro uso) em vez disso.
//   2. Encaminha o upgrade de WebSocket (tanto do app desktop quanto do
//      painel) para o Durable Object do dispositivo certo — a validação de
//      credencial de cada lado (device_token do app; ticket do painel)
//      acontece dentro do próprio Durable Object.
// O app desktop NÃO passa por aqui: ele já manda o device_token direto num
// header Authorization de verdade (não é um navegador, não tem essa
// limitação), então conecta direto na rota de WebSocket abaixo.

/** POST /api/v1/panel/ws-ticket — painel web pede um ticket de uso único para abrir o WebSocket do dispositivo. */
async function handlePanelWsTicket(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const userId = await resolveSupabaseUserId(req);
  if (!userId) return json(fail(ResponseCodes.BAD_REQUEST, 'Sessão inválida ou expirada. Faça login novamente.'), 401, cors);

  let body: any; try { body = await req.json(); } catch { return json(fail(ResponseCodes.BAD_REQUEST, 'JSON inválido.'), 400, cors); }
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : null;
  if (!deviceId) return json(fail(ResponseCodes.VALIDATION_ERROR, 'deviceId obrigatório.'), 400, cors);

  if (!(await userHasActiveSubscription(env, userId))) {
    return json(fail(ResponseCodes.SUBSCRIPTION_REQUIRED, 'O painel web remoto é um recurso do Cubicase Plus.'), 402, cors);
  }

  // Confere que o dispositivo pertence mesmo a este usuário antes de emitir
  // o ticket — sem isso, qualquer assinante Plus logado poderia adivinhar o
  // id (UUID) de outro dispositivo e pedir um ticket para ele.
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json(fail(ResponseCodes.INTERNAL_ERROR, 'Painel web não configurado neste servidor.'), 503, cors);
  const ownerResp = await fetch(
    `${SUPABASE_URL}/rest/v1/panel_devices?id=eq.${encodeURIComponent(deviceId)}&select=user_id`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const ownerRows: any = ownerResp.ok ? await ownerResp.json().catch(() => []) : [];
  if (ownerRows?.[0]?.user_id !== userId) {
    return json(fail(ResponseCodes.SERVER_NOT_FOUND, 'Dispositivo não encontrado para este usuário.'), 404, cors);
  }

  const id = env.HOST_CHANNEL.idFromName(deviceId);
  const stub = env.HOST_CHANNEL.get(id);
  const mintResp = await stub.fetch('https://host-channel.internal/mint-ticket', { method: 'POST' });
  const { ticket } = await mintResp.json() as { ticket: string };

  return json(ok(ResponseCodes.SUCCESS, 'Ticket emitido.', { ticket, deviceId }), 200, cors);
}

/** GET /panel/ws/{deviceId}?role=agent|panel — encaminha o upgrade de WebSocket para o Durable Object do dispositivo. */
async function handlePanelWebSocket(deviceId: string, req: Request, env: Env): Promise<Response> {
  const id = env.HOST_CHANNEL.idFromName(deviceId);
  const stub = env.HOST_CHANNEL.get(id);
  return stub.fetch(req);
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
      if (m === 'POST' && m1) {
        if (!(await checkRateLimit(env, 'join', clientIp(req), JOIN_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handleCreateConnectionSession(m1[1].toUpperCase(), req, env, cfg, cors);
      }

      // POST /api/v1/servers/{sc}/regenerate-code
      const m1r = p.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/regenerate-code$/);
      if (m === 'POST' && m1r) {
        if (!(await checkRateLimit(env, 'regen', clientIp(req), REGEN_CODE_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handleRegenerateCode(m1r[1].toUpperCase(), env, cfg, cors);
      }

      // POST /api/v1/servers/{sc}/wake — acordar servidor em espera (wake-on-demand)
      const m1w = p.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/wake$/);
      if (m === 'POST' && m1w) {
        if (!(await checkRateLimit(env, 'wake', clientIp(req), WAKE_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handleWakeServer(m1w[1].toUpperCase(), env, cors);
      }

      // PUT/DELETE /api/v1/servers/{sc}/slug — link de convite personalizado (Cubicase Plus)
      const m1s = p.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/slug$/);
      if (m === 'PUT' && m1s) {
        if (!(await checkRateLimit(env, 'slug', clientIp(req), SLUG_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handleSetServerSlug(m1s[1].toUpperCase(), req, env, cors);
      }
      if (m === 'DELETE' && m1s) return await handleDeleteServerSlug(m1s[1].toUpperCase(), req, env, cors);

      // PUT/DELETE /api/v1/servers/{sc}/connect-name — endereço de conexão personalizado (Cubicase Plus)
      const m1cn = p.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/connect-name$/);
      if (m === 'PUT' && m1cn) {
        if (!(await checkRateLimit(env, 'connect-name', clientIp(req), CONNECT_NAME_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handleSetConnectName(m1cn[1].toUpperCase(), req, env, cors);
      }
      if (m === 'DELETE' && m1cn) return await handleRemoveConnectName(m1cn[1].toUpperCase(), req, env, cors);

      // GET /api/v1/servers/by-slug/{slug} — resolve o link de convite (chamado pela página estática, ver play-site/index.html)
      const mBySlug = p.match(/^\/api\/v1\/servers\/by-slug\/([a-z0-9-]{3,32})$/);
      if (m === 'GET' && mBySlug) {
        if (!(await checkRateLimit(env, 'slug-resolve', clientIp(req), SLUG_RESOLVE_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handleResolveSlug(mBySlug[1], env, cors);
      }

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
      // Sem checkRateLimit aqui de propósito: essa é a rota mais chamada de
      // longe (cada convidado consulta a cada 30s por servidor conhecido, e
      // o wake-on-demand faz polling rápido enquanto acorda) — checkRateLimit
      // escreve no KV a cada chamada, e o KV do Cloudflare tem cota diária de
      // escrita baixa (já estourou por causa disso, ver incidente de
      // 2026-09-14). Proteção contra brute-force de shortCode aqui deve vir
      // de uma regra de rate-limit no dashboard da Cloudflare (nível de
      // borda, sem custo de escrita no Workers KV) em vez de KV.
      const m3 = p.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)$/);
      if (m === 'GET' && m3) {
        return await handleDiscoverServer(m3[1].toUpperCase(), env, cors);
      }

      // DELETE /api/v1/servers/{sc}
      if (m === 'DELETE' && m3) return await handleDeleteServer(m3[1].toUpperCase(), env, cors);

      // LEGADO: GET /api/servers/{sc} — mesmo raciocínio acima, sem checkRateLimit.
      const m4 = p.match(/^\/api\/servers\/([A-Za-z0-9]+)$/);
      if (m === 'GET' && m4) {
        return await handleLegacyDiscover(m4[1].toUpperCase(), env, cors);
      }
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
      // (nome mantido por compatibilidade com o endpoint já configurado no
      // Dashboard: trata tanto doação avulsa quanto eventos de assinatura)
      if (m === 'POST' && p === '/api/v1/donations/webhook') return await handleStripeWebhook(req, env, cors);

      // POST /api/v1/subscriptions/checkout-session — assinar Cubicase Plus
      if (m === 'POST' && p === '/api/v1/subscriptions/checkout-session') {
        if (!(await checkRateLimit(env, 'sub-checkout', clientIp(req), SUB_CHECKOUT_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handleCreateSubscriptionCheckout(req, env, cors);
      }

      // POST /api/v1/subscriptions/portal-session — gerenciar/cancelar assinatura
      if (m === 'POST' && p === '/api/v1/subscriptions/portal-session') {
        if (!(await checkRateLimit(env, 'sub-portal', clientIp(req), SUB_PORTAL_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handleCreateBillingPortalSession(req, env, cors);
      }

      // POST /api/v1/panel/ws-ticket — painel web (Cubicase Plus) pede ticket para abrir o WebSocket
      if (m === 'POST' && p === '/api/v1/panel/ws-ticket') {
        if (!(await checkRateLimit(env, 'panel-ticket', clientIp(req), PANEL_TICKET_RATE_LIMIT))) return rateLimitedResponse(cors);
        return await handlePanelWsTicket(req, env, cors);
      }

      // GET /panel/ws/{deviceId} — upgrade de WebSocket (app desktop com device_token, ou painel web com ticket)
      const mWs = p.match(/^\/panel\/ws\/([A-Za-z0-9-]+)$/);
      if (m === 'GET' && mWs && req.headers.get('Upgrade') === 'websocket') {
        return await handlePanelWebSocket(mWs[1], req, env);
      }

      if (m === 'GET' && p === '/health') return new Response(JSON.stringify(ok(ResponseCodes.SUCCESS, 'OK', { status: 'ok', version: 'v1' })), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });

      return json(fail(ResponseCodes.NOT_FOUND, 'Endpoint não encontrado.', { path: p, method: m }), 404, cors);
    } catch (e) { console.error('Unhandled:', e); return json(fail(ResponseCodes.INTERNAL_ERROR, 'Erro interno.', { error: String(e) }), 500, cors); }
  },
};