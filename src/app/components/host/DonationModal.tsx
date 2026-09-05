"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CreditCard, QrCode, Loader2, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { openCardDonationCheckout, openPixDonationCheckout } from "@/lib/donations";

// ============================================================
// DonationModal
// ============================================================
// Passo 1: escolher a forma de pagamento (Cartão → Stripe, valor livre na
// própria página do Stripe; Pix → Mercado Pago, que exige escolher o
// valor aqui antes já que o Checkout Pro não tem "valor livre").
// Passo 2 (só pro Pix): escolher o valor. Depois disso, o modal só abre o
// navegador do sistema — nenhum dado de pagamento passa pelo Cubicase.
// ============================================================

interface DonationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

const PIX_PRESETS_REAIS = [5, 10, 20, 50];

export function DonationModal({ isOpen, onClose, onError }: DonationModalProps) {
  const [step, setStep] = useState<"choose" | "pix-amount">("choose");
  const [pixAmountReais, setPixAmountReais] = useState<number | null>(10);
  const [customAmount, setCustomAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useLockBodyScroll(isOpen);

  const reset = () => {
    setStep("choose");
    setPixAmountReais(10);
    setCustomAmount("");
    setIsSubmitting(false);
  };

  const handleClose = () => {
    if (isSubmitting) return;
    reset();
    onClose();
  };

  const handleCard = async () => {
    setIsSubmitting(true);
    try {
      await openCardDonationCheckout();
      handleClose();
    } catch (err) {
      onError(String(err));
      setIsSubmitting(false);
    }
  };

  const effectivePixAmount = customAmount.trim() ? parseFloat(customAmount.replace(",", ".")) : pixAmountReais;
  const pixAmountValid = !!effectivePixAmount && effectivePixAmount >= 0.5 && effectivePixAmount <= 1000;

  const handlePixConfirm = async () => {
    if (!pixAmountValid || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await openPixDonationCheckout(Math.round(effectivePixAmount! * 100));
      handleClose();
    } catch (err) {
      onError(String(err));
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4 }}
            className="relative w-full max-w-md bg-theme-card rounded-[2rem] border-theme-card shadow-2xl p-8 z-10 space-y-6"
          >
            <div className="flex items-center gap-2.5">
              {step === "pix-amount" && (
                <button
                  type="button"
                  onClick={() => setStep("choose")}
                  disabled={isSubmitting}
                  className="p-1.5 -ml-1.5 rounded-lg hover:bg-theme-muted text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer disabled:opacity-40"
                >
                  <ArrowLeft className="w-4.5 h-4.5" />
                </button>
              )}
              <h3 className="text-xl font-bold text-theme-primary">
                {step === "choose" ? "Apoiar o Cubicase 🥤" : "Quanto você quer doar?"}
              </h3>
            </div>

            {step === "choose" && (
              <div className="space-y-3">
                <p className="text-sm text-theme-secondary leading-relaxed">
                  Escolha como prefere pagar. Nenhum dado de pagamento passa pelo Cubicase — as duas opções abrem
                  a página segura do provedor no seu navegador.
                </p>

                <button
                  type="button"
                  onClick={handleCard}
                  disabled={isSubmitting}
                  className="w-full flex items-center gap-4 p-4 rounded-2xl border border-theme-card hover:border-indigo-500 hover:bg-theme-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-left"
                >
                  <div className="w-11 h-11 flex-shrink-0 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600">
                    {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <CreditCard className="w-5 h-5" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-theme-primary">Cartão</p>
                    <p className="text-xs text-theme-secondary">Qualquer valor, qualquer moeda — via Stripe</p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setStep("pix-amount")}
                  disabled={isSubmitting}
                  className="w-full flex items-center gap-4 p-4 rounded-2xl border border-theme-card hover:border-emerald-500 hover:bg-theme-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-left"
                >
                  <div className="w-11 h-11 flex-shrink-0 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center text-emerald-600">
                    <QrCode className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-theme-primary">Pix</p>
                    <p className="text-xs text-theme-secondary">Instantâneo — via Mercado Pago</p>
                  </div>
                </button>
              </div>
            )}

            {step === "pix-amount" && (
              <div className="space-y-4">
                <div className="grid grid-cols-4 gap-2">
                  {PIX_PRESETS_REAIS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setPixAmountReais(value);
                        setCustomAmount("");
                      }}
                      disabled={isSubmitting}
                      className={cn(
                        "h-12 rounded-xl text-sm font-bold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
                        pixAmountReais === value && !customAmount
                          ? "bg-emerald-600 text-white"
                          : "bg-theme-muted text-theme-primary hover:bg-theme-card border border-theme-card"
                      )}
                    >
                      R${value}
                    </button>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-secondary uppercase tracking-wide">Ou outro valor (R$)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    placeholder="Ex: 15,00"
                    disabled={isSubmitting}
                    className="w-full h-12 px-4 border border-theme-card rounded-2xl focus:border-emerald-500 focus:outline-none transition-all text-sm font-semibold text-theme-primary bg-transparent disabled:opacity-50"
                  />
                </div>

                <button
                  type="button"
                  onClick={handlePixConfirm}
                  disabled={!pixAmountValid || isSubmitting}
                  className="w-full h-12 bg-emerald-600 text-white rounded-2xl hover:bg-emerald-700 transition-colors text-sm font-bold shadow-md shadow-theme-shadow disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {isSubmitting ? "Abrindo..." : "Continuar com Pix"}
                </button>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
