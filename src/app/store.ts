import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ServerInfo } from '@/lib/server';

// Estado do ciclo de vida do servidor Minecraft
export type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed';

// Servidor conhecido na biblioteca do guest
export interface KnownServer {
  shortCode: string;
  name: string;
  version: string;
  serverType: string;
  description: string;
  status: ServerStatus;
  port: number;
  maxPlayers: number;
  currentPlayers: number;
  lastSeenOnline: string | null; // ISO timestamp
  addedAt: string; // ISO timestamp
  isOwnServer: boolean; // true se for um servidor criado pelo próprio usuário
  networkProvider: string;
}

interface AppSettings {
  // Configurações persistidas
  serverDir: string | null;
  hasInitialized: boolean;
  minecraftPort: number;
  selectedServer: string | null;

  // Estado de runtime (não persistido)
  serverStatus: ServerStatus;

  // Biblioteca de servidores conhecidos (persistida)
  knownServers: KnownServer[];

  // Servidores locais do host (runtime, não persistido separadamente)
  localServers: ServerInfo[];

  // Caminhos de servidores importados (persistido - são pastas fora do padrão)
  importedServerPaths: string[];

  // Logs persistidos (para sobreviver a Ctrl+R)
  logs: string[];
  mcLogs: string[];

  // Setters
  setServerDir: (dir: string) => void;
  setInitialized: (val: boolean) => void;
  setMinecraftPort: (port: number) => void;
  setSelectedServer: (name: string | null) => void;
  setServerStatus: (status: ServerStatus) => void;
  setLocalServers: (servers: ServerInfo[]) => void;
  setKnownServers: (servers: KnownServer[]) => void;
  addKnownServer: (server: KnownServer) => void;
  removeKnownServer: (shortCode: string) => void;
  updateKnownServerStatus: (shortCode: string, status: ServerStatus, currentPlayers?: number) => void;
  addImportedServerPath: (path: string) => void;
  removeImportedServerPath: (path: string) => void;
  setLogs: (logs: any) => void;
  setMcLogs: (logs: any) => void;
}


export const useAppStore = create<AppSettings>()(
  persist(
    (set) => ({
      serverDir: null,
      hasInitialized: false,
      minecraftPort: 25565,
      selectedServer: null,
      serverStatus: 'offline',
      knownServers: [],
      localServers: [],
      importedServerPaths: [],
      logs: [],
      mcLogs: [],

      setServerDir: (dir) => set({ serverDir: dir }),
      setInitialized: (val) => set({ hasInitialized: val }),
      setMinecraftPort: (port) => set({ minecraftPort: port }),
      setSelectedServer: (name) => set({ selectedServer: name }),
      setServerStatus: (status) => set({ serverStatus: status }),
      setLocalServers: (servers) => set({ localServers: servers }),
      setKnownServers: (servers) => set({ knownServers: servers }),
      addKnownServer: (server) => set((state) => {
        const exists = state.knownServers.find(s => s.shortCode === server.shortCode);
        if (exists) return state;
        return { knownServers: [...state.knownServers, server] };
      }),
      removeKnownServer: (shortCode) => set((state) => ({
        knownServers: state.knownServers.filter(s => s.shortCode !== shortCode),
      })),
      updateKnownServerStatus: (shortCode, status, currentPlayers) => set((state) => ({
        knownServers: state.knownServers.map(s =>
          s.shortCode === shortCode
            ? {
                ...s,
                status,
                currentPlayers: currentPlayers ?? s.currentPlayers,
                lastSeenOnline: status === 'online' ? new Date().toISOString() : s.lastSeenOnline,
              }
            : s
        ),
      })),
      addImportedServerPath: (path) => set((state) => {
        if (state.importedServerPaths.includes(path)) return state;
        return { importedServerPaths: [...state.importedServerPaths, path] };
      }),
      removeImportedServerPath: (path) => set((state) => ({
        importedServerPaths: state.importedServerPaths.filter(p => p !== path),
      })),
      setLogs: (logs) => set((state) => {
        const newLogs = typeof logs === 'function' ? logs(state.logs) : logs;
        return { logs: newLogs.slice(-150) };
      }),
      setMcLogs: (logs) => set((state) => {
        const newLogs = typeof logs === 'function' ? logs(state.mcLogs) : logs;
        return { mcLogs: newLogs.slice(-500) };
      }),
    }),
    {
      name: 'cubeforge-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        serverDir: state.serverDir,
        hasInitialized: state.hasInitialized,
        minecraftPort: state.minecraftPort,
        selectedServer: state.selectedServer,
        knownServers: state.knownServers,
        importedServerPaths: state.importedServerPaths,
        logs: state.logs,
        mcLogs: state.mcLogs,
      }),
    }
  )
);

