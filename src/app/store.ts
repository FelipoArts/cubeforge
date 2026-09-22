import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ServerInfo } from '@/lib/server';

// Estado do ciclo de vida do servidor Minecraft. 'sleeping' só se aplica a
// KnownServer.minecraftStatus (wake-on-demand armado, ver PlayersPanel/
// GuestView) — nunca é um valor real do processo local deste host.
export type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed' | 'sleeping';

// Causa do último crash, já traduzida pelo analisador de regras
// (src/lib/crashAnalyzer.ts) ou pelo diagnóstico genérico do Rust —
// usada pela HostView para mostrar o motivo específico no banner de crash.
export interface CrashInfo {
  title: string;
  message: string;
  detail?: string;
}

// Usuário autenticado via Supabase (ver src/lib/auth.ts) — só um espelho
// reativo para a UI. A sessão de verdade (tokens, refresh) fica no storage
// interno do supabase-js, que já persiste e renova sozinho; duplicar isso
// aqui só criaria uma segunda fonte de verdade. Por isso NÃO entra no
// `partialize` abaixo.
export interface AuthUser {
  id: string;
  email: string;
}

// Servidor conhecido na biblioteca do guest
export interface KnownServer {
  shortCode: string;
  name: string;
  version: string;
  serverType: string;
  description: string;
  // Status da rede mesh do host (Tailscale) — só diz se dá pra alcançar o host
  // pelo túnel do CubeForge, não se o Minecraft em si está de pé (ver minecraftStatus).
  status: ServerStatus;
  // Status do processo Java do Minecraft no host, reportado independente da rede
  // mesh (ver report_mc_status em lib.rs) — null quando a API Central nunca recebeu
  // nenhum heartbeat dele (host nunca iniciou o servidor, ou registro expirou).
  minecraftStatus: ServerStatus | null;
  port: number;
  // Endereço de conexão personalizado (Cubicase Plus) — null se o host nunca
  // configurou um, e aí o endereço exibido cai pro padrão grátis derivado do
  // shortCode (ver defaultConnectNameFor em src/lib/connectAddress.ts).
  connectName: string | null;
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

  // Aba atualmente selecionada (Host/Convidado). Persistida para não voltar
  // sempre para "host" a cada F5 — sem isso, dar refresh enquanto na aba
  // Convidado te jogava de volta para a aba Host no meio de um teste.
  mode: "host" | "guest";

  // Escolha feita na tela de boas-vindas (primeiro uso): qual aba deve abrir
  // sempre que o app é iniciado. null enquanto o onboarding nunca rodou —
  // é esse null que faz a OnboardingScreen aparecer (ver page.tsx). Editável
  // depois em Configurações → Início. Diferente de `mode` acima: `mode` é a
  // aba visível AGORA (muda ao clicar Host/Convidado no cabeçalho); esta aqui
  // é só a preferência de qual aba `mode` deve assumir a cada boot do app.
  defaultTab: "host" | "guest" | null;

  // Backup automático do mundo (parada/crash/sessão longa — ver
  // src/lib/autoBackup.ts). Preferência do usuário, então persistida.
  autoBackupEnabled: boolean;
  backupRetentionCount: number;
  // Intervalo (em horas) do backup de segurança para sessões longas que
  // nunca são paradas manualmente — ver uso em page.tsx.
  backupSafetyNetIntervalHours: number;

  // Nome do servidor cujo processo Minecraft está atualmente rodando/iniciando
  // (pode divergir de selectedServer quando o usuário navega para outro servidor
  // enquanto o processo anterior continua ativo). Usado para atribuir corretamente
  // as linhas de log recebidas do backend ao servidor certo.
  runningServer: string | null;

  // Estado de runtime (não persistido)
  serverStatus: ServerStatus;

  // Jogadores conectados no servidor Minecraft rodando neste momento (runtime,
  // não persistido). Não há RCON/consulta de estado disponível, então essa
  // lista é derivada das mensagens padrão do servidor vanilla ("X joined/left
  // the game") — ver o listener de "minecraft-log" em page.tsx. Zerada sempre
  // que o servidor sai do estado "online".
  onlinePlayers: string[];

