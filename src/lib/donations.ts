// ============================================================
// Doações (botão "Pagar uma Coquinha")
// ============================================================
// O app nunca lida com dados de pagamento — só pede pra API central criar
// a cobrança e abre a URL retornada no navegador do sistema: Stripe
// Checkout, valor livre (custom_unit_amount), escolhido direto na página
// hospedada do Stripe. Cartão, Apple Pay, Google Pay e Link aparecem
// automaticamente ali conforme o que estiver ativo no Dashboard do Stripe
// e o que o navegador/dispositivo do doador suportar — o Cubicase não
// escolhe métodos, só abre a sessão (ver handleCreateDonationCheckout em
// api/src/index.ts).
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { open } from "@tauri-apps/plugin-shell";

const DONATIONS_API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

/** Cria a sessão de doação no Stripe (valor livre) e abre a página de pagamento. */
export async function openCardDonationCheckout(): Promise<void> {
  const res = await fetch(`${DONATIONS_API_BASE}/api/v1/donations/checkout-session`, { method: "POST" });
  const json = (await res.json().catch(() => null)) as ApiEnvelope<{ url?: string }> | null;
  if (!res.ok || !json?.success || !json.data?.url) {
    throw new Error(json?.message || `Não foi possível iniciar a doação agora (HTTP ${res.status}). Tente novamente em instantes.`);
  }
  await open(json.data.url);
}
