"use client";

import { useTheme } from "next-themes";
import { useState, useEffect } from "react";
import { Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

// ============================================================
// ThemeToggle
// ============================================================
// Botão toggle para alternar entre tema claro e escuro.
// Usa next-themes para gerenciar o tema com persistência.
// ============================================================

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Evita mismatch de hidratação SSR
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Renderiza um placeholder com o mesmo tamanho para evitar layout shift
    return <div className="w-14 h-7" />;
  }

  const isDark = theme === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(
        "relative w-14 h-7 rounded-full flex items-center px-1 transition-colors duration-300",
        isDark
          ? "bg-indigo-900/60 border border-indigo-700/30"
          : "bg-indigo-100 border border-indigo-200"
      )}
      title={isDark ? "Mudar para modo claro" : "Mudar para modo escuro"}
    >
      {/* Ícone do Sol (lado direito) */}
      <Sun
        className={cn(
          "w-3.5 h-3.5 absolute right-2 transition-all duration-300",
          isDark ? "text-indigo-400/40" : "text-amber-500"
        )}
      />

      {/* Ícone da Lua (lado esquerdo) */}
      <Moon
        className={cn(
          "w-3.5 h-3.5 absolute left-2 transition-all duration-300",
          isDark ? "text-indigo-300" : "text-indigo-400/40"
        )}
      />

      {/* Bolinha deslizante - sem animação */}
      <div
        className={cn(
          "w-5 h-5 rounded-full shadow-md z-10 transition-none",
          isDark ? "bg-indigo-500" : "bg-white border border-indigo-200"
        )}
        style={{
          transform: isDark ? "translateX(0)" : "translateX(28px)",
        }}
      />
    </button>
  );
}
