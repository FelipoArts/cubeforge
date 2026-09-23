// ============================================================
// HostChannel — Durable Object do painel web remoto (Cubicase Plus)
// ============================================================
// Um DO por dispositivo (nome = panel_devices.id, um UUID não-secreto).
// Mantém a conexão WebSocket outbound do app desktop (papel "agent") viva
// via WebSocket Hibernation API (o isolate pode ser evacuado da memória
// entre mensagens sem derrubar a conexão do cliente) e roteia mensagens
// entre ela e quantas conexões de painel web (papel "panel") estiverem
// abertas para o mesmo dispositivo — do dono e de contas convidadas.
//
// Protocolo (JSON por mensagem WS, ver espelho em src-tauri/src/panel_agent.rs):
//   agent -> relay -> painel(is):
//     { type: "status", serverRunning, serverName?, playerCount?, maxPlayers?, ts }
//     { type: "log_line", line, ts }
//     { type: "server_list", servers: [{ id, name, version, serverType, status }] }
//     { type: "error", message } — comando que o agent tentou executar e falhou
//       (ex: enviar comando de console sem servidor rodando)
//     { type: "metrics", totalRamMb, availableRamMb, cpuUsagePercent, processRamMb?, processCpuPercent?, ts }
//       (Fase 3 — só enviada quando o agent já tem uma amostra, ver build_metrics_message)
//   relay -> painel (sem vir do agent):
//     { type: "agent_connected" } | { type: "agent_disconnected" }
//     { type: "access", isOwner, permissions } — logo ao conectar: o que ESTA
//       conexão pode fazer (a UI usa só pra esconder/desabilitar botões; quem
//       de fato barra é este DO, a cada mensagem — ver handlePanelMessage)
//     { type: "error", message } — ação negada por falta de permissão
//   painel -> relay:
//     { type: "command", command } | { type: "stop_server" }
//     | { type: "start_server", serverId } | { type: "restart_server", serverId }
//   relay -> agent (o que efetivamente chega ao app desktop):
//     as mensagens acima, RECONSTRUÍDAS depois de autorizadas (nada que o
//     painel mande a mais passa) e com `by` (nome de quem pediu) preenchido
//     aqui — o painel nunca escolhe o próprio `by`. "restart_server" nunca
//     chega ao agent: o DO a executa como stop_server -> (espera status
//     serverRunning=false) -> start_server, pra que "reiniciar" seja uma
//     permissão de verdade e não dê pra usar o meio-caminho pra só desligar.
//
// Permissões (acesso compartilhado): o dono tem tudo; membros têm o que o
// dono definiu (api/src/panel-access.ts). O Worker grava as permissões do
// membro no ticket; aqui elas são guardadas em ctx.storage por usuário
// (`perms:<userId>`) — não no attachment do WebSocket, que tem limite de 2KB
// e uma whitelist de comandos grande estouraria isso.
//
// O agent só empurra `status`/`server_list` por conta própria ao CONECTAR,
// em mudanças de estado do Minecraft, e logo depois de processar um
// comando vindo do painel (ver handle_incoming_message em panel_agent.rs —
// reenvia um snapshot fresco em vez de confiar só no evento se propagar
// sozinho). Ainda assim, um painel que conecta DEPOIS desses eventos (F5,
// segunda aba) não veria nada até o próximo — por isso a DO guarda o
// último `status`/`server_list`, e um histórico curto de `log_line`
// (ctx.storage, sobrevive a hibernação) e repete tudo pra qualquer painel
// que conectar depois (ver cacheAgentSnapshot / handleWebSocketUpgrade).
//
// Autenticação de cada lado acontece só aqui dentro (nunca no Worker "puro",
// ver comentário em index.ts sobre por que o painel usa ticket em vez de
// Authorization: o WebSocket do navegador não manda headers custom):
//   - agent: header `Authorization: Bearer <device_token>` (real header —
//     quem conecta é o processo Rust, não um navegador, então não tem a
//     limitação acima). Validado contra panel_devices via service role.
//   - panel: query `?ticket=<uuid>`, de uso único, emitido por
//     POST /api/v1/panel/ws-ticket (panel-members.ts) e consumido aqui.
// ============================================================

import { SUPABASE_URL, userHasActiveSubscription, type SupabaseEnv } from '../supabase';
import { authorizePanelMessage, normalizePermissions, OWNER_PERMISSIONS, type PanelPermissions } from '../panel-access';

interface Env extends SupabaseEnv {}

const TICKET_TTL_MS = 30_000;
const LOG_HISTORY_KEY = 'log_history';
const LOG_HISTORY_MAX = 200;
const RESTART_KEY = 'pending_restart';
const RESTART_TTL_MS = 90_000;
const MAX_PANEL_MESSAGE_CHARS = 4096;

