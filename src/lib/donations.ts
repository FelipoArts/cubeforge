// ============================================================
// Doações (botão "Pagar uma Coquinha")
// ============================================================
// O app nunca lida com dados de pagamento — só pede pra API central criar
// a cobrança e abre a URL retornada no navegador do sistema. Dois
// provedores, escolhidos pelo doador (ver DonationModal.tsx):
//
// - Cartão → Stripe Checkout (valor livre, escolhido na própria página do
//   Stripe). Ver api/src/index.ts (handleCreateDonationCheckout).
// - Pix → Mercado Pago Checkout Pro. O Stripe ainda não libera Pix para
//   contas pessoa física novas; o Mercado Pago aceita sem essa exigência.
//   Diferença importante: o Checkout Pro não tem "cliente escolhe o
//   valor" — por isso o valor é escolhido aqui no app (só um número, não é
//   dado de pagamento) antes de criar a cobrança. Ver
//   handleCreateMercadoPagoCheckout no Worker.
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";
import { open } from "@tauri-apps/plugin-shell";

const DONATIONS_API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

interface CheckoutSessionResponse {
  success: boolean;
  message?: string;
  data?: { url?: string };
}

async function openCheckoutUrl(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${DONATIONS_API_BASE}${path}`, {
    method: "POST",
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as CheckoutSessionResponse | null;
  if (!res.ok || !json?.success || !json.data?.url) {
    throw new Error(json?.message || `Não foi possível iniciar a doação agora (HTTP ${res.status}). Tente novamente em instantes.`);
  }
  await open(json.data.url);
}

/** Cria a sessão de doação no Stripe (cartão, valor livre) e abre a página de pagamento. */
export async function openCardDonationCheckout(): Promise<void> {
  await openCheckoutUrl("/api/v1/donations/checkout-session");
}

/** Cria a cobrança Pix no Mercado Pago para o valor escolhido (em centavos) e abre a página de pagamento. */
export async function openPixDonationCheckout(amountCents: number): Promise<void> {
  await openCheckoutUrl("/api/v1/donations/mercadopago/checkout-session", { amountCents });
}
