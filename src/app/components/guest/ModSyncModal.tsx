"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, CheckCircle2, XCircle, AlertTriangle, Download, Server, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModSyncEntry, PrepState } from "@/lib/modSync";
import { formatBytes } from "@/lib/modSync";

// ============================================================
// ModSyncModal — confirmação + progresso + relatório final do fluxo
// "Preparar e Jogar" (instalar loader + sincronizar mods antes de abrir o
// launcher). Nunca fecha sozinho e nunca decide continuar sozinho: cada
// transição de fase é um clique explícito do jogador — ver design acordado
// na conversa (clareza total: o que vai acontecer, o que está acontecendo,
// e o que aconteceu, sempre visível, nunca silencioso).
// ============================================================

interface ModSyncModalProps {
  serverName: string;
  state: PrepState;
  onCancel: () => void;
  onConfirm: () => void;
  onRetryAll: () => void;
  onRetryFailedOnly: () => void;
  onContinueAnyway: () => void;
  onOpenMinecraft: () => void;
}

function statusIcon(status: ModSyncEntry["status"]) {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />;
    case "downloading":
      return <Loader2 className="w-3.5 h-3.5 text-indigo-500 shrink-0 animate-spin" />;
    default:
      return <div className="w-3.5 h-3.5 rounded-full border-2 border-theme-card shrink-0" />;
  }
}

