// ============================================================
// Cubicase — Site (comportamento compartilhado entre as páginas)
// ============================================================

const REPO = "FelipoArts/cubeforge";

// Menu mobile
function setupNavToggle() {
  const toggle = document.querySelector("[data-nav-toggle]");
  const links = document.querySelector("[data-nav-links]");
  if (!toggle || !links) return;

  toggle.addEventListener("click", () => {
    const open = links.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  links.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => links.classList.remove("is-open"))
  );
}

// Fade/slide dos blocos com [data-reveal] conforme entram na tela
function setupScrollReveal() {
  const items = document.querySelectorAll("[data-reveal]");
  if (!items.length) return;

  if (!("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );

  items.forEach((el) => observer.observe(el));
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

// Busca a release mais recente publicada no GitHub e usa pra atualizar
// versão/tamanho/link de download em qualquer elemento marcado com
// data-version / data-size / data-download-btn presente na página.
// Progressive enhancement: se a API falhar (offline, rate limit, ainda
// sem nenhuma release publicada), os elementos mantêm o texto/link
// genérico que já está no HTML.
async function loadLatestRelease() {
  const versionEls = document.querySelectorAll("[data-version]");
  const sizeEls = document.querySelectorAll("[data-size]");
  const downloadBtn = document.querySelector("[data-download-btn]");

  if (!versionEls.length && !sizeEls.length && !downloadBtn) return;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const data = await res.json();

    const asset =
      data.assets?.find((a) => /setup\.exe$/i.test(a.name)) ||
      data.assets?.find((a) => /\.msi$/i.test(a.name));

    versionEls.forEach((el) => (el.textContent = data.tag_name || el.textContent));
    if (asset) {
      sizeEls.forEach((el) => (el.textContent = formatBytes(asset.size)));
      if (downloadBtn) downloadBtn.href = asset.browser_download_url;
    }
  } catch {
    // Silencioso de propósito — ver comentário acima.
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setupNavToggle();
  setupScrollReveal();
  loadLatestRelease();
});
