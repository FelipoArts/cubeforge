"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Blocks,
  Globe2,
  Trash2,
  FolderOpen,
  Archive,
  RotateCcw,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Save,
  CheckSquare,
  Square,
  PackagePlus,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { cn } from "@/lib/utils";
import { pushDiagnostic } from "@/app/diagnostics";
import type { ServerStatus } from "@/app/store";
import { ConfirmActionModal } from "./ConfirmActionModal";
import { ModBrowserModal } from "./ModBrowserModal";
import { loaderForServerType } from "@/lib/modrinth";

// ============================================================
// ServerManagePanel
// ============================================================
// Painel inline com abas para gerenciar os mods (Forge/Fabric/NeoForge)
// e o mundo (backup/restaurar/resetar) do servidor selecionado, sem
// precisar abrir a pasta do servidor manualmente.
// ============================================================

interface ModInfo {
  file_name: string;
  display_name: string;
  size_bytes: number;
  enabled: boolean;
}

interface BackupInfo {
  file_name: string;
  size_bytes: number;
  created_at: string;
}

interface ServerManagePanelProps {
  serverDir: string;
  serverType: string;
  serverStatus: ServerStatus;
  mcVersion: string | null;
}

type PendingAction =
  | { kind: "delete-mod"; fileName: string; displayName: string }
  | { kind: "delete-mods-bulk"; fileNames: string[] }
  | { kind: "delete-backup"; fileName: string }
  | { kind: "restore-backup"; fileName: string }
  | { kind: "reset-world" };

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(iso: string): string {
  if (!iso) return "Data desconhecida";
  try {
    return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function ServerManagePanel({ serverDir, serverType, serverStatus, mcVersion }: ServerManagePanelProps) {
  // Forge/NeoForge/Fabric usam pasta "mods"; Paper (e derivados como Spigot/Purpur)
  // usam pasta "plugins" — mesmo conceito de gerenciamento, pasta e rótulo diferentes.
  const isPluginBased = serverType === "paper" || serverType === "spigot" || serverType === "purpur" || serverType === "bukkit";
  const modsCapable = serverType === "forge" || serverType === "neoforge" || serverType === "fabric" || isPluginBased;
  const itemsFolder = isPluginBased ? "plugins" : "mods";
  const itemsLabel = isPluginBased ? "Plugins" : "Mods";
  // A Modrinth só cobre esse mesmo conjunto de loaders (ver loaderForServerType em
  // src/lib/modrinth.ts); precisamos também saber a versão do MC pra filtrar por
  // compatibilidade, que nem sempre está disponível (ex: servidor importado sem meta).
  const modBrowserAvailable = modsCapable && !!loaderForServerType(serverType) && !!mcVersion;
  const [activeTab, setActiveTab] = useState<"mods" | "mundo">(modsCapable ? "mods" : "mundo");
  const [showModBrowser, setShowModBrowser] = useState(false);

  const [mods, setMods] = useState<ModInfo[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loadingMods, setLoadingMods] = useState(false);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set());

  const isServerStopped = serverStatus === "offline" || serverStatus === "crashed";

  // Some mensagens de erro (ex: aviso de backup sem mundo) somem sozinhas depois de um tempo.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const loadMods = useCallback(async () => {
    if (!modsCapable) return;
    setLoadingMods(true);
    try {
      const list = await invoke<ModInfo[]>("list_mods", { serverDir, folderName: itemsFolder });
      setMods(list);
      setSelectedMods((prev) => {
        const stillPresent = new Set([...prev].filter((fileName) => list.some((m) => m.file_name === fileName)));
        return stillPresent.size === prev.size ? prev : stillPresent;
      });
    } catch (err) {
      console.error("Erro ao listar mods:", err);
      pushDiagnostic({ level: "warning", source: "Servidor", title: "Não foi possível listar os mods", message: String(err) });
    } finally {
      setLoadingMods(false);
    }
  }, [serverDir, modsCapable, itemsFolder]);

  const loadBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const list = await invoke<BackupInfo[]>("list_world_backups", { serverDir });
      setBackups(list);
    } catch (err) {
      console.error("Erro ao listar backups:", err);
      pushDiagnostic({ level: "warning", source: "Servidor", title: "Não foi possível listar os backups", message: String(err) });
    } finally {
      setLoadingBackups(false);
    }
  }, [serverDir]);

  // Nota: HostView monta este componente com `key={serverDir}`, então trocar de
  // servidor remonta o componente e reinicia todo o estado local automaticamente.
  useEffect(() => {
    (async () => {
      await loadMods();
      await loadBackups();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleMod = async (mod: ModInfo) => {
    try {
      await invoke("toggle_mod", { serverDir, fileName: mod.file_name, folderName: itemsFolder });
      await loadMods();
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: "Servidor", title: `Erro ao alternar o ${isPluginBased ? "plugin" : "mod"}`, message: String(err) });
    }
  };

  const toggleModSelection = (fileName: string) => {
    setSelectedMods((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  };

  const allModsSelected = mods.length > 0 && selectedMods.size === mods.length;

  const toggleSelectAllMods = () => {
    setSelectedMods(allModsSelected ? new Set() : new Set(mods.map((m) => m.file_name)));
  };

  const handleOpenModsFolder = async () => {
    try {
      const modsPath = await join(serverDir, itemsFolder);
      await invoke("open_path_in_explorer", { path: modsPath });
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: "Sistema", title: `Erro ao abrir a pasta de ${itemsLabel.toLowerCase()}`, message: String(err) });
    }
  };

  const handleBackupNow = async () => {
    try {
      setIsBackingUp(true);
      setError(null);
      await invoke("backup_world", { serverDir });
      await loadBackups();
    } catch (err) {
      console.error(err);
      setError(String(err));
      pushDiagnostic({ level: "error", source: "Servidor", title: "Falha ao criar backup do mundo", message: String(err) });
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleConfirmAction = async () => {
    if (!pendingAction) return;
    try {
      if (pendingAction.kind === "delete-mod") {
        await invoke("delete_mod", { serverDir, fileName: pendingAction.fileName, folderName: itemsFolder });
        await loadMods();
      } else if (pendingAction.kind === "delete-mods-bulk") {
        for (const fileName of pendingAction.fileNames) {
          await invoke("delete_mod", { serverDir, fileName, folderName: itemsFolder });
        }
        setSelectedMods(new Set());
        await loadMods();
      } else if (pendingAction.kind === "delete-backup") {
        await invoke("delete_world_backup", { serverDir, fileName: pendingAction.fileName });
        await loadBackups();
      } else if (pendingAction.kind === "restore-backup") {
        await invoke("restore_world_backup", { serverDir, fileName: pendingAction.fileName });
      } else if (pendingAction.kind === "reset-world") {
        await invoke("reset_world", { serverDir });
      }
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: "Servidor", title: "Erro ao executar a ação", message: String(err) });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="bg-theme-card p-8 rounded-[2rem] border-theme-card shadow-theme-card space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full">
            Gerenciamento
          </span>
          <h2 className="text-2xl font-bold text-theme-primary mt-2">{itemsLabel} &amp; Mundo</h2>
        </div>

        <div className="flex items-center gap-2 bg-theme-muted p-1 rounded-2xl border border-theme-card">
          {modsCapable && (
            <button
              type="button"
              onClick={() => setActiveTab("mods")}
              className={cn(
                "px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 transition-all cursor-pointer",
                activeTab === "mods" ? "bg-theme-card text-indigo-600 shadow-theme-shadow" : "text-theme-secondary hover:text-theme-primary"
              )}
            >
              <Blocks className="w-3.5 h-3.5" /> {itemsLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => setActiveTab("mundo")}
            className={cn(
              "px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 transition-all cursor-pointer",
              activeTab === "mundo" ? "bg-theme-card text-indigo-600 shadow-theme-shadow" : "text-theme-secondary hover:text-theme-primary"
            )}
          >
            <Globe2 className="w-3.5 h-3.5" /> Mundo
          </button>
        </div>
      </div>

      {activeTab === "mods" && modsCapable && (
        <div className="space-y-4">
          {serverStatus === "online" && (
            <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              Alterações em {itemsLabel.toLowerCase()} só têm efeito após reiniciar o servidor.
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            {selectedMods.size > 0 && (
              <>
                <button
                  type="button"
                  onClick={toggleSelectAllMods}
                  title={allModsSelected ? "Desmarcar todos" : "Selecionar todos"}
                  className="h-9 w-9 flex items-center justify-center bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-indigo-600 transition-colors cursor-pointer"
                >
                  {allModsSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAction({ kind: "delete-mods-bulk", fileNames: Array.from(selectedMods) })}
                  title={`Excluir ${itemsLabel.toLowerCase()} selecionados`}
                  className="h-9 w-9 flex items-center justify-center bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 border border-theme-card rounded-xl text-rose-500 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setShowModBrowser(true)}
              disabled={!modBrowserAvailable}
              title={modBrowserAvailable ? undefined : "Versão do Minecraft deste servidor não foi detectada — não é possível buscar itens compatíveis."}
              className="h-9 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <PackagePlus className="w-3.5 h-3.5" /> Buscar {itemsLabel} Online
            </button>
            <button
              type="button"
              onClick={handleOpenModsFolder}
              className="h-9 px-4 bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-xs font-bold text-theme-secondary hover:text-indigo-600 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5" /> Abrir Pasta de {itemsLabel}
            </button>
            <button
              type="button"
              onClick={loadMods}
              disabled={loadingMods}
              className="h-9 w-9 flex items-center justify-center bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-theme-secondary hover:text-indigo-600 transition-colors cursor-pointer disabled:opacity-50"
              title="Atualizar lista"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loadingMods && "animate-spin")} />
            </button>
          </div>

          {mods.length === 0 ? (
            <div className="text-center py-10 text-theme-secondary text-sm">
              {loadingMods ? (
                <Loader2 className="w-5 h-5 animate-spin mx-auto" />
              ) : (
                <>Nenhum {isPluginBased ? "plugin" : "mod"} instalado. Adicione arquivos .jar na pasta de {itemsFolder} do servidor.</>
              )}
            </div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
              {mods.map((mod) => (
                <div
                  key={mod.file_name}
                  className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-2xl px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <input
                      type="checkbox"
                      checked={selectedMods.has(mod.file_name)}
                      onChange={() => toggleModSelection(mod.file_name)}
                      className="w-4 h-4 rounded accent-indigo-600 cursor-pointer flex-shrink-0"
                      title="Selecionar mod"
                    />
                    <div className="min-w-0">
                      <p className={cn("text-sm font-semibold truncate", mod.enabled ? "text-theme-primary" : "text-theme-secondary line-through")}>
                        {mod.display_name}
                      </p>
                      <p className="text-[11px] text-theme-secondary">{formatSize(mod.size_bytes)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={mod.enabled}
                      onClick={() => handleToggleMod(mod)}
                      title={mod.enabled ? `Desabilitar ${isPluginBased ? "plugin" : "mod"}` : `Habilitar ${isPluginBased ? "plugin" : "mod"}`}
                      className={cn(
                        "relative h-6 w-11 rounded-full transition-colors cursor-pointer flex-shrink-0",
                        mod.enabled ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 left-0.5 h-5 w-5 bg-white rounded-full shadow transition-transform",
                          mod.enabled ? "translate-x-5" : "translate-x-0"
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingAction({ kind: "delete-mod", fileName: mod.file_name, displayName: mod.display_name })}
                      title={`Excluir ${isPluginBased ? "plugin" : "mod"}`}
                      className="h-8 w-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "mundo" && (
        <div className="space-y-4">
          {!isServerStopped && (
            <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              Pare o servidor para gerenciar backups do mundo.
            </div>
          )}
          {error && (
            <div className="p-3 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleBackupNow}
              disabled={!isServerStopped || isBackingUp}
              className="h-10 px-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition-all active:scale-95 disabled:opacity-40 cursor-pointer shadow-md shadow-theme-shadow"
            >
              {isBackingUp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {isBackingUp ? "Gerando backup..." : "Fazer Backup Agora"}
            </button>
            <button
              type="button"
              onClick={() => setPendingAction({ kind: "reset-world" })}
              disabled={!isServerStopped}
              className="h-10 px-5 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-300 rounded-xl text-xs font-bold flex items-center gap-2 transition-all active:scale-95 disabled:opacity-40 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Resetar Mundo
            </button>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold text-theme-secondary uppercase tracking-wide flex items-center gap-1.5">
                <Archive className="w-3.5 h-3.5" /> Backups
              </h3>
              <button
                type="button"
                onClick={loadBackups}
                disabled={loadingBackups}
                className="h-7 w-7 flex items-center justify-center rounded-lg text-theme-secondary hover:text-indigo-600 hover:bg-theme-muted transition-colors cursor-pointer disabled:opacity-50"
                title="Atualizar lista"
              >
                <RefreshCw className={cn("w-3.5 h-3.5", loadingBackups && "animate-spin")} />
              </button>
            </div>

            {backups.length === 0 ? (
              <div className="text-center py-8 text-theme-secondary text-sm">
                {loadingBackups ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : <>Nenhum backup gerado ainda.</>}
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1 custom-scrollbar">
                {backups.map((backup) => (
                  <div
                    key={backup.file_name}
                    className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-2xl px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-theme-primary truncate">{backup.file_name}</p>
                      <p className="text-[11px] text-theme-secondary">
                        {formatDate(backup.created_at)} • {formatSize(backup.size_bytes)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setPendingAction({ kind: "restore-backup", fileName: backup.file_name })}
                        disabled={!isServerStopped}
                        title="Restaurar backup"
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors cursor-pointer disabled:opacity-40"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingAction({ kind: "delete-backup", fileName: backup.file_name })}
                        title="Excluir backup"
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmActionModal
        isOpen={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        onConfirm={handleConfirmAction}
        title={
          pendingAction?.kind === "delete-mod" || pendingAction?.kind === "delete-mods-bulk"
            ? `Excluir ${isPluginBased ? "Plugin(s)" : "Mod(s)"}`
            : pendingAction?.kind === "delete-backup"
            ? "Excluir Backup"
            : pendingAction?.kind === "restore-backup"
            ? "Restaurar Backup"
            : "Resetar Mundo"
        }
        confirmLabel={
          pendingAction?.kind === "delete-mod" || pendingAction?.kind === "delete-mods-bulk" || pendingAction?.kind === "delete-backup"
            ? "Excluir"
            : pendingAction?.kind === "restore-backup"
            ? "Restaurar"
            : "Resetar"
        }
        requireTypedConfirmation={
          pendingAction?.kind === "restore-backup" ? "RESTAURAR" : pendingAction?.kind === "reset-world" ? "RESETAR" : undefined
        }
        message={
          pendingAction?.kind === "delete-mod" ? (
            <>Tem certeza que deseja excluir o {isPluginBased ? "plugin" : "mod"} <strong className="text-theme-primary">{`"${pendingAction.displayName}"`}</strong>?</>
          ) : pendingAction?.kind === "delete-mods-bulk" ? (
            <>Tem certeza que deseja excluir <strong className="text-theme-primary">{pendingAction.fileNames.length} {isPluginBased ? "plugin(s)" : "mod(s)"}</strong> selecionado(s)?</>
          ) : pendingAction?.kind === "delete-backup" ? (
            <>Tem certeza que deseja excluir o backup <strong className="text-theme-primary">{`"${pendingAction.fileName}"`}</strong>? Esta ação não pode ser desfeita.</>
          ) : pendingAction?.kind === "restore-backup" ? (
            <>Isso vai <strong className="text-theme-primary">substituir o mundo atual</strong> pelo conteúdo do backup selecionado. O progresso atual do mundo será perdido. Esta ação não pode ser desfeita.</>
          ) : (
            <>Isso vai <strong className="text-theme-primary">apagar o mundo atual</strong> permanentemente. O Minecraft vai gerar um mundo novo na próxima vez que o servidor iniciar. Esta ação não pode ser desfeita.</>
          )
        }
      />

      {modBrowserAvailable && mcVersion && (
        <ModBrowserModal
          isOpen={showModBrowser}
          onClose={() => setShowModBrowser(false)}
          serverDir={serverDir}
          serverType={serverType}
          mcVersion={mcVersion}
          onInstalled={loadMods}
        />
      )}
    </div>
  );
}
