import { defineMessages } from "./define";

// Título e descrição da página (aplicados em runtime — ver applyDocumentMeta em src/i18n/index.ts).
// O HTML estático exportado pelo Next carrega o texto em pt-BR (src/app/layout.tsx); ao iniciar,
// o i18n troca para o idioma efetivo.
export default defineMessages({
  "pt-BR": {
    "meta.title": "Cubicase — Servidor Minecraft Simplificado",
    "meta.description": "Crie, gerencie e compartilhe servidores Minecraft com amigos. Rede mesh privada, sem abrir portas, sem configuração técnica.",
  },
  en: {
    "meta.title": "Cubicase — Minecraft Servers Made Simple",
    "meta.description": "Create, manage and share Minecraft servers with friends. Private mesh network, no port forwarding, no technical setup.",
  },
});