const NO_PERMISSIONS: PanelPermissions = {
  viewConsole: false,
  start: false,
  stop: false,
  restart: false,
  commands: { mode: 'none', allowlist: [] },
};

interface PendingTicket {
  userId: string;
  name: string;
  isOwner: boolean;
  permissions: PanelPermissions | null;
  expiresAt: number;
}

/** Guardado no próprio WebSocket (serializeAttachment, máx. 2KB) — só identidade, nunca as permissões (ver comentário no topo). */
interface PanelAttachment {
  userId: string;
  name: string;
  isOwner: boolean;
}

interface PendingRestart {
  serverId: string;
  by: string;
  expiresAt: number;
}

export class HostChannel {
  private ctx: DurableObjectState;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/mint-ticket') {
      return this.handleMintTicket(request);
    }
    if (request.method === 'POST' && url.pathname === '/kick') {
      return this.handleKick(request);
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request, url);
    }

    return new Response('Not found', { status: 404 });
  }

  /** Chamado só pelo próprio Worker (nunca exposto fora dele — Durable Objects não têm URL pública própria). */
  private async handleMintTicket(request: Request): Promise<Response> {
    let body: any;
    try { body = await request.json(); } catch { return new Response('JSON inválido.', { status: 400 }); }
    if (typeof body?.userId !== 'string' || !body.userId) return new Response('userId ausente.', { status: 400 });

    const isOwner = body.isOwner === true;
    const permissions = isOwner ? null : normalizePermissions(body.permissions);
    if (!isOwner && !permissions) return new Response('Permissões inválidas.', { status: 400 });

    const ticket = crypto.randomUUID();
    const pending: PendingTicket = {
      userId: body.userId,
      name: typeof body.name === 'string' && body.name ? body.name.slice(0, 80) : 'Alguém',
      isOwner,
      permissions,
      expiresAt: Date.now() + TICKET_TTL_MS,
    };
    // O usuário e as permissões já foram validados pelo Worker (dono ou
    // membro do dispositivo, com Plus do dono ativo) antes de chegar aqui —
    // o ticket só carrega isso adiante pra conexão. Guardado em ctx.storage
    // (não em memória) porque a DO pode ser evacuada entre o mint e o uso.
    await this.ctx.storage.put(`ticket:${ticket}`, pending);
    return new Response(JSON.stringify({ ticket }), { headers: { 'Content-Type': 'application/json' } });
  }

  private async consumeTicket(ticket: string): Promise<PendingTicket | null> {
    const key = `ticket:${ticket}`;
    const pending = await this.ctx.storage.get<PendingTicket>(key);
    await this.ctx.storage.delete(key); // uso único, válido ou não
    if (!pending || Date.now() >= pending.expiresAt) return null;
    return pending;
  }

  /**
   * Derruba as conexões de painel de um membro — depois de mudar as
   * permissões dele (reconecta já com as novas) ou de removê-lo (o Worker
   * passa a negar o ticket, então ele não volta).
   */
  private async handleKick(request: Request): Promise<Response> {
    let body: any;
    try { body = await request.json(); } catch { return new Response('JSON inválido.', { status: 400 }); }
    if (typeof body?.userId !== 'string' || !body.userId) return new Response('userId ausente.', { status: 400 });
    const removed = body.removed === true;

    for (const ws of this.ctx.getWebSockets(`user:${body.userId}`)) {
      try { ws.close(4001, removed ? 'access-removed' : 'access-changed'); } catch { /* já fechando */ }
    }
    if (removed) await this.ctx.storage.delete(`perms:${body.userId}`);
    return new Response(null, { status: 204 });
  }

  private async permsFor(att: PanelAttachment): Promise<PanelPermissions> {
    if (att.isOwner) return OWNER_PERMISSIONS;
    const stored = await this.ctx.storage.get<unknown>(`perms:${att.userId}`);
    return normalizePermissions(stored) ?? NO_PERMISSIONS;
  }

  /**
   * Valida device_token contra panel_devices (service role — bypassa RLS,
   * único jeito de validar credencial que não é a sessão de ninguém) e
   * confere que a assinatura Plus do dono ainda está ativa — o dispositivo
   * pareado e o token continuam existindo mesmo depois que uma assinatura
   * expira, então sem esta segunda checagem o painel continuaria
   * funcionando de graça para quem cancelou.
   */
  private async verifyDeviceToken(deviceId: string, token: string): Promise<boolean> {
    if (!this.env.SUPABASE_SERVICE_ROLE_KEY) return false;
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/panel_devices?id=eq.${encodeURIComponent(deviceId)}&device_token=eq.${encodeURIComponent(token)}&select=user_id`,
        { headers: { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      if (!resp.ok) return false;
      const rows: any = await resp.json().catch(() => []);
      const userId = rows?.[0]?.user_id;
      if (!userId) return false;
      return await userHasActiveSubscription(this.env, userId);
    } catch {
      return false;
    }
  }

  private async touchLastSeen(deviceId: string): Promise<void> {
    if (!this.env.SUPABASE_SERVICE_ROLE_KEY) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/panel_devices?id=eq.${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: {
          apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
      });
    } catch {
      // Best-effort — não bloqueia a conexão por causa de telemetria.
    }
  }

  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    const role = url.searchParams.get('role');
    const deviceId = url.pathname.match(/^\/panel\/ws\/([A-Za-z0-9-]+)$/)?.[1];
    if (!deviceId) return new Response('deviceId ausente na URL.', { status: 400 });

    if (role === 'agent') {
      const auth = request.headers.get('Authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token || !(await this.verifyDeviceToken(deviceId, token))) {
        return new Response('device_token inválido.', { status: 401 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Encerra uma conexão de agente anterior (ex: app reiniciado) antes de
      // aceitar a nova — só um app desktop de cada vez fala por este canal.
      for (const old of this.ctx.getWebSockets('agent')) {
        try { old.close(4000, 'replaced'); } catch { /* já pode estar fechando sozinho */ }
      }
      this.ctx.acceptWebSocket(server, ['agent']);
      void this.touchLastSeen(deviceId);
      void this.broadcastToPanels({ type: 'agent_connected' });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === 'panel') {
      const ticket = url.searchParams.get('ticket');
      const pending = ticket ? await this.consumeTicket(ticket) : null;
      if (!pending) {
        return new Response('Ticket inválido ou expirado.', { status: 401 });
      }

      // Permissões de membro ficam em storage por usuário (ver comentário no topo).
      if (!pending.isOwner && pending.permissions) {
        await this.ctx.storage.put(`perms:${pending.userId}`, pending.permissions);
      }
      const perms = pending.isOwner ? OWNER_PERMISSIONS : (pending.permissions ?? NO_PERMISSIONS);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['panel', `user:${pending.userId}`]);
      const attachment: PanelAttachment = { userId: pending.userId, name: pending.name, isOwner: pending.isOwner };
      server.serializeAttachment(attachment);

      const agentConnected = this.ctx.getWebSockets('agent').length > 0;
      try {
        server.send(JSON.stringify({ type: 'access', isOwner: pending.isOwner, permissions: perms }));
        server.send(JSON.stringify({ type: agentConnected ? 'agent_connected' : 'agent_disconnected' }));
        // O agent só empurra `status`/`server_list` por conta própria quando
        // CONECTA (ou numa mudança de estado do Minecraft) — um painel que
        // chega depois disso (ex: dar F5, abrir uma segunda aba) nunca via
        // nada até o próximo evento, porque não existia como ele pedir um
        // resumo do estado atual. Reproduz aqui o último retrato conhecido,
        // guardado em ctx.storage por cacheAgentSnapshot.
        if (agentConnected) {
          const [lastStatus, lastServerList, logHistory] = await Promise.all([
            this.ctx.storage.get<string>('last:status'),
            this.ctx.storage.get<string>('last:server_list'),
            this.ctx.storage.get<string[]>(LOG_HISTORY_KEY),
          ]);
          if (lastStatus) server.send(lastStatus);
          if (lastServerList) server.send(lastServerList);
          if (perms.viewConsole) {
            for (const line of logHistory ?? []) server.send(line);
          }
        }
      } catch { /* conexão pode já ter caído antes deste send */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('role precisa ser "agent" ou "panel".', { status: 400 });
  }

  /**
   * Manda `message` pra todos os painéis abertos. `consoleOnly` pula quem não
   * tem a permissão de ver o console (log_line e erros de comando podem
   * conter o que outros digitaram/o que o servidor imprimiu).
   */
  private async broadcastToPanels(message: unknown, opts: { consoleOnly?: boolean } = {}): Promise<void> {
    const body = JSON.stringify(message);
    const canSeeConsole = new Map<string, boolean>();
    for (const ws of this.ctx.getWebSockets('panel')) {
      if (opts.consoleOnly) {
        const att = ws.deserializeAttachment() as PanelAttachment | null;
        if (!att) continue;
        let allowed = canSeeConsole.get(att.userId);
        if (allowed === undefined) {
          allowed = (await this.permsFor(att)).viewConsole;
          canSeeConsole.set(att.userId, allowed);
        }
        if (!allowed) continue;
      }
      try { ws.send(body); } catch { /* painel pode ter caído entre a listagem e o send */ }
    }
  }

  // ---- WebSocket Hibernation API ----

  /**
   * Guarda o último `status`/`server_list` recebido do agent (pra repetir
   * pra um painel que conecta depois) e um histórico curto de `log_line`
   * (pra o console do painel não voltar vazio a cada F5/segunda aba — antes
   * disso, log_line nunca era cacheado, só repassado ao vivo).
   */
  private async cacheAgentSnapshot(parsed: any, raw: string): Promise<void> {
    if (parsed?.type === 'status' || parsed?.type === 'server_list') {
      await this.ctx.storage.put(`last:${parsed.type}`, raw);
      return;
    }
    if (parsed?.type === 'log_line') {
      const history = (await this.ctx.storage.get<string[]>(LOG_HISTORY_KEY)) ?? [];
      history.push(raw);
      if (history.length > LOG_HISTORY_MAX) history.splice(0, history.length - LOG_HISTORY_MAX);
      await this.ctx.storage.put(LOG_HISTORY_KEY, history);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('agent')) {
      // Log/status/lista de servidores do app desktop -> painéis abertos.
      if (typeof message !== 'string') return;
      let parsed: any;
      try { parsed = JSON.parse(message); } catch { return; }
      await this.cacheAgentSnapshot(parsed, message);
      await this.broadcastToPanels(parsed, { consoleOnly: parsed?.type === 'log_line' || parsed?.type === 'error' });
      if (parsed?.type === 'status' && parsed.serverRunning === false) {
        await this.maybeCompleteRestart(ws);
      }
      return;
    }
    if (tags.includes('panel')) {
      await this.handlePanelMessage(ws, message);
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    try { ws.send(JSON.stringify({ type: 'error', message })); } catch { /* já fechou */ }
  }

  /**
   * Único caminho de mensagem painel -> agent, e onde as permissões são
   * aplicadas (ver authorizePanelMessage). Nada é repassado "como veio".
   */
  private async handlePanelMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_PANEL_MESSAGE_CHARS) return;
    let parsed: unknown;
    try { parsed = JSON.parse(message); } catch { return; }

    const att = ws.deserializeAttachment() as PanelAttachment | null;
    if (!att) { try { ws.close(1008, 'sem identidade'); } catch { /* */ } return; }

    const decision = authorizePanelMessage(await this.permsFor(att), parsed);
    if (!decision.ok) {
      this.sendError(ws, decision.reason);
      return;
    }

    const agent = this.ctx.getWebSockets('agent')[0];
    if (!agent) {
      try { ws.send(JSON.stringify({ type: 'agent_disconnected' })); } catch { /* já fechou */ }
      return;
    }

    const forward = decision.forward;
    if (forward.type === 'restart_server') {
      await this.beginRestart(ws, agent, forward.serverId, att.name);
      return;
    }
    try { agent.send(JSON.stringify({ ...forward, by: att.name })); } catch { /* agente pode ter caído */ }
  }

  /**
   * "Reiniciar" atômico: manda parar agora e só manda iniciar quando o agent
   * confirmar (status serverRunning=false) — ver maybeCompleteRestart.
   */
  private async beginRestart(ws: WebSocket, agent: WebSocket, serverId: string, by: string): Promise<void> {
    let running = false;
    try {
      const raw = await this.ctx.storage.get<string>('last:status');
      running = raw ? JSON.parse(raw).serverRunning === true : false;
    } catch { /* trata como parado */ }
    if (!running) {
      this.sendError(ws, 'O servidor não está rodando — use "Iniciar".');
      return;
    }
    const pending: PendingRestart = { serverId, by, expiresAt: Date.now() + RESTART_TTL_MS };
    await this.ctx.storage.put(RESTART_KEY, pending);
    try { agent.send(JSON.stringify({ type: 'stop_server', by })); } catch { /* agente pode ter caído */ }
  }

  private async maybeCompleteRestart(agent: WebSocket): Promise<void> {
    const pending = await this.ctx.storage.get<PendingRestart>(RESTART_KEY);
    if (!pending) return;
    await this.ctx.storage.delete(RESTART_KEY); // uma vez só
    if (Date.now() > pending.expiresAt) return;
    try { agent.send(JSON.stringify({ type: 'start_server', serverId: pending.serverId, by: pending.by })); } catch { /* agente pode ter caído */ }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    if (this.ctx.getTags(ws).includes('agent')) {
      await this.ctx.storage.delete(['last:status', 'last:server_list', LOG_HISTORY_KEY, RESTART_KEY]);
      await this.broadcastToPanels({ type: 'agent_disconnected' });
    }
    try { ws.close(); } catch { /* já fechado */ }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    if (this.ctx.getTags(ws).includes('agent')) {
      await this.ctx.storage.delete(['last:status', 'last:server_list', LOG_HISTORY_KEY, RESTART_KEY]);
      await this.broadcastToPanels({ type: 'agent_disconnected' });
    }
  }
}
