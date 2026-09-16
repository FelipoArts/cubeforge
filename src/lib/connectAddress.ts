// ============================================================
// Endereço de conexão — <nome>.link.cubicase.net
// ============================================================
// Todo servidor já tem um endereço de graça: o próprio shortCode em
// minúsculas (ver defaultConnectNameFor) — não exige login nem assinatura.
// Cubicase Plus só desbloqueia TROCAR isso por um nome escolhido, guardado
// na API Central — ver ServerConfigModal.tsx pra onde essa edição fica.
//
// Campo independente do slug do link de convite (src/lib/inviteLink.ts): o
// host pode ter nomes diferentes pra cada um.
//
// Só funciona pra convidados na mesh do próprio Cubicase: um registro DNS
// wildcard `*.link.cubicase.net -> A 127.0.0.1`, mantido fora do app,
// resolve qualquer nome sob esse domínio pro loopback onde o tsnet-node do
// convidado já escuta depois de conectar (ver GuestView.tsx/page.tsx) — é
// por isso que esse endereço só funciona enquanto o app está conectado
// àquele servidor, exatamente como "localhost:<porta>" hoje.
//
// Mesmo padrão de src/lib/inviteLink.ts: leitura pública direto na API
// Central (sem auth), escrita autenticada com o access token do Supabase. A
// validação de formato/disponibilidade de verdade é sempre a do Worker (ver
// api/src/index.ts, handleSetConnectName) — aqui só evitamos uma ida e volta
// óbvia.
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { supabase } from "@/lib/supabaseClient";
import { SLUG_FORMAT_HINT, isValidSlugFormat } from "@/lib/inviteLink";

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";
export const CONNECT_NAME_DOMAIN = "link.cubicase.net";

/** Mesma regra do Worker (isValidSlug) — checagem só pra feedback imediato, não é a fonte da verdade. */
export const CONNECT_NAME_FORMAT_HINT = SLUG_FORMAT_HINT;

export function isValidConnectNameFormat(name: string): boolean {
  return isValidSlugFormat(name);
}

/** Nome de graça de qualquer servidor, sem precisar de nome customizado nem assinatura. */
export function defaultConnectNameFor(shortCode: string): string {
  return shortCode.toLowerCase();
}

/**
 * Monta o endereço que o convidado deve usar no Minecraft. Só omite a porta
 * quando for a padrão (25565) — o Minecraft já assume essa por conta própria;
 * qualquer outra precisa ser digitada, porque é a porta LOCAL do convidado
 * (onde o tsnet-node dele escuta), não uma escolha do host.
 */
export function connectAddressFor(server: { shortCode: string; connectName?: string | null }, port: number): string {
  const name = server.connectName ?? defaultConnectNameFor(server.shortCode);
  const host = `${name}.${CONNECT_NAME_DOMAIN}`;
  return port === 25565 ? host : `${host}:${port}`;
}

interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

/** Lê o connectName atual do servidor (null se nunca configurado) — público, não precisa de login. */
export async function getServerConnectName(shortCode: string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}`);
  if (!res.ok) return null;
  const envelope = (await res.json().catch(() => null)) as ApiEnvelope<{ server?: { connectName?: string | null } }> | null;
  return envelope?.data?.server?.connectName ?? null;
}

async function authedConnectNameFetch(shortCode: string, method: "PUT" | "DELETE", body?: unknown): Promise<ApiEnvelope<{ connectName?: string; address?: string }>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Não autenticado.");

  const res = await fetch(`${API_BASE}/api/v1/servers/${shortCode}/connect-name`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as ApiEnvelope<{ connectName?: string; address?: string }> | null;
  if (!res.ok || !json?.success) {
    throw new Error(json?.message || `Falha na operação (HTTP ${res.status}).`);
  }
  return json;
}

/** Define ou troca o endereço de conexão personalizado. Exige login + Cubicase Plus ativo (checado no Worker). */
export async function setConnectName(shortCode: string, name: string): Promise<string> {
  const envelope = await authedConnectNameFetch(shortCode, "PUT", { connectName: name });
  return envelope.data?.connectName ?? name;
}

/** Remove o endereço personalizado — volta a exibir o nome baseado no shortCode. */
export async function removeConnectName(shortCode: string): Promise<void> {
  await authedConnectNameFetch(shortCode, "DELETE");
}
