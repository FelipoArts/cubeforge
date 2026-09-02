import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  explainRamAllocation,
  explainResourceBottleneck,
  createResourceMonitor,
} from "@/lib/resourceDiagnostics";

describe("explainRamAllocation", () => {
  it("usa mensagem genérica quando não tem dados de RAM", () => {
    expect(explainRamAllocation({})).toContain("Aumente a RAM alocada");
  });

  it("sugere aumentar alocação quando o PC tem RAM de sobra", () => {
    const msg = explainRamAllocation({ totalRamMb: 16000, allocatedRamMb: 4096 });
    expect(msg).toContain("RAM de sobra");
    expect(msg).toContain("4GB"); // GB alocado formatado (4096MB -> "4GB", sem ".0" sobrando)
  });

  it("sugere reduzir/upgrade quando não há folga de RAM no PC", () => {
    const msg = explainRamAllocation({ totalRamMb: 8000, allocatedRamMb: 7000 });
    expect(msg).toContain("upgrade de RAM");
  });
});

describe("explainResourceBottleneck", () => {
  it("retorna null sem snapshot", () => {
    expect(explainResourceBottleneck(null)).toBeNull();
  });

  it("aponta CPU como gargalo quando uso está alto", () => {
    const msg = explainResourceBottleneck({ cpuUsagePercent: 92 });
    expect(msg).toContain("processador");
    expect(msg).toContain("92%");
  });

  it("aponta RAM do sistema como gargalo quando pouca sobra", () => {
    const msg = explainResourceBottleneck({ totalRamMb: 16000, availableRamMb: 500 });
    expect(msg).toContain("memória");
  });

  it("cai no texto genérico quando nada está no limite", () => {
    const msg = explainResourceBottleneck({ cpuUsagePercent: 10, totalRamMb: 16000, availableRamMb: 8000 });
    expect(msg).toContain("mod/plugin específico");
  });

  it("prioriza CPU sobre RAM quando ambos estão no limite", () => {
    const msg = explainResourceBottleneck({ cpuUsagePercent: 95, totalRamMb: 16000, availableRamMb: 100 });
    expect(msg).toContain("processador");
  });
});

describe("createResourceMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Começa bem depois de t=0: o debounce interno compara com lastPushedAt
    // (que também começa em 0), e um "agora" próximo de zero bloquearia até
    // o primeiro diagnóstico por engano. Valor real de Date.now() nunca fica
    // perto de zero, então isso só deixa o teste mais realista.
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("não dispara nada com poucas amostras ruins isoladas", () => {
    const monitor = createResourceMonitor();
    expect(monitor.ingestSample({ cpuUsagePercent: 95 })).toBeNull();
    expect(monitor.ingestSample({ cpuUsagePercent: 95 })).toBeNull();
  });

  it("dispara aviso de CPU após atingir o streak sustentado", () => {
    const monitor = createResourceMonitor();
    expect(monitor.ingestSample({ cpuUsagePercent: 95 })).toBeNull();
    expect(monitor.ingestSample({ cpuUsagePercent: 95 })).toBeNull();
    const result = monitor.ingestSample({ cpuUsagePercent: 95 });
    expect(result?.title).toContain("Processador");
  });

  it("quebra o streak quando uma amostra volta ao normal", () => {
    const monitor = createResourceMonitor();
    monitor.ingestSample({ cpuUsagePercent: 95 });
    monitor.ingestSample({ cpuUsagePercent: 95 });
    monitor.ingestSample({ cpuUsagePercent: 10 }); // quebra o streak
    const result = monitor.ingestSample({ cpuUsagePercent: 95 });
    expect(result).toBeNull(); // streak reiniciou, ainda não atingiu 3 de novo
  });

  it("respeita o intervalo mínimo entre diagnósticos", () => {
    const monitor = createResourceMonitor();
    monitor.ingestSample({ cpuUsagePercent: 95 });
    monitor.ingestSample({ cpuUsagePercent: 95 });
    const first = monitor.ingestSample({ cpuUsagePercent: 95 });
    expect(first).not.toBeNull();

    // Mesmo continuando ruim, não deveria disparar de novo antes do intervalo mínimo.
    const tooSoon = monitor.ingestSample({ cpuUsagePercent: 95 });
    expect(tooSoon).toBeNull();
  });

  it("reset() zera os streaks e o debounce", () => {
    const monitor = createResourceMonitor();
    monitor.ingestSample({ cpuUsagePercent: 95 });
    monitor.ingestSample({ cpuUsagePercent: 95 });
    monitor.reset();
    // Depois do reset, precisa de 3 amostras de novo antes de disparar.
    expect(monitor.ingestSample({ cpuUsagePercent: 95 })).toBeNull();
    expect(monitor.ingestSample({ cpuUsagePercent: 95 })).toBeNull();
    expect(monitor.ingestSample({ cpuUsagePercent: 95 })).not.toBeNull();
  });
});
