import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface AppSettings {
  serverDir: string | null;
  hasInitialized: boolean;
  minecraftPort: number;
  setServerDir: (dir: string) => void;
  setInitialized: (val: boolean) => void;
  setMinecraftPort: (port: number) => void;
}

export const useAppStore = create<AppSettings>()(
  persist(
    (set) => ({
      serverDir: null,
      hasInitialized: false,
      minecraftPort: 25565,
      setServerDir: (dir) => set({ serverDir: dir }),
      setInitialized: (val) => set({ hasInitialized: val }),
      setMinecraftPort: (port) => set({ minecraftPort: port }),
    }),
    {
      name: 'cubeforge-storage',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
