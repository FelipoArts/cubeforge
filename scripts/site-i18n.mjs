// i18n do site (docs/): valida a cobertura do dicionário e gera as páginas estáticas /en/.
//
//   node scripts/site-i18n.mjs          → gera docs/en/** e valida
//   node scripts/site-i18n.mjs --check  → só valida (usado no teste e no CI)
//
// Páginas "estáticas" (marketing, indexáveis): index e download → ganham cópia em /en/.
// Páginas "de runtime" (entrar, painel, obrigado, assinatura): traduzidas no navegador (assets/i18n.js),
// na mesma URL; aqui só validamos que todo texto delas está no dicionário.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");

export const STATIC_PAGES = ["index.html", "download/index.html"];
export const RUNTIME_PAGES = ["entrar/index.html", "obrigado/index.html", "assinatura/sucesso/index.html", "painel/index.html"];

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&hellip;": "…", "&nbsp;": " ", "&#10;": "\n", "&mdash;": "—" };
const decode = (s) => s.replace(/&(?:#\d+|\w+);/g, (m) => ENTITIES[m] ?? m);
const norm = (s) => s.replace(/\s+/g, " ").trim();
const NEEDS_TRANSLATION = /[A-Za-zÀ-ú]{3}/;

export function loadDictionary() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(DOCS, "assets/i18n/en.js"), "utf8"), ctx);
  return ctx.window.CUBICASE_I18N;
}

function translate(dict, key) {
  if (Object.prototype.hasOwnProperty.call(dict.en, key)) return dict.en[key];
  for (const [re, rep] of dict.patterns ?? []) {
    const r = new RegExp(re, "s");
    if (r.test(key)) return key.replace(r, rep);
  }
  return null;
}

const META_RE = /<meta\s+(?:name="description"|property="og:title"|property="og:description")\s+content="([^"]*)"\s*\/?>/gi;

/** Strings traduzíveis de uma página (texto, atributos, <title>, metas) — sem o conteúdo de <script>/<style>. */
export function extractStrings(html) {
  const found = new Set();
  const add = (raw) => { const k = norm(decode(raw)); if (NEEDS_TRANSLATION.test(k)) found.add(k); };
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const title = /<title>([\s\S]*?)<\/title>/i.exec(body);
  if (title) add(title[1]);
  for (const m of body.matchAll(META_RE)) add(m[1]);
  for (const m of body.matchAll(/\b(?:alt|title|placeholder|aria-label)="([^"]*)"/gi)) add(m[1]);
  for (const m of body.matchAll(/>([^<>]+)</g)) add(m[1]);
  return found;
}

/** Chamadas i18n.t("...") do JS embutido. */
export function extractRuntimeKeys(html) {
  const keys = new Set();
  for (const m of html.matchAll(/i18n\.t\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) {
    try { keys.add(norm(JSON.parse(m[1].startsWith('"') ? m[1] : `"${m[1].slice(1, -1).replace(/"/g, '\\"')}"`))); } catch { /* literal exótico */ }
  }
  return keys;
}

export function checkSite() {
  const dict = loadDictionary();
  const missing = [];
  for (const page of [...STATIC_PAGES, ...RUNTIME_PAGES]) {
    const html = fs.readFileSync(path.join(DOCS, page), "utf8");
    for (const key of extractStrings(html)) if (translate(dict, key) === null) missing.push(`${page}: ${key}`);
    for (const key of extractRuntimeKeys(html)) if (translate(dict, key) === null) missing.push(`${page} (i18n.t): ${key}`);
  }
  return missing;
}

function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function buildEnglishPage(html, dict, page) {
  const tr = (raw) => { const en = translate(dict, norm(decode(raw))); return en === null ? null : en; };
  let out = html;
  // <title>
  out = out.replace(/(<title>)([\s\S]*?)(<\/title>)/i, (m, a, t, c) => { const en = tr(t); return en ? a + escapeHtml(en) + c : m; });
  // metas
  out = out.replace(META_RE, (m, content) => { const en = tr(content); return en ? m.replace(`content="${content}"`, `content="${escapeAttr(en)}"`) : m; });
  // atributos
  out = out.replace(/\b(alt|title|placeholder|aria-label)="([^"]*)"/gi, (m, name, v) => { const en = tr(v); return en ? `${name}="${escapeAttr(en)}"` : m; });
  // texto (fora de <script>/<style>)
  out = out.replace(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)|>([^<>]+)</g, (m, block, text) => {
    if (block) return block;
    const en = tr(text);
    if (en === null) return m;
    const lead = /^\s*/.exec(text)[0], trail = /\s*$/.exec(text)[0];
    return `>${lead}${escapeHtml(en)}${trail}<`;
  });
  // idioma, links internos e og:locale
  out = out.replace('<html lang="pt-BR">', '<html lang="en">');
  out = out.replace(/href="\/(?!assets\/|en\/)([^"]*)"/g, (m, rest) => (rest === "" || rest.endsWith("/") ? `href="/en/${rest}"` : m));
  out = out.replace(/(<meta property="og:type"[^>]*>)/, `$1\n  <meta property="og:locale" content="en_US" />`);
  return out;
}

export function buildSite() {
  const dict = loadDictionary();
  const written = [];
  for (const page of STATIC_PAGES) {
    const html = fs.readFileSync(path.join(DOCS, page), "utf8").replace(/\r\n/g, "\n");
    const target = path.join(DOCS, "en", page);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildEnglishPage(html, dict, page));
    written.push(path.relative(ROOT, target));
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const missing = checkSite();
  if (missing.length) {
    console.error(`Faltam ${missing.length} tradução(ões) em docs/assets/i18n/en.js:\n` + missing.map((m) => "  - " + m).join("\n"));
    process.exit(1);
  }
  if (!process.argv.includes("--check")) console.log("Geradas:\n" + buildSite().map((f) => "  " + f).join("\n"));
  else console.log("Dicionário do site completo.");
}
