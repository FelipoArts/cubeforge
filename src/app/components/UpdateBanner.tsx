"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Download, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUpdaterStore } from "@/app/updater";

// ============================================================
// UpdateBanner
// ============================================================
// Faixa discreta no topo (não-bloqueante, ao contrário de um dialog)
// avisando sobre atualização disponível. Público é não-técnico, então
// o fluxo é "um clique": baixa, instala e reinicia sozinho.
// ============================================================

export function UpdateBanner() {
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const progress = useUpdaterStore((s) => s.progress);
  const dismissed = useUpdaterStore((s) => s.dismissed);
  const installAndRestart = useUpdaterStore((s) => s.installAndRestart);
  const dismiss = useUpdaterStore((s) => s.dismiss);

  const visible = !dismissed && phase !== "idle" && phase !== "checking";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ type: "spring", duration: 0.3 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[110] w-full max-w-md px-4"
        >
          <div className="flex items-center gap-3 p-3 rounded-2xl border border-theme-accent bg-theme-accent shadow-lg backdrop-blur-xl">
            <Download className="w-4.5 h-4.5 flex-shrink-0 text-indigo-700 dark:text-indigo-300" />

            <div className="flex-1 min-w-0">
              {phase === "available" && (
                <p className="text-xs font-medium text-theme-primary">
                  Nova versão disponível{version ? ` (v${version})` : ""}.
                </p>
              )}
              {phase === "downloading" && (
                <p className="text-xs font-medium text-theme-primary">
                  Baixando atualização... {progress}%
                </p>
              )}
              {phase === "ready" && (
                <p className="text-xs font-medium text-theme-primary">Reiniciando...</p>
              )}
              {phase === "error" && (
                <p className="text-xs font-medium text-theme-primary">
                  Falha ao atualizar. Tente novamente mais tarde.
                </p>
              )}
            </div>

            {phase === "available" && (
              <button
                type="button"
                onClick={installAndRestart}
                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors cursor-pointer flex-shrink-0"
              >
                Atualizar e reiniciar
              </button>
            )}

            {phase === "downloading" && (
              <RotateCw className={cn("w-4 h-4 flex-shrink-0 text-theme-secondary animate-spin")} />
            )}

            {(phase === "available" || phase === "error") && (
              <button
                type="button"
                onClick={dismiss}
                className="p-1 rounded-lg hover:bg-theme-muted text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer flex-shrink-0"
                title="Dispensar"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
