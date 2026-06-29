"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, X, Loader2, ChevronRight, Server, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchVersionManifest,
  getRecommendedVersions,
  getPopularVersions,
  getAllReleaseVersions,
  searchVersions,
  getJavaVersion,
  type VersionManifest,
  type ServerInstallProgress,
} from "@/lib/server";

// ============================================================
// CreateServerModal
// ============================================================
// Modal para criar um novo servidor Minecraft Vanilla.
// Inclui seletor de versão com busca, slider de RAM e
// barra de progresso de instalação.
// ============================================================

interface CreateServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, version: string, ram: number) => Promise<void>;
  installProgress: ServerInstallProgress | null;
  totalRamGb: number;
}

export function CreateServerModal({
  isOpen,
  onClose,
  onCreate,
  installProgress,
  totalRamGb,
}: CreateServerModalProps) {
  const [serverName, setServerName] = useState("");
  const [serverVersion, setServerVersion] = useState("1.20.1");
  const [serverRam, setServerRam] = useState(4);
  const [versionManifest, setVersionManifest] = useState<VersionManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [versionDropdownOpen, setVersionDropdownOpen] = useState(false);
  const [versionSearchQuery, setVersionSearchQuery] = useState("");
  const [showAllVersions, setShowAllVersions] = useState(false);
  const versionDropdownRef = useRef<HTMLDivElement>(null);

  // Carrega o manifest quando o modal abre
  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      setManifestLoading(true);
      try {
        const manifest = await fetchVersionManifest();
        setVersionManifest(manifest);
        setServerVersion(manifest.latest.release);
      } catch (err) {
        console.warn("Falha ao carregar manifest da Mojang:", err);
        setManifestError("Não foi possível carregar a lista de versões.");
        setServerVersion("1.20.1");
      } finally {
        setManifestLoading(false);
      }
    })();
  }, [isOpen]);

  // Fecha o dropdown ao clicar fora
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (versionDropdownRef.current && !versionDropdownRef.current.contains(e.target as Node)) {
        setVersionDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Reseta o estado ao fechar
  useEffect(() => {
    if (!isOpen) {
      setServerName("");
      setVersionSearchQuery("");
      setShowAllVersions(false);
      setVersionDropdownOpen(false);
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverName.trim()) return;
    const cleanName = serverName.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    await onCreate(cleanName, serverVersion, serverRam);
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
                  <Plus className="text-indigo-700 dark:text-indigo-300 w-5 h-5" />
                </div>
                <h3 className="text-xl font-bold text-theme-primary">Criar Servidor Minecraft</h3>
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
                  Estamos baixando os arquivos oficiais de forma nativa e segura. Isso ocorrerá apenas uma vez por versão instalada.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Nome do Servidor */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Nome do Servidor</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Meu_Servidor"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent"
                  />
                </div>

                {/* Versão - Seletor Categorizado */}
                <div className="space-y-1.5 relative" ref={versionDropdownRef}>
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Versão do Minecraft</label>

                  {/* Botão do dropdown */}
                  <button
                    type="button"
                    onClick={() => setVersionDropdownOpen(!versionDropdownOpen)}
                    disabled={manifestLoading}
                    className="w-full h-12 px-4 border border-theme-card bg-transparent rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary flex items-center justify-between"
                  >
                    {manifestLoading ? (
                      <span className="text-theme-secondary">Carregando versões...</span>
                    ) : (
                      <span>Vanilla {serverVersion}</span>
                    )}
                    <ChevronRight className={`w-4 h-4 text-theme-secondary transition-transform ${versionDropdownOpen ? 'rotate-90' : ''}`} />
                  </button>

                  {/* Dropdown */}
                  {versionDropdownOpen && (
                    <div className="absolute z-50 mt-1 w-full bg-theme-card border border-theme-card rounded-2xl shadow-xl overflow-hidden">
                      {/* Campo de busca */}
                      <div className="p-2 border-b border-theme-card">
                        <input
                          type="text"
                          placeholder="🔍 Buscar versão..."
                          value={versionSearchQuery}
                          onChange={(e) => {
                            setVersionSearchQuery(e.target.value);
                            if (e.target.value) setShowAllVersions(true);
                          }}
                          className="w-full h-10 px-3 border border-theme-card rounded-xl focus:border-indigo-500 focus:outline-none text-sm text-theme-primary bg-transparent"
                          autoFocus
                        />
                      </div>

                      {/* Lista de versões */}
                      <div className="max-h-64 overflow-y-auto">
                        {(() => {
                          if (!versionManifest) {
                            return (
                              <div className="p-4 text-center text-sm text-theme-secondary">
                                {manifestError ? <span>{manifestError}</span> : <span>Carregando...</span>}
                              </div>
                            );
                          }

                          let versions: { id: string; section: string }[] = [];

                          if (versionSearchQuery) {
                            const results = searchVersions(versionManifest, versionSearchQuery);
                            versions = results.map(id => ({ id, section: 'resultados' }));
                          } else if (showAllVersions) {
                            const all = getAllReleaseVersions(versionManifest);
                            versions = all.map(id => ({ id, section: 'todas' }));
                          } else {
                            const recommended = getRecommendedVersions(versionManifest);
                            const popular = getPopularVersions();
                            const seen = new Set<string>();
                            for (const id of recommended) {
                              if (!seen.has(id)) { versions.push({ id, section: 'recommended' }); seen.add(id); }
                            }
                            for (const id of popular) {
                              if (!seen.has(id)) { versions.push({ id, section: 'popular' }); seen.add(id); }
                            }
                          }

                          const sections: { label: string; key: string; ids: string[] }[] = [];
                          let currentSection: string | null = null;
                          for (const v of versions) {
                            if (v.section !== currentSection) {
                              currentSection = v.section;
                              let label = '';
                              switch (v.section) {
                                case 'recommended': label = '⭐ Recomendadas'; break;
                                case 'popular': label = '🔥 Versões Populares'; break;
                                case 'todas': label = '📋 Todas as Versões'; break;
                                case 'resultados': label = '🔍 Resultados da Busca'; break;
                              }
                              sections.push({ label, key: v.section, ids: [] });
                            }
                            sections[sections.length - 1].ids.push(v.id);
                          }

                          return sections.map((section) => (
                            <div key={section.key}>
                              <div className="px-4 py-1.5 text-[10px] font-bold text-theme-secondary uppercase tracking-wider bg-theme-muted/50">
                                {section.label}
                              </div>
                              {section.ids.map((id) => (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() => {
                                    setServerVersion(id);
                                    setVersionDropdownOpen(false);
                                    setVersionSearchQuery('');
                                    setShowAllVersions(false);
                                  }}
                                  className={`w-full px-4 py-2.5 text-left text-sm transition-colors hover:bg-theme-accent flex items-center justify-between ${
                                    serverVersion === id ? 'bg-theme-accent text-indigo-700 font-semibold' : 'text-theme-primary'
                                  }`}
                                >
                                  <span>Vanilla {id}</span>
                                  <span className="text-[10px] text-theme-secondary font-mono">
                                    Java {getJavaVersion(id)}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ));
                        })()}
                      </div>

                      {/* Rodapé do dropdown */}
                      {!versionSearchQuery && (
                        <div className="p-2 border-t border-theme-card">
                          <button
                            type="button"
                            onClick={() => {
                              setShowAllVersions(!showAllVersions);
                              setVersionSearchQuery('');
                            }}
                            className="w-full h-9 text-xs font-semibold text-indigo-600 hover:bg-theme-accent rounded-xl transition-colors"
                          >
                            {showAllVersions ? '← Mostrar apenas Recomendadas' : `📋 Mostrar todas as ${versionManifest ? getAllReleaseVersions(versionManifest).length : '...'} versões`}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Indicador visual */}
                  {serverVersion && !manifestLoading && (
                    <div className="mt-2 px-3 py-2 bg-theme-accent border border-theme-accent rounded-xl text-xs font-semibold text-indigo-700 dark:text-indigo-300 flex items-center gap-2">
                      <Server className="w-3.5 h-3.5 flex-shrink-0" />
                      Minecraft {serverVersion} • Java {getJavaVersion(serverVersion)} • Vanilla
                    </div>
                  )}
                </div>

                {/* RAM */}
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
                  {serverRam < 3 && (
                    <div className="mt-2 p-2.5 bg-theme-warning border border-amber-100 text-amber-800 text-[10px] rounded-xl flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>Atenção:</strong> Menos de 3 GB de RAM pode causar lentidão ou travamentos no servidor, especialmente com muitos jogadores ou mods.
                      </span>
                    </div>
                  )}
                  {(totalRamGb - serverRam < 2) && (
                    <div className="p-3 bg-theme-warning border border-amber-100 text-amber-800 text-[10px] rounded-xl flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      <span>
                        <strong>Atenção:</strong> Deixar menos de 2GB livres para o sistema operacional pode deixar o Windows lento ou instável.
                      </span>
                    </div>
                  )}
                </div>

                {/* Botões */}
                <div className="flex justify-end gap-3 pt-4 border-t border-theme-card">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-5 h-12 rounded-2xl text-theme-secondary hover:text-theme-primary hover:bg-theme-muted transition-colors text-sm font-semibold"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-6 h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-semibold shadow-md shadow-theme-shadow"
                  >
                    Criar Servidor
                  </button>
                </div>
              </form>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
