import { create } from 'zustand';

// ============================================================
// Central de Diagnósticos
// ============================================================
// Store global e efêmero (não persistido — assim como serverStatus em
// store.ts, não faz sentido reabrir o app "lembrando" de um erro antigo)
// para toasts e histórico de diagnósticos (erros, avisos e informações)
// vindos tanto do backend Rust/sidecar Go quanto da própria UI.
//
// Substitui o padrão anterior de `alert()` espalhado pelos componentes:
// agora toda falha vira uma entrada rastreável, com nível de severidade,
// fonte e timestamp, consultável depois no painel de histórico.
// ============================================================

export type DiagnosticLevel = 'info' | 'warning' | 'error' | 'critical';

export interface DiagnosticEntry {
  id: string;
  level: DiagnosticLevel;
  title: string;
  message: string;
  /** Detalhe técnico opcional (stack, código de erro, etc) — exibido colapsado no histórico. */
  detail?: string;
  /** Origem do diagnóstico, ex: "Rede", "Servidor", "Instalação". */
  source: string;
  timestamp: string; // ISO
  read: boolean;
}

export interface PushDiagnosticInput {
  level: DiagnosticLevel;
  title: string;
  message: string;
  detail?: string;
  source: string;
}

const MAX_HISTORY = 200;

// info/warning desaparecem sozinhos do stack de toasts; error/critical
// exigem dispensa manual do usuário (não devem passar despercebidos).
const AUTO_DISMISS_MS: Record<DiagnosticLevel, number | null> = {
  info: 5000,
  warning: 8000,
  error: null,
  critical: null,
};

let counter = 0;
function nextId(): string {
  counter += 1;
  return `diag-${Date.now()}-${counter}`;
}

interface DiagnosticsState {
  entries: DiagnosticEntry[];
  toastIds: string[];
  unreadCount: number;
  push: (input: PushDiagnosticInput) => string;
  dismissToast: (id: string) => void;
  markAllRead: () => void;
  clearHistory: () => void;
}

export const useDiagnosticsStore = create<DiagnosticsState>((set, get) => ({
  entries: [],
  toastIds: [],
  unreadCount: 0,

  push: (input) => {
    const id = nextId();
    const entry: DiagnosticEntry = {
      id,
      level: input.level,
      title: input.title,
      message: input.message,
      detail: input.detail,
      source: input.source,
      timestamp: new Date().toISOString(),
      read: false,
    };

    set((state) => ({
      entries: [entry, ...state.entries].slice(0, MAX_HISTORY),
      toastIds: [...state.toastIds, id],
      unreadCount: state.unreadCount + 1,
    }));

    const dismissAfter = AUTO_DISMISS_MS[input.level];
    if (dismissAfter !== null) {
      setTimeout(() => get().dismissToast(id), dismissAfter);
    }

    return id;
  },

  dismissToast: (id) => set((state) => ({
    toastIds: state.toastIds.filter((t) => t !== id),
  })),

  markAllRead: () => set((state) => ({
    entries: state.entries.map((e) => ({ ...e, read: true })),
    unreadCount: 0,
  })),

  clearHistory: () => set({ entries: [], unreadCount: 0 }),
}));

/**
 * Helper de conveniência para reportar um diagnóstico fora de um componente React
 * (handlers de evento, funções em lib/, etc) sem precisar do hook useDiagnosticsStore.
 */
export function pushDiagnostic(input: PushDiagnosticInput): string {
  return useDiagnosticsStore.getState().push(input);
}
