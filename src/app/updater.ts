import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { pushDiagnostic } from "@/app/diagnostics";

// ============================================================
// Auto-atualização
// ============================================================
// Checagem silenciosa contra o endpoint configurado em tauri.conf.json
// (plugins.updater.endpoints — hoje um latest.json publicado via GitHub
// Releases). Falha na checagem não deve incomodar o usuário (rede
// instável, offline, etc): fica só no histórico de diagnósticos, não
// como toast. Update disponível/erro de instalação já é relevante o
// bastante pra aparecer na UI (ver UpdateBanner).
// ============================================================

export type UpdaterPhase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

interface UpdaterState {
  phase: UpdaterPhase;
  version: string | null;
  notes: string | null;
  progress: number;
  dismissed: boolean;
  update: Update | null;
  checkForUpdates: () => Promise<void>;
  installAndRestart: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  phase: "idle",
  version: null,
  notes: null,
  progress: 0,
  dismissed: false,
  update: null,

  checkForUpdates: async () => {
    if (get().phase === "checking" || get().phase === "downloading") return;
    set({ phase: "checking" });
    try {
      const update = await check();
      if (update) {
        set({ phase: "available", version: update.version, notes: update.body ?? null, update, dismissed: false });
      } else {
        set({ phase: "idle" });
      }
    } catch (e) {
      set({ phase: "idle" });
      pushDiagnostic({
        level: "info",
        title: "Verificação de atualização falhou",
        message: "Não foi possível checar por novas versões agora.",
        detail: String(e),
        source: "Atualização",
      });
    }
  },

  installAndRestart: async () => {
    const { update } = get();
    if (!update) return;
    set({ phase: "downloading", progress: 0 });
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          set({ progress: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0 });
        } else if (event.event === "Finished") {
          set({ progress: 100 });
        }
      });
      set({ phase: "ready" });
      await relaunch();
    } catch (e) {
      set({ phase: "error" });
      pushDiagnostic({
        level: "warning",
        title: "Falha ao instalar atualização",
        message: "Não foi possível baixar ou instalar a nova versão. Tente novamente mais tarde.",
        detail: String(e),
        source: "Atualização",
      });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
