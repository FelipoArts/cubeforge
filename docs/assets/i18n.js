// ============================================================
// Cubicase — i18n do site (pt-BR ↔ en)
// ============================================================
// - Idioma: ?lang=xx (e guarda) > preferência salva > idioma do navegador.
// - Páginas de marketing têm versão estática em /en/ (SEO); aqui só decidimos o
//   redirecionamento e montamos o seletor de idioma.
// - Páginas de fluxo (entrar, painel, obrigado, assinatura) são traduzidas em
//   runtime, na MESMA URL — os redirects de login (OAuth/magic link) continuam
//   apontando pra mesma página. <html data-i18n="runtime"> liga esse modo.
// - Dicionário: assets/i18n/en.js (chave = texto pt-BR normalizado).
//   scripts/site-i18n.mjs valida a cobertura e gera as páginas /en/.
// ============================================================
(function () {
  "use strict";

  var STORE = "cubicase-lang";
  var dict = (window.CUBICASE_I18N && window.CUBICASE_I18N.en) || {};
  var patterns = ((window.CUBICASE_I18N && window.CUBICASE_I18N.patterns) || []).map(function (p) {
    return [new RegExp(p[0], "s"), p[1]];
  });
  var root = document.documentElement;

  function norm(s) { return String(s).replace(/\s+/g, " ").trim(); }
  function getStored() { try { var v = localStorage.getItem(STORE); return v === "pt" || v === "en" ? v : null; } catch (e) { return null; } }
  function setStored(v) { try { localStorage.setItem(STORE, v); } catch (e) { /* storage indisponível */ } }

  function detect() {
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
    for (var i = 0; i < list.length; i++) {
      var l = String(list[i]).toLowerCase();
      if (l.indexOf("pt") === 0) return "pt";
      if (l.indexOf("en") === 0) return "en";
    }
    return list.length && list[0] ? "en" : "pt"; // idioma desconhecido → inglês
  }

  // ?lang=en|pt escolhe (e guarda) o idioma — usado, por ex., pelo app ao abrir /entrar/.
  var fromQuery = null;
  try {
    var q = new URLSearchParams(location.search).get("lang");
    if (q === "pt" || q === "en") { fromQuery = q; setStored(q); }
  } catch (e) { /* ignore */ }

  var stored = getStored();
  var desired = fromQuery || stored || detect();
  var pageLang = (root.getAttribute("lang") || "pt").toLowerCase().indexOf("en") === 0 ? "en" : "pt";
  var isRuntime = root.getAttribute("data-i18n") === "runtime";
  // Evita o "flash" em português nas páginas de runtime quando o idioma é inglês
  // (regra em style.css); a classe sai assim que a tradução é aplicada (ou após 2s).
  if (isRuntime && desired === "en") {
    root.classList.add("i18n-pending");
    setTimeout(function () { root.classList.remove("i18n-pending"); }, 2000);
  }

  // Idioma efetivo da página atual: páginas estáticas têm o idioma fixo; as de runtime seguem o desejado.
  var lang = isRuntime ? desired : pageLang;

  // ---------- Redirecionamento entre versões estáticas (marketing) ----------
  function alternate(hreflang) {
    var el = document.querySelector('link[rel="alternate"][hreflang="' + hreflang + '"]');
    return el ? el.getAttribute("href") : null;
  }
  if (!isRuntime) {
    var target = null;
    if (pageLang === "pt" && desired === "en") target = alternate("en");
    else if (pageLang === "en" && stored === "pt") target = alternate("pt-BR"); // só quando a pessoa escolheu PT explicitamente
    // Nunca redireciona para a própria URL (evita loop se o alternate estiver errado).
    if (target && new URL(target, location.href).pathname !== location.pathname) { location.replace(target + location.search + location.hash); return; }
  }

  // ---------- Tradução ----------
  function translateString(pt) {
    var key = norm(pt);
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i][0].test(key)) return key.replace(patterns[i][0], patterns[i][1]);
    }
    return null;
  }

  function interpolate(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, function (m, name) { return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m; });
  }

  // t("texto em pt com {param}", { param }) — devolve o texto no idioma efetivo.
  function t(pt, params) {
    var out = pt;
    if (lang === "en") {
      var en = translateString(pt);
      if (en !== null) out = en;
    }
    return interpolate(out, params);
  }

  var ATTRS = ["placeholder", "title", "aria-label", "alt"];

  function translateTextNode(node) {
    var raw = node.nodeValue;
    if (!raw || !/[A-Za-zÀ-ú]{3}/.test(raw)) return;
    var en = translateString(raw);
    if (en === null || en === norm(raw)) return;
    var lead = /^\s*/.exec(raw)[0], trail = /\s*$/.exec(raw)[0];
    node.nodeValue = lead + en + trail;
  }

  function translateElementAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (!v) continue;
      var en = translateString(v);
      if (en !== null && en !== v) el.setAttribute(ATTRS[i], en);
    }
  }

  function translateTree(node) {
    if (node.nodeType === 3) { translateTextNode(node); return; }
    if (node.nodeType !== 1) return;
    var tag = node.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") return;
    translateElementAttrs(node);
    var all = node.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) if (all[i].tagName !== "SCRIPT" && all[i].tagName !== "STYLE") translateElementAttrs(all[i]);
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { var p = n.parentNode && n.parentNode.tagName; return p === "SCRIPT" || p === "STYLE" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    var n;
    while ((n = walker.nextNode())) translateTextNode(n);
  }

  function translateHead() {
    var title = translateString(document.title);
    if (title !== null) document.title = title;
    var metas = document.querySelectorAll('meta[name="description"], meta[property="og:title"], meta[property="og:description"]');
    for (var i = 0; i < metas.length; i++) {
      var c = metas[i].getAttribute("content");
      var en = c && translateString(c);
      if (en) metas[i].setAttribute("content", en);
    }
  }

  function startRuntimeTranslation() {
    root.setAttribute("lang", "en");
    translateHead();
    translateTree(document.body);
    root.classList.remove("i18n-pending");
    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "childList") for (var j = 0; j < m.addedNodes.length; j++) translateTree(m.addedNodes[j]);
        else if (m.type === "characterData") translateTextNode(m.target);
        else if (m.type === "attributes") translateElementAttrs(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  // ---------- Seletor de idioma ----------
  function buildSwitcher() {
    var hosts = document.querySelectorAll("[data-lang-switch]");
    if (!hosts.length) return;
    var ptHref = pageLang === "pt" ? null : alternate("pt-BR");
    var enHref = pageLang === "en" ? null : alternate("en");
    for (var i = 0; i < hosts.length; i++) {
      hosts[i].innerHTML = "";
      [["pt", "PT", ptHref], ["en", "EN", enHref]].forEach(function (opt) {
        var a = document.createElement("a");
        a.textContent = opt[1];
        a.href = opt[2] || "?lang=" + opt[0];
        a.lang = opt[0];
        a.setAttribute("aria-label", opt[0] === "pt" ? "Português" : "English");
        if (lang === opt[0]) a.setAttribute("aria-current", "true");
        a.className = "lang-switch-link" + (lang === opt[0] ? " is-active" : "");
        a.addEventListener("click", function (e) {
          setStored(opt[0]);
          if (lang === opt[0]) { e.preventDefault(); return; }
          // Páginas de runtime: recarrega na mesma URL para refazer a tradução do zero.
          if (isRuntime) { e.preventDefault(); var u = new URL(location.href); u.searchParams.set("lang", opt[0]); location.href = u.toString(); }
        });
        hosts[i].appendChild(a);
      });
    }
  }

  window.i18n = {
    lang: lang,
    t: t,
    /** Locale para Intl/toLocaleString. */
    locale: function () { return lang === "en" ? "en-US" : "pt-BR"; },
  };

  function init() {
    if (isRuntime && lang === "en") startRuntimeTranslation();
    else root.classList.remove("i18n-pending");
    buildSwitcher();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
