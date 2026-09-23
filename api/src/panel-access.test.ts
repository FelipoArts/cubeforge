// ============================================================
// Testes do modelo de permissões do painel compartilhado
// ============================================================
// Lógica pura, sem Worker/KV — é a peça que decide se um membro convidado
// consegue ou não fazer algo no servidor de outra pessoa, então o que mais
// importa aqui é o que fica NEGADO (bypass por "stop" no console, quebra de
// linha, tipo de mensagem desconhecido...).
// ============================================================

import { describe, it, expect } from "vitest";
import {
  authorizePanelMessage,
  generateInviteToken,
  inviteUsable,
  normalizeAllowlistEntry,
  normalizePermissions,
  OWNER_PERMISSIONS,
  PERMISSION_PRESETS,
  type PanelPermissions,
} from "./panel-access";

const perms = (over: Partial<PanelPermissions> = {}): PanelPermissions => ({
  ...PERMISSION_PRESETS.viewer,
  ...over,
});

describe("normalizeAllowlistEntry", () => {
  it("tira a barra inicial, baixa a caixa e colapsa espaços", () => {
    expect(normalizeAllowlistEntry("  /Time   SET ")).toBe("time set");
  });
  it("recusa vazio, não-string, controle e entradas gigantes", () => {
    expect(normalizeAllowlistEntry("")).toBeNull();
    expect(normalizeAllowlistEntry("///")).toBeNull();
    expect(normalizeAllowlistEntry(42)).toBeNull();
    expect(normalizeAllowlistEntry("say\nstop")).toBeNull();
    expect(normalizeAllowlistEntry("a".repeat(61))).toBeNull();
  });
});

describe("normalizePermissions", () => {
  it("aceita os presets como estão", () => {
    for (const p of Object.values(PERMISSION_PRESETS)) {
      expect(normalizePermissions(p)).toEqual(p);
    }
  });
  it("só considera true estrito (string 'true' não vira permissão)", () => {
    const n = normalizePermissions({ viewConsole: "true", start: 1, stop: true, restart: false, commands: { mode: "none" } });
    expect(n).toMatchObject({ viewConsole: false, start: false, stop: true, restart: false });
  });
  it("descarta a whitelist fora do modo allowlist e deduplica dentro dele", () => {
    expect(normalizePermissions({ commands: { mode: "all", allowlist: ["say"] } })?.commands.allowlist).toEqual([]);
    expect(normalizePermissions({ commands: { mode: "allowlist", allowlist: ["Say", "/say", "kick"] } })?.commands.allowlist).toEqual(["say", "kick"]);
  });
  it("recusa modo allowlist vazio, modo desconhecido e entrada inválida", () => {
    expect(normalizePermissions({ commands: { mode: "allowlist", allowlist: [] } })).toBeNull();
    expect(normalizePermissions({ commands: { mode: "tudo" } })).toBeNull();
    expect(normalizePermissions({ commands: { mode: "allowlist", allowlist: ["say", ""] } })).toBeNull();
    expect(normalizePermissions({ commands: { mode: "allowlist", allowlist: Array.from({ length: 41 }, (_, i) => `c${i}`) } })).toBeNull();
    expect(normalizePermissions(null)).toBeNull();
    expect(normalizePermissions({})).toBeNull();
  });
});

