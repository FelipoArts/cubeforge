import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ServerInfo } from '@/lib/server';

// Estado do ciclo de vida do servidor Minecraft
export type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed';

// Causa do último crash, já traduzida pelo analisador de regras
// (src/lib/crashAnalyzer.ts) ou pelo diagnóstico genérico do Rust —
// usada pela HostView para mostrar o motivo específico no banner de crash.
export interface CrashInfo {
  title: string;
  message: string;
  detail?: string;
}

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
  lastConfirmedAt: string | null; // ISO timestamp da última resposta bem-sucedida da API Central
  onlineSince: string | null; // ISO timestamp de quando o servidor ficou online nesta sessão (reseta quando cai)
  addedAt: string; // ISO timestamp
  isOwnServer: boolean; // true se for um servidor criado pelo próprio usuário
  networkProvider: string;
  // Versão exata do Forge/NeoForge (ex: "47.2.0") ou do loader Fabric/build do
  // Paper, espelhando ServerInfo.forgeVersion/modLoaderVersion em server.ts —
  // usado pelo fluxo "Jogar" pra instalar o client com a MESMA build do host
  // (Forge quebra compatibilidade entre builds, então "a mais recente" não serve).
  forgeVersion: string | null;
  modLoaderVersion: string | null;
}

interface AppSettings {
  // Configurações persistidas
  serverDir: string | null;
  hasInitialized: boolean;
  minecraftPort: number;
  selectedServer: string | null;

  // Backup automático do mundo (parada/crash/sessão longa — ver
  // src/lib/autoBackup.ts). Preferência do usuário, então persistida.
  autoBackupEnabled: boolean;
  backupRetentionCount: number;

  // Nome do servidor cujo processo Minecraft está atualmente rodando/iniciando
  // (pode divergir de selectedServer quando o usuário navega para outro servidor
  // enquanto o processo anterior continua ativo). Usado para atribuir corretamente
  // as linhas de log recebidas do backend ao servidor certo.
  runningServer: string | null;

  // Estado de runtime (não persistido)
  serverStatus: ServerStatus;

  // Causa do último crash (não persistido — assim como serverStatus, não faz
  // sentido reabrir o app "lembrando" de um crash antigo). Resetado sempre
  // que um novo start é disparado (ver setServerStatus).
  lastCrashInfo: CrashInfo | null;

  // Biblioteca de servidores conhecidos (persistida)
  knownServers: KnownServer[];

  // Servidores locais do host (runtime, não persistido separadamente)
  localServers: ServerInfo[];

  // Caminhos de servidores importados (persistido - são pastas fora do padrão)
  importedServerPaths: string[];

  // Logs persistidos (para sobreviver a Ctrl+R)
  logs: string[];
  // Console do Minecraft: cada servidor tem sua própria sessão de logs,
  // indexada pelo nome do servidor.
  mcLogsByServer: Record<string, string[]>;

  // Setters
  setServerDir: (dir: string) => void;
  setInitialized: (val: boolean) => void;
  setMinecraftPort: (port: number) => void;
  setAutoBackupEnabled: (enabled: boolean) => void;
  setBackupRetentionCount: (count: number) => void;
  setSelectedServer: (name: string | null) => void;
  setRunningServer: (name: string | null) => void;
  setServerStatus: (status: ServerStatus) => void;
  setLastCrashInfo: (info: CrashInfo | null) => void;
  setLocalServers: (servers: ServerInfo[]) => void;
  setKnownServers: (servers: KnownServer[]) => void;
  addKnownServer: (server: KnownServer) => void;
  removeKnownServer: (shortCode: string) => void;
  updateKnownServerStatus: (shortCode: string, status: ServerStatus, currentPlayers?: number) => void;
  addImportedServerPath: (path: string) => void;
  removeImportedServerPath: (path: string) => void;
  setLogs: (logs: any) => void;
  setMcLogs: (serverName: string, logs: string[] | ((prev: string[]) => string[])) => void;
}


export const useAppStore = create<AppSettings>()(
  persist(
    (set) => ({
      serverDir: null,
      hasInitialized: false,
      minecraftPort: 25565,
      autoBackupEnabled: true,
      backupRetentionCount: 10,
      selectedServer: null,
      runningServer: null,
      serverStatus: 'offline',
      lastCrashInfo: null,
      knownServers: [],
      localServers: [],
      importedServerPaths: [],
      logs: [],
      mcLogsByServer: {},

      setServerDir: (dir) => set({ serverDir: dir }),
      setInitialized: (val) => set({ hasInitialized: val }),
      setMinecraftPort: (port) => set({ minecraftPort: port }),
      setAutoBackupEnabled: (enabled) => set({ autoBackupEnabled: enabled }),
      setBackupRetentionCount: (count) => set({ backupRetentionCount: count }),
      setSelectedServer: (name) => set({ selectedServer: name }),
      setRunningServer: (name) => set({ runningServer: name }),
      setServerStatus: (status) => set((state) => ({
        serverStatus: status,
        // Um novo start torna o crash anterior irrelevante para o banner.
        lastCrashInfo: status === 'starting' ? null : state.lastCrashInfo,
      })),
      setLastCrashInfo: (info) => set({ lastCrashInfo: info }),
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
                // Marca o início da sessão "online" apenas na transição para online;
                // permanece parado enquanto o status continuar online (para servir de
                // base ao contador de tempo online) e reseta quando o servidor cai.
                onlineSince: status === 'online'
                  // Preserva o timestamp existente só se já havia um (evita resetar a
                  // contagem a cada poll); senão inicializa agora — cobre tanto a
                  // transição real para online quanto servidores persistidos antes
                  // deste campo existir (onlineSince ausente apesar de status "online").
                  ? (s.status === 'online' && s.onlineSince ? s.onlineSince : new Date().toISOString())
                  : null,
                // Só é chamado após uma resposta bem-sucedida da API: marca o momento
                // em que este status foi de fato confirmado (usado para detectar dados obsoletos).
                lastConfirmedAt: new Date().toISOString(),
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
      setMcLogs: (serverName, logs) => set((state) => {
        const prevLogs = state.mcLogsByServer[serverName] ?? [];
        const newLogs = typeof logs === 'function' ? logs(prevLogs) : logs;
        return { mcLogsByServer: { ...state.mcLogsByServer, [serverName]: newLogs.slice(-500) } };
      }),
    }),
    {
      name: 'cubeforge-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        serverDir: state.serverDir,
        hasInitialized: state.hasInitialized,
        minecraftPort: state.minecraftPort,
        autoBackupEnabled: state.autoBackupEnabled,
        backupRetentionCount: state.backupRetentionCount,
        selectedServer: state.selectedServer,
        runningServer: state.runningServer,
        knownServers: state.knownServers,
        importedServerPaths: state.importedServerPaths,
        logs: state.logs,
        mcLogsByServer: state.mcLogsByServer,
      }),
    }
  )
);

