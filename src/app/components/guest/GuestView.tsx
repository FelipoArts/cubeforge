"use client";

import { useState, useEffect, useCallback } from "react";
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
import { join } from "@tauri-apps/api/path";
import { useAppStore, type KnownServer, type ServerStatus } from "@/app/store";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { pushDiagnostic } from "@/app/diagnostics";
import {
  installFabricClient,
  installForgeClient,
  getInstanceDir,
  findInstalledFabricVersion,
  findInstalledForgeVersion,
} from "@/lib/clientSetup";
import { planModSync, runModSync, INITIAL_PREP_STATE, type PrepState } from "@/lib/modSync";
import { connectAddressFor } from "@/lib/connectAddress";
import { ModSyncModal } from "./ModSyncModal";

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
    guestConnectedShortCode: connectedShortCode,
    setGuestConnectedShortCode: setConnectedShortCode,
    pendingJoinShortCode,
    setPendingJoinShortCode,
  } = useAppStore();

  const [showAddModal, setShowAddModal] = useState(false);
  useLockBodyScroll(showAddModal);
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Wake-on-demand: shortCode do servidor que estamos tentando acordar agora
  // (null = nenhum) + erro por shortCode, pra não confundir cards diferentes.
  const [wakingShortCode, setWakingShortCode] = useState<string | null>(null);
  const [wakeError, setWakeError] = useState<{ shortCode: string; message: string } | null>(null);
  // Contador de tempo online é calculado localmente (a partir de onlineSince) e
  // precisa de um "tick" próprio para atualizar a UI a cada segundo, já que o
  // polling da API Central acontece só a cada 30s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // connectedShortCode é persistido (ver store.ts) para sobreviver a F5/reabertura
  // do app — só é limpo quando a rede mesh cai de verdade, o usuário desconecta
  // manualmente, ou a tentativa de conexão falha (todos tratados em page.tsx, que
  // é quem recebe o evento real "network-status" e o resultado de handleGuestConnect).

  // Fluxo "Preparar e Jogar" (instala o mod loader se precisar, sincroniza os
  // mods com o que o host tem agora, e só então deixa abrir o Minecraft
  // Launcher já com o perfil certo selecionado) — sempre uma ação explícita
  // do jogador (botão próprio, nunca dispara sozinho ao conectar: era
  // exatamente esse auto-disparo que fazia o Explorer "abrir do nada" quando
  // a ativação do launcher via shell:AppsFolder falhava em silêncio pra quem
  // não tem a versão da Microsoft Store instalada).
  //
  // `prepStates` guarda o progresso/relatório por shortCode (sobrevive ao
  // fechamento do modal, então reabrir mostra o último resultado); `prepModalFor`
  // é qual servidor está com o modal aberto agora (null = nenhum).
  const [prepModalFor, setPrepModalFor] = useState<string | null>(null);
  const [prepStates, setPrepStates] = useState<Record<string, PrepState>>({});

  const loaderLabel = (serverType: string): string =>
    serverType === "neoforge" ? "NeoForge" : serverType === "forge" ? "Forge" : "Fabric";

  const patchPrepState = (shortCode: string, patch: Partial<PrepState>) => {
    setPrepStates(prev => ({ ...prev, [shortCode]: { ...(prev[shortCode] ?? INITIAL_PREP_STATE), ...patch } }));
  };

  /** Passo 1: checa o que já está instalado/sincronizado e monta o resumo mostrado no modal — não baixa nada ainda. */
  const handlePrepareAndPlay = async (server: KnownServer) => {
    setPrepModalFor(server.shortCode);
    patchPrepState(server.shortCode, { ...INITIAL_PREP_STATE, phase: "checking" });

    if ((server.serverType === "forge" || server.serverType === "neoforge") && !server.forgeVersion) {
      patchPrepState(server.shortCode, {
        phase: "error",
        errorMessage: `Não sabemos qual versão do ${loaderLabel(server.serverType)} esse servidor usa — abra o Minecraft manualmente e conecte em ${connectAddressFor(server, minecraftPort)}.`,
      });
      return;
    }

    try {
      let loaderNote: string | null = null;
      let instanceModsDir = "";
      let plan = { entries: [] as PrepState["modEntries"], remoteMods: [] as PrepState["remoteMods"], alreadyInstalledCount: 0, totalBytesToDownload: 0 };

      if (ISOLATED_SERVER_TYPES.has(server.serverType)) {
        const gameDir = await getInstanceDir(server.shortCode);
        instanceModsDir = await join(gameDir, "mods");

        if (server.serverType === "fabric") {
          const already = await findInstalledFabricVersion(server.version);
          loaderNote = already ? null : "Instalar o Fabric no seu Minecraft (ainda não instalado).";
        } else {
          const already = server.forgeVersion ? await findInstalledForgeVersion(server.forgeVersion) : null;
          loaderNote = already ? null : `Instalar o ${loaderLabel(server.serverType)} ${server.forgeVersion} no seu Minecraft (ainda não instalado).`;
        }

        plan = await planModSync(server.shortCode, instanceModsDir);
      }

      patchPrepState(server.shortCode, {
        phase: "confirm",
        loaderNote,
        instanceModsDir,
        modEntries: plan.entries,
        remoteMods: plan.remoteMods,
        alreadyInstalledCount: plan.alreadyInstalledCount,
        totalBytesToDownload: plan.totalBytesToDownload,
      });
    } catch (err) {
      patchPrepState(server.shortCode, { phase: "error", errorMessage: String(err) });
    }
  };

  /** Último passo comum a todos os caminhos de sucesso: seleciona o perfil no launcher (nunca o abre — isso só no clique final "Abrir Minecraft"). */
  const finalizeLauncherProfile = async (
    server: KnownServer,
    versionId: string,
    gameDir: string | null,
    extra: Partial<PrepState> = {}
  ) => {
    patchPrepState(server.shortCode, { stageMessage: "Selecionando o perfil no launcher...", stagePercent: 92 });
    try {
      const prepResult = await invoke<string>("prepare_launcher_profile", {
        versionId,
        profileName: `Cubicase — ${server.name}`,
        gameDir,
      });
      if (prepResult === "not_found") {
        patchPrepState(server.shortCode, {
          phase: "error",
          errorMessage: `Não encontramos sua instalação do Minecraft — abra o jogo e conecte em ${connectAddressFor(server, minecraftPort)} manualmente.`,
        });
        return;
      }
      patchPrepState(server.shortCode, { phase: "done", versionId, gameDir, ...extra });
    } catch (err) {
      patchPrepState(server.shortCode, { phase: "error", errorMessage: String(err) });
    }
  };

  /** Passo 2 (clique em "Preparar agora"): instala o loader (se precisar) e sincroniza os mods que faltam. */
  const handleConfirmPrepare = async (server: KnownServer) => {
    const current = prepStates[server.shortCode];
    if (!current) return;

    patchPrepState(server.shortCode, { phase: "syncing", stageMessage: "Preparando...", stagePercent: 0 });

    try {
      let versionId = server.version ?? "";
      let gameDir: string | null = null;

      if (server.serverType === "fabric") {
        gameDir = await getInstanceDir(server.shortCode);
        versionId = await installFabricClient(server.version, (p) =>
          patchPrepState(server.shortCode, { stageMessage: p.status, stagePercent: p.percent * 0.5 })
        );
      } else if (server.serverType === "forge" || server.serverType === "neoforge") {
        gameDir = await getInstanceDir(server.shortCode);
        versionId = await installForgeClient(server.serverType, server.version, server.forgeVersion!, (p) =>
          patchPrepState(server.shortCode, { stageMessage: p.status, stagePercent: p.percent * 0.5 })
        );
      }

      if (ISOLATED_SERVER_TYPES.has(server.serverType) && current.modEntries.length > 0) {
        const entries = current.modEntries.map(e => ({ ...e }));
        await runModSync({
          shortCode: server.shortCode,
          instanceModsDir: current.instanceModsDir,
          remoteMods: current.remoteMods,
          entries,
          onProgress: (updated) => patchPrepState(server.shortCode, { modEntries: [...updated] }),
        });

        if (entries.some(e => e.status === "failed")) {
          // Não prepara o perfil ainda — espera o jogador decidir (tentar de
          // novo só os que falharam, ou continuar mesmo assim).
          patchPrepState(server.shortCode, { phase: "done", modEntries: entries, versionId, gameDir });
          return;
        }
      }

      await finalizeLauncherProfile(server, versionId, gameDir);
    } catch (err) {
      patchPrepState(server.shortCode, { phase: "error", errorMessage: String(err) });
    }
  };

  /** "Tentar de novo (N)" no relatório final: baixa de novo só os mods que falharam. */
  const handleRetryFailedOnly = async (server: KnownServer) => {
    const current = prepStates[server.shortCode];
    if (!current) return;

    const reset = current.modEntries.map(e => (e.status === "failed" ? { ...e, status: "pending" as const, error: undefined } : e));
    patchPrepState(server.shortCode, { phase: "syncing", stageMessage: "Tentando de novo os mods que falharam...", stagePercent: 50, modEntries: reset });

    const toRetry = reset.filter(e => e.status === "pending");
    await runModSync({
      shortCode: server.shortCode,
      instanceModsDir: current.instanceModsDir,
      remoteMods: current.remoteMods,
      entries: toRetry,
      onProgress: (updated) => {
        setPrepStates(prev => {
          const latest = prev[server.shortCode];
          const merged = latest.modEntries.map(e => updated.find(u => u.filename === e.filename) ?? e);
          return { ...prev, [server.shortCode]: { ...latest, modEntries: merged } };
        });
      },
    });

    // `reset` e `toRetry` compartilham as MESMAS referências de objeto pros
    // itens que estavam "pending" — runModSync muta `entry.status` direto
    // neles, então `reset` já reflete o resultado final aqui, sem precisar
    // ler `prepStates` de volta (evitaria pegar um snapshot desatualizado
    // do closure, já que o estado avançou via setPrepStates durante o await).
    if (reset.some(e => e.status === "failed")) {
      patchPrepState(server.shortCode, { phase: "done" });
    } else {
      await finalizeLauncherProfile(server, current.versionId, current.gameDir);
    }
  };

  /** "Continuar mesmo assim" no relatório final: aceita prosseguir com mods faltando. */
  const handleContinueAnyway = async (server: KnownServer) => {
    const current = prepStates[server.shortCode];
    if (!current) return;
    await finalizeLauncherProfile(server, current.versionId, current.gameDir, { acceptedPartial: true });
  };

  /** Clique final "Abrir Minecraft" — só aqui o launcher é de fato aberto. */
  const handleOpenMinecraftFinal = async () => {
    try {
      await invoke("open_minecraft_launcher");
    } catch (err) {
      console.warn("[GuestView] Falha ao abrir o Minecraft Launcher:", err);
    }
    setPrepModalFor(null);
  };

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
          minecraftStatus: null,
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
          connectName: null,
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
    // knownServers muda (nova referência) a cada add/remove/update no store —
    // incluindo os feitos por ESTE próprio efeito. Isso faz o efeito rodar de
    // novo depois de cada add/remove, mas aí já converge: na segunda
    // passagem, os servidores que acabaram de ser adicionados/removidos já
    // batem com localServers, então os dois loops acima não encontram mais
    // nada a fazer e o efeito não dispara uma terceira vez.
  }, [localServers, knownServers, addKnownServer, removeKnownServer]);

  // Lê `knownServers` direto do store (não do closure do componente) e é
  // estável entre renders (useCallback com deps vazias) — de propósito: os
  // dois efeitos abaixo rodam só uma vez (montagem) e a cada 30s, e não
  // devem reiniciar o intervalo a cada atualização de status (que também
  // muda `knownServers`, já que updateKnownServerStatus escreve nele). Antes,
  // como a função fechava sobre `knownServers` do render de montagem e os
  // efeitos nunca re-rodavam ([] como dependência), o polling periódico
  // ficava preso pra sempre olhando o `knownServers` de quando o componente
  // montou — se a lista estivesse vazia nesse instante, o refresh periódico
  // nunca via os servidores adicionados depois.
  const refreshAllServers = useCallback(async (silent = false) => {
    const knownServers = useAppStore.getState().knownServers;
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
          // networkStatus (rede mesh) e minecraftStatus (processo Java) são
          // independentes — ver handleDiscoverServer na API Central.
          const status = (session.networkStatus ?? session.status ?? "offline") as ServerStatus;
          const minecraftStatus = (session.minecraftStatus ?? null) as ServerStatus | null;
          console.log(`[GuestView] Servidor ${server.shortCode} (${server.name}): rede=${status}, minecraft=${minecraftStatus}`);
          updateKnownServerStatus(
            server.shortCode,
            status,
            minecraftStatus,
            session.currentPlayers ?? undefined
          );
        } else {
          console.warn(`[GuestView] Servidor ${server.shortCode}: API retornou HTTP ${response.status}`);
          // Servidor não encontrado na API (removido pelo host)
          if (response.status === 404) {
            updateKnownServerStatus(server.shortCode, "offline", null);
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
  }, [updateKnownServerStatus]);

  // Atualizar status de todos os servidores conhecidos ao abrir. Disparado
  // via setTimeout (não chamado direto no corpo do efeito) porque
  // refreshAllServers muda estado (setIsRefreshing) já na sua primeira linha,
  // antes do primeiro await — chamar isso de forma síncrona dentro do efeito
  // encadearia um re-render ainda durante a fase de commit do React.
  useEffect(() => {
    const id = setTimeout(() => refreshAllServers(), 0);
    return () => clearTimeout(id);
  }, [refreshAllServers]);

  // Atualizar status periodicamente (a cada 30 segundos)
  useEffect(() => {
    const interval = setInterval(() => {
      refreshAllServers(true);
    }, 30000);
    return () => clearInterval(interval);
  }, [refreshAllServers]);

  // Wake-on-demand: pede pro host acordar (POST /wake) e faz um poll rápido
  // (3s, só deste servidor) até minecraftStatus sair de "sleeping" — bem mais
  // frequente que o refreshAllServers de 30s, pra não deixar quem clicou
  // esperando sem feedback por muito tempo. Desiste depois de ~90s.
  const handleWakeServer = async (server: KnownServer) => {
    setWakingShortCode(server.shortCode);
    setWakeError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/servers/${server.shortCode}/wake`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = res.status === 429
          ? "Pedido de despertar já enviado recentemente. Aguarde alguns segundos e tente de novo."
          : (body?.message || `Não foi possível acordar o servidor (HTTP ${res.status}).`);
        throw new Error(message);
      }

      const POLL_INTERVAL_MS = 3000;
      const MAX_ATTEMPTS = 30; // ~90s no total
      let attempts = 0;
      const poll = async () => {
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
          setWakingShortCode(null);
          setWakeError({ shortCode: server.shortCode, message: "O servidor demorou demais pra responder. Tente de novo." });
          return;
        }
        try {
          const discoverRes = await fetch(`${API_BASE}/api/v1/servers/${server.shortCode}`);
          if (discoverRes.ok) {
            const envelope = await discoverRes.json();
            const session = envelope?.data?.session ?? {};
            const status = (session.networkStatus ?? session.status ?? "offline") as ServerStatus;
            const minecraftStatus = (session.minecraftStatus ?? null) as ServerStatus | null;
            updateKnownServerStatus(server.shortCode, status, minecraftStatus, session.currentPlayers ?? undefined);
            if (minecraftStatus !== "sleeping") {
              setWakingShortCode(null);
              return;
            }
          }
        } catch { /* mantém tentando até o limite de tentativas */ }
        setTimeout(poll, POLL_INTERVAL_MS);
      };
      poll();
    } catch (err) {
      setWakingShortCode(null);
      const message = err instanceof Error ? err.message : String(err);
      setWakeError({ shortCode: server.shortCode, message });
    }
  };

  type AddServerResult =
    | { ok: true; server: KnownServer }
    | { ok: false; reason: "not_found" | "network_error" };

  /** Consulta a API Central por um shortCode e adiciona à biblioteca — usado tanto pelo formulário manual quanto pelo link de convite (deep link, ver efeito abaixo). Não checa duplicidade (quem chama já decide o que fazer se já existir). */
  const addServerByCode = async (code: string): Promise<AddServerResult> => {
    try {
      const response = await fetch(`${API_BASE}/api/v1/servers/${code}`);
      if (!response.ok) return { ok: false, reason: "not_found" };

      // Envelope da API Central: metadados em data.server, status/jogadores em data.session.
      const envelope = await response.json();
      const server = envelope?.data?.server ?? {};
      const session = envelope?.data?.session ?? {};
      const networkStatus = session.networkStatus ?? session.status ?? "offline";
      const known: KnownServer = {
        shortCode: server.shortCode,
        name: server.name,
        version: server.version,
        serverType: server.serverType || "vanilla",
        description: server.description || `Servidor Minecraft ${server.version}`,
        status: networkStatus,
        minecraftStatus: session.minecraftStatus ?? null,
        port: session.port || 25565,
        maxPlayers: session.maxPlayers || 20,
        currentPlayers: session.currentPlayers || 0,
        lastSeenOnline: networkStatus === "online" ? new Date().toISOString() : null,
        onlineSince: networkStatus === "online" ? new Date().toISOString() : null,
        lastConfirmedAt: new Date().toISOString(),
        addedAt: new Date().toISOString(),
        isOwnServer: false,
        networkProvider: session.provider || "tailscale",
        forgeVersion: server.forgeVersion ?? null,
        modLoaderVersion: server.modLoaderVersion ?? null,
        connectName: server.connectName ?? null,
      };
      addKnownServer(known);
      return { ok: true, server: known };
    } catch {
      return { ok: false, reason: "network_error" };
    }
  };

  const handleAddServer = async () => {
    const code = inviteCodeInput.replace("CF-", "").trim().toUpperCase();
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

    const result = await addServerByCode(code);
    setIsAdding(false);
    if (!result.ok) {
      setAddError(
        result.reason === "not_found"
          ? "Servidor não encontrado. Verifique o código e tente novamente."
          : "Não foi possível conectar à API Central. Verifique sua conexão com a internet."
      );
      return;
    }

    setShowAddModal(false);
    setInviteCodeInput("");
  };

  // Um servidor é considerado "obsoleto" se a última confirmação da API Central
  // foi há mais tempo do que alguns ciclos de polling (30s cada). Sem isso, um
  // status cacheado (ex: "online") continuaria sendo exibido como verdade mesmo
  // que a API esteja fora do ar ou as requisições estejam falhando repetidamente —
  // o que passaria informação falsa para o convidado.
  const STALE_THRESHOLD_MS = 100_000; // ~3 ciclos de 30s
  const isServerStale = (server: KnownServer, nowMs: number): boolean => {
    if (!server.lastConfirmedAt) return true;
    return nowMs - new Date(server.lastConfirmedAt).getTime() > STALE_THRESHOLD_MS;
  };

  const handleConnect = (server: KnownServer) => {
    if (server.status !== "online" || isServerStale(server, now)) return;
    setConnectedShortCode(server.shortCode);
    onConnect(`CF-${server.shortCode}`);
  };

  // Convite recebido via link bonito (play.cubicase.net/<slug> -> deep link
  // cubicase://join/<shortCode>, ver src/lib/joinDeepLink.ts). Reusa o mesmo
  // modal de "Adicionar servidor" pra aproveitar o loading/erro já existentes
  // — só entra no fluxo automaticamente em vez de esperar o usuário digitar.
  // Se o servidor já estiver na biblioteca e online, conecta direto.
  useEffect(() => {
    if (!pendingJoinShortCode) return;
    const code = pendingJoinShortCode;

    void (async () => {
      setPendingJoinShortCode(null);

      const existing = knownServers.find(s => s.shortCode === code);
      if (existing) {
        handleConnect(existing);
        return;
      }

      setInviteCodeInput(code);
      setShowAddModal(true);
      setIsAdding(true);
      setAddError(null);
      const result = await addServerByCode(code);
      setIsAdding(false);
      if (!result.ok) {
        const message = result.reason === "not_found"
          ? "Convite inválido ou expirado. Verifique o link e tente novamente."
          : "Não foi possível conectar à API Central. Verifique sua conexão com a internet.";
        setAddError(message);
        pushDiagnostic({ level: "warning", source: "Convite", title: "Não foi possível entrar pelo convite", message, detail: `CF-${code}` });
        return;
      }
      setShowAddModal(false);
      setInviteCodeInput("");
      pushDiagnostic({ level: "info", source: "Convite", title: "Servidor adicionado", message: `"${result.server.name}" foi adicionado à sua biblioteca pelo link de convite.` });
      handleConnect(result.server);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJoinShortCode]);

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

  // Guarda o TEXTO copiado (não um booleano solto) pra só o botão que copiou
  // aquele conteúdo específico mostrar o ícone de check — com um booleano
  // único, copiar o código de um servidor "marcava" o botão de copiar de
  // TODOS os outros servidores da lista, mesmo copiando códigos diferentes.
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((current) => (current === text ? null : current)), 2000);
  };

  const formatLastSeen = (iso: string | null, nowMs: number): string => {
    if (!iso) return "Nunca";
    const diff = nowMs - new Date(iso).getTime();
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


  // Rede mesh (status) e Minecraft (minecraftStatus) são reportados de forma
  // independente pela API Central — um host pode ligar só um dos dois (ex: rodar
  // o servidor sem usar a malha do CubeForge, acessível só por IP local/LAN ou
  // outra VPN). Por isso o badge combina os dois em 4 estados em vez de repetir
  // o "Offline" genérico sempre que falta qualquer uma das duas partes.
  const getDisplayStatus = (server: KnownServer): { color: string; textClass: string; label: string } => {
    const networkOnline = server.status === "online";
    const mc = server.minecraftStatus;
    const mcOnline = mc === "online";

    if (networkOnline && mcOnline) {
      return { color: "bg-emerald-500", textClass: "text-emerald-600 dark:text-emerald-400", label: "Online" };
    }
    if (networkOnline) {
      // Rede pronta, mas o processo Java não está de pé.
      const label =
        mc === "starting" ? "Servidor iniciando" :
        mc === "stopping" ? "Servidor encerrando" :
        mc === "crashed" ? "Servidor com erro" :
        "Servidor desligado";
      return {
        color: mc === "crashed" ? "bg-rose-500" : "bg-amber-500",
        textClass: mc === "crashed" ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400",
        label,
      };
    }
    if (mcOnline) {
      // Minecraft rodando, mas sem a rede mesh do CubeForge — só acessível
      // diretamente (IP local/LAN) ou por outra VPN, não pelo "Conectar" daqui.
      return { color: "bg-sky-500", textClass: "text-sky-600 dark:text-sky-400", label: "Rodando sem rede mesh" };
    }
    if (mc === "crashed") {
      // Sem rede E o Minecraft crashou — mantém consistente com o botão de ação
      // abaixo, que já trata esse caso separadamente do "Offline" genérico.
      return { color: "bg-rose-500", textClass: "text-rose-600 dark:text-rose-400", label: "Servidor com erro" };
    }
    if (mc === "sleeping") {
      // Wake-on-demand armado: rede mesh de propósito desligada até alguém
      // pedir pra entrar (ver botão "Acordar servidor" abaixo).
      return { color: "bg-indigo-400", textClass: "text-indigo-500 dark:text-indigo-400", label: "Em espera" };
    }
    return { color: "bg-slate-400", textClass: "text-theme-secondary", label: "Offline" };
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
            const stale = isServerStale(server, now);
            const isThisConnected = connectedShortCode === server.shortCode;
            const display = getDisplayStatus(server);
            const isFullyOnline = server.status === "online" && server.minecraftStatus === "online";
            return (
            <motion.div
              key={server.shortCode}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className={cn(
                "rounded-[2rem] border shadow-theme-card overflow-hidden transition-all duration-300 hover:shadow-lg",
                isThisConnected
                  ? "bg-emerald-50/70 dark:bg-emerald-950/20 border-emerald-400 dark:border-emerald-600 ring-2 ring-emerald-400/30"
                  : "bg-theme-card border-theme-card hover:border-indigo-200 dark:hover:border-indigo-800"
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
                      stale ? "bg-slate-400" : display.color,
                      !stale && isFullyOnline && "animate-pulse"
                    )} />
                    <span className={cn(
                      "text-[10px] font-bold uppercase tracking-wider",
                      stale ? "text-theme-secondary" : display.textClass
                    )} title={
                      stale ? "Não foi possível confirmar o status recentemente com a API Central" :
                      display.label === "Rodando sem rede mesh" ? "O Minecraft está de pé, mas o host não ligou a rede mesh do CubeForge — só dá pra acessar pelo IP local (LAN) ou outra VPN." :
                      undefined
                    }>
                      {/* Status desatualizado: não sabemos mais se ainda é verdade, então
                          não afirmamos online/offline — só que não está confirmado. */}
                      {stale ? "Não confirmado" : display.label}
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
                  {server.currentPlayers !== undefined && server.minecraftStatus === "online" && (
                    <span className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {server.currentPlayers}/{server.maxPlayers} jogadores
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {isFullyOnline && !stale
                      ? `Online há ${formatUptime(server.onlineSince)}`
                      : formatLastSeen(server.lastSeenOnline, now)}
                  </span>
                </div>

                {(() => {
                  // Endereço de conexão: o app tuneliza a porta local para o servidor
                  // via mesh, então isso resolve pro loopback (127.0.0.1) do próprio
                  // convidado — só passa a rotear de fato depois de clicar em
                  // "Conectar" (ver connectAddressFor em src/lib/connectAddress.ts).
                  const connectAddress = connectAddressFor(server, minecraftPort);
                  return isThisConnected ? (
                  // Conectado: em vez de uma div separada abaixo da lista, as informações
                  // de conexão ficam centralizadas dentro do próprio card (que já mudou
                  // de cor para indicar o estado). Preparar o launcher (loader + mods +
                  // abrir o Minecraft) é sempre uma ação explícita à parte — ver botão
                  // "Preparar e Jogar" nas ações do card, nunca dispara sozinho ao conectar.
                  <div className="flex flex-col items-center text-center gap-2.5 py-1">
                    <div className="w-11 h-11 bg-emerald-100 dark:bg-emerald-900/40 rounded-2xl flex items-center justify-center">
                      <Zap className="w-5 h-5 text-emerald-600 fill-current" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-emerald-700 dark:text-emerald-300">
                        {isOnline ? "Conectado" : "Conectando..."}
                      </h4>
                      <p className="text-[11px] text-theme-secondary mt-0.5 leading-relaxed">
                        Conecte-se em{" "}
                        <strong className="text-theme-primary font-mono">{connectAddress}</strong>{" "}
                        no seu Minecraft
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(connectAddress)}
                      className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 dark:hover:text-indigo-400 transition-colors cursor-pointer"
                    >
                      {copied === connectAddress ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied === connectAddress ? "Copiado!" : "Copiar endereço"}
                    </button>
                  </div>
                  ) : (
                  <div className="flex items-center gap-2 bg-theme-muted rounded-xl px-3 py-2 border border-theme-card">
                    <Globe className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                    <span className="font-mono font-bold text-theme-primary text-xs flex-1 truncate">
                      {connectAddress}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(connectAddress)}
                      className="p-1.5 hover:bg-theme-card rounded-lg text-indigo-600 hover:text-indigo-800 dark:hover:text-indigo-400 transition-colors cursor-pointer shrink-0"
                      title="Copiar endereço de conexão"
                    >
                      {copied === connectAddress ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  );
                })()}
              </div>

              {/* Ações do card */}
              <div className="px-5 pb-5 pt-0 flex items-center gap-2">
                {isThisConnected ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleDisconnect()}
                      className="h-10 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/30"
                    >
                      <X className="w-3.5 h-3.5" /> Desconectar
                    </button>
                    {PLAYABLE_SERVER_TYPES.has(server.serverType) && (
                      <button
                        type="button"
                        onClick={() => handlePrepareAndPlay(server)}
                        disabled={prepModalFor === server.shortCode && prepStates[server.shortCode]?.phase !== "error" && prepStates[server.shortCode]?.phase !== "done"}
                        className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer bg-indigo-600 text-white hover:bg-indigo-700 shadow-md shadow-theme-shadow"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" /> Preparar e Jogar
                      </button>
                    )}
                  </>
                ) : stale ? (
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
                      {display.label}
                    </div>
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
                      <Play className="w-3.5 h-3.5 fill-current" /> Conectar
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
                ) : server.minecraftStatus === "sleeping" ? (
                  server.isOwnServer ? (
                    <div className="flex-1 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-indigo-500">
                      <Zap className="w-3 h-3 text-indigo-400" />
                      {display.label}
                    </div>
                  ) : wakingShortCode === server.shortCode ? (
                    <div className="flex-1 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-indigo-500">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Acordando, aguarde...
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleWakeServer(server)}
                      className="flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer bg-indigo-600 text-white hover:bg-indigo-700 shadow-md shadow-theme-shadow"
                    >
                      <Zap className="w-3.5 h-3.5 fill-current" /> Acordar servidor
                    </button>
                  )
                ) : server.minecraftStatus === "online" ? (
                  // Minecraft de pé, mas sem a rede mesh do CubeForge: não dá pra conectar
                  // por aqui — só via IP local (LAN) ou outra VPN que o host esteja usando.
                  <div
                    className="flex-1 h-10 rounded-xl bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800/30 flex items-center justify-center gap-1.5 text-[10px] font-bold text-sky-600 dark:text-sky-400"
                    title="O host ligou o servidor, mas não a rede mesh do CubeForge. Só dá pra entrar pelo IP local (LAN) ou outra VPN."
                  >
                    <Server className="w-3 h-3" />
                    Sem rede mesh
                  </div>
                ) : server.minecraftStatus === "crashed" ? (
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
                  {copied === `CF-${server.shortCode}` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
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
              {wakeError?.shortCode === server.shortCode && (
                <p className="px-5 pb-4 -mt-2 text-[10px] text-rose-500">{wakeError.message}</p>
              )}
            </motion.div>
            );
          })}
        </div>
      )}

      {/* Modal de Preparar e Jogar (instalar loader + sincronizar mods + abrir launcher) */}
      {prepModalFor && prepStates[prepModalFor] && (() => {
        const prepServer = knownServers.find(s => s.shortCode === prepModalFor);
        if (!prepServer) return null;
        return (
          <ModSyncModal
            serverName={prepServer.name}
            state={prepStates[prepModalFor]}
            onCancel={() => setPrepModalFor(null)}
            onConfirm={() => handleConfirmPrepare(prepServer)}
            onRetryAll={() => handlePrepareAndPlay(prepServer)}
            onRetryFailedOnly={() => handleRetryFailedOnly(prepServer)}
            onContinueAnyway={() => handleContinueAnyway(prepServer)}
            onOpenMinecraft={() => handleOpenMinecraftFinal()}
          />
        );
      })()}

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
