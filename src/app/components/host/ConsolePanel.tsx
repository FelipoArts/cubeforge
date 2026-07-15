"use client";

import { useState, useRef, useEffect } from "react";
import { Terminal, Activity, Send } from "lucide-react";
import { cn } from "@/lib/utils";

// ============================================================
// ConsolePanel
// ============================================================
// Console com abas para logs do Minecraft e da Rede Mesh.
// Inclui input de comandos para o servidor Minecraft.
// Auto-scroll ao final sempre que logs mudam ou aba troca.
// ============================================================

interface ConsolePanelProps {
  mcLogs: string[];
  networkLogs: string[];
  serverStatus: string;
  onSendCommand: (command: string) => void;
  onClearLogs: (tab: "minecraft" | "network") => void;
}

export function ConsolePanel({
  mcLogs,
  networkLogs,
  serverStatus,
  onSendCommand,
  onClearLogs,
}: ConsolePanelProps) {
  const [activeTab, setActiveTab] = useState<"minecraft" | "network">("minecraft");
  const [mcCommand, setMcCommand] = useState("");
  const mcLogsEndRef = useRef<HTMLDivElement>(null);
  const networkLogsEndRef = useRef<HTMLDivElement>(null);

  // Refs para o container de scroll
  const mcScrollRef = useRef<HTMLDivElement>(null);
  const networkScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll inteligente: só rola para o final se o usuário já estiver no final.
  // Usa scrollTop diretamente no container em vez de scrollIntoView para evitar
  // que o scroll "vaze" para o scroll principal da página.
  useEffect(() => {
    const container = mcScrollRef.current;
    if (!container) return;
    const isAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 8;
    if (isAtBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }, [mcLogs]);

  useEffect(() => {
    const container = networkScrollRef.current;
    if (!container) return;
    const isAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 8;
    if (isAtBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }, [networkLogs]);

  // Auto-scroll para o final quando troca de aba
  useEffect(() => {
    const container = activeTab === "minecraft" ? mcScrollRef.current : networkScrollRef.current;
    if (container) {
      setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
    }
  }, [activeTab]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcCommand.trim() || serverStatus !== "online") return;
    onSendCommand(mcCommand.trim());
    setMcCommand("");
  };

  return (
    <div className="bg-theme-console rounded-[2rem] p-6 font-mono text-xs text-slate-400 flex flex-col shadow-2xl border border-white/10">
      {/* Tabs Header */}
      <div className="pb-4 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setActiveTab("minecraft")}
            className={cn(
              "text-[10px] uppercase font-bold tracking-tighter transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer",
              activeTab === "minecraft"
                ? "bg-white/10 text-white"
                : "text-slate-500 hover:text-slate-300"
            )}
          >
            <Terminal className="w-3.5 h-3.5" /> Minecraft Console
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("network")}
            className={cn(
              "text-[10px] uppercase font-bold tracking-tighter transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer",
              activeTab === "network"
                ? "bg-white/10 text-white"
                : "text-slate-500 hover:text-slate-300"
            )}
          >
            <Activity className="w-3.5 h-3.5" /> Rede Mesh
          </button>
        </div>
        <button
          type="button"
          onClick={() => onClearLogs(activeTab)}
          className="text-[10px] text-slate-500 hover:text-slate-300 font-bold uppercase transition-colors cursor-pointer"
        >
          Limpar
        </button>
      </div>

      {/* Tab Contents */}
      <div
        ref={activeTab === "minecraft" ? mcScrollRef : networkScrollRef}
        className="h-72 overflow-y-auto mt-4 space-y-1.5 pr-2 custom-scrollbar"
      >
        {activeTab === "minecraft" ? (
          mcLogs.length === 0 ? (
            <p className="text-slate-600 italic">Console do Minecraft inativo. Inicie o servidor Minecraft para monitorar.</p>
          ) : (
            mcLogs.map((log, idx) => {
              const isErr = log.includes("[ERR]") || log.includes("ERROR") || log.includes("[Cubicase ERR]");
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
          networkLogs.length === 0 ? (
            <p className="text-slate-600 italic">Nenhum log de rede gerado. Inicie o túnel para monitorar.</p>
          ) : (
            networkLogs.map((log, idx) => {
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
        <div ref={activeTab === "minecraft" ? mcLogsEndRef : networkLogsEndRef} />
      </div>

      {/* Stdin Command Input for Minecraft */}
      {activeTab === "minecraft" && (
        <form
          onSubmit={handleSubmit}
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
            className="bg-indigo-600 text-white rounded-xl px-4 py-2 hover:bg-indigo-700 active:scale-95 transition-all disabled:opacity-40 cursor-pointer"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      )}
    </div>
  );
}
