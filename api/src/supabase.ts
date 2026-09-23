// ============================================================
// Helpers Supabase compartilhados (Worker)
// ============================================================
// Extraído de index.ts para ser reaproveitado também pelo Durable Object do
// painel web remoto (host-channel.ts) — mesma lógica de validação usada por
// checkout/portal de assinatura, sem duplicar.
// ============================================================

export const SUPABASE_URL = 'https://rtfxcyvymlxebvemgwaj.supabase.co';
// Mesma publishable key de src/lib/supabaseClient.ts — pública por design
// (RLS protege os dados, não o segredo desta key).
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ggAEPrue0lgmIlXGkv4vUg_Hot7Xe0Y';

export interface SupabaseEnv {
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export interface SupabaseUser {
  id: string;
  email: string | null;
  /** Nome para exibir (perfil do Google/Discord) — cai pro e-mail quando não há. */
  displayName: string;
}

/** Valida o Bearer token do Supabase contra o próprio Supabase Auth — nunca confia num userId vindo do cliente. */
export async function resolveSupabaseUser(req: Request): Promise<SupabaseUser | null> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: auth },
    });
    if (!resp.ok) return null;
    const data: any = await resp.json().catch(() => null);
    if (!data?.id) return null;
    const meta = data.user_metadata ?? {};
    const email: string | null = data.email ?? null;
    const displayName = (meta.full_name || meta.name || meta.user_name || email || 'Alguém').toString();
    return { id: data.id, email, displayName };
  } catch {
    return null;
  }
}

export async function resolveSupabaseUserId(req: Request): Promise<string | null> {
  return (await resolveSupabaseUser(req))?.id ?? null;
}

/** Chamada REST/RPC ao Supabase com a service role (bypassa RLS) — só pra uso do Worker/DO, nunca exposta ao cliente. */
export function supabaseService(env: SupabaseEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/** true se o usuário tem Cubicase Plus ativo agora — mesmos status aceitos de isSubscriptionActive no app (src/lib/subscription.ts). */
export async function userHasActiveSubscription(env: SupabaseEnv, userId: string): Promise<boolean> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=status`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!resp.ok) return false;
    const rows: any = await resp.json().catch(() => []);
    const status = rows?.[0]?.status;
    return status === 'active' || status === 'trialing';
  } catch {
    return false;
  }
}
