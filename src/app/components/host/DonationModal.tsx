"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CreditCard, Loader2 } from "lucide-react";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { openCardDonationCheckout } from "@/lib/donations";

// ============================================================
// DonationModal
// ============================================================
// Confirmação simples antes de abrir o Stripe Checkout (valor livre,
// escolhido na própria página do Stripe) no navegador do sistema — cartão,
// Apple Pay, Google Pay e Link aparecem automaticamente ali conforme o que
// estiver ativo no Dashboard do Stripe e o que o navegador do doador
// suportar. Nenhum dado de pagamento passa pelo Cubicase.
// ============================================================

interface DonationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

export function DonationModal({ isOpen, onClose, onError }: DonationModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  useLockBodyScroll(isOpen);

  const handleClose = () => {
    if (isSubmitting) return;
    onClose();
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await openCardDonationCheckout();
      setIsSubmitting(false);
      onClose();
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
            <h3 className="text-xl font-bold text-theme-primary">Apoiar o Cubicase 🥤</h3>

            <div className="space-y-3">
              <p className="text-sm text-theme-secondary leading-relaxed">
                Você escolhe o valor na própria página segura do Stripe, aberta no seu navegador — cartão, Apple
                Pay, Google Pay ou Link. Nenhum dado de pagamento passa pelo Cubicase.
              </p>

              <button
                type="button"
                onClick={handleConfirm}
                disabled={isSubmitting}
                className="w-full h-12 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 transition-colors text-sm font-bold shadow-md shadow-theme-shadow disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                {isSubmitting ? "Abrindo..." : "Continuar para pagamento"}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
