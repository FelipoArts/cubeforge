"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Server, 
  Users, 
  Database, 
  Activity, 
  Settings, 
  Play, 
  Copy, 
  Check,
  ChevronRight,
  ShieldCheck,
  Zap,
  FolderOpen,
  X,
  Terminal,
  Plus,
  Trash2,
  AlertTriangle,
  Send,
  Loader2
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { ServerConfigModal } from "./ServerConfigModal";
import SettingsButton from "./components/SettingsButton";
import { twMerge } from "tailwind-merge";
import { open } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type ServerStatus } from "./store";
import { installJRE, isJREInstalled, getJREPath, type DownloadProgress } from "@/lib/jre";
import { readTextFile, remove } from "@tauri-apps/plugin-fs";
import { 
  listLocalServers, 
  installMinecraftServer, 
  SUPPORTED_VERSIONS, 
  getJavaVersion, 
  type MinecraftVersion, 
  type ServerInfo, 
  type ServerInstallProgress 
} from "@/lib/server";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Codifica um IP virtual (ex: 100.84.21.10) para um código alfanumérico curto de convite (ex: CF-6454150A)
function ipToCode(ip: string): string {
  const parts = ip.split(".");
  if (parts.length !== 4) return "CUBE-ERR";
  const hex = parts.map(p => {
    const h = parseInt(p, 10).toString(16).toUpperCase();
    return h.length === 1 ? "0" + h : h;
  }).join("");
  return `CF-${hex}`;
}

// Decodifica o código de convite (ex: CF-6454150A) de volta para o IP correspondente (ex: 100.84.21.10)
function codeToIp(code: string): string | null {
  const clean = code.trim().toUpperCase();
  if (!clean.startsWith("CF-")) return null;
  const hex = clean.substring(3);
  if (hex.length !== 8) return null;
  const parts = [];
  for (let i = 0; i < 8; i += 2) {
    parts.push(parseInt(hex.substring(i, i + 2), 16));
  }
  if (parts.some(isNaN)) return null;
  return parts.join(".");
}

