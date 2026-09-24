import { defineMessages } from "./define";

// DeleteConfirmModal, ConfirmActionModal, ConsolePanel, ServerList, SettingsModal (host)
export default defineMessages({
  "pt-BR": {
    "host.delete.title": "Excluir Servidor",
    "host.delete.importedMsg": "Tem certeza que deseja remover o servidor {name} da sua lista? Os arquivos originais na pasta não serão deletados.",
    "host.delete.msg": "Tem certeza que deseja excluir permanentemente o servidor {name}? Todos os mundos, configurações e dados serão perdidos. Esta ação não pode ser desfeita.",
    "host.delete.typeName": "Digite o nome do servidor para confirmar",
    "host.delete.confirm": "Excluir Permanentemente",

    "confirm.typeToConfirm": "Digite \"{text}\" para confirmar",
    "confirm.wait": "Aguarde...",

    "console.tab.minecraft": "Minecraft Console",
    "console.tab.network": "Rede Mesh",
    "console.clear": "Limpar",
    "console.emptyMc": "Console do Minecraft inativo. Inicie o servidor Minecraft para monitorar.",
    "console.emptyNet": "Nenhum log de rede gerado. Inicie o túnel para monitorar.",
    "console.placeholderOnline": "Digite um comando para o Minecraft (ex: op Player, say Olá)...",
    "console.placeholderOffline": "O console aceita comandos apenas quando o servidor está ONLINE",

    "serverList.title": "Servidores Locais",
    "serverList.import": "Importar Servidor Existente",
    "serverList.importModpack": "Importar Modpack (.zip/.mrpack)",
    "serverList.create": "Criar Novo Servidor",
    "serverList.empty": "Nenhum servidor criado. Clique no botão \"+\" acima para adicionar o seu primeiro servidor.",
    "serverList.running.title": "Servidor em execução",
    "serverList.running.message": "Pare o servidor atual antes de selecionar outro.",
    "serverList.version": "Versão: {version}",
    "serverList.versionNotFound": "Não encontrada",
    "serverList.delete": "Deletar Servidor",

    "hostSettings.title": "Ajustes do Sistema",
    "hostSettings.guestPort": "Porta Local de Convidado",
    "hostSettings.guestPortHint": "Porta local usada apenas quando VOCÊ entra como convidado no servidor de outra pessoa (padrão 25565). Não afeta servidores que você hospeda — a porta desses é definida em \"Configurações do Servidor\", em cada servidor.",
    "hostSettings.save": "Salvar Ajustes",
  },
  en: {
    "host.delete.title": "Delete Server",
    "host.delete.importedMsg": "Are you sure you want to remove the server {name} from your list? The original files in the folder won't be deleted.",
    "host.delete.msg": "Are you sure you want to permanently delete the server {name}? All worlds, settings and data will be lost. This action cannot be undone.",
    "host.delete.typeName": "Type the server name to confirm",
    "host.delete.confirm": "Delete Permanently",

    "confirm.typeToConfirm": "Type \"{text}\" to confirm",
    "confirm.wait": "Please wait...",

    "console.tab.minecraft": "Minecraft Console",
    "console.tab.network": "Mesh Network",
    "console.clear": "Clear",
    "console.emptyMc": "Minecraft console inactive. Start the Minecraft server to monitor it.",
    "console.emptyNet": "No network logs generated. Start the tunnel to monitor it.",
    "console.placeholderOnline": "Type a command for Minecraft (e.g. op Player, say Hello)...",
    "console.placeholderOffline": "The console only accepts commands while the server is ONLINE",

    "serverList.title": "Local Servers",
    "serverList.import": "Import Existing Server",
    "serverList.importModpack": "Import Modpack (.zip/.mrpack)",
    "serverList.create": "Create New Server",
    "serverList.empty": "No servers created. Click the \"+\" button above to add your first server.",
    "serverList.running.title": "Server running",
    "serverList.running.message": "Stop the current server before selecting another one.",
    "serverList.version": "Version: {version}",
    "serverList.versionNotFound": "Not found",
    "serverList.delete": "Delete Server",

    "hostSettings.title": "System Settings",
    "hostSettings.guestPort": "Local Guest Port",
    "hostSettings.guestPortHint": "Local port used only when YOU join someone else's server as a guest (default 25565). It doesn't affect servers you host — their port is set in \"Server Settings\", on each server.",
    "hostSettings.save": "Save Settings",
  },
});
