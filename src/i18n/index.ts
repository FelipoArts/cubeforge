import { createElement, Fragment, useSyncExternalStore, type ReactNode } from "react";
import { ptBR, en, type MessageKey } from "./messages";

// ============================================================
// i18n do Cubicase
// ============================================================
// Runtime 100% no cliente (o app é Next `output: 'export'` numa webview do
// Tauri, sem servidor nem rotas por idioma). Sem dependências externas.
//
//  - `t(chave, vars)`        → uso em qualquer lugar (lib/*, handlers, etc.)
//  - `useT()`                → uso em componentes; re-renderiza ao trocar idioma
//  - preferência do usuário  → "auto" | "pt-BR" | "en" (localStorage próprio,
//                              independente do store Zustand principal)
//
// Adicionar um idioma novo: incluir a chave "xx" em cada módulo de ./messages,
// em Locale/DICTIONARIES/SUPPORTED_LOCALES e mapear o prefixo em detectLocale().
// ============================================================

export type Locale = "pt-BR" | "en";
export type LanguagePreference = "auto" | Locale;
export type { MessageKey };

export const SUPPORTED_LOCALES: readonly Locale[] = ["pt-BR", "en"];
export const DEFAULT_LOCALE: Locale = "pt-BR";
const STORAGE_KEY = "cubicase-language";

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { "pt-BR": ptBR, en };

// Chaves de plural terminam em _one/_other; o chamador usa a chave base.
type PluralSuffix = "_one" | "_other";
export type TKey = MessageKey extends infer K
  ? K extends `${infer B}${PluralSuffix}` ? B : K
  : never;
export type TVars = Record<string, string | number>;

/** Mapeia o idioma do sistema/navegador para um locale suportado. */
export function detectLocale(languages?: readonly string[]): Locale {
  const list =
    languages ??
    (typeof navigator !== "undefined"
      ? navigator.languages?.length ? navigator.languages : [navigator.language]
      : []);
  for (const raw of list) {
    const lang = (raw || "").toLowerCase();
    if (lang.startsWith("pt")) return "pt-BR";
    if (lang.startsWith("en")) return "en";
  }
  // Idioma desconhecido: inglês é o fallback para quem não fala PT.
  return list.length > 0 ? "en" : DEFAULT_LOCALE;
}

export function resolveLocale(pref: LanguagePreference, languages?: readonly string[]): Locale {
  return pref === "auto" ? detectLocale(languages) : pref;
}

function readPreference(): LanguagePreference {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (v === "auto" || v === "pt-BR" || v === "en") return v;
  } catch { /* storage indisponível */ }
  return "auto";
}

let preference: LanguagePreference = readPreference();
let current: Locale = resolveLocale(preference);
const listeners = new Set<() => void>();
let nativeSync: ((l: Locale) => void) | null = null;

// Mantém <html lang>, <title> e <meta name="description"> alinhados ao idioma efetivo.
function applyDocumentLang() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = current;
  document.title = translate(current, "meta.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", translate(current, "meta.description"));
}
// Executa após o módulo inteiro ser avaliado (translate/DICTIONARIES ainda não existem neste ponto).
queueMicrotask(applyDocumentLang);

export function getLocale(): Locale { return current; }
export function getLanguagePreference(): LanguagePreference { return preference; }

export function setLanguagePreference(pref: LanguagePreference) {
  preference = pref;
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* ignore */ }
  current = resolveLocale(pref);
  applyDocumentLang();
  listeners.forEach((l) => l());
  nativeSync?.(current);
}

/**
 * Registra um callback que recebe o locale efetivo (agora e a cada troca).
 * Usado para avisar o backend Tauri (tray, mensagens nativas) sem acoplar este
 * módulo ao Tauri — assim continua testável em node.
 */
export function registerNativeSync(fn: (l: Locale) => void) {
  nativeSync = fn;
  fn(current);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

export function translate(locale: Locale, key: TKey, vars?: TVars): string {
  const dict = DICTIONARIES[locale] as Record<string, string>;
  let k: string = key;
  if (vars && typeof vars.count === "number") {
    const form = new Intl.PluralRules(locale).select(vars.count) === "one" ? "_one" : "_other";
    if (`${key}${form}` in dict) k = `${key}${form}`;
    else if (`${key}_other` in dict) k = `${key}_other`;
  }
  const msg = dict[k] ?? (ptBR as Record<string, string>)[k] ?? key;
  return interpolate(msg, vars);
}

/**
 * Tradução com elementos React nas variáveis (ex.: <strong>{nome}</strong>).
 * Uso: rich("chave", { name: <strong>{x}</strong> }) — o restante do texto
 * é mantido como string, sem dangerouslySetInnerHTML.
 */
export function translateRich(locale: Locale, key: TKey, vars: Record<string, ReactNode>): ReactNode {
  const msg = translate(locale, key, typeof vars.count === "number" ? { count: vars.count } : undefined);
  const parts = msg.split(/(\{\w+\})/g);
  return createElement(
    Fragment,
    null,
    ...parts.map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part);
      return m && m[1] in vars ? createElement(Fragment, { key: i }, vars[m[1]]) : part;
    })
  );
}

/** Tradução fora de componentes React (usa o idioma atual). */
export function t(key: TKey, vars?: TVars): string {
  return translate(current, key, vars);
}

/** Hook para componentes: re-renderiza quando o idioma muda. */
export function useT() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => DEFAULT_LOCALE);
  return {
    t: (key: TKey, vars?: TVars) => translate(locale, key, vars),
    rich: (key: TKey, vars: Record<string, ReactNode>) => translateRich(locale, key, vars),
    locale,
  };
}

export function useLanguagePreference(): [LanguagePreference, (p: LanguagePreference) => void] {
  const pref = useSyncExternalStore(subscribe, getLanguagePreference, () => "auto" as LanguagePreference);
  return [pref, setLanguagePreference];
}

// ---- Formatação sensível ao idioma ----
export const formatNumber = (n: number, opts?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(current, opts).format(n);
export const formatDateTime = (d: Date | string | number, opts?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(current, opts ?? { dateStyle: "short", timeStyle: "short" }).format(new Date(d));
