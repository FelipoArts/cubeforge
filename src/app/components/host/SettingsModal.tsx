"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, X } from "lucide-react";

// ============================================================
// SettingsModal
// ============================================================
// Modal de configurações globais do sistema.
// Permite ajustar a porta local do Minecraft.
// Com altura máxima e scroll vertical para não ultrapassar viewport.
// ============================================================

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPort: number;
  onSave: (port: number) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  currentPort,
  onSave,
}: SettingsModalProps) {
  const [port, setPort] = useState(currentPort);

  useEffect(() => {
    if (isOpen) setPort(currentPort);
  }, [isOpen, currentPort]);

  const handleSave = () => {
    onSave(port);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-md bg-theme-card rounded-[2rem] border-theme-card shadow-2xl z-10 space-y-6 max-h-[80vh] flex flex-col"
          >
            <div className="p-8 pb-0 flex-shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center">
                    <Settings className="text-indigo-600 w-5 h-5" />
                  </div>
                  <h3 className="text-xl font-bold text-theme-primary">Ajustes do Sistema</h3>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
              <div className="space-y-4 pb-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Porta Local do Minecraft</label>
                  <input
                    type="number"
                    min="1024"
                    max="65535"
                    value={port}
                    onChange={(e) => setPort(parseInt(e.target.value) || 25565)}
                    className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all font-mono text-sm text-theme-primary bg-transparent"
                  />
                  <p className="text-[10px] text-theme-secondary">
                    Porta local na qual o seu Minecraft se conectará (padrão 25565).
                  </p>
                </div>
              </div>
            </div>

            <div className="p-8 pt-0 flex-shrink-0">
              <div className="flex justify-end gap-3 pt-4 border-t border-theme-card">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow cursor-pointer"
                >
                  Salvar Ajustes
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
