import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const pushDiagnosticMock = vi.fn();
vi.mock("@/app/diagnostics", () => ({
  pushDiagnostic: (...args: unknown[]) => pushDiagnosticMock(...args),
}));

// Importado depois dos mocks acima (autoBackup.ts importa invoke/pushDiagnostic no topo).
const { maybeBackupWorld } = await import("@/lib/autoBackup");

// Cada teste usa um serverDir próprio: o módulo guarda estado (último mtime
// já salvo, "backup em andamento") em Maps no nível do módulo, que persistem
// entre testes deste arquivo — paths distintos evitam um teste contaminar o
// outro sem precisar resetar módulos a cada `it`.
let counter = 0;
function freshDir(): string {
  counter += 1;
  return `/fake/server-${counter}`;
}

function mockInvokeImpl(handlers: Record<string, (args: any) => unknown>) {
  invokeMock.mockImplementation((cmd: string, args: any) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`comando não mockado: ${cmd}`);
    return Promise.resolve(handler(args));
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  pushDiagnosticMock.mockReset();
});

describe("maybeBackupWorld", () => {
  it("não faz nada quando o backup automático está desabilitado", async () => {
    const dir = freshDir();
    await maybeBackupWorld(dir, "stop", { enabled: false, retentionCount: 10 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("não faz nada sem serverDir", async () => {
    await maybeBackupWorld("", "stop", { enabled: true, retentionCount: 10 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("pula o backup quando o mundo ainda não existe (world_last_modified null)", async () => {
    const dir = freshDir();
    mockInvokeImpl({ world_last_modified: () => null });

    await maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 10 });

    expect(invokeMock).toHaveBeenCalledWith("world_last_modified", { serverDir: dir });
    expect(invokeMock).not.toHaveBeenCalledWith("backup_world", expect.anything());
  });

  it("faz backup e avisa (info) quando dá certo", async () => {
    const dir = freshDir();
    mockInvokeImpl({
      world_last_modified: () => "2026-01-01T00:00:00Z",
      backup_world: () => ({ file_name: "world_x.zip", size_bytes: 100, created_at: "2026-01-01T00:00:00Z" }),
      list_world_backups: () => [],
    });

    await maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 10 });

    expect(invokeMock).toHaveBeenCalledWith("backup_world", { serverDir: dir });
    expect(pushDiagnosticMock).toHaveBeenCalledWith(expect.objectContaining({ level: "info" }));
  });

  it("pula backup repetido quando nada mudou desde o último (mesmo mtime)", async () => {
    const dir = freshDir();
    mockInvokeImpl({
      world_last_modified: () => "2026-01-01T00:00:00Z",
      backup_world: () => ({ file_name: "world_x.zip", size_bytes: 100, created_at: "2026-01-01T00:00:00Z" }),
      list_world_backups: () => [],
    });

    await maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 10 });
    invokeMock.mockClear();

    await maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 10 });
    expect(invokeMock).toHaveBeenCalledWith("world_last_modified", { serverDir: dir });
    expect(invokeMock).not.toHaveBeenCalledWith("backup_world", expect.anything());
  });

  it("sempre tenta backup em caso de crash, mesmo com o mesmo mtime", async () => {
    const dir = freshDir();
    mockInvokeImpl({
      world_last_modified: () => "2026-01-01T00:00:00Z",
      backup_world: () => ({ file_name: "world_x.zip", size_bytes: 100, created_at: "2026-01-01T00:00:00Z" }),
      list_world_backups: () => [],
    });

    await maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 10 });
    invokeMock.mockClear();

    await maybeBackupWorld(dir, "crash", { enabled: true, retentionCount: 10 });
    expect(invokeMock).toHaveBeenCalledWith("backup_world", { serverDir: dir });
  });

  it("avisa (warning) e não poda backups quando backup_world falha", async () => {
    const dir = freshDir();
    mockInvokeImpl({
      world_last_modified: () => "2026-01-01T00:00:00Z",
      backup_world: () => {
        throw new Error("disco cheio");
      },
    });

    await maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 10 });

    expect(pushDiagnosticMock).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
    expect(invokeMock).not.toHaveBeenCalledWith("list_world_backups", expect.anything());
  });

  it("poda backups além do limite de retenção após um backup bem-sucedido", async () => {
    const dir = freshDir();
    const existingBackups = Array.from({ length: 5 }, (_, i) => ({
      file_name: `world_${i}.zip`,
      size_bytes: 10,
      created_at: `2026-01-0${i + 1}T00:00:00Z`,
    }));
    mockInvokeImpl({
      world_last_modified: () => "2026-01-06T00:00:00Z",
      backup_world: () => ({ file_name: "world_novo.zip", size_bytes: 10, created_at: "2026-01-06T00:00:00Z" }),
      list_world_backups: () => existingBackups,
      delete_world_backup: () => undefined,
    });

    await maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 3 });

    // Mantém os 3 primeiros (mais novos, já vem ordenado assim do backend),
    // apaga os 2 excedentes.
    expect(invokeMock).toHaveBeenCalledWith("delete_world_backup", { serverDir: dir, fileName: "world_3.zip" });
    expect(invokeMock).toHaveBeenCalledWith("delete_world_backup", { serverDir: dir, fileName: "world_4.zip" });
    expect(invokeMock).not.toHaveBeenCalledWith("delete_world_backup", { serverDir: dir, fileName: "world_0.zip" });
  });

  it("retentionCount <= 0 desativa a poda (não apaga nada)", async () => {
    const dir = freshDir();
    mockInvokeImpl({
      world_last_modified: () => "2026-01-01T00:00:00Z",
      backup_world: () => ({ file_name: "world_novo.zip", size_bytes: 10, created_at: "2026-01-01T00:00:00Z" }),
    });

    await maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 0 });
    expect(invokeMock).not.toHaveBeenCalledWith("list_world_backups", expect.anything());
  });

  it("não roda dois backups do mesmo servidor em paralelo (guarda inFlight)", async () => {
    const dir = freshDir();
    let resolveWorldLastModified: (v: string) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "world_last_modified") {
        return new Promise((resolve) => {
          resolveWorldLastModified = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const first = maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 10 });
    const second = maybeBackupWorld(dir, "stop", { enabled: true, retentionCount: 10 });

    // A 2ª chamada deveria ter voltado sem sequer chamar invoke, já que a 1ª
    // ainda está "em voo" (esperando world_last_modified resolver).
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveWorldLastModified!(null as unknown as string);
    await Promise.all([first, second]);
  });
});
