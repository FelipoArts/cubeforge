import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLagMonitor } from "@/lib/lagDetector";

const LIGHT_LAG = "Can't keep up! Is the server overloaded? Running 2500ms or 50 ticks behind";
const SEVERE_LAG = "Can't keep up! Is the server overloaded? Running 8000ms or 160 ticks behind";
const WATCHDOG_LINE = "A single server tick took 60.00 seconds";

describe("createLagMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Igual ao resourceDiagnostics.test.ts: começa longe de zero pra não
    // confundir o debounce interno (que compara com um "último disparo" que
    // também começa em zero).
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignora linhas sem relação com lag", () => {
    const monitor = createLagMonitor();
    expect(monitor.ingestLine("[Server thread/INFO]: Steve joined the game")).toBeNull();
  });

  it("detecta lag leve na primeira ocorrência", () => {
    const monitor = createLagMonitor();
    const result = monitor.ingestLine(LIGHT_LAG);
    expect(result?.level).toBe("warning");
    expect(result?.title).toBe("Servidor com lag");
  });

  it("detecta lag severo imediatamente, sem respeitar o debounce", () => {
    const monitor = createLagMonitor();
    const first = monitor.ingestLine(SEVERE_LAG);
    expect(first?.level).toBe("error");

    // Severo ignora o debounce — dispara de novo mesmo sem avançar o tempo.
    const second = monitor.ingestLine(SEVERE_LAG);
    expect(second?.level).toBe("error");
  });

  it("respeita o debounce entre avisos leves consecutivos", () => {
    const monitor = createLagMonitor();
    expect(monitor.ingestLine(LIGHT_LAG)).not.toBeNull();
    // Mesmo "agora": ainda dentro do intervalo mínimo (120s por padrão).
    expect(monitor.ingestLine(LIGHT_LAG)).toBeNull();

    vi.advanceTimersByTime(120_001);
    expect(monitor.ingestLine(LIGHT_LAG)).not.toBeNull();
  });

  it("conta ocorrências acumuladas (dentro da janela de 60s) mesmo enquanto suprimidas pelo debounce", () => {
    const monitor = createLagMonitor();
    // t=0: dispara (1ª ocorrência, define o debounce de 120s a partir daqui).
    expect(monitor.ingestLine(LIGHT_LAG)).not.toBeNull();

    // t=30s e t=59s: dentro da janela de 60s, mas ainda dentro do debounce
    // de 120s — contam como ocorrência, mas não geram novo relatório.
    vi.advanceTimersByTime(30_000);
    expect(monitor.ingestLine(LIGHT_LAG)).toBeNull();
    vi.advanceTimersByTime(29_000); // agora em t=59s
    expect(monitor.ingestLine(LIGHT_LAG)).toBeNull();

    // t=88s: a ocorrência de t=0 já saiu da janela de 60s (88-0=88s); as de
    // 30s e 59s continuam válidas (58s e 29s atrás, respectivamente).
    vi.advanceTimersByTime(29_000);
    expect(monitor.ingestLine(LIGHT_LAG)).toBeNull();

    // t=120.001s: debounce libera de novo. Só a ocorrência de 88s (32s atrás)
    // e essa nova contam dentro da janela de 60s — as de 0/30/59s já saíram.
    vi.advanceTimersByTime(32_001);
    const result = monitor.ingestLine(LIGHT_LAG);
    expect(result?.message).toContain("2x no último minuto");
  });

  it("descarta ocorrências fora da janela deslizante", () => {
    const monitor = createLagMonitor({ windowMs: 60_000 });
    monitor.ingestLine(LIGHT_LAG);
    vi.advanceTimersByTime(61_000); // sai da janela de 60s
    vi.advanceTimersByTime(120_001 - 61_000); // ainda avança o suficiente pro debounce liberar
    const result = monitor.ingestLine(LIGHT_LAG);
    expect(result?.message).toContain("1x no último minuto");
  });

  it("watchdog dispara imediatamente e não duplica dentro de 5s", () => {
    const monitor = createLagMonitor();
    const first = monitor.ingestLine(WATCHDOG_LINE);
    expect(first?.title).toBe("Servidor travando (Watchdog)");

    const second = monitor.ingestLine(WATCHDOG_LINE);
    expect(second).toBeNull();

    vi.advanceTimersByTime(5001);
    const third = monitor.ingestLine(WATCHDOG_LINE);
    expect(third?.title).toBe("Servidor travando (Watchdog)");
  });

  it("reset() limpa o estado (watchdog volta a disparar sem esperar)", () => {
    const monitor = createLagMonitor();
    monitor.ingestLine(WATCHDOG_LINE);
    monitor.reset();
    const result = monitor.ingestLine(WATCHDOG_LINE);
    expect(result).not.toBeNull();
  });
});