describe("authorizePanelMessage — ligar/desligar/reiniciar", () => {
  it("cada ação depende só da própria permissão", () => {
    const onlyStart = perms({ start: true });
    expect(authorizePanelMessage(onlyStart, { type: "start_server", serverId: "abc" }).ok).toBe(true);
    expect(authorizePanelMessage(onlyStart, { type: "stop_server" }).ok).toBe(false);
    expect(authorizePanelMessage(onlyStart, { type: "restart_server", serverId: "abc" }).ok).toBe(false);

    const onlyStop = perms({ stop: true });
    expect(authorizePanelMessage(onlyStop, { type: "stop_server" }).ok).toBe(true);
    expect(authorizePanelMessage(onlyStop, { type: "start_server", serverId: "abc" }).ok).toBe(false);

    const onlyRestart = perms({ restart: true });
    expect(authorizePanelMessage(onlyRestart, { type: "restart_server", serverId: "abc" }).ok).toBe(true);
    expect(authorizePanelMessage(onlyRestart, { type: "stop_server" }).ok).toBe(false);
  });
  it("exige serverId válido para iniciar/reiniciar", () => {
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "start_server" }).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "restart_server", serverId: "" }).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "start_server", serverId: 5 }).ok).toBe(false);
  });
  it("reconstrói a mensagem — campos extras do cliente não passam", () => {
    const d = authorizePanelMessage(OWNER_PERMISSIONS, { type: "start_server", serverId: "abc", by: "falso", extra: 1 });
    expect(d).toEqual({ ok: true, forward: { type: "start_server", serverId: "abc" } });
  });
  it("nega tipos desconhecidos, mesmo para o dono", () => {
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "format_disk" }).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "log_line", line: "x" }).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, "texto").ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, null).ok).toBe(false);
  });
});

describe("authorizePanelMessage — comandos", () => {
  const cmd = (p: PanelPermissions, command: unknown) => authorizePanelMessage(p, { type: "command", command });

  it("modo none nega tudo", () => {
    expect(cmd(perms(), "say oi").ok).toBe(false);
  });
  it("modo all libera qualquer comando (menos stop sem permissão de desligar)", () => {
    const p = perms({ commands: { mode: "all", allowlist: [] } });
    expect(cmd(p, "op fulano").ok).toBe(true);
    expect(cmd(p, "stop").ok).toBe(false);
    expect(cmd(p, "/STOP").ok).toBe(false);
    expect(cmd({ ...p, stop: true }, "stop").ok).toBe(true);
  });
  it("whitelist casa por prefixo de palavras, ignorando barra e caixa", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["say", "time set"] } });
    expect(cmd(p, "say olá mundo").ok).toBe(true);
    expect(cmd(p, "/Say olá").ok).toBe(true);
    expect(cmd(p, "time set day").ok).toBe(true);
    expect(cmd(p, "time add 5").ok).toBe(false);
    expect(cmd(p, "time").ok).toBe(false);
    expect(cmd(p, "op fulano").ok).toBe(false);
  });
  it("prefixo é por palavra inteira, não por texto ('say' não libera 'sayonara')", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["say"] } });
    expect(cmd(p, "sayonara").ok).toBe(false);
  });
  it("'stop' na whitelist continua exigindo a permissão de desligar", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["stop"] } });
    expect(cmd(p, "stop").ok).toBe(false);
    expect(cmd({ ...p, stop: true }, "stop").ok).toBe(true);
  });
  it("recusa quebra de linha (vários comandos numa mensagem só) e controle", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["say"] } });
    expect(cmd(p, "say oi\nstop").ok).toBe(false);
    expect(cmd(p, "say oi\rop eu").ok).toBe(false);
    expect(cmd(OWNER_PERMISSIONS, "say a\u0000b").ok).toBe(false);
  });
  it("recusa vazio, não-string e comando gigante", () => {
    expect(cmd(OWNER_PERMISSIONS, "   ").ok).toBe(false);
    expect(cmd(OWNER_PERMISSIONS, "/").ok).toBe(false);
    expect(cmd(OWNER_PERMISSIONS, 123).ok).toBe(false);
    expect(cmd(OWNER_PERMISSIONS, "say " + "a".repeat(600)).ok).toBe(false);
  });
});

describe("convites", () => {
  it("token é único, longo e seguro para URL", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(30);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("valida expiração e uso único", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(inviteUsable({ single_use: true, uses: 0, expires_at: future }, Date.now())).toBe(true);
    expect(inviteUsable({ single_use: true, uses: 1, expires_at: future }, Date.now())).toBe(false);
    expect(inviteUsable({ single_use: false, uses: 9, expires_at: future }, Date.now())).toBe(true);
    expect(inviteUsable({ single_use: false, uses: 0, expires_at: past }, Date.now())).toBe(false);
  });
});
