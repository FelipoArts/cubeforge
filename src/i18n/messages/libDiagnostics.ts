import { defineMessages } from "./define";

// Textos gerados por src/lib/* que viram diagnósticos/toasts:
// resourceDiagnostics, lagDetector, autoBackup, joinDeepLink.
export default defineMessages({
  "pt-BR": {
    "res.oom.generic": "O servidor ficou sem memória (RAM) durante a execução. Aumente a RAM alocada nas configurações do servidor, ou feche outros programas para liberar memória no computador.",
    "res.oom.headroom": "O servidor ficou sem memória, mas seu computador tem RAM de sobra: você alocou {allocated}GB, e o computador tem {total}GB no total. Pode aumentar a RAM alocada nas configurações do servidor com segurança até uns {max}GB.",
    "res.oom.tight": "O servidor ficou sem memória, e seu computador só tem {total}GB de RAM no total — já não sobra muita folga além do que está alocado ({allocated}GB). Considere reduzir a quantidade de mods/jogadores, diminuir um pouco a RAM alocada para dar mais folga ao sistema, ou fazer um upgrade de RAM no computador.",
    "res.bottleneck.cpu": "O processador do computador está no limite ({percent}% de uso) — esse é provavelmente o gargalo. Considere reduzir a distância de renderização (view-distance), remover mods pesados, ou fazer upgrade do processador.",
    "res.bottleneck.ram": "A memória do computador está quase toda ocupada (só {free}GB livres de {total}GB). Considere reduzir a RAM alocada para o servidor, fechar outros programas, ou aumentar a RAM do computador.",
    "res.bottleneck.none": "O processador e a memória do computador não parecem estar no limite — o lag provavelmente vem de um mod/plugin específico, ou de muitos jogadores/entidades carregados ao mesmo tempo.",
    "res.sustainedCpu.title": "Processador sob pressão sustentada",
    "res.sustainedCpu.message": "O processador do computador está acima de {threshold}% de uso há alguns minutos, mesmo sem o Minecraft ter acusado lag ainda. Isso costuma anteceder travamentos — considere reduzir mods pesados/jogadores, ou de olho se isso persistir.",
    "res.sustainedRam.title": "Memória do computador sob pressão sustentada",
    "res.sustainedRam.message": "A memória RAM do computador está quase toda ocupada há alguns minutos. Considere reduzir a RAM alocada para o servidor ou fechar outros programas antes que isso vire uma queda por falta de memória.",

    "lag.watchdog.title": "Servidor travando (Watchdog)",
    "lag.watchdog.message": "O Minecraft detectou uma trava grave no processamento — algum mod ou plugin pode estar preso em um loop. Se isso se repetir, o servidor pode cair sozinho em breve. Veja o console para ver qual mod aparece perto do aviso.",
    "lag.severe.title": "Lag severo no servidor",
    "lag.severe.message": "O servidor está bem atrasado ({ms}ms atrás do esperado) e pode travar em breve. Costuma ser causado por mods pesados, muitas entidades/jogadores, ou hardware insuficiente para a configuração atual.",
    "lag.mild.title": "Servidor com lag",
    "lag.mild.message": "O servidor está tendo dificuldade de acompanhar o ritmo do jogo (aconteceu {count}x no último minuto). Costuma ser causado por mods pesados, geração de terreno em excesso, ou pouca RAM/CPU disponível.",

    "backup.source": "Backup",
    "backup.reason.stop": "servidor parado",
    "backup.reason.crash": "crash do servidor",
    "backup.reason.safetyNet": "sessão longa em andamento",
    "backup.created.title": "Backup automático criado",
    "backup.created.message": "Backup do mundo gerado ({reason}).",
    "backup.failed.title": "Não foi possível criar o backup automático",

    "deeplink.unrecognized.title": "Link de convite não reconhecido",
    "deeplink.unrecognized.message": "Recebemos um link, mas não conseguimos entender o convite.",
    "deeplink.received.title": "Convite recebido",
    "deeplink.received.message": "Abrindo a biblioteca de convidado para o servidor CF-{code}...",
  },
  en: {
    "res.oom.generic": "The server ran out of memory (RAM) while running. Increase the RAM allocated in the server settings, or close other programs to free up memory on the computer.",
    "res.oom.headroom": "The server ran out of memory, but your computer has RAM to spare: you allocated {allocated}GB, and the computer has {total}GB in total. You can safely increase the allocated RAM in the server settings up to about {max}GB.",
    "res.oom.tight": "The server ran out of memory, and your computer only has {total}GB of RAM in total — there isn't much headroom left beyond what's allocated ({allocated}GB). Consider reducing the number of mods/players, lowering the allocated RAM a bit to give the system more room, or upgrading the computer's RAM.",
    "res.bottleneck.cpu": "The computer's processor is maxed out ({percent}% usage) — that's probably the bottleneck. Consider lowering the render distance (view-distance), removing heavy mods, or upgrading the processor.",
    "res.bottleneck.ram": "The computer's memory is almost full (only {free}GB free of {total}GB). Consider reducing the RAM allocated to the server, closing other programs, or adding more RAM to the computer.",
    "res.bottleneck.none": "The computer's processor and memory don't seem to be maxed out — the lag most likely comes from a specific mod/plugin, or from many players/entities loaded at the same time.",
    "res.sustainedCpu.title": "Sustained processor pressure",
    "res.sustainedCpu.message": "The computer's processor has been above {threshold}% usage for a few minutes, even though Minecraft hasn't reported lag yet. This usually precedes freezes — consider reducing heavy mods/players, or keep an eye on it if it persists.",
    "res.sustainedRam.title": "Sustained computer memory pressure",
    "res.sustainedRam.message": "The computer's RAM has been almost full for a few minutes. Consider reducing the RAM allocated to the server or closing other programs before this turns into a crash from lack of memory.",

    "lag.watchdog.title": "Server freezing (Watchdog)",
    "lag.watchdog.message": "Minecraft detected a severe freeze in processing — some mod or plugin may be stuck in a loop. If this keeps happening, the server may crash on its own soon. Check the console to see which mod appears near the warning.",
    "lag.severe.title": "Severe server lag",
    "lag.severe.message": "The server is far behind ({ms}ms behind schedule) and may freeze soon. It's usually caused by heavy mods, many entities/players, or hardware that isn't enough for the current setup.",
    "lag.mild.title": "Server lagging",
    "lag.mild.message": "The server is struggling to keep up with the game's pace (it happened {count}x in the last minute). It's usually caused by heavy mods, excessive terrain generation, or too little available RAM/CPU.",

    "backup.source": "Backup",
    "backup.reason.stop": "server stopped",
    "backup.reason.crash": "server crash",
    "backup.reason.safetyNet": "long session in progress",
    "backup.created.title": "Automatic backup created",
    "backup.created.message": "World backup created ({reason}).",
    "backup.failed.title": "Couldn't create the automatic backup",

    "deeplink.unrecognized.title": "Invite link not recognized",
    "deeplink.unrecognized.message": "We received a link, but couldn't understand the invite.",
    "deeplink.received.title": "Invite received",
    "deeplink.received.message": "Opening the guest library for server CF-{code}...",
  },
});
