/**
 * CubeForge Central API v1
 * 
 * Cloudflare Worker responsável por:
 * - Gerenciar servidores Minecraft como entidades permanentes
 * - Gerenciar sessões de jogo como entidades temporárias
 * - Gerar shortCodes únicos para convites
 * - Receber heartbeats dos hosts
 * - Servir descoberta de servidores para guests
 * 
 * Endpoints v1:
 *   POST   /api/v1/servers                    → Criar servidor (permanente)
 *   GET    /api/v1/servers/:shortCode         → Descobrir servidor + sessão ativa
 *   PATCH  /api/v1/servers/:shortCode         → Atualizar metadados do servidor
 *   DELETE /api/v1/servers/:shortCode         → Remover servidor
 *   POST   /api/v1/servers/:shortCode/sessions → Criar/atualizar sessão
 *   GET    /api/v1/servers/:shortCode/sessions  → Obter sessão atual
 *   DELETE /api/v1/servers/:shortCode/sessions  → Encerrar sessão
 *   POST   /api/v1/servers/:shortCode/heartbeat → Heartbeat (renova TTL da sessão)
 * 
 * Endpoints legado (v0, mantidos para compatibilidade):
 *   POST   /api/servers                       → Redireciona para v1
 *   GET    /api/servers/:shortCode            → Redireciona para v1
 *   PATCH  /api/servers/:shortCode/status     → Redireciona para v1
 *   DELETE /api/servers/:shortCode            → Redireciona para v1
 *   POST   /api/servers/:shortCode/heartbeat  → Redireciona para v1
 */

// ============================================================
// Tipos
// ============================================================

interface Env {
  CUBEFORGE_REGISTRY: KVNamespace;
  SERVER_TTL_SECONDS: string;
  HEARTBEAT_TIMEOUT_SECONDS: string;
  HEARTBEAT_EXPIRE_SECONDS: string;
  SHORT_CODE_LENGTH: string;
  API_BASE_URL: string;
  ENVIRONMENT: string;
}

type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed';

interface NetworkProvider {
  provider: string;
  connectionInfo: Record<string, string>;
}

// --- Entidade Servidor (Permanente) ---
interface ServerEntity {
  shortCode: string;
  uuid: string;
  name: string;
  version: string;
  serverType: string;
  description: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

// --- Entidade Sessão (Temporária) ---
interface SessionEntity {
  shortCode: string;
  provider: string;
  hostIp: string;
  port: number;
  status: ServerStatus;
  currentPlayers: number;
  maxPlayers: number;
  lastHeartbeat: string;
  createdAt: string;
  expiresAt: string;
}

// --- Resposta Padronizada ---
interface ApiResponse<T = any> {
  success: boolean;
  code: string;
  message: string;
  data?: T;
  details?: Record<string, any>;
  timestamp: string;
}

// ============================================================
// Códigos de Resposta
// ============================================================

const ResponseCodes = {
  // Sucesso
  SUCCESS: 'SUCCESS',
  SERVER_CREATED: 'SERVER_CREATED',
  SERVER_UPDATED: 'SERVER_UPDATED',
  SERVER_DELETED: 'SERVER_DELETED',
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_UPDATED: 'SESSION_UPDATED',
  SESSION_DELETED: 'SESSION_DELETED',
  HEARTBEAT_RECEIVED: 'HEARTBEAT_RECEIVED',
  
  // Erros
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  SERVER_NOT_FOUND: 'SERVER_NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

// ============================================================
// Helpers
// ============================================================

const SHORT_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function successResponse(code: string, message: string, data?: any, details?: Record<string, any>): ApiResponse {
  return {
    success: true,
    code,
    message,
    data,
    details,
    timestamp: new Date().toISOString(),
  };
}

function errorResponse(code: string, message: string, details?: Record<string, any>): ApiResponse {
  return {
    success: false,
    code,
    message,
    details,
    timestamp: new Date().toISOString(),
  };
}

function jsonResponse(body: ApiResponse, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function generateUniqueShortCode(env: Env, length: number): Promise<string> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let code = '';
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    for (let i = 0; i < length; i++) {
      code += SHORT_CODE_CHARS[array[i] % SHORT_CODE_CHARS.length];
    }
    const existing = await env.CUBEFORGE_REGISTRY.get(`server:${code}`);
    if (!existing) {
      return code;
    }
    console.warn(`[SHORTCODE] Collision for ${code}, retrying... (attempt ${attempt + 1})`);
  }
  const timestamp = Date.now().toString(36).toUpperCase();
  return timestamp.slice(-length);
}

function generateUUID(): string {
  return crypto.randomUUID();
}

// ============================================================
// KV Key Scheme
// ============================================================
// server:{shortCode}       → ServerEntity (sem expiração)
// session:{shortCode}      → SessionEntity (com TTL)
// shortCode:{uuid}         → shortCode (para lookup reverso, sem expiração)

// ============================================================
// Handlers v1
// ============================================================

/**
 * POST /api/v1/servers
 * Cria um servidor como entidade permanente.
 */
async function handleV1CreateServer(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      errorResponse(ResponseCodes.BAD_REQUEST, 'JSON inválido no corpo da requisição.'),
      400,
      corsHeaders
    );
  }

  // Validar campos obrigatórios
  if (!body.name || !body.version || !body.serverType) {
    return jsonResponse(
      errorResponse(ResponseCodes.VALIDATION_ERROR, 'Campos obrigatórios: name, version, serverType.', {
        received: Object.keys(body),
      }),
      400,
      corsHeaders
    );
  }

  // Usar shortCode fornecido ou gerar novo
  const shortCode = body.shortCode || await generateUniqueShortCode(env, parseInt(env.SHORT_CODE_LENGTH || '6'));
  const uuid = generateUUID();

  const server: ServerEntity = {
    shortCode,
    uuid,
    name: body.name,
    version: body.version,
    serverType: body.serverType,
    description: body.description || '',
    owner: body.owner || uuid,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Armazenar servidor (sem TTL — permanente)
  await env.CUBEFORGE_REGISTRY.put(`server:${shortCode}`, JSON.stringify(server));
  await env.CUBEFORGE_REGISTRY.put(`shortCode:${uuid}`, shortCode);

  console.log(`[V1] Server created: ${shortCode} - ${server.name}`);

  return jsonResponse(
    successResponse(ResponseCodes.SERVER_CREATED, 'Servidor criado com sucesso.', server),
    201,
    corsHeaders
  );
}

