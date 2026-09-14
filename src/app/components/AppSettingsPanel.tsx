"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, X, Archive, Palette, User as UserIcon, Sparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useAppStore } from "@/app/store";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { cn } from "@/lib/utils";
import { requireAuth, logout, setPassword, getLinkedProviders } from "@/lib/auth";
import { getJavaVersion, updateWakeOnDemandConfig } from "@/lib/server";
import { isJREInstalled, getJREPath } from "@/lib/jre";
import {
  getSubscriptionStatus,
  openSubscriptionCheckout,
  openBillingPortal,
  isSubscriptionActive,
  type SubscriptionInfo,
  type SubscriptionPlan,
} from "@/lib/subscription";

const IDLE_TIMEOUT_OPTIONS = [10, 15, 30, 60] as const;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

// ============================================================
// AppSettingsPanel
// ============================================================
// Painel de configurações gerais do app, aberto pela engrenagem no
// cabeçalho. Menu lateral de categorias + conteúdo à direita. Grava
// direto na store a cada mudança (sem botão "Salvar").
// ============================================================

type SettingsCategory = "backups" | "tema" | "conta" | "assinatura";

const CATEGORIES: { id: SettingsCategory; label: string; icon: typeof Archive }[] = [
  { id: "backups", label: "Backups", icon: Archive },
  { id: "tema", label: "Tema", icon: Palette },
  { id: "conta", label: "Conta", icon: UserIcon },
  { id: "assinatura", label: "Assinatura", icon: Sparkles },
];

interface AppSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AppSettingsPanel({ isOpen, onClose }: AppSettingsPanelProps) {
  const [category, setCategory] = useState<SettingsCategory>("backups");
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

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

  // Estado local, de propósito — igual a `providers` acima. Nunca deve virar
  // campo do store: entitlement precisa ser sempre reverificado ao vivo no
  // Supabase, nunca confiado a partir do que ficou salvo no localStorage.
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [subAction, setSubAction] = useState<"monthly" | "annual" | "portal" | null>(null);

  useEffect(() => {
    if (!user) { setSubscription(null); return; }
    setSubLoading(true);
    getSubscriptionStatus()
      .then(setSubscription)
      .catch(() => setSubscription(null))
      .finally(() => setSubLoading(false));
  }, [user]);

  const handleSubscribe = async (plan: SubscriptionPlan) => {
    setSubAction(plan);
    setSubError(null);
    try {
      await openSubscriptionCheckout(plan);
    } catch (err: any) {
      setSubError(err?.message || "Não foi possível abrir o checkout.");
    } finally {
      setSubAction(null);
    }
  };

  const handleManageSubscription = async () => {
    setSubAction("portal");
    setSubError(null);
    try {
      await openBillingPortal();
    } catch (err: any) {
      setSubError(err?.message || "Não foi possível abrir o portal de assinatura.");
    } finally {
      setSubAction(null);
    }
  };

  // ------------------------------------------------------------
  // Wake-on-demand (Cubicase Plus) — armar/desarmar o servidor selecionado
  // ------------------------------------------------------------
  // Config por servidor (cubicase-meta.json), não global — segue o mesmo
  // servidor selecionado na aba Hospedar (mesma fonte, useAppStore). A
  // reflexão instantânea do badge "Em espera" na HostView depende de
  // `setLocalServers` também atualizar o espelho da store, não só o disco.
  const selectedServer = useAppStore((s) => s.selectedServer);
  const localServers = useAppStore((s) => s.localServers);
  const setLocalServers = useAppStore((s) => s.setLocalServers);
  const minecraftPort = useAppStore((s) => s.minecraftPort);
  const serverInfo = localServers.find((s) => s.name === selectedServer) ?? null;

