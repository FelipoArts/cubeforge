"use client";

import { Server, Plus, Trash2, Loader2, FolderOpen, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import SettingsButton from "@/app/components/SettingsButton";
import { pushDiagnostic } from "@/app/diagnostics";
import type { ServerInfo } from "@/lib/server";

// ============================================================
// ServerList
// ============================================================
// Sidebar com lista de servidores locais.
// Permite selecionar, configurar e deletar servidores.
// ============================================================

interface ServerListProps {
  servers: ServerInfo[];
  selectedServer: string | null;
  serverStatus: string;
  onSelect: (name: string) => void;
  onCreate: () => void;
  onImport: () => void;
  onImportModpack: () => void;
  onDelete: (name: string, e: React.MouseEvent) => void;
  onConfig: (path: string) => void;
  isDeleting: string | null;
  isImporting: boolean;
}

export function ServerList({
  servers,
  selectedServer,
  serverStatus,
  onSelect,
  onCreate,
  onImport,
  onImportModpack,
  onDelete,
  onConfig,
  isDeleting,
  isImporting,
}: ServerListProps) {
  return (
    <div className="bg-theme-card p-6 rounded-[2rem] border-theme-card shadow-theme-card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-theme-primary flex items-center gap-2">
          <Server className="w-4 h-4 text-indigo-500" /> Servidores Locais
        </h3>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onImport}
            disabled={isImporting}
            className="p-1.5 hover:bg-theme-accent text-indigo-600 rounded-lg border border-theme-accent transition-colors cursor-pointer disabled:opacity-40"
            title="Importar Servidor Existente"
          >
            {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onImportModpack}
            className="p-1.5 hover:bg-theme-accent text-indigo-600 rounded-lg border border-theme-accent transition-colors cursor-pointer"
            title="Importar Modpack (.zip/.mrpack)"
          >
            <Package className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onCreate}
            className="p-1.5 hover:bg-theme-accent text-indigo-600 rounded-lg border border-theme-accent transition-colors cursor-pointer"
            title="Criar Novo Servidor"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
        {servers.length === 0 ? (
          <div className="text-center py-6 px-4 bg-theme-muted border border-dashed border-theme-card rounded-2xl text-xs text-theme-secondary">
            Nenhum servidor criado. Clique no botão "+" acima para adicionar o seu primeiro servidor.
          </div>
        ) : (
          servers.map((server) => {
            const isSelected = selectedServer === server.name;
            const isRunning = isSelected && (serverStatus === "online" || serverStatus === "starting" || serverStatus === "stopping");
            return (
              <div
                key={server.name}
                onClick={() => {
                  if (serverStatus !== "offline" && serverStatus !== "crashed" && !isSelected) {
                    pushDiagnostic({ level: "warning", source: "Servidor", title: "Servidor em execução", message: "Pare o servidor atual antes de selecionar outro." });
                    return;
                  }
                  onSelect(server.name);
                }}
                className={cn(
                  "p-4 rounded-2xl border transition-all duration-300 flex items-center justify-between cursor-pointer relative",
                  isSelected
                    ? "bg-theme-accent border-theme-accent shadow-theme-shadow"
                    : "bg-theme-muted border-theme-card hover:border-slate-300 hover:bg-theme-card"
                )}
              >
                <div className="min-w-0">
                  <p className="font-bold text-theme-primary truncate text-sm">{server.name}</p>
                  <p className="text-[10px] text-theme-secondary mt-0.5">Versão: {server.version || "Não encontrada"}</p>
                </div>

                <div className="flex items-center gap-2">
                  {isRunning && (
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
                  )}
                  <SettingsButton serverDir={server.path} onConfig={onConfig} />
                  <button
                    type="button"
                    onClick={(e) => onDelete(server.name, e)}
                    disabled={isDeleting === server.name || isRunning}
                    className="p-1.5 hover:bg-rose-50 dark:hover:bg-rose-900/20 text-theme-secondary hover:text-rose-500 rounded-lg transition-colors disabled:opacity-30 cursor-pointer"
                    title="Deletar Servidor"
                  >
                    {isDeleting === server.name ? (
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
  );
}
