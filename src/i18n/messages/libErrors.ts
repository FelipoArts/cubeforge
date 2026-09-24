import { defineMessages } from "./define";

// Mensagens de erro/progresso de src/lib/* (jre, clientSetup, modpackImport,
// modSync, modrinth, inviteLink, connectAddress, subscription).
export default defineMessages({
  "pt-BR": {
    "err.notAuthenticated": "Não autenticado.",
    "err.operationFailed": "Falha na operação (HTTP {status}).",

    "jre.retrying": "Falha no download, tentando novamente ({attempt}/{max})...",
    "jre.installFailed": "Falha ao instalar a JRE {version} após {max} tentativas: {error}",
    "jre.apiFailed": "Falha ao consultar a API da Adoptium",
    "jre.noBuild": "Nenhum build de JRE disponível na API da Adoptium para esta versão.",
    "jre.installError": "Erro na instalação do JRE: {error}",

    "client.fabricInstallerHttp": "Falha ao consultar o instalador do Fabric (HTTP {status}).",
    "client.fabricNoInstaller": "Nenhuma versão do instalador do Fabric disponível no momento.",
    "client.fabricInstalled": "Fabric já instalado.",
    "client.alreadyInstalled": "{label} já instalado.",

    "modpack.curseforgeHttp": "Falha ao consultar a CurseForge (HTTP {status}). O serviço de import pode estar temporariamente indisponível.",
    "modpack.curseforgeUnavailable": "Import de modpacks da CurseForge ainda não está disponível (aguardando aprovação de acesso à API deles). Por enquanto, use um pacote .mrpack do Modrinth.",
    "modpack.nameExists": "Já existe um servidor com o nome \"{name}\".",
    "modpack.motd": "Servidor Cubicase [{pack}] - {name}",

    "modsync.hostUnreachable": "Não foi possível falar com o host para checar os mods — a rede mesh pode estar instável ou o host offline.",
    "modsync.notHosting": "O host não está hospedando este servidor agora (ou você já não está mais conectado a ele).",
    "modsync.removedFromHost": "Mod não está mais na lista do host (pode ter sido removido durante a sincronização).",
    "modsync.removedFromFolder": "Mod não está mais na pasta do servidor (pode ter sido removido durante a sincronização).",

    "modrinth.noFile": "Esta versão não possui nenhum arquivo para download.",
    "modrinth.downloadDone": "Download concluído.",

    "invite.slugHint": "3 a 32 letras minúsculas, números ou hífen, sem hífen nas pontas.",
  },
  en: {
    "err.notAuthenticated": "Not signed in.",
    "err.operationFailed": "Operation failed (HTTP {status}).",

    "jre.retrying": "Download failed, trying again ({attempt}/{max})...",
    "jre.installFailed": "Failed to install JRE {version} after {max} attempts: {error}",
    "jre.apiFailed": "Failed to query the Adoptium API",
    "jre.noBuild": "No JRE build available from the Adoptium API for this version.",
    "jre.installError": "JRE installation error: {error}",

    "client.fabricInstallerHttp": "Failed to query the Fabric installer (HTTP {status}).",
    "client.fabricNoInstaller": "No Fabric installer version available right now.",
    "client.fabricInstalled": "Fabric already installed.",
    "client.alreadyInstalled": "{label} already installed.",

    "modpack.curseforgeHttp": "Failed to query CurseForge (HTTP {status}). The import service may be temporarily unavailable.",
    "modpack.curseforgeUnavailable": "Importing CurseForge modpacks isn't available yet (waiting for their API access approval). For now, use a Modrinth .mrpack package.",
    "modpack.nameExists": "A server named \"{name}\" already exists.",
    "modpack.motd": "Cubicase Server [{pack}] - {name}",

    "modsync.hostUnreachable": "Couldn't reach the host to check the mods — the mesh network may be unstable or the host offline.",
    "modsync.notHosting": "The host isn't hosting this server right now (or you're no longer connected to it).",
    "modsync.removedFromHost": "Mod is no longer on the host's list (it may have been removed during syncing).",
    "modsync.removedFromFolder": "Mod is no longer in the server folder (it may have been removed during syncing).",

    "modrinth.noFile": "This version has no downloadable file.",
    "modrinth.downloadDone": "Download complete.",

    "invite.slugHint": "3 to 32 lowercase letters, numbers or hyphens, with no hyphen at the ends.",
  },
});