  // Causa do último crash (não persistido — assim como serverStatus, não faz
  // sentido reabrir o app "lembrando" de um crash antigo). Resetado sempre
  // que um novo start é disparado (ver setServerStatus).
  lastCrashInfo: CrashInfo | null;

  // Usuário logado (Supabase), null se estiver usando sem conta — ver
  // AuthUser acima. Não persistido.
  user: AuthUser | null;

  // shortCode de um convite recebido via deep link (cubicase://join/<shortCode>,
  // ver src/lib/joinDeepLink.ts) que a GuestView ainda não processou — runtime
  // apenas, nunca persistido. GuestView zera pra null assim que consome.
  pendingJoinShortCode: string | null;

  // Biblioteca de servidores conhecidos (persistida)
  knownServers: KnownServer[];

  // Servidores locais do host (runtime, não persistido separadamente)
  localServers: ServerInfo[];

  // shortCode do servidor ao qual o Convidado está conectado agora (persistido —
  // sobrevive a F5/reabertura do app). A ÚNICA fonte de verdade pra "desconectado"
  // é a rede mesh cair de verdade (evento "network-status" offline) ou o usuário
  // clicar em Desconectar — nunca um simples reload de página. Ver GuestView.tsx
  // e o restore em page.tsx (get_system_status).
  guestConnectedShortCode: string | null;

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
  setBackupSafetyNetIntervalHours: (hours: number) => void;
  setSelectedServer: (name: string | null) => void;
  setMode: (mode: "host" | "guest") => void;
  setDefaultTab: (tab: "host" | "guest") => void;
  setRunningServer: (name: string | null) => void;
  setServerStatus: (status: ServerStatus) => void;
  setOnlinePlayers: (players: string[]) => void;
  addOnlinePlayer: (name: string) => void;
  removeOnlinePlayer: (name: string) => void;
  setLastCrashInfo: (info: CrashInfo | null) => void;
  setUser: (user: AuthUser | null) => void;
  setPendingJoinShortCode: (shortCode: string | null) => void;
  setLocalServers: (servers: ServerInfo[]) => void;
  setGuestConnectedShortCode: (shortCode: string | null) => void;
  setKnownServers: (servers: KnownServer[]) => void;
  addKnownServer: (server: KnownServer) => void;
  removeKnownServer: (shortCode: string) => void;
  updateKnownServerStatus: (shortCode: string, status: ServerStatus, minecraftStatus?: ServerStatus | null, currentPlayers?: number) => void;
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
      backupSafetyNetIntervalHours: 6,
      selectedServer: null,
      mode: "host",
      defaultTab: null,
      runningServer: null,
      serverStatus: 'offline',
      onlinePlayers: [],
      lastCrashInfo: null,
      user: null,
      pendingJoinShortCode: null,
      knownServers: [],
      localServers: [],
      guestConnectedShortCode: null,
      importedServerPaths: [],
      logs: [],
      mcLogsByServer: {},

