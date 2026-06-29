"use client";

import React from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";

// ============================================================
// SettingsButton
// ============================================================
// Botão de engrenagem para abrir configurações do servidor.
// ============================================================

interface SettingsButtonProps {
  serverDir: string;
  onConfig: (dir: string) => void;
}

export default function SettingsButton({ serverDir, onConfig }: SettingsButtonProps) {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onConfig(serverDir);
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "p-1.5 hover:bg-indigo-50 text-indigo-600 rounded-lg transition-colors cursor-pointer",
        "pointer-events-auto"
      )}
      title="Configurações do Servidor"
    >
      <Settings className="w-4 h-4" />
    </button>
  );
}
