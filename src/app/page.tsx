"use client";

import { useState, useRef, useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Globe,
  Monitor,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { useAppStore, type ServerStatus } from "@/app/store";
import { join } from "@tauri-apps/api/path";
import { readTextFile, remove } from "@tauri-apps/plugin-fs";
import { installJRE, isJREInstalled, getJREPath, type DownloadProgress } from "@/lib/jre";
import {
  getJavaVersion,
  type ServerInfo,
  type ServerInstallProgress,
} from "@/lib/server";
import { useTheme } from "next-themes";
import { AppSettingsPanel } from "@/app/components/AppSettingsPanel";
import { DiagnosticsToasts, DiagnosticsBell } from "@/app/components/DiagnosticsCenter";
import { pushDiagnostic } from "@/app/diagnostics";
import { UpdateBanner } from "@/app/components/UpdateBanner";
import { useUpdaterStore } from "@/app/updater";
import { analyzeCrashText } from "@/lib/crashAnalyzer";
import { createLagMonitor } from "@/lib/lagDetector";
import { createResourceMonitor, explainResourceBottleneck, type ResourceSnapshot } from "@/lib/resourceDiagnostics";
import { maybeBackupWorld } from "@/lib/autoBackup";

// Componentes extraídos
import { HostView } from "@/app/components/host/HostView";
import { GuestView } from "@/app/components/guest/GuestView";

// ============================================================
// Page
// ============================================================
// Página principal do Cubicase Dash.
// Gerencia o estado global e a navegação entre modos Host/Guest.
// Todos os estados compartilhados vivem aqui para preservar
// estado ao alternar entre abas.
// ============================================================

export default function Home() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Evitar hydration mismatch: só renderizar o logo após montar no cliente
  useEffect(() => {
    setMounted(true);
  }, []);

  // Checagem de atualização: silenciosa, alguns segundos após o boot (não
  // compete com as outras chamadas de rede do startup) e depois a cada 4h
  // enquanto o app fica aberto (útil pro host, que roda por horas).
  useEffect(() => {
    const checkForUpdates = useUpdaterStore.getState().checkForUpdates;
    const initial = setTimeout(checkForUpdates, 5000);
    const interval = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  // --- Store ---
  const {
    serverDir,
    setServerDir,
    minecraftPort,
    setMinecraftPort,
    selectedServer,
    setSelectedServer,
    mode,
    setMode,
    serverStatus,
    setServerStatus,
    setLastCrashInfo,
    mcLogsByServer,
    setMcLogs: setMcLogsInStore,
  } = useAppStore();

  // --- Estados locais (compartilhados entre Host e Guest) ---
  const [netStatus, setNetStatus] = useState<"offline" | "connecting" | "online">("offline");
  // De quem é a conexão de rede ativa (só existe uma por instalação — ver
  // active_network_mode no Rust). Sem isso, a aba Host não tinha como saber
  // que um netStatus "online" era, na verdade, a conexão do Convidado.
  const [netMode, setNetMode] = useState<"host" | "guest" | null>(null);
  const [netIp, setNetIp] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  // O console do Minecraft (mcLogsByServer) vive no store (persistido por servidor);
  // aqui derivamos apenas a sessão do servidor atualmente selecionado para exibição.
  const mcLogs = selectedServer ? (mcLogsByServer[selectedServer] ?? []) : [];

  // Ações/comandos disparados pela UI (iniciar, parar, enviar comando, limpar)
  // sempre dizem respeito ao servidor que o usuário está vendo no momento.
  const onSetMcLogsForSelected = (logs: string[] | ((prev: string[]) => string[])) => {
    if (!selectedServer) return;
    setMcLogsInStore(selectedServer, logs);
  };

  // Eventos vindos do backend (linhas de log, mudanças de status) não sabem a
  // qual servidor pertencem — são atribuídos ao servidor cujo processo está
  // rodando (runningServer), que pode ser diferente do servidor selecionado
  // na tela caso o usuário tenha navegado para outro servidor nesse meio tempo.
  const appendMcLogToRunningServer = (line: string) => {
    const state = useAppStore.getState();
    const target = state.runningServer ?? state.selectedServer;
    if (!target) return;
    state.setMcLogs(target, prev => [...prev, line]);
  };

  // Carregar logs de rede do localStorage na montagem e persistir em toda mudança
  // IMPORTANTE: isso precisa acontecer em UM único useEffect para evitar que
  // o salvamento com array vazio sobrescreva os dados carregados.
  const logsLoadedRef = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('cubeforge-storage');
      if (raw) {
        const parsed = JSON.parse(raw);
        const savedLogs = parsed?.state?.logs;
        if (savedLogs?.length) {
          setLogs(savedLogs.slice(-150));
          logsLoadedRef.current = true;
          return; // Não persiste de volta logo após carregar
        }
      }
    } catch {}

    // Se não tinha nada no localStorage, marca como carregado mesmo assim
    logsLoadedRef.current = true;
  }, []);

  // Persistir SEPARADAMENTE: só roda quando logs mudam (não na montagem)
  const prevLogsRef = useRef<string[]>([]);
  useEffect(() => {
    // Ignorar a primeira execução (quando logsLoadedRef acabou de ficar true)
    if (!logsLoadedRef.current) return;
    // Só persistir se realmente mudou
    if (logs === prevLogsRef.current) return;
    prevLogsRef.current = logs;
    try {
      const raw = localStorage.getItem('cubeforge-storage');
      if (raw) {
        const parsed = JSON.parse(raw);
        parsed.state = parsed.state || {};
        parsed.state.logs = logs.slice(-150);
        localStorage.setItem('cubeforge-storage', JSON.stringify(parsed));
      }
    } catch {}
  }, [logs]);

  const [localServers, setLocalServers] = useState<ServerInfo[]>([]);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configServerDir, setConfigServerDir] = useState<string | null>(null);
  const [serverInstallProgress, setServerInstallProgress] = useState<ServerInstallProgress | null>(null);
  const [isDeletingServer, setIsDeletingServer] = useState<string | null>(null);
  const [deleteConfirmServer, setDeleteConfirmServer] = useState<string | null>(null);
  const [totalSystemRamGb, setTotalSystemRamGb] = useState(8);
  const [serverConfigPort, setServerConfigPort] = useState(25565);
  const [discoveredServer, setDiscoveredServer] = useState<{
    name: string;
    version: string;
    status: string;
    description?: string;
  } | null>(null);
  const [shortCode, setShortCode] = useState("");

  // Sincronizar localServers com o store (para o GuestView)
  const storeSetLocalServers = useAppStore((state) => state.setLocalServers);
  useEffect(() => {
    storeSetLocalServers(localServers);
  }, [localServers, storeSetLocalServers]);

  // Refs para evitar closure stale
  const selectedServerRef = useRef<string | null>(null);
  const localServersRef = useRef<ServerInfo[]>([]);
  const serverConfigPortRef = useRef(25565);
  const netStatusRef = useRef<"offline" | "connecting" | "online">("offline");
  const serverStatusRef = useRef<ServerStatus>("offline");
  const pendingMcStartRef = useRef(false);
  // Nomes de servidores para os quais já tentamos a auto-correção de "JRE incompatível"
  // nesta sessão — evita loop (reinstalar → crashar de novo → reinstalar → ...) se a
  // causa real do crash for outra coisa que só parece o mesmo sintoma.
  const jreAutoFixAttemptedRef = useRef<Set<string>>(new Set());
  const serverShortCodeRef = useRef<string>("");
  // shortCode do último servidor efetivamente registrado na API Central nesta sessão.
  // Evita re-registrar (e re-logar) o mesmo servidor repetidamente.
  const registeredShortCodeRef = useRef<string | null>(null);
  // Detector de lag baseado em regras (ver src/lib/lagDetector.ts) — mantém uma
  // janela deslizante de ocorrências de "Can't keep up!"/Watchdog no stream de
  // log. Resetado a cada novo start para não arrastar contagem de uma sessão anterior.
  const lagMonitorRef = useRef(createLagMonitor());
  // Última amostra de RAM/CPU real da máquina (evento "mc-resource-sample",
  // emitido pelo Rust a cada ~15s enquanto o servidor roda — ver resourceDiagnostics.ts).
  // Usada para enriquecer o aviso de lag com a causa provável (CPU/RAM/mod).
  const latestResourceSampleRef = useRef<ResourceSnapshot | null>(null);
  // Detecta pressão SUSTENTADA de CPU/RAM (avisa antes mesmo do Minecraft
  // acusar lag no log). Resetado junto com o lagMonitorRef a cada novo start.
  const resourceMonitorRef = useRef(createResourceMonitor());
  // Amostra mais recente exposta pra UI (indicador de saúde na HostView) —
  // não precisa de histórico, só o valor mais atual.
  const [resourceSample, setResourceSample] = useState<ResourceSnapshot | null>(null);
  // Timestamp do último backup automático (qualquer motivo) do servidor
  // atual — usado pelo "backup de segurança" pra saber quando já se passou
  // tempo suficiente numa sessão longa. Resetado a cada novo start.
  const lastAutoBackupAtRef = useRef<number>(Date.now());

  // Sincronizar refs
  useEffect(() => { selectedServerRef.current = selectedServer; }, [selectedServer]);
  useEffect(() => { localServersRef.current = localServers; }, [localServers]);
  useEffect(() => { serverConfigPortRef.current = serverConfigPort; }, [serverConfigPort]);
  useEffect(() => { netStatusRef.current = netStatus; }, [netStatus]);
  useEffect(() => { serverStatusRef.current = serverStatus; }, [serverStatus]);

  // Registra (ou associa) um servidor local na API Central: guarda o shortCode nos
  // refs usados pelos heartbeats e envia sync_register_server. Idempotente por
  // shortCode (via registeredShortCodeRef) para não reenviar a cada re-render.
  //
  // Antes isso só acontecia dentro do listener de "network-status" ficar online —
  // ou seja, só no exato momento em que a rede mesh conectava. Se o usuário criasse
  // ou selecionasse um servidor DEPOIS da mesh já estar online (ou desse Ctrl+R com
  // tudo já rodando), nenhum evento de rede disparava de novo e esse servidor nunca
  // era registrado — a API Central nunca ficava sabendo que ele existia, e o convidado
  // via 404 mesmo com o host e a mesh online. Por isso agora essa função também é
  // chamada por um efeito reativo (abaixo) sempre que o servidor selecionado muda
  // com a mesh já online.
  // Retorna a Promise do invoke pra quem precisa ESPERAR o registro terminar
  // antes de seguir (ex: HostView precisa que o ServerEntity já exista na API
  // Central antes de pedir uma ConnectionSession pra esse shortCode — senão
  // toma SERVER_NOT_FOUND). Quando já registrado nesta sessão (guard abaixo),
  // resolve imediatamente (await em non-Promise é um no-op).
  const registerServerWithCentral = (serverInfo: ServerInfo): Promise<void> => {
    if (!serverInfo.shortCode) return Promise.resolve();
    const metaShortCode = serverInfo.shortCode;
    serverShortCodeRef.current = metaShortCode;
    setShortCode(metaShortCode);

    if (registeredShortCodeRef.current === metaShortCode) return Promise.resolve();
    registeredShortCodeRef.current = metaShortCode;

    setLogs(prev => [...prev, `[INFO] Código do servidor: CF-${metaShortCode}`]);

    const type = serverInfo.serverType || "vanilla";
    const typeLabel =
      type === "vanilla" ? "Vanilla" :
      type === "neoforge" ? "NeoForge" :
      type === "forge" ? "Forge" :
      type === "fabric" ? "Fabric" :
      type === "paper" ? "Paper" :
      type;
    return invoke("sync_register_server", {
      name: serverInfo.name,
      version: serverInfo.version || "1.20.1",
      serverType: type,
      description: serverInfo.description || `Servidor Minecraft ${typeLabel} ${serverInfo.version || "1.20.1"}`,
      shortCode: metaShortCode,
      owner: null,
      forgeVersion: serverInfo.forgeVersion ?? null,
      modLoaderVersion: serverInfo.modLoaderVersion ?? null,
      // Usado pela rota mesh "GET /mods" (sincronização de mods do convidado)
      // pra saber de qual pasta ler mods/ quando alguém pedir este shortCode —
      // ver AppState::active_server_dir em lib.rs.
      serverDir: serverInfo.path,
    }).then((responseJson: any) => {
      try {
        const response = typeof responseJson === "string" ? JSON.parse(responseJson) : responseJson;
        if (response.code === "SERVER_CREATED") {
          setLogs(prev => [...prev, `[INFO] ✅ Servidor registrado na API Central! Código: CF-${metaShortCode}`]);
        } else if (response.code === "QUEUED") {
          setLogs(prev => [...prev, `[INFO] ⏳ Servidor enfileirado para sincronização. Código: CF-${metaShortCode}`]);
        }
      } catch {
        setLogs(prev => [...prev, `[INFO] ✅ Servidor registrado na API Central!`]);
      }
    }).catch(() => {
      setLogs(prev => [...prev, `[INFO] ⚠ API Central indisponível. Servidor funcionando em modo offline.`]);
    });
  };

  // Reage a: mesh já online + servidor selecionado mudou (server novo criado,
  // troca manual de servidor, ou Ctrl+R com tudo já rodando). Cobre os casos que o
  // listener de "network-status" sozinho não cobre (ver comentário acima).
  useEffect(() => {
    if (netStatus !== "online" || !selectedServer) return;
    const serverInfo = localServersRef.current.find(s => s.name === selectedServer);
    if (serverInfo) registerServerWithCentral(serverInfo);
  }, [selectedServer, netStatus]);

  // O heartbeat periódico que existia aqui foi removido: mantinha uma
  // SessionEntity legada viva via timer no JS, em paralelo com o ciclo de
  // vida real da ConnectionSession, que agora é conduzido pelo Rust (heartbeat
  // automático a cada 60s enquanto a sessão estiver Online/Degraded — ver
  // start_network_node em lib.rs).

  // Inicia o processo Java para um servidor: resolve (e instala se preciso) a JRE
  // correta para a versão do MC, lê a RAM configurada em cubicase-meta.json, e invoca
  // start_minecraft_server. Compartilhada entre o auto-start pós-conexão da rede mesh
  // e a auto-correção de "JRE incompatível" (que reinstala a JRE e chama de novo).
  const startMinecraftForServer = async (serverInfo: ServerInfo) => {
    setServerStatus("starting");
    useAppStore.getState().setRunningServer(serverInfo.name);
    useAppStore.getState().setMcLogs(serverInfo.name, prev => [...prev, `[Cubicase] Inicializando preparação do servidor "${serverInfo.name}"...`]);

    try {
      const version = serverInfo.version || "1.20.1";
      const javaVer = getJavaVersion(version);

      const installed = await isJREInstalled(javaVer);
      if (!installed) {
        useAppStore.getState().setMcLogs(serverInfo.name, prev => [...prev, `[Cubicase] JRE ${javaVer} não encontrado na máquina. Baixando de Adoptium...`]);
        await installJRE(javaVer, (p) => {
          setServerInstallProgress({ status: `Instalando JRE ${javaVer}: ${p.status}`, percent: p.percent });
        });
        setServerInstallProgress(null);
      }
      const jrePath = await getJREPath(javaVer);
      const javaPath = `${jrePath}\\bin\\java.exe`;

      let ram = 4;
      try {
        const metaPath = await join(serverInfo.path, 'cubicase-meta.json');
        const metaContent = await readTextFile(metaPath);
        const meta = JSON.parse(metaContent) as { ramGb?: number };
        if (typeof meta.ramGb === 'number' && meta.ramGb >= 2) ram = meta.ramGb;
      } catch (e) {
        console.warn('Could not read RAM from meta file, using default 4GB:', e);
      }

      await invoke("start_minecraft_server", {
        serverDir: serverInfo.path,
        javaPath,
        ramGb: ram,
        // A porta do Java precisa ser a real (server-port do server.properties),
        // não a "Porta Local de Convidado" global (essa é só para quando este
        // app entra como convidado em outro servidor) — ver mesmo ajuste em HostView.
        localPort: serverConfigPortRef.current,
        serverJarName: serverInfo.serverJar || null,
        launchArgsDir: serverInfo.launchArgsDir || null,
      });
    } catch (err: any) {
      console.error(err);
      useAppStore.getState().setMcLogs(serverInfo.name, prev => [...prev, `[Cubicase ERR] Falha ao iniciar automaticamente: ${err}`]);
      setServerStatus("offline");
    }
  };

  // --- Listeners Tauri (registrados UMA vez no page.tsx) ---
  useEffect(() => {
    let unlistenStatus: (() => void) | null = null;
    let unlistenLogs: (() => void) | null = null;
    let unlistenMcStatus: (() => void) | null = null;
    let unlistenMcLogs: (() => void) | null = null;
    let unlistenMcDiagnostic: (() => void) | null = null;
    let unlistenNetDiagnostic: (() => void) | null = null;
    let unlistenResourceSample: (() => void) | null = null;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");

      unlistenStatus = await listen<{ status: string; ip: string | null }>("network-status", (event) => {
        const newNetStatus = event.payload.status === "online" ? "online" : "offline";
        setNetStatus(newNetStatus);

        if (event.payload.status === "online") {
          setNetIp(event.payload.ip);
          setIsStarting(false);

          const currentSelectedServer = selectedServerRef.current;
          const currentLocalServers = localServersRef.current;

          if (currentSelectedServer) {
            const serverInfo = currentLocalServers.find(s => s.name === currentSelectedServer);
            if (serverInfo && serverInfo.shortCode) {
              registerServerWithCentral(serverInfo);

              if (pendingMcStartRef.current && currentSelectedServer) {
                pendingMcStartRef.current = false;
                setTimeout(() => {
                  const serverInfo2 = localServersRef.current.find(s => s.name === currentSelectedServer);
                  if (!serverInfo2) return;
                  startMinecraftForServer(serverInfo2);
                }, 500);
              }
            } else {
              const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
              let code = "";
              for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
              serverShortCodeRef.current = code;
              setShortCode(code);
              setLogs(prev => [...prev, `[INFO] Código gerado localmente: CF-${code}`]);
            }
          }
        } else {
          setNetStatus("offline");
          setNetMode(null);
          setNetIp(null);
          setIsStarting(false);
          pendingMcStartRef.current = false;
          // Rede mesh caiu de verdade (evento vindo do sidecar) — só aqui (ou em
          // desconexão manual/falha de conexão) é correto limpar a conexão do
          // Convidado. Nunca em um simples reload de página.
          useAppStore.getState().setGuestConnectedShortCode(null);
        }
      });

      unlistenLogs = await listen<{ message: string; is_error: boolean }>("network-log", (event) => {
        setLogs(prev => {
          const newLogs = [...prev, `[${event.payload.is_error ? 'ERR' : 'INFO'}] ${event.payload.message}`];
          return newLogs.slice(-150);
        });
        if (event.payload.is_error) {
          pushDiagnostic({
            level: "error",
            source: "Rede",
            title: "Falha na rede mesh",
            message: event.payload.message,
          });
        }
      });

      // Diagnósticos estruturados vindos do backend Rust (causa específica de
      // crash do Minecraft: porta ocupada, falta de RAM, JRE incompatível, etc)
      // e do sidecar Go (auth inválida, sem internet, hostname duplicado, etc).
      unlistenMcDiagnostic = await listen<{
        level: "info" | "warning" | "error" | "critical";
        title: string;
        message: string;
        detail?: string;
        code?: string;
        crashReportText?: string;
        crashReportFile?: string;
        resourceSnapshot?: { totalRamMb: number; availableRamMb: number; cpuUsagePercent: number; processRamMb?: number; processCpuPercent?: number };
        allocatedRamMb?: number;
      }>(
        "mc-diagnostic",
        (event) => {
          // Analisador de regras (src/lib/crashAnalyzer.ts) examina o texto completo
          // do crash-report/latest.log — mais rico que a causa de 1 linha do Rust
          // (ex: reconhece conflito de mod, dependência faltando, watchdog/trava).
          // Se nenhuma regra bater, mantém o título/mensagem genéricos vindos do backend.
          // O retrato de RAM/CPU (resourceDiagnostics.ts) refina especificamente a
          // regra de OOM: "aumente a alocação" vs. "o PC não tem RAM suficiente".
          const analysis = analyzeCrashText(event.payload.crashReportText, {
            ...event.payload.resourceSnapshot,
            allocatedRamMb: event.payload.allocatedRamMb,
          });
          const title = analysis?.title ?? event.payload.title;
          const message = analysis?.message ?? event.payload.message;
          const detail = event.payload.crashReportText
            ? event.payload.crashReportText.slice(0, 2000)
            : event.payload.detail;

          pushDiagnostic({
            level: event.payload.level,
            title,
            message,
            detail,
            source: "Servidor",
          });

          // "mc-diagnostic" só é emitido pelo Rust no caso de crash do servidor —
          // guarda a causa já traduzida para a HostView mostrar no banner de crash.
          setLastCrashInfo({ title, message, detail });

          // Auto-correção: "UnsupportedClassVersionError" quase sempre significa uma
          // instalação de JRE corrompida/incompleta para esta versão (a versão CORRETA
          // já é escolhida deterministicamente por getJavaVersion antes de cada start).
          // Reinstalar do zero e tentar iniciar de novo, uma única vez por servidor
          // nesta sessão, evita que o usuário precise diagnosticar isso manualmente.
          if (event.payload.code === "java_version_incompatible") {
            const crashedServerName = useAppStore.getState().runningServer;
            const serverInfo = crashedServerName
              ? localServersRef.current.find(s => s.name === crashedServerName)
              : null;
            if (serverInfo && !jreAutoFixAttemptedRef.current.has(serverInfo.name)) {
              jreAutoFixAttemptedRef.current.add(serverInfo.name);
              (async () => {
                try {
                  const javaVer = getJavaVersion(serverInfo.version || "1.20.1");
                  pushDiagnostic({
                    level: "info",
                    source: "Servidor",
                    title: "Corrigindo automaticamente",
                    message: `Reinstalando a JRE ${javaVer} (provável instalação corrompida) e tentando iniciar "${serverInfo.name}" novamente...`,
                  });
                  useAppStore.getState().setMcLogs(serverInfo.name, prev => [...prev, `[Cubicase] Detectada JRE ${javaVer} incompatível/corrompida — reinstalando automaticamente...`]);
                  const jrePath = await getJREPath(javaVer);
                  await remove(jrePath, { recursive: true }).catch(() => {});
                  await startMinecraftForServer(serverInfo);
                } catch (err) {
                  console.error("[AutoFix JRE] Falha ao corrigir automaticamente:", err);
                }
              })();
            }
          }
        }
      );
      unlistenNetDiagnostic = await listen<{ level: "info" | "warning" | "error" | "critical"; title: string; message: string; detail?: string }>(
        "network-diagnostic",
        (event) => {
          pushDiagnostic({ ...event.payload, source: "Rede" });
        }
      );

      unlistenMcStatus = await listen<string>("minecraft-status-changed", (event) => {
        const status = event.payload as ServerStatus;
        setServerStatus(status);

        // Fora do estado "online" não há jogadores conectados: zera a lista
        // para não reportar jogadores desatualizados na próxima vez que ficar online.
        if (status !== "online") {
          useAppStore.getState().setOnlinePlayers([]);
        }

        // Novo start: zera a janela do detector de lag e do monitor de
        // recursos para não arrastar contagem de uma sessão anterior do processo.
        if (status === "starting") {
          lagMonitorRef.current.reset();
          resourceMonitorRef.current.reset();
          latestResourceSampleRef.current = null;
          setResourceSample(null);
          lastAutoBackupAtRef.current = Date.now();
        }

        let statusMsg = "";
        switch (status) {
          case "online": statusMsg = "[Cubicase] Servidor de Minecraft está ONLINE!"; break;
          case "offline": statusMsg = "[Cubicase] Servidor de Minecraft está OFFLINE."; break;
          case "starting": statusMsg = "[Cubicase] Servidor de Minecraft está INICIANDO..."; break;
          case "stopping": statusMsg = "[Cubicase] Servidor de Minecraft está PARANDO..."; break;
          case "crashed": statusMsg = "[Cubicase ERR] O servidor de Minecraft fechou de forma inesperada (CRASHED)!"; break;
        }
        if (statusMsg) appendMcLogToRunningServer(statusMsg);

        // Backup automático na parada normal e no crash (ver src/lib/autoBackup.ts) —
        // pula sozinho se o mundo não mudou desde o último backup (exceto em crash).
        if (status === "offline" || status === "crashed") {
          const runningServerName = useAppStore.getState().runningServer;
          const serverInfo = runningServerName
            ? localServersRef.current.find(s => s.name === runningServerName)
            : null;
          if (serverInfo) {
            const { autoBackupEnabled: enabled, backupRetentionCount: retentionCount } = useAppStore.getState();
            maybeBackupWorld(serverInfo.path, status === "crashed" ? "crash" : "stop", { enabled, retentionCount });
          }
        }
      });

      unlistenMcLogs = await listen<string>("minecraft-log", (event) => {
        const line = event.payload.trim();
        // Não há RCON/consulta de estado disponível — a lista de jogadores online
        // (exibida no painel de Jogadores) é derivada das mensagens padrão do
        // servidor vanilla ("X joined/left the game"). O nome é sempre a última
        // palavra antes desse sufixo, independente do prefixo de timestamp/thread
        // (que varia entre vanilla/Forge/Fabric/Paper).
        const joinedMatch = /(\S+) joined the game$/.exec(line);
        const leftMatch = /(\S+) left the game$/.exec(line);
        if (joinedMatch) {
          useAppStore.getState().addOnlinePlayer(joinedMatch[1]);
        } else if (leftMatch) {
          useAppStore.getState().removeOnlinePlayer(leftMatch[1]);
        }

        // Detecção de lag/trava baseada em regras sobre o próprio aviso do
        // Minecraft (ver src/lib/lagDetector.ts) — não precisa de RCON. A
        // mensagem é enriquecida com o retrato de RAM/CPU real da máquina
        // (resourceDiagnostics.ts) pra apontar se o gargalo é CPU, RAM do
        // sistema, ou provavelmente um mod específico.
        const lagDiagnostic = lagMonitorRef.current.ingestLine(line);
        if (lagDiagnostic) {
          const bottleneck = explainResourceBottleneck(latestResourceSampleRef.current);
          pushDiagnostic({
            ...lagDiagnostic,
            message: bottleneck ? `${lagDiagnostic.message} ${bottleneck}` : lagDiagnostic.message,
            source: "Servidor",
          });
        }

        appendMcLogToRunningServer(event.payload);
      });

      // Amostra periódica de RAM/CPU real da máquina (a cada ~15s enquanto o
      // servidor roda — ver a thread de amostragem em src-tauri/src/lib.rs).
      // Alimenta o indicador de saúde na UI e o monitor de pressão sustentada
      // (aviso proativo antes mesmo do Minecraft acusar lag no log).
      unlistenResourceSample = await listen<ResourceSnapshot>("mc-resource-sample", (event) => {
        latestResourceSampleRef.current = event.payload;
        setResourceSample(event.payload);

        const resourceDiagnostic = resourceMonitorRef.current.ingestSample(event.payload);
        if (resourceDiagnostic) {
          pushDiagnostic({ ...resourceDiagnostic, source: "Servidor" });
        }

        // "Backup de segurança": reaproveita este tick de ~15s como relógio
        // pra sessões longas que nunca são paradas manualmente (ver
        // src/lib/autoBackup.ts) — sem precisar de um novo timer.
        const safetyNetIntervalMs = useAppStore.getState().backupSafetyNetIntervalHours * 60 * 60 * 1000;
        if (Date.now() - lastAutoBackupAtRef.current >= safetyNetIntervalMs) {
          lastAutoBackupAtRef.current = Date.now();
          const runningServerName = useAppStore.getState().runningServer;
          const serverInfo = runningServerName
            ? localServersRef.current.find(s => s.name === runningServerName)
            : null;
          if (serverInfo) {
            const { autoBackupEnabled: enabled, backupRetentionCount: retentionCount } = useAppStore.getState();
            maybeBackupWorld(serverInfo.path, "safety-net", { enabled, retentionCount });
          }
        }
      });

      // Restaurar estado real APÓS os listeners estarem registrados.
      // Se chamássemos antes, os listeners sobrescreveriam o estado.
      try {
        const status = await invoke<{ minecraftStatus: string; netStatus: string; netMode: "host" | "guest" | null; ip: string | null }>("get_system_status");
        console.log("[Restore] Estado do sistema após recarga:", status);

        if (status.netStatus === "online") {
          setNetStatus("online");
          setNetMode(status.netMode ?? null);
          setNetIp(status.ip || null);
          // Se a rede mesh restaurada não for do Convidado, qualquer
          // guestConnectedShortCode persistido de uma sessão anterior está
          // desatualizado (ex: o usuário virou host nesse meio tempo).
          if (status.netMode !== "guest") {
            useAppStore.getState().setGuestConnectedShortCode(null);
          }
        } else {
          // Mesh real está offline agora — a conexão do Convidado persistida
          // (se houver) não reflete mais a realidade.
          useAppStore.getState().setGuestConnectedShortCode(null);
        }
        if (status.minecraftStatus === "online") {
          setServerStatus("online");
          appendMcLogToRunningServer("[Cubicase] ✅ Servidor Minecraft já estava ONLINE (detectado após recarga).");
        } else if (status.minecraftStatus === "crashed") {
          setServerStatus("crashed");
          appendMcLogToRunningServer("[Cubicase] ❌ Servidor Minecraft estava CRASHADO (detectado após recarga).");
        } else if (status.minecraftStatus === "starting") {
          setServerStatus("starting");
          appendMcLogToRunningServer("[Cubicase] ⏳ Servidor Minecraft ainda está inicializando (detectado após recarga).");
        }
      } catch (err) {
        console.warn("[Restore] Erro ao verificar estado do sistema:", err);
      }
    })();

    return () => {
      unlistenStatus?.();
      unlistenLogs?.();
      unlistenMcStatus?.();
      unlistenMcLogs?.();
      unlistenMcDiagnostic?.();
      unlistenNetDiagnostic?.();
      unlistenResourceSample?.();
    };
  }, [setServerStatus, setLastCrashInfo, minecraftPort]);

  // Login opcional (Supabase) — registra o listener do deep link de volta
  // do fluxo de login uma única vez. Ver src/lib/auth.ts.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { initAuthListener } = await import("@/lib/auth");
      const unlisten = await initAuthListener();
      if (cancelled) unlisten();
      else cleanup = unlisten;
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  // --- Guest Handlers ---
  const handleGuestConnect = async (inviteCode: string) => {
    setLogs([]);
    setDiscoveredServer(null);
    setNetStatus("connecting");
    setNetMode("guest");
    setLogs(prev => [...prev, `[INFO] Conectando ao código ${inviteCode}...`]);

    let discoveredName: string | null = null;
    const shortCodeClean = inviteCode.replace("CF-", "");

    // A descoberta agora é obrigatória: é dela que vem o IP de malha real do
    // host (session.hostIp) — sem isso não tem pra onde discar. O código de
    // convite sozinho (CF-XXXXXX) só carrega o shortCode, nunca um IP.
    let hostIp: string | null = null;
    try {
      const response = await fetch(`https://cubeforge-api.cubeforge.workers.dev/api/v1/servers/${shortCodeClean}`);
      if (response.ok) {
        // Envelope da API Central: metadados em data.server, status em data.session.
        const envelope = await response.json();
        const server = envelope?.data?.server ?? {};
        const session = envelope?.data?.session ?? {};
        setLogs(prev => [...prev, `[INFO] Servidor encontrado: ${server.name} (${server.version})`]);
        setDiscoveredServer({
          name: server.name,
          version: server.version,
          status: session.status,
          description: server.description,
        });
        discoveredName = server.name ?? null;
        hostIp = session.hostIp ?? null;
      }
    } catch {
      // tratado abaixo pelo `!hostIp`
    }

    if (!hostIp) {
      setNetStatus("offline");
      setNetMode(null);
      useAppStore.getState().setGuestConnectedShortCode(null);
      setLogs(prev => [...prev, `[ERR] Não foi possível encontrar esse servidor online. Confira o código ou peça para o host verificar se a rede mesh dele está ativa.`]);
      pushDiagnostic({
        level: "error",
        source: "Rede",
        title: "Servidor não encontrado",
        message: "A API Central não retornou um endereço de rede para esse código — o host provavelmente não está com a rede mesh online agora.",
      });
      return;
    }

    try {
      await invoke("start_network_node", {
        mode: "guest",
        shortCode: shortCodeClean,
        targetIp: hostIp,
        localPort: minecraftPort,
      });
      setNetStatus("online");
      setNetMode("guest");
      setLogs(prev => [...prev, `[INFO] ✅ Túnel estabelecido! Conecte-se em localhost:${minecraftPort}`]);

      // Adiciona (ou atualiza) automaticamente o servidor na lista "Multiplayer"
      // do cliente Minecraft do convidado, editando o servers.dat diretamente —
      // evita que o jogador precise digitar "localhost:<porta>" na mão. Melhor
      // esforço: se não achar a instalação do launcher, o app continua
      // funcionando normalmente (o convidado só digita o endereço manualmente).
      try {
        const result = await invoke<string>("add_minecraft_server_entry", {
          name: discoveredName ?? "Servidor CubeForge",
          address: `localhost:${minecraftPort}`,
        });
        if (result === "added") {
          setLogs(prev => [...prev, `[INFO] ✅ Servidor adicionado automaticamente à sua lista de Multiplayer do Minecraft.`]);
        } else {
          setLogs(prev => [...prev, `[INFO] Não encontramos sua instalação do Minecraft — adicione "localhost:${minecraftPort}" manualmente na lista de Multiplayer.`]);
        }
      } catch (err) {
        console.warn("[Guest] Falha ao adicionar servidor ao cliente Minecraft:", err);
        setLogs(prev => [...prev, `[INFO] Não foi possível adicionar o servidor automaticamente — adicione "localhost:${minecraftPort}" manualmente na lista de Multiplayer.`]);
      }
    } catch (err) {
      console.error(err);
      setNetStatus("offline");
      setNetMode(null);
      useAppStore.getState().setGuestConnectedShortCode(null);
      setLogs(prev => [...prev, `[ERR] Falha ao conectar: ${err}`]);
      pushDiagnostic({
        level: "error",
        source: "Rede",
        title: "Falha ao conectar ao servidor",
        message: String(err),
      });
    }
  };

  const handleGuestDisconnect = async () => {
    try {
      await invoke("stop_network_node");
      setNetStatus("offline");
      setNetMode(null);
      setNetIp(null);
      setDiscoveredServer(null);
      useAppStore.getState().setGuestConnectedShortCode(null);
      setLogs(prev => [...prev, `[INFO] Conexão encerrada.`]);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="min-h-screen bg-theme-bg transition-colors duration-300">
      <DiagnosticsToasts />
      <UpdateBanner />
      {/* Cabeçalho */}
      <header className="sticky top-0 z-40 bg-theme-card/80 backdrop-blur-xl border-b border-theme-card">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={mounted ? (resolvedTheme === "dark" ? "/icon-dark.png" : "/icon.png") : "/icon.png"}
              alt="Cubicase"
              className="h-7"
            />
          </div>

          <div className="flex items-center gap-3">
            {/* Seletor de Modo */}
            <div className="flex bg-theme-muted p-1 rounded-2xl border border-theme-card">
              <button
                type="button"
                onClick={() => setMode("host")}
                className={cn(
                  "px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer",
                  mode === "host"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-theme-secondary hover:text-theme-primary"
                )}
              >
                <Monitor className="w-3.5 h-3.5" />
                Host
              </button>
              <button
                type="button"
                onClick={() => setMode("guest")}
                className={cn(
                  "px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer",
                  mode === "guest"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-theme-secondary hover:text-theme-primary"
                )}
              >
                <Globe className="w-3.5 h-3.5" />
                Convidado
              </button>
            </div>

            <DiagnosticsBell />
            <button
              type="button"
              onClick={() => setShowAppSettings(true)}
              title="Configurações"
              className="w-9 h-9 flex items-center justify-center rounded-xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors cursor-pointer"
            >
              <SettingsIcon className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>
      </header>

      <AppSettingsPanel isOpen={showAppSettings} onClose={() => setShowAppSettings(false)} />

      {/* Conteúdo Principal */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {mode === "host" ? (
          <HostView
            netStatus={netStatus}
            netMode={netMode}
            netIp={netIp}
            isStarting={isStarting}
            downloadProgress={downloadProgress}
            logs={logs}
            mcLogs={mcLogs}
            localServers={localServers}
            showCreateServer={showCreateServer}
            showSettings={showSettings}
            showConfigModal={showConfigModal}
            configServerDir={configServerDir}
            serverInstallProgress={serverInstallProgress}
            isDeletingServer={isDeletingServer}
            deleteConfirmServer={deleteConfirmServer}
            totalSystemRamGb={totalSystemRamGb}
            serverConfigPort={serverConfigPort}
            copied={copied}
            shortCode={shortCode}
            resourceSample={resourceSample}
            onSetNetStatus={setNetStatus}
            onSetNetMode={setNetMode}
            onSetNetIp={setNetIp}
            onSetIsStarting={setIsStarting}
            onSetDownloadProgress={setDownloadProgress}
            onSetLogs={setLogs}
            onSetMcLogs={onSetMcLogsForSelected}
            onSetLocalServers={setLocalServers}
            onSetShowCreateServer={setShowCreateServer}
            onSetShowSettings={setShowSettings}
            onSetShowConfigModal={setShowConfigModal}
            onSetConfigServerDir={setConfigServerDir}
            onSetServerInstallProgress={setServerInstallProgress}
            onSetIsDeletingServer={setIsDeletingServer}
            onSetDeleteConfirmServer={setDeleteConfirmServer}
            onSetTotalSystemRamGb={setTotalSystemRamGb}
            onSetServerConfigPort={setServerConfigPort}
            onSetCopied={setCopied}
            onSetShortCode={setShortCode}
            onRegisterServer={registerServerWithCentral}
          />
        ) : (
          <GuestView
            netStatus={netStatus}
            minecraftPort={minecraftPort}
            onConnect={handleGuestConnect}
            onDisconnect={handleGuestDisconnect}
          />
        )}
      </main>
    </div>
  );
}
