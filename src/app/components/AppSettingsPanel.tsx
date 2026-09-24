"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, X, Archive, Palette, User as UserIcon, Sparkles, Home, Monitor, Globe } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { useAppStore } from "@/app/store";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { LanguageSelector } from "@/app/components/LanguageSelector";
import { useT, formatNumber, formatDateTime, type TKey } from "@/i18n";
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

export type SettingsCategory = "inicio" | "backups" | "tema" | "conta" | "assinatura";

const CATEGORIES: { id: SettingsCategory; labelKey: TKey; icon: typeof Archive }[] = [
  { id: "inicio", labelKey: "settings.cat.home", icon: Home },
  { id: "backups", labelKey: "settings.cat.backups", icon: Archive },
  { id: "tema", labelKey: "settings.cat.theme", icon: Palette },
  { id: "conta", labelKey: "settings.cat.account", icon: UserIcon },
  { id: "assinatura", labelKey: "settings.cat.subscription", icon: Sparkles },
];

interface AppSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Categoria exibida ao abrir o painel (ex: card "Cubicase Plus" no HostView pulando direto pra aba de assinatura). Padrão "backups". */
  initialCategory?: SettingsCategory;
}

export function AppSettingsPanel({ isOpen, onClose, initialCategory }: AppSettingsPanelProps) {
  const { t } = useT();
  const [category, setCategory] = useState<SettingsCategory>(initialCategory ?? "backups");
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Reabrir o painel sempre parte da categoria pedida (ex: link direto pra "assinatura"),
  // sem carregar a última aba visitada de uma abertura anterior.
  useEffect(() => {
    if (isOpen) setCategory(initialCategory ?? "backups");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  const defaultTab = useAppStore((s) => s.defaultTab);
  const setDefaultTab = useAppStore((s) => s.setDefaultTab);

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
      setSubError(err?.message || t("settings.sub.checkoutFailed"));
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
      setSubError(err?.message || t("settings.sub.portalFailed"));
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
        throw new Error(t("settings.wake.javaMissing"));
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
      setLoginError(err?.message || t("settings.account.loginFailed"));
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
                <h3 className="text-xl font-bold text-theme-primary">{t("settings.title")}</h3>
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
                  {CATEGORIES.map(({ id, labelKey, icon: Icon }) => (
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
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
                {appVersion && (
                  <p className="text-[10px] text-theme-secondary text-center px-2">{t("settings.version", { version: appVersion })}</p>
                )}
              </nav>

              <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
                {category === "inicio" && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.home.label")}</label>
                    <p className="text-[10px] text-theme-secondary pb-1">
                      {t("settings.home.hint")}
                    </p>
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <button
                        type="button"
                        onClick={() => setDefaultTab("host")}
                        className={cn(
                          "text-left p-4 rounded-2xl border transition-colors cursor-pointer",
                          defaultTab === "host"
                            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20"
                            : "border-theme-card hover:bg-theme-muted"
                        )}
                      >
                        <Monitor className="w-4.5 h-4.5 text-indigo-600 mb-2" />
                        <div className="text-sm font-bold text-theme-primary">{t("settings.home.host")}</div>
                        <div className="text-[10px] text-theme-secondary">{t("settings.home.hostDesc")}</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDefaultTab("guest")}
                        className={cn(
                          "text-left p-4 rounded-2xl border transition-colors cursor-pointer",
                          defaultTab === "guest"
                            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20"
                            : "border-theme-card hover:bg-theme-muted"
                        )}
                      >
                        <Globe className="w-4.5 h-4.5 text-indigo-600 mb-2" />
                        <div className="text-sm font-bold text-theme-primary">{t("settings.home.guest")}</div>
                        <div className="text-[10px] text-theme-secondary">{t("settings.home.guestDesc")}</div>
                      </button>
                    </div>
                  </div>
                )}

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
                        <span className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.backups.auto")}</span>
                      </label>
                      <p className="text-[10px] text-theme-secondary">
                        {t("settings.backups.autoHint")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.backups.retention")}</label>
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
                        {t("settings.backups.retentionHint")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.backups.interval")}</label>
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
                        {t("settings.backups.intervalHint")}
                      </p>
                    </div>
                  </div>
                )}

                {category === "tema" && (
                  <div className="space-y-6">
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.theme.appearance")}</label>
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-sm text-theme-primary">{t("settings.theme.mode")}</span>
                        <ThemeToggle />
                      </div>
                    </div>
                    <LanguageSelector />
                  </div>
                )}

                {category === "conta" && (
                  <div className="space-y-5">
                    {!user ? (
                      <div className="space-y-3">
                        <p className="text-[10px] text-theme-secondary">
                          {t("settings.account.intro")}
                        </p>
                        <button
                          type="button"
                          onClick={handleLogin}
                          disabled={loggingIn}
                          className="w-full h-12 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm rounded-2xl transition-colors cursor-pointer"
                        >
                          {loggingIn ? t("settings.account.opening") : t("settings.account.login")}
                        </button>
                        {loginError && <p className="text-[10px] text-rose-500">{loginError}</p>}
                      </div>
                    ) : (
                      <div className="space-y-5">
                        <div className="space-y-1.5">
                          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.account.loggedAs")}</label>
                          <p className="text-sm text-theme-primary">{user.email}</p>
                          {providers.length > 0 && (
                            <p className="text-[10px] text-theme-secondary">
                              {t("settings.account.providers", { providers: providers.join(", ") })}
                            </p>
                          )}
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.account.setPassword")}</label>
                          <p className="text-[10px] text-theme-secondary">
                            {t("settings.account.setPasswordHint")}
                          </p>
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={newPassword}
                              onChange={(e) => { setNewPassword(e.target.value); setPasswordStatus("idle"); }}
                              placeholder={t("settings.account.newPassword")}
                              className="flex-1 h-12 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm text-theme-primary bg-transparent"
                            />
                            <button
                              type="button"
                              onClick={handleSetPassword}
                              disabled={passwordStatus === "saving"}
                              className="h-12 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm rounded-2xl transition-colors cursor-pointer"
                            >
                              {t("settings.account.save")}
                            </button>
                          </div>
                          {passwordStatus === "saved" && <p className="text-[10px] text-emerald-600">{t("settings.account.passwordSaved")}</p>}
                          {passwordStatus === "error" && (
                            <p className="text-[10px] text-rose-500">{t("settings.account.passwordError")}</p>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => logout()}
                          className="text-xs font-semibold text-rose-500 hover:text-rose-600 transition-colors cursor-pointer"
                        >
                          {t("settings.account.logout")}
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
                          {t("settings.sub.loginPrompt")}
                        </p>
                        <button
                          type="button"
                          onClick={handleLogin}
                          disabled={loggingIn}
                          className="w-full h-12 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm rounded-2xl transition-colors cursor-pointer"
                        >
                          {loggingIn ? t("settings.account.opening") : t("settings.account.login")}
                        </button>
                        {loginError && <p className="text-[10px] text-rose-500">{loginError}</p>}
                      </div>
                    ) : (
                      <div className="space-y-5">
                        <div className="space-y-2 p-4 bg-theme-muted border border-theme-card rounded-2xl">
                          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.sub.title")}</label>
                          {subLoading ? (
                            <p className="text-[10px] text-theme-secondary">{t("settings.sub.checking")}</p>
                          ) : isSubscriptionActive(subscription) ? (
                            <>
                              <p className="text-sm text-theme-primary">
                                {t(subscription!.plan === "annual" ? "settings.sub.active.annual" : "settings.sub.active.monthly")}
                                {subscription!.currentPeriodEnd &&
                                  t(subscription!.cancelAtPeriodEnd ? "settings.sub.cancelsOn" : "settings.sub.renewsOn", {
                                    date: formatDateTime(subscription!.currentPeriodEnd, { dateStyle: "short" }),
                                  })}
                              </p>
                              <button
                                type="button"
                                onClick={handleManageSubscription}
                                disabled={subAction !== null}
                                className="h-10 px-4 bg-theme-card border border-theme-card hover:bg-theme-muted disabled:opacity-50 text-theme-primary font-semibold text-xs rounded-xl transition-colors cursor-pointer"
                              >
                                {subAction === "portal" ? t("settings.sub.opening") : t("settings.sub.manage")}
                              </button>
                            </>
                          ) : (
                            <>
                              <p className="text-[10px] text-theme-secondary">
                                {t("settings.sub.freeHint")}
                              </p>
                              <div className="flex gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={() => handleSubscribe("monthly")}
                                  disabled={subAction !== null}
                                  className="flex-1 h-10 px-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-xs rounded-xl transition-colors cursor-pointer"
                                >
                                  {subAction === "monthly" ? t("settings.sub.opening") : t("settings.sub.monthly", { price: formatNumber(14.9, { style: "currency", currency: "BRL" }) })}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSubscribe("annual")}
                                  disabled={subAction !== null}
                                  className="flex-1 h-10 px-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-xs rounded-xl transition-colors cursor-pointer"
                                >
                                  {subAction === "annual" ? t("settings.sub.opening") : t("settings.sub.annual", { price: formatNumber(149.9, { style: "currency", currency: "BRL" }) })}
                                </button>
                              </div>
                            </>
                          )}
                          {subError && <p className="text-[10px] text-rose-500">{subError}</p>}
                        </div>

                        <div className="space-y-2.5 p-4 bg-theme-muted border border-theme-card rounded-2xl">
                          <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">{t("settings.wake.title")}</label>

                          {!isSubscriptionActive(subscription) ? (
                            <p className="text-[10px] text-theme-secondary">
                              {t("settings.wake.locked")}
                            </p>
                          ) : !serverInfo ? (
                            <p className="text-[10px] text-theme-secondary">
                              {t("settings.wake.selectServer")}
                            </p>
                          ) : (
                            <>
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-sm text-theme-primary font-semibold">{serverInfo.name}</p>
                                  <p className="text-[10px] text-theme-secondary">
                                    {t("settings.wake.desc")}
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
                                <label className="text-[10px] font-bold text-theme-secondary uppercase tracking-wide">{t("settings.wake.idleAfter")}</label>
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
                                    <option key={min} value={min}>{t("settings.wake.minutes", { count: min })}</option>
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
