"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  X,
  Server,
  Globe,
  WifiOff,
  Clock,
  Users,
  Trash2,
  Loader2,
  AlertTriangle,
  Zap,
  Copy,
  Check,
  RefreshCw,
  Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { useAppStore, type KnownServer, type ServerStatus } from "@/app/store";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { installFabricClient, installForgeClient, getInstanceDir } from "@/lib/clientSetup";

/** Tipos de servidor cobertos pelo fluxo "Jogar" (abrir o launcher já pronto). */
const PLAYABLE_SERVER_TYPES = new Set(["vanilla", "paper", "fabric", "forge", "neoforge"]);

/** Loaders que precisam de instância isolada (mods/config/saves fora do .minecraft/mods compartilhado). */
const ISOLATED_SERVER_TYPES = new Set(["fabric", "forge", "neoforge"]);

// ============================================================
// GuestView
// ============================================================
// Biblioteca pessoal de servidores conhecidos.
// O usuário adiciona servidores uma única vez via código de
// convite, e eles ficam salvos permanentemente.
// ============================================================

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

interface GuestViewProps {
  netStatus: "offline" | "connecting" | "online";
  minecraftPort: number;
  onConnect: (inviteCode: string) => void;
  onDisconnect: () => void;
}

export function GuestView({
  netStatus,
  minecraftPort,
  onConnect,
  onDisconnect,
}: GuestViewProps) {
  const {
    knownServers,
    addKnownServer,
    removeKnownServer,
    updateKnownServerStatus,
    localServers,
  } = useAppStore();

  const [showAddModal, setShowAddModal] = useState(false);
  useLockBodyScroll(showAddModal);
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [connectedShortCode, setConnectedShortCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Contador de tempo online é calculado localmente (a partir de onlineSince) e
  // precisa de um "tick" próprio para atualizar a UI a cada segundo, já que o
  // polling da API Central acontece só a cada 30s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // `handleConnect` marca connectedShortCode otimisticamente antes da conexão real
  // (assíncrona, tratada em page.tsx) terminar. Se ela falhar ou cair depois, netStatus
  // volta para "offline" — sem isso, o card ficava travado mostrando "Desconectar"
  // até o usuário clicar manualmente.
  useEffect(() => {
    if (netStatus === "offline" && connectedShortCode !== null) {
      setConnectedShortCode(null);
    }
  }, [netStatus, connectedShortCode]);

  // Status do fluxo "Jogar" (Vanilla/Paper/Fabric/Forge/NeoForge) por servidor
  // — instala o mod loader se precisar e abre o Minecraft Launcher já com o
  // perfil certo selecionado, assim que o túnel sobe. `launcherTriggeredFor`
  // evita disparar de novo a cada re-render enquanto a mesma conexão segue online.
  const [launcherMessage, setLauncherMessage] = useState<Record<string, string>>({});
  const [launcherProgress, setLauncherProgress] = useState<Record<string, number>>({});
  const launcherTriggeredFor = useRef<string | null>(null);

  const loaderLabel = (serverType: string): string =>
    serverType === "neoforge" ? "NeoForge" : serverType === "forge" ? "Forge" : "Fabric";

  const handleOpenLauncher = async (server: KnownServer) => {
    const setStatus = (status: string, percent?: number) => {
      setLauncherMessage(prev => ({ ...prev, [server.shortCode]: status }));
      if (percent !== undefined) setLauncherProgress(prev => ({ ...prev, [server.shortCode]: percent }));
    };

    setStatus("Preparando o Minecraft...", 0);
    try {
      let versionId = server.version ?? "";
      let alreadyInstalled = false;
      let gameDir: string | null = null;

      if (server.serverType === "fabric") {
        gameDir = await getInstanceDir(server.shortCode);
        versionId = await installFabricClient(server.version, (p) => setStatus(p.status, p.percent));
      } else if (server.serverType === "forge" || server.serverType === "neoforge") {
        if (!server.forgeVersion) {
          setStatus(`Não sabemos qual versão do ${loaderLabel(server.serverType)} esse servidor usa — abra o Minecraft manualmente e conecte em localhost:${minecraftPort}.`);
          return;
        }
        gameDir = await getInstanceDir(server.shortCode);
        versionId = await installForgeClient(server.serverType, server.version, server.forgeVersion, (p) => setStatus(p.status, p.percent));
      } else {
        const installed = await invoke<string[]>("find_installed_minecraft_versions").catch(() => [] as string[]);
        alreadyInstalled = !!server.version && installed.includes(server.version);
      }

      setStatus("Selecionando o perfil no launcher...", 92);
      const prepResult = await invoke<string>("prepare_launcher_profile", {
        versionId,
        profileName: `Cubicase — ${server.name}`,
        gameDir,
      });

      if (prepResult === "not_found") {
        setStatus(`Não encontramos sua instalação do Minecraft — abra o jogo e conecte em localhost:${minecraftPort} manualmente.`);
        return;
      }

      await invoke("open_minecraft_launcher");
      setStatus(
        ISOLATED_SERVER_TYPES.has(server.serverType)
          ? `${loaderLabel(server.serverType)} instalado e perfil selecionado — é só clicar em Play!`
          : alreadyInstalled
            ? "Minecraft aberto com o perfil certo selecionado — é só clicar em Play!"
            : "Minecraft aberto! O launcher vai baixar essa versão automaticamente ao clicar em Play.",
        100
      );
    } catch (err) {
      console.warn("[GuestView] Falha ao preparar o Minecraft automaticamente:", err);
      setStatus(`Não conseguimos preparar o Minecraft automaticamente — abra manualmente e conecte em localhost:${minecraftPort}.`);
    }
  };

  // Assim que o túnel de um servidor Vanilla/Paper/Fabric sobe, prepara e abre
  // o launcher sozinho — para os demais tipos (Forge/NeoForge) ainda não
  // instalamos o mod loader certo automaticamente, então não prometemos nada.
  useEffect(() => {
    if (netStatus !== "online" || !connectedShortCode) {
      launcherTriggeredFor.current = null;
      return;
    }
    if (launcherTriggeredFor.current === connectedShortCode) return;

    const server = knownServers.find(s => s.shortCode === connectedShortCode);
    if (!server || !PLAYABLE_SERVER_TYPES.has(server.serverType)) return;

    launcherTriggeredFor.current = connectedShortCode;
    void handleOpenLauncher(server);
  }, [netStatus, connectedShortCode, knownServers]);

  // Sincronizar servidores locais do host na biblioteca do guest
  // Adiciona servidores locais novos e remove os que foram deletados
  useEffect(() => {
    const localShortCodes = new Set(
      localServers.filter(s => s.shortCode).map(s => s.shortCode!)
    );

    // Adicionar servidores locais novos que ainda não estão na lista
    for (const server of localServers) {
      if (!server.shortCode) continue;
      const exists = knownServers.find(s => s.shortCode === server.shortCode);
      if (!exists) {
        addKnownServer({
          shortCode: server.shortCode,
          name: server.name,
          version: server.version || "1.20.1",
          serverType: server.serverType || "vanilla",
          description: server.description || `Servidor Minecraft Vanilla ${server.version || "1.20.1"}`,
          status: "offline",
          port: 25565,
          maxPlayers: 20,
          currentPlayers: 0,
          lastSeenOnline: null,
          onlineSince: null,
          lastConfirmedAt: null,
          addedAt: new Date().toISOString(),
          isOwnServer: true,
          networkProvider: "tailscale",
          forgeVersion: server.forgeVersion ?? null,
          modLoaderVersion: server.modLoaderVersion ?? null,
        });
      }
    }

    // Remover servidores "Meu" que foram deletados localmente
    // (isOwnServer=true mas não existe mais em localServers)
    const serversToRemove = knownServers.filter(
      s => s.isOwnServer && !localShortCodes.has(s.shortCode)
    );
    for (const s of serversToRemove) {
      removeKnownServer(s.shortCode);
    }
  }, [localServers]);

  // Atualizar status de todos os servidores conhecidos ao abrir
  useEffect(() => {
    refreshAllServers();
  }, []);

  // Atualizar status periodicamente (a cada 30 segundos)
  useEffect(() => {
    const interval = setInterval(() => {
      refreshAllServers(true);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const refreshAllServers = async (silent = false) => {
    if (knownServers.length === 0) return;
    if (!silent) setIsRefreshing(true);

    let hasError = false;
    for (const server of knownServers) {
      try {
        // Consultar API Central para obter status do servidor
        const response = await fetch(`${API_BASE}/api/v1/servers/${server.shortCode}`);
        if (response.ok) {
          // A API Central responde envelopado: os dados reais ficam em data.server
          // (metadados) e data.session (status/jogadores) — não no nível raiz.
          const envelope = await response.json();
          // session vem null quando o host nunca teve uma sessão ativa (ou ela expirou) —
          // trata como "offline" em vez de deixar o status como undefined.
          const session = envelope?.data?.session ?? {};
          const status = (session.status ?? "offline") as ServerStatus;
          console.log(`[GuestView] Servidor ${server.shortCode} (${server.name}): status da API = ${status}`);
          updateKnownServerStatus(
            server.shortCode,
            status,
            session.currentPlayers ?? undefined
          );
        } else {
          console.warn(`[GuestView] Servidor ${server.shortCode}: API retornou HTTP ${response.status}`);
          // Servidor não encontrado na API (removido pelo host)
          if (response.status === 404) {
            updateKnownServerStatus(server.shortCode, "offline");
          }
        }
      } catch (err) {
        console.error(`[GuestView] Erro ao consultar servidor ${server.shortCode}:`, err);
        hasError = true;
      }
    }

    if (hasError) {
      setIsOfflineMode(true);
    } else {
      setIsOfflineMode(false);
    }

    setLastRefreshTime(new Date());
    if (!silent) setIsRefreshing(false);
  };

  const handleAddServer = async () => {
    const code = inviteCodeInput.replace("CF-", "").trim();
    if (!code) {
      setAddError("Insira um código de convite.");
      return;
    }

    // Verificar se já existe
    if (knownServers.find(s => s.shortCode === code)) {
      setAddError("Este servidor já está na sua biblioteca.");
      return;
    }

    setIsAdding(true);
    setAddError(null);

    try {
      const response = await fetch(`${API_BASE}/api/v1/servers/${code}`);
      if (!response.ok) {
        setAddError("Servidor não encontrado. Verifique o código e tente novamente.");
        setIsAdding(false);
        return;
      }

      // Envelope da API Central: metadados em data.server, status/jogadores em data.session.
      const envelope = await response.json();
      const server = envelope?.data?.server ?? {};
      const session = envelope?.data?.session ?? {};
      addKnownServer({
        shortCode: server.shortCode,
        name: server.name,
        version: server.version,
        serverType: server.serverType || "vanilla",
        description: server.description || `Servidor Minecraft ${server.version}`,
        status: session.status || "offline",
        port: session.port || 25565,
        maxPlayers: session.maxPlayers || 20,
        currentPlayers: session.currentPlayers || 0,
        lastSeenOnline: session.status === "online" ? new Date().toISOString() : null,
        onlineSince: session.status === "online" ? new Date().toISOString() : null,
        lastConfirmedAt: new Date().toISOString(),
        addedAt: new Date().toISOString(),
        isOwnServer: false,
        networkProvider: session.provider || "tailscale",
        forgeVersion: server.forgeVersion ?? null,
        modLoaderVersion: server.modLoaderVersion ?? null,
      });

      setShowAddModal(false);
      setInviteCodeInput("");
    } catch {
      setAddError("Não foi possível conectar à API Central. Verifique sua conexão com a internet.");
    } finally {
      setIsAdding(false);
    }
  };

  const handleConnect = (server: KnownServer) => {
    if (server.status !== "online" || isServerStale(server)) return;
    setConnectedShortCode(server.shortCode);
    onConnect(`CF-${server.shortCode}`);
  };

  const handleDisconnect = () => {
    setConnectedShortCode(null);
    onDisconnect();
  };

  const handleRemoveServer = (shortCode: string) => {
    if (connectedShortCode === shortCode) {
      handleDisconnect();
    }
    removeKnownServer(shortCode);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatLastSeen = (iso: string | null): string => {
    if (!iso) return "Nunca";
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "Agora mesmo";
    if (minutes < 60) return `Há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Há ${hours}h`;
    const days = Math.floor(hours / 24);
    return `Há ${days}d`;
  };

  // Tempo online desde a última vez que o status transicionou para "online"
  // (calculado localmente a partir de onlineSince, sem depender do host).
  const formatUptime = (iso: string | null): string => {
    if (!iso) return "0min";
    const diff = Math.max(0, now - new Date(iso).getTime());
    const totalMinutes = Math.floor(diff / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 1) return `${minutes}min`;
    return `${hours}h${minutes.toString().padStart(2, "0")}min`;
  };

  // Um servidor é considerado "obsoleto" se a última confirmação da API Central
  // foi há mais tempo do que alguns ciclos de polling (30s cada). Sem isso, um
  // status cacheado (ex: "online") continuaria sendo exibido como verdade mesmo
  // que a API esteja fora do ar ou as requisições estejam falhando repetidamente —
  // o que passaria informação falsa para o convidado.
  const STALE_THRESHOLD_MS = 100_000; // ~3 ciclos de 30s
  const isServerStale = (server: KnownServer): boolean => {
    if (!server.lastConfirmedAt) return true;
    return Date.now() - new Date(server.lastConfirmedAt).getTime() > STALE_THRESHOLD_MS;
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case "online": return "bg-emerald-500";
      case "starting": return "bg-amber-500";
      case "stopping": return "bg-orange-500";
      case "crashed": return "bg-rose-500";
      default: return "bg-slate-400";
    }
  };

  const getStatusLabel = (status: string): string => {
    switch (status) {
      case "online": return "Online";
      case "starting": return "Iniciando";
      case "stopping": return "Encerrando";
      case "crashed": return "Erro";
      default: return "Offline";
    }
  };

  const isConnecting = netStatus === "connecting";
  const isOnline = netStatus === "online";

  return (
    <div className="space-y-6">
      {/* Cabeçalho da Biblioteca */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <h2 className="text-3xl font-bold text-theme-primary flex items-center gap-3">
            <Globe className="w-7 h-7 text-indigo-600" />
            Servidores Conhecidos
          </h2>
          <p className="text-theme-secondary text-sm">
            {knownServers.length === 0
              ? "Adicione servidores usando o código de convite para começar."
              : `${knownServers.length} servidor${knownServers.length !== 1 ? "es" : ""} na sua biblioteca`}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Indicador de modo offline */}
          {isOfflineMode && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-xl text-[10px] font-bold text-amber-600 dark:text-amber-400">
              <WifiOff className="w-3 h-3" />
              Offline
            </div>
          )}

          {/* Última atualização */}
          {lastRefreshTime && (
            <span className="text-[10px] text-theme-secondary font-mono">
              {lastRefreshTime.toLocaleTimeString()}
            </span>
          )}

          {/* Botão atualizar */}
          <button
            type="button"
            onClick={() => refreshAllServers()}
            disabled={isRefreshing}
            className="p-2 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors disabled:opacity-50 cursor-pointer"
            title="Atualizar status"
          >
            <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
          </button>

          {/* Botão adicionar servidor */}
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="h-11 px-5 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-all text-sm font-bold flex items-center gap-2 shadow-md shadow-theme-shadow active:scale-95 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Adicionar Servidor
          </button>
        </div>
      </div>

      {/* Aviso de modo offline */}
      {isOfflineMode && knownServers.length > 0 && (
        <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl flex items-center gap-3 text-xs">
          <WifiOff className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span>
            Sem conexão com a API Central. As informações podem estar desatualizadas.
            Os status exibidos são do último snapshot salvo.
          </span>
        </div>
      )}

      {/* Lista de Servidores */}
      {knownServers.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-theme-card rounded-[2rem] border-theme-card shadow-theme-card p-16 text-center space-y-6"
        >
          <div className="w-20 h-20 bg-indigo-100 dark:bg-indigo-900/30 rounded-[2rem] flex items-center justify-center mx-auto">
            <Globe className="w-10 h-10 text-indigo-600" />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-theme-primary">Sua Biblioteca está vazia</h3>
            <p className="text-theme-secondary text-sm max-w-md mx-auto leading-relaxed">
              Adicione servidores usando o código de convite compartilhado pelos hosts.
              Você só precisa do código uma única vez — depois disso, o servidor fica salvo aqui.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="h-12 px-8 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-all text-sm font-bold flex items-center gap-2 mx-auto shadow-md shadow-theme-shadow active:scale-95 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Adicionar Primeiro Servidor
          </button>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {knownServers.map((server, index) => {
            const stale = isServerStale(server);
            return (
            <motion.div
              key={server.shortCode}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className={cn(
                "bg-theme-card rounded-[2rem] border shadow-theme-card overflow-hidden transition-all duration-300 hover:shadow-lg",
                connectedShortCode === server.shortCode
                  ? "border-emerald-400 dark:border-emerald-600 ring-2 ring-emerald-400/30"
                  : "border-theme-card hover:border-indigo-200 dark:hover:border-indigo-800"
              )}
            >
              {/* Topo do card */}
              <div className="p-5 space-y-3">
                {/* Badges */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {/* Status indicator */}
                    <div className={cn(
                      "w-2.5 h-2.5 rounded-full",
                      stale ? "bg-slate-400" : getStatusColor(server.status),
                      !stale && server.status === "online" && "animate-pulse"
                    )} />
                    <span className={cn(
                      "text-[10px] font-bold uppercase tracking-wider",
                      stale ? "text-theme-secondary" :
                      server.status === "online" ? "text-emerald-600 dark:text-emerald-400" :
                      server.status === "crashed" ? "text-rose-600 dark:text-rose-400" :
                      "text-theme-secondary"
                    )} title={stale ? "Não foi possível confirmar o status recentemente com a API Central" : undefined}>
                      {/* Status desatualizado: não sabemos mais se ainda é verdade, então
                          não afirmamos online/offline — só que não está confirmado. */}
                      {stale ? "Não confirmado" : getStatusLabel(server.status)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {/* Badge "Meu Servidor" */}
                    {server.isOwnServer && (
                      <span className="text-[9px] font-bold text-indigo-600 uppercase tracking-wider bg-indigo-100 dark:bg-indigo-900/30 px-2 py-0.5 rounded-full">
                        Meu
                      </span>
                    )}
                    {/* Badge de tipo com cor */}
                    <span className={cn(
                      "text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full",
                      server.serverType === "forge" ? "text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/30" :
                      server.serverType === "neoforge" ? "text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/30" :
                      server.serverType === "fabric" ? "text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/30" :
                      server.serverType === "paper" ? "text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/30" :
                      "text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/30"
                    )}>
                      {server.serverType}
                    </span>
                  </div>
                </div>

                {/* Nome e descrição */}
                <div>
                  <h3 className="text-lg font-bold text-theme-primary truncate">
                    {server.name}
                  </h3>
                  {server.description && (
                    <p className="text-xs text-theme-secondary mt-0.5 line-clamp-2">
                      {server.description}
                    </p>
                  )}
                </div>

                {/* Metadados */}
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-theme-secondary">
                  <span className="flex items-center gap-1">
                    <Server className="w-3 h-3" />
                    Vanilla {server.version}
                  </span>
                  {server.currentPlayers !== undefined && server.status === "online" && (
                    <span className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {server.currentPlayers}/{server.maxPlayers} jogadores
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {server.status === "online" && !stale
                      ? `Online há ${formatUptime(server.onlineSince)}`
                      : formatLastSeen(server.lastSeenOnline)}
                  </span>
                </div>

                {/* Endereço de conexão: o app tuneliza a porta local para o servidor via
                    mesh, então o endereço que o convidado usa no Minecraft é sempre este
                    localhost — só passa a rotear de fato depois de clicar em "Conectar". */}
                <div className="flex items-center gap-2 bg-theme-muted rounded-xl px-3 py-2 border border-theme-card">
                  <Globe className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                  <span className="font-mono font-bold text-theme-primary text-xs flex-1 truncate">
                    localhost:{minecraftPort}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(`localhost:${minecraftPort}`)}
                    className="p-1.5 hover:bg-theme-card rounded-lg text-indigo-600 hover:text-indigo-800 dark:hover:text-indigo-400 transition-colors cursor-pointer shrink-0"
                    title="Copiar endereço de conexão"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>

                {/* Status do fluxo "Jogar" (instalar loader se preciso + abrir o launcher) */}
                {connectedShortCode === server.shortCode && launcherMessage[server.shortCode] && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-theme-secondary leading-relaxed">
                      {launcherMessage[server.shortCode]}
                    </p>
                    {(launcherProgress[server.shortCode] ?? 100) < 100 && (
                      <div className="h-1 bg-theme-muted rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-indigo-500"
                          animate={{ width: `${launcherProgress[server.shortCode] ?? 0}%` }}
                          transition={{ duration: 0.3 }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Ações do card */}
              <div className="px-5 pb-5 pt-0 flex items-center gap-2">
                {stale && connectedShortCode !== server.shortCode ? (
                  // Não conseguimos confirmar o status recentemente com a API Central —
                  // melhor não afirmar "Online" nem "Offline" (nenhuma das duas seria confiável)
                  // e impedir uma tentativa de conexão baseada em dado potencialmente obsoleto.
                  <div className="flex-1 h-10 rounded-xl bg-theme-muted border border-theme-card flex items-center justify-center gap-1.5 text-[10px] font-bold text-theme-secondary">
                    <WifiOff className="w-3 h-3" />
                    Status desatualizado
                  </div>
                ) : server.status === "online" ? (
                  server.isOwnServer ? (
                    // Servidor do próprio host: não permite conectar (não pode conectar na própria mesh)
                    <div className="flex-1 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-indigo-500">
                      <Zap className="w-3 h-3 text-indigo-400" />
                      Online
                    </div>
                  ) : connectedShortCode === server.shortCode ? (
                    <button
                      type="button"
                      onClick={() => handleDisconnect()}
                      className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/30"
                    >
                      <X className="w-3.5 h-3.5" /> Desconectar
                    </button>
                  ) : PLAYABLE_SERVER_TYPES.has(server.serverType) ? (
                    // Um clique conecta e já prepara + abre o Minecraft com o perfil certo
                    // selecionado (ver useEffect que dispara handleOpenLauncher assim que o
                    // túnel sobe). Para Fabric/Forge/NeoForge isso inclui instalar o mod
                    // loader certo, numa instância isolada, se ainda não estiver instalado.
                    <button
                      type="button"
                      onClick={() => handleConnect(server)}
                      disabled={isConnecting}
                      className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 shadow-md shadow-theme-shadow"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" /> Jogar
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleConnect(server)}
                      disabled={isConnecting}
                      className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 shadow-md shadow-theme-shadow"
                    >
                      <Zap className="w-3.5 h-3.5 fill-current" /> Conectar
                    </button>
                  )
                ) : server.status === "crashed" ? (
                  <div className="flex-1 h-10 rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-rose-500">
                    <AlertTriangle className="w-3 h-3" />
                    Servidor com erro
                  </div>
                ) : (
                  <div className="flex-1 h-10 rounded-xl bg-theme-muted border border-theme-card flex items-center justify-center gap-1.5 text-[10px] font-bold text-theme-secondary">
                    <WifiOff className="w-3 h-3" />
                    Offline
                  </div>
                )}

                {/* Botão copiar código */}
                <button
                  type="button"
                  onClick={() => copyToClipboard(`CF-${server.shortCode}`)}
                  className="p-2.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"
                  title="Copiar código do servidor"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </button>

                {/* Botão remover */}
                <button
                  type="button"
                  onClick={() => handleRemoveServer(server.shortCode)}
                  className="p-2.5 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-xl text-theme-secondary hover:text-rose-500 transition-colors cursor-pointer"
                  title="Remover da biblioteca"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </motion.div>
            );
          })}
        </div>
      )}

      {/* Modal de conexão ativa */}
      <AnimatePresence>
        {isOnline && connectedShortCode && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="p-6 bg-theme-success border border-emerald-200 dark:border-emerald-800/30 rounded-[2rem] space-y-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl flex items-center justify-center">
                  <Zap className="w-5 h-5 text-emerald-600 fill-current" />
                </div>
                <div>
                  <h4 className="font-bold text-theme-primary">Conectado</h4>
                  <p className="text-xs text-theme-secondary">
                    {knownServers.find(s => s.shortCode === connectedShortCode)?.name || "Servidor"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleDisconnect}
                className="h-10 px-5 bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-300 rounded-xl hover:bg-rose-100 dark:hover:bg-rose-900/30 transition-all text-xs font-bold flex items-center gap-2 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" /> Desconectar
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-theme-muted p-3 rounded-xl border border-theme-card">
                <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">Endereço Local</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono font-bold text-theme-primary text-sm">localhost:{minecraftPort}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(`localhost:${minecraftPort}`)}
                    className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 transition-colors cursor-pointer"
                  >
                    {copied ? "Copiado!" : "Copiar"}
                  </button>
                </div>
              </div>
              <div className="bg-theme-muted p-3 rounded-xl border border-theme-card">
                <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">Status da Rede</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                  <span className="text-sm font-bold text-emerald-600">Online</span>
                </div>
              </div>
            </div>

            <p className="text-xs text-theme-secondary leading-relaxed bg-theme-muted p-3 rounded-xl">
              Conecte-se em <strong className="text-theme-primary">localhost:{minecraftPort}</strong> no seu Minecraft para jogar.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modal de Adicionar Servidor */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
              onClick={() => { if (!isAdding) setShowAddModal(false); }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: "spring", duration: 0.4 }}
              className="relative w-full max-w-sm bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-6"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg flex items-center justify-center">
                    <Plus className="text-indigo-700 dark:text-indigo-300 w-5 h-5" />
                  </div>
                  <h3 className="text-xl font-bold text-theme-primary">Adicionar Servidor</h3>
                </div>
                {!isAdding && (
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">
                    Código de Convite
                  </label>
                  <input
                    type="text"
                    placeholder="CF-XXXXXXXX"
                    value={inviteCodeInput}
                    onChange={(e) => {
                      setInviteCodeInput(e.target.value.toUpperCase());
                      setAddError(null);
                    }}
                    disabled={isAdding}
                    className={cn(
                      "w-full h-14 text-center text-2xl font-mono font-bold tracking-[0.1em] border-2 rounded-2xl transition-all uppercase bg-transparent text-theme-primary",
                      addError
                        ? "border-rose-400 focus:border-rose-500 focus:outline-none"
                        : "border-theme-card focus:border-indigo-500 focus:outline-none",
                      isAdding && "opacity-50"
                    )}
                    autoFocus
                  />
                  {addError && (
                    <p className="text-[10px] text-rose-500 font-bold flex items-center gap-1 mt-1">
                      <AlertTriangle className="w-3 h-3" /> {addError}
                    </p>
                  )}
                </div>

                <p className="text-[10px] text-theme-secondary italic leading-relaxed">
                  Peça ao host para compartilhar o código do servidor. Você só precisa dele uma vez — depois disso, o servidor fica salvo na sua biblioteca.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-2 border-t border-theme-card">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  disabled={isAdding}
                  className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold disabled:opacity-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleAddServer}
                  disabled={isAdding || !inviteCodeInput.startsWith("CF-")}
                  className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-theme-shadow cursor-pointer"
                >
                  {isAdding ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Verificando...</>
                  ) : (
                    <><Plus className="w-4 h-4" /> Adicionar</>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
