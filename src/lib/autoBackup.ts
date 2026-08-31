// ============================================================
// Backup automático do mundo (baseado em regras, sem IA)
// ============================================================
// Orquestra os comandos Tauri de backup que já existem
// (backup_world/list_world_backups/delete_world_backup — ver
// src-tauri/src/lib.rs) em cima de três gatilhos: parada normal do
// servidor, crash, e um "backup de segurança" periódico para sessões
// longas que nunca são paradas manualmente.
//
// Pula o backup quando o mundo não mudou desde o último (comparando o
// timestamp do comando `world_last_modified`), exceto em crash — aí sempre
// tenta, já que é o momento mais importante de ter uma cópia recente.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { pushDiagnostic } from "@/app/diagnostics";

interface BackupInfo {
  file_name: string;
  size_bytes: number;
  created_at: string;
}

export type AutoBackupReason = "stop" | "crash" | "safety-net";

export interface AutoBackupOptions {
  enabled: boolean;
  retentionCount: number;
}

// Intervalo do "backup de segurança" para sessões longas que nunca são
// paradas manualmente — constante fixa por ora, não exposta na UI.
export const SAFETY_NET_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

const REASON_LABELS: Record<AutoBackupReason, string> = {
  stop: "servidor parado",
  crash: "crash do servidor",
  "safety-net": "sessão longa em andamento",
};

// Último `world_last_modified` que já gerou um backup, por servidor — em
// memória, só dura a sessão do app (reiniciar o app no máximo gera um
// backup a mais, nunca um a menos).
const lastBackedUpMtime = new Map<string, string>();
// Evita rodar dois backups do mesmo servidor ao mesmo tempo se dois
// gatilhos disparam quase juntos (ex: crash bem na hora do safety-net).
const inFlight = new Set<string>();

/**
 * Gera um backup automático do mundo em `serverDir`, se fizer sentido:
 * respeita `options.enabled`, pula se nada mudou desde o último backup
 * (exceto em crash), e poda backups antigos além de `options.retentionCount`
 * depois de um backup bem-sucedido.
 */
export async function maybeBackupWorld(
  serverDir: string,
  reason: AutoBackupReason,
  options: AutoBackupOptions,
): Promise<void> {
  if (!options.enabled || !serverDir) return;
  if (inFlight.has(serverDir)) return;

  inFlight.add(serverDir);
  try {
    const currentMtime = await invoke<string | null>("world_last_modified", { serverDir }).catch(() => null);
    if (!currentMtime) return; // mundo ainda não existe (servidor nunca chegou a rodar) — nada pra fazer backup

    if (reason !== "crash" && lastBackedUpMtime.get(serverDir) === currentMtime) {
      return; // nada mudou desde o último backup — não gera zip à toa
    }

    try {
      await invoke("backup_world", { serverDir });
      lastBackedUpMtime.set(serverDir, currentMtime);
      pushDiagnostic({
        level: "info",
        source: "Backup",
        title: "Backup automático criado",
        message: `Backup do mundo gerado (${REASON_LABELS[reason]}).`,
      });
    } catch (err) {
      // Best-effort: em crash o mundo pode estar num estado ruim pra zipar,
      // não é um erro que mereça alarmar o usuário como "error".
      pushDiagnostic({
        level: "warning",
        source: "Backup",
        title: "Não foi possível criar o backup automático",
        message: String(err),
      });
      return;
    }

    await pruneOldBackups(serverDir, options.retentionCount);
  } finally {
    inFlight.delete(serverDir);
  }
}

/**
 * Apaga os backups mais antigos além de `retentionCount`. A retenção conta
 * TODOS os backups da pasta, inclusive os manuais (o botão "Backup agora"
 * usa o mesmo `backup_world`) — os arquivos não carregam metadado de origem.
 */
async function pruneOldBackups(serverDir: string, retentionCount: number): Promise<void> {
  if (retentionCount <= 0) return; // <=0 desativa a poda, não apaga tudo
  try {
    const backups = await invoke<BackupInfo[]>("list_world_backups", { serverDir });
    const surplus = backups.slice(retentionCount); // já vem ordenado do mais novo pro mais antigo
    for (const backup of surplus) {
      await invoke("delete_world_backup", { serverDir, fileName: backup.file_name }).catch(() => {});
    }
  } catch {
    // Poda é best-effort — não deve quebrar o fluxo de backup em si.
  }
}
