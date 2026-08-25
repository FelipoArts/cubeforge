// ============================================================
// Analisador de causa de crash (baseado em regras, sem IA)
// ============================================================
// Recebe o texto bruto de um crash-report do Minecraft/Forge (ou, na
// ausência de um, a cauda de logs/latest.log — ver `crashReportText` no
// evento `mc-diagnostic` emitido por src-tauri/src/lib.rs) e tenta
// reconhecer padrões conhecidos para explicar a causa em português.
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

export interface CrashAnalysis {
  code: string;
  title: string;
  message: string;
}

interface CrashRule {
  code: string;
  title: string;
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
    title: "O servidor travou (Watchdog)",
    test: (t) => /A single server tick took|Server thread dumped|did not respond to the shutdown/i.test(t),
    build: () => {
      return "O próprio Minecraft detectou que o servidor ficou travado (o \"Watchdog\") e forçou o encerramento. " +
        "Isso normalmente é causado por um mod ou plugin preso em um loop infinito, uma consulta pesada demais (ex: geração de terreno ou pathfinding em massa), ou disco/rede muito lentos. " +
        "Veja nos detalhes técnicos qual thread ficou presa — o nome do mod geralmente aparece no stack trace.";
    },
  },
  {
    code: "duplicate_mod_id",
    title: "Dois mods com o mesmo ID instalados",
    test: (t) => /Duplicate mod id|Multiple entries with same key/i.test(t),
    build: (t) => {
      const modId = firstMatch(t, /Duplicate mod id ["'“]?([\w.\-]+)["'”]?/i);
      return modId
        ? `Há dois mods diferentes usando o mesmo identificador ("${modId}") — provavelmente uma versão duplicada do mesmo mod (ex: baixado duas vezes, ou uma cópia dentro de outro mod). Remova a cópia extra da pasta mods/.`
        : "Há dois mods diferentes usando o mesmo identificador interno. Provavelmente é uma versão duplicada do mesmo mod (baixada duas vezes, ou embutida dentro de outro mod). Revise a pasta mods/ por arquivos repetidos.";
    },
  },
  {
    code: "missing_mod_dependency",
    title: "Falta um mod ou biblioteca exigida por outro mod",
    test: (t) => /Missing or unsupported mandatory dependencies|requires \[?[\w.\- ]+\]? .*but (it|that) (was not found|is missing)/i.test(t),
    build: (t) => {
      const dep = firstMatch(t, /mod ["'“]?([\w.\- ]+)["'”]? requires/i) ?? firstMatch(t, /requires \[?([\w.\- ]+)\]?/i);
      return dep
        ? `Um mod precisa de "${dep}" para funcionar, mas esse mod/biblioteca não está instalado (ou está em uma versão incompatível). Baixe a dependência que falta e coloque na pasta mods/.`
        : "Um mod depende de outro mod (ou biblioteca) que não está instalado, ou está em uma versão incompatível. Veja nos detalhes técnicos qual dependência falta e instale-a.";
    },
  },
  {
    code: "mixin_conflict",
    title: "Conflito entre mods (mixin)",
    test: (t) => /mixin apply failed|MixinApplicatorStandard|mixin transformation.*failed/i.test(t),
    build: () => {
      return "Dois mods provavelmente estão tentando modificar a mesma parte do código do jogo ao mesmo tempo (um conflito clássico de \"mixin\" no Forge/Fabric). " +
        "Isso costuma acontecer quando dois mods alteram a mesma classe do Minecraft de forma incompatível. Tente identificar qual mod foi instalado por último e removê-lo, ou procure por uma versão mais nova que resolva o conflito.";
    },
  },
  {
    code: "corrupted_world",
    title: "Mundo (world) corrompido",
    test: (t) => /RegionFileException|ChunkPos.*IOException|Failed to save chunk|corrupt(ed)? (region|chunk)/i.test(t),
    build: () => {
      return "Parece que um arquivo do mundo (região/chunk) está corrompido. Isso pode acontecer após uma queda de energia ou um encerramento forçado do servidor durante uma gravação. " +
        "Se você tem um backup do mundo, restaurar a partir dele costuma resolver.";
    },
  },
  {
    code: "version_mismatch",
    title: "Mod incompatível com a versão do Minecraft/Forge",
    test: (t) => /(NoSuchMethodError|NoClassDefFoundError)[\s\S]{0,300}(net\.minecraft|net\.minecraftforge|net\.neoforged)/i.test(t),
    build: () => {
      return "Um mod está chamando algo que não existe nesta versão do Minecraft/Forge — sinal de que ele foi feito para uma versão diferente da instalada no servidor. " +
        "Confira se todos os mods (e o próprio Forge) são compatíveis com a mesma versão do Minecraft.";
    },
  },
  {
    code: "out_of_memory_report",
    title: "Sem memória suficiente (OutOfMemoryError)",
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
      return { code: rule.code, title: rule.title, message: rule.build(text, resources) };
    }
  }
  return null;
}