/**
 * GET /api/v1/servers/:shortCode
 * Retorna informações do servidor + sessão ativa (se houver).
 */
async function handleV1DiscoverServer(
  shortCode: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const serverJson = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!serverJson) {
    return jsonResponse(
      errorResponse(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.', { shortCode }),
      404,
      corsHeaders
    );
  }

  const server: ServerEntity = JSON.parse(serverJson);

  // Tentar obter sessão ativa
  const sessionJson = await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`);
  const session: SessionEntity | null = sessionJson ? JSON.parse(sessionJson) : null;

  console.log(`[V1] Server discovered: ${shortCode} - session=${session ? session.status : 'none'}`);

  return jsonResponse(
    successResponse(ResponseCodes.SUCCESS, 'Servidor encontrado.', {
      server,
      session: session ? {
        provider: session.provider,
        hostIp: session.hostIp,
        port: session.port,
        status: session.status,
        currentPlayers: session.currentPlayers,
        maxPlayers: session.maxPlayers,
        lastHeartbeat: session.lastHeartbeat,
      } : null,
    }),
    200,
    corsHeaders
  );
}

/**
 * PATCH /api/v1/servers/:shortCode
 * Atualiza metadados do servidor (nome, descrição, etc.).
 */
async function handleV1UpdateServer(
  shortCode: string,
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      errorResponse(ResponseCodes.BAD_REQUEST, 'JSON inválido no corpo da requisição.'),
      400,
      corsHeaders
    );
  }

  const serverJson = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!serverJson) {
    return jsonResponse(
      errorResponse(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado.', { shortCode }),
      404,
      corsHeaders
    );
  }

  const server: ServerEntity = JSON.parse(serverJson);

  // Atualizar apenas campos fornecidos
  if (body.name !== undefined) server.name = body.name;
  if (body.version !== undefined) server.version = body.version;
  if (body.serverType !== undefined) server.serverType = body.serverType;
  if (body.description !== undefined) server.description = body.description;
  server.updatedAt = new Date().toISOString();

  await env.CUBEFORGE_REGISTRY.put(`server:${shortCode}`, JSON.stringify(server));

  console.log(`[V1] Server updated: ${shortCode}`);

  return jsonResponse(
    successResponse(ResponseCodes.SERVER_UPDATED, 'Servidor atualizado com sucesso.', server),
    200,
    corsHeaders
  );
}

/**
 * DELETE /api/v1/servers/:shortCode
 * Remove um servidor e sua sessão ativa (se houver).
 */
async function handleV1DeleteServer(
  shortCode: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Remover servidor
  const serverJson = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (serverJson) {
    const server: ServerEntity = JSON.parse(serverJson);
    await env.CUBEFORGE_REGISTRY.delete(`server:${shortCode}`);
    await env.CUBEFORGE_REGISTRY.delete(`shortCode:${server.uuid}`);
  }

  // Remover sessão ativa (se houver)
  await env.CUBEFORGE_REGISTRY.delete(`session:${shortCode}`);

  console.log(`[V1] Server deleted: ${shortCode}`);

  return jsonResponse(
    successResponse(ResponseCodes.SERVER_DELETED, 'Servidor removido com sucesso.', { shortCode }),
    200,
    corsHeaders
  );
}

/**
 * POST /api/v1/servers/:shortCode/sessions
 * Cria ou atualiza uma sessão de jogo.
 */
async function handleV1CreateSession(
  shortCode: string,
  request: Request,
  env: Env,
  config: { ttlSeconds: number },
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Verificar se o servidor existe
  const serverJson = await env.CUBEFORGE_REGISTRY.get(`server:${shortCode}`);
  if (!serverJson) {
    return jsonResponse(
      errorResponse(ResponseCodes.SERVER_NOT_FOUND, 'Servidor não encontrado. Crie o servidor primeiro.', { shortCode }),
      404,
      corsHeaders
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      errorResponse(ResponseCodes.BAD_REQUEST, 'JSON inválido no corpo da requisição.'),
      400,
      corsHeaders
    );
  }

  if (!body.provider || !body.hostIp || !body.port) {
    return jsonResponse(
      errorResponse(ResponseCodes.VALIDATION_ERROR, 'Campos obrigatórios: provider, hostIp, port.', {
        received: Object.keys(body),
      }),
      400,
      corsHeaders
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.ttlSeconds * 1000);

  const session: SessionEntity = {
    shortCode,
    provider: body.provider,
    hostIp: body.hostIp,
    port: body.port,
    status: body.status || 'starting',
    currentPlayers: body.currentPlayers || 0,
    maxPlayers: body.maxPlayers || 20,
    lastHeartbeat: now.toISOString(),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await env.CUBEFORGE_REGISTRY.put(`session:${shortCode}`, JSON.stringify(session), {
    expirationTtl: config.ttlSeconds,
  });

  console.log(`[V1] Session created: ${shortCode} - provider=${body.provider}, status=${session.status}`);

  return jsonResponse(
    successResponse(ResponseCodes.SESSION_CREATED, 'Sessão criada com sucesso.', session),
    201,
    corsHeaders
  );
}

/**
 * GET /api/v1/servers/:shortCode/sessions
 * Retorna a sessão ativa do servidor.
 */
async function handleV1GetSession(
  shortCode: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const sessionJson = await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`);
  if (!sessionJson) {
    return jsonResponse(
      errorResponse(ResponseCodes.SESSION_NOT_FOUND, 'Nenhuma sessão ativa para este servidor.', { shortCode }),
      404,
      corsHeaders
    );
  }

  const session: SessionEntity = JSON.parse(sessionJson);

  return jsonResponse(
    successResponse(ResponseCodes.SUCCESS, 'Sessão encontrada.', session),
    200,
    corsHeaders
  );
}

