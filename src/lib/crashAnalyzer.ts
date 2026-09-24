// ============================================================
// Analisador de causa de crash (baseado em regras, sem IA)
// ============================================================
// Recebe o texto bruto de um crash-report do Minecraft/Forge (ou, na
// ausência de um, a cauda de logs/latest.log — ver `crashReportText` no
// evento `mc-diagnostic` emitido por src-tauri/src/lib.rs) e tenta
// reconhecer padrões conhecidos para explicar a causa no idioma da interface.
//
// Isso complementa `detect_known_mc_error` (Rust), que só olha UMA linha de
// stdout por vez — aqui temos o texto inteiro do crash, o que permite
// reconhecer padrões que só aparecem combinados (ex: nome do mod + "requires
// version" em linhas próximas).
//
// Se nenhuma regra bater, retorna `null` e o chamador cai no texto genérico
// já fornecido pelo Rust (`unknown_crash`).
//
// A regra de OOM recebe também o retrato de RAM real da máquina (ver
// resourceDiagnostics.ts) para diferenciar "aumente a RAM alocada" (o PC tem
// de sobra) de "o computador não tem RAM suficiente" (upgrade de hardware).
// ============================================================

import { explainRamAllocation, type ResourceSnapshot } from "@/lib/resourceDiagnostics";
import { t, type TKey } from "@/i18n";

export interface CrashAnalysis {
  code: string;
  title: string;
  message: string;
}

interface CrashRule {
  code: string;
  title: TKey;
  test: (text: string) => boolean;
  build: (text: string, resources: ResourceSnapshot) => string;
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[1]?.trim() ?? null : null;
}

const RULES: CrashRule[] = [
  {
    code: "watchdog_hang",
    title: "crash.watchdog.title",
    test: (t) => /A single server tick took|Server thread dumped|did not respond to the shutdown/i.test(t),
    build: () => t("crash.watchdog.message"),
  },
  {
    code: "duplicate_mod_id",
    title: "crash.duplicateMod.title",
    test: (t) => /Duplicate mod id|Multiple entries with same key/i.test(t),
    build: (text) => {
      const modId = firstMatch(text, /Duplicate mod id ["'“]?([\w.\-]+)["'”]?/i);
      return modId ? t("crash.duplicateMod.withId", { modId }) : t("crash.duplicateMod.noId");
    },
  },
  {
    code: "missing_mod_dependency",
    title: "crash.missingDep.title",
    test: (t) => /Missing or unsupported mandatory dependencies|requires \[?[\w.\- ]+\]? .*but (it|that) (was not found|is missing)/i.test(t),
    build: (text) => {
      const dep = firstMatch(text, /mod ["'“]?([\w.\- ]+)["'”]? requires/i) ?? firstMatch(text, /requires \[?([\w.\- ]+)\]?/i);
      return dep ? t("crash.missingDep.withName", { dep }) : t("crash.missingDep.noName");
    },
  },
  {
    code: "mixin_conflict",
    title: "crash.mixin.title",
    test: (t) => /mixin apply failed|MixinApplicatorStandard|mixin transformation.*failed/i.test(t),
    build: () => t("crash.mixin.message"),
  },
  {
    code: "corrupted_world",
    title: "crash.corruptedWorld.title",
    test: (t) => /RegionFileException|ChunkPos.*IOException|Failed to save chunk|corrupt(ed)? (region|chunk)/i.test(t),
    build: () => t("crash.corruptedWorld.message"),
  },
  {
    code: "version_mismatch",
    title: "crash.versionMismatch.title",
    test: (t) => /(NoSuchMethodError|NoClassDefFoundError)[\s\S]{0,300}(net\.minecraft|net\.minecraftforge|net\.neoforged)/i.test(t),
    build: () => t("crash.versionMismatch.message"),
  },
  {
    code: "out_of_memory_report",
    title: "crash.oom.title",
    test: (t) => /OutOfMemoryError|Could not reserve enough space/i.test(t),
    build: (_t, resources) => explainRamAllocation(resources),
  },
];

/**
 * Analisa o texto de um crash-report (ou cauda de latest.log) e retorna a
 * causa mais provável, ou `null` se nenhuma regra reconhecida bater.
 * `resources` (opcional) é o retrato de RAM/CPU da máquina no momento do
 * crash — hoje só a regra de OOM usa, para uma recomendação mais precisa.
 */
export function analyzeCrashText(text: string | null | undefined, resources: ResourceSnapshot = {}): CrashAnalysis | null {
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.test(text)) {
      return { code: rule.code, title: t(rule.title), message: rule.build(text, resources) };
    }
  }
  return null;
}
