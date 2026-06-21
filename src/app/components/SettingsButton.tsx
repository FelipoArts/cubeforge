"use client";

import React from "react";
import { Settings } from "lucide-react";
import { cn } from "../lib/utils";

interface SettingsButtonProps {
  serverDir: string;
  setConfigServer: (dir: string) => void;
  setShowConfigModal: (show: boolean) => void;
}

export default function SettingsButton({ serverDir, setConfigServer, setShowConfigModal }: SettingsButtonProps) {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setConfigServer(serverDir);
    setShowConfigModal(true);
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