      setServerDir: (dir) => set({ serverDir: dir }),
      setInitialized: (val) => set({ hasInitialized: val }),
      setMinecraftPort: (port) => set({ minecraftPort: port }),
      setAutoBackupEnabled: (enabled) => set({ autoBackupEnabled: enabled }),
      setBackupRetentionCount: (count) => set({ backupRetentionCount: count }),
      setBackupSafetyNetIntervalHours: (hours) => set({ backupSafetyNetIntervalHours: hours }),
      setSelectedServer: (name) => set({ selectedServer: name }),
      setMode: (mode) => set({ mode }),
      // Grava a escolha do onboarding E já troca pra aba escolhida na hora
      // (evita o usuário escolher "Convidado" e continuar vendo a tela de Host).
      setDefaultTab: (tab) => set({ defaultTab: tab, mode: tab }),
      setRunningServer: (name) => set({ runningServer: name }),
      setServerStatus: (status) => set((state) => ({
        serverStatus: status,
        // Um novo start torna o crash anterior irrelevante para o banner.
        lastCrashInfo: status === 'starting' ? null : state.lastCrashInfo,
      })),
      setOnlinePlayers: (players) => set({ onlinePlayers: players }),
      addOnlinePlayer: (name) => set((state) =>
        state.onlinePlayers.includes(name) ? state : { onlinePlayers: [...state.onlinePlayers, name] }
      ),
      removeOnlinePlayer: (name) => set((state) => ({
        onlinePlayers: state.onlinePlayers.filter((p) => p !== name),
      })),
      setLastCrashInfo: (info) => set({ lastCrashInfo: info }),
      setUser: (user) => set({ user }),
      setPendingJoinShortCode: (shortCode) => set({ pendingJoinShortCode: shortCode }),
      setLocalServers: (servers) => set({ localServers: servers }),
      setGuestConnectedShortCode: (shortCode) => set({ guestConnectedShortCode: shortCode }),
      setKnownServers: (servers) => set({ knownServers: servers }),
      addKnownServer: (server) => set((state) => {
        const exists = state.knownServers.find(s => s.shortCode === server.shortCode);
        if (exists) return state;
        return { knownServers: [...state.knownServers, server] };
      }),
      removeKnownServer: (shortCode) => set((state) => ({
        knownServers: state.knownServers.filter(s => s.shortCode !== shortCode),
      })),
      updateKnownServerStatus: (shortCode, status, minecraftStatus, currentPlayers) => set((state) => ({
        knownServers: state.knownServers.map(s => {
          if (s.shortCode !== shortCode) return s;
          const resolvedMcStatus = minecraftStatus !== undefined ? minecraftStatus : s.minecraftStatus;
          // "Online há X" / "visto por último" descrevem o processo Java em si
          // (minecraftStatus), não a rede mesh (status) — um host pode manter a
          // mesh sempre ligada (ou nunca ligar), o que fazia esses campos nunca
          // avançarem (ou avançarem o tempo todo) independente do servidor estar
          // de pé de verdade. Ver getDisplayStatus/isFullyOnline em GuestView.tsx.
          const mcOnline = resolvedMcStatus === 'online';
          return {
            ...s,
            status,
            minecraftStatus: resolvedMcStatus,
            currentPlayers: currentPlayers ?? s.currentPlayers,
            lastSeenOnline: mcOnline ? new Date().toISOString() : s.lastSeenOnline,
            // Marca o início da sessão "online" apenas na transição para online;
            // permanece parado enquanto o Minecraft continuar online (para servir de
            // base ao contador de tempo online) e reseta quando o servidor cai.
            onlineSince: mcOnline
              // Preserva o timestamp existente só se já havia um (evita resetar a
              // contagem a cada poll); senão inicializa agora — cobre tanto a
              // transição real para online quanto servidores persistidos antes
              // deste campo existir (onlineSince ausente apesar de minecraftStatus "online").
              ? (s.minecraftStatus === 'online' && s.onlineSince ? s.onlineSince : new Date().toISOString())
              : null,
            // Só é chamado após uma resposta bem-sucedida da API: marca o momento
            // em que este status foi de fato confirmado (usado para detectar dados obsoletos).
            lastConfirmedAt: new Date().toISOString(),
          };
        }),
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
        backupSafetyNetIntervalHours: state.backupSafetyNetIntervalHours,
        selectedServer: state.selectedServer,
        mode: state.mode,
        defaultTab: state.defaultTab,
        runningServer: state.runningServer,
        knownServers: state.knownServers,
        guestConnectedShortCode: state.guestConnectedShortCode,
        importedServerPaths: state.importedServerPaths,
        logs: state.logs,
        mcLogsByServer: state.mcLogsByServer,
      }),
      // Força `mode` a nascer igual à preferência (defaultTab) a cada boot do
      // app — sem isso, `mode` (persistido só pra sobreviver a F5 durante dev)
      // ficaria "grudado" na última aba vista antes de fechar o app, em vez de
      // respeitar a preferência escolhida no onboarding/Configurações → Início.
      // Precisa ser aqui no `merge` (não em `onRehydrateStorage`/useEffect):
      // como localStorage é síncrono, a reidratação inteira roda de forma
      // síncrona durante a criação da store, antes até da constante
      // `useAppStore` terminar de ser atribuída — qualquer callback que
      // referencie `useAppStore` nesse momento cai em erro de TDZ.
      merge: (persistedState, currentState) => {
        const merged = { ...currentState, ...(persistedState as Partial<AppSettings>) };
        const persistedDefaultTab = (persistedState as Partial<AppSettings> | undefined)?.defaultTab;
        if (persistedDefaultTab) merged.mode = persistedDefaultTab;
        return merged;
      },
    }
  )
);

