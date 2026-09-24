// ============================================================
// Detecção de lag/trava (baseado em regras, sem IA)
// ============================================================
// O próprio Minecraft já avisa quando está lento ("Can't keep up! Is the
// server overloaded?") ou quando o Watchdog detecta uma trava grave numa
// tick — não precisamos de RCON/heartbeat ativo pra pegar isso, basta
// observar o stream de log já emitido pelo evento `minecraft-log`
// (ver src/app/page.tsx).
//
// `createLagMonitor()` mantém um pequeno estado por servidor rodando
// (janela deslizante de ocorrências + debounce) para não floodar a Central
// de Diagnósticos a cada linha — deve ser recriado a cada novo start.
// ============================================================

import { t } from "@/i18n";

export interface LagDiagnostic {
  level: "warning" | "error";
  title: string;
  message: string;
}

interface LagMonitorOptions {
  /** Janela usada para contar quantas vezes o aviso apareceu recentemente. */
  windowMs?: number;
  /** Intervalo mínimo entre diagnósticos não-severos, pra não floodar o usuário. */
  minIntervalMs?: number;
  /** A partir de quantos ms atrás o lag é tratado como severo (nível "error"). */
  severeMsThreshold?: number;
}

const CANT_KEEP_UP = /Can't keep up! Is the server overloaded\? Running (\d+)\s*ms or (\d+)\s*ticks behind/i;
const WATCHDOG = /A single server tick took|Server thread dumped/i;

export function createLagMonitor(options: LagMonitorOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const minIntervalMs = options.minIntervalMs ?? 120_000;
  const severeMsThreshold = options.severeMsThreshold ?? 5000;

  let occurrences: number[] = [];
  let lastPushedAt = 0;
  let lastWatchdogAt = 0;

  function reset() {
    occurrences = [];
    lastPushedAt = 0;
    lastWatchdogAt = 0;
  }

  function ingestLine(line: string): LagDiagnostic | null {
    const now = Date.now();

    // Watchdog isolado no meio do log (fora de um crash) é o sinal mais forte
    // de trava real — reporta quase sempre, só evita duplicar a mesma linha.
    if (WATCHDOG.test(line)) {
      if (now - lastWatchdogAt < 5000) return null;
      lastWatchdogAt = now;
      lastPushedAt = now;
      return {
        level: "error",
        title: t("lag.watchdog.title"),
        message: t("lag.watchdog.message"),
      };
    }

    const match = line.match(CANT_KEEP_UP);
    if (!match) return null;

    occurrences.push(now);
    occurrences = occurrences.filter((t) => now - t <= windowMs);

    const ms = parseInt(match[1], 10) || 0;
    const severe = ms >= severeMsThreshold;

    // Avisos leves respeitam o debounce; severos sempre passam (mas sem repetir toda linha).
    if (!severe && now - lastPushedAt < minIntervalMs) return null;
    lastPushedAt = now;

    const count = occurrences.length;
    return severe
      ? {
          level: "error",
          title: t("lag.severe.title"),
          message: t("lag.severe.message", { ms }),
        }
      : {
          level: "warning",
          title: t("lag.mild.title"),
          message: t("lag.mild.message", { count }),
        };
  }

  return { ingestLine, reset };
}
