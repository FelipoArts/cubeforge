// ============================================================
// Cubicase Plus — assinatura recorrente (Stripe + Supabase)
// ============================================================
// Leitura de status é direto no Supabase (RLS garante que o usuário só
// enxerga a própria linha em `subscriptions`) — sem round-trip pelo Worker.
// Checkout e portal de cobrança passam pelo Worker: abre a URL retornada no
// navegador do sistema, nunca coleta cartão no app, autenticados com o
// access token do Supabase.
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { open } from "@tauri-apps/plugin-shell";
import { supabase } from "@/lib/supabaseClient";
import { requireAuth } from "@/lib/auth";
import { getLocale, t } from "@/i18n";

const SUBSCRIPTIONS_API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

export type SubscriptionPlan = "monthly" | "annual";
export type SubscriptionStatus =
  | "trialing" | "active" | "past_due" | "canceled"
  | "unpaid" | "incomplete" | "incomplete_expired" | "paused";

export interface SubscriptionInfo {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** true só pros status que realmente dão direito aos benefícios Plus agora. */
export function isSubscriptionActive(info: SubscriptionInfo | null): boolean {
  return info?.status === "active" || info?.status === "trialing";
}

/** Lê o status direto do Supabase — RLS garante só a própria linha do usuário logado. Retorna null se não há sessão ou nunca assinou. */
export async function getSubscriptionStatus(): Promise<SubscriptionInfo | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return null;

  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    plan: data.plan,
    status: data.status,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
  };
}

interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

async function authedCheckoutFetch(path: string, body: unknown): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error(t("err.notAuthenticated"));

  const res = await fetch(`${SUBSCRIPTIONS_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      "Accept-Language": getLocale(),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as ApiEnvelope<{ url?: string }> | null;
  if (!res.ok || !json?.success || !json.data?.url) {
    throw new Error(json?.message || t("err.operationFailed", { status: res.status }));
  }
  return json.data.url;
}

/** Garante login e abre o Checkout de assinatura (mensal ou anual) no navegador do sistema. */
export async function openSubscriptionCheckout(plan: SubscriptionPlan): Promise<void> {
  await requireAuth();
  const url = await authedCheckoutFetch("/api/v1/subscriptions/checkout-session", { plan });
  await open(url);
}

/** Garante login e abre o Stripe Billing Portal (gerenciar/cancelar) no navegador do sistema. */
export async function openBillingPortal(): Promise<void> {
  await requireAuth();
  const url = await authedCheckoutFetch("/api/v1/subscriptions/portal-session", {});
  await open(url);
}
