import { invoke } from "@tauri-apps/api/core";
import { registerNativeSync } from "./index";

// Avisa o backend Tauri (erros, diagnósticos, logs de rede e menu do tray — ver
// src-tauri/src/i18n.rs) do idioma efetivo: agora e a cada troca. Fora do Tauri
// (npm run dev no navegador) o invoke falha e é ignorado.
export function initNativeLocaleSync() {
  registerNativeSync((locale) => {
    try {
      invoke("set_locale", { locale }).catch(() => { /* fora do Tauri */ });
    } catch { /* fora do Tauri */ }
  });
}
