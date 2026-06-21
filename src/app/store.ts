import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// Estado do ciclo de vida do servidor Minecraft
export type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed';

interface AppSettings {
  // Configurações persistidas
  serverDir: string | null;
  hasInitialized: boolean;
  minecraftPort: number;
  selectedServer: string | null;

  // Estado de runtime (não persistido)
  serverStatus: ServerStatus;

  // Setters
  setServerDir: (dir: string) => void;
  setInitialized: (val: boolean) => void;
  setMinecraftPort: (port: number) => void;
  setSelectedServer: (name: string | null) => void;
  setServerStatus: (status: ServerStatus) => void;
}

export const useAppStore = create<AppSettings>()(
  persist(
    (set) => ({
      serverDir: null,
      hasInitialized: false,
      minecraftPort: 25565,
      selectedServer: null,
      serverStatus: 'offline',

      setServerDir: (dir) => set({ serverDir: dir }),
      setInitialized: (val) => set({ hasInitialized: val }),
      setMinecraftPort: (port) => set({ minecraftPort: port }),
      setSelectedServer: (name) => set({ selectedServer: name }),
      setServerStatus: (status) => set({ serverStatus: status }),
    }),
    {
      // Persistir apenas configurações do usuário, não estados de runtime
      name: 'cubeforge-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        serverDir: state.serverDir,
        hasInitialized: state.hasInitialized,
        minecraftPort: state.minecraftPort,
        selectedServer: state.selectedServer,
      }),
    }
  )
);
