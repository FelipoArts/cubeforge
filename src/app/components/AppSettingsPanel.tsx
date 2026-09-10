"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, X, Archive, Palette, User as UserIcon } from "lucide-react";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useAppStore } from "@/app/store";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { cn } from "@/lib/utils";
import { requireAuth, logout, setPassword, getLinkedProviders } from "@/lib/auth";

// ============================================================
// AppSettingsPanel
// ============================================================
// Painel de configurações gerais do app, aberto pela engrenagem no
// cabeçalho. Menu lateral de categorias + conteúdo à direita. Grava
// direto na store a cada mudança (sem botão "Salvar").
// ============================================================

type SettingsCategory = "backups" | "tema" | "conta";

const CATEGORIES: { id: SettingsCategory; label: string; icon: typeof Archive }[] = [
  { id: "backups", label: "Backups", icon: Archive },
  { id: "tema", label: "Tema", icon: Palette },
  { id: "conta", label: "Conta", icon: UserIcon },
];

interface AppSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AppSettingsPanel({ isOpen, onClose }: AppSettingsPanelProps) {
  const [category, setCategory] = useState<SettingsCategory>("backups");

  const autoBackupEnabled = useAppStore((s) => s.autoBackupEnabled);
  const setAutoBackupEnabled = useAppStore((s) => s.setAutoBackupEnabled);
  const backupRetentionCount = useAppStore((s) => s.backupRetentionCount);
  const setBackupRetentionCount = useAppStore((s) => s.setBackupRetentionCount);
  const backupSafetyNetIntervalHours = useAppStore((s) => s.backupSafetyNetIntervalHours);
  const setBackupSafetyNetIntervalHours = useAppStore((s) => s.setBackupSafetyNetIntervalHours);

  const user = useAppStore((s) => s.user);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [newPassword, setNewPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (!user) { setProviders([]); return; }
    getLinkedProviders().then(setProviders);
  }, [user]);

  const handleLogin = async () => {
    setLoggingIn(true);
    setLoginError(null);
    try {
      await requireAuth();
    } catch (err: any) {
      setLoginError(err?.message || "Não foi possível concluir o login.");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleSetPassword = async () => {
    if (newPassword.length < 6) {
      setPasswordStatus("error");
      return;
    }
    setPasswordStatus("saving");
    try {
      await setPassword(newPassword);
      setPasswordStatus("saved");
      setNewPassword("");
    } catch {
      setPasswordStatus("error");
    }
  };

  useLockBodyScroll(isOpen);

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
            className="relative w-full max-w-2xl bg-theme-card rounded-[2rem] border-theme-card shadow-2xl z-10 flex flex-col h-[560px] max-h-[80vh] overflow-hidden"
          >
            <div className="p-6 pb-4 flex-shrink-0 flex items-center justify-between border-b border-theme-card">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center">
                  <Settings className="text-indigo-600 w-5 h-5" />
                </div>
                <h3 className="text-xl font-bold text-theme-primary">Configurações</h3>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-1 min-h-0">
              <nav className="w-44 flex-shrink-0 border-r border-theme-card p-3 space-y-1">
                {CATEGORIES.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setCategory(id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors cursor-pointer",
                      category === id
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-theme-secondary hover:text-theme-primary hover:bg-theme-muted"
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                ))}
              </nav>

              <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
                {category === "backups" && (
                  <div className="space-y-5">
                    <div className="space-y-1.5">
                      <label className="flex items-center gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoBackupEnabled}
                          onChange={(e) => setAutoBackupEnabled(e.target.checked)}
                          className="w-4.5 h-4.5 rounded-lg text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Backup automático do mundo</span>
                      </label>
                      <p className="text-[10px] text-theme-secondary">
                        Gera backup sozinho quando o servidor é parado ou crasha, e periodicamente
                        em sessões longas. Pula sozinho se o mundo não mudou desde o último.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Manter últimos N backups</label>
                      <input
                        type="number"
                        min="1"
                        max="100"
                        value={backupRetentionCount}
                        disabled={!autoBackupEnabled}
                        onChange={(e) => setBackupRetentionCount(parseInt(e.target.value) || 1)}
                        className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all font-mono text-sm text-theme-primary bg-transparent disabled:opacity-50"
                      />
                      <p className="text-[10px] text-theme-secondary">
                        Backups mais antigos que isso (automáticos ou manuais) são apagados sozinhos.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Intervalo do backup de segurança (horas)</label>
                      <input
                        type="number"
                        min="1"
                        max="24"
                        value={backupSafetyNetIntervalHours}
                        disabled={!autoBackupEnabled}
                        onChange={(e) => setBackupSafetyNetIntervalHours(parseInt(e.target.value) || 1)}
                        className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all font-mono text-sm text-theme-primary bg-transparent disabled:opacity-50"
                      />
                      <p className="text-[10px] text-theme-secondary">
                        Em sessões longas que nunca são paradas manualmente, gera um backup extra a cada esse tanto de horas.
                      </p>
                    </div>
                  </div>
                )}

                {category === "tema" && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Aparência</label>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-sm text-theme-primary">Modo claro / escuro</span>
                      <ThemeToggle />
                    </div>
                  </div>
                )}

                {category === "conta" && (
                  <div className="space-y-5">
                    {!user ? (
                      <div className="space-y-3">
                        <p className="text-[10px] text-theme-secondary">
                          Uma conta é opcional — o Cubicase continua funcionando
                          normalmente sem login. Ela só é necessária para recursos
                          pagos (quando existirem) ou se você quiser vincular seus
                          servidores a um perfil.
                        </p>
                        <button
                          type="button"
                          onClick={handleLogin}
                          disabled={loggingIn}
                          className="w-full h-12 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm rounded-2xl transition-colors cursor-pointer"
                        >
                          {loggingIn ? "Abrindo o navegador..." : "Entrar"}
                        </button>
                        {loginError && <p className="text-[10px] text-rose-500">{loginError}</p>}
                      </div>
                    ) : (
                      <div className="space-y-5">
                        <div className="space-y-1.5">
                          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Logado como</label>
                          <p className="text-sm text-theme-primary">{user.email}</p>
                          {providers.length > 0 && (
                            <p className="text-[10px] text-theme-secondary">
                              Provedores vinculados: {providers.join(", ")}
                            </p>
                          )}
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Definir senha</label>
                          <p className="text-[10px] text-theme-secondary">
                            Opcional — permite entrar com senha além do link mágico/Google/Discord.
                          </p>
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={newPassword}
                              onChange={(e) => { setNewPassword(e.target.value); setPasswordStatus("idle"); }}
                              placeholder="Nova senha"
                              className="flex-1 h-12 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm text-theme-primary bg-transparent"
                            />
                            <button
                              type="button"
                              onClick={handleSetPassword}
                              disabled={passwordStatus === "saving"}
                              className="h-12 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm rounded-2xl transition-colors cursor-pointer"
                            >
                              Salvar
                            </button>
                          </div>
                          {passwordStatus === "saved" && <p className="text-[10px] text-emerald-600">Senha atualizada.</p>}
                          {passwordStatus === "error" && (
                            <p className="text-[10px] text-rose-500">Senha inválida (mínimo 6 caracteres) ou falha ao salvar.</p>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => logout()}
                          className="text-xs font-semibold text-rose-500 hover:text-rose-600 transition-colors cursor-pointer"
                        >
                          Sair da conta
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
