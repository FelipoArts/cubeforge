"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Package, X, Loader2, AlertTriangle, FileArchive, ExternalLink } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { parseModpack, type ParsedModpack, type ModpackInstallProgress } from "@/lib/modpackImport";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";

// ============================================================
// ImportModpackModal
// ============================================================
// Fluxo próprio (diferente do CreateServerModal): escolher o .zip/.mrpack →
// ler o manifest → confirmar (versão/loader vêm do pack, não são escolhidos
// pelo usuário) → progresso, reaproveitando installModpack (src/lib/modpackImport.ts).
// ============================================================

const LOADER_LABELS: Record<string, string> = {
  forge: "Forge",
  neoforge: "NeoForge",
  fabric: "Fabric",
};

type Step = "pick" | "parsing" | "confirm";

interface ImportModpackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (name: string, parsed: ParsedModpack, ram: number) => Promise<void>;
  installProgress: ModpackInstallProgress | null;
  totalRamGb: number;
}

export function ImportModpackModal({ isOpen, onClose, onImport, installProgress, totalRamGb }: ImportModpackModalProps) {
  useLockBodyScroll(isOpen);

  const [step, setStep] = useState<Step>("pick");
  const [parsed, setParsed] = useState<ParsedModpack | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [serverName, setServerName] = useState("");
  const [serverRam, setServerRam] = useState(4);

  useEffect(() => {
    if (!isOpen) {
      setStep("pick");
      setParsed(null);
      setParseError(null);
      setServerName("");
      setServerRam(4);
    }
  }, [isOpen]);

  const handlePickFile = async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Modpack", extensions: ["zip", "mrpack"] }],
      title: "Selecione o arquivo do modpack",
    });
    if (!selected) return;

    setStep("parsing");
    setParseError(null);
    try {
      const result = await parseModpack(selected as string);
      setParsed(result);
      setServerName(result.packName.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "Modpack");
      setStep("confirm");
    } catch (err) {
      console.error(err);
      setParseError(String(err instanceof Error ? err.message : err));
      setStep("pick");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed || !serverName.trim()) return;
    const cleanName = serverName.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    await onImport(cleanName, parsed, serverRam);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { if (!installProgress) onClose(); }}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-md bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-6"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg flex items-center justify-center">
                  <Package className="text-indigo-700 dark:text-indigo-300 w-5 h-5" />
                </div>
                <h3 className="text-xl font-bold text-theme-primary">Importar Modpack</h3>
              </div>
              {!installProgress && (
                <button
                  onClick={onClose}
                  className="p-1.5 hover:bg-theme-muted rounded-xl text-theme-secondary hover:text-theme-primary transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {installProgress ? (
              <div className="py-8 space-y-4">
                <div className="flex items-center justify-center gap-3">
                  <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                  <span className="font-bold text-theme-primary text-sm">{installProgress.status}</span>
                </div>
                <div className="space-y-2">
                  <div className="w-full h-3 bg-theme-muted rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${installProgress.percent}%` }}
                      className="h-full bg-indigo-600 rounded-full"
                    />
                  </div>
                  <div className="text-right text-[10px] font-bold text-theme-secondary">{installProgress.percent}% concluído</div>
                </div>
                <p className="text-[10px] text-theme-secondary text-center italic leading-relaxed">
                  Instalando o mod loader e baixando os mods do pack. Modpacks grandes podem levar alguns minutos.
                </p>
              </div>
            ) : step === "pick" ? (
              <div className="space-y-4">
                <p className="text-sm text-theme-secondary leading-relaxed">
                  Selecione o arquivo <code className="text-xs bg-theme-muted px-1.5 py-0.5 rounded">.zip</code> (CurseForge) ou{" "}
                  <code className="text-xs bg-theme-muted px-1.5 py-0.5 rounded">.mrpack</code> (Modrinth) do modpack. O CubeForge Dash vai
                  identificar a versão do Minecraft, o mod loader e baixar todos os mods automaticamente.
                </p>
                {parseError && (
                  <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-xs rounded-xl flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <span>{parseError}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handlePickFile}
                  className="w-full h-32 border-2 border-dashed border-theme-card rounded-2xl flex flex-col items-center justify-center gap-2 text-theme-secondary hover:border-indigo-400 hover:text-indigo-600 transition-colors cursor-pointer"
                >
                  <FileArchive className="w-8 h-8" />
                  <span className="text-sm font-semibold">Clique para selecionar o arquivo</span>
                </button>
                <div className="flex justify-end pt-2 border-t border-theme-card">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : step === "parsing" ? (
              <div className="py-10 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                <span className="text-sm font-semibold text-theme-secondary">Lendo o modpack...</span>
              </div>
            ) : parsed ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="p-3 bg-theme-accent border border-theme-accent rounded-xl space-y-1">
                  <p className="text-sm font-bold text-theme-primary">{parsed.packName}</p>
                  <p className="text-xs text-theme-secondary">
                    Minecraft {parsed.mcVersion} • {LOADER_LABELS[parsed.loader] ?? parsed.loader} {parsed.loaderVersion} •{" "}
                    {parsed.mods.length} {parsed.mods.length === 1 ? "mod" : "mods"}
                  </p>
                </div>

                {parsed.unresolvedMods.length > 0 && (
                  <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-xs rounded-xl space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <span>
                        {parsed.unresolvedMods.length} {parsed.unresolvedMods.length === 1 ? "mod não pode" : "mods não podem"} ser
                        baixados automaticamente (o autor desabilitou distribuição por terceiros). Baixe manualmente e coloque na pasta
                        &quot;mods&quot; depois de importar:
                      </span>
                    </div>
                    <div className="max-h-24 overflow-y-auto space-y-1 pl-6">
                      {parsed.unresolvedMods.map((m) => (
                        <button
                          key={`${m.projectId}-${m.fileId}`}
                          type="button"
                          onClick={() => m.slug && openExternal(`https://www.curseforge.com/minecraft/mc-mods/${m.slug}`)}
                          disabled={!m.slug}
                          className="flex items-center gap-1.5 text-[11px] font-semibold underline decoration-dotted disabled:no-underline disabled:opacity-60 disabled:cursor-default cursor-pointer"
                        >
                          {m.slug ?? `Projeto ${m.projectId}`}
                          {m.slug && <ExternalLink className="w-3 h-3" />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Nome do Servidor</label>
                  <input
                    type="text"
                    required
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">RAM Alocada</label>
                    <span className="text-sm font-bold text-indigo-600 font-mono">{serverRam} GB</span>
                  </div>
                  <input
                    type="range"
                    min="2"
                    max={Math.max(2, totalRamGb - 2)}
                    step="1"
                    value={serverRam}
                    onChange={(e) => setServerRam(parseInt(e.target.value))}
                    className="w-full accent-indigo-600 cursor-pointer h-2 bg-theme-muted rounded-lg appearance-none"
                  />
                  <div className="flex justify-between text-[10px] text-theme-secondary">
                    <span>Mín: 2 GB</span>
                    <span>Total no PC: {totalRamGb} GB</span>
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-theme-card">
                  <button
                    type="button"
                    onClick={() => setStep("pick")}
                    className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold"
                  >
                    Voltar
                  </button>
                  <button
                    type="submit"
                    className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow"
                  >
                    Importar Modpack
                  </button>
                </div>
              </form>
            ) : null}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
