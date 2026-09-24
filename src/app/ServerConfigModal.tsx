import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-dialog';
import { Check, X, AlertTriangle, Image as ImageIcon, Link as LinkIcon, Gamepad2, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLockBodyScroll } from '@/lib/useLockBodyScroll';
import { useAppStore } from '@/app/store';
import { getSubscriptionStatus, isSubscriptionActive } from '@/lib/subscription';
import {
  getServerSlug,
  setServerSlug,
  removeServerSlug,
  isValidSlugFormat,
  inviteLinkUrl,
  defaultSlugFor,
  slugFormatHint,
} from '@/lib/inviteLink';
import {
  getServerConnectName,
  setConnectName,
  removeConnectName,
  isValidConnectNameFormat,
  connectAddressFor,
  defaultConnectNameFor,
  CONNECT_NAME_DOMAIN,
  connectNameFormatHint,
} from '@/lib/connectAddress';
import { useT } from '@/i18n';

interface ServerConfigModalProps {
  /** Full filesystem path to the server directory */
  serverDir: string;
  /** Código de convite (CF-XXXXXX) deste servidor — null se ele nunca chegou a ser registrado na API Central. */
  shortCode: string | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void; // refresh parent data after save
  /** Current server status — if "online" or "starting", form is disabled */
  serverStatus?: string;
}

