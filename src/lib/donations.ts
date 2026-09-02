// ============================================================
// Doações (botão "Pagar uma Coquinha")
// ============================================================
// O app nunca lida com dados de pagamento — só pede pra API central criar
// uma Stripe Checkout Session (valor livre, escolhido pelo doador na
// própria página do Stripe) e abre a URL retornada no navegador do
// sistema. Ver api/src/index.ts (handleCreateDonationCheckout) pra a
// lógica de criação da sessão e o webhook que confirma o pagamento.
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { open } from "@tauri-apps/plugin-shell";

const DONATIONS_API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

interface CheckoutSessionResponse {
  success: boolean;
  message?: string;
  data?: { url?: string };
}

/** Cria a sessão de doação no Stripe e abre a página de pagamento no navegador padrão. */
export async function openDonationCheckout(): Promise<void> {
  const res = await fetch(`${DONATIONS_API_BASE}/api/v1/donations/checkout-session`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Não foi possível iniciar a doação agora (HTTP ${res.status}). Tente novamente em instantes.`);
  }
  const json = (await res.json()) as CheckoutSessionResponse;
  if (!json.success || !json.data?.url) {
    throw new Error(json.message || "Resposta inválida do servidor de doações.");
  }
  await open(json.data.url);
}
