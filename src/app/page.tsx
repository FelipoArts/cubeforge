"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Server, 
  Users, 
  Cpu, 
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
  Terminal
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { open } from "@tauri-apps/plugin-dialog";
import { documentDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store";
import { installJRE, isJREInstalled, type DownloadProgress } from "@/lib/jre";

function cn(...inputs: ClassValue[]) {
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

  // Estados de Rede e Configurações
  const [netStatus, setNetStatus] = useState<"offline" | "connecting" | "online">("offline");
  const [netIp, setNetIp] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  
  // Estados locais para formulários de Convidado
  const [inviteCodeInput, setInviteCodeInput] = useState("");

  const logsEndRef = useRef<HTMLDivElement>(null);

  const { 
    serverDir, 
    setServerDir, 
    minecraftPort,
    setMinecraftPort
  } = useAppStore();

  // Estados temporários do modal de configurações
  const [settingsPort, setSettingsPort] = useState(25565);

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

    async function setupListeners() {
      unlistenStatus = await listen<{ status: string; ip: string | null }>("network-status", (event) => {
        console.log("network-status event:", event.payload);
        if (event.payload.status === "online") {
          setNetStatus("online");
          setNetIp(event.payload.ip);
        } else {
          setNetStatus("offline");
          setNetIp(null);
          setIsStarting(false);
        }
      });

      unlistenLogs = await listen<{ message: string; is_error: boolean }>("network-log", (event) => {
        setLogs(prev => {
          const newLogs = [...prev, `[${event.payload.is_error ? 'ERR' : 'INFO'}] ${event.payload.message}`];
          // Limita histórico em 150 linhas
          return newLogs.slice(-150);
        });
      });
    }

    setupListeners();

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenLogs) unlistenLogs();
    };
  }, []);

  // Rolar logs do console automaticamente
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

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

  const handleStartServer = async () => {
    // Se o servidor/rede já estiver rodando ou iniciando, para a execução
    if (isStarting || netStatus !== "offline") {
      try {
        setLogs(prev => [...prev, "[INFO] Parando nó de rede e servidor..."]);
        await invoke("stop_network_node");
        setIsStarting(false);
        setNetStatus("offline");
        setNetIp(null);
      } catch (err) {
        console.error(err);
        alert("Erro ao parar rede: " + err);
      }
      return;
    }

    try {
      setIsStarting(true);
      setLogs([]); // Limpar logs anteriores
      
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
      
    } catch (error) {
      console.error(error);
      setIsStarting(false);
      setNetStatus("offline");
      setDownloadProgress(null);
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
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-slate-100 rounded-xl transition-all duration-300 text-slate-500 hover:text-indigo-600 hover:rotate-45"
            title="Configurações"
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
                    invoke("stop_network_node");
                    setRole(null);
                    setNetStatus("offline");
                    setNetIp(null);
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
                  <div className="lg:col-span-2 space-y-6">
                    {/* Server Control Card */}
                    <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm space-y-8">
                      <div className="flex items-start justify-between flex-wrap gap-4">
                        <div>
                          <h2 className="text-3xl font-bold text-slate-800">Rede do Servidor</h2>
                          <p className="text-slate-500 mt-1">Minecraft Server local redirecionado via Mesh</p>
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
                              <><Activity className="w-5 h-5 animate-spin" /> Parar Sessão</>
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

                    {/* Console Logger */}
                    <div className="bg-slate-900 rounded-[2rem] p-6 font-mono text-xs text-slate-400 h-72 flex flex-col shadow-2xl border border-white/10">
                      <div className="pb-4 border-b border-white/5 bg-slate-900 flex items-center justify-between">
                        <span className="uppercase tracking-tighter font-bold text-[10px] text-slate-500 flex items-center gap-1.5">
                          <Terminal className="w-3.5 h-3.5" /> Output da Rede Mesh
                        </span>
                        <button 
                          onClick={() => setLogs([])}
                          className="text-[10px] text-slate-500 hover:text-slate-300 font-bold uppercase transition-colors"
                        >
                          Limpar
                        </button>
                      </div>
                      <div className="flex-1 overflow-y-auto mt-4 space-y-1.5 pr-2 custom-scrollbar">
                        {logs.length === 0 ? (
                          <p className="text-slate-600 italic">Nenhum log gerado no momento. Inicie o túnel para monitorar.</p>
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
                        )}
                        <div ref={logsEndRef} />
                      </div>
                    </div>
                  </div>

                  {/* Sidebar */}
                  <div className="space-y-6">
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
                          <span className="text-sm font-bold font-mono text-slate-700">{minecraftPort}</span>
                        </div>
                        
                        <div className="flex justify-between items-end mt-4">
                          <span className="text-sm text-slate-500">Java Runtime</span>
                          <span className="text-sm font-bold text-indigo-600">JRE 17 (Adoptium)</span>
                        </div>
                      </div>
                    </div>

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
                    <div className="bg-slate-900 rounded-[2rem] p-6 font-mono text-xs text-slate-400 h-48 flex flex-col text-left shadow-xl border border-white/10">
                      <div className="pb-3 border-b border-white/5 flex items-center justify-between">
                        <span className="uppercase tracking-tighter font-bold text-[10px] text-slate-500">Logs de Conexão</span>
                      </div>
                      <div className="flex-1 overflow-y-auto mt-3 space-y-1 pr-2 custom-scrollbar">
                        {logs.map((log, idx) => (
                          <p key={idx} className="leading-relaxed text-slate-300 break-all">{log}</p>
                        ))}
                        <div ref={logsEndRef} />
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-slate-400 leading-relaxed italic max-w-sm mx-auto">
                    "Ao conectar, o sistema abre uma escuta local em localhost que direciona os dados do seu jogo de forma encriptada diretamente para a máquina do host."
                  </p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

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
    </div>
  );
}