/**
 * DELETE /api/v1/servers/:shortCode/sessions
 * Encerra a sessão ativa do servidor.
 */
async function handleV1DeleteSession(
  shortCode: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  await env.CUBEFORGE_REGISTRY.delete(`session:${shortCode}`);

  console.log(`[V1] Session deleted: ${shortCode}`);

  return jsonResponse(
    successResponse(ResponseCodes.SESSION_DELETED, 'Sessão encerrada com sucesso.', { shortCode }),
    200,
    corsHeaders
  );
}

/**
 * POST /api/v1/servers/:shortCode/heartbeat
 * Recebe heartbeat do host e renova o TTL da sessão.
 */
async function handleV1Heartbeat(
  shortCode: string,
  request: Request,
  env: Env,
  config: { ttlSeconds: number },
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const sessionJson = await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`);
  if (!sessionJson) {
    // Sessão não existe — pode ter expirado. Não é erro crítico.
    return jsonResponse(
      successResponse(ResponseCodes.HEARTBEAT_RECEIVED, 'Heartbeat recebido, mas nenhuma sessão ativa.', { shortCode }),
      200,
      corsHeaders
    );
  }

  const session: SessionEntity = JSON.parse(sessionJson);
  const now = new Date();
  session.lastHeartbeat = now.toISOString();

  if (body.status) {
    session.status = body.status;
  }
  if (body.currentPlayers !== undefined) {
    session.currentPlayers = body.currentPlayers;
  }

  // Renovar TTL
  const expiresAt = new Date(now.getTime() + config.ttlSeconds * 1000);
  session.expiresAt = expiresAt.toISOString();

  await env.CUBEFORGE_REGISTRY.put(`session:${shortCode}`, JSON.stringify(session), {
    expirationTtl: config.ttlSeconds,
  });

  console.log(`[V1] Heartbeat received: ${shortCode} - status=${session.status}`);

  return jsonResponse(
    successResponse(ResponseCodes.HEARTBEAT_RECEIVED, 'Heartbeat recebido. TTL renovado.', {
      shortCode,
      expiresAt: expiresAt.toISOString(),
    }),
    200,
    corsHeaders
  );
}

// ============================================================
// Handlers Legado (v0 → v1)
// ============================================================

/**
 * Converte requisição v0 para v1.
 * POST /api/servers → POST /api/v1/servers
 */
async function handleLegacyRegisterServer(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      errorResponse(ResponseCodes.BAD_REQUEST, 'JSON inválido no corpo da requisição.'),
      400,
      corsHeaders
    );
  }

  // Extrair shortCode do body ou query
  const url = new URL(request.url);
  const shortCode = url.searchParams.get('shortCode') || body.shortCode;

  // Criar servidor
  const createBody = {
    name: body.name,
    version: body.version,
    serverType: body.serverType,
    description: body.description,
    owner: body.owner,
    shortCode,
  };

  const createReq = new Request(request.url, {
    method: 'POST',
    body: JSON.stringify(createBody),
    headers: { 'Content-Type': 'application/json' },
  });

  const createResp = await handleV1CreateServer(createReq, env, corsHeaders);
  const createData = await createResp.json() as ApiResponse;

  if (!createData.success) {
    return jsonResponse(createData, createResp.status, corsHeaders);
  }

  // Se tiver informações de rede, criar sessão também
  if (body.networkProvider?.provider && body.hostIp) {
    const sessionBody = {
      provider: body.networkProvider.provider,
      hostIp: body.hostIp,
      port: body.port || 25565,
      status: body.status || 'starting',
      currentPlayers: body.currentPlayers || 0,
      maxPlayers: body.maxPlayers || 20,
    };

    const sessionReq = new Request(request.url, {
      method: 'POST',
      body: JSON.stringify(sessionBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const config = {
      ttlSeconds: parseInt(env.SERVER_TTL_SECONDS || '14400'),
    };

    await handleV1CreateSession(shortCode || createData.data?.shortCode, sessionReq, env, config, corsHeaders);
  }

  return jsonResponse(createData, createResp.status, corsHeaders);
}

/**
 * Converte requisição v0 para v1.
 * GET /api/servers/:shortCode → GET /api/v1/servers/:shortCode
 */
async function handleLegacyDiscoverServer(
  shortCode: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const resp = await handleV1DiscoverServer(shortCode, env, corsHeaders);
  const data = await resp.json() as ApiResponse;

  // Adaptar resposta para formato legado
  if (data.success && data.data) {
    const { server, session } = data.data;
    const legacyData = {
      shortCode: server.shortCode,
      name: server.name,
      version: server.version,
      serverType: server.serverType,
      description: server.description,
      status: session?.status || 'offline',
      port: session?.port || 25565,
      maxPlayers: session?.maxPlayers || 20,
      currentPlayers: session?.currentPlayers || 0,
      networkProvider: session ? {
        provider: session.provider,
        connectionInfo: { hostIp: session.hostIp },
      } : null,
      ttlSeconds: parseInt(env.SERVER_TTL_SECONDS || '14400'),
      expiresAt: session?.expiresAt || null,
    };

    return new Response(JSON.stringify(legacyData), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  return resp;
}

/**
 * Converte requisição v0 para v1.
 * PATCH /api/servers/:shortCode/status → POST /api/v1/servers/:shortCode/sessions
 */
async function handleLegacyUpdateStatus(
  shortCode: string,
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      errorResponse(ResponseCodes.BAD_REQUEST, 'JSON inválido.'),
      400,
      corsHeaders
    );
  }

  if (!body.status) {
    return jsonResponse(
      errorResponse(ResponseCodes.VALIDATION_ERROR, 'Campo obrigatório: status.'),
      400,
      corsHeaders
    );
  }

  // Tentar obter sessão existente
  const sessionJson = await env.CUBEFORGE_REGISTRY.get(`session:${shortCode}`);
  if (!sessionJson) {
    // Se não há sessão, criar uma básica
    const config = { ttlSeconds: parseInt(env.SERVER_TTL_SECONDS || '14400') };
    const sessionBody = {
      provider: 'unknown',
      hostIp: '0.0.0.0',
      port: body.port || 25565,
      status: body.status,
      currentPlayers: body.currentPlayers || 0,
      maxPlayers: body.maxPlayers || 20,
    };
    const sessionReq = new Request(request.url, {
      method: 'POST',
      body: JSON.stringify(sessionBody),
      headers: { 'Content-Type': 'application/json' },
    });
    await handleV1CreateSession(shortCode, sessionReq, env, config, corsHeaders);
  } else {
    // Atualizar sessão existente
    const session: SessionEntity = JSON.parse(sessionJson);
    session.status = body.status;
    if (body.currentPlayers !== undefined) {
      session.currentPlayers = body.currentPlayers;
    }
    session.lastHeartbeat = new Date().toISOString();

    const config = { ttlSeconds: parseInt(env.SERVER_TTL_SECONDS || '14400') };
    const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);
    session.expiresAt = expiresAt.toISOString();

    await env.CUBEFORGE_REGISTRY.put(`session:${shortCode}`, JSON.stringify(session), {
      expirationTtl: config.ttlSeconds,
    });
  }

  console.log(`[LEGACY] Status updated: ${shortCode} -> ${body.status}`);

  return new Response(JSON.stringify({ status: 'updated' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

/**
 * Converte requisição v0 para v1.
 * POST /api/servers/:shortCode/heartbeat → POST /api/v1/servers/:shortCode/heartbeat
 */
async function handleLegacyHeartbeat(
  shortCode: string,
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const config = { ttlSeconds: parseInt(env.SERVER_TTL_SECONDS || '14400') };
  const resp = await handleV1Heartbeat(shortCode, request, env, config, corsHeaders);
  const data = await resp.json() as ApiResponse;

  // Adaptar para formato legado
  return new Response(JSON.stringify({
    ttlExtended: data.success,
    expiresAt: data.data?.expiresAt || new Date().toISOString(),
  }), {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

/**
 * Converte requisição v0 para v1.
 * DELETE /api/servers/:shortCode → DELETE /api/v1/servers/:shortCode
 */
async function handleLegacyDeleteServer(
  shortCode: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const resp = await handleV1DeleteServer(shortCode, env, corsHeaders);
  const data = await resp.json() as ApiResponse;

  // Adaptar para formato legado
  return new Response(JSON.stringify({ status: 'removed' }), {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ============================================================
// Main Router
// ============================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      const config = {
        ttlSeconds: parseInt(env.SERVER_TTL_SECONDS || '14400'),
        heartbeatTimeout: parseInt(env.HEARTBEAT_TIMEOUT_SECONDS || '300'),
        heartbeatExpire: parseInt(env.HEARTBEAT_EXPIRE_SECONDS || '600'),
        shortCodeLength: parseInt(env.SHORT_CODE_LENGTH || '6'),
      };

      // ============================================================
      // Rotas v1
      // ============================================================

      // POST /api/v1/servers — Criar servidor
      if (method === 'POST' && path === '/api/v1/servers') {
        return await handleV1CreateServer(request, env, corsHeaders);
      }

      // GET /api/v1/servers/:shortCode — Descobrir servidor
      const v1DiscoverMatch = path.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)$/);
      if (method === 'GET' && v1DiscoverMatch) {
        return await handleV1DiscoverServer(v1DiscoverMatch[1].toUpperCase(), env, corsHeaders);
      }

      // PATCH /api/v1/servers/:shortCode — Atualizar servidor
      if (method === 'PATCH' && v1DiscoverMatch) {
        return await handleV1UpdateServer(v1DiscoverMatch[1].toUpperCase(), request, env, corsHeaders);
      }

      // DELETE /api/v1/servers/:shortCode — Remover servidor
      if (method === 'DELETE' && v1DiscoverMatch) {
        return await handleV1DeleteServer(v1DiscoverMatch[1].toUpperCase(), env, corsHeaders);
      }

      // POST /api/v1/servers/:shortCode/sessions — Criar/atualizar sessão
      const v1SessionMatch = path.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/sessions$/);
      if (method === 'POST' && v1SessionMatch) {
        return await handleV1CreateSession(v1SessionMatch[1].toUpperCase(), request, env, config, corsHeaders);
      }

      // GET /api/v1/servers/:shortCode/sessions — Obter sessão
      if (method === 'GET' && v1SessionMatch) {
        return await handleV1GetSession(v1SessionMatch[1].toUpperCase(), env, corsHeaders);
      }

      // DELETE /api/v1/servers/:shortCode/sessions — Encerrar sessão
      if (method === 'DELETE' && v1SessionMatch) {
        return await handleV1DeleteSession(v1SessionMatch[1].toUpperCase(), env, corsHeaders);
      }

      // POST /api/v1/servers/:shortCode/heartbeat — Heartbeat
      const v1HeartbeatMatch = path.match(/^\/api\/v1\/servers\/([A-Za-z0-9]+)\/heartbeat$/);
      if (method === 'POST' && v1HeartbeatMatch) {
        return await handleV1Heartbeat(v1HeartbeatMatch[1].toUpperCase(), request, env, config, corsHeaders);
      }

      // ============================================================
      // Rotas Legado (v0) — mantidas para compatibilidade
      // ============================================================

      // POST /api/servers — Registrar servidor (legado)
      if (method === 'POST' && path === '/api/servers') {
        return await handleLegacyRegisterServer(request, env, corsHeaders);
      }

      // GET /api/servers/:shortCode — Descobrir servidor (legado)
      const legacyDiscoverMatch = path.match(/^\/api\/servers\/([A-Za-z0-9]+)$/);
      if (method === 'GET' && legacyDiscoverMatch) {
        return await handleLegacyDiscoverServer(legacyDiscoverMatch[1].toUpperCase(), env, corsHeaders);
      }

      // PATCH /api/servers/:shortCode/status — Atualizar status (legado)
      const legacyStatusMatch = path.match(/^\/api\/servers\/([A-Za-z0-9]+)\/status$/);
      if (method === 'PATCH' && legacyStatusMatch) {
        return await handleLegacyUpdateStatus(legacyStatusMatch[1].toUpperCase(), request, env, corsHeaders);
      }

      // POST /api/servers/:shortCode/heartbeat — Heartbeat (legado)
      const legacyHeartbeatMatch = path.match(/^\/api\/servers\/([A-Za-z0-9]+)\/heartbeat$/);
      if (method === 'POST' && legacyHeartbeatMatch) {
        return await handleLegacyHeartbeat(legacyHeartbeatMatch[1].toUpperCase(), request, env, corsHeaders);
      }

      // DELETE /api/servers/:shortCode — Remover servidor (legado)
      if (method === 'DELETE' && legacyDiscoverMatch) {
        return await handleLegacyDeleteServer(legacyDiscoverMatch[1].toUpperCase(), env, corsHeaders);
      }

      // GET /health — Health check
      if (method === 'GET' && path === '/health') {
        return new Response(JSON.stringify({
          success: true,
          code: 'SUCCESS',
          message: 'API operacional.',
          data: { status: 'ok', version: 'v1', timestamp: new Date().toISOString() },
          timestamp: new Date().toISOString(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 404
      return jsonResponse(
        errorResponse(ResponseCodes.NOT_FOUND, 'Endpoint não encontrado.', { path, method }),
        404,
        corsHeaders
      );

    } catch (error) {
      console.error('Unhandled error:', error);
      return jsonResponse(
        errorResponse(ResponseCodes.INTERNAL_ERROR, 'Erro interno do servidor.', {
          error: String(error),
        }),
        500,
        corsHeaders
      );
    }
  },
};
