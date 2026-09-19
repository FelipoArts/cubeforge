"use client";

import { motion } from "framer-motion";
import { Monitor, Globe, ArrowRight } from "lucide-react";
import { useTheme } from "next-themes";

// ============================================================
// OnboardingScreen
// ============================================================
// Exibida no primeiríssimo uso do app (defaultTab ainda null na store —
// ver page.tsx), antes de qualquer outra UI. Faz a pessoa escolher entre
// Host e Convidado logo de cara, em vez de cair direto na aba de Host,
// que não faz sentido pra quem só quer entrar no servidor de um amigo.
// A escolha vira a aba padrão do app (mudável depois em Configurações →
// Início) — ver setDefaultTab em store.ts.
// ============================================================

interface OnboardingScreenProps {
  mounted: boolean;
  onChoose: (tab: "host" | "guest") => void;
}

export function OnboardingScreen({ mounted, onChoose }: OnboardingScreenProps) {
  const { resolvedTheme } = useTheme();

  return (
    <div className="min-h-screen bg-theme-bg transition-colors duration-300 flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-2xl text-center space-y-10"
      >
        <div className="space-y-4">
          <img
            src={mounted ? (resolvedTheme === "dark" ? "/icon-dark.png" : "/icon.png") : "/icon.png"}
            alt="Cubicase"
            className="h-10 mx-auto"
          />
          <div className="space-y-1.5">
            <h1 className="text-2xl font-bold text-theme-primary">Bem-vindo ao Cubicase</h1>
            <p className="text-sm text-theme-secondary">
              O que você quer fazer? Dá pra mudar isso depois em Configurações.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => onChoose("host")}
            className="group text-left p-6 rounded-[2rem] border border-theme-card bg-theme-card hover:border-indigo-500 hover:shadow-xl transition-all cursor-pointer"
          >
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center mb-4">
              <Monitor className="w-6 h-6 text-indigo-600" />
            </div>
            <h2 className="text-base font-bold text-theme-primary flex items-center gap-1.5">
              Hospedar um servidor
              <ArrowRight className="w-4 h-4 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all text-indigo-600" />
            </h2>
            <p className="text-xs text-theme-secondary mt-1.5 leading-relaxed">
              Crie e gerencie seu próprio servidor Minecraft, e convide seus amigos pra jogar.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onChoose("guest")}
            className="group text-left p-6 rounded-[2rem] border border-theme-card bg-theme-card hover:border-indigo-500 hover:shadow-xl transition-all cursor-pointer"
          >
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center mb-4">
              <Globe className="w-6 h-6 text-indigo-600" />
            </div>
            <h2 className="text-base font-bold text-theme-primary flex items-center gap-1.5">
              Conectar a um servidor
              <ArrowRight className="w-4 h-4 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all text-indigo-600" />
            </h2>
            <p className="text-xs text-theme-secondary mt-1.5 leading-relaxed">
              Entre no servidor de um amigo usando o código que ele te passou.
            </p>
          </button>
        </div>
      </motion.div>
    </div>
  );
}