  const [wakeIdleMinutes, setWakeIdleMinutes] = useState(DEFAULT_IDLE_TIMEOUT_MINUTES);
  const [wakeSubmitting, setWakeSubmitting] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);

  useEffect(() => {
    setWakeIdleMinutes(serverInfo?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES);
    setWakeError(null);
  }, [serverInfo?.name]);

  const patchServerInfo = (patch: Partial<typeof localServers[number]>) => {
    if (!serverInfo) return;
    setLocalServers(localServers.map((s) => (s.name === serverInfo.name ? { ...s, ...patch } : s)));
  };

  const handleEnableWakeOnDemand = async () => {
    if (!serverInfo) return;
    setWakeSubmitting(true);
    setWakeError(null);
    try {
      const version = serverInfo.version || "1.20.1";
      const javaVer = getJavaVersion(version);
      if (!(await isJREInstalled(javaVer))) {
        throw new Error("Java ainda não instalado para este servidor — inicie-o manualmente pelo menos uma vez antes de ativar o modo de espera.");
      }
      const jrePath = await getJREPath(javaVer);
      const javaPath = `${jrePath}\\bin\\java.exe`;

      let ramGb = 4;
      try {
        const metaPath = await join(serverInfo.path, "cubicase-meta.json");
        const meta = JSON.parse(await readTextFile(metaPath)) as { ramGb?: number };
        if (typeof meta.ramGb === "number" && meta.ramGb >= 2) ramGb = meta.ramGb;
      } catch { /* usa o padrão de 4GB */ }

      await invoke("arm_wake_on_demand", {
        serverDir: serverInfo.path,
        shortCode: serverInfo.shortCode,
        javaPath,
        ramGb,
        localPort: minecraftPort || 25565,
        serverJarName: serverInfo.serverJar || null,
        launchArgsDir: serverInfo.launchArgsDir || null,
        idleTimeoutMinutes: wakeIdleMinutes,
        name: serverInfo.name,
        version,
        serverType: serverInfo.serverType,
        description: serverInfo.description,
        forgeVersion: serverInfo.forgeVersion,
        modLoaderVersion: serverInfo.modLoaderVersion,
      });
      await updateWakeOnDemandConfig(serverInfo.path, { enabled: true, idleTimeoutMinutes: wakeIdleMinutes });
      patchServerInfo({ wakeOnDemandEnabled: true, idleTimeoutMinutes: wakeIdleMinutes });
    } catch (err: any) {
      setWakeError(err?.message || String(err));
    } finally {
      setWakeSubmitting(false);
    }
  };

  const handleDisableWakeOnDemand = async () => {
    if (!serverInfo) return;
    setWakeSubmitting(true);
    setWakeError(null);
    try {
      await invoke("disarm_wake_on_demand");
      await updateWakeOnDemandConfig(serverInfo.path, { enabled: false, idleTimeoutMinutes: wakeIdleMinutes });
      patchServerInfo({ wakeOnDemandEnabled: false });
    } catch (err: any) {
      setWakeError(err?.message || String(err));
    } finally {
      setWakeSubmitting(false);
    }
  };

  // Reverifica a assinatura periodicamente (e ao entrar nesta aba) enquanto o
  // app estiver aberto — cobre o caso raro de a assinatura vencer com o
  // wake-on-demand já armado. Nunca derruba uma sessão em hospedagem de
  // verdade (disarm_wake_on_demand só faz isso quando ainda dormindo) —
  // só impede reentrar em espera depois que ela terminar sozinha.
  useEffect(() => {
    if (!user) return;
    const recheck = async () => {
      const status = await getSubscriptionStatus().catch(() => null);
      setSubscription(status);
      if (isSubscriptionActive(status)) return;
      const servers = useAppStore.getState().localServers;
      const armed = servers.find((s) => s.wakeOnDemandEnabled);
      if (!armed) return;
      await invoke("disarm_wake_on_demand").catch(() => {});
      await updateWakeOnDemandConfig(armed.path, { enabled: false, idleTimeoutMinutes: armed.idleTimeoutMinutes }).catch(() => {});
      useAppStore.getState().setLocalServers(
        servers.map((s) => (s.name === armed.name ? { ...s, wakeOnDemandEnabled: false } : s))
      );
    };
    if (category === "assinatura") recheck();
    const interval = setInterval(recheck, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user, category]);

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
              <nav className="w-44 flex-shrink-0 border-r border-theme-card p-3 flex flex-col justify-between">
                <div className="space-y-1">
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
                </div>
                {appVersion && (
                  <p className="text-[10px] text-theme-secondary text-center px-2">Cubicase v{appVersion}</p>
                )}
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
                          normalmente sem login. Ela só é necessária pro Cubicase Plus
                          (aba Assinatura) ou se você quiser vincular seus servidores
                          a um perfil.
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

                {category === "assinatura" && (
                  <div className="space-y-5">
                    {!user ? (
                      <div className="space-y-3">
                        <p className="text-[10px] text-theme-secondary">
                          Entre com uma conta pra assinar o Cubicase Plus.
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
                        <div className="space-y-2 p-4 bg-theme-muted border border-theme-card rounded-2xl">
                          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Cubicase Plus</label>
                          {subLoading ? (
                            <p className="text-[10px] text-theme-secondary">Verificando assinatura...</p>
                          ) : isSubscriptionActive(subscription) ? (
                            <>
                              <p className="text-sm text-theme-primary">
                                Plano {subscription!.plan === "annual" ? "anual" : "mensal"} ativo
                                {subscription!.currentPeriodEnd && (
                                  <> — {subscription!.cancelAtPeriodEnd ? "cancela" : "renova"} em{" "}
                                    {new Date(subscription!.currentPeriodEnd).toLocaleDateString("pt-BR")}</>
                                )}
                              </p>
                              <button
                                type="button"
                                onClick={handleManageSubscription}
                                disabled={subAction !== null}
                                className="h-10 px-4 bg-theme-card border border-theme-card hover:bg-theme-muted disabled:opacity-50 text-theme-primary font-semibold text-xs rounded-xl transition-colors cursor-pointer"
                              >
                                {subAction === "portal" ? "Abrindo..." : "Gerenciar assinatura"}
                              </button>
                            </>
                          ) : (
                            <>
                              <p className="text-[10px] text-theme-secondary">
                                Sem custo pra usar o Cubicase — o Plus desbloqueia recursos extras.
                              </p>
                              <div className="flex gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={() => handleSubscribe("monthly")}
                                  disabled={subAction !== null}
                                  className="flex-1 h-10 px-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-xs rounded-xl transition-colors cursor-pointer"
                                >
                                  {subAction === "monthly" ? "Abrindo..." : "Mensal — R$14,90"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSubscribe("annual")}
                                  disabled={subAction !== null}
                                  className="flex-1 h-10 px-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-xs rounded-xl transition-colors cursor-pointer"
                                >
                                  {subAction === "annual" ? "Abrindo..." : "Anual — R$149,90"}
                                </button>
                              </div>
                            </>
                          )}
                          {subError && <p className="text-[10px] text-rose-500">{subError}</p>}
                        </div>

                        <div className="space-y-2.5 p-4 bg-theme-muted border border-theme-card rounded-2xl">
                          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Servidor sob demanda</label>

                          {!isSubscriptionActive(subscription) ? (
                            <p className="text-[10px] text-theme-secondary">
                              Assine o Cubicase Plus acima pra desbloquear: o servidor liga sozinho quando
                              alguém tenta entrar, e desliga sozinho depois de um tempo sem jogadores.
                            </p>
                          ) : !serverInfo ? (
                            <p className="text-[10px] text-theme-secondary">
                              Selecione um servidor na aba Hospedar primeiro.
                            </p>
                          ) : (
                            <>
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-sm text-theme-primary font-semibold">{serverInfo.name}</p>
                                  <p className="text-[10px] text-theme-secondary">
                                    Liga sozinho quando alguém tenta entrar, desliga sozinho sem jogadores.
                                  </p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer flex-shrink-0 ml-3">
                                  <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    checked={!!serverInfo.wakeOnDemandEnabled}
                                    disabled={wakeSubmitting}
                                    onChange={(e) => e.target.checked ? handleEnableWakeOnDemand() : handleDisableWakeOnDemand()}
                                  />
                                  <div className="w-11 h-6 bg-theme-card border border-theme-card rounded-full peer peer-checked:bg-indigo-600 peer-disabled:opacity-50 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
                                </label>
                              </div>

                              <div className="space-y-1 pt-1">
                                <label className="text-[10px] font-bold text-theme-secondary uppercase tracking-wide">Desligar sem jogadores após</label>
                                <select
                                  value={wakeIdleMinutes}
                                  disabled={wakeSubmitting}
                                  onChange={async (e) => {
                                    const minutes = parseInt(e.target.value, 10);
                                    setWakeIdleMinutes(minutes);
                                    await updateWakeOnDemandConfig(serverInfo.path, { enabled: !!serverInfo.wakeOnDemandEnabled, idleTimeoutMinutes: minutes });
                                    patchServerInfo({ idleTimeoutMinutes: minutes });
                                    if (serverInfo.wakeOnDemandEnabled) {
                                      // Rearma com o novo valor — o loop de espera/hospedagem em memória
                                      // no Rust só lê o timeout no momento de armar.
                                      await handleEnableWakeOnDemand();
                                    }
                                  }}
                                  className="w-full h-11 px-3 rounded-xl border border-theme-card bg-theme-card text-theme-primary focus:outline-none focus:border-indigo-500 transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {IDLE_TIMEOUT_OPTIONS.map((min) => (
                                    <option key={min} value={min}>{min} minutos</option>
                                  ))}
                                </select>
                              </div>
                            </>
                          )}
                          {wakeError && <p className="text-[10px] text-rose-500">{wakeError}</p>}
                        </div>
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
