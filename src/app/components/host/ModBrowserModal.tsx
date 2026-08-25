"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Search,
  Loader2,
  ArrowLeft,
  Download,
  WifiOff,
  AlertTriangle,
  CheckCircle2,
  Blocks,
  PackagePlus,
} from "lucide-react";
import { pushDiagnostic } from "@/app/diagnostics";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import {
  loaderForServerType,
  checkModrinthReachable,
  searchModrinthProjects,
  getCompatibleVersions,
  resolveRequiredDependencies,
  installModrinthFile,
  type ModrinthSearchHit,
  type ModrinthVersion,
  type MissingDependency,
  type ModrinthInstallProgress,
} from "@/lib/modrinth";

// ============================================================
// ModBrowserModal
// ============================================================
// Busca e instala mods/plugins da Modrinth já filtrados pela versão do
// Minecraft e pelo loader do servidor (Forge/NeoForge/Fabric/Paper), com
// checagem de dependência obrigatória antes de instalar. Ver
// src/lib/modrinth.ts para o cliente da API e as decisões de design
// (compatibilidade por versão+loader, não por build exata; registro de
// proveniência local para saber o que já foi instalado por aqui).
// ============================================================

interface ModBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverDir: string;
  serverType: string;
  mcVersion: string;
  onInstalled: () => void;
}

type View = "search" | "detail";

