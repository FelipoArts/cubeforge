"use client";

import { useEffect } from "react";
import { useT } from "@/i18n";

// Aplica <title> e <meta name="description"> no idioma efetivo. O Next/React reescreve o
// <title> estático do layout (pt-BR) durante/depois da hidratação, então além do efeito
// observamos o <head> e reaplicamos se o título voltar ao valor estático.
export function DocumentMeta() {
  const { t, locale } = useT();

  useEffect(() => {
    const title = t("meta.title");
    const description = t("meta.description");

    const apply = () => {
      if (document.title !== title) document.title = title;
      const meta = document.querySelector('meta[name="description"]');
      if (meta && meta.getAttribute("content") !== description) meta.setAttribute("content", description);
    };

    document.documentElement.lang = locale;
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  return null;
}
