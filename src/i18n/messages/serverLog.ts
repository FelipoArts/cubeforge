import { defineMessages } from "./define";

// Linhas de log de startServerOrchestrated (src/lib/server.ts)
export default defineMessages({
  "pt-BR": {
    "srv.log.checkingJava": "Verificando compatibilidade com Java JRE {java}...",
    "srv.log.jreReady": "JRE {java} pronto!",
    "srv.log.startingJava": "Iniciando Java runtime com {ram}GB de RAM...",
  },
  en: {
    "srv.log.checkingJava": "Checking Java JRE {java} compatibility...",
    "srv.log.jreReady": "JRE {java} ready!",
    "srv.log.startingJava": "Starting the Java runtime with {ram}GB of RAM...",
  },
});
