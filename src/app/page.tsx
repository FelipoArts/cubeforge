"use client";

import { useState, useRef, useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Globe,
  Monitor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { useAppStore, type ServerStatus } from "@/app/store";
import type { DownloadProgress } from "@/lib/jre";
import {
  type ServerInfo,
  type ServerInstallProgress,
} from "@/lib/server";
import { useTheme } from "next-themes";
import { ThemeToggle } from "@/app/components/ThemeToggle";

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

  // --- Store ---
  const {
    serverDir,
    setServerDir,
    minecraftPort,
    setMinecraftPort,
    selectedServer,
    setSelectedServer,
    serverStatus,
    setServerStatus,
  } = useAppStore();

  // --- Estados locais (compartilhados entre Host e Guest) ---
  const [mode, setMode] = useState<"host" | "guest">("host");
  const [netStatus, setNetStatus] = useState<"offline" | "connecting" | "online">("offline");
  const [netIp, setNetIp] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [mcLogs, setMcLogs] = useState<string[]>([]);

  // Carregar logs do localStorage na montagem e persistir em toda mudança
  // IMPORTANTE: isso precisa acontecer em UM único useEffect para evitar que
  // o salvamento com array vazio sobrescreva os dados carregados.
  const logsLoadedRef = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('cubeforge-storage');
      if (raw) {
        const parsed = JSON.parse(raw);
        const savedLogs = parsed?.state?.logs;
        const savedMcLogs = parsed?.state?.mcLogs;
        if (savedLogs?.length || savedMcLogs?.length) {
          setLogs(savedLogs?.slice(-150) || []);
          setMcLogs(savedMcLogs?.slice(-500) || []);
          logsLoadedRef.current = true;
          return; // Não persiste de volta logo após carregar
        }
      }
    } catch {}

    // Se não tinha nada no localStorage, marca como carregado mesmo assim
    logsLoadedRef.current = true;
  }, []);

  // Persistir SEPARADAMENTE: só roda quando logs/mcLogs mudam (não na montagem)
  const prevLogsRef = useRef<string[]>([]);
  const prevMcLogsRef = useRef<string[]>([]);
  useEffect(() => {
    // Ignorar a primeira execução (quando logsLoadedRef acabou de ficar true)
    if (!logsLoadedRef.current) return;
    // Só persistir se realmente mudou
    if (logs === prevLogsRef.current && mcLogs === prevMcLogsRef.current) return;
    prevLogsRef.current = logs;
    prevMcLogsRef.current = mcLogs;
    try {
      const raw = localStorage.getItem('cubeforge-storage');
      if (raw) {
        const parsed = JSON.parse(raw);
        parsed.state = parsed.state || {};
        parsed.state.logs = logs.slice(-150);
        parsed.state.mcLogs = mcLogs.slice(-500);
        localStorage.setItem('cubeforge-storage', JSON.stringify(parsed));
      }
    } catch {}
  }, [logs, mcLogs]);

  const [localServers, setLocalServers] = useState<ServerInfo[]>([]);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configServerDir, setConfigServerDir] = useState<string | null>(null);
  const [serverInstallProgress, setServerInstallProgress] = useState<ServerInstallProgress | null>(null);
  const [isDeletingServer, setIsDeletingServer] = useState<string | null>(null);
  const [deleteConfirmServer, setDeleteConfirmServer] = useState<string | null>(null);
  const [totalSystemRamGb, setTotalSystemRamGb] = useState(8);
  const [serverConfigPort, setServerConfigPort] = useState(25565);
  const [settingsPort, setSettingsPort] = useState(25565);
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
  const serverShortCodeRef = useRef<string>("");
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sincronizar refs
  useEffect(() => { selectedServerRef.current = selectedServer; }, [selectedServer]);
  useEffect(() => { localServersRef.current = localServers; }, [localServers]);
  useEffect(() => { serverConfigPortRef.current = serverConfigPort; }, [serverConfigPort]);
  useEffect(() => { netStatusRef.current = netStatus; }, [netStatus]);
  useEffect(() => { serverStatusRef.current = serverStatus; }, [serverStatus]);

  // --- Heartbeat periódico para manter servidor "vivo" na API Central ---
  // A API Central tem um heartbeat timeout de 300s (5 min).
  // Enviamos heartbeats a cada 60s para garantir que o servidor não seja
  // marcado como offline por inatividade.
  //
  // Este useEffect monitora TANTO serverStatus quanto shortCode.
  // Se o shortCode for definido DEPOIS que o servidor já está online
  // (ex: rede mesh demorou para conectar), o heartbeat ainda assim inicia.
  useEffect(() => {
    // Limpar intervalo anterior se existir
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    // Só iniciar heartbeat se o servidor estiver online e tiver shortCode
    const currentShortCode = serverShortCodeRef.current;
    if (serverStatus === "online" && currentShortCode) {
      setLogs(prev => [...prev, `[INFO] ❤️ Iniciando heartbeat (a cada 60s) para CF-${currentShortCode}...`]);

      // Enviar um heartbeat imediatamente ao iniciar
      invoke("sync_send_heartbeat", {
        shortCode: currentShortCode,
        status: "online",
        currentPlayers: null,
      }).then(() => {
        setLogs(prev => [...prev, `[INFO] ❤️ Heartbeat inicial enviado para CF-${currentShortCode}`]);
      }).catch((err: any) => {
        console.warn("[Heartbeat] Falha no heartbeat inicial:", err);
        setLogs(prev => [...prev, `[WARN] ❤️ Heartbeat inicial falhou: ${err}`]);
      });

      heartbeatIntervalRef.current = setInterval(() => {
        const sc = serverShortCodeRef.current;
        const st = serverStatusRef.current;
        if (sc && st === "online") {
          invoke("sync_send_heartbeat", {
            shortCode: sc,
            status: st,
            currentPlayers: null,
          }).catch((err: any) => {
            console.warn("[Heartbeat] Falha ao enviar heartbeat:", err);
          });
        }
      }, 60_000); // 60 segundos
    }

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
  }, [serverStatus, shortCode, setLogs]);

  // --- Listeners Tauri (registrados UMA vez no page.tsx) ---
  useEffect(() => {
    let unlistenStatus: (() => void) | null = null;
    let unlistenLogs: (() => void) | null = null;
    let unlistenMcStatus: (() => void) | null = null;
    let unlistenMcLogs: (() => void) | null = null;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");

      unlistenStatus = await listen<{ status: string; ip: string | null }>("network-status", (event) => {
        if (event.payload.status === "online") {
          setNetStatus("online");
          setNetIp(event.payload.ip);
          setIsStarting(false);

          const currentSelectedServer = selectedServerRef.current;
          const currentLocalServers = localServersRef.current;
          const currentServerConfigPort = serverConfigPortRef.current;

          if (currentSelectedServer) {
            const serverInfo = currentLocalServers.find(s => s.name === currentSelectedServer);
            if (serverInfo && serverInfo.shortCode) {
              // Usar o shortCode do meta.json como identificador fixo na API
              const metaShortCode = serverInfo.shortCode;
              serverShortCodeRef.current = metaShortCode;
              setShortCode(metaShortCode);
              setLogs(prev => [...prev, `[INFO] Código do servidor: CF-${metaShortCode}`]);

              // Registrar servidor na API Central (entidade permanente)
              const currentMcStatus = serverStatusRef.current;
              invoke("sync_register_server", {
                name: currentSelectedServer,
                version: serverInfo.version || "1.20.1",
                serverType: "vanilla",
                description: `Servidor Minecraft Vanilla ${serverInfo.version || "1.20.1"}`,
                shortCode: metaShortCode,
                owner: null,
              }).then((responseJson: any) => {
                try {
                  const response = typeof responseJson === "string" ? JSON.parse(responseJson) : responseJson;
                  if (response.code === "SERVER_CREATED") {
                    setLogs(prev => [...prev, `[INFO] ✅ Servidor registrado na API Central! Código: CF-${metaShortCode}, Status: ${currentMcStatus}`]);
                  } else if (response.code === "QUEUED") {
                    setLogs(prev => [...prev, `[INFO] ⏳ Servidor enfileirado para sincronização. Código: CF-${metaShortCode}`]);
                  }
                } catch {
                  setLogs(prev => [...prev, `[INFO] ✅ Servidor registrado na API Central! Status: ${currentMcStatus}`]);
                }
              }).catch(() => {
                setLogs(prev => [...prev, `[INFO] ⚠ API Central indisponível. Servidor funcionando em modo offline.`]);
              });

              if (pendingMcStartRef.current && currentSelectedServer) {
                pendingMcStartRef.current = false;
                setTimeout(() => {
                  // Dispara o start do MC server via invoke direto
                  const serverInfo2 = localServersRef.current.find(s => s.name === currentSelectedServer);
                  if (serverInfo2) {
                    setServerStatus("starting");
                    setMcLogs(prev => [...prev, `[Cubicase] Inicializando preparação do servidor "${currentSelectedServer}"...`]);
                    invoke("start_minecraft_server", {
                      serverDir: serverInfo2.path,
                      javaPath: "",
                      ramGb: 4,
                      localPort: minecraftPort,
                    }).catch((err: any) => {
                      console.error(err);
                      setServerStatus("offline");
                    });
                  }
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
          setNetIp(null);
          setIsStarting(false);
          pendingMcStartRef.current = false;

          // Rede mesh caiu → atualizar status combinado para a API
          const currentShortCode = serverShortCodeRef.current;
          const currentMcStatus = serverStatusRef.current;
          if (currentShortCode) {
            // Se mesh caiu, status efetivo é "offline" (mesmo se MC estiver rodando)
            invoke("sync_send_heartbeat", {
              shortCode: currentShortCode,
              status: "offline",
              currentPlayers: null,
            }).catch(() => {});
          }
        }
      });

      unlistenLogs = await listen<{ message: string; is_error: boolean }>("network-log", (event) => {
        setLogs(prev => {
          const newLogs = [...prev, `[${event.payload.is_error ? 'ERR' : 'INFO'}] ${event.payload.message}`];
          return newLogs.slice(-150);
        });
      });

      unlistenMcStatus = await listen<string>("minecraft-status-changed", (event) => {
        const status = event.payload as ServerStatus;
        setServerStatus(status);

        const currentShortCode = serverShortCodeRef.current;
        if (currentShortCode) {
          // Status combinado: só "online" se AMBOS servidor MC e rede mesh estiverem online
          const currentNetStatus = netStatusRef.current;
          const effectiveStatus = (status === "online" && currentNetStatus === "online") ? "online" : status;

          invoke("sync_send_heartbeat", {
            shortCode: currentShortCode,
            status: effectiveStatus,
            hostIp: currentNetStatus === "online" ? netIp : "0.0.0.0",
            currentPlayers: null,
          }).then(() => {
            setLogs(prev => [...prev, `[API] Status atualizado na API Central: ${effectiveStatus}`]);
          }).catch((err: any) => {
            console.warn("[API] Falha ao atualizar status na API Central:", err);
            setLogs(prev => [...prev, `[WARN] API Central: falha ao atualizar status (${err})`]);
          });
        }

        let statusMsg = "";
        switch (status) {
          case "online": statusMsg = "[Cubicase] Servidor de Minecraft está ONLINE!"; break;
          case "offline": statusMsg = "[Cubicase] Servidor de Minecraft está OFFLINE."; break;
          case "starting": statusMsg = "[Cubicase] Servidor de Minecraft está INICIANDO..."; break;
          case "stopping": statusMsg = "[Cubicase] Servidor de Minecraft está PARANDO..."; break;
          case "crashed": statusMsg = "[Cubicase ERR] O servidor de Minecraft fechou de forma inesperada (CRASHED)!"; break;
        }
        if (statusMsg) setMcLogs(prev => [...prev, statusMsg]);
      });

      unlistenMcLogs = await listen<string>("minecraft-log", (event) => {
        setMcLogs(prev => {
          const newLogs = [...prev, event.payload];
          return newLogs.slice(-500);
        });
      });

      // Restaurar estado real APÓS os listeners estarem registrados.
      // Se chamássemos antes, os listeners sobrescreveriam o estado.
      try {
        const status = await invoke<{ minecraftStatus: string; netStatus: string; ip: string | null }>("get_system_status");
        console.log("[Restore] Estado do sistema após recarga:", status);

        if (status.netStatus === "online") {
          setNetStatus("online");
          setNetIp(status.ip || null);
        }
        if (status.minecraftStatus === "online") {
          setServerStatus("online");
          setMcLogs(prev => [...prev, "[Cubicase] ✅ Servidor Minecraft já estava ONLINE (detectado após recarga)."]);
        } else if (status.minecraftStatus === "crashed") {
          setServerStatus("crashed");
          setMcLogs(prev => [...prev, "[Cubicase] ❌ Servidor Minecraft estava CRASHADO (detectado após recarga)."]);
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
    };
  }, [setServerStatus, minecraftPort]);

  // --- Guest Handlers ---
  const handleGuestConnect = async (inviteCode: string) => {
    setLogs([]);
    setDiscoveredServer(null);
    setNetStatus("connecting");
    setLogs(prev => [...prev, `[INFO] Conectando ao código ${inviteCode}...`]);

    try {
      const shortCodeClean = inviteCode.replace("CF-", "");
      const response = await fetch(`https://cubeforge-api.cubeforge.workers.dev/api/servers/${shortCodeClean}`);
      if (response.ok) {
        const data = await response.json();
        setLogs(prev => [...prev, `[INFO] Servidor encontrado: ${data.name} (${data.version})`]);
        setDiscoveredServer({
          name: data.name,
          version: data.version,
          status: data.status,
          description: data.description,
        });
      } else {
        setLogs(prev => [...prev, `[INFO] API Central indisponível. Conectando diretamente...`]);
      }
    } catch {
      setLogs(prev => [...prev, `[INFO] API Central indisponível. Conectando diretamente...`]);
    }

    try {
      await invoke("start_network_node", {
        mode: "guest",
        targetIp: inviteCode,
        localPort: minecraftPort,
      });
      setNetStatus("online");
      setLogs(prev => [...prev, `[INFO] ✅ Túnel estabelecido! Conecte-se em localhost:${minecraftPort}`]);
    } catch (err) {
      console.error(err);
      setNetStatus("offline");
      setLogs(prev => [...prev, `[ERR] Falha ao conectar: ${err}`]);
      alert("Falha ao conectar: " + err);
    }
  };

  const handleGuestDisconnect = async () => {
    try {
      await invoke("stop_network_node");
      setNetStatus("offline");
      setNetIp(null);
      setDiscoveredServer(null);
      setLogs(prev => [...prev, `[INFO] Conexão encerrada.`]);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="min-h-screen bg-theme-bg transition-colors duration-300">
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

            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Conteúdo Principal */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {mode === "host" ? (
          <HostView
            netStatus={netStatus}
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
            settingsPort={settingsPort}
            copied={copied}
            shortCode={shortCode}
            onSetNetStatus={setNetStatus}
            onSetNetIp={setNetIp}
            onSetIsStarting={setIsStarting}
            onSetDownloadProgress={setDownloadProgress}
            onSetLogs={setLogs}
            onSetMcLogs={setMcLogs}
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
            onSetSettingsPort={setSettingsPort}
            onSetCopied={setCopied}
            onSetShortCode={setShortCode}
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
