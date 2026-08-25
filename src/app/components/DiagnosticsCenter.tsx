"use client";

import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  X,
  Info,
  AlertTriangle,
  AlertOctagon,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDiagnosticsStore, type DiagnosticEntry, type DiagnosticLevel } from "@/app/diagnostics";

// ============================================================
// Central de Diagnósticos — UI
// ============================================================
// DiagnosticsToasts: pilha de notificações não-bloqueantes (substitui alert()).
// DiagnosticsBell: ícone de sino com contador de não lidos + painel de histórico.
// ============================================================

const LEVEL_STYLES: Record<DiagnosticLevel, { bg: string; border: string; text: string; icon: typeof Info }> = {
  info: { bg: "bg-theme-accent", border: "border-theme-accent", text: "text-indigo-700 dark:text-indigo-300", icon: Info },
  warning: { bg: "bg-theme-warning", border: "border-theme-warning", text: "text-amber-800 dark:text-amber-200", icon: AlertTriangle },
  error: { bg: "bg-theme-danger", border: "border-theme-danger", text: "text-rose-800 dark:text-rose-200", icon: AlertOctagon },
  critical: { bg: "bg-theme-danger", border: "border-theme-danger", text: "text-rose-800 dark:text-rose-200", icon: ShieldAlert },
};

const LEVEL_LABELS: Record<DiagnosticLevel, string> = {
  info: "Info",
  warning: "Aviso",
  error: "Erro",
  critical: "Crítico",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ------------------------------------------------------------
// Toasts
// ------------------------------------------------------------

export function DiagnosticsToasts() {
  const entries = useDiagnosticsStore((s) => s.entries);
  const toastIds = useDiagnosticsStore((s) => s.toastIds);
  const dismissToast = useDiagnosticsStore((s) => s.dismissToast);

  const visible = toastIds
    .map((id) => entries.find((e) => e.id === id))
    .filter((e): e is DiagnosticEntry => !!e);

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 w-full max-w-sm pointer-events-none">
      <AnimatePresence initial={false}>
        {visible.map((entry) => {
          const style = LEVEL_STYLES[entry.level];
          const Icon = style.icon;
          return (
            <motion.div
              key={entry.id}
              layout
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}
              transition={{ type: "spring", duration: 0.3 }}
              className={cn(
                "pointer-events-auto p-4 rounded-2xl border shadow-lg backdrop-blur-xl flex items-start gap-3",
                style.bg,
                style.border
              )}
            >
              <Icon className={cn("w-5 h-5 flex-shrink-0 mt-0.5", style.text)} />
              <div className="flex-1 min-w-0">
                <p className={cn("text-sm font-bold", style.text)}>{entry.title}</p>
                <p className="text-xs text-theme-secondary mt-0.5 break-words">{entry.message}</p>
              </div>
              <button
                type="button"
                onClick={() => dismissToast(entry.id)}
                className="p-1 rounded-lg hover:bg-theme-muted text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer flex-shrink-0"
                title="Dispensar"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------
// Sino + Painel de histórico
// ------------------------------------------------------------

export function DiagnosticsBell() {
  const entries = useDiagnosticsStore((s) => s.entries);
  const unreadCount = useDiagnosticsStore((s) => s.unreadCount);
  const markAllRead = useDiagnosticsStore((s) => s.markAllRead);
  const clearHistory = useDiagnosticsStore((s) => s.clearHistory);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next) markAllRead();
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={handleToggle}
        className="relative p-2 rounded-xl hover:bg-theme-muted text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"
        title="Central de diagnósticos"
      >
        <Bell className="w-4.5 h-4.5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 mt-2 w-96 max-h-[28rem] bg-theme-card border border-theme-card rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden"
          >
            <div className="p-4 flex items-center justify-between border-b border-theme-card flex-shrink-0">
              <h4 className="text-sm font-bold text-theme-primary">Central de Diagnósticos</h4>
              {entries.length > 0 && (
                <button
                  type="button"
                  onClick={clearHistory}
                  className="text-xs text-theme-secondary hover:text-rose-500 transition-colors flex items-center gap-1 cursor-pointer"
                  title="Limpar histórico"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Limpar
                </button>
              )}
            </div>

            <div className="overflow-y-auto custom-scrollbar flex-1">
              {entries.length === 0 ? (
                <div className="p-8 text-center text-sm text-theme-secondary">
                  Nenhum evento registrado ainda.
                </div>
              ) : (
                entries.map((entry) => {
                  const style = LEVEL_STYLES[entry.level];
                  const Icon = style.icon;
                  return (
                    <div key={entry.id} className="p-4 border-b border-theme-card last:border-0 flex items-start gap-3">
                      <Icon className={cn("w-4 h-4 flex-shrink-0 mt-0.5", style.text)} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn("text-xs font-bold", style.text)}>{entry.title}</span>
                          <span className="text-[10px] text-theme-muted">{LEVEL_LABELS[entry.level]}</span>
                        </div>
                        <p className="text-xs text-theme-secondary mt-0.5 break-words">{entry.message}</p>
                        {entry.detail && (
                          <p className="text-[10px] text-theme-muted mt-1 break-words font-mono">{entry.detail}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-theme-muted">{entry.source}</span>
                          <span className="text-[10px] text-theme-muted">·</span>
                          <span className="text-[10px] text-theme-muted">{formatTime(entry.timestamp)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
