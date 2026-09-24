import common from "./common";
import settings from "./settings";
import app from "./app";
import shell from "./shell";
import hostBasics from "./hostBasics";
import libDiagnostics from "./libDiagnostics";
import libErrors from "./libErrors";
import crash from "./crash";
import modSyncUi from "./modSyncUi";
import modpackUi from "./modpackUi";
import serverConfig from "./serverConfig";
import createServer from "./createServer";
import modBrowser from "./modBrowser";
import manage from "./manage";
import players from "./players";
import hostView from "./hostView";
import hostInstall from "./hostInstall";
import guest from "./guest";
import serverLib from "./serverLib";
import serverLog from "./serverLog";
import meta from "./meta";

// Registre aqui cada novo módulo de mensagens.
export const MODULES = { common, settings, app, shell, hostBasics, libDiagnostics, libErrors, crash, modSyncUi, modpackUi, serverConfig, createServer, modBrowser, manage, players, hostView, hostInstall, guest, serverLib, serverLog, meta } as const;

type Modules = (typeof MODULES)[keyof typeof MODULES];
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

export type MessageKey = keyof UnionToIntersection<Modules["pt-BR"]> & string;

function merge(locale: "pt-BR" | "en"): Record<MessageKey, string> {
  return Object.assign({}, ...Object.values(MODULES).map((m) => m[locale]));
}

export const ptBR = merge("pt-BR");
export const en = merge("en");
