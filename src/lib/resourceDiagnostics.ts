// ============================================================
// Diagnóstico de hardware (RAM/CPU real da máquina)
// ============================================================
// Complementa crashAnalyzer.ts e lagDetector.ts com o retrato real de RAM/CPU
// do computador (amostrado no Rust via `sysinfo`, evento "mc-resource-sample"
// e campo `resourceSnapshot` do evento "mc-diagnostic" — ver src-tauri/src/lib.rs).
// Isso permite diferenciar, por exemplo, "pouca RAM alocada mas o PC tem de
// sobra → aumentar alocação" de "o PC não tem RAM suficiente → upgrade".
//
// Os limiares abaixo são heurísticas razoáveis, não valores exatos — dá pra
// ajustar depois com uso real sem mexer no resto do código.
// ============================================================

import { t } from "@/i18n";

export interface ResourceSnapshot {
  totalRamMb?: number;
  availableRamMb?: number;
  cpuUsagePercent?: number;
  allocatedRamMb?: number;
}

export interface ResourceDiagnostic {
  level: "warning" | "error";
  title: string;
  message: string;
}

const OS_RESERVED_RAM_MB = 2048; // reserva para SO/outros programas ao sugerir um teto de alocação
const MIN_HEADROOM_MB = 512; // folga mínima entre alocado e o teto recomendado para sugerir aumento
const HIGH_CPU_THRESHOLD = 85; // uso de CPU (%) considerado gargalo no momento do lag
const LOW_FREE_RAM_RATIO = 0.10; // RAM livre do sistema abaixo disso = "apertada"
const SUSTAINED_HIGH_CPU_THRESHOLD = 90; // uso de CPU (%) considerado pressão sustentada
const SUSTAINED_LOW_FREE_RAM_RATIO = 0.05; // RAM livre abaixo disso, sustentado = alerta proativo
const SUSTAINED_SAMPLES_REQUIRED = 3; // amostras seguidas (~45s com o intervalo de 15s do Rust)

function formatGb(mb: number): string {
  return (mb / 1024).toFixed(1).replace(/\.0$/, "");
}

/**
 * Mensagem para a regra de OOM do crashAnalyzer — usa o retrato real de RAM
 * (se disponível) para sugerir "aumentar alocação" ou "faltou RAM no PC".
 */
export function explainRamAllocation(snapshot: ResourceSnapshot): string {
  const { totalRamMb, allocatedRamMb } = snapshot;
  if (!totalRamMb || !allocatedRamMb) {
    return t("res.oom.generic");
  }

  const recommendedMaxMb = totalRamMb - OS_RESERVED_RAM_MB;
  const headroomMb = recommendedMaxMb - allocatedRamMb;

  if (headroomMb >= MIN_HEADROOM_MB) {
    return t("res.oom.headroom", { allocated: formatGb(allocatedRamMb), total: formatGb(totalRamMb), max: formatGb(recommendedMaxMb) });
  }

  return t("res.oom.tight", { total: formatGb(totalRamMb), allocated: formatGb(allocatedRamMb) });
}

/**
 * Sentença extra anexada ao aviso de lag, apontando se o gargalo aparente é
 * CPU, RAM do sistema, ou nenhum dos dois (nesse caso, provavelmente um
 * mod/plugin específico ou excesso de jogadores/entidades).
 */
export function explainResourceBottleneck(snapshot: ResourceSnapshot | null): string | null {
  if (!snapshot) return null;
  const { cpuUsagePercent, totalRamMb, availableRamMb } = snapshot;

  if (cpuUsagePercent !== undefined && cpuUsagePercent >= HIGH_CPU_THRESHOLD) {
    return t("res.bottleneck.cpu", { percent: Math.round(cpuUsagePercent) });
  }

  if (totalRamMb && availableRamMb !== undefined && totalRamMb > 0 && availableRamMb / totalRamMb < LOW_FREE_RAM_RATIO) {
    return t("res.bottleneck.ram", { free: formatGb(availableRamMb), total: formatGb(totalRamMb) });
  }

  return t("res.bottleneck.none");
}

/**
 * Detecta pressão SUSTENTADA de CPU/RAM (várias amostras seguidas) para
 * avisar o usuário antes mesmo de o Minecraft acusar lag no log — igual ao
 * padrão de createLagMonitor() em lagDetector.ts.
 */
export function createResourceMonitor() {
  let cpuStreak = 0;
  let ramStreak = 0;
  let lastPushedAt = 0;
  const minIntervalMs = 120_000;

  function reset() {
    cpuStreak = 0;
    ramStreak = 0;
    lastPushedAt = 0;
  }

  function ingestSample(sample: ResourceSnapshot): ResourceDiagnostic | null {
    const cpuHigh = sample.cpuUsagePercent !== undefined && sample.cpuUsagePercent >= SUSTAINED_HIGH_CPU_THRESHOLD;
    const ramLow = !!sample.totalRamMb && sample.availableRamMb !== undefined
      && sample.availableRamMb / sample.totalRamMb < SUSTAINED_LOW_FREE_RAM_RATIO;

    cpuStreak = cpuHigh ? cpuStreak + 1 : 0;
    ramStreak = ramLow ? ramStreak + 1 : 0;

    const now = Date.now();
    if (now - lastPushedAt < minIntervalMs) return null;

    if (cpuStreak >= SUSTAINED_SAMPLES_REQUIRED) {
      lastPushedAt = now;
      return {
        level: "warning",
        title: t("res.sustainedCpu.title"),
        message: t("res.sustainedCpu.message", { threshold: SUSTAINED_HIGH_CPU_THRESHOLD }),
      };
    }
    if (ramStreak >= SUSTAINED_SAMPLES_REQUIRED) {
      lastPushedAt = now;
      return {
        level: "warning",
        title: t("res.sustainedRam.title"),
        message: t("res.sustainedRam.message"),
      };
    }
    return null;
  }

  return { ingestSample, reset };
}
