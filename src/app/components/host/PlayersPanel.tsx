"use client";

import { useCallback, useEffect, useState } from "react";
import { Users, ShieldCheck, Ban, Plus, Trash2, RefreshCw, Loader2, AlertTriangle, Undo2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { pushDiagnostic } from "@/app/diagnostics";
import type { ServerStatus } from "@/app/store";
import { ConfirmActionModal } from "./ConfirmActionModal";

// ============================================================
// PlayersPanel
// ============================================================
// Painel inline com abas para gerenciar whitelist, operadores e
// banimentos (jogadores + IPs) do servidor selecionado, sem precisar
// editar whitelist.json/ops.json/banned-*.json na mão.
//
// Com o servidor parado, os comandos de backend editam esses arquivos
// diretamente. Com o servidor online, as mesmas ações são enviadas como
// comandos de console (whitelist/op/ban/pardon) em vez de mexer no
// arquivo: o processo do Minecraft mantém essas listas em memória e
// sobrescreveria qualquer edição direta feita enquanto está rodando.
// ============================================================

interface WhitelistEntry {
  uuid: string;
  name: string;
}

interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

interface BannedPlayerEntry {
  uuid: string;
  name: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

interface BannedIpEntry {
  ip: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

interface PlayersPanelProps {
  serverDir: string;
  serverStatus: ServerStatus;
  onSendCommand: (command: string) => Promise<void>;
}

type Tab = "whitelist" | "ops" | "banidos";

type PendingAction =
  | { kind: "remove-whitelist"; entry: WhitelistEntry }
  | { kind: "remove-op"; entry: OpEntry }
  | { kind: "pardon-player"; entry: BannedPlayerEntry }
  | { kind: "pardon-ip"; entry: BannedIpEntry };

function shortUuid(uuid: string): string {
  return uuid.length > 8 ? `${uuid.slice(0, 8)}…` : uuid;
}

export function PlayersPanel({ serverDir, serverStatus, onSendCommand }: PlayersPanelProps) {
  const isOnline = serverStatus === "online";

  const [activeTab, setActiveTab] = useState<Tab>("whitelist");

  const [whitelist, setWhitelist] = useState<WhitelistEntry[]>([]);
  const [ops, setOps] = useState<OpEntry[]>([]);
  const [bannedPlayers, setBannedPlayers] = useState<BannedPlayerEntry[]>([]);
  const [bannedIps, setBannedIps] = useState<BannedIpEntry[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [whitelistInput, setWhitelistInput] = useState("");
  const [opInput, setOpInput] = useState("");
  const [banInput, setBanInput] = useState("");
  const [banReasonInput, setBanReasonInput] = useState("");
  const [ipBanInput, setIpBanInput] = useState("");
  const [ipBanReasonInput, setIpBanReasonInput] = useState("");

  // Mensagens de erro de submissão somem sozinhas depois de um tempo.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [wl, opList, bp, bi] = await Promise.all([
        invoke<WhitelistEntry[]>("list_whitelist", { serverDir }),
        invoke<OpEntry[]>("list_ops", { serverDir }),
        invoke<BannedPlayerEntry[]>("list_banned_players", { serverDir }),
        invoke<BannedIpEntry[]>("list_banned_ips", { serverDir }),
      ]);
      setWhitelist(wl);
      setOps(opList);
      setBannedPlayers(bp);
      setBannedIps(bi);
    } catch (err) {
      console.error("Erro ao listar jogadores:", err);
      pushDiagnostic({ level: "warning", source: "Servidor", title: "Não foi possível listar whitelist/ops/banidos", message: String(err) });
    } finally {
      setLoading(false);
    }
  }, [serverDir]);

  // Nota: HostView monta este componente com `key={serverDir}`, então trocar de
  // servidor remonta o componente e reinicia todo o estado local automaticamente.
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Com o servidor online, o comando de console só termina de atualizar o
  // arquivo depois de processado pelo servidor — um pequeno atraso antes de
  // recarregar evita ler o arquivo um instante antes dessa atualização.
  const reloadAfterAction = async () => {
    if (isOnline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await loadAll();
  };

  const handleAddWhitelist = async () => {
    const name = whitelistInput.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isOnline) {
        await onSendCommand(`whitelist add ${name}`);
      } else {
        await invoke("add_whitelist_player", { serverDir, name });
      }
      setWhitelistInput("");
      await reloadAfterAction();
    } catch (err) {
      setError(String(err));
      pushDiagnostic({ level: "error", source: "Servidor", title: "Erro ao adicionar à whitelist", message: String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddOp = async () => {
    const name = opInput.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isOnline) {
        await onSendCommand(`op ${name}`);
      } else {
        await invoke("add_op", { serverDir, name });
      }
      setOpInput("");
      await reloadAfterAction();
    } catch (err) {
      setError(String(err));
      pushDiagnostic({ level: "error", source: "Servidor", title: "Erro ao tornar operador", message: String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleBanPlayer = async () => {
    const name = banInput.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const reason = banReasonInput.trim();
      if (isOnline) {
        await onSendCommand(reason ? `ban ${name} ${reason}` : `ban ${name}`);
      } else {
        await invoke("ban_player", { serverDir, name, reason: reason || null });
      }
      setBanInput("");
      setBanReasonInput("");
      await reloadAfterAction();
    } catch (err) {
      setError(String(err));
      pushDiagnostic({ level: "error", source: "Servidor", title: "Erro ao banir jogador", message: String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleBanIp = async () => {
    const ip = ipBanInput.trim();
    if (!ip || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const reason = ipBanReasonInput.trim();
      if (isOnline) {
        await onSendCommand(reason ? `ban-ip ${ip} ${reason}` : `ban-ip ${ip}`);
      } else {
        await invoke("ban_ip", { serverDir, ip, reason: reason || null });
      }
      setIpBanInput("");
      setIpBanReasonInput("");
      await reloadAfterAction();
    } catch (err) {
      setError(String(err));
      pushDiagnostic({ level: "error", source: "Servidor", title: "Erro ao banir IP", message: String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmAction = async () => {
    if (!pendingAction) return;
    try {
      if (pendingAction.kind === "remove-whitelist") {
        if (isOnline) {
          await onSendCommand(`whitelist remove ${pendingAction.entry.name}`);
        } else {
          await invoke("remove_whitelist_player", { serverDir, uuid: pendingAction.entry.uuid });
        }
      } else if (pendingAction.kind === "remove-op") {
        if (isOnline) {
          await onSendCommand(`deop ${pendingAction.entry.name}`);
        } else {
          await invoke("remove_op", { serverDir, uuid: pendingAction.entry.uuid });
        }
      } else if (pendingAction.kind === "pardon-player") {
        if (isOnline) {
          await onSendCommand(`pardon ${pendingAction.entry.name}`);
        } else {
          await invoke("pardon_player", { serverDir, uuid: pendingAction.entry.uuid });
        }
      } else if (pendingAction.kind === "pardon-ip") {
        if (isOnline) {
          await onSendCommand(`pardon-ip ${pendingAction.entry.ip}`);
        } else {
          await invoke("pardon_ip", { serverDir, ip: pendingAction.entry.ip });
        }
      }
      await reloadAfterAction();
    } catch (err) {
      console.error(err);
      pushDiagnostic({ level: "error", source: "Servidor", title: "Erro ao executar a ação", message: String(err) });
    } finally {
      setPendingAction(null);
    }
  };

  const tabs: { id: Tab; label: string; icon: typeof Users }[] = [
    { id: "whitelist", label: "Whitelist", icon: Users },
    { id: "ops", label: "Operadores", icon: ShieldCheck },
    { id: "banidos", label: "Banidos", icon: Ban },
  ];

  return (
    <div className="bg-theme-card p-8 rounded-[2rem] border-theme-card shadow-theme-card space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full">
            Gerenciamento
          </span>
          <h2 className="text-2xl font-bold text-theme-primary mt-2">Jogadores</h2>
        </div>

        <div className="flex items-center gap-2 bg-theme-muted p-1 rounded-2xl border border-theme-card">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={cn(
                "px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 transition-all cursor-pointer",
                activeTab === id ? "bg-theme-card text-indigo-600 shadow-theme-shadow" : "text-theme-secondary hover:text-theme-primary"
              )}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      {isOnline && (
        <div className="p-3 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl flex items-center gap-2.5 text-xs">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          Servidor online: as ações abaixo são enviadas como comando pelo console e têm efeito imediato.
        </div>
      )}

      {error && (
        <div className="p-3 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={loadAll}
          disabled={loading}
          className="h-9 w-9 flex items-center justify-center bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-theme-secondary hover:text-indigo-600 transition-colors cursor-pointer disabled:opacity-50"
          title="Atualizar listas"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {activeTab === "whitelist" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={whitelistInput}
              onChange={(e) => setWhitelistInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddWhitelist()}
              placeholder="Nome do jogador"
              className="flex-1 h-10 px-4 border border-theme-card rounded-xl bg-transparent text-sm text-theme-primary focus:border-indigo-500 focus:outline-none transition-all"
            />
            <button
              type="button"
              onClick={handleAddWhitelist}
              disabled={!whitelistInput.trim() || submitting}
              className="h-10 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Adicionar
            </button>
          </div>

          {loading && whitelist.length === 0 ? (
            <div className="text-center py-10">
              <Loader2 className="w-5 h-5 animate-spin mx-auto text-theme-secondary" />
            </div>
          ) : whitelist.length === 0 ? (
            <div className="text-center py-10 text-theme-secondary text-sm">Nenhum jogador na whitelist.</div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
              {whitelist.map((entry) => (
                <div key={entry.uuid} className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-2xl px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-theme-primary truncate">{entry.name}</p>
                    <p className="text-[11px] text-theme-secondary font-mono">{shortUuid(entry.uuid)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingAction({ kind: "remove-whitelist", entry })}
                    title="Remover da whitelist"
                    className="h-8 w-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors cursor-pointer flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "ops" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={opInput}
              onChange={(e) => setOpInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddOp()}
              placeholder="Nome do jogador"
              className="flex-1 h-10 px-4 border border-theme-card rounded-xl bg-transparent text-sm text-theme-primary focus:border-indigo-500 focus:outline-none transition-all"
            />
            <button
              type="button"
              onClick={handleAddOp}
              disabled={!opInput.trim() || submitting}
              className="h-10 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Tornar Operador
            </button>
          </div>

          {loading && ops.length === 0 ? (
            <div className="text-center py-10">
              <Loader2 className="w-5 h-5 animate-spin mx-auto text-theme-secondary" />
            </div>
          ) : ops.length === 0 ? (
            <div className="text-center py-10 text-theme-secondary text-sm">Nenhum operador definido.</div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
              {ops.map((entry) => (
                <div key={entry.uuid} className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-2xl px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-theme-primary truncate">{entry.name}</p>
                    <p className="text-[11px] text-theme-secondary font-mono">{shortUuid(entry.uuid)} • nível {entry.level}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingAction({ kind: "remove-op", entry })}
                    title="Remover operador"
                    className="h-8 w-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors cursor-pointer flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "banidos" && (
        <div className="space-y-8">
          <div className="space-y-4">
            <h3 className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Jogadores banidos</h3>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={banInput}
                onChange={(e) => setBanInput(e.target.value)}
                placeholder="Nome do jogador"
                className="flex-1 min-w-[10rem] h-10 px-4 border border-theme-card rounded-xl bg-transparent text-sm text-theme-primary focus:border-indigo-500 focus:outline-none transition-all"
              />
              <input
                type="text"
                value={banReasonInput}
                onChange={(e) => setBanReasonInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleBanPlayer()}
                placeholder="Motivo (opcional)"
                className="flex-1 min-w-[10rem] h-10 px-4 border border-theme-card rounded-xl bg-transparent text-sm text-theme-primary focus:border-indigo-500 focus:outline-none transition-all"
              />
              <button
                type="button"
                onClick={handleBanPlayer}
                disabled={!banInput.trim() || submitting}
                className="h-10 px-4 bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />} Banir
              </button>
            </div>

            {loading && bannedPlayers.length === 0 ? (
              <div className="text-center py-6">
                <Loader2 className="w-5 h-5 animate-spin mx-auto text-theme-secondary" />
              </div>
            ) : bannedPlayers.length === 0 ? (
              <div className="text-center py-6 text-theme-secondary text-sm">Nenhum jogador banido.</div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
                {bannedPlayers.map((entry) => (
                  <div key={entry.uuid} className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-2xl px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-theme-primary truncate">{entry.name}</p>
                      <p className="text-[11px] text-theme-secondary truncate">{entry.reason}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingAction({ kind: "pardon-player", entry })}
                      title="Remover banimento"
                      className="h-8 w-8 flex items-center justify-center rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors cursor-pointer flex-shrink-0"
                    >
                      <Undo2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-4 pt-2 border-t border-theme-card">
            <h3 className="text-xs font-bold text-theme-secondary uppercase tracking-wide">IPs banidos</h3>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={ipBanInput}
                onChange={(e) => setIpBanInput(e.target.value)}
                placeholder="Endereço IP"
                className="flex-1 min-w-[10rem] h-10 px-4 border border-theme-card rounded-xl bg-transparent text-sm text-theme-primary focus:border-indigo-500 focus:outline-none transition-all"
              />
              <input
                type="text"
                value={ipBanReasonInput}
                onChange={(e) => setIpBanReasonInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleBanIp()}
                placeholder="Motivo (opcional)"
                className="flex-1 min-w-[10rem] h-10 px-4 border border-theme-card rounded-xl bg-transparent text-sm text-theme-primary focus:border-indigo-500 focus:outline-none transition-all"
              />
              <button
                type="button"
                onClick={handleBanIp}
                disabled={!ipBanInput.trim() || submitting}
                className="h-10 px-4 bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />} Banir IP
              </button>
            </div>

            {bannedIps.length === 0 ? (
              <div className="text-center py-6 text-theme-secondary text-sm">Nenhum IP banido.</div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
                {bannedIps.map((entry) => (
                  <div key={entry.ip} className="flex items-center justify-between gap-3 bg-theme-muted border border-theme-card rounded-2xl px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-theme-primary truncate font-mono">{entry.ip}</p>
                      <p className="text-[11px] text-theme-secondary truncate">{entry.reason}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingAction({ kind: "pardon-ip", entry })}
                      title="Remover banimento de IP"
                      className="h-8 w-8 flex items-center justify-center rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors cursor-pointer flex-shrink-0"
                    >
                      <Undo2 className="w-4 h-4" />
                    </button>
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
          pendingAction?.kind === "remove-whitelist"
            ? "Remover da Whitelist"
            : pendingAction?.kind === "remove-op"
            ? "Remover Operador"
            : pendingAction?.kind === "pardon-player"
            ? "Remover Banimento"
            : "Remover Banimento de IP"
        }
        confirmLabel={pendingAction?.kind === "remove-whitelist" || pendingAction?.kind === "remove-op" ? "Remover" : "Desbanir"}
        message={
          pendingAction?.kind === "remove-whitelist" ? (
            <>Tem certeza que deseja remover <strong className="text-theme-primary">{pendingAction.entry.name}</strong> da whitelist?</>
          ) : pendingAction?.kind === "remove-op" ? (
            <>Tem certeza que deseja remover os privilégios de operador de <strong className="text-theme-primary">{pendingAction.entry.name}</strong>?</>
          ) : pendingAction?.kind === "pardon-player" ? (
            <>Tem certeza que deseja remover o banimento de <strong className="text-theme-primary">{pendingAction.entry.name}</strong>?</>
          ) : pendingAction?.kind === "pardon-ip" ? (
            <>Tem certeza que deseja remover o banimento do IP <strong className="text-theme-primary">{pendingAction.entry.ip}</strong>?</>
          ) : null
        }
      />
    </div>
  );
}
