// ============================================================
// Testes do Durable Object HostChannel — aplicação das permissões
// ============================================================
// Roda o DO de verdade (Miniflare). O agent real exige validar device_token
// contra o Supabase (rede), então aqui só se exercita o lado do PAINEL: o
// ticket, a mensagem "access" e — o que mais importa — que ações sem
// permissão são negadas NO DO (não dá pra contar com o botão escondido).
// ============================================================

import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { PERMISSION_PRESETS } from "./panel-access";

const BASE = "https://example.com";

function stubFor(deviceId: string) {
  return env.HOST_CHANNEL.get(env.HOST_CHANNEL.idFromName(deviceId));
}

async function mintTicket(deviceId: string, body: object): Promise<string> {
  const resp = await stubFor(deviceId).fetch("https://host-channel.internal/mint-ticket", {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(resp.status).toBe(200);
  return ((await resp.json()) as { ticket: string }).ticket;
}

/** Abre o WebSocket de painel e devolve as mensagens recebidas até agora + helpers. */
async function openPanel(deviceId: string, ticket: string) {
  const resp = await SELF.fetch(`${BASE}/panel/ws/${deviceId}?role=panel&ticket=${ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(resp.status).toBe(101);
  const ws = resp.webSocket!;
  ws.accept();
  const messages: any[] = [];
  const closes: { code: number; reason: string }[] = [];
  ws.addEventListener("message", (e) => { messages.push(JSON.parse(e.data as string)); });
  ws.addEventListener("close", (e) => { closes.push({ code: e.code, reason: e.reason }); });
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(pred()).toBe(true);
  };
  return { ws, messages, closes, waitFor };
}

describe("ticket do painel", () => {
  it("é de uso único", async () => {
    const ticket = await mintTicket("dev-uso-unico", { userId: "u1", name: "Fulano", isOwner: true });
    const first = await SELF.fetch(`${BASE}/panel/ws/dev-uso-unico?role=panel&ticket=${ticket}`, { headers: { Upgrade: "websocket" } });
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    const second = await SELF.fetch(`${BASE}/panel/ws/dev-uso-unico?role=panel&ticket=${ticket}`, { headers: { Upgrade: "websocket" } });
    expect(second.status).toBe(401);
  });

  it("recusa ticket de membro com permissões inválidas", async () => {
    const resp = await stubFor("dev-invalido").fetch("https://host-channel.internal/mint-ticket", {
      method: "POST",
      body: JSON.stringify({ userId: "u1", name: "X", isOwner: false, permissions: { commands: { mode: "tudo" } } }),
    });
    expect(resp.status).toBe(400);
  });
});

describe("mensagem access", () => {
  it("informa as permissões da conexão", async () => {
    const ticket = await mintTicket("dev-access", { userId: "u2", name: "Mod", isOwner: false, permissions: PERMISSION_PRESETS.moderator });
    const panel = await openPanel("dev-access", ticket);
    await panel.waitFor(() => panel.messages.some((m) => m.type === "access"));
    const access = panel.messages.find((m) => m.type === "access");
    expect(access.isOwner).toBe(false);
    expect(access.permissions.commands).toEqual({ mode: "allowlist", allowlist: ["say", "kick", "whitelist"] });
    expect(access.permissions.stop).toBe(false);
  });
});

describe("aplicação de permissões no DO", () => {
  it("nega ligar/desligar/reiniciar/comando sem permissão, com o motivo", async () => {
    const ticket = await mintTicket("dev-negar", { userId: "u3", name: "Visitante", isOwner: false, permissions: PERMISSION_PRESETS.viewer });
    const panel = await openPanel("dev-negar", ticket);
    await panel.waitFor(() => panel.messages.some((m) => m.type === "access"));

    for (const msg of [
      { type: "start_server", serverId: "s1" },
      { type: "stop_server" },
      { type: "restart_server", serverId: "s1" },
      { type: "command", command: "say oi" },
      { type: "format_disk" },
    ]) {
      panel.ws.send(JSON.stringify(msg));
    }
    await panel.waitFor(() => panel.messages.filter((m) => m.type === "error").length === 5);
    const errors = panel.messages.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors[0]).toContain("ligar");
    expect(errors[1]).toContain("desligar");
    expect(errors[2]).toContain("reiniciar");
    expect(errors[3]).toContain("comandos");
    expect(errors[4]).toContain("não suportada");
  });

  it("'stop' no console também é negado sem a permissão de desligar", async () => {
    const ticket = await mintTicket("dev-stop", { userId: "u4", name: "Cmd", isOwner: false, permissions: { ...PERMISSION_PRESETS.viewer, commands: { mode: "all", allowlist: [] } } });
    const panel = await openPanel("dev-stop", ticket);
    await panel.waitFor(() => panel.messages.some((m) => m.type === "access"));
    panel.ws.send(JSON.stringify({ type: "command", command: "/stop" }));
    await panel.waitFor(() => panel.messages.some((m) => m.type === "error"));
    expect(panel.messages.find((m) => m.type === "error").message).toContain("desligar");
  });

  it("comando permitido só falha por falta de agent (não por permissão)", async () => {
    const ticket = await mintTicket("dev-permitido", { userId: "u5", name: "Mod", isOwner: false, permissions: PERMISSION_PRESETS.moderator });
    const panel = await openPanel("dev-permitido", ticket);
    await panel.waitFor(() => panel.messages.some((m) => m.type === "access"));
    panel.ws.send(JSON.stringify({ type: "command", command: "say olá" }));
    await panel.waitFor(() => panel.messages.filter((m) => m.type === "agent_disconnected").length >= 2);
    expect(panel.messages.some((m) => m.type === "error")).toBe(false);
  });

  it("dono não é barrado pelas checagens de membro", async () => {
    const ticket = await mintTicket("dev-dono", { userId: "u6", name: "Dono", isOwner: true });
    const panel = await openPanel("dev-dono", ticket);
    await panel.waitFor(() => panel.messages.some((m) => m.type === "access"));
    expect(panel.messages.find((m) => m.type === "access").isOwner).toBe(true);
    panel.ws.send(JSON.stringify({ type: "stop_server" }));
    await panel.waitFor(() => panel.messages.filter((m) => m.type === "agent_disconnected").length >= 2);
    expect(panel.messages.some((m) => m.type === "error")).toBe(false);
  });
});

describe("remoção/alteração de membro", () => {
  it("kick derruba só as conexões do usuário alvo", async () => {
    const t1 = await mintTicket("dev-kick", { userId: "alvo", name: "Alvo", isOwner: false, permissions: PERMISSION_PRESETS.viewer });
    const t2 = await mintTicket("dev-kick", { userId: "outro", name: "Outro", isOwner: false, permissions: PERMISSION_PRESETS.viewer });
    const alvo = await openPanel("dev-kick", t1);
    const outro = await openPanel("dev-kick", t2);
    await alvo.waitFor(() => alvo.messages.some((m) => m.type === "access"));
    await outro.waitFor(() => outro.messages.some((m) => m.type === "access"));

    const kick = await stubFor("dev-kick").fetch("https://host-channel.internal/kick", {
      method: "POST",
      body: JSON.stringify({ userId: "alvo", removed: true }),
    });
    expect(kick.status).toBe(204);
    await alvo.waitFor(() => alvo.closes.length > 0);
    expect(alvo.closes[0].code).toBe(4001);
    expect(alvo.closes[0].reason).toBe("access-removed");
    expect(outro.closes.length).toBe(0);
  });
});

describe("rotas de acesso compartilhado exigem login", () => {
  it("responde 401 sem sessão", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/panel/devices"],
      ["GET", "/api/v1/panel/devices/abc/members"],
      ["POST", "/api/v1/panel/devices/abc/invites"],
      ["PATCH", "/api/v1/panel/devices/abc/members/def"],
      ["DELETE", "/api/v1/panel/devices/abc/members/def"],
      ["POST", "/api/v1/panel/invites/accept"],
    ] as const) {
      const resp = await SELF.fetch(`${BASE}${path}`, { method, body: method === "GET" ? undefined : "{}" });
      // 401 (sem sessão) ou 503 (sem service role neste ambiente de teste) — nunca 200.
      expect([401, 503]).toContain(resp.status);
    }
  });
});
