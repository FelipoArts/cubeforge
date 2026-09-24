"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Power, Minus } from "lucide-react";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useT } from "@/i18n";

// ============================================================
// CloseAppModal
// ============================================================
// Exibido quando o usuário clica no X da janela (o Rust intercepta o close e
// emite "close-requested" em vez de fechar direto — ver on_window_event em
// src-tauri/src/lib.rs). Deixa o usuário escolher entre encerrar tudo
// (servidor Minecraft + rede mesh + app) ou minimizar pro system tray
// mantendo os dois rodando em segundo plano.
// ============================================================

interface CloseAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  onQuitFully: () => Promise<void> | void;
  onMinimizeToTray: () => Promise<void> | void;
}

export function CloseAppModal({ isOpen, onClose, onQuitFully, onMinimizeToTray }: CloseAppModalProps) {
  const { t } = useT();
  const [pending, setPending] = useState<"quit" | "minimize" | null>(null);

  useLockBodyScroll(isOpen);

  const handleQuit = async () => {
    if (pending) return;
    setPending("quit");
    try {
      await onQuitFully();
    } catch {
      setPending(null);
    }
  };

  const handleMinimize = async () => {
    if (pending) return;
    setPending("minimize");
    try {
      await onMinimizeToTray();
    } finally {
      setPending(null);
    }
  };

  const handleBackdropClose = () => {
    if (pending) return;
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleBackdropClose}
            className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-md bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-6"
          >
            <div className="space-y-1.5">
              <h3 className="text-xl font-bold text-theme-primary">{t("close.title")}</h3>
              <p className="text-sm text-theme-secondary leading-relaxed">
                {t("close.desc")}
              </p>
            </div>

            <div className="space-y-3">
              <button
                type="button"
                onClick={handleMinimize}
                disabled={pending !== null}
                className="w-full h-16 px-5 rounded-2xl border border-theme-card hover:bg-theme-muted transition-colors text-left flex items-center gap-3 disabled:opacity-40 cursor-pointer"
              >
                <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center shrink-0">
                  <Minus className="w-4.5 h-4.5 text-indigo-500" />
                </div>
                <div>
                  <div className="text-sm font-bold text-theme-primary">
                    {pending === "minimize" ? t("close.minimizing") : t("close.minimize")}
                  </div>
                  <div className="text-xs text-theme-secondary">{t("close.minimizeDesc")}</div>
                </div>
              </button>

              <button
                type="button"
                onClick={handleQuit}
                disabled={pending !== null}
                className="w-full h-16 px-5 rounded-2xl border border-theme-card hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors text-left flex items-center gap-3 disabled:opacity-40 cursor-pointer"
              >
                <div className="w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-900/30 flex items-center justify-center shrink-0">
                  <Power className="w-4.5 h-4.5 text-rose-500" />
                </div>
                <div>
                  <div className="text-sm font-bold text-theme-primary">
                    {pending === "quit" ? t("close.quitting") : t("close.quit")}
                  </div>
                  <div className="text-xs text-theme-secondary">{t("close.quitDesc")}</div>
                </div>
              </button>
            </div>

            <div className="flex justify-end pt-2 border-t border-theme-card">
              <button
                type="button"
                onClick={onClose}
                disabled={pending !== null}
                className="px-5 h-11 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold disabled:opacity-40 cursor-pointer"
              >
                {t("common.cancel")}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
