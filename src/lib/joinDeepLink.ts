// ============================================================
// Deep link de convite — cubicase://join/<shortCode>
// ============================================================
// Gerado pela página de convite bonita (play.cubicase.net/<slug>, ver
// api/src/index.ts:handleResolveSlug e play-site/index.html) e pelo esquema
// `cubicase://` já registrado pro login (ver src/lib/auth.ts) — mesmo
// mecanismo de entrega, destino diferente: aqui só guardamos o shortCode
// recebido na store, e é a GuestView que consome (troca pra aba Convidado,
// adiciona à biblioteca e conecta se já estiver online — ver o efeito em
// GuestView.tsx).
//
// Cold start x app já aberto — os dois casos precisam de mecanismos
// DIFERENTES, e usar só um deles foi exatamente o bug reportado (amigo sem
// o Cubicase aberto clica no link, o app abre na aba Convidado mas não
// adiciona nada):
//   - App já rodando (Windows/Linux): o SO manda o link como argumento de
//     linha de comando pra uma tentativa de SEGUNDA instância, que o
//     single_instance do Tauri intercepta e o Rust repassa via o evento
//     "deep-link-received" (ver src-tauri/src/lib.rs) — cobre onOpenUrl.
//   - Cold start (app fechado, é a PRIMEIRA instância): não existe "segunda
//     instância" nenhuma pro single_instance interceptar, e onOpenUrl (que
//     escuta exatamente esse mesmo evento) nunca dispara. A própria
//     documentação do plugin é explícita: onOpenUrl é só "while the app is
//     running" — pra cold start ela manda usar getCurrent() (lê os argumentos
//     de linha de comando do próprio processo) explicitamente ao montar o
//     app. Sem isso, um amigo que nunca abriu o Cubicase antes clica no
//     link, o instalador finalizado abre o app do zero já com a URL como
//     argumento — e essa URL nunca era lida.
// ============================================================

import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { useAppStore } from "@/app/store";
import { pushDiagnostic } from "@/app/diagnostics";
import { t } from "@/i18n";

const JOIN_PREFIX = "cubicase://join/";

function extractShortCode(url: string): string | null {
  if (!url.startsWith(JOIN_PREFIX)) return null;
  const code = url.slice(JOIN_PREFIX.length).split(/[/?#]/)[0]?.trim().toUpperCase();
  return code || null;
}

function handleJoinUrl(url: string): void {
  // O esquema cubicase:// é compartilhado com outros fluxos (ex:
  // cubicase://auth-callback do login, ver src/lib/auth.ts) — os dois
  // listeners (onOpenUrl/getCurrent/deep-link-received) recebem TODAS as
  // URLs entregues ao app, não só as do seu próprio prefixo. Uma URL que
  // nem começa com JOIN_PREFIX simplesmente não é um convite e pertence a
  // outro handler — ignorar em silêncio, sem avisar o usuário.
  if (!url.startsWith(JOIN_PREFIX)) return;

  const code = extractShortCode(url);
  if (!code) {
    // Aqui sim é um convite de verdade (bate o prefixo) mas malformado —
    // isso não deveria acontecer, então vale avisar.
    pushDiagnostic({
      level: "warning",
      source: t("diag.source.invite"),
      title: t("deeplink.unrecognized.title"),
      message: t("deeplink.unrecognized.message"),
      detail: url,
    });
    return;
  }
  pushDiagnostic({
    level: "info",
    source: t("diag.source.invite"),
    title: t("deeplink.received.title"),
    message: t("deeplink.received.message", { code }),
  });
  useAppStore.getState().setMode("guest");
  useAppStore.getState().setPendingJoinShortCode(code);
}

/**
 * Registra o listener do deep link de convite e trata o cold start. Chamar
 * uma vez ao montar o app (ver page.tsx, ao lado de initAuthListener) —
 * retorna a função de limpeza.
 */
export async function initJoinDeepLinkListener(): Promise<() => void> {
  // Cold start: se o app acabou de ser aberto POR este link, getCurrent()
  // devolve a URL (lida dos argumentos de linha de comando do processo).
  try {
    const initialUrls = await getCurrent();
    if (initialUrls) for (const url of initialUrls) handleJoinUrl(url);
  } catch (err) {
    console.error("[joinDeepLink] Falha ao checar getCurrent():", err);
  }

  // App já rodando: uma segunda tentativa de instância é interceptada pelo
  // single_instance do Tauri e repassada como este evento (ver lib.rs).
  const unlistenOpenUrl = await onOpenUrl((urls) => {
    for (const url of urls) handleJoinUrl(url);
  });

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenForwarded = await listen<string>("deep-link-received", (event) => {
    handleJoinUrl(event.payload);
  });

  return () => {
    unlistenOpenUrl();
    unlistenForwarded();
  };
}