export function ModSyncModal({
  serverName,
  state,
  onCancel,
  onConfirm,
  onRetryAll,
  onRetryFailedOnly,
  onContinueAnyway,
  onOpenMinecraft,
}: ModSyncModalProps) {
  const { phase, modEntries } = state;
  const failedEntries = modEntries.filter((e) => e.status === "failed");
  const okCount = modEntries.filter((e) => e.status === "ok").length;
  const modrinthCount = modEntries.filter((e) => e.source === "modrinth").length;
  const meshCount = modEntries.filter((e) => e.source === "mesh").length;
  const canClose = phase === "confirm" || phase === "error" || phase === "done";
  const showFailureFooter = failedEntries.length > 0 && !state.acceptedPartial;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          onClick={() => { if (canClose) onCancel(); }}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ type: "spring", duration: 0.4 }}
          className="relative w-full max-w-md bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-5 max-h-[85vh] overflow-y-auto"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg flex items-center justify-center shrink-0">
                <Download className="text-indigo-700 dark:text-indigo-300 w-4 h-4" />
              </div>
              <h3 className="text-lg font-bold text-theme-primary truncate">Preparar {serverName}</h3>
            </div>
            {canClose && (
              <button
                type="button"
                onClick={onCancel}
                className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* ---------- Checando ---------- */}
          {phase === "checking" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
              <p className="text-sm text-theme-secondary">Checando o que já está instalado e o que o servidor precisa...</p>
            </div>
          )}

          {/* ---------- Erro geral (host inalcançável, etc) ---------- */}
          {phase === "error" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2.5 p-3 bg-theme-warning border border-theme-warning rounded-2xl text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>{state.errorMessage ?? "Não foi possível preparar este servidor."}</span>
              </div>
              <div className="flex justify-end gap-3 pt-2 border-t border-theme-card">
                <button type="button" onClick={onCancel} className="px-5 h-11 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold cursor-pointer">
                  Fechar
                </button>
                <button type="button" onClick={onRetryAll} className="px-5 h-11 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold cursor-pointer">
                  Tentar de novo
                </button>
              </div>
            </div>
          )}

          {/* ---------- Confirmação ---------- */}
          {phase === "confirm" && (
            <div className="space-y-4">
              <div className="space-y-2 text-sm text-theme-secondary">
                <p className="font-semibold text-theme-primary">Isso vai:</p>
                <ul className="space-y-1.5 pl-1">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
                    <span>Selecionar o perfil certo no Minecraft Launcher.</span>
                  </li>
                  {state.loaderNote && (
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
                      <span>{state.loaderNote}</span>
                    </li>
                  )}
                  {modEntries.length > 0 ? (
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
                      <span>
                        Baixar {modEntries.length} mod{modEntries.length !== 1 ? "s" : ""} (≈{formatBytes(state.totalBytesToDownload)})
                        {modrinthCount > 0 && meshCount > 0 && (
                          <> — {modrinthCount} direto do Modrinth, {meshCount} pelo próprio host</>
                        )}
                        {modrinthCount > 0 && meshCount === 0 && <> — direto do Modrinth</>}
                        {modrinthCount === 0 && meshCount > 0 && <> — direto do host (não encontrados em catálogo público)</>}
                      </span>
                    </li>
                  ) : (
                    state.alreadyInstalledCount > 0 && (
                      <li className="flex items-start gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                        <span>Todos os {state.alreadyInstalledCount} mods já estão instalados e verificados.</span>
                      </li>
                    )
                  )}
                  {state.instanceModsDir !== "" && (
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
                      <span>Isolar tudo numa pasta própria deste servidor — não afeta outros.</span>
                    </li>
                  )}
                </ul>
              </div>
              <div className="flex justify-end gap-3 pt-2 border-t border-theme-card">
                <button type="button" onClick={onCancel} className="px-5 h-11 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold cursor-pointer">
                  Cancelar
                </button>
                <button type="button" onClick={onConfirm} className="px-5 h-11 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold cursor-pointer">
                  Preparar agora
                </button>
              </div>
            </div>
          )}

          {/* ---------- Sincronizando ---------- */}
          {phase === "syncing" && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-xs text-theme-secondary">{state.stageMessage}</p>
                <div className="h-1.5 bg-theme-muted rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-indigo-500"
                    animate={{ width: `${state.stagePercent}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              </div>
              {modEntries.length > 0 && (
                <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                  {modEntries.map((entry) => (
                    <div key={entry.filename} className="flex items-center gap-2 text-xs py-0.5">
                      {statusIcon(entry.status)}
                      <span className={cn("truncate flex-1", entry.status === "failed" ? "text-rose-600 dark:text-rose-400" : "text-theme-secondary")}>
                        {entry.filename}
                      </span>
                      <span className="text-[10px] text-theme-secondary shrink-0">
                        {entry.status === "ok" ? "ok" : entry.status === "downloading" ? (entry.source === "modrinth" ? "Modrinth..." : "host...") : entry.status === "failed" ? "falhou" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---------- Relatório final ---------- */}
          {phase === "done" && (
            <div className="space-y-4">
              {failedEntries.length === 0 ? (
                <div className="flex items-start gap-2.5 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/40 rounded-2xl text-sm text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {modEntries.length > 0
                      ? `${okCount}/${modEntries.length} mods instalados e verificados. Pronto pra jogar!`
                      : "Tudo certo. Pronto pra jogar!"}
                  </span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-start gap-2.5 p-3 bg-theme-warning border border-theme-warning rounded-2xl text-sm text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      {okCount}/{modEntries.length} mods instalados. {failedEntries.length} não deram certo
                      {state.acceptedPartial ? " — você optou por continuar mesmo assim, o servidor pode rejeitar a conexão ou o jogo pode travar por mod faltando:" : ":"}
                    </span>
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto pl-1">
                    {failedEntries.map((entry) => (
                      <div key={entry.filename} className="flex items-start gap-2 text-xs">
                        <Server className="w-3 h-3 text-rose-500 shrink-0 mt-0.5" />
                        <span className="text-theme-secondary">
                          <span className="font-semibold text-theme-primary">{entry.filename}</span> — {entry.error ?? "falha desconhecida"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-theme-card">
                {showFailureFooter ? (
                  <>
                    <button type="button" onClick={onCancel} className="px-4 h-10 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-xs font-semibold cursor-pointer">
                      Cancelar
                    </button>
                    <button type="button" onClick={onContinueAnyway} className="px-4 h-10 rounded-2xl border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors text-xs font-semibold cursor-pointer">
                      Continuar mesmo assim
                    </button>
                    <button type="button" onClick={onRetryFailedOnly} className="px-4 h-10 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-xs font-semibold cursor-pointer">
                      Tentar de novo ({failedEntries.length})
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={onCancel} className="px-4 h-10 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-xs font-semibold cursor-pointer">
                      Fechar
                    </button>
                    <button
                      type="button"
                      onClick={onOpenMinecraft}
                      className="px-5 h-10 bg-emerald-600 text-white rounded-2xl hover:bg-emerald-700 transition-colors text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" /> Abrir Minecraft
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