export function ModBrowserModal({ isOpen, onClose, serverDir, serverType, mcVersion, onInstalled }: ModBrowserModalProps) {
  useLockBodyScroll(isOpen);

  const loaderInfo = loaderForServerType(serverType);
  const itemsFolder = loaderInfo?.projectType === "plugin" ? "plugins" : "mods";
  const itemsLabel = loaderInfo?.projectType === "plugin" ? "plugin" : "mod";

  const [reachable, setReachable] = useState<boolean | null>(null);
  const [view, setView] = useState<View>("search");

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ModrinthSearchHit[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selectedProject, setSelectedProject] = useState<ModrinthSearchHit | null>(null);
  const [versions, setVersions] = useState<ModrinthVersion[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");

  const [missingDeps, setMissingDeps] = useState<MissingDependency[]>([]);
  const [checkedDeps, setCheckedDeps] = useState<Set<string>>(new Set());
  const [loadingDeps, setLoadingDeps] = useState(false);

  const [installProgress, setInstallProgress] = useState<ModrinthInstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedOk, setInstalledOk] = useState(false);

  const resetToSearch = () => {
    setView("search");
    setSelectedProject(null);
    setVersions([]);
    setSelectedVersionId("");
    setMissingDeps([]);
    setCheckedDeps(new Set());
    setInstallError(null);
    setInstalledOk(false);
  };

  useEffect(() => {
    if (!isOpen) return;
    resetToSearch();
    setQuery("");
    setHits([]);
    setTotalHits(0);
    setSearchError(null);
    setReachable(null);
    checkModrinthReachable().then(setReachable);
  }, [isOpen]);

  const runSearch = async (offset = 0) => {
    if (!loaderInfo) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await searchModrinthProjects(query, { mcVersion, serverType, offset });
      setHits(offset === 0 ? result.hits : [...hits, ...result.hits]);
      setTotalHits(result.totalHits);
    } catch (err) {
      console.error("[Modrinth] Falha na busca:", err);
      setSearchError("Não foi possível buscar na Modrinth agora. Tente novamente em instantes.");
    } finally {
      setSearching(false);
    }
  };

  const handleSelectProject = async (hit: ModrinthSearchHit) => {
    setSelectedProject(hit);
    setView("detail");
    setVersions([]);
    setSelectedVersionId("");
    setMissingDeps([]);
    setInstallError(null);
    setInstalledOk(false);
    setLoadingVersions(true);
    try {
      const compatible = await getCompatibleVersions(hit.project_id, mcVersion, serverType);
      setVersions(compatible);
      if (compatible.length > 0) setSelectedVersionId(compatible[0].id);
    } catch (err) {
      console.error("[Modrinth] Falha ao buscar versões:", err);
      setInstallError("Não foi possível carregar as versões deste item.");
    } finally {
      setLoadingVersions(false);
    }
  };

  const selectedVersion = versions.find((v) => v.id === selectedVersionId) ?? null;

  useEffect(() => {
    if (!selectedVersion) {
      setMissingDeps([]);
      return;
    }
    let cancelled = false;
    setLoadingDeps(true);
    resolveRequiredDependencies(selectedVersion, serverDir)
      .then((deps) => {
        if (cancelled) return;
        setMissingDeps(deps);
        setCheckedDeps(new Set(deps.map((d) => d.projectId)));
      })
      .catch(() => {
        if (!cancelled) setMissingDeps([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingDeps(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedVersion, serverDir]);

  const toggleDep = (projectId: string) => {
    setCheckedDeps((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const handleInstall = async () => {
    if (!selectedProject || !selectedVersion) return;
    setInstallError(null);
    try {
      const depsToInstall = missingDeps.filter((d) => checkedDeps.has(d.projectId));
      let step = 0;
      const totalSteps = depsToInstall.length + 1;

      for (const dep of depsToInstall) {
        step++;
        const depVersions = await getCompatibleVersions(dep.projectId, mcVersion, serverType);
        if (depVersions.length === 0) {
          pushDiagnostic({
            level: "warning",
            source: "Mods",
            title: `Dependência não disponível: ${dep.title}`,
            message: `Não encontramos uma versão de "${dep.title}" compatível com esta versão do Minecraft/loader. Instale-a manualmente se necessário.`,
          });
          continue;
        }
        await installModrinthFile(depVersions[0], dep.title, serverDir, itemsFolder, (p) =>
          setInstallProgress({ status: `(${step}/${totalSteps}) ${dep.title}: ${p.status}`, percent: Math.round(((step - 1) / totalSteps) * 100 + p.percent / totalSteps) })
        );
      }

      step++;
      await installModrinthFile(selectedVersion, selectedProject.title, serverDir, itemsFolder, (p) =>
        setInstallProgress({ status: `(${step}/${totalSteps}) ${selectedProject.title}: ${p.status}`, percent: Math.round(((step - 1) / totalSteps) * 100 + p.percent / totalSteps) })
      );

      setInstallProgress(null);
      setInstalledOk(true);
      onInstalled();
    } catch (err) {
      console.error("[Modrinth] Falha ao instalar:", err);
      setInstallProgress(null);
      setInstallError(String(err));
      pushDiagnostic({ level: "error", source: "Mods", title: `Erro ao instalar ${itemsLabel}`, message: String(err) });
    }
  };

  const handleClose = () => {
    if (installProgress) return;
    onClose();
  };

  if (!loaderInfo) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-2xl max-h-[85vh] bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 flex flex-col gap-5"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-800/40 rounded-lg flex items-center justify-center">
                  <PackagePlus className="text-indigo-700 dark:text-indigo-300 w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-theme-primary">Buscar Mods Online</h3>
                  <p className="text-[11px] text-theme-secondary">
                    {loaderInfo.loader.charAt(0).toUpperCase() + loaderInfo.loader.slice(1)} · Minecraft {mcVersion} · via Modrinth
                  </p>
                </div>
              </div>
              {!installProgress && (
                <button
                  onClick={handleClose}
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
              </div>
            ) : reachable === false ? (
              <div className="py-12 flex flex-col items-center gap-3 text-center">
                <WifiOff className="w-8 h-8 text-theme-secondary" />
                <p className="text-sm font-semibold text-theme-primary">Sem conexão com a Modrinth</p>
                <p className="text-xs text-theme-secondary max-w-sm">
                  Não conseguimos alcançar a Modrinth agora. Verifique sua internet e tente novamente — a gestão dos mods
                  já instalados continua funcionando normalmente.
                </p>
                <button
                  type="button"
                  onClick={() => checkModrinthReachable().then(setReachable)}
                  className="h-9 px-4 bg-theme-muted hover:bg-theme-card border border-theme-card rounded-xl text-xs font-bold text-theme-secondary hover:text-indigo-600 transition-colors cursor-pointer"
                >
                  Tentar novamente
                </button>
              </div>
            ) : reachable === null ? (
              <div className="py-12 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
              </div>
            ) : view === "search" ? (
              <div className="flex flex-col gap-4 min-h-0 overflow-hidden">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    runSearch(0);
                  }}
                  className="flex gap-2"
                >
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Buscar ${itemsLabel}s (ex: Sodium, WorldEdit...)`}
                    className="flex-1 h-11 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={searching}
                    className="h-11 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl flex items-center gap-1.5 text-sm font-bold transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  </button>
                </form>

                <div className="overflow-y-auto custom-scrollbar space-y-2 min-h-[200px]">
                  {searchError ? (
                    <div className="text-center py-10 text-rose-500 text-sm">{searchError}</div>
                  ) : hits.length === 0 ? (
                    <div className="text-center py-10 text-theme-secondary text-sm">
                      {searching ? (
                        <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                      ) : (
                        <>Busque um {itemsLabel} compatível com este servidor.</>
                      )}
                    </div>
                  ) : (
                    <>
                      {hits.map((hit) => (
                        <button
                          key={hit.project_id}
                          type="button"
                          onClick={() => handleSelectProject(hit)}
                          className="w-full flex items-center gap-3 bg-theme-muted hover:bg-theme-card border border-theme-card rounded-2xl px-4 py-3 text-left transition-colors cursor-pointer"
                        >
                          {hit.icon_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={hit.icon_url} alt="" className="w-10 h-10 rounded-lg flex-shrink-0 object-cover" />
                          ) : (
                            <div className="w-10 h-10 rounded-lg bg-theme-card border border-theme-card flex items-center justify-center flex-shrink-0">
                              <Blocks className="w-5 h-5 text-theme-secondary" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-theme-primary truncate">{hit.title}</p>
                            <p className="text-[11px] text-theme-secondary truncate">{hit.description}</p>
                          </div>
                          <div className="text-[10px] font-bold text-theme-secondary flex-shrink-0">
                            {hit.downloads.toLocaleString("pt-BR")} downloads
                          </div>
                        </button>
                      ))}
                      {hits.length < totalHits && (
                        <button
                          type="button"
                          onClick={() => runSearch(hits.length)}
                          disabled={searching}
                          className="w-full h-9 rounded-xl text-xs font-bold text-theme-secondary hover:text-indigo-600 hover:bg-theme-muted transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {searching ? "Carregando..." : "Carregar mais"}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              selectedProject && (
                <div className="flex flex-col gap-4 min-h-0 overflow-y-auto custom-scrollbar">
                  <button
                    type="button"
                    onClick={resetToSearch}
                    className="flex items-center gap-1.5 text-xs font-bold text-theme-secondary hover:text-indigo-600 transition-colors cursor-pointer w-fit"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" /> Voltar à busca
                  </button>

                  <div className="flex items-center gap-3">
                    {selectedProject.icon_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={selectedProject.icon_url} alt="" className="w-12 h-12 rounded-xl flex-shrink-0 object-cover" />
                    ) : (
                      <div className="w-12 h-12 rounded-xl bg-theme-muted border border-theme-card flex items-center justify-center flex-shrink-0">
                        <Blocks className="w-6 h-6 text-theme-secondary" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-base font-bold text-theme-primary truncate">{selectedProject.title}</p>
                      <p className="text-xs text-theme-secondary truncate">{selectedProject.description}</p>
                    </div>
                  </div>

                  {installedOk ? (
                    <div className="py-8 flex flex-col items-center gap-2 text-center">
                      <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                      <p className="text-sm font-bold text-theme-primary">
                        {selectedProject.title} instalado com sucesso.
                      </p>
                      <p className="text-xs text-theme-secondary">Reinicie o servidor para aplicar as mudanças.</p>
                    </div>
                  ) : loadingVersions ? (
                    <div className="py-8 flex justify-center">
                      <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                    </div>
                  ) : versions.length === 0 ? (
                    <div className="p-4 bg-theme-warning border border-theme-warning text-amber-800 dark:text-amber-200 rounded-xl text-xs flex items-center gap-2.5">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      Nenhuma versão compatível com Minecraft {mcVersion} + {loaderInfo.loader} foi encontrada para este {itemsLabel}.
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Versão</label>
                        <select
                          value={selectedVersionId}
                          onChange={(e) => setSelectedVersionId(e.target.value)}
                          className="w-full h-11 px-4 border border-theme-card rounded-2xl focus:border-indigo-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent cursor-pointer"
                        >
                          {versions.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name || v.version_number}
                            </option>
                          ))}
                        </select>
                      </div>

                      {loadingDeps ? (
                        <div className="flex items-center gap-2 text-xs text-theme-secondary">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checando dependências...
                        </div>
                      ) : missingDeps.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs font-bold text-theme-secondary uppercase tracking-wide">
                            Dependências não detectadas
                          </p>
                          <div className="space-y-1.5">
                            {missingDeps.map((dep) => (
                              <label
                                key={dep.projectId}
                                className="flex items-center gap-2.5 bg-theme-muted border border-theme-card rounded-xl px-3 py-2 text-sm cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={checkedDeps.has(dep.projectId)}
                                  onChange={() => toggleDep(dep.projectId)}
                                  className="w-4 h-4 rounded accent-indigo-600 cursor-pointer"
                                />
                                <span className="text-theme-primary font-semibold">{dep.title}</span>
                              </label>
                            ))}
                          </div>
                          <p className="text-[11px] text-theme-secondary italic">
                            Não detectamos essas dependências entre os mods instalados por este navegador — se você já as
                            instalou manualmente, pode desmarcar.
                          </p>
                        </div>
                      ) : null}

                      {installError && (
                        <div className="p-3 bg-theme-danger border border-theme-danger text-rose-800 dark:text-rose-200 rounded-xl text-xs">
                          {installError}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={handleInstall}
                        disabled={!selectedVersion}
                        className="h-11 px-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-40 cursor-pointer shadow-md shadow-theme-shadow"
                      >
                        <Download className="w-4 h-4" /> Instalar
                      </button>
                    </>
                  )}
                </div>
              )
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
