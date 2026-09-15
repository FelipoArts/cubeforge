// ============================================================
// Testes do Worker (API Central)
// ============================================================
// Roda contra um Worker real, isolado, via Miniflare (não é um mock em JS —
// o KV aqui aplica as MESMAS regras do Cloudflare de verdade, incluindo o
// TTL mínimo de 60s — é exatamente esse tipo de teste que teria pego o bug
// do WAKE_COOLDOWN_SECONDS=20 na hora, sem precisar de duas máquinas reais
// pra descobrir em produção). Cada teste começa com storage isolado (ver
// @cloudflare/vitest-pool-workers), então não precisa limpar KV manualmente.
// ============================================================

import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const BASE = "https://example.com";

async function createTestServer(name = "TesteAutomatizado") {
  const res = await SELF.fetch(`${BASE}/api/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, version: "1.20.1", serverType: "vanilla", description: "" }),
  });
  const body = await res.json();
  return { status: res.status, body, shortCode: body?.data?.shortCode as string };
}

describe("/health", () => {
  it("responde 200 sem tocar no KV", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, code: "SUCCESS" });
  });
});

describe("ciclo de vida do servidor", () => {
  it("cria, descobre e remove um servidor", async () => {
    const { status, body, shortCode } = await createTestServer();
    expect(status).toBe(201);
    expect(body.code).toBe("SERVER_CREATED");
    expect(shortCode).toMatch(/^[A-Z0-9]{6}$/);

    const discoverRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    expect(discoverRes.status).toBe(200);
    const discoverBody = await discoverRes.json();
    expect(discoverBody.data.server.shortCode).toBe(shortCode);
    // Sem sessão nenhuma ainda: nem rede nem Minecraft têm status.
    expect(discoverBody.data.session.networkStatus).toBeNull();
    expect(discoverBody.data.session.minecraftStatus).toBeNull();

    const deleteRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    const afterDeleteRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    expect(afterDeleteRes.status).toBe(404);
  });

  it("descobrir um shortCode inexistente dá 404, não 500", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/ZZZZZZ`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("SERVER_NOT_FOUND");
  });

  it("regenera o código, invalidando o antigo", async () => {
    const { shortCode } = await createTestServer();

    const regenRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/regenerate-code`, { method: "POST" });
    expect(regenRes.status).toBe(200);
    const regenBody = await regenRes.json();
    const newShortCode = regenBody.data.shortCode as string;
    expect(newShortCode).not.toBe(shortCode);

    // Código antigo não existe mais.
    const oldRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    expect(oldRes.status).toBe(404);

    // Código novo funciona.
    const newRes = await SELF.fetch(`${BASE}/api/v1/servers/${newShortCode}`);
    expect(newRes.status).toBe(200);
  });
});

describe("heartbeat + wake-on-demand (ver incidente de 2026-09-14/15)", () => {
  it("host manda heartbeat 'sleeping' e não há pedido de despertar por padrão", async () => {
    const { shortCode } = await createTestServer();

    const hbRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "sleeping", currentPlayers: 0 }),
    });
    expect(hbRes.status).toBe(200);
    const hbBody = await hbRes.json();
    expect(hbBody.data.wakeRequested).toBe(false);

    // O status "sleeping" já aparece pro convidado via discover.
    const discoverRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
    const discoverBody = await discoverRes.json();
    expect(discoverBody.data.session.minecraftStatus).toBe("sleeping");
  });

  it("wake -> próxima heartbeat reporta wakeRequested e consome o pedido (não repete na seguinte)", async () => {
    const { shortCode } = await createTestServer();

    // Regressão direta do bug de 2026-09-14: isso já deu 500 em produção
    // (KV PUT com TTL de 20s, abaixo do mínimo de 60s do Cloudflare) — se
    // voltar a acontecer, é aqui que este teste falha.
    const wakeRes = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/wake`, { method: "POST" });
    expect(wakeRes.status).toBe(200);

    const hb1 = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "sleeping" }),
    });
    expect((await hb1.json()).data.wakeRequested).toBe(true);

    // Consumido — a próxima heartbeat não deve mais reportar wakeRequested.
    const hb2 = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "sleeping" }),
    });
    expect((await hb2.json()).data.wakeRequested).toBe(false);
  });

  it("wake logo em seguida (mesmo shortCode) é bloqueado pelo cooldown, não gera 500", async () => {
    const { shortCode } = await createTestServer();

    const first = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/wake`, { method: "POST" });
    expect(first.status).toBe(200);

    const second = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/wake`, { method: "POST" });
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("wake num shortCode que não existe dá 404, não 500", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/servers/ZZZZZZ/wake`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("descoberta NÃO tem custo de escrita/rate-limit (guest pode fazer polling frequente)", async () => {
    // Regressão do incidente de escrita excessiva no KV: até pouco tempo
    // atrás, cada chamada de descoberta escrevia no KV pra contar o rate
    // limit — isso sozinho estourou a cota diária de escrita da conta.
    // Descoberta hoje é só leitura; bem mais que DISCOVER_RATE_LIMIT (antigo,
    // já removido) de chamadas seguidas não deve travar em 429 nunca.
    const { shortCode } = await createTestServer();
    for (let i = 0; i < 80; i++) {
      const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}`);
      expect(res.status).toBe(200);
    }
  });

  it("wake tem rate limit por IP, além do cooldown por shortCode", async () => {
    // Usa um shortCode por chamada pra isolar o limite por IP do cooldown
    // por shortCode (testado separadamente acima).
    const ip = "203.0.113.50";
    let sawRateLimited = false;
    for (let i = 0; i < 15; i++) {
      const { shortCode } = await createTestServer(`WakeRL${i}`);
      const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/wake`, {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
      });
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(sawRateLimited).toBe(true);
  });

  it("regenerar código tem rate limit por IP", async () => {
    const { shortCode } = await createTestServer();
    const ip = "203.0.113.51";
    let sawRateLimited = false;
    for (let i = 0; i < 10; i++) {
      const res = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/regenerate-code`, {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
      });
      // Depois da primeira, o shortCode já mudou — 404 é esperado nas
      // próximas, mas o rate limit é checado ANTES do handler rodar, então
      // 429 continua aparecendo independente disso.
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
