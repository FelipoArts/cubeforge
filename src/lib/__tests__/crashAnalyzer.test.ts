import { describe, expect, it } from "vitest";
import { analyzeCrashText } from "@/lib/crashAnalyzer";

describe("analyzeCrashText", () => {
  it("retorna null quando não há texto", () => {
    expect(analyzeCrashText(null)).toBeNull();
    expect(analyzeCrashText(undefined)).toBeNull();
    expect(analyzeCrashText("")).toBeNull();
  });

  it("retorna null quando nenhuma regra reconhece o texto", () => {
    expect(analyzeCrashText("[Server thread/INFO]: Done (12.3s)! For help, type \"help\"")).toBeNull();
  });

  it("detecta watchdog hang", () => {
    const result = analyzeCrashText("A single server tick took 60.00 seconds");
    expect(result?.code).toBe("watchdog_hang");
  });

  it("detecta mod id duplicado e extrai o nome do mod", () => {
    const result = analyzeCrashText('Duplicate mod id "examplemod" found');
    expect(result?.code).toBe("duplicate_mod_id");
    expect(result?.message).toContain("examplemod");
  });

  it("detecta mod id duplicado mesmo sem conseguir extrair o nome", () => {
    const result = analyzeCrashText("Multiple entries with same key: foo=1 and foo=2");
    expect(result?.code).toBe("duplicate_mod_id");
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it("detecta dependência de mod faltando", () => {
    const result = analyzeCrashText("Missing or unsupported mandatory dependencies");
    expect(result?.code).toBe("missing_mod_dependency");
  });

  it("detecta conflito de mixin", () => {
    const result = analyzeCrashText("Mixin apply failed onLoadShared");
    expect(result?.code).toBe("mixin_conflict");
  });

  it("detecta mundo corrompido", () => {
    const result = analyzeCrashText("RegionFileException: corrupted region file");
    expect(result?.code).toBe("corrupted_world");
  });

  it("detecta incompatibilidade de versão", () => {
    const result = analyzeCrashText(
      "java.lang.NoSuchMethodError: something.method()\n\tat net.minecraft.server.MinecraftServer.run"
    );
    expect(result?.code).toBe("version_mismatch");
  });

  it("detecta OOM e delega a mensagem pro explicador de RAM", () => {
    const result = analyzeCrashText("java.lang.OutOfMemoryError: Java heap space", {
      totalRamMb: 16000,
      allocatedRamMb: 4096,
    });
    expect(result?.code).toBe("out_of_memory_report");
    expect(result?.message).toContain("RAM de sobra");
  });

  it("a primeira regra que bate vence quando o texto casa com mais de uma", () => {
    // watchdog_hang vem antes de out_of_memory_report na lista de regras.
    const text = "A single server tick took 60 seconds\njava.lang.OutOfMemoryError";
    const result = analyzeCrashText(text);
    expect(result?.code).toBe("watchdog_hang");
  });
});
