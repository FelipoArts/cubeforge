// ============================================================
// Link de convite — play.cubicase.net/<slug>
// ============================================================
// Todo servidor já tem um link de graça: o próprio shortCode em minúsculas
// (ver defaultSlugFor) — não exige login nem assinatura, e nem precisa
// perguntar pro Worker (é derivado localmente). Cubicase Plus só desbloqueia
// TROCAR isso por um slug escolhido, guardado na API Central — ver
// ServerConfigModal.tsx pra onde essa edição fica.
//
// Mesmo padrão de src/lib/subscription.ts: leitura pública direto na API
// Central (sem auth — o discover de um servidor já é público), escrita
// autenticada com o access token do Supabase. A validação de formato/
// disponibilidade de verdade é sempre a do Worker (ver api/src/index.ts,
// handleSetServerSlug) — aqui só evitamos uma ida e volta óbvia.
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { supabase } from "@/lib/supabaseClient";

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";
export const INVITE_LINK_DOMAIN = "play.cubicase.net";

/** Mesma regra do Worker (SLUG_REGEX) — checagem só pra feedback imediato, não é a fonte da verdade. */
export const SLUG_FORMAT_HINT = "3 a 32 letras minúsculas, números ou hífen, sem hífen nas pontas.";
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

export function isValidSlugFormat(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

export function inviteLinkUrl(slug: string): string {
  return `https://${INVITE_LINK_DOMAIN}/${slug}`;
}

/** Link de graça de qualquer servidor, sem precisar de slug customizado nem assinatura. */
export function defaultSlugFor(shortCode: string): string {
  return shortCode.toLowerCase();
}

interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

/** Lê o slug atual do servidor (null se nunca configurado) — público, não precisa de login. */
export async function getServerSlug(shortCode: string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}`);
  if (!res.ok) return null;
  const envelope = (await res.json().catch(() => null)) as ApiEnvelope<{ server?: { slug?: string | null } }> | null;
  return envelope?.data?.server?.slug ?? null;
}

async function authedSlugFetch(shortCode: string, method: "PUT" | "DELETE", body?: unknown): Promise<ApiEnvelope<{ slug?: string; url?: string }>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Não autenticado.");

  const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}/slug`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as ApiEnvelope<{ slug?: string; url?: string }> | null;
  if (!res.ok || !json?.success) {
    throw new Error(json?.message || `Falha na operação (HTTP ${res.status}).`);
  }
  return json;
}

/** Define ou troca o link de convite personalizado. Exige login + Cubicase Plus ativo (checado no Worker). */
export async function setServerSlug(shortCode: string, slug: string): Promise<string> {
  const envelope = await authedSlugFetch(shortCode, "PUT", { slug });
  return envelope.data?.slug ?? slug;
}

/** Remove o link personalizado — volta a exibir só o código CF-XXXXXX. */
export async function removeServerSlug(shortCode: string): Promise<void> {
  await authedSlugFetch(shortCode, "DELETE");
}
