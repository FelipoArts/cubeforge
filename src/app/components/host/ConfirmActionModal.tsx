"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";

// ============================================================
// ConfirmActionModal
// ============================================================
// Modal de confirmação genérico para ações destrutivas (excluir mod,
// restaurar backup, resetar mundo). Mesma linguagem visual do
// DeleteConfirmModal, mas configurável — não usado para exclusão de
// servidor, que continua no DeleteConfirmModal dedicado.
// ============================================================

interface ConfirmActionModalProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  /** Se definido, exige digitar exatamente esse texto para habilitar a confirmação. */
  requireTypedConfirmation?: string;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

export function ConfirmActionModal({
  isOpen,
  title,
  message,
  confirmLabel,
  requireTypedConfirmation,
  onClose,
  onConfirm,
}: ConfirmActionModalProps) {
  const [confirmInput, setConfirmInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useLockBodyScroll(isOpen);

  const canConfirm = !requireTypedConfirmation || confirmInput === requireTypedConfirmation;

  const handleConfirm = async () => {
    if (!canConfirm || isSubmitting) return;
    try {
      setIsSubmitting(true);
      await onConfirm();
    } finally {
      setIsSubmitting(false);
      setConfirmInput("");
    }
  };

  const handleClose = () => {
    if (isSubmitting) return;
    setConfirmInput("");
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
            onClick={handleClose}
            className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-md bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-6"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-rose-50 dark:bg-rose-900/30 rounded-lg flex items-center justify-center">
                <AlertTriangle className="text-rose-500 w-5 h-5" />
              </div>
              <h3 className="text-xl font-bold text-theme-primary">{title}</h3>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-theme-secondary leading-relaxed">{message}</p>

              {requireTypedConfirmation && (
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">
                    {`Digite "${requireTypedConfirmation}" para confirmar`}
                  </label>
                  <input
                    type="text"
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    placeholder={requireTypedConfirmation}
                    className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-rose-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent"
                    autoFocus
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-theme-card">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSubmitting}
                className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={!canConfirm || isSubmitting}
                className="px-6 h-12 bg-rose-500 text-white rounded-2xl hover:bg-rose-600 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Aguarde..." : confirmLabel}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