export default function Home() {
  const [role, setRole] = useState<"host" | "guest" | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);

  // Ref para controlar auto-início do servidor MC após mesh ficar online
  const pendingMcStartRef = useRef(false);

  // Estados de Rede e Configurações
  const [netStatus, setNetStatus] = useState<"offline" | "connecting" | "online">("offline");
  const [netIp, setNetIp] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  
  // Estados locais para formulários de Convidado
  const [inviteCodeInput, setInviteCodeInput] = useState("");

  const logsEndRef = useRef<HTMLDivElement>(null);
  const mcLogsEndRef = useRef<HTMLDivElement>(null);

  // Controle de Abas nos Logs (Minecraft vs VPN)
  const [activeTab, setActiveTab] = useState<"minecraft" | "network">("minecraft");

  const { 
    serverDir, 
    setServerDir, 
    minecraftPort,
    setMinecraftPort,
    selectedServer,
    setSelectedServer,
    serverStatus,
    setServerStatus
  } = useAppStore();

  // Estados do Servidor Minecraft
  const [localServers, setLocalServers] = useState<ServerInfo[]>([]);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [createServerName, setCreateServerName] = useState("");
  const [createServerVersion, setCreateServerVersion] = useState<MinecraftVersion>("1.20.1");
  const [createServerRam, setCreateServerRam] = useState(4);
  const [totalSystemRamGb, setTotalSystemRamGb] = useState(8);
  const [serverInstallProgress, setServerInstallProgress] = useState<ServerInstallProgress | null>(null);
  const [isDeletingServer, setIsDeletingServer] = useState<string | null>(null);
  
  // Console e Logs do Minecraft
  const [mcLogs, setMcLogs] = useState<string[]>([]);
  const [mcCommand, setMcCommand] = useState("");

  // Estados temporários do modal de configurações
  const [settingsPort, setSettingsPort] = useState(25565);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configServerDir, setConfigServerDir] = useState<string | null>(null);

  // Estado para o modal de confirmação de exclusão
  const [deleteConfirmServer, setDeleteConfirmServer] = useState<string | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');

  // Porta real do servidor lida do server.properties (para exibição)
  const [serverConfigPort, setServerConfigPort] = useState(25565);

  // Efeito para sincronizar configurações da store ao abrir o modal
  useEffect(() => {
    if (showSettings) {
      setSettingsPort(minecraftPort || 25565);
    }
  }, [showSettings, minecraftPort]);

  // Efeito para escutar eventos globais emitidos pelo Rust
  useEffect(() => {
    let unlistenStatus: (() => void) | null = null;
    let unlistenLogs: (() => void) | null = null;
    let unlistenMcStatus: (() => void) | null = null;
    let unlistenMcLogs: (() => void) | null = null;

    async function setupListeners() {
      unlistenStatus = await listen<{ status: string; ip: string | null }>("network-status", (event) => {
        console.log("network-status event:", event.payload);
        if (event.payload.status === "online") {
          setNetStatus("online");
          setNetIp(event.payload.ip);
          setIsStarting(false);
          
          // Auto-iniciar servidor Minecraft se houver um pendente
          if (pendingMcStartRef.current && selectedServer) {
            pendingMcStartRef.current = false;
            // Pequeno delay para garantir que o listener de rede estabilizou
            setTimeout(() => handleStartMCServer(), 500);
          }
        } else {
          setNetStatus("offline");
          setNetIp(null);
          setIsStarting(false);
          pendingMcStartRef.current = false;
        }
      });

      unlistenLogs = await listen<{ message: string; is_error: boolean }>("network-log", (event) => {
        setLogs(prev => {
          const newLogs = [...prev, `[${event.payload.is_error ? 'ERR' : 'INFO'}] ${event.payload.message}`];
          // Limita histórico em 150 linhas
          return newLogs.slice(-150);
        });
      });

      unlistenMcStatus = await listen<string>("minecraft-status-changed", (event) => {
        console.log("minecraft-status-changed event:", event.payload);
        const status = event.payload as ServerStatus;
        setServerStatus(status);
        
        let statusMsg = "";
        switch (status) {
          case "online":
            statusMsg = "[CubeForge] Servidor de Minecraft está ONLINE!";
            break;
          case "offline":
            statusMsg = "[CubeForge] Servidor de Minecraft está OFFLINE.";
            break;
          case "starting":
            statusMsg = "[CubeForge] Servidor de Minecraft está INICIANDO...";
            break;
          case "stopping":
            statusMsg = "[CubeForge] Servidor de Minecraft está PARANDO...";
            break;
          case "crashed":
            statusMsg = "[CubeForge ERR] O servidor de Minecraft fechou de forma inesperada (CRASHED)!";
            break;
        }
        if (statusMsg) {
          setMcLogs(prev => [...prev, statusMsg]);
        }
      });

      unlistenMcLogs = await listen<string>("minecraft-log", (event) => {
        setMcLogs(prev => {
          const newLogs = [...prev, event.payload];
          return newLogs.slice(-500); // mantém até 500 linhas
        });
      });
    }

    setupListeners();

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenLogs) unlistenLogs();
      if (unlistenMcStatus) unlistenMcStatus();
      if (unlistenMcLogs) unlistenMcLogs();
    };
  }, [setServerStatus]);

  // Rolar logs do console automaticamente
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    mcLogsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mcLogs]);

  // Inicializar diretório padrão do servidor se não estiver definido
  useEffect(() => {
    async function initDefaults() {
      if (!serverDir) {
        const docs = await documentDir();
        setServerDir(`${docs}\\CubeForgeServers`);
      }
    }
    initDefaults();
  }, [serverDir, setServerDir]);

  // Carrega servidores e RAM total
  useEffect(() => {
    async function loadInitialData() {
      try {
        const servers = await listLocalServers();
        setLocalServers(servers);
        
        const totalBytes = await invoke<number>("get_total_memory");
        const totalGb = Math.round(totalBytes / (1024 * 1024 * 1024));
        setTotalSystemRamGb(totalGb);
        setCreateServerRam(Math.min(4, Math.max(2, Math.floor(totalGb / 2))));
      } catch (err) {
        console.error("Erro ao carregar dados iniciais:", err);
      }
    }
    loadInitialData();
  }, []);

  // Recarrega servidores se a pasta mudar
  useEffect(() => {
    async function updateServers() {
      if (serverDir) {
        try {
          const servers = await listLocalServers();
          setLocalServers(servers);
        } catch (err) {
          console.error("Erro ao atualizar servidores:", err);
        }
      }
    }
    updateServers();
  }, [serverDir]);

  // Lê a porta real do servidor do server.properties quando um servidor é selecionado
  useEffect(() => {
    if (!selectedServer) return;
    const serverInfo = localServers.find(s => s.name === selectedServer);
    if (!serverInfo) return;
    (async () => {
      try {
        const props = await invoke<Record<string, any>>('read_server_properties', { serverDir: serverInfo.path });
        setServerConfigPort(Number(props['server-port'] ?? 25565));
      } catch {
        setServerConfigPort(25565);
      }
    })();
  }, [selectedServer, localServers]);

  const handleStartServer = async () => {
    // Se o servidor/rede já estiver rodando ou iniciando, para a execução
    if (isStarting || netStatus !== "offline") {
      try {
        setLogs(prev => [...prev, "[INFO] Parando nó de rede e servidor..."]);
        await invoke("stop_network_node");
        setIsStarting(false);
        setNetStatus("offline");
        setNetIp(null);
        pendingMcStartRef.current = false;
      } catch (err) {
        console.error(err);
        alert("Erro ao parar rede: " + err);
      }
      return;
    }

    try {
      setIsStarting(true);
      setLogs([]); // Limpar logs anteriores
      setActiveTab("network"); // Mudar para aba de rede para mostrar logs de conexão
      
      // 1. Verificar/Instalar JRE
      setLogs(prev => [...prev, "[INFO] Verificando instalação do Java Runtime (JRE 17)..."]);
      const installed = await isJREInstalled(17);
      if (!installed) {
        setLogs(prev => [...prev, "[INFO] Java não encontrado. Iniciando instalação..."]);
        await installJRE(17, (p) => {
          setDownloadProgress(p);
        });
      }
      setDownloadProgress(null);
      setLogs(prev => [...prev, "[INFO] Java 17 está pronto!"]);

      // 2. Iniciar o nó de rede Mesh em Rust
      setLogs(prev => [...prev, "[INFO] Autenticando sessão de rede no CubeForge..."]);
      setNetStatus("connecting");
      
      await invoke("start_network_node", {
        mode: "host",
        targetIp: null,
        localPort: minecraftPort
      });

      // 3. Marcar para auto-iniciar servidor MC quando a mesh ficar online
      if (selectedServer) {
        pendingMcStartRef.current = true;
        setLogs(prev => [...prev, "[INFO] Rede mesh iniciada. Aguardando conexão para iniciar servidor Minecraft automaticamente..."]);
      } else {
        setLogs(prev => [...prev, "[INFO] Rede mesh ativa. Selecione um servidor e clique em 'Iniciar Servidor' para começar."]);
      }
      
    } catch (error) {
      console.error(error);
      setIsStarting(false);
      setNetStatus("offline");
      setDownloadProgress(null);
      pendingMcStartRef.current = false;
      setLogs(prev => [...prev, `[ERR] Falha ao iniciar host: ${error}`]);
      alert("Falha ao iniciar servidor: " + error);
    }
  };

  const handleConnectGuest = async () => {
    if (netStatus !== "offline") {
      try {
        setLogs(prev => [...prev, "[INFO] Desconectando da rede..."]);
        await invoke("stop_network_node");
        setNetStatus("offline");
        setNetIp(null);
      } catch (err) {
        console.error(err);
        alert("Erro ao desconectar: " + err);
      }
      return;
    }

    if (!inviteCodeInput.trim()) {
      alert("Por favor, insira o código de convite!");
      return;
    }

    const targetIp = codeToIp(inviteCodeInput);
    if (!targetIp) {
      alert("Código de convite inválido! O código deve estar no formato CF-XXXXXXXX.");
      return;
    }

    try {
      setLogs([]);
      setNetStatus("connecting");
      setLogs(prev => [...prev, "[INFO] Autenticando sessão de rede no CubeForge..."]);
      setLogs(prev => [...prev, `[INFO] Conectando ao host através do endereço virtual...`]);

      await invoke("start_network_node", {
        mode: "guest",
        targetIp: targetIp,
        localPort: minecraftPort
      });

    } catch (error) {
      console.error(error);
      setNetStatus("offline");
      setLogs(prev => [...prev, `[ERR] Falha ao conectar: ${error}`]);
      alert("Falha ao estabelecer conexão: " + error);
    }
  };

  const handleSelectDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: serverDir || undefined,
    });
    if (selected) {
      setServerDir(selected as string);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveSettings = () => {
    setMinecraftPort(settingsPort);
    setShowSettings(false);
  };

  // Função para deletar um servidor local
  const handleDeleteServer = async (serverName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (serverStatus !== "offline" && serverStatus !== "crashed" && selectedServer === serverName) {
      alert("Não é possível deletar o servidor enquanto ele está em execução.");
      return;
    }
    
    // Abre o modal de confirmação
    setDeleteConfirmServer(serverName);
    setDeleteConfirmInput('');
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirmServer) return;
    
    try {
      setIsDeletingServer(deleteConfirmServer);
      const docsDir = await documentDir();
      const serverPath = `${docsDir}\\CubeForgeServers\\${deleteConfirmServer}`;
      await remove(serverPath, { recursive: true });
      
      if (selectedServer === deleteConfirmServer) {
        setSelectedServer(null);
      }

      const servers = await listLocalServers();
      setLocalServers(servers);
    } catch (err) {
      console.error(err);
      alert("Erro ao deletar servidor: " + err);
    } finally {
      setIsDeletingServer(null);
      setDeleteConfirmServer(null);
      setDeleteConfirmInput('');
    }
  };

  const handleCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createServerName.trim()) {
      alert("Por favor, insira um nome para o servidor.");
      return;
    }
    const cleanName = createServerName.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    
    if (localServers.some(s => s.name.toLowerCase() === cleanName.toLowerCase())) {
      alert(`Já existe um servidor com o nome "${cleanName}". Escolha outro nome.`);
      return;
    }

    try {
      setServerInstallProgress({ status: "Iniciando download da Mojang...", percent: 5 });
      
      await installMinecraftServer(cleanName, createServerVersion, createServerRam, (p) => {
        setServerInstallProgress(p);
      });

      const servers = await listLocalServers();
      setLocalServers(servers);
      setSelectedServer(cleanName);
      
      setShowCreateServer(false);
      setCreateServerName("");
      setServerInstallProgress(null);
    } catch (err) {
      console.error(err);
      alert("Erro ao criar servidor: " + err);
      setServerInstallProgress(null);
    }
  };

  const handleStartMCServer = async () => {
    if (!selectedServer) {
      alert("Selecione um servidor primeiro.");
      return;
    }

    // Verificar se a rede mesh está ativa antes de iniciar o servidor
    if (netStatus !== "online") {
      alert("A rede mesh precisa estar ativa antes de iniciar o servidor Minecraft. Inicie a Rede Mesh primeiro.");
      return;
    }

    const serverInfo = localServers.find(s => s.name === selectedServer);
    if (!serverInfo) {
      alert("Servidor selecionado não encontrado.");
      return;
    }

    try {
      setServerStatus("starting");
      setActiveTab("minecraft");
      setMcLogs([]);
      setMcLogs(prev => [...prev, `[CubeForge] Inicializando preparação do servidor "${selectedServer}"...`]);

      const version = serverInfo.version || "1.20.1";
      const javaVer = getJavaVersion(version);
      
      setMcLogs(prev => [...prev, `[CubeForge] Verificando compatibilidade com Java JRE ${javaVer}...`]);
      const installed = await isJREInstalled(javaVer);
      if (!installed) {
        setMcLogs(prev => [...prev, `[CubeForge] JRE ${javaVer} não encontrado na máquina. Baixando de Adoptium...`]);
        await installJRE(javaVer, (p) => {
          setServerInstallProgress({ status: `Instalando JRE ${javaVer}: ${p.status}`, percent: p.percent });
        });
      }
      setServerInstallProgress(null);
      setMcLogs(prev => [...prev, `[CubeForge] JRE ${javaVer} pronto!`]);

      const jrePath = await getJREPath(javaVer);
      const javaPath = `${jrePath}\\bin\\java.exe`;

      let ram = 4;
      try {
        const metaPath = await join(serverInfo.path, 'cubeforge-meta.json');
        const metaContent = await readTextFile(metaPath);
        const meta = JSON.parse(metaContent) as { ramGb?: number };
        if (typeof meta.ramGb === 'number' && meta.ramGb >= 2) {
          ram = meta.ramGb;
        }
      } catch (e) {
        console.warn('Could not read RAM from meta file, using default 4GB:', e);
      }

      setMcLogs(prev => [...prev, `[CubeForge] Iniciando Java runtime com ${ram}GB de RAM...`]);

      await invoke("start_minecraft_server", {
        serverDir: serverInfo.path,
        javaPath: javaPath,
        ramGb: ram,
        localPort: minecraftPort
      });

    } catch (err) {
      console.error(err);
      setServerStatus("offline");
      setMcLogs(prev => [...prev, `[CubeForge ERR] Falha ao iniciar: ${err}`]);
      alert("Falha ao iniciar o Minecraft Server: " + err);
    }
  };

  const handleStopMCServer = async () => {
    try {
      setServerStatus("stopping");
      setMcLogs(prev => [...prev, `[CubeForge] Enviando comando "/stop" para o console do Minecraft...`]);
      await invoke("stop_minecraft_server");
    } catch (err) {
      console.error(err);
      setMcLogs(prev => [...prev, `[CubeForge ERR] Erro ao enviar comando de parada: ${err}`]);
      alert("Falha ao encerrar o servidor: " + err);
    }
  };

  const handleSendMCCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcCommand.trim() || serverStatus !== "online") return;

    try {
      setMcLogs(prev => [...prev, `> ${mcCommand.trim()}`]);
      await invoke("send_minecraft_command", { command: mcCommand.trim() });
      setMcCommand("");
    } catch (err) {
      console.error(err);
      setMcLogs(prev => [...prev, `[CubeForge ERR] Falha ao enviar comando: ${err}`]);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans selection:bg-indigo-100 relative overflow-x-hidden">
      {/* Header */}
      <header className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md border-b border-slate-200/60 px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-200">
            <Zap className="text-white w-6 h-6 fill-current animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              CubeForge <span className="text-indigo-600">Dash</span>
            </h1>
            <p className="text-[10px] uppercase tracking-widest font-bold text-slate-400">Mesh Core Edition v0.2.0</p>
          </div>
        </div>

        <nav className="flex items-center gap-2">
          <button
            onClick={() => {
              if (selectedServer) {
                const serverInfo = localServers.find(s => s.name === selectedServer);
                if (serverInfo) {
                  setConfigServerDir(serverInfo.path);
                  setShowConfigModal(true);
                  return;
                }
              }
              setShowSettings(true);
            }}
            className="p-2 hover:bg-slate-100 rounded-xl transition-all duration-300 text-slate-500 hover:text-indigo-600 hover:rotate-45"
            title={selectedServer ? "Configurações do Servidor" : "Configurações"}
          >
            <Settings className="w-5 h-5" />
          </button>
        </nav>
      </header>

      <main className="pt-32 pb-16 px-8 max-w-6xl mx-auto">
        <AnimatePresence mode="wait">
          {!role ? (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: "spring", stiffness: 100, damping: 15 }}
              className="grid grid-cols-1 md:grid-cols-2 gap-8"
            >
              {/* Host Card */}
              <button 
                onClick={() => setRole("host")}
                className="group relative flex flex-col items-center text-center p-10 bg-white border border-slate-200 rounded-[2rem] shadow-sm hover:shadow-2xl hover:shadow-indigo-100 hover:border-indigo-200 transition-all duration-500 overflow-hidden"
              >
                <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-700">
                  <Server className="w-40 h-40 text-indigo-600" />
                </div>
                
                <div className="w-20 h-20 bg-indigo-50 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:bg-indigo-600 transition-all duration-500">
                  <Server className="w-10 h-10 text-indigo-600 group-hover:text-white transition-colors" />
                </div>
                
                <h2 className="text-2xl font-bold mb-3 text-slate-800">Ser o Host</h2>
                <p className="text-slate-500 leading-relaxed max-w-xs">
                  Inicie a rede mesh segura na sua máquina e libere o código de acesso para os seus convidados jogarem.
                </p>
                
                <div className="mt-8 flex items-center gap-2 text-indigo-600 font-semibold group-hover:gap-4 transition-all">
                  Configurar Sessão <ChevronRight className="w-4 h-4" />
                </div>
              </button>

              {/* Guest Card */}
              <button 
                onClick={() => setRole("guest")}
                className="group relative flex flex-col items-center text-center p-10 bg-white border border-slate-200 rounded-[2rem] shadow-sm hover:shadow-2xl hover:shadow-emerald-100 hover:border-emerald-200 transition-all duration-500 overflow-hidden"
              >
                <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-700">
                  <Users className="w-40 h-40 text-emerald-600" />
                </div>

                <div className="w-20 h-20 bg-emerald-50 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:bg-emerald-600 transition-all duration-500">
                  <Users className="w-10 h-10 text-emerald-600 group-hover:text-white transition-colors" />
                </div>
                
                <h2 className="text-2xl font-bold mb-3 text-slate-800">Entrar em um Jogo</h2>
                <p className="text-slate-500 leading-relaxed max-w-xs">
                  Digite o código hexadecimal recebido de um amigo para abrir um canal seguro de baixa latência.
                </p>

                <div className="mt-8 flex items-center gap-2 text-emerald-600 font-semibold group-hover:gap-4 transition-all">
                  Usar código <ChevronRight className="w-4 h-4" />
                </div>
              </button>
            </motion.div>
          ) : (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 120, damping: 18 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between">
                <button
                  onClick={() => {
                    // A rede mesh continua rodando em segundo plano mesmo ao navegar
                    setRole(null);
                  }}
                  className="text-sm font-bold text-slate-400 hover:text-slate-600 transition-colors flex items-center gap-2"
                >
                  ← Voltar para o início
                </button>
                
                <div className="flex items-center gap-3 px-4 py-2 bg-white border border-slate-200 rounded-2xl shadow-sm">
                  <div className={cn(
                    "w-2.5 h-2.5 rounded-full",
                    netStatus === "online" ? "bg-emerald-500 animate-pulse" :
                    netStatus === "connecting" ? "bg-amber-500 animate-bounce" : "bg-slate-400"
                  )} />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    {role === "host" ? "Modo Host" : "Modo Convidado"} — {
                      netStatus === "online" ? "Online" :
                      netStatus === "connecting" ? "Conectando..." : "Offline"
                    }
                  </span>
                </div>
              </div>

              {role === "host" ? (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  {/* Painel Principal (2 colunas) */}
                  <div className="lg:col-span-2 space-y-6">
                    {/* Minecraft Server Control Card */}
                    <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm space-y-6">
                      <div className="flex items-center justify-between flex-wrap gap-4">
                        <div>
                          <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-50 px-2.5 py-1 rounded-full">
                            Minecraft Server Vanilla
                          </span>
                          <h2 className="text-3xl font-bold text-slate-800 mt-2">
                            {selectedServer ? selectedServer : "Nenhum Servidor Selecionado"}
                          </h2>
                          <p className="text-slate-500 mt-1">
                            {selectedServer
                              ? (() => {
                                  const sv = localServers.find(s => s.name === selectedServer);
                                  return sv?.version ? `Versão: ${sv.version}` : "Versão não encontrada";
                                })()
                              : "Selecione ou crie um servidor na barra lateral para começar."}
                          </p>
                        </div>

                        {selectedServer && (
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-100 rounded-xl text-xs font-bold text-slate-600">
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

                            <button
                              onClick={
                                serverStatus === "online" 
                                  ? handleStopMCServer 
                                  : handleStartMCServer
                              }
                              disabled={serverStatus === "starting" || serverStatus === "stopping"}
                              className={cn(
                                "h-12 px-6 rounded-xl font-bold flex items-center gap-2 transition-all active:scale-95 shadow-md disabled:opacity-50",
                                serverStatus === "online"
                                  ? "bg-rose-500 hover:bg-rose-600 text-white shadow-rose-100"
                                  : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-100"
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
                        <div className="p-4 bg-rose-50 border border-rose-100 text-rose-800 rounded-2xl flex items-center gap-3 text-sm">
                          <AlertTriangle className="w-5 h-5 text-rose-500 flex-shrink-0" />
                          <div>
                            <span className="font-bold">O servidor fechou de forma inesperada.</span> Verifique os logs do console para identificar erros nos arquivos ou configurações do Minecraft.
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Rede do Servidor (Mesh VPN) */}
                    <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm space-y-8">
                      <div className="flex items-start justify-between flex-wrap gap-4">
                        <div>
                          <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-50 px-2.5 py-1 rounded-full">
                            Rede Mesh VPN
                          </span>
                          <h2 className="text-3xl font-bold text-slate-800 mt-2">Rede do Servidor</h2>
                          <p className="text-slate-500 mt-1">Conexão segura ponto-a-ponto via VPN virtual</p>
                        </div>
                        <button 
                          onClick={handleStartServer}
                          disabled={isStarting && downloadProgress !== null}
                          className={cn(
                            "h-14 px-8 rounded-2xl font-bold flex items-center gap-3 transition-all active:scale-95 shadow-lg disabled:opacity-50",
                            netStatus !== "offline" || isStarting
                              ? "bg-rose-50 text-rose-600 shadow-rose-100 hover:bg-rose-100" 
                              : "bg-indigo-600 text-white shadow-indigo-200 hover:bg-indigo-700"
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
                          <div className="w-full h-2 bg-indigo-50 rounded-full overflow-hidden">
                            <motion.div 
                              initial={{ width: 0 }}
                              animate={{ width: `${downloadProgress.percent}%` }}
                              className="h-full bg-indigo-600"
                            />
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-3 gap-4">
                        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Redirecionamento</p>
                          <p className="text-sm font-bold text-slate-800 mt-1">127.0.0.1:{minecraftPort}</p>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Endereço Mesh</p>
                          <p className="text-sm font-bold text-slate-800 mt-1">{netIp || "Inativo"}</p>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Interface</p>
                          <p className="text-sm font-bold text-emerald-600 mt-1">{netStatus === "online" ? "Ativa" : "Desconectada"}</p>
                        </div>
                      </div>

                      {netStatus === "online" && netIp && (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="p-6 bg-indigo-50 border border-indigo-100 rounded-2xl flex flex-col md:flex-row items-center justify-between gap-4"
                        >
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center shadow-sm">
                              <ShieldCheck className="text-indigo-600 w-6 h-6" />
                            </div>
                            <div>
                              <p className="text-sm font-bold text-indigo-900">Rede Mesh Ativa</p>
                              <p className="text-xs text-indigo-600">Compartilhe o código abaixo com seus amigos.</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="bg-white px-4 py-2 rounded-xl font-mono font-bold text-indigo-600 text-sm shadow-sm border border-indigo-100">
                              {ipToCode(netIp)}
                            </div>
                            <button 
                              onClick={() => copyToClipboard(ipToCode(netIp))}
                              className="p-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all shadow-sm active:scale-95"
                              title="Copiar Código"
                            >
                              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </div>

                    {/* Console Tabbed Logger */}
                    <div className="bg-slate-900 rounded-[2rem] p-6 font-mono text-xs text-slate-400 flex flex-col shadow-2xl border border-white/10">
                      {/* Tabs Header */}
                      <div className="pb-4 border-b border-white/5 bg-slate-900 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => setActiveTab("minecraft")}
                            className={cn(
                              "text-[10px] uppercase font-bold tracking-tighter transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                              activeTab === "minecraft"
                                ? "bg-white/10 text-white"
                                : "text-slate-500 hover:text-slate-300"
                            )}
                          >
                            <Terminal className="w-3.5 h-3.5" /> Minecraft Console
                          </button>
                          <button
                            onClick={() => setActiveTab("network")}
                            className={cn(
                              "text-[10px] uppercase font-bold tracking-tighter transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                              activeTab === "network"
                                ? "bg-white/10 text-white"
                                : "text-slate-500 hover:text-slate-300"
                            )}
                          >
                            <Activity className="w-3.5 h-3.5" /> Rede Mesh
                          </button>
                        </div>
                        <button 
                          onClick={() => {
                            if (activeTab === "minecraft") setMcLogs([]);
                            else setLogs([]);
                          }}
                          className="text-[10px] text-slate-500 hover:text-slate-300 font-bold uppercase transition-colors"
                        >
                          Limpar
                        </button>
                      </div>

                      {/* Tab Contents */}
                      <div className="h-72 overflow-y-auto mt-4 space-y-1.5 pr-2 custom-scrollbar">
                        {activeTab === "minecraft" ? (
                          mcLogs.length === 0 ? (
                            <p className="text-slate-600 italic">Console do Minecraft inativo. Inicie o servidor Minecraft para monitorar.</p>
                          ) : (
                            mcLogs.map((log, idx) => {
                              const isErr = log.includes("[ERR]") || log.includes("ERROR") || log.includes("[CubeForge ERR]");
                              const isWarn = log.includes("WARN") || log.includes("WARNING");
                              return (
                                <p key={idx} className={cn(
                                  "leading-relaxed break-words whitespace-pre-wrap",
                                  isErr ? "text-rose-400" : isWarn ? "text-amber-400" : "text-slate-300"
                                )}>
                                  {log}
                                </p>
                              );
                            })
                          )
                        ) : (
                          logs.length === 0 ? (
                            <p className="text-slate-600 italic">Nenhum log de rede gerado. Inicie o túnel para monitorar.</p>
                          ) : (
                            logs.map((log, idx) => {
                              const isErr = log.startsWith("[ERR]");
                              return (
                                <p key={idx} className={cn(
                                  "leading-relaxed break-all",
                                  isErr ? "text-rose-400" : "text-slate-300"
                                )}>
                                  {log}
                                </p>
                              );
                            })
                          )
                        )}
                        <div ref={activeTab === "minecraft" ? mcLogsEndRef : logsEndRef} />
                      </div>

                      {/* Stdin Command Input for Minecraft */}
                      {activeTab === "minecraft" && (
                        <form 
                          onSubmit={handleSendMCCommand}
                          className="mt-4 pt-4 border-t border-white/5 flex gap-2"
                        >
                          <input
                            type="text"
                            placeholder={
                              serverStatus === "online" 
                                ? "Digite um comando para o Minecraft (ex: op Player, say Olá)..."
                                : "O console aceita comandos apenas quando o servidor está ONLINE"
                            }
                            value={mcCommand}
                            onChange={(e) => setMcCommand(e.target.value)}
                            disabled={serverStatus !== "online"}
                            className="bg-black/40 border border-white/10 px-4 py-2.5 rounded-xl text-slate-300 placeholder:text-slate-600 text-xs flex-1 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
                          />
                          <button
                            type="submit"
                            disabled={serverStatus !== "online" || !mcCommand.trim()}
                            className="bg-indigo-600 text-white rounded-xl px-4 py-2 hover:bg-indigo-700 active:scale-95 transition-all disabled:opacity-40"
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        </form>
                      )}
                    </div>
                  </div>

                  {/* Sidebar (1 coluna) */}
                  <div className="space-y-6">
                    {/* Lista de Servidores */}
                    <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <Server className="w-4 h-4 text-indigo-500" /> Servidores Locais
                        </h3>
                        <button
                          onClick={() => setShowCreateServer(true)}
                          className="p-1.5 hover:bg-slate-100 text-indigo-600 rounded-lg border border-indigo-100 transition-colors"
                          title="Criar Novo Servidor"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                        {localServers.length === 0 ? (
                          <div className="text-center py-6 px-4 bg-slate-50 border border-dashed border-slate-200 rounded-2xl text-xs text-slate-400">
                            Nenhum servidor criado. Clique no botão &quot;+&quot; acima para adicionar o seu primeiro servidor.
                          </div>
                        ) : (
                          localServers.map((server) => {
                            const isSelected = selectedServer === server.name;
                            const isRunning = isSelected && serverStatus !== "offline";
                            return (
                              <div
                                key={server.name}
                                onClick={() => {
                                  if (serverStatus !== "offline" && serverStatus !== "crashed" && !isSelected) {
                                    alert("Pare o servidor atual antes de selecionar outro.");
                                    return;
                                  }
                                  setSelectedServer(server.name);
                                }}
                                className={cn(
                                  "p-4 rounded-2xl border transition-all duration-300 flex items-center justify-between cursor-pointer relative",
                                  isSelected 
                                    ? "bg-indigo-50 border-indigo-200 shadow-sm"
                                    : "bg-slate-50 border-slate-100 hover:border-slate-300 hover:bg-white"
                                )}
                              >
                                <div className="min-w-0">
                                  <p className="font-bold text-slate-800 truncate text-sm">{server.name}</p>
                                  <p className="text-[10px] text-slate-400 mt-0.5">Versão: {server.version || "Não encontrada"}</p>
                                </div>

                                <div className="flex items-center gap-2">
                                  {isRunning && (
                                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
                                  )}
                                  <SettingsButton serverDir={server.path} setConfigServer={setConfigServerDir} setShowConfigModal={setShowConfigModal} />
                                  <button
                                    onClick={(e) => handleDeleteServer(server.name, e)}
                                    disabled={isDeletingServer === server.name || isRunning}
                                    className="p-1.5 hover:bg-rose-50 text-slate-400 hover:text-rose-500 rounded-lg transition-colors disabled:opacity-30"
                                    title="Deletar Servidor"
                                  >
                                    {isDeletingServer === server.name ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <Trash2 className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {/* Parâmetros Globais */}
                    <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm">
                      <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <Database className="w-4 h-4 text-slate-400" /> Parâmetros locais
                      </h3>
                      <div className="space-y-4">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-slate-500">Diretório do Servidor</span>
                          <button 
                            onClick={handleSelectDir}
                            className="p-2 bg-slate-50 hover:bg-slate-100 rounded-lg border border-slate-100 transition-colors"
                            title="Escolher diretório"
                          >
                            <FolderOpen className="w-4 h-4 text-indigo-600" />
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-400 font-mono truncate bg-slate-50 p-2 rounded-lg border border-slate-100" title={serverDir || ""}>
                          {serverDir || "Carregando..."}
                        </p>

                        <div className="flex justify-between items-end mt-4">
                          <span className="text-sm text-slate-500">Porta Interna (Minecraft)</span>
                          <span className="text-sm font-bold font-mono text-slate-700">{serverConfigPort}</span>
                        </div>
                        
                        <div className="flex justify-between items-end mt-4">
                          <span className="text-sm text-slate-500">Java Runtime</span>
                          <span className="text-sm font-bold text-indigo-600">
                            {selectedServer 
                              ? `JRE ${getJavaVersion(localServers.find(s => s.name === selectedServer)?.version || "1.20.1")}` 
                              : "JRE 17 / 21"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Suporte */}
                    <div className="bg-indigo-600 p-6 rounded-[2rem] text-white shadow-xl shadow-indigo-100">
                      <h3 className="font-bold text-white mb-2">Suporte ao CubeForge</h3>
                      <p className="text-indigo-100 text-sm leading-relaxed mb-4">
                        O CubeForge Dash economiza taxas mensais de hosts cloud tradicionais. Apoie o projeto!
                      </p>
                      <button className="w-full py-3 bg-white text-indigo-600 rounded-2xl font-bold text-sm hover:bg-indigo-50 transition-colors">
                        Pagar uma Coquinha 🥤
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="max-w-xl mx-auto space-y-8 text-center">
                  <div className="space-y-4 animate-fade-in">
                    <h2 className="text-4xl font-bold text-slate-800">Conectar ao Host</h2>
                    <p className="text-slate-500">Insira o código enviado pelo host para abrir o proxy reverso em localhost.</p>
                  </div>
                  
                  <div className="bg-white p-10 rounded-[2rem] border border-slate-200 shadow-sm space-y-6">
                    <input 
                      type="text" 
                      placeholder="CF-XXXXXXXX"
                      disabled={netStatus !== "offline"}
                      value={inviteCodeInput}
                      onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                      className="w-full h-20 text-center text-3xl font-mono font-bold tracking-[0.1em] border-2 border-slate-100 rounded-2xl focus:border-emerald-500 focus:outline-none transition-all uppercase placeholder:text-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                    />
                    
                    <button 
                      onClick={handleConnectGuest}
                      className={cn(
                        "w-full h-16 rounded-2xl font-bold text-lg shadow-lg transition-all active:scale-95 flex items-center justify-center gap-3",
                        netStatus === "online" 
                          ? "bg-rose-50 text-rose-600 shadow-rose-100 hover:bg-rose-100" 
                          : netStatus === "connecting"
                          ? "bg-amber-500 text-white shadow-amber-100 hover:bg-amber-600"
                          : "bg-emerald-600 text-white shadow-emerald-100 hover:bg-emerald-700"
                      )}
                    >
                      {netStatus === "online" ? (
                        <>Parar Conexão</>
                      ) : netStatus === "connecting" ? (
                        <><Activity className="w-5 h-5 animate-spin" /> Conectando...</>
                      ) : (
                        <><Zap className="w-5 h-5 fill-current" /> Conectar Agora</>
                      )}
                    </button>
                    
                    <div className="pt-4 flex items-center justify-center gap-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                      <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> Tunelamento P2P</span>
                      <span className="w-1 h-1 bg-slate-200 rounded-full" />
                      <span className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-emerald-500" /> Porta {minecraftPort}</span>
                    </div>
                  </div>

                  {netStatus === "online" && (
                    <motion.div
                      initial={{ opacity: 0, y: 15 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-6 bg-emerald-50 border border-emerald-100 rounded-[2rem] text-left"
                    >
                      <h4 className="font-bold text-emerald-900 mb-1">Túnel Estabelecido!</h4>
                      <p className="text-xs text-emerald-700 leading-relaxed">
                        O proxy reverso de rede está ativo. O jogo do host está acessível no endereço local:
                      </p>
                      <div className="mt-3 flex items-center justify-between bg-white px-4 py-2.5 rounded-xl border border-emerald-100">
                        <span className="font-mono font-bold text-emerald-800 text-sm">localhost:{minecraftPort}</span>
                        <button 
                          onClick={() => copyToClipboard(`localhost:${minecraftPort}`)}
                          className="text-[10px] font-bold text-emerald-600 hover:text-emerald-800 transition-colors uppercase"
                        >
                          {copied ? "Copiado!" : "Copiar"}
                        </button>
                      </div>
                    </motion.div>
                  )}

                  {/* Monitoramento de log do guest */}
                  {netStatus !== "offline" && (
                    <div className="bg-slate-900 rounded-[2rem] p-6 font-mono text-xs text-slate-400 shadow-xl border border-white/10">
                      <div className="pb-3 border-b border-white/5 flex items-center justify-between">
                        <span className="uppercase tracking-tighter font-bold text-[10px] text-slate-500">Logs de Conexão</span>
                      </div>
                      <div className="h-48 overflow-y-auto mt-3 space-y-1 pr-2 custom-scrollbar">
                        {logs.map((log, idx) => (
                          <p key={idx} className="leading-relaxed text-slate-300 break-all">{log}</p>
                        ))}
                        <div ref={logsEndRef} />
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-slate-400 leading-relaxed italic max-w-sm mx-auto">
                    &quot;Ao conectar, o sistema abre uma escuta local em localhost que direciona os dados do seu jogo de forma encriptada diretamente para a máquina do host.&quot;
                  </p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Modal de Criação de Servidor */}
      <AnimatePresence>
        {showCreateServer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                if (serverInstallProgress) return;
                setShowCreateServer(false);
              }}
              className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
            />
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: "spring", duration: 0.4 }}
              className="relative w-full max-w-md bg-white rounded-[2rem] border border-slate-200 shadow-2xl p-8 z-10 space-y-6"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center">
                    <Plus className="text-indigo-600 w-5 h-5" />
                  </div>
                  <h3 className="text-xl font-bold text-slate-800">Criar Servidor Minecraft</h3>
                </div>
                {!serverInstallProgress && (
                  <button 
                    onClick={() => setShowCreateServer(false)}
                    className="p-1.5 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>

              {serverInstallProgress ? (
                <div className="py-8 space-y-4">
                  <div className="flex items-center justify-center gap-3">
                    <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                    <span className="font-bold text-slate-700 text-sm">{serverInstallProgress.status}</span>
                  </div>
                  <div className="space-y-2">
                    <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${serverInstallProgress.percent}%` }}
                        className="h-full bg-indigo-600 rounded-full"
                      />
                    </div>
                    <div className="text-right text-[10px] font-bold text-slate-400">{serverInstallProgress.percent}% concluído</div>
                  </div>
                  <p className="text-[10px] text-slate-400 text-center italic leading-relaxed">
                    Estamos baixando os arquivos oficiais de forma nativa e segura. Isso ocorrerá apenas uma vez por versão instalada.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleCreateServer} className="space-y-4">
                  {/* Nome do Servidor */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Nome do Servidor</label>
                    <input 
                      type="text" 
                      required
                      placeholder="Ex: Meu_Servidor"
                      value={createServerName}
                      onChange={(e) => setCreateServerName(e.target.value)}
                      className="w-full h-12 px-4 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-slate-700"
                    />
                  </div>

                  {/* Versão */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Versão do Minecraft</label>
                    <select
                      value={createServerVersion}
                      onChange={(e) => setCreateServerVersion(e.target.value as MinecraftVersion)}
                      className="w-full h-12 px-4 border border-slate-200 bg-white rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-slate-700"
                    >
                      {SUPPORTED_VERSIONS.map((v) => (
                        <option key={v} value={v}>Vanilla {v}</option>
                      ))}
                    </select>
                  </div>

                  {/* RAM */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">RAM Alocada</label>
                      <span className="text-sm font-bold text-indigo-600 font-mono">{createServerRam} GB</span>
                    </div>
                    <input 
                      type="range" 
                      min="2"
                      max={Math.max(2, totalSystemRamGb - 2)}
                      step="1"
                      value={createServerRam}
                      onChange={(e) => setCreateServerRam(parseInt(e.target.value))}
                      className="w-full accent-indigo-600 cursor-pointer h-2 bg-slate-100 rounded-lg appearance-none"
                    />
                    <div className="flex justify-between text-[10px] text-slate-400">
                      <span>Mín: 2 GB</span>
                      <span>Total no PC: {totalSystemRamGb} GB</span>
                    </div>
                    {createServerRam < 3 && (
                      <div className="mt-2 p-2.5 bg-amber-50 border border-amber-100 text-amber-800 text-[10px] rounded-xl flex items-start gap-2">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                        <span>
                          <strong>Atenção:</strong> Menos de 3 GB de RAM pode causar lentidão ou travamentos no servidor, especialmente com muitos jogadores ou mods.
                        </span>
                      </div>
                    )}
                    {(totalSystemRamGb - createServerRam < 2) && (
                      <div className="p-3 bg-amber-50 border border-amber-100 text-amber-800 text-[10px] rounded-xl flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                        <span>
                          <strong>Atenção:</strong> Deixar menos de 2GB livres para o sistema operacional pode deixar o Windows lento ou instável.
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Botões */}
                  <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                    <button 
                      type="button"
                      onClick={() => setShowCreateServer(false)}
                      className="px-5 h-12 rounded-2xl text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors text-sm font-semibold"
                    >
                      Cancelar
                    </button>
                    <button 
                      type="submit"
                      className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-indigo-100"
                    >
                      Criar Servidor
                    </button>
                  </div>
                </form>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal de Confirmação de Exclusão */}
      <AnimatePresence>
        {deleteConfirmServer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setDeleteConfirmServer(null);
                setDeleteConfirmInput('');
              }}
              className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: "spring", duration: 0.4 }}
              className="relative w-full max-w-md bg-white rounded-[2rem] border border-slate-200 shadow-2xl p-8 z-10 space-y-6"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-rose-50 rounded-lg flex items-center justify-center">
                  <AlertTriangle className="text-rose-500 w-5 h-5" />
                </div>
                <h3 className="text-xl font-bold text-slate-800">Excluir Servidor</h3>
              </div>

              <div className="space-y-4">
                <p className="text-sm text-slate-600 leading-relaxed">
                  Tem certeza que deseja excluir permanentemente o servidor <strong className="text-slate-800">"{deleteConfirmServer}"</strong>?
                  Todos os mundos, configurações e dados serão perdidos. Esta ação não pode ser desfeita.
                </p>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                    Digite o nome do servidor para confirmar
                  </label>
                  <input
                    type="text"
                    value={deleteConfirmInput}
                    onChange={(e) => setDeleteConfirmInput(e.target.value)}
                    placeholder={deleteConfirmServer || ""}
                    className="w-full h-12 px-4 border border-slate-200 rounded-2xl focus:border-rose-500 focus:outline-none transition-all text-sm font-semibold text-slate-700"
                    autoFocus
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  onClick={() => {
                    setDeleteConfirmServer(null);
                    setDeleteConfirmInput('');
                  }}
                  className="px-5 h-12 rounded-2xl text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors text-sm font-semibold"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleConfirmDelete}
                  disabled={deleteConfirmInput !== deleteConfirmServer}
                  className="px-6 h-12 bg-rose-500 text-white rounded-2xl hover:bg-rose-600 transition-colors text-sm font-semibold shadow-md shadow-rose-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Excluir Permanentemente
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal de Configurações */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Overlay */}
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
              className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
            />
            
            {/* Modal Content */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: "spring", duration: 0.4 }}
              className="relative w-full max-w-md bg-white rounded-[2rem] border border-slate-200 shadow-2xl p-8 z-10 space-y-6"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center">
                    <Settings className="text-indigo-600 w-5 h-5" />
                  </div>
                  <h3 className="text-xl font-bold text-slate-800">Ajustes do Sistema</h3>
                </div>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="p-1.5 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                {/* Local Port Input */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Porta Local do Minecraft</label>
                  <input 
                    type="number" 
                    min="1024"
                    max="65535"
                    value={settingsPort}
                    onChange={(e) => setSettingsPort(parseInt(e.target.value) || 25565)}
                    className="w-full h-12 px-4 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:outline-none transition-all font-mono text-sm"
                  />
                  <p className="text-[10px] text-slate-400">
                    Porta local na qual o seu Minecraft se conectará (padrão 25565).
                  </p>
                </div>
              </div>

              {/* Botões de Ação */}
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="px-5 h-12 rounded-2xl text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors text-sm font-semibold"
                >
                  Cancelar
                </button>
                <button 
                  onClick={handleSaveSettings}
                  className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-indigo-100"
                >
                  Salvar Ajustes
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal de Configurações do Servidor (server.properties) */}
      {configServerDir && (
        <ServerConfigModal
          serverDir={configServerDir}
          isOpen={showConfigModal}
          onClose={() => {
            setShowConfigModal(false);
            setConfigServerDir(null);
          }}
          onSaved={async () => {
            // Recarrega a lista de servidores após salvar
            const servers = await listLocalServers();
            setLocalServers(servers);
          }}
          serverStatus={serverStatus}
        />
      )}
    </div>
  );
}
