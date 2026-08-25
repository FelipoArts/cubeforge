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
    return "O servidor ficou sem memória (RAM) durante a execução. Aumente a RAM alocada nas configurações do servidor, ou feche outros programas para liberar memória no computador.";
  }

  const recommendedMaxMb = totalRamMb - OS_RESERVED_RAM_MB;
  const headroomMb = recommendedMaxMb - allocatedRamMb;

  if (headroomMb >= MIN_HEADROOM_MB) {
    return `O servidor ficou sem memória, mas seu computador tem RAM de sobra: você alocou ${formatGb(allocatedRamMb)}GB, e o computador tem ${formatGb(totalRamMb)}GB no total. Pode aumentar a RAM alocada nas configurações do servidor com segurança até uns ${formatGb(recommendedMaxMb)}GB.`;
  }

  return `O servidor ficou sem memória, e seu computador só tem ${formatGb(totalRamMb)}GB de RAM no total — já não sobra muita folga além do que está alocado (${formatGb(allocatedRamMb)}GB). Considere reduzir a quantidade de mods/jogadores, diminuir um pouco a RAM alocada para dar mais folga ao sistema, ou fazer um upgrade de RAM no computador.`;
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
    return `O processador do computador está no limite (${Math.round(cpuUsagePercent)}% de uso) — esse é provavelmente o gargalo. Considere reduzir a distância de renderização (view-distance), remover mods pesados, ou fazer upgrade do processador.`;
  }

  if (totalRamMb && availableRamMb !== undefined && totalRamMb > 0 && availableRamMb / totalRamMb < LOW_FREE_RAM_RATIO) {
    return `A memória do computador está quase toda ocupada (só ${formatGb(availableRamMb)}GB livres de ${formatGb(totalRamMb)}GB). Considere reduzir a RAM alocada para o servidor, fechar outros programas, ou aumentar a RAM do computador.`;
  }

  return "O processador e a memória do computador não parecem estar no limite — o lag provavelmente vem de um mod/plugin específico, ou de muitos jogadores/entidades carregados ao mesmo tempo.";
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
        title: "Processador sob pressão sustentada",
        message: `O processador do computador está acima de ${SUSTAINED_HIGH_CPU_THRESHOLD}% de uso há alguns minutos, mesmo sem o Minecraft ter acusado lag ainda. Isso costuma anteceder travamentos — considere reduzir mods pesados/jogadores, ou de olho se isso persistir.`,
      };
    }
    if (ramStreak >= SUSTAINED_SAMPLES_REQUIRED) {
      lastPushedAt = now;
      return {
        level: "warning",
        title: "Memória do computador sob pressão sustentada",
        message: "A memória RAM do computador está quase toda ocupada há alguns minutos. Considere reduzir a RAM alocada para o servidor ou fechar outros programas antes que isso vire uma queda por falta de memória.",
      };
    }
    return null;
  }

  return { ingestSample, reset };
}
