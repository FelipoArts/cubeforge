"use client";

import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Settings,
  Play,
  Copy,
  Check,
  ShieldCheck,
  Activity,
  FolderOpen,
  X,
  Loader2,
  AlertTriangle,
  Database,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile, remove } from "@tauri-apps/plugin-fs";
import { useAppStore, type ServerStatus } from "@/app/store";
import { pushDiagnostic } from "@/app/diagnostics";
import { installJRE, isJREInstalled, getJREPath, type DownloadProgress } from "@/lib/jre";
import {
  listLocalServers,
  installMinecraftServer,
  installForgeServer,
  installFabricServer,
  installPaperServer,
  importExistingServer,
  scanExternalServer,
  getJavaVersion,
  type ServerInfo,
  type ServerInstallProgress,
} from "@/lib/server";
import type { ResourceSnapshot } from "@/lib/resourceDiagnostics";
import { installModpack, type ParsedModpack } from "@/lib/modpackImport";
import { openDonationCheckout } from "@/lib/donations";
import { ServerConfigModal } from "@/app/ServerConfigModal";
import { ConsolePanel } from "./ConsolePanel";
import { ServerManagePanel } from "./ServerManagePanel";
import { PlayersPanel } from "./PlayersPanel";
import { ServerList } from "./ServerList";
import { CreateServerModal } from "./CreateServerModal";
import { ImportModpackModal } from "./ImportModpackModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { SettingsModal } from "./SettingsModal";

// ============================================================
// HostView
// ============================================================
// Painel principal do host. Orquestra todos os subcomponentes.
// Recebe estados e callbacks do page.tsx para preservar estado
// ao alternar entre abas Host/Guest.
// ============================================================

interface HostViewProps {
  netStatus: "offline" | "connecting" | "online";
  netIp: string | null;
  isStarting: boolean;
  downloadProgress: DownloadProgress | null;
  logs: string[];
  mcLogs: string[];
  localServers: ServerInfo[];
  showCreateServer: boolean;
  showSettings: boolean;
  showConfigModal: boolean;
  configServerDir: string | null;
  serverInstallProgress: ServerInstallProgress | null;
  isDeletingServer: string | null;
  deleteConfirmServer: string | null;
  totalSystemRamGb: number;
  serverConfigPort: number;
  copied: boolean;
  shortCode: string;
  resourceSample: ResourceSnapshot | null;

  // Callbacks
  onSetNetStatus: (status: "offline" | "connecting" | "online") => void;
  onSetNetIp: (ip: string | null) => void;
  onSetIsStarting: (v: boolean) => void;
  onSetDownloadProgress: (p: DownloadProgress | null) => void;
  onSetLogs: (logs: string[] | ((prev: string[]) => string[])) => void;
  onSetMcLogs: (logs: string[] | ((prev: string[]) => string[])) => void;
  onSetLocalServers: (servers: ServerInfo[]) => void;
  onSetShowCreateServer: (v: boolean) => void;
  onSetShowSettings: (v: boolean) => void;
  onSetShowConfigModal: (v: boolean) => void;
  onSetConfigServerDir: (v: string | null) => void;
  onSetServerInstallProgress: (p: ServerInstallProgress | null) => void;
  onSetIsDeletingServer: (v: string | null) => void;
  onSetDeleteConfirmServer: (v: string | null) => void;
  onSetTotalSystemRamGb: (v: number) => void;
  onSetServerConfigPort: (v: number) => void;
  onSetCopied: (v: boolean) => void;
  onSetShortCode: (v: string) => void;
}

