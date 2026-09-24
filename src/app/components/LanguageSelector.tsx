"use client";

import { useLanguagePreference, useT, type LanguagePreference } from "@/i18n";
import { cn } from "@/lib/utils";

// Seletor de idioma da interface: Automático (segue o sistema) / Português / English.
// `compact` é a versão em linha usada no onboarding; a padrão é a de Configurações.
export function LanguageSelector({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const [pref, setPref] = useLanguagePreference();

  const options: { value: LanguagePreference; label: string }[] = [
    { value: "auto", label: t("language.auto") },
    { value: "pt-BR", label: t("language.ptBR") },
    { value: "en", label: t("language.en") },
  ];

  return (
    <div className={compact ? "" : "space-y-1.5"}>
      {!compact && (
        <>
          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("language.label")}</label>
          <p className="text-[10px] text-theme-secondary pb-1">{t("language.hint")}</p>
        </>
      )}
      <div
        role="radiogroup"
        aria-label={t("language.label")}
        className={cn("flex flex-wrap gap-2", compact && "justify-center")}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={pref === o.value}
            title={o.value === "auto" ? t("language.autoHint") : undefined}
            onClick={() => setPref(o.value)}
            className={cn(
              "px-3 py-2 rounded-xl border text-xs font-semibold transition-colors cursor-pointer",
              pref === o.value
                ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300"
                : "border-theme-card text-theme-secondary hover:text-theme-primary hover:bg-theme-muted"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
