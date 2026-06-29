import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { Check, X, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ServerConfigModalProps {
  /** Full filesystem path to the server directory */
  serverDir: string;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void; // refresh parent data after save
  /** Current server status — if "online" or "starting", form is disabled */
  serverStatus?: string;
}

export function ServerConfigModal({ serverDir, isOpen, onClose, onSaved, serverStatus }: ServerConfigModalProps) {
  const [motd, setMotd] = useState('');
  const [gamemode, setGamemode] = useState('survival');
  const [difficulty, setDifficulty] = useState('easy');
  const [hardcore, setHardcore] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(20);
  const [whitelist, setWhitelist] = useState(false);
  const [pvp, setPvp] = useState(true);
  const [allowFlight, setAllowFlight] = useState(false);
  const [levelSeed, setLevelSeed] = useState('');
  const [allowNether, setAllowNether] = useState(true);
  const [spawnMonsters, setSpawnMonsters] = useState(true);
  const [spawnAnimals, setSpawnAnimals] = useState(true);
  const [spawnNpcs, setSpawnNpcs] = useState(true);
  const [viewDistance, setViewDistance] = useState(10);
  const [onlineMode, setOnlineMode] = useState(true);
  const [serverPort, setServerPort] = useState(25565);
  const [enforceSecureProfile, setEnforceSecureProfile] = useState(true);
  const [allocatedRam, setAllocatedRam] = useState(4);
  const [totalSystemRam, setTotalSystemRam] = useState(8);
  const [portError, setPortError] = useState('');

  // Load current properties when modal opens
  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        const props = await invoke<Record<string, any>>('read_server_properties', { serverDir });
        // All values come from Rust as strings — convert booleans and numbers explicitly
        setMotd(props.motd ?? '');
        setGamemode(props.gamemode ?? 'survival');
        setDifficulty(props.difficulty ?? 'easy');
        setHardcore(props.hardcore === 'true');
        setMaxPlayers(Number(props['max-players'] ?? 20));
        setWhitelist(props['white-list'] === 'true');
        setPvp(props.pvp !== 'false'); // default true
        setAllowFlight(props['allow-flight'] === 'true');
        setLevelSeed(props['level-seed'] ?? '');
        setAllowNether(props['allow-nether'] !== 'false'); // default true
        setSpawnMonsters(props['spawn-monsters'] !== 'false'); // default true
        setSpawnAnimals(props['spawn-animals'] !== 'false'); // default true
        setSpawnNpcs(props['spawn-npcs'] !== 'false'); // default true
        setViewDistance(Number(props['view-distance'] ?? 10));
        setOnlineMode(props['online-mode'] !== 'false'); // default true
        setServerPort(Number(props['server-port'] ?? 25565));
        setEnforceSecureProfile(props['enforce-secure-profile'] !== 'false'); // default true
        setPortError('');

        // Load RAM from cubeforge-meta.json
        try {
          const metaPath = await join(serverDir, 'cubeforge-meta.json');
          const metaContent = await readTextFile(metaPath);
          const meta = JSON.parse(metaContent) as { ramGb?: number; totalRamGb?: number };
          if (typeof meta.ramGb === 'number' && meta.ramGb >= 2) {
            setAllocatedRam(meta.ramGb);
          }
          if (typeof meta.totalRamGb === 'number' && meta.totalRamGb > 0) {
            setTotalSystemRam(meta.totalRamGb);
          } else {
            // Try to get total system RAM
            try {
              const totalBytes = await invoke<number>('get_total_memory');
              setTotalSystemRam(Math.round(totalBytes / (1024 * 1024 * 1024)));
            } catch { /* ignore */ }
          }
        } catch (e) {
          console.warn('Could not read cubeforge-meta.json, using defaults:', e);
          // If meta file doesn't exist, try to get total system RAM
          try {
            const totalBytes = await invoke<number>('get_total_memory');
            setTotalSystemRam(Math.round(totalBytes / (1024 * 1024 * 1024)));
          } catch { /* ignore */ }
          setAllocatedRam(4);
        }
      } catch (e) {
        console.error('Failed to read server properties:', e);
      }
    })();
  }, [isOpen, serverDir]);

  const handleSave = async () => {
    // Validate server port
    if (serverPort < 1024 || serverPort > 65535) {
      setPortError('A porta deve estar entre 1024 e 65535.');
      return;
    }
    setPortError('');

    // All values must be strings — the Rust command expects HashMap<String, String>
    const properties: Record<string, string> = {
      motd,
      gamemode,
      difficulty,
      hardcore: String(hardcore),
      'max-players': String(maxPlayers),
      'white-list': String(whitelist),
      pvp: String(pvp),
      'allow-flight': String(allowFlight),
      'level-seed': levelSeed,
      'allow-nether': String(allowNether),
      'spawn-monsters': String(spawnMonsters),
      'spawn-animals': String(spawnAnimals),
      'spawn-npcs': String(spawnNpcs),
      'view-distance': String(viewDistance),
      'online-mode': String(onlineMode),
      'server-port': String(serverPort),
      'enforce-secure-profile': String(enforceSecureProfile),
    };
    try {
      await invoke('write_server_properties', { serverDir, props: properties });

      // Also save RAM allocation to cubeforge-meta.json
      try {
        const metaPath = await join(serverDir, 'cubeforge-meta.json');
        const metaContent = await readTextFile(metaPath);
        const meta = JSON.parse(metaContent);
        meta.ramGb = allocatedRam;
        await writeTextFile(metaPath, JSON.stringify(meta, null, 2));
        console.log(`RAM saved: ${allocatedRam}GB -> ${metaPath}`);
      } catch (e) {
        // If meta file doesn't exist, create it
        console.warn('Could not update existing meta file, creating new one:', e);
        try {
          const metaPath = await join(serverDir, 'cubeforge-meta.json');
          await writeTextFile(metaPath, JSON.stringify({ ramGb: allocatedRam }, null, 2));
          console.log(`RAM saved (new file): ${allocatedRam}GB -> ${metaPath}`);
        } catch (e2) {
          console.error('Failed to save RAM allocation:', e2);
        }
      }

      onSaved();
      onClose();
    } catch (e) {
      console.error('Failed to write server properties:', e);
    }
  };

  const isServerRunning = serverStatus === "online" || serverStatus === "starting" || serverStatus === "stopping";

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onClose} />
          {/* Modal */}
          <motion.div
            className="relative w-full max-w-lg bg-theme-card rounded-[2rem] border-theme-card shadow-2xl z-10 space-y-6 max-h-[85vh] flex flex-col"
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: 'spring', duration: 0.3 }}
          >
            <div className="p-8 pb-0 flex-shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-theme-primary">Configurações do Servidor</h3>
                <button type="button" onClick={onClose} className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer" title="Cancelar">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
              {isServerRunning && (
                <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-2xl flex items-start gap-3 text-sm mb-4">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">Servidor em execução.</span> As configurações só podem ser alteradas com o servidor Minecraft parado. Pare o servidor antes de modificar as propriedades.
                  </div>
                </div>
              )}

              <form className="space-y-4 pb-4" onSubmit={e => { e.preventDefault(); handleSave(); }}>
                {/* MOTD */}
                <div>
                  <label className="block text-sm font-medium text-theme-primary mb-1">Mensagem do Dia (motd)</label>
                  <input
                    type="text"
                    value={motd}
                    onChange={e => setMotd(e.target.value)}
                    disabled={isServerRunning}
                    className="w-full rounded-2xl border border-theme-card bg-transparent px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>
                {/* Gamemode & Difficulty */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">Modo de Jogo</label>
                    <select
                      value={gamemode}
                      onChange={e => setGamemode(e.target.value)}
                      disabled={isServerRunning}
                      className="w-full rounded-2xl border border-theme-card bg-theme-card px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="survival">Sobrevivência</option>
                      <option value="creative">Criativo</option>
                      <option value="adventure">Aventura</option>
                      <option value="spectator">Espectador</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">Dificuldade</label>
                    <select
                      value={difficulty}
                      onChange={e => setDifficulty(e.target.value)}
                      disabled={isServerRunning}
                      className="w-full rounded-2xl border border-theme-card bg-theme-card px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="peaceful">Pacífico</option>
                      <option value="easy">Fácil</option>
                      <option value="normal">Normal</option>
                      <option value="hard">Difícil</option>
                    </select>
                  </div>
                </div>
                {/* Toggles */}
                <div className="grid grid-cols-2 gap-4">
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={hardcore} onChange={e => setHardcore(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Hardcore</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={whitelist} onChange={e => setWhitelist(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Lista de Aprovados</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={pvp} onChange={e => setPvp(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">PVP</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={allowFlight} onChange={e => setAllowFlight(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Permitir Voo</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={allowNether} onChange={e => setAllowNether(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Permitir Nether</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={spawnMonsters} onChange={e => setSpawnMonsters(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Gerar Monstros</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={spawnAnimals} onChange={e => setSpawnAnimals(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Gerar Animais</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={spawnNpcs} onChange={e => setSpawnNpcs(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Gerar Aldeões</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={onlineMode} onChange={e => setOnlineMode(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Modo Online</span>
                  </label>
                  <label className="inline-flex items-center space-x-2">
                    <input type="checkbox" checked={enforceSecureProfile} onChange={e => setEnforceSecureProfile(e.target.checked)} disabled={isServerRunning} className="form-checkbox h-5 w-5 text-indigo-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-sm text-theme-primary">Perfil Seguro</span>
                  </label>
                </div>
                {/* Numeric fields */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">Máx. Jogadores</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={maxPlayers}
                      onChange={e => setMaxPlayers(Number(e.target.value))}
                      disabled={isServerRunning}
                      className="w-full rounded-2xl border border-theme-card bg-transparent px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">Porta do Servidor</label>
                    <input
                      type="number"
                      value={serverPort}
                      onChange={e => setServerPort(Number(e.target.value))}
                      disabled={isServerRunning}
                      className={cn(
                        "w-full rounded-2xl border px-3 py-2 focus:outline-none transition-colors bg-transparent text-theme-primary",
                        portError
                          ? "border-rose-400 focus:border-rose-500 bg-rose-50 dark:bg-rose-900/20"
                          : "border-theme-card focus:border-indigo-500",
                        isServerRunning && "opacity-50 cursor-not-allowed"
                      )}
                    />
                    {portError && (
                      <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {portError}
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-theme-primary mb-1">Semente (level-seed)</label>
                    <input
                      type="text"
                      value={levelSeed}
                      onChange={e => setLevelSeed(e.target.value)}
                      disabled={isServerRunning}
                      className="w-full rounded-2xl border border-theme-card bg-transparent px-3 py-2 text-theme-primary focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>
                </div>
                {/* View Distance Slider */}
                <div>
                  <label className="block text-sm font-medium text-theme-primary mb-1">Distância de Visão</label>
                  <div className="flex items-center space-x-4">
                    <input
                      type="range"
                      min={4}
                      max={32}
                      step={1}
                      value={viewDistance}
                      onChange={e => setViewDistance(Number(e.target.value))}
                      disabled={isServerRunning}
                      className="flex-1 accent-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <span className="w-12 text-center font-medium text-theme-primary">{viewDistance}</span>
                  </div>
                </div>
                {/* RAM Allocation Slider */}
                <div>
                  <label className="block text-sm font-medium text-theme-primary mb-1">Memória RAM Alocada</label>
                  <div className="flex items-center space-x-4">
                    <input
                      type="range"
                      min={2}
                      max={Math.max(2, totalSystemRam - 1)}
                      step={1}
                      value={allocatedRam}
                      onChange={e => setAllocatedRam(Number(e.target.value))}
                      disabled={isServerRunning}
                      className="flex-1 accent-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <span className="w-16 text-center font-medium text-theme-primary font-mono">{allocatedRam} GB</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-theme-secondary mt-1">
                    <span>Mín: 2 GB</span>
                    <span>Total no PC: {totalSystemRam} GB</span>
                  </div>
                  {allocatedRam < 3 && (
                    <div className="mt-2 p-2.5 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 text-[10px] rounded-xl flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>Atenção:</strong> Menos de 3 GB de RAM pode causar lentidão ou travamentos no servidor, especialmente com muitos jogadores ou mods.
                      </span>
                    </div>
                  )}
                  {totalSystemRam - allocatedRam < 2 && (
                    <div className="mt-2 p-2.5 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 text-[10px] rounded-xl flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>Perigo:</strong> Deixar menos de 2 GB livres para o sistema operacional pode travar o Windows ou corromper dados. Reduza a RAM alocada.
                      </span>
                    </div>
                  )}
                </div>
              </form>
            </div>

            {/* Action buttons */}
            <div className="p-8 pt-0 flex-shrink-0">
              <div className="flex justify-end space-x-3 pt-4 border-t border-theme-card">
                <button type="button" onClick={onClose} className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold cursor-pointer">
                  Cancelar
                </button>
                <button type="submit" disabled={isServerRunning} onClick={handleSave} className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-theme-shadow cursor-pointer">
                  <Check className="w-4 h-4" /> Salvar
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
