// ============================================================
// HostChannel — Durable Object do painel web remoto (Cubicase Plus)
// ============================================================
// Um DO por dispositivo (nome = panel_devices.id, um UUID não-secreto).
// Mantém a conexão WebSocket outbound do app desktop (papel "agent") viva
// via WebSocket Hibernation API (o isolate pode ser evacuado da memória
// entre mensagens sem derrubar a conexão do cliente) e roteia mensagens
// entre ela e quantas conexões de painel web (papel "panel") estiverem
// abertas para o mesmo dispositivo.
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
//   painel -> relay -> agent (Fase 2):
//     { type: "command", command } | { type: "stop_server" } | { type: "start_server", serverId }
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
//     POST /api/v1/panel/ws-ticket (index.ts) e consumido aqui.
// ============================================================

import { SUPABASE_URL, userHasActiveSubscription, type SupabaseEnv } from '../supabase';

interface Env extends SupabaseEnv {}

const TICKET_TTL_MS = 30_000;
const LOG_HISTORY_KEY = 'log_history';
const LOG_HISTORY_MAX = 200;

interface PendingTicket {
  userId: string;
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
      return this.handleMintTicket();
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request, url);
    }

    return new Response('Not found', { status: 404 });
  }

  /** Chamado só pelo próprio Worker (nunca exposto fora dele — Durable Objects não têm URL pública própria). */
  private async handleMintTicket(): Promise<Response> {
    const ticket = crypto.randomUUID();
    const pending: PendingTicket = { userId: '', expiresAt: Date.now() + TICKET_TTL_MS };
    // O userId já foi validado pelo Worker (dono do deviceId) antes de chegar
    // aqui — o ticket só precisa provar "alguém que passou por aquela
    // validação, há poucos segundos, pediu para conectar nesta DO específica".
    // Guardado em ctx.storage (não em memória) porque a DO pode ser evacuada
    // entre o mint e o uso do ticket.
    await this.ctx.storage.put(`ticket:${ticket}`, pending);
    return new Response(JSON.stringify({ ticket }), { headers: { 'Content-Type': 'application/json' } });
  }

  private async consumeTicket(ticket: string): Promise<boolean> {
    const key = `ticket:${ticket}`;
    const pending = await this.ctx.storage.get<PendingTicket>(key);
    await this.ctx.storage.delete(key); // uso único, válido ou não
    if (!pending) return false;
    return Date.now() < pending.expiresAt;
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
      this.broadcastToPanels({ type: 'agent_connected' });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === 'panel') {
      const ticket = url.searchParams.get('ticket');
      if (!ticket || !(await this.consumeTicket(ticket))) {
        return new Response('Ticket inválido ou expirado.', { status: 401 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['panel']);
      const agentConnected = this.ctx.getWebSockets('agent').length > 0;
      try {
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
          for (const line of logHistory ?? []) server.send(line);
        }
      } catch { /* conexão pode já ter caído antes deste send */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('role precisa ser "agent" ou "panel".', { status: 400 });
  }

  private broadcastToPanels(message: unknown): void {
    const body = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets('panel')) {
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
  private async cacheAgentSnapshot(raw: string): Promise<void> {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
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
      // Log/status/lista de servidores do app desktop -> todos os painéis abertos.
      if (typeof message === 'string') {
        await this.cacheAgentSnapshot(message);
        this.broadcastToPanels(JSON.parse(message));
      } else {
        this.broadcastToPanels(message);
      }
      return;
    }
    if (tags.includes('panel')) {
      // Comando do painel -> o único agente conectado (Fase 2 — já roteado
      // desde já, mesmo que a UI do painel ainda não emita nada aqui).
      const agents = this.ctx.getWebSockets('agent');
      if (agents.length > 0) {
        try { agents[0].send(message); } catch { /* ignora — agente pode ter caído */ }
      } else {
        try { ws.send(JSON.stringify({ type: 'agent_disconnected' })); } catch { /* já fechou */ }
      }
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    if (this.ctx.getTags(ws).includes('agent')) {
      await this.ctx.storage.delete(['last:status', 'last:server_list', LOG_HISTORY_KEY]);
      this.broadcastToPanels({ type: 'agent_disconnected' });
    }
    try { ws.close(); } catch { /* já fechado */ }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    if (this.ctx.getTags(ws).includes('agent')) {
      await this.ctx.storage.delete(['last:status', 'last:server_list', LOG_HISTORY_KEY]);
      this.broadcastToPanels({ type: 'agent_disconnected' });
    }
  }
}
