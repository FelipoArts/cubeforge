// ============================================================
// Login opcional (Supabase)
// ============================================================
// O app funciona 100% sem conta. Login só é disparado quando algo
// realmente precisa dele — um recurso pago, ou o usuário clicando em
// "Entrar" nas configurações (ver AppSettingsPanel.tsx, categoria "conta").
//
// Fluxo (ver docs/entrar/index.html para o outro lado):
//   1. requireAuth() abre https://cubicase.net/entrar/ no navegador do
//      sistema (mesmo padrão de src/lib/subscription.ts).
//   2. O usuário loga por magic link, Google ou Discord nessa página.
//   3. A página redireciona para cubicase://auth-callback#access_token=...
//   4. O SO entrega essa URL de volta pro app — via onOpenUrl (primeira
//      instância/cold start) ou via o evento "deep-link-received" que o
//      Rust emite quando uma segunda instância é disparada pelo clique
//      (ver o closure do single_instance em src-tauri/src/lib.rs).
//   5. setSession() aplica a sessão; supabase-js cuida de persistir e
//      renovar o token sozinho daí em diante.
// ============================================================

import { open } from "@tauri-apps/plugin-shell";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { supabase } from "@/lib/supabaseClient";
import { useAppStore, type AuthUser } from "@/app/store";

const LOGIN_URL = "https://cubicase.net/entrar/";
const REQUIRE_AUTH_TIMEOUT_MS = 5 * 60_000;

function toAuthUser(user: { id: string; email?: string | null }): AuthUser {
  return { id: user.id, email: user.email ?? "" };
}

function parseTokensFromDeepLink(url: string): { access_token: string; refresh_token: string } | null {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) return null;
  return { access_token, refresh_token };
}

async function handleAuthCallbackUrl(url: string): Promise<void> {
  if (!url.startsWith("cubicase://auth-callback")) return;
  const tokens = parseTokensFromDeepLink(url);
  if (!tokens) {
    console.error("[auth] Deep link de login sem os tokens esperados:", url);
    return;
  }
  const { error } = await supabase.auth.setSession(tokens);
  if (error) console.error("[auth] Falha ao aplicar sessão recebida do deep link:", error);
}

/**
 * Registra os listeners de autenticação (mudança de sessão + deep link de
 * volta do login). Chamar UMA vez ao montar o app (ver page.tsx) — retorna
 * a função de limpeza.
 */
export async function initAuthListener(): Promise<() => void> {
  const setUser = useAppStore.getState().setUser;

  // Sessão que já existia, persistida pelo supabase-js de uma execução anterior.
  const { data: { session } } = await supabase.auth.getSession();
  setUser(session?.user ? toAuthUser(session.user) : null);

  const { data: authSub } = supabase.auth.onAuthStateChange((_event, newSession) => {
    setUser(newSession?.user ? toAuthUser(newSession.user) : null);
  });

  // Cold start: se o app acabou de ser aberto pelo próprio deep link de login
  // (raro pra login — normalmente o app já está aberto quando se clica em
  // "Entrar" — mas o mesmo mecanismo vale), getCurrent() pega a URL dos
  // argumentos de linha de comando do processo. onOpenUrl sozinho só cobre o
  // app já rodando (ver comentário equivalente em src/lib/joinDeepLink.ts).
  try {
    const initialUrls = await getCurrent();
    if (initialUrls) for (const url of initialUrls) void handleAuthCallbackUrl(url);
  } catch (err) {
    console.error("[auth] Falha ao checar getCurrent():", err);
  }

  const unlistenOpenUrl = await onOpenUrl((urls) => {
    for (const url of urls) void handleAuthCallbackUrl(url);
  });

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenForwarded = await listen<string>("deep-link-received", (event) => {
    void handleAuthCallbackUrl(event.payload);
  });

  return () => {
    authSub.subscription.unsubscribe();
    unlistenOpenUrl();
    unlistenForwarded();
  };
}

/**
 * Garante que há um usuário logado, pedindo login se necessário. Se já
 * houver sessão, resolve na hora. Senão, abre o navegador e só resolve
 * quando o deep link de volta confirmar o login (ou rejeita depois de
 * REQUIRE_AUTH_TIMEOUT_MS sem resposta).
 */
export function requireAuth(): Promise<AuthUser> {
  return new Promise((resolve, reject) => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        resolve(toAuthUser(session.user));
        return;
      }

      const timer = setTimeout(() => {
        sub.subscription.unsubscribe();
        reject(new Error("Login cancelado: tempo esgotado."));
      }, REQUIRE_AUTH_TIMEOUT_MS);

      const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
        if (event === "SIGNED_IN" && newSession?.user) {
          clearTimeout(timer);
          sub.subscription.unsubscribe();
          resolve(toAuthUser(newSession.user));
        }
      });

      try {
        await open(LOGIN_URL);
      } catch (err) {
        clearTimeout(timer);
        sub.subscription.unsubscribe();
        reject(err);
      }
    })();
  });
}

export async function logout(): Promise<void> {
  await supabase.auth.signOut();
}

/** Define (ou troca) a senha da conta já logada — login por senha continua opcional. */
export async function setPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

/** Provedores vinculados à conta logada (ex: ["email", "google"]), para exibir nas configurações. */
export async function getLinkedProviders(): Promise<string[]> {
  const { data, error } = await supabase.auth.getUserIdentities();
  if (error || !data) return [];
  return data.identities.map((identity) => identity.provider);
}
