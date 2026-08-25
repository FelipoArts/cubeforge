"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";

// ============================================================
// DeleteConfirmModal
// ============================================================
// Modal de confirmação para exclusão de servidor.
// Exige que o usuário digite o nome do servidor para confirmar.
// ============================================================

interface DeleteConfirmModalProps {
  serverName: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  isImported?: boolean;
}

export function DeleteConfirmModal({
  serverName,
  onClose,
  onConfirm,
  isImported = false,
}: DeleteConfirmModalProps) {
  const [confirmInput, setConfirmInput] = useState("");

  useLockBodyScroll(!!serverName);

  const handleConfirm = async () => {
    await onConfirm();
    setConfirmInput("");
  };

  const handleClose = () => {
    setConfirmInput("");
    onClose();
  };

  return (
    <AnimatePresence>
      {serverName && (
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
              <div className="w-8 h-8 bg-rose-50 rounded-lg flex items-center justify-center">
                <AlertTriangle className="text-rose-500 w-5 h-5" />
              </div>
              <h3 className="text-xl font-bold text-theme-primary">Excluir Servidor</h3>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-theme-secondary leading-relaxed">
                {isImported ? (
                  <>Tem certeza que deseja remover o servidor <strong className="text-theme-primary">"{serverName}"</strong> da sua lista? Os arquivos originais na pasta não serão deletados.</>
                ) : (
                  <>Tem certeza que deseja excluir permanentemente o servidor <strong className="text-theme-primary">"{serverName}"</strong>? Todos os mundos, configurações e dados serão perdidos. Esta ação não pode ser desfeita.</>
                )}
              </p>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">
                  Digite o nome do servidor para confirmar
                </label>
                <input
                  type="text"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder={serverName || ""}
                  className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-rose-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent"
                  autoFocus
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-theme-card">
              <button
                onClick={handleClose}
                className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirm}
                disabled={confirmInput !== serverName}
                className="px-6 h-12 bg-rose-500 text-white rounded-2xl hover:bg-rose-600 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Excluir Permanentemente
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
