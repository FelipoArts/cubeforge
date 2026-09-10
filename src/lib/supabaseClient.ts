// ============================================================
// Cliente Supabase (login opcional — ver src/lib/auth.ts)
// ============================================================
// URL e publishable key são públicas por design (o Supabase protege os
// dados via RLS no banco, não escondendo essas credenciais) — mesmo nível
// de confiança que DONATIONS_API_BASE em src/lib/donations.ts, por isso
// hardcoded aqui, sem variável de ambiente (padrão já usado no resto do
// app, que é distribuído como binário compilado).
//
// A publishable key (sb_publishable_...) é a chave nova do Supabase, que
// substitui a antiga "anon key" (descontinuada até o fim de 2026) — mesma
// função: segura pra expor no client. NUNCA usar a secret key aqui, essa
// é só de backend e pula o RLS inteiro.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://rtfxcyvymlxebvemgwaj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ggAEPrue0lgmIlXGkv4vUg_Hot7Xe0Y";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // O parsing da URL de callback (magic link / OAuth) acontece na página
    // web hospedada (docs/entrar/), não aqui — o app recebe a sessão já
    // pronta via deep link (cubicase://auth-callback#access_token=...).
    detectSessionInUrl: false,
  },
});