export function HostView({
  netStatus,
  netIp,
  isStarting,
  downloadProgress,
  logs,
  mcLogs,
  localServers,
  showCreateServer,
  showSettings,
  showConfigModal,
  configServerDir,
  serverInstallProgress,
  isDeletingServer,
  deleteConfirmServer,
  totalSystemRamGb,
  serverConfigPort,
  copied,
  shortCode,
  resourceSample,

  onSetNetStatus,
  onSetNetIp,
  onSetIsStarting,
  onSetDownloadProgress,
  onSetLogs,
  onSetMcLogs,
  onSetLocalServers,
  onSetShowCreateServer,
  onSetShowSettings,
  onSetShowConfigModal,
  onSetConfigServerDir,
  onSetServerInstallProgress,
  onSetIsDeletingServer,
  onSetDeleteConfirmServer,
  onSetTotalSystemRamGb,
  onSetServerConfigPort,
  onSetCopied,
  onSetShortCode,
}: HostViewProps) {
  // --- Store ---
  const {
    serverDir,
    setServerDir,
    minecraftPort,
    setMinecraftPort,
    autoBackupEnabled,
    setAutoBackupEnabled,
    backupRetentionCount,
    setBackupRetentionCount,
    selectedServer,
    setSelectedServer,
    setRunningServer,
    serverStatus,
    setServerStatus,
    lastCrashInfo,
    importedServerPaths,
    addImportedServerPath,
    removeImportedServerPath,
  } = useAppStore();

  // --- Estado ---
  const [isImporting, setIsImporting] = useState(false);
  const [showCrashDetail, setShowCrashDetail] = useState(false);
  const [showImportModpack, setShowImportModpack] = useState(false);
  const [isOpeningDonation, setIsOpeningDonation] = useState(false);

  // Refs para evitar closure stale
  const selectedServerRef = useRef<string | null>(null);
  const localServersRef = useRef<ServerInfo[]>([]);
  const serverConfigPortRef = useRef(25565);
  const netStatusRef = useRef<"offline" | "connecting" | "online">("offline");
  const pendingMcStartRef = useRef(false);
  const serverShortCodeRef = useRef<string>("");

  // Sincronizar refs
  useEffect(() => { selectedServerRef.current = selectedServer; }, [selectedServer]);
  useEffect(() => { localServersRef.current = localServers; }, [localServers]);
  useEffect(() => { serverConfigPortRef.current = serverConfigPort; }, [serverConfigPort]);
  useEffect(() => { netStatusRef.current = netStatus; }, [netStatus]);

  // --- Efeitos ---

  // Inicializar diretório padrão
  useEffect(() => {
    (async () => {
      if (!serverDir) {
        const docs = await documentDir();
        setServerDir(`${docs}\\CubicaseServers`);
      }
    })();
  }, [serverDir, setServerDir]);

  // Carregar servidores (locais + importados) e RAM total
  useEffect(() => {
    (async () => {
      try {
        // 1. Servidores padrão (pasta CubicaseServers)
        const defaultServers = await listLocalServers();

        // 2. Servidores importados (paths salvos no store)
        const importedResults: ServerInfo[] = [];
        const validImportedPaths: string[] = [];
        for (const path of importedServerPaths) {
          try {
            const scanned = await scanExternalServer(path);
            if (scanned) {
              importedResults.push(scanned);
              validImportedPaths.push(path);
            }
          } catch (err) {
            console.warn(`Erro ao escanear servidor importado em ${path}:`, err);
            // Path não é mais acessível — remover da lista persistida
          }
        }

        // Limpar paths de servidores importados que não existem mais (ex: deletados manualmente)
        if (validImportedPaths.length !== importedServerPaths.length) {
          const toRemove = importedServerPaths.filter(p => !validImportedPaths.includes(p));
          for (const p of toRemove) {
            removeImportedServerPath(p);
          }
        }

        // 3. Merge: servidores importados não duplicam os padrão
        const allServerPaths = new Set(defaultServers.map(s => s.path.toLowerCase()));
        for (const imp of importedResults) {
          if (!allServerPaths.has(imp.path.toLowerCase())) {
            defaultServers.push(imp);
            allServerPaths.add(imp.path.toLowerCase());
          }
        }

        onSetLocalServers(defaultServers);

        // 4. Se o servidor selecionado não existe mais, resetar seleção
        if (selectedServer && !defaultServers.some(s => s.name === selectedServer)) {
          setSelectedServer(null);
        }
        const totalBytes = await invoke<number>("get_total_memory");
        const totalGb = Math.round(totalBytes / (1024 * 1024 * 1024));
        onSetTotalSystemRamGb(totalGb);
      } catch (err) {
        console.error("Erro ao carregar dados iniciais:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recarregar servidores se a pasta mudar
  useEffect(() => {
    if (!serverDir) return;
    (async () => {
      try {
        const servers = await listLocalServers();
        onSetLocalServers(servers);
      } catch (err) {
        console.error("Erro ao atualizar servidores:", err);
      }
    })();
  }, [serverDir]);

  // Ler porta real do server.properties
  useEffect(() => {
    if (!selectedServer) return;
    const serverInfo = localServers.find(s => s.name === selectedServer);
    if (!serverInfo) return;
    (async () => {
      try {
        const props = await invoke<Record<string, any>>('read_server_properties', { serverDir: serverInfo.path });
        onSetServerConfigPort(Number(props['server-port'] ?? 25565));
      } catch {
        onSetServerConfigPort(25565);
      }
    })();
  }, [selectedServer, localServers]);

  // --- Handlers ---

  const handleStartNetwork = async () => {
    if (netStatus === "online") {
      try {
        onSetLogs(prev => [...prev, "[INFO] Parando rede mesh... O servidor Minecraft continua rodando."]);
        await invoke("stop_network_node");
        onSetIsStarting(false);
        onSetNetStatus("offline");
        onSetNetIp(null);
        pendingMcStartRef.current = false;
      } catch (err) {
        console.error(err);
        pushDiagnostic({ level: "error", source: "Rede", title: "Erro ao parar a rede mesh", message: String(err) });
      }
      return;
    }

    if (isStarting || netStatus === "connecting") {
      try {
        onSetLogs(prev => [...prev, "[INFO] Cancelando conexão..."]);
        await invoke("stop_network_node");
        onSetIsStarting(false);
        onSetNetStatus("offline");
        onSetNetIp(null);
        pendingMcStartRef.current = false;
      } catch (err) {
        console.error(err);
      }
      return;
    }

    try {
      onSetIsStarting(true);
      onSetLogs([]);

      onSetLogs(prev => [...prev, "[INFO] Verificando instalação do Java Runtime (JRE 17)..."]);
      const installed = await isJREInstalled(17);
      if (!installed) {
        onSetLogs(prev => [...prev, "[INFO] Java não encontrado. Iniciando instalação..."]);
        await installJRE(17, (p) => onSetDownloadProgress(p));
      }
      onSetDownloadProgress(null);
      onSetLogs(prev => [...prev, "[INFO] Java 17 está pronto!"]);

      onSetLogs(prev => [...prev, "[INFO] Autenticando sessão de rede no Cubicase..."]);
      onSetNetStatus("connecting");
      await invoke("start_network_node", { mode: "host", targetIp: null, localPort: minecraftPort });

      if (selectedServer && serverStatus !== "online" && serverStatus !== "starting") {
        pendingMcStartRef.current = true;
        onSetLogs(prev => [...prev, "[INFO] Rede mesh iniciada. Aguardando conexão para iniciar servidor Minecraft automaticamente..."]);
      } else if (selectedServer && (serverStatus === "online" || serverStatus === "starting")) {
        onSetLogs(prev => [...prev, "[INFO] Rede mesh iniciada. Servidor Minecraft já está rodando, continuando normalmente."]);
      } else {
        onSetLogs(prev => [...prev, "[INFO] Rede mesh ativa. Selecione um servidor e clique em 'Iniciar Servidor' para começar."]);
      }
    } catch (error) {
      console.error(error);
      onSetIsStarting(false);
      onSetNetStatus("offline");
      onSetDownloadProgress(null);
      pendingMcStartRef.current = false;
      onSetLogs(prev => [...prev, `[ERR] Falha ao iniciar host: ${error}`]);
      pushDiagnostic({ level: "error", source: "Rede", title: "Falha ao iniciar a rede mesh", message: String(error) });
    }
  };

  const handleStartMCServer = async () => {
    const currentSelectedServer = selectedServerRef.current || selectedServer;
    const currentLocalServers = localServersRef.current.length > 0 ? localServersRef.current : localServers;

    if (!currentSelectedServer) {
      pushDiagnostic({ level: "warning", source: "Servidor", title: "Nenhum servidor selecionado", message: "Selecione um servidor primeiro." });
      return;
    }

    const serverInfo = currentLocalServers.find(s => s.name === currentSelectedServer);
    if (!serverInfo) {
      pushDiagnostic({ level: "warning", source: "Servidor", title: "Servidor não encontrado", message: "O servidor selecionado não foi encontrado na lista local." });
      return;
    }

    try {
      setServerStatus("starting");
      setRunningServer(currentSelectedServer);
      onSetMcLogs([]);
      onSetMcLogs(prev => [...prev, `[Cubicase] Inicializando preparação do servidor "${selectedServer}"...`]);

      const version = serverInfo.version || "1.20.1";
      const javaVer = getJavaVersion(version);

      onSetMcLogs(prev => [...prev, `[Cubicase] Verificando compatibilidade com Java JRE ${javaVer}...`]);
      const installed = await isJREInstalled(javaVer);
      if (!installed) {
        onSetMcLogs(prev => [...prev, `[Cubicase] JRE ${javaVer} não encontrado na máquina. Baixando de Adoptium...`]);
        await installJRE(javaVer, (p) => {
          onSetServerInstallProgress({ status: `Instalando JRE ${javaVer}: ${p.status}`, percent: p.percent });
        });
      }
      onSetServerInstallProgress(null);
      onSetMcLogs(prev => [...prev, `[Cubicase] JRE ${javaVer} pronto!`]);

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

      // serverJarName opcional: null = server.jar (Vanilla), ou "forge-1.20.1-47.1.0-shim.jar" (Forge antigo)
      // launchArgsDir opcional: pasta com win_args.txt/unix_args.txt (Forge/NeoForge modernos, sem JAR único)
      const serverJarName = serverInfo.serverJar || null;
      const launchArgsDir = serverInfo.launchArgsDir || null;
      onSetMcLogs(prev => [...prev, `[Cubicase] Iniciando Java runtime com ${ram}GB de RAM...`]);
      await invoke("start_minecraft_server", {
        serverDir: serverInfo.path,
        javaPath: javaPath,
        ramGb: ram,
        localPort: minecraftPort,
        serverJarName: serverJarName,
        launchArgsDir: launchArgsDir,
      });
    } catch (err) {
      console.error(err);
      setServerStatus("offline");
      onSetMcLogs(prev => [...prev, `[Cubicase ERR] Falha ao iniciar: ${err}`]);
      pushDiagnostic({ level: "error", source: "Servidor", title: "Falha ao iniciar o servidor Minecraft", message: String(err) });
    }
  };

  const handleStopMCServer = async () => {
    try {
      setServerStatus("stopping");
      onSetMcLogs(prev => [...prev, `[Cubicase] Enviando comando "/stop" para o console do Minecraft...`]);
      await invoke("stop_minecraft_server");
    } catch (err) {
      console.error(err);
      onSetMcLogs(prev => [...prev, `[Cubicase ERR] Erro ao enviar comando de parada: ${err}`]);
      pushDiagnostic({ level: "error", source: "Servidor", title: "Falha ao encerrar o servidor", message: String(err) });
    }
  };

  const handleSendMCCommand = async (command: string) => {
    try {
      onSetMcLogs(prev => [...prev, `> ${command}`]);
      await invoke("send_minecraft_command", { command });
    } catch (err) {
      console.error(err);
      onSetMcLogs(prev => [...prev, `[Cubicase ERR] Falha ao enviar comando: ${err}`]);
    }
  };

  const handleSelectDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: serverDir || undefined,
    });
    if (selected) setServerDir(selected as string);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    onSetCopied(true);
    setTimeout(() => onSetCopied(false), 2000);
  };

  const handleCreateServer = async (name: string, version: string, ram: number, serverType?: "vanilla" | "forge" | "neoforge" | "fabric" | "paper", extraVersion?: string) => {
    if (localServers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      pushDiagnostic({ level: "warning", source: "Instalação", title: "Nome já em uso", message: `Já existe um servidor com o nome "${name}". Escolha outro nome.` });
      return;
    }
    try {
      if ((serverType === "forge" || serverType === "neoforge") && extraVersion) {
        onSetServerInstallProgress({ status: "Iniciando instalação do Forge...", percent: 5 });
        await installForgeServer(name, version, extraVersion, serverType, ram, (p: ServerInstallProgress) => onSetServerInstallProgress(p));
      } else if (serverType === "fabric" && extraVersion) {
        onSetServerInstallProgress({ status: "Iniciando instalação do Fabric...", percent: 5 });
        await installFabricServer(name, version, extraVersion, ram, (p: ServerInstallProgress) => onSetServerInstallProgress(p));
      } else if (serverType === "paper" && extraVersion) {
        onSetServerInstallProgress({ status: "Iniciando instalação do Paper...", percent: 5 });
        await installPaperServer(name, version, Number(extraVersion), ram, (p: ServerInstallProgress) => onSetServerInstallProgress(p));
      } else {
        onSetServerInstallProgress({ status: "Iniciando download da Mojang...", percent: 5 });
        await installMinecraftServer(name, version, ram, (p) => onSetServerInstallProgress(p));
      }
      const servers = await listLocalServers();
      onSetLocalServers(servers);
      setSelectedServer(name);
      onSetShowCreateServer(false);
      onSetServerInstallProgress(null);
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: "Instalação", title: "Erro ao criar servidor", message: String(err) });
      onSetServerInstallProgress(null);
    }
  };

  const handleImportModpack = async (name: string, parsed: ParsedModpack, ram: number) => {
    if (localServers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      pushDiagnostic({ level: "warning", source: "Instalação", title: "Nome já em uso", message: `Já existe um servidor com o nome "${name}". Escolha outro nome.` });
      return;
    }
    try {
      onSetServerInstallProgress({ status: "Iniciando import do modpack...", percent: 2 });
      await installModpack(name, parsed, ram, (p) => onSetServerInstallProgress(p));
      const servers = await listLocalServers();
      onSetLocalServers(servers);
      setSelectedServer(name);
      setShowImportModpack(false);
      onSetServerInstallProgress(null);
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: "Instalação", title: "Erro ao importar modpack", message: String(err) });
      onSetServerInstallProgress(null);
    }
  };

  const handleDeleteServer = async (serverName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (serverStatus !== "offline" && serverStatus !== "crashed" && selectedServer === serverName) {
      pushDiagnostic({ level: "warning", source: "Servidor", title: "Servidor em execução", message: "Não é possível deletar o servidor enquanto ele está em execução." });
      return;
    }
    onSetDeleteConfirmServer(serverName);
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirmServer) return;
    try {
      onSetIsDeletingServer(deleteConfirmServer);
      const serverInfo = localServers.find(s => s.name === deleteConfirmServer);
      if (!serverInfo) throw new Error("Servidor não encontrado");

      // Verificar se é um servidor importado (fora da pasta padrão)
      const docsDir = await documentDir();
      const defaultPath = `${docsDir}\\CubicaseServers\\${deleteConfirmServer}`;
      const isImported = serverInfo.path.toLowerCase() !== defaultPath.toLowerCase();

      if (isImported) {
        // Servidor importado: remover da lista de importados (não deleta arquivos)
        onSetLogs(prev => [...prev, `[INFO] Removendo servidor importado "${deleteConfirmServer}" da lista.`]);
        removeImportedServerPath(serverInfo.path);
      } else {
        // Servidor padrão: deletar a pasta permanentemente
        await remove(serverInfo.path, { recursive: true });
        onSetLogs(prev => [...prev, `[INFO] Servidor "${deleteConfirmServer}" deletado permanentemente.`]);
      }

      // Remover também da API Central: sem isso o servidor deletado localmente
      // continuava aparecendo como existente (e potencialmente "online") para os convidados.
      if (serverInfo.shortCode) {
        try {
          await invoke("sync_delete_server", { shortCode: serverInfo.shortCode });
          onSetLogs(prev => [...prev, `[INFO] Servidor removido da API Central.`]);
        } catch (err) {
          console.warn("Falha ao remover servidor da API Central:", err);
          onSetLogs(prev => [...prev, `[WARN] Não foi possível remover o servidor da API Central agora (ficará na fila de sincronização).`]);
        }
      }

      if (selectedServer === deleteConfirmServer) setSelectedServer(null);
      const servers = await listLocalServers();
      onSetLocalServers(servers);
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: "Servidor", title: "Erro ao deletar servidor", message: String(err) });
    } finally {
      onSetIsDeletingServer(null);
      onSetDeleteConfirmServer(null);
    }
  };

  const handleImportServer = async () => {
    try {
      setIsImporting(true);
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Selecione a pasta do servidor Minecraft",
      });
      if (!selected) { setIsImporting(false); return; }

      const folderPath = selected as string;

      // Verificar se já não está na lista (pela path)
      const alreadyExists = localServers.some(s => s.path.toLowerCase() === folderPath.toLowerCase());
      if (alreadyExists) {
        pushDiagnostic({ level: "warning", source: "Instalação", title: "Servidor já importado", message: "Este servidor já está na sua lista." });
        setIsImporting(false);
        return;
      }

      onSetLogs(prev => [...prev, `[INFO] Importando servidor de: ${folderPath}`]);
      const imported = await importExistingServer(folderPath);
      addImportedServerPath(folderPath);

      // Merge com servidores locais e reordenar
      const allServers = [...localServers, imported];
      onSetLocalServers(allServers);
      setSelectedServer(imported.name);
      onSetLogs(prev => [...prev, `[INFO] Servidor "${imported.name}" (${imported.version || "versão desconhecida"}) importado com sucesso!`]);
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: "Instalação", title: "Erro ao importar servidor", message: String(err) });
    } finally {
      setIsImporting(false);
    }
  };

  const handleSaveSettings = (port: number, newAutoBackupEnabled: boolean, newBackupRetentionCount: number) => {
    setMinecraftPort(port);
    setAutoBackupEnabled(newAutoBackupEnabled);
    setBackupRetentionCount(newBackupRetentionCount);
    onSetShowSettings(false);
  };

  // --- Render ---

  const serverInfo = selectedServer ? localServers.find(s => s.name === selectedServer) : null;
  const displayShortCode = serverInfo?.shortCode || serverShortCodeRef.current || shortCode;

  const serverTypeLabels: Record<string, string> = {
    vanilla: "Vanilla",
    forge: "Forge",
    neoforge: "NeoForge",
    fabric: "Fabric",
    paper: "Paper",
  };
  const serverTypeLabel = serverTypeLabels[serverInfo?.serverType ?? "vanilla"] ?? "Vanilla";

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Painel Principal (2 colunas) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Minecraft Server Control Card */}
          <div className="bg-theme-card p-8 rounded-[2rem] border-theme-card shadow-theme-card space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex-1 min-w-0">
                <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full">
                  Minecraft Server {serverTypeLabel}
                </span>
                <div className="flex items-center gap-2 mt-2">
                  <h2 className="text-3xl font-bold text-theme-primary truncate">
                    {selectedServer ? selectedServer : "Nenhum Servidor Selecionado"}
                  </h2>
                  {selectedServer && (
                    <button
                      type="button"
                      onClick={() => {
                        const sv = localServers.find(s => s.name === selectedServer);
                        if (sv) { onSetConfigServerDir(sv.path); onSetShowConfigModal(true); }
                      }}
                      className="p-1.5 hover:bg-theme-muted rounded-lg transition-all duration-300 text-theme-secondary hover:text-indigo-600 hover:rotate-45 flex-shrink-0 cursor-pointer"
                      title="Configurações do Servidor"
                    >
                      <Settings className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <p className="text-theme-secondary mt-1">
                  {selectedServer
                    ? `Versão: ${serverInfo?.version || "Não encontrada"}${serverInfo?.forgeVersion ? ` • ${serverTypeLabel}: ${serverInfo.forgeVersion}` : ""}`
                    : "Selecione ou crie um servidor na barra lateral para começar."}
                </p>

                {/* Código de convite permanente */}
                {selectedServer && displayShortCode && (
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-theme-accent border border-theme-accent rounded-xl">
                      <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">Código</span>
                      <span className="font-mono font-bold text-indigo-700 dark:text-indigo-300 text-sm tracking-wider">
                        CF-{displayShortCode}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(`CF-${displayShortCode}`)}
                      className="p-1.5 bg-indigo-100 dark:bg-indigo-800/40 text-indigo-600 dark:text-indigo-300 rounded-lg hover:bg-indigo-200 dark:hover:bg-indigo-700/50 transition-all active:scale-95 cursor-pointer"
                      title="Copiar Código do Servidor"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>

              {selectedServer && (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-theme-muted border border-theme-card rounded-xl text-xs font-bold text-theme-secondary">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      serverStatus === "online" ? "bg-emerald-500 animate-pulse" :
                      serverStatus === "starting" ? "bg-amber-500 animate-bounce" :
                      serverStatus === "stopping" ? "bg-orange-500 animate-pulse" :
                      serverStatus === "crashed" ? "bg-rose-500" : "bg-slate-400"
                    )} />
                    <span className="uppercase tracking-wider">
                      {serverStatus === "online" ? "Online" :
                       serverStatus === "starting" ? "Iniciando" :
                       serverStatus === "stopping" ? "Parando" :
                       serverStatus === "crashed" ? "Crash" : "Offline"}
                    </span>
                  </div>

                  {/* Indicador leve de saúde: RAM/CPU real da máquina, atualizado a
                      cada ~15s (ver src-tauri thread de amostragem + mc-resource-sample).
                      Sem histórico/gráfico — só o valor mais recente, pra dar uma noção
                      contínua sem virar um dashboard. */}
                  {serverStatus === "online" && resourceSample?.totalRamMb && resourceSample.availableRamMb !== undefined && (
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 bg-theme-muted border border-theme-card rounded-xl text-xs font-bold text-theme-secondary"
                      title="Uso de RAM/CPU do computador (não só do servidor)"
                    >
                      <Activity className="w-3.5 h-3.5" />
                      <span>
                        RAM {Math.round(((resourceSample.totalRamMb - resourceSample.availableRamMb) / resourceSample.totalRamMb) * 100)}%
                        {" · "}
                        CPU {Math.round(resourceSample.cpuUsagePercent ?? 0)}%
                      </span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={serverStatus === "online" ? handleStopMCServer : handleStartMCServer}
                    disabled={serverStatus === "starting" || serverStatus === "stopping"}
                    className={cn(
                      "h-12 px-6 rounded-xl font-bold flex items-center gap-2 transition-all active:scale-95 shadow-md disabled:opacity-50 cursor-pointer",
                      serverStatus === "online"
                        ? "bg-rose-500 hover:bg-rose-600 text-white shadow-theme-shadow"
                        : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-theme-shadow"
                    )}
                  >
                    {serverStatus === "starting" ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Iniciando...</>
                    ) : serverStatus === "stopping" ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Parando...</>
                    ) : serverStatus === "online" ? (
                      <><X className="w-4 h-4" /> Parar Servidor</>
                    ) : (
                      <><Play className="w-4 h-4 fill-current" /> Iniciar Servidor</>
                    )}
                  </button>
                </div>
              )}
            </div>

            {serverStatus === "crashed" && (
              <div className="p-4 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-2xl text-sm">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    {lastCrashInfo ? (
                      <>
                        <span className="font-bold">{lastCrashInfo.title}.</span> {lastCrashInfo.message}
                      </>
                    ) : (
                      <>
                        <span className="font-bold">O servidor fechou de forma inesperada.</span> Verifique os logs do console para identificar erros nos arquivos ou configurações do Minecraft.
                      </>
                    )}

                    {lastCrashInfo?.detail && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => setShowCrashDetail((v) => !v)}
                          className="flex items-center gap-1 text-xs font-bold text-rose-700 dark:text-rose-300 hover:underline cursor-pointer"
                        >
                          <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showCrashDetail && "rotate-180")} />
                          {showCrashDetail ? "Ocultar detalhes técnicos" : "Ver detalhes técnicos"}
                        </button>
                        {showCrashDetail && (
                          <pre className="mt-2 p-3 bg-black/10 dark:bg-black/30 rounded-xl text-[10px] font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto custom-scrollbar">
                            {lastCrashInfo.detail}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Alerta: servidor MC rodando sem rede mesh */}
            {(serverStatus === "online" || serverStatus === "starting") && netStatus === "offline" && (
              <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl flex items-center justify-between gap-4 text-sm">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">Rede mesh desativada.</span> O servidor Minecraft está rodando localmente, mas seus amigos não conseguem se conectar sem a rede mesh ativa.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleStartNetwork}
                  disabled={isStarting}
                  className="flex-shrink-0 h-10 px-5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all text-xs font-bold flex items-center gap-2 disabled:opacity-50 cursor-pointer shadow-md shadow-theme-shadow"
                >
                  {isStarting ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Iniciando...</>
                  ) : (
                    <><Play className="w-3.5 h-3.5 fill-current" /> Iniciar Rede Mesh</>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Rede do Servidor (Mesh VPN) */}
          <div className="bg-theme-card p-8 rounded-[2rem] border-theme-card shadow-theme-card space-y-8">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div>
                <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full">
                  Rede Mesh VPN
                </span>
                <h2 className="text-3xl font-bold text-theme-primary mt-2">Rede do Servidor</h2>
                <p className="text-theme-secondary mt-1">Conexão segura ponto-a-ponto via VPN virtual</p>
              </div>
              <button
                type="button"
                onClick={handleStartNetwork}
                disabled={isStarting && downloadProgress !== null}
                className={cn(
                  "h-14 px-8 rounded-2xl font-bold flex items-center gap-3 transition-all active:scale-95 shadow-lg disabled:opacity-50 cursor-pointer",
                  netStatus !== "offline" || isStarting
                    ? "bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-300 shadow-theme-shadow hover:bg-rose-100 dark:hover:bg-rose-900/30"
                    : "bg-indigo-600 text-white shadow-theme-shadow hover:bg-indigo-700"
                )}
              >
                {isStarting || netStatus === "connecting" ? (
                  downloadProgress ? (
                    <><Activity className="w-5 h-5 animate-spin" /> Instalando JRE {downloadProgress.percent}%</>
                  ) : (
                    <><Loader2 className="w-5 h-5 animate-spin" /> Iniciando...</>
                  )
                ) : netStatus === "online" ? (
                  <><Activity className="w-5 h-5 animate-pulse" /> Parar Rede Mesh</>
                ) : (
                  <><Play className="w-5 h-5 fill-current" /> Iniciar Rede Mesh</>
                )}
              </button>
            </div>

            {downloadProgress && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-bold text-indigo-600 uppercase tracking-wider">
                  <span>{downloadProgress.status}</span>
                  <span>{downloadProgress.percent}%</span>
                </div>
                <div className="w-full h-2 bg-indigo-50 dark:bg-indigo-900/30 rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${downloadProgress.percent}%` }}
                    className="h-full bg-indigo-600"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
                <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">Redirecionamento</p>
                <p className="text-sm font-bold text-theme-primary mt-1">127.0.0.1:{minecraftPort}</p>
              </div>
              <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
                <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">Endereço Mesh</p>
                <p className="text-sm font-bold text-theme-primary mt-1">{netIp || "Inativo"}</p>
              </div>
              <div className="bg-theme-muted p-4 rounded-2xl border border-theme-card">
                <p className="text-[10px] font-bold text-theme-secondary uppercase tracking-wider">Interface</p>
                <p className="text-sm font-bold text-emerald-600 mt-1">{netStatus === "online" ? "Ativa" : "Desconectada"}</p>
              </div>
            </div>

            {netStatus === "online" && netIp && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-6 bg-theme-accent border border-theme-accent rounded-2xl flex flex-col md:flex-row items-center justify-between gap-4"
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-xl flex items-center justify-center shadow-theme-shadow">
                    <ShieldCheck className="text-indigo-600 w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-indigo-900 dark:text-indigo-200">Rede Mesh Ativa</p>
                    <p className="text-xs text-indigo-600 dark:text-indigo-400">Compartilhe o código abaixo com seus amigos.</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="bg-white dark:bg-slate-800 px-4 py-2 rounded-xl font-mono font-bold text-indigo-600 dark:text-indigo-300 text-sm shadow-theme-shadow border border-theme-accent">
                    CF-{displayShortCode}
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(`CF-${displayShortCode}`)}
                    className="p-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all shadow-theme-shadow active:scale-95 cursor-pointer"
                    title="Copiar Código"
                  >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </motion.div>
            )}
          </div>

          {/* Gerenciamento de Mods e Mundo */}
          {selectedServer && serverInfo && (
            <ServerManagePanel
              key={serverInfo.path}
              serverDir={serverInfo.path}
              serverType={serverInfo.serverType}
              serverStatus={serverStatus}
              mcVersion={serverInfo.version}
            />
          )}

          {/* Whitelist, operadores e banimentos */}
          {selectedServer && serverInfo && (
            <PlayersPanel
              key={serverInfo.path}
              serverDir={serverInfo.path}
              serverStatus={serverStatus}
              onSendCommand={handleSendMCCommand}
            />
          )}

          {/* Console */}
          <ConsolePanel
            mcLogs={mcLogs}
            networkLogs={logs}
            serverStatus={serverStatus}
            onSendCommand={handleSendMCCommand}
            onClearLogs={(tab) => {
              if (tab === "minecraft") onSetMcLogs([]);
              else onSetLogs([]);
            }}
          />
        </div>

        {/* Sidebar (1 coluna) */}
        <div className="space-y-6">
          <ServerList
            servers={localServers}
            selectedServer={selectedServer}
            serverStatus={serverStatus}
            onSelect={setSelectedServer}
            onCreate={() => onSetShowCreateServer(true)}
            onImport={handleImportServer}
            onImportModpack={() => setShowImportModpack(true)}
            onDelete={handleDeleteServer}
            onConfig={(path) => { onSetConfigServerDir(path); onSetShowConfigModal(true); }}
            isDeleting={isDeletingServer}
            isImporting={isImporting}
          />

          {/* Parâmetros Globais */}
          <div className="bg-theme-card p-6 rounded-[2rem] border-theme-card shadow-theme-card">
            <h3 className="font-bold text-theme-primary mb-4 flex items-center gap-2">
              <Database className="w-4 h-4 text-slate-400" /> Parâmetros locais
            </h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-theme-secondary">Diretório do Servidor</span>
                <button
                  type="button"
                  onClick={handleSelectDir}
                  className="p-2 bg-theme-muted hover:bg-theme-card rounded-lg border border-theme-card transition-colors cursor-pointer"
                  title="Escolher diretório"
                >
                  <FolderOpen className="w-4 h-4 text-indigo-600" />
                </button>
              </div>
              <p className="text-[10px] text-theme-secondary font-mono truncate bg-theme-muted p-2 rounded-lg border border-theme-card" title={serverDir || ""}>
                {serverDir || "Carregando..."}
              </p>

              <div className="flex justify-between items-end mt-4">
                <span className="text-sm text-theme-secondary">Porta Interna (Minecraft)</span>
                <span className="text-sm font-bold font-mono text-theme-primary">{serverConfigPort}</span>
              </div>

              <div className="flex justify-between items-end mt-4">
                <span className="text-sm text-theme-secondary">Java Runtime</span>
                <span className="text-sm font-bold text-indigo-600">
                  {selectedServer
                    ? `JRE ${getJavaVersion(serverInfo?.version || "1.20.1")}`
                    : "JRE 17 / 21"}
                </span>
              </div>
            </div>
          </div>

          {/* Suporte */}
          <div className="bg-indigo-600 p-6 rounded-[2rem] text-white shadow-theme-xl">
            <h3 className="font-bold text-white mb-2">Suporte ao Cubicase</h3>
            <p className="text-indigo-100 text-sm leading-relaxed mb-4">
              O Cubicase Dash economiza taxas mensais de hosts cloud tradicionais. Apoie o projeto!
            </p>
            <button
              type="button"
              disabled={isOpeningDonation}
              onClick={async () => {
                setIsOpeningDonation(true);
                try {
                  await openDonationCheckout();
                } catch (err) {
                  pushDiagnostic({ level: "error", source: "Doação", title: "Não foi possível abrir a página de doação", message: String(err) });
                } finally {
                  setIsOpeningDonation(false);
                }
              }}
              className="w-full py-3 bg-white text-indigo-600 rounded-2xl font-bold text-sm hover:bg-indigo-50 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isOpeningDonation ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Pagar uma Coquinha 🥤
            </button>
          </div>
        </div>
      </div>

      {/* Modais */}
      <CreateServerModal
        isOpen={showCreateServer}
        onClose={() => onSetShowCreateServer(false)}
        onCreate={handleCreateServer}
        installProgress={serverInstallProgress}
        totalRamGb={totalSystemRamGb}
      />

      <ImportModpackModal
        isOpen={showImportModpack}
        onClose={() => setShowImportModpack(false)}
        onImport={handleImportModpack}
        installProgress={serverInstallProgress}
        totalRamGb={totalSystemRamGb}
      />

      <DeleteConfirmModal
        serverName={deleteConfirmServer}
        onClose={() => onSetDeleteConfirmServer(null)}
        onConfirm={handleConfirmDelete}
        isImported={deleteConfirmServer ? localServers.some(s => {
          if (s.name !== deleteConfirmServer) return false;
          // Comparar: servidores dentro da pasta padrão não são importados
          const defaultPath = `${serverDir || ''}\\${s.name}`;
          return s.path.toLowerCase() !== defaultPath.toLowerCase();
        }) : false}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => onSetShowSettings(false)}
        currentPort={minecraftPort || 25565}
        currentAutoBackupEnabled={autoBackupEnabled}
        currentBackupRetentionCount={backupRetentionCount}
        onSave={handleSaveSettings}
      />

      <AnimatePresence>
        {showConfigModal && configServerDir && (
          <ServerConfigModal
            serverDir={configServerDir}
            isOpen={showConfigModal}
            onClose={() => {
              onSetShowConfigModal(false);
              onSetConfigServerDir(null);
            }}
            onSaved={async () => {
              const servers = await listLocalServers();
              onSetLocalServers(servers);
            }}
            serverStatus={serverStatus}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// Import necessário para AnimatePresence
import { AnimatePresence } from "framer-motion";
