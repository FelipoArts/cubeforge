"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, X, Loader2, ChevronRight, Server, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { pushDiagnostic } from "@/app/diagnostics";
import {
  fetchVersionManifest,
  getRecommendedVersions,
  getPopularVersions,
  getAllReleaseVersions,
  searchVersions,
  getJavaVersion,
  getForgeVersions,
  getFabricLoaderVersions,
  getPaperBuilds,
  type VersionManifest,
  type ServerInstallProgress,
  type ForgeBuild,
  type FabricLoaderBuild,
  type PaperBuild,
} from "@/lib/server";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";

// ============================================================
// CreateServerModal
// ============================================================
// Modal para criar um novo servidor Minecraft: Vanilla, Forge/NeoForge,
// Fabric ou Paper. Inclui seletor de versão com busca, seletor de
// build/loader conforme o tipo, slider de RAM e barra de progresso.
// ============================================================

type UiServerType = "vanilla" | "forge" | "fabric" | "paper";

interface CreateServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (
    name: string,
    version: string,
    ram: number,
    serverType?: "vanilla" | "forge" | "neoforge" | "fabric" | "paper",
    // Forge/NeoForge: versão do Forge. Fabric: versão do loader. Paper: número da build (como string).
    extraVersion?: string
  ) => Promise<void>;
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
  useLockBodyScroll(isOpen);

  const [serverName, setServerName] = useState("");
  const [serverVersion, setServerVersion] = useState("1.20.1");
  const [serverRam, setServerRam] = useState(4);
  const [serverType, setServerType] = useState<UiServerType>("vanilla");
  const [forgeBuilds, setForgeBuilds] = useState<ForgeBuild[]>([]);
  const [selectedForgeBuild, setSelectedForgeBuild] = useState<string>("");
  const [forgeVersionsLoading, setForgeVersionsLoading] = useState(false);
  const [fabricBuilds, setFabricBuilds] = useState<FabricLoaderBuild[]>([]);
  const [selectedFabricLoader, setSelectedFabricLoader] = useState<string>("");
  const [fabricVersionsLoading, setFabricVersionsLoading] = useState(false);
  const [paperBuilds, setPaperBuilds] = useState<PaperBuild[]>([]);
  const [selectedPaperBuild, setSelectedPaperBuild] = useState<number | null>(null);
  const [paperVersionsLoading, setPaperVersionsLoading] = useState(false);
  const [versionManifest, setVersionManifest] = useState<VersionManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [versionDropdownOpen, setVersionDropdownOpen] = useState(false);
  const [versionSearchQuery, setVersionSearchQuery] = useState("");
  const [showAllVersions, setShowAllVersions] = useState(false);
  const versionDropdownRef = useRef<HTMLDivElement>(null);

  // Carregar versões Forge quando tipo = forge e versão mudar
  useEffect(() => {
    if (!isOpen || serverType !== "forge") return;
    (async () => {
      setForgeVersionsLoading(true);
      try {
        const builds = await getForgeVersions(serverVersion);
        setForgeBuilds(builds);
        const recommended = builds.find(b => b.recommended);
        if (recommended) {
          setSelectedForgeBuild(recommended.forgeVersion);
        } else if (builds.length > 0) {
          setSelectedForgeBuild(builds[0].forgeVersion);
        } else {
          setSelectedForgeBuild("");
        }
      } catch (err) {
        console.warn("Falha ao carregar versões Forge:", err);
        setForgeBuilds([]);
      } finally {
        setForgeVersionsLoading(false);
      }
    })();
  }, [isOpen, serverType, serverVersion]);

  // Carregar versões do Fabric Loader quando tipo = fabric e versão mudar
  useEffect(() => {
    if (!isOpen || serverType !== "fabric") return;
    (async () => {
      setFabricVersionsLoading(true);
      try {
        const builds = await getFabricLoaderVersions(serverVersion);
        setFabricBuilds(builds);
        const recommended = builds.find(b => b.stable);
        if (recommended) {
          setSelectedFabricLoader(recommended.loaderVersion);
        } else if (builds.length > 0) {
          setSelectedFabricLoader(builds[0].loaderVersion);
        } else {
          setSelectedFabricLoader("");
        }
      } catch (err) {
        console.warn("Falha ao carregar versões do Fabric:", err);
        setFabricBuilds([]);
      } finally {
        setFabricVersionsLoading(false);
      }
    })();
  }, [isOpen, serverType, serverVersion]);

  // Carregar builds do Paper quando tipo = paper e versão mudar
  useEffect(() => {
    if (!isOpen || serverType !== "paper") return;
    (async () => {
      setPaperVersionsLoading(true);
      try {
        const builds = await getPaperBuilds(serverVersion);
        setPaperBuilds(builds);
        const recommended = builds.find(b => b.recommended);
        if (recommended) {
          setSelectedPaperBuild(recommended.build);
        } else if (builds.length > 0) {
          setSelectedPaperBuild(builds[0].build);
        } else {
          setSelectedPaperBuild(null);
        }
      } catch (err) {
        console.warn("Falha ao carregar builds do Paper:", err);
        setPaperBuilds([]);
      } finally {
        setPaperVersionsLoading(false);
      }
    })();
  }, [isOpen, serverType, serverVersion]);

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
      setServerType("vanilla");
      setForgeBuilds([]);
      setSelectedForgeBuild("");
      setFabricBuilds([]);
      setSelectedFabricLoader("");
      setPaperBuilds([]);
      setSelectedPaperBuild(null);
    }
  }, [isOpen]);

  const typeLabel =
    serverType === "forge"
      ? (forgeBuilds.find(b => b.forgeVersion === selectedForgeBuild)?.provider === "neoforge" ? "NeoForge" : "Forge")
      : serverType === "fabric"
      ? "Fabric"
      : serverType === "paper"
      ? "Paper"
      : "Vanilla";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverName.trim()) return;
    const cleanName = serverName.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    if (serverType === "forge") {
      if (!selectedForgeBuild) {
        pushDiagnostic({ level: "warning", source: "Instalação", title: "Versão do Forge não selecionada", message: "Selecione uma versão do Forge." });
        return;
      }
      // A build pode ter vindo do provider Forge clássico ou do NeoForge — o formato
      // da URL de instalação é diferente entre os dois, então é preciso mandar o
      // provider certo, não assumir sempre "forge".
      const build = forgeBuilds.find(b => b.forgeVersion === selectedForgeBuild);
      await onCreate(cleanName, serverVersion, serverRam, build?.provider ?? "forge", selectedForgeBuild);
    } else if (serverType === "fabric") {
      if (!selectedFabricLoader) {
        pushDiagnostic({ level: "warning", source: "Instalação", title: "Versão do Fabric não selecionada", message: "Selecione uma versão do Fabric Loader." });
        return;
      }
      await onCreate(cleanName, serverVersion, serverRam, "fabric", selectedFabricLoader);
    } else if (serverType === "paper") {
      if (selectedPaperBuild === null) {
        pushDiagnostic({ level: "warning", source: "Instalação", title: "Build do Paper não selecionada", message: "Selecione uma build do Paper." });
        return;
      }
      await onCreate(cleanName, serverVersion, serverRam, "paper", String(selectedPaperBuild));
    } else {
      await onCreate(cleanName, serverVersion, serverRam);
    }
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

                {/* Tipo de Servidor */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Tipo do Servidor</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setServerType("vanilla")}
                      className={cn(
                        "h-10 rounded-xl text-xs font-bold transition-all border cursor-pointer",
                        serverType === "vanilla"
                          ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                          : "bg-transparent text-theme-secondary border-theme-card hover:border-emerald-300"
                      )}
                    >
                      🟢 Vanilla
                    </button>
                    <button
                      type="button"
                      onClick={() => setServerType("forge")}
                      className={cn(
                        "h-10 rounded-xl text-xs font-bold transition-all border cursor-pointer",
                        serverType === "forge"
                          ? "bg-amber-600 text-white border-amber-600 shadow-sm"
                          : "bg-transparent text-theme-secondary border-theme-card hover:border-amber-300"
                      )}
                    >
                      🟠 Forge
                    </button>
                    <button
                      type="button"
                      onClick={() => setServerType("fabric")}
                      className={cn(
                        "h-10 rounded-xl text-xs font-bold transition-all border cursor-pointer",
                        serverType === "fabric"
                          ? "bg-purple-600 text-white border-purple-600 shadow-sm"
                          : "bg-transparent text-theme-secondary border-theme-card hover:border-purple-300"
                      )}
                    >
                      🧵 Fabric
                    </button>
                    <button
                      type="button"
                      onClick={() => setServerType("paper")}
                      className={cn(
                        "h-10 rounded-xl text-xs font-bold transition-all border cursor-pointer",
                        serverType === "paper"
                          ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                          : "bg-transparent text-theme-secondary border-theme-card hover:border-blue-300"
                      )}
                    >
                      📄 Paper
                    </button>
                  </div>
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
                      <span>{typeLabel} {serverVersion}</span>
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
                                  <span>{typeLabel} {id}</span>
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
                      Minecraft {serverVersion} • Java {getJavaVersion(serverVersion)} •{" "}
                      {serverType === "forge"
                        ? `${typeLabel} ${selectedForgeBuild || "..."}`
                        : serverType === "fabric"
                        ? `Fabric ${selectedFabricLoader || "..."}`
                        : serverType === "paper"
                        ? `Paper build ${selectedPaperBuild ?? "..."}`
                        : "Vanilla"}
                    </div>
                  )}
                </div>

                {/* Seletor de build Forge (só aparece quando tipo = forge) */}
                {serverType === "forge" && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Versão do Forge</label>
                    {forgeVersionsLoading ? (
                      <div className="flex items-center gap-2 px-4 py-3 border border-theme-card rounded-2xl text-sm text-theme-secondary">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Carregando versões do Forge...
                      </div>
                    ) : forgeBuilds.length === 0 ? (
                      <div className="px-4 py-3 border border-theme-card rounded-2xl text-sm text-theme-secondary italic">
                        Nenhuma versão do Forge encontrada para {serverVersion}.
                      </div>
                    ) : (
                      <div className="max-h-40 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                        {forgeBuilds.map((build, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setSelectedForgeBuild(build.forgeVersion)}
                            className={cn(
                              "w-full px-4 py-2.5 text-left text-sm transition-colors rounded-xl border flex items-center justify-between",
                              selectedForgeBuild === build.forgeVersion
                                ? "bg-amber-100 dark:bg-amber-900/30 border-amber-300 text-amber-800 dark:text-amber-200 font-semibold"
                                : "border-theme-card text-theme-primary hover:bg-theme-accent"
                            )}
                          >
                            <span>
                              {build.recommended && <span className="mr-1">⭐</span>}
                              {build.provider === "neoforge" ? "NeoForge" : "Forge"} {build.forgeVersion}
                            </span>
                            <span className="text-[10px] text-theme-secondary font-mono">
                              Build {build.build}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Seletor de loader Fabric (só aparece quando tipo = fabric) */}
                {serverType === "fabric" && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Versão do Fabric Loader</label>
                    {fabricVersionsLoading ? (
                      <div className="flex items-center gap-2 px-4 py-3 border border-theme-card rounded-2xl text-sm text-theme-secondary">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Carregando versões do Fabric...
                      </div>
                    ) : fabricBuilds.length === 0 ? (
                      <div className="px-4 py-3 border border-theme-card rounded-2xl text-sm text-theme-secondary italic">
                        Nenhuma versão do Fabric encontrada para {serverVersion}.
                      </div>
                    ) : (
                      <div className="max-h-40 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                        {fabricBuilds.map((build, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setSelectedFabricLoader(build.loaderVersion)}
                            className={cn(
                              "w-full px-4 py-2.5 text-left text-sm transition-colors rounded-xl border flex items-center justify-between",
                              selectedFabricLoader === build.loaderVersion
                                ? "bg-purple-100 dark:bg-purple-900/30 border-purple-300 text-purple-800 dark:text-purple-200 font-semibold"
                                : "border-theme-card text-theme-primary hover:bg-theme-accent"
                            )}
                          >
                            <span>
                              {build.stable && <span className="mr-1">⭐</span>}
                              Fabric Loader {build.loaderVersion}
                            </span>
                            <span className="text-[10px] text-theme-secondary font-mono">
                              {build.stable ? "Estável" : "Beta"}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Seletor de build Paper (só aparece quando tipo = paper) */}
                {serverType === "paper" && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Build do Paper</label>
                    {paperVersionsLoading ? (
                      <div className="flex items-center gap-2 px-4 py-3 border border-theme-card rounded-2xl text-sm text-theme-secondary">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Carregando builds do Paper...
                      </div>
                    ) : paperBuilds.length === 0 ? (
                      <div className="px-4 py-3 border border-theme-card rounded-2xl text-sm text-theme-secondary italic">
                        Nenhuma build do Paper encontrada para {serverVersion}.
                      </div>
                    ) : (
                      <div className="max-h-40 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                        {paperBuilds.slice(0, 25).map((build) => (
                          <button
                            key={build.build}
                            type="button"
                            onClick={() => setSelectedPaperBuild(build.build)}
                            className={cn(
                              "w-full px-4 py-2.5 text-left text-sm transition-colors rounded-xl border flex items-center justify-between",
                              selectedPaperBuild === build.build
                                ? "bg-blue-100 dark:bg-blue-900/30 border-blue-300 text-blue-800 dark:text-blue-200 font-semibold"
                                : "border-theme-card text-theme-primary hover:bg-theme-accent"
                            )}
                          >
                            <span>
                              {build.recommended && <span className="mr-1">⭐</span>}
                              Paper build {build.build}
                            </span>
                            <span className="text-[10px] text-theme-secondary font-mono">
                              {build.channel === "STABLE" ? "Estável" : build.channel}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

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
