import { defineMessages } from "./define";

// Regras do crashAnalyzer (src/lib/crashAnalyzer.ts).
export default defineMessages({
  "pt-BR": {
    "crash.watchdog.title": "O servidor travou (Watchdog)",
    "crash.watchdog.message": "O próprio Minecraft detectou que o servidor ficou travado (o \"Watchdog\") e forçou o encerramento. Isso normalmente é causado por um mod ou plugin preso em um loop infinito, uma consulta pesada demais (ex: geração de terreno ou pathfinding em massa), ou disco/rede muito lentos. Veja nos detalhes técnicos qual thread ficou presa — o nome do mod geralmente aparece no stack trace.",
    "crash.duplicateMod.title": "Dois mods com o mesmo ID instalados",
    "crash.duplicateMod.withId": "Há dois mods diferentes usando o mesmo identificador (\"{modId}\") — provavelmente uma versão duplicada do mesmo mod (ex: baixado duas vezes, ou uma cópia dentro de outro mod). Remova a cópia extra da pasta mods/.",
    "crash.duplicateMod.noId": "Há dois mods diferentes usando o mesmo identificador interno. Provavelmente é uma versão duplicada do mesmo mod (baixada duas vezes, ou embutida dentro de outro mod). Revise a pasta mods/ por arquivos repetidos.",
    "crash.missingDep.title": "Falta um mod ou biblioteca exigida por outro mod",
    "crash.missingDep.withName": "Um mod precisa de \"{dep}\" para funcionar, mas esse mod/biblioteca não está instalado (ou está em uma versão incompatível). Baixe a dependência que falta e coloque na pasta mods/.",
    "crash.missingDep.noName": "Um mod depende de outro mod (ou biblioteca) que não está instalado, ou está em uma versão incompatível. Veja nos detalhes técnicos qual dependência falta e instale-a.",
    "crash.mixin.title": "Conflito entre mods (mixin)",
    "crash.mixin.message": "Dois mods provavelmente estão tentando modificar a mesma parte do código do jogo ao mesmo tempo (um conflito clássico de \"mixin\" no Forge/Fabric). Isso costuma acontecer quando dois mods alteram a mesma classe do Minecraft de forma incompatível. Tente identificar qual mod foi instalado por último e removê-lo, ou procure por uma versão mais nova que resolva o conflito.",
    "crash.corruptedWorld.title": "Mundo (world) corrompido",
    "crash.corruptedWorld.message": "Parece que um arquivo do mundo (região/chunk) está corrompido. Isso pode acontecer após uma queda de energia ou um encerramento forçado do servidor durante uma gravação. Se você tem um backup do mundo, restaurar a partir dele costuma resolver.",
    "crash.versionMismatch.title": "Mod incompatível com a versão do Minecraft/Forge",
    "crash.versionMismatch.message": "Um mod está chamando algo que não existe nesta versão do Minecraft/Forge — sinal de que ele foi feito para uma versão diferente da instalada no servidor. Confira se todos os mods (e o próprio Forge) são compatíveis com a mesma versão do Minecraft.",
    "crash.oom.title": "Sem memória suficiente (OutOfMemoryError)",
  },
  en: {
    "crash.watchdog.title": "The server froze (Watchdog)",
    "crash.watchdog.message": "Minecraft itself detected that the server hung (the \"Watchdog\") and forced it to shut down. This is usually caused by a mod or plugin stuck in an infinite loop, a query that's too heavy (e.g. terrain generation or mass pathfinding), or a very slow disk/network. Check the technical details to see which thread got stuck — the mod name usually shows up in the stack trace.",
    "crash.duplicateMod.title": "Two mods with the same ID installed",
    "crash.duplicateMod.withId": "Two different mods are using the same identifier (\"{modId}\") — most likely a duplicate version of the same mod (e.g. downloaded twice, or a copy inside another mod). Remove the extra copy from the mods/ folder.",
    "crash.duplicateMod.noId": "Two different mods are using the same internal identifier. It's most likely a duplicate version of the same mod (downloaded twice, or bundled inside another mod). Check the mods/ folder for repeated files.",
    "crash.missingDep.title": "A mod or library required by another mod is missing",
    "crash.missingDep.withName": "A mod needs \"{dep}\" to work, but that mod/library isn't installed (or is an incompatible version). Download the missing dependency and put it in the mods/ folder.",
    "crash.missingDep.noName": "A mod depends on another mod (or library) that isn't installed, or is an incompatible version. Check the technical details to see which dependency is missing and install it.",
    "crash.mixin.title": "Mod conflict (mixin)",
    "crash.mixin.message": "Two mods are probably trying to modify the same part of the game's code at the same time (a classic \"mixin\" conflict on Forge/Fabric). This usually happens when two mods change the same Minecraft class in incompatible ways. Try to identify which mod was installed last and remove it, or look for a newer version that fixes the conflict.",
    "crash.corruptedWorld.title": "Corrupted world",
    "crash.corruptedWorld.message": "It looks like a world file (region/chunk) is corrupted. This can happen after a power outage or a forced server shutdown during a write. If you have a world backup, restoring from it usually fixes the problem.",
    "crash.versionMismatch.title": "Mod incompatible with the Minecraft/Forge version",
    "crash.versionMismatch.message": "A mod is calling something that doesn't exist in this Minecraft/Forge version — a sign that it was built for a different version than the one installed on the server. Make sure all mods (and Forge itself) are compatible with the same Minecraft version.",
    "crash.oom.title": "Out of memory (OutOfMemoryError)",
  },
});