export function ServerConfigModal({ serverDir, shortCode, isOpen, onClose, onSaved, serverStatus }: ServerConfigModalProps) {
  const { t } = useT();
  const [motd, setMotd] = useState('');
  const [gamemode, setGamemode] = useState('survival');
  const [difficulty, setDifficulty] = useState('easy');
  const [hardcore, setHardcore] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(20);
  const [whitelist, setWhitelist] = useState(false);
  const [pvp, setPvp] = useState(true);
  const [allowFlight, setAllowFlight] = useState(false);
  // Somente leitura: o level-seed só faz efeito na criação do mundo (que já
  // aconteceu quando este modal é aberto), então não é mais editável aqui —
  // ver campo de semente no CreateServerModal, usado na criação do servidor.
  const [currentSeed, setCurrentSeed] = useState('');
  const [allowNether, setAllowNether] = useState(true);
  const [spawnMonsters, setSpawnMonsters] = useState(true);
  const [spawnAnimals, setSpawnAnimals] = useState(true);
  const [spawnNpcs, setSpawnNpcs] = useState(true);
  const [viewDistance, setViewDistance] = useState(10);
  const [onlineMode, setOnlineMode] = useState(true);
  const [serverPort, setServerPort] = useState(25565);
  const [enforceSecureProfile, setEnforceSecureProfile] = useState(true);
  const [allocatedRam, setAllocatedRam] = useState(4);
  const [totalSystemRam, setTotalSystemRam] = useState(8);
  const [portError, setPortError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
  const [iconSaving, setIconSaving] = useState(false);
  const [iconError, setIconError] = useState('');

  // ------------------------------------------------------------
  // Link de convite (play.cubicase.net/<slug>)
  // ------------------------------------------------------------
  // Todo servidor já tem um link de graça (o próprio shortCode em minúsculas,
  // ver defaultSlugFor) — não exige login nem assinatura. Só quem tem o
  // Cubicase Plus pode TROCAR isso por um slug escolhido (checado de verdade
  // no Worker; `subscriptionActive` aqui só controla a UI, não é a fonte da
  // verdade). Fica neste modal (não nas configurações gerais) porque é uma
  // propriedade deste servidor, não da conta.
  const user = useAppStore((s) => s.user);
  const [subscriptionActive, setSubscriptionActive] = useState(false);
  const [customSlug, setCustomSlug] = useState<string | null>(null);
  const [slugLoading, setSlugLoading] = useState(false);
  const [slugInput, setSlugInput] = useState('');
  const [slugSubmitting, setSlugSubmitting] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [slugCopied, setSlugCopied] = useState(false);

  const defaultSlug = shortCode ? defaultSlugFor(shortCode) : null;

  // ------------------------------------------------------------
  // Endereço de conexão (<nome>.link.cubicase.net) — mesmo padrão do link de
  // convite acima, mas um campo INDEPENDENTE: o host pode ter um nome
  // diferente pro link de convite e pro endereço usado dentro do Minecraft.
  // Só vale pra convidados conectando pela mesh do próprio Cubicase (ver
  // comentário em src/lib/connectAddress.ts).
  // ------------------------------------------------------------
  const [customConnectName, setCustomConnectName] = useState<string | null>(null);
  const [connectNameLoading, setConnectNameLoading] = useState(false);
  const [connectNameInput, setConnectNameInput] = useState('');
  const [connectNameSubmitting, setConnectNameSubmitting] = useState(false);
  const [connectNameError, setConnectNameError] = useState<string | null>(null);
  const [connectNameCopied, setConnectNameCopied] = useState(false);

  const defaultConnectName = shortCode ? defaultConnectNameFor(shortCode) : null;

  useEffect(() => {
    if (!isOpen || !shortCode) return;
    setSlugError(null);
    setSlugLoading(true);
    setConnectNameError(null);
    setConnectNameLoading(true);
    Promise.all([
      user ? getSubscriptionStatus().catch(() => null) : Promise.resolve(null),
      getServerSlug(shortCode).catch(() => null),
      getServerConnectName(shortCode).catch(() => null),
    ]).then(([sub, slug, connectName]) => {
      const active = isSubscriptionActive(sub);
      setSubscriptionActive(active);
      setCustomSlug(slug);
      setSlugInput(slug ?? defaultSlugFor(shortCode));
      setCustomConnectName(connectName);
      setConnectNameInput(connectName ?? defaultConnectNameFor(shortCode));
    }).finally(() => {
      setSlugLoading(false);
      setConnectNameLoading(false);
    });
  }, [isOpen, shortCode, user]);

  const handleSaveSlug = async () => {
    if (!shortCode) return;
    const slug = slugInput.trim().toLowerCase();
    if (!isValidSlugFormat(slug)) {
      setSlugError(t("config.slugInvalid", { hint: slugFormatHint() }));
      return;
    }
    setSlugSubmitting(true);
    setSlugError(null);
    try {
      const saved = await setServerSlug(shortCode, slug);
      setCustomSlug(saved);
      setSlugInput(saved);
    } catch (err: any) {
      setSlugError(err?.message || t('config.slug.saveFailed'));
    } finally {
      setSlugSubmitting(false);
    }
  };

  const handleRemoveSlug = async () => {
    if (!shortCode) return;
    setSlugSubmitting(true);
    setSlugError(null);
    try {
      await removeServerSlug(shortCode);
      setCustomSlug(null);
      setSlugInput(defaultSlugFor(shortCode));
    } catch (err: any) {
      setSlugError(err?.message || t('config.slug.removeFailed'));
    } finally {
      setSlugSubmitting(false);
    }
  };

  const handleCopyInviteLink = () => {
    const slug = customSlug ?? defaultSlug;
    if (!slug) return;
    navigator.clipboard.writeText(inviteLinkUrl(slug));
    setSlugCopied(true);
    setTimeout(() => setSlugCopied(false), 1500);
  };

  const handleSaveConnectName = async () => {
    if (!shortCode) return;
    const name = connectNameInput.trim().toLowerCase();
    if (!isValidConnectNameFormat(name)) {
      setConnectNameError(t("config.connectNameInvalid", { hint: connectNameFormatHint() }));
      return;
    }
    setConnectNameSubmitting(true);
    setConnectNameError(null);
    try {
      const saved = await setConnectName(shortCode, name);
      setCustomConnectName(saved);
      setConnectNameInput(saved);
    } catch (err: any) {
      setConnectNameError(err?.message || t('config.connect.saveFailed'));
    } finally {
      setConnectNameSubmitting(false);
    }
  };

  const handleRemoveConnectName = async () => {
    if (!shortCode) return;
    setConnectNameSubmitting(true);
    setConnectNameError(null);
    try {
      await removeConnectName(shortCode);
      setCustomConnectName(null);
      setConnectNameInput(defaultConnectNameFor(shortCode));
    } catch (err: any) {
      setConnectNameError(err?.message || t('config.connect.removeFailed'));
    } finally {
      setConnectNameSubmitting(false);
    }
  };

  const handleCopyConnectAddress = () => {
    if (!shortCode) return;
    navigator.clipboard.writeText(connectAddressFor({ shortCode, connectName: customConnectName ?? defaultConnectName }, 25565));
    setConnectNameCopied(true);
    setTimeout(() => setConnectNameCopied(false), 1500);
  };

  useLockBodyScroll(isOpen);

  // Load current properties when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setLoadError('');
    setSaveError('');
    setIconError('');
    (async () => {
      try {
        const icon = await invoke<string | null>('get_server_icon', { serverDir });
        setIconDataUrl(icon);
      } catch (e) {
        console.warn('Could not load server icon:', e);
      }
      try {
        const props = await invoke<Record<string, any>>('read_server_properties', { serverDir });
        // All values come from Rust as strings — convert booleans and numbers explicitly
        setMotd(props.motd ?? '');
        setGamemode(props.gamemode ?? 'survival');
        setDifficulty(props.difficulty ?? 'easy');
        setHardcore(props.hardcore === 'true');
        setMaxPlayers(Number(props['max-players'] ?? 20));
        setWhitelist(props['white-list'] === 'true');
        setPvp(props.pvp !== 'false'); // default true
        setAllowFlight(props['allow-flight'] === 'true');
        setCurrentSeed(props['level-seed'] ?? '');
        setAllowNether(props['allow-nether'] !== 'false'); // default true
        setSpawnMonsters(props['spawn-monsters'] !== 'false'); // default true
        setSpawnAnimals(props['spawn-animals'] !== 'false'); // default true
        setSpawnNpcs(props['spawn-npcs'] !== 'false'); // default true
        setViewDistance(Number(props['view-distance'] ?? 10));
        setOnlineMode(props['online-mode'] !== 'false'); // default true
        setServerPort(Number(props['server-port'] ?? 25565));
        setEnforceSecureProfile(props['enforce-secure-profile'] !== 'false'); // default true
        setPortError('');

        // Load RAM from cubicase-meta.json
        try {
          const metaPath = await join(serverDir, 'cubicase-meta.json');
          const metaContent = await readTextFile(metaPath);
          const meta = JSON.parse(metaContent) as { ramGb?: number; totalRamGb?: number };
          if (typeof meta.ramGb === 'number' && meta.ramGb >= 2) {
            setAllocatedRam(meta.ramGb);
          }
          if (typeof meta.totalRamGb === 'number' && meta.totalRamGb > 0) {
            setTotalSystemRam(meta.totalRamGb);
          } else {
            // Try to get total system RAM
            try {
              const totalBytes = await invoke<number>('get_total_memory');
              setTotalSystemRam(Math.round(totalBytes / (1024 * 1024 * 1024)));
            } catch { /* ignore */ }
          }
        } catch (e) {
          console.warn('Could not read cubicase-meta.json, using defaults:', e);
          // If meta file doesn't exist, try to get total system RAM
          try {
            const totalBytes = await invoke<number>('get_total_memory');
            setTotalSystemRam(Math.round(totalBytes / (1024 * 1024 * 1024)));
          } catch { /* ignore */ }
          setAllocatedRam(4);
        }
      } catch (e) {
        console.error('Failed to read server properties:', e);
        // Sem os valores reais, o formulário ficaria com defaults genéricos —
        // bloquear "Salvar" para não sobrescrever o server.properties real com lixo.
        setLoadError(t('config.loadFailed', { error: String(e) }));
      }
    })();
  }, [isOpen, serverDir]);

  const handleSave = async () => {
    if (loadError) return;

    // Validate server port
    if (serverPort < 1024 || serverPort > 65535) {
      setPortError(t('config.portRange'));
      return;
    }
    setPortError('');
    setSaveError('');

    // All values must be strings — the Rust command expects HashMap<String, String>
    const properties: Record<string, string> = {
      motd,
      gamemode,
      difficulty,
      hardcore: String(hardcore),
      'max-players': String(maxPlayers),
      'white-list': String(whitelist),
      pvp: String(pvp),
      'allow-flight': String(allowFlight),
      'allow-nether': String(allowNether),
      'spawn-monsters': String(spawnMonsters),
      'spawn-animals': String(spawnAnimals),
      'spawn-npcs': String(spawnNpcs),
      'view-distance': String(viewDistance),
      'online-mode': String(onlineMode),
      'server-port': String(serverPort),
      'enforce-secure-profile': String(enforceSecureProfile),
    };
    try {
      await invoke('write_server_properties', { serverDir, props: properties });

      // Also save RAM allocation to cubicase-meta.json
      try {
        const metaPath = await join(serverDir, 'cubicase-meta.json');
        const metaContent = await readTextFile(metaPath);
        const meta = JSON.parse(metaContent);
        meta.ramGb = allocatedRam;
        await writeTextFile(metaPath, JSON.stringify(meta, null, 2));
        console.log(`RAM saved: ${allocatedRam}GB -> ${metaPath}`);
      } catch (e) {
        // If meta file doesn't exist, create it
        console.warn('Could not update existing meta file, creating new one:', e);
        try {
          const metaPath = await join(serverDir, 'cubicase-meta.json');
          await writeTextFile(metaPath, JSON.stringify({ ramGb: allocatedRam }, null, 2));
          console.log(`RAM saved (new file): ${allocatedRam}GB -> ${metaPath}`);
        } catch (e2) {
          console.error('Failed to save RAM allocation:', e2);
        }
      }

      onSaved();
      onClose();
    } catch (e) {
      console.error('Failed to write server properties:', e);
      setSaveError(t('config.saveFailed', { error: String(e) }));
    }
  };

  const handlePickIcon = async () => {
    const selected = await open({
      multiple: false,
      title: t('config.icon.dialogTitle'),
      filters: [{ name: t('config.icon.filterName'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    });
    if (!selected) return;
    setIconError('');
    setIconSaving(true);
    try {
      await invoke('set_server_icon', { serverDir, imagePath: selected as string });
      const icon = await invoke<string | null>('get_server_icon', { serverDir });
      setIconDataUrl(icon);
    } catch (e) {
      console.error('Failed to set server icon:', e);
      setIconError(t('config.icon.setFailed', { error: String(e) }));
    } finally {
      setIconSaving(false);
    }
  };

  const handleRemoveIcon = async () => {
    setIconError('');
    setIconSaving(true);
    try {
      await invoke('remove_server_icon', { serverDir });
      setIconDataUrl(null);
    } catch (e) {
      console.error('Failed to remove server icon:', e);
      setIconError(t('config.icon.removeFailed', { error: String(e) }));
    } finally {
      setIconSaving(false);
    }
  };

  const isServerRunning = serverStatus === "online" || serverStatus === "starting" || serverStatus === "stopping";
  const formDisabled = isServerRunning || !!loadError;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onClose} />
          {/* Modal */}
          <motion.div
            className="relative w-full max-w-lg bg-theme-card rounded-[2rem] border-theme-card shadow-2xl z-10 space-y-6 max-h-[85vh] flex flex-col"
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: 'spring', duration: 0.3 }}
          >
            <div className="p-8 pb-0 flex-shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-theme-primary">{t("serverSettings.button")}</h3>
                <button type="button" onClick={onClose} className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer" title={t("common.cancel")}>
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
              {loadError && (
                <div className="p-4 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-2xl flex items-start gap-3 text-sm mb-4">
                  <AlertTriangle className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">{t("config.loadError.title")}</span> {t("config.loadError.body")}
                    <div className="mt-1 text-xs opacity-80">{loadError}</div>
                  </div>
                </div>
              )}

              {saveError && (
                <div className="p-4 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-2xl flex items-start gap-3 text-sm mb-4">
                  <AlertTriangle className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" />
                  <div>{saveError}</div>
                </div>
              )}

              {isServerRunning && (
                <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl flex items-start gap-3 text-sm mb-4">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">{t("config.running.title")}</span> {t("config.running.body")}
                  </div>
                </div>
              )}

              {/* Link de convite — não faz parte do <form> de server.properties: é
                  salvo na hora, direto na API Central, sem precisar do botão "Salvar". */}
              {shortCode && (
                <div className="mb-4 p-4 bg-theme-muted border border-theme-card rounded-2xl space-y-2.5">
                  <label className="flex items-center gap-1.5 text-sm font-medium text-theme-primary">
                    <LinkIcon className="w-4 h-4" /> {t("config.slug.title")}
                  </label>
                  {slugLoading ? (
                    <p className="text-[10px] text-theme-secondary">{t("config.loading")}</p>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <div className="flex-1 flex items-center h-11 px-3 rounded-xl border border-theme-card bg-theme-card overflow-hidden">
                          <span className="text-[11px] text-theme-secondary whitespace-nowrap">play.cubicase.net/</span>
                          <input
                            type="text"
                            value={slugInput}
                            disabled={!subscriptionActive || slugSubmitting}
                            onChange={(e) => setSlugInput(e.target.value.toLowerCase())}
                            className="flex-1 min-w-0 bg-transparent focus:outline-none text-sm text-theme-primary font-mono disabled:opacity-70 disabled:cursor-not-allowed"
                          />
                        </div>
                        {subscriptionActive && (
                          <button
                            type="button"
                            onClick={handleSaveSlug}
                            disabled={slugSubmitting || !slugInput.trim() || slugInput.trim() === (customSlug ?? defaultSlug)}
                            className="h-11 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-xs rounded-xl transition-colors cursor-pointer flex-shrink-0"
                          >
                            {slugSubmitting ? t("config.saving") : t("config.save")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleCopyInviteLink}
                          className="h-11 px-3 bg-theme-card border border-theme-card hover:bg-theme-muted text-theme-primary rounded-xl transition-colors cursor-pointer flex-shrink-0 flex items-center gap-1.5 text-xs font-semibold"
                          title={t("config.copyLink")}
                        >
                          {slugCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>

                      {!subscriptionActive ? (
                        <p className="text-[10px] text-theme-secondary">
                          {t("config.slug.freeSubscribe")}
                        </p>
                      ) : customSlug ? (
                        <button
                          type="button"
                          onClick={handleRemoveSlug}
                          disabled={slugSubmitting}
                          className="text-xs font-semibold text-rose-500 hover:text-rose-600 disabled:opacity-50 transition-colors cursor-pointer"
                        >
                          {t("config.slug.reset")}
                        </button>
                      ) : (
                        <p className="text-[10px] text-theme-secondary">
                          {t("config.slug.freeChoose")}
                        </p>
                      )}
                    </>
                  )}
                  {slugError && <p className="text-[10px] text-rose-500">{slugError}</p>}
                </div>
              )}

              {/* Endereço de conexão — mesmo esquema do link de convite acima (salvo
                  na hora, fora do <form>), mas um campo independente: o nome aqui não
                  precisa ser igual ao do link de convite. Só vale pra convidados
                  conectando pela mesh do próprio Cubicase. */}
              {shortCode && (
                <div className="mb-4 p-4 bg-theme-muted border border-theme-card rounded-2xl space-y-2.5">
                  <label className="flex items-center gap-1.5 text-sm font-medium text-theme-primary">
                    <Gamepad2 className="w-4 h-4" /> {t("config.connect.title")}
                  </label>
                  {connectNameLoading ? (
                    <p className="text-[10px] text-theme-secondary">{t("config.loading")}</p>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <div className="flex-1 flex items-center h-11 px-3 rounded-xl border border-theme-card bg-theme-card overflow-hidden">
                          <input
                            type="text"
                            value={connectNameInput}
                            disabled={!subscriptionActive || connectNameSubmitting}
                            onChange={(e) => setConnectNameInput(e.target.value.toLowerCase())}
                            className="flex-1 min-w-0 bg-transparent focus:outline-none text-sm text-theme-primary font-mono disabled:opacity-70 disabled:cursor-not-allowed"
                          />
                          <span className="text-[11px] text-theme-secondary whitespace-nowrap">.{CONNECT_NAME_DOMAIN}</span>
                        </div>
                        {subscriptionActive && (
                          <button
                            type="button"
                            onClick={handleSaveConnectName}
                            disabled={connectNameSubmitting || !connectNameInput.trim() || connectNameInput.trim() === (customConnectName ?? defaultConnectName)}
                            className="h-11 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-xs rounded-xl transition-colors cursor-pointer flex-shrink-0"
                          >
                            {connectNameSubmitting ? t("config.saving") : t("config.save")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleCopyConnectAddress}
                          className="h-11 px-3 bg-theme-card border border-theme-card hover:bg-theme-muted text-theme-primary rounded-xl transition-colors cursor-pointer flex-shrink-0 flex items-center gap-1.5 text-xs font-semibold"
                          title={t("config.copyAddress")}
                        >
                          {connectNameCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>

                      {!subscriptionActive ? (
                        <p className="text-[10px] text-theme-secondary">
                          {t("config.connect.freeSubscribe")}
                        </p>
                      ) : customConnectName ? (
                        <button
                          type="button"
                          onClick={handleRemoveConnectName}
                          disabled={connectNameSubmitting}
                          className="text-xs font-semibold text-rose-500 hover:text-rose-600 disabled:opacity-50 transition-colors cursor-pointer"
                        >
                          {t("config.connect.reset")}
                        </button>
                      ) : (
                        <p className="text-[10px] text-theme-secondary">
                          {t("config.connect.freeChoose")}
                        </p>
                      )}
                    </>
                  )}
                  {connectNameError && <p className="text-[10px] text-rose-500">{connectNameError}</p>}
                </div>
              )}

              <form className="space-y-4 pb-4" onSubmit={e => { e.preventDefault(); handleSave(); }}>
                {/* Ícone do Servidor */}
                <div>
                  <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.icon.title")}</label>
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-xl overflow-hidden border border-theme-card bg-theme-muted flex items-center justify-center flex-shrink-0">
                      {iconDataUrl ? (
                        <img src={iconDataUrl} alt={t("config.icon.alt")} className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon className="w-6 h-6 text-theme-secondary" />
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handlePickIcon}
                          disabled={iconSaving}
                          className="px-4 h-9 rounded-xl bg-theme-muted hover:bg-theme-card text-theme-primary text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {iconDataUrl ? t('config.icon.change') : t('config.icon.choose')}
                        </button>
                        {iconDataUrl && (
                          <button
                            type="button"
                            onClick={handleRemoveIcon}
                            disabled={iconSaving}
                            className="px-4 h-9 rounded-xl text-rose-500 hover:bg-theme-danger text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                          >
                            {t("config.icon.remove")}
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-theme-secondary">
                        {t("config.icon.hint")}
                        {isServerRunning && ` ${t("config.icon.restartHint")}`}
                      </p>
                    </div>
                  </div>
                  {iconError && (
                    <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> {iconError}
                    </p>
                  )}
                </div>
                {/* MOTD */}
                <div>
                  <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.motd")}</label>
                  <input
                    type="text"
                    value={motd}
                    onChange={e => setMotd(e.target.value)}
                    disabled={formDisabled}
                    className="w-full rounded-2xl border border-theme-card bg-transparent px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>
                {/* Gamemode & Difficulty */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.gamemode")}</label>
                    <select
                      value={gamemode}
                      onChange={e => setGamemode(e.target.value)}
                      disabled={formDisabled || hardcore}
                      className="w-full rounded-2xl border border-theme-card bg-theme-card px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="survival">{t("config.gamemode.survival")}</option>
                      <option value="creative">{t("config.gamemode.creative")}</option>
                      <option value="adventure">{t("config.gamemode.adventure")}</option>
                      <option value="spectator">{t("config.gamemode.spectator")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.difficulty")}</label>
                    <select
                      value={difficulty}
                      onChange={e => setDifficulty(e.target.value)}
                      disabled={formDisabled || hardcore}
                      className="w-full rounded-2xl border border-theme-card bg-theme-card px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="peaceful">{t("config.difficulty.peaceful")}</option>
                      <option value="easy">{t("config.difficulty.easy")}</option>
                      <option value="normal">Normal</option>
                      <option value="hard">{t("config.difficulty.hard")}</option>
                    </select>
                  </div>
                </div>
                {/* Toggles */}
                <div className="grid grid-cols-2 gap-4">
                  <label className="inline-flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={hardcore}
                      onChange={e => {
                        const checked = e.target.checked;
                        setHardcore(checked);
                        if (checked) {
                          setGamemode('survival');
                          setDifficulty('hard');
                        }
                      }}
                      disabled={formDisabled}
                      className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <span className="text-sm text-theme-primary">{t("config.toggle.hardcore")}</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={whitelist} onChange={e => setWhitelist(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">{t("config.toggle.whitelist")}</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={pvp} onChange={e => setPvp(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">PVP</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={allowFlight} onChange={e => setAllowFlight(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">{t("config.toggle.allowFlight")}</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={allowNether} onChange={e => setAllowNether(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">{t("config.toggle.allowNether")}</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={spawnMonsters} onChange={e => setSpawnMonsters(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">{t("config.toggle.spawnMonsters")}</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={spawnAnimals} onChange={e => setSpawnAnimals(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">{t("config.toggle.spawnAnimals")}</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={spawnNpcs} onChange={e => setSpawnNpcs(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">{t("config.toggle.spawnNpcs")}</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={onlineMode} onChange={e => setOnlineMode(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">{t("config.toggle.onlineMode")}</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={enforceSecureProfile} onChange={e => setEnforceSecureProfile(e.target.checked)} disabled={formDisabled} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">{t("config.toggle.secureProfile")}</span>
                  </label>
                </div>
                {/* Numeric fields */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.maxPlayers")}</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={maxPlayers}
                      onChange={e => setMaxPlayers(Number(e.target.value))}
                      disabled={formDisabled}
                      className="w-full rounded-2xl border border-theme-card bg-transparent px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.port")}</label>
                    <input
                      type="number"
                      value={serverPort}
                      onChange={e => setServerPort(Number(e.target.value))}
                      disabled={formDisabled}
                      className={cn(
                        "w-full rounded-2xl border px-3 py-2 focus:outline-none transition-colors bg-transparent text-theme-primary",
                        portError
                          ? "border-rose-400 focus:border-rose-500 bg-rose-50 dark:bg-rose-900/20"
                          : "border-theme-card focus:border-indigo-500",
                        formDisabled && "opacity-50 cursor-not-allowed"
                      )}
                    />
                    {portError && (
                      <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {portError}
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.seed")}</label>
                    <div className="w-full rounded-2xl border border-theme-card bg-theme-muted px-3 py-2 text-theme-secondary text-sm font-mono truncate">
                      {currentSeed || <span className="italic">{t("config.seed.random")}</span>}
                    </div>
                    <p className="mt-1 text-[10px] text-theme-secondary">
                      {t("config.seed.hint")}
                    </p>
                  </div>
                </div>
                {/* View Distance Slider */}
                <div>
                  <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.viewDistance")}</label>
                  <div className="flex items-center space-x-4">
                    <input
                      type="range"
                      min={4}
                      max={32}
                      step={1}
                      value={viewDistance}
                      onChange={e => setViewDistance(Number(e.target.value))}
                      disabled={formDisabled}
                      className="flex-1 accent-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <span className="w-12 text-center font-medium text-theme-primary">{viewDistance}</span>
                  </div>
                </div>
                {/* RAM Allocation Slider */}
                <div>
                  <label className="block text-sm font-medium text-theme-primary mb-1">{t("config.ram")}</label>
                  <div className="flex items-center space-x-4">
                    <input
                      type="range"
                      min={2}
                      max={Math.max(2, totalSystemRam - 1)}
                      step={1}
                      value={allocatedRam}
                      onChange={e => setAllocatedRam(Number(e.target.value))}
                      disabled={formDisabled}
                      className="flex-1 accent-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <span className="w-16 text-center font-medium text-theme-primary font-mono">{allocatedRam} GB</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-theme-secondary mt-1">
                    <span>{t("config.ramMin")}</span>
                    <span>{t("config.ramTotal", { total: totalSystemRam })}</span>
                  </div>
                  {allocatedRam < 3 && (
                    <div className="mt-2 p-2.5 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 text-[10px] rounded-xl flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>{t("config.ram.warnLabel")}</strong> {t("config.ram.warnLow")}
                      </span>
                    </div>
                  )}
                  {totalSystemRam - allocatedRam < 2 && (
                    <div className="mt-2 p-2.5 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 text-[10px] rounded-xl flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>{t("config.ram.dangerLabel")}</strong> {t("config.ram.dangerHigh")}
                      </span>
                    </div>
                  )}
                </div>
              </form>
            </div>

            {/* Action buttons */}
            <div className="p-8 pt-0 flex-shrink-0">
              <div className="flex justify-end space-x-3 pt-4 border-t border-theme-card">
                <button type="button" onClick={onClose} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold cursor-pointer">
                  {t("common.cancel")}
                </button>
                <button type="submit" disabled={formDisabled} onClick={handleSave} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-theme-shadow cursor-pointer">
                  <Check className="w-4 h-4" /> {t("config.save")}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
