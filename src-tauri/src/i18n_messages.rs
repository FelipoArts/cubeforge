//! Catálogo de mensagens do backend: cada chave tem (pt-BR, en) lado a lado.
//! Placeholders usam `{nome}`. Ver `i18n.rs` para o uso (`tr!`) e os testes que
//! garantem paridade de placeholders e que toda chave usada no código existe aqui.

macro_rules! messages {
    ($($key:literal => ($pt:literal, $en:literal),)*) => {
        /// Par (pt-BR, en) de uma chave.
        pub fn lookup(key: &str) -> Option<(&'static str, &'static str)> {
            match key {
                $($key => Some(($pt, $en)),)*
                _ => None,
            }
        }

        /// Todas as chaves do catálogo (usada nos testes de consistência).
        #[cfg(test)]
        pub const KEYS: &[&str] = &[$($key),*];
    };
}

messages! {
    // ---------- Tray ----------
    "tray.show" => ("Abrir Cubicase", "Open Cubicase"),
    "tray.quit" => ("Sair (encerra servidor e rede mesh)", "Quit (stops the server and mesh network)"),

    // ---------- Erros do sidecar de rede (título + mensagem) ----------
    "sidecar.config.title" => ("Configuração de rede inválida", "Invalid network configuration"),
    "sidecar.config.message" => (
        "Não foi possível ler a configuração da rede mesh. Tente reiniciar o app; se persistir, reinstale o Cubicase.",
        "Couldn't read the mesh network configuration. Try restarting the app; if it persists, reinstall Cubicase."
    ),
    "sidecar.auth.title" => ("Falha de autenticação na rede mesh", "Mesh network authentication failed"),
    "sidecar.auth.message" => (
        "Não foi possível autenticar na rede mesh (Tailscale). Verifique sua conexão com a internet e tente novamente.",
        "Couldn't authenticate with the mesh network (Tailscale). Check your internet connection and try again."
    ),
    "sidecar.noIp.title" => ("Nenhum IP atribuído pela rede mesh", "No IP assigned by the mesh network"),
    "sidecar.noIp.message" => (
        "A rede mesh não atribuiu um endereço para este dispositivo. Tente reconectar em alguns instantes.",
        "The mesh network didn't assign an address to this device. Try reconnecting in a few moments."
    ),
    "sidecar.listenMesh.title" => ("Falha ao abrir a porta na rede mesh", "Failed to open the port on the mesh network"),
    "sidecar.listenMesh.message" => (
        "Não foi possível abrir a porta do servidor na rede mesh. Tente reconectar; se persistir, pode haver conflito de hostname na malha.",
        "Couldn't open the server port on the mesh network. Try reconnecting; if it persists, there may be a hostname conflict on the mesh."
    ),
    "sidecar.listenLocal.title" => ("Porta local já em uso", "Local port already in use"),
    "sidecar.listenLocal.message" => (
        "Não foi possível abrir a porta local necessária para a conexão — provavelmente já está em uso por outro programa. Detalhe técnico: {detail}",
        "Couldn't open the local port needed for the connection — it's probably already in use by another program. Technical detail: {detail}"
    ),
    "sidecar.other.title" => ("Erro inesperado na rede mesh", "Unexpected mesh network error"),
    "sidecar.other.code" => ("Código: {code}", "Code: {code}"),
    "sidecar.hostUnreachable.title" => ("Conexão com o host instável", "Unstable connection to the host"),
    "sidecar.hostUnreachable.message" => (
        "Não estamos conseguindo alcançar o host na rede mesh há um tempo — a conexão pode ter caído ou o host pode ter ficado offline. O túnel continua tentando se recuperar sozinho; se persistir, peça para o host verificar a rede mesh dele.",
        "We haven't been able to reach the host on the mesh network for a while — the connection may have dropped or the host may have gone offline. The tunnel keeps trying to recover on its own; if it persists, ask the host to check their mesh network."
    ),
    "sidecar.warn.title" => ("Aviso na rede mesh", "Mesh network warning"),

    // ---------- Rede ----------
    "net.roleConflict" => (
        "Esta instalação já está com a rede mesh ativa como \"{active}\". Pare-a antes de conectar como \"{requested}\". Se quiser jogar no seu próprio servidor a partir deste mesmo computador, conecte direto em localhost:{port} — não precisa (e não é suportado) usar o modo Convidado para isso.",
        "This installation already has the mesh network active as \"{active}\". Stop it before connecting as \"{requested}\". If you want to play on your own server from this same computer, connect straight to localhost:{port} — you don't need to (and can't) use Guest mode for that."
    ),
    "net.role.host" => ("Host", "Host"),
    "net.role.guest" => ("Convidado", "Guest"),
    "net.credentialsFailed" => ("Não foi possível obter credenciais de rede: {error}", "Couldn't get network credentials: {error}"),
    "net.hostReconnected" => ("Conexão com o host da malha restabelecida.", "Connection to the mesh host restored."),
    "net.meshDisconnected" => ("Rede mesh desconectada.", "Mesh network disconnected."),
    "net.closed" => ("Conexão de rede encerrada: {title} (ver Central de Diagnósticos)", "Network connection closed: {title} (see the Diagnostics Center)"),
    "net.closedUnexpected" => ("Conexão de rede encerrada inesperadamente (Código: {code})", "Network connection closed unexpectedly (Code: {code})"),
    "net.mock.authenticating" => ("[mock-provider] Autenticando nó virtual de rede mesh simulado...", "[mock-provider] Authenticating the simulated mesh network virtual node..."),
    "net.mock.registered" => ("[mock-provider] Nó registrado com IP virtual simulado: {ip}", "[mock-provider] Node registered with simulated virtual IP: {ip}"),
    "net.mock.starting" => ("[mock-provider] Inicializando provedor de testes (Mock)...", "[mock-provider] Starting the test provider (Mock)..."),
    "net.mock.proxy" => ("[mock-provider] Proxy reverso simulado escutando em localhost:{port}", "[mock-provider] Simulated reverse proxy listening on localhost:{port}"),
    "net.mock.stopping" => ("[mock-provider] Finalizando sessão simulada...", "[mock-provider] Ending the simulated session..."),
    "net.mock.stopped" => ("[mock-provider] Rede mesh simulada encerrada.", "[mock-provider] Simulated mesh network stopped."),

    // ---------- Arquivos / launcher / instalação ----------
    "err.serversDatRead" => ("Falha ao ler servers.dat: {error}", "Failed to read servers.dat: {error}"),
    "err.serversDatBuild" => ("Falha ao montar servers.dat: {error}", "Failed to build servers.dat: {error}"),
    "err.serversDatSerialize" => ("Falha ao serializar servers.dat: {error}", "Failed to serialize servers.dat: {error}"),
    "err.serversDatWrite" => ("Falha ao gravar servers.dat: {error}", "Failed to write servers.dat: {error}"),
    "err.listVersions" => ("Falha ao listar versions/: {error}", "Failed to list versions/: {error}"),
    "err.instanceDir" => ("Falha ao criar a pasta da instância: {error}", "Failed to create the instance folder: {error}"),
    "err.profilesInvalid" => ("{file} não tem um campo \"profiles\" válido", "{file} has no valid \"profiles\" field"),
    "err.fileRead" => ("Falha ao ler {file}: {error}", "Failed to read {file}: {error}"),
    "err.fileParse" => ("Falha ao interpretar {file}: {error}", "Failed to parse {file}: {error}"),
    "err.fileBackup" => ("Falha ao criar backup de {file}: {error}", "Failed to back up {file}: {error}"),
    "err.fileSerialize" => ("Falha ao serializar {file}: {error}", "Failed to serialize {file}: {error}"),
    "err.fileWrite" => ("Falha ao gravar {file}: {error}", "Failed to write {file}: {error}"),
    "err.openLauncher" => ("Falha ao abrir o Minecraft Launcher: {error}", "Failed to open the Minecraft Launcher: {error}"),
    "err.downloadHttp" => ("Falha no download: HTTP {status}", "Download failed: HTTP {status}"),
    "err.checksumSha1" => ("Checksum SHA1 não confere (esperado {expected}, obtido {actual})", "SHA1 checksum mismatch (expected {expected}, got {actual})"),
    "err.checksumSha256" => ("Checksum SHA256 não confere (esperado {expected}, obtido {actual})", "SHA256 checksum mismatch (expected {expected}, got {actual})"),
    "err.checksumSha1AfterDownload" => ("Checksum SHA1 não confere após o download.", "SHA1 checksum mismatch after the download."),
    "err.downloadAttempts" => ("Falha ao baixar após {attempts} tentativas: {error}", "Download failed after {attempts} attempts: {error}"),
    "err.modDownloadAttempts" => ("Falha ao baixar mod após {attempts} tentativas: {error}", "Failed to download the mod after {attempts} attempts: {error}"),
    "err.openFile" => ("Não foi possível abrir o arquivo: {error}", "Couldn't open the file: {error}"),
    "err.invalidArchive" => ("Arquivo inválido ou corrompido: {error}", "Invalid or corrupted file: {error}"),

    // ---------- Servidor Minecraft ----------
    "mc.oom.title" => ("Sem memória suficiente (OutOfMemoryError)", "Not enough memory (OutOfMemoryError)"),
    "mc.oom.message" => (
        "O servidor Minecraft ficou sem memória durante a execução. Tente aumentar a RAM alocada nas configurações do servidor, ou feche outros programas para liberar memória.",
        "The Minecraft server ran out of memory while running. Try increasing the RAM allocated in the server settings, or close other programs to free up memory."
    ),
    "mc.javaVersion.title" => ("Versão do Java incompatível", "Incompatible Java version"),
    "mc.javaVersion.message" => (
        "A versão do Java instalada não é compatível com esta versão do Minecraft. Reinstale a JRE recomendada para este servidor nas configurações.",
        "The installed Java version isn't compatible with this Minecraft version. Reinstall the JRE recommended for this server in the settings."
    ),
    "mc.portInUse.title" => ("Porta já em uso", "Port already in use"),
    "mc.portInUse.message" => (
        "Não foi possível abrir a porta do servidor porque ela já está sendo usada por outro processo. Fecha o processo ou altere a porta do servidor nas configurações.",
        "Couldn't open the server port because it's already being used by another process. Close that process or change the server port in the settings."
    ),
    "mc.eula.title" => ("EULA não aceito", "EULA not accepted"),
    "mc.eula.message" => (
        "O arquivo eula.txt não está marcado como aceito. Isso normalmente é feito automaticamente pelo Cubicase — se persistir, abra a pasta do servidor e defina eula=true em eula.txt.",
        "The eula.txt file isn't marked as accepted. Cubicase normally does this automatically — if it persists, open the server folder and set eula=true in eula.txt."
    ),
    "mc.portBusy" => (
        "A porta {port} já está em uso por outro processo. Pare-o ou altere a porta do servidor antes de iniciar.",
        "Port {port} is already in use by another process. Stop it or change the server port before starting."
    ),
    "mc.notRunning" => ("Nenhum servidor Minecraft está em execução.", "No Minecraft server is running."),
    "mc.installerPath" => ("Caminho do instalador inválido", "Invalid installer path"),
    "mc.forgeTimeout" => ("Instalador do Forge excedeu o tempo limite de 10 minutos.", "The Forge installer exceeded the 10-minute time limit."),
    "mc.forgeWait" => ("Erro ao aguardar instalador do Forge: {error}", "Error waiting for the Forge installer: {error}"),
    "mc.forgeFailed" => ("Instalador do Forge falhou com código: {code}", "The Forge installer failed with code: {code}"),
    "mc.forgeFailedClient" => (
        "Instalador do Forge falhou com código: {code}. Se você nunca abriu o Minecraft Launcher neste computador, abra-o pelo menos uma vez e tente de novo.",
        "The Forge installer failed with code: {code}. If you've never opened the Minecraft Launcher on this computer, open it at least once and try again."
    ),
    "mc.forgeNoVersion" => ("O instalador do Forge rodou, mas não encontramos a versão instalada em versions/.", "The Forge installer ran, but we couldn't find the installed version in versions/."),
    "mc.fabricTimeout" => ("Instalador do Fabric excedeu o tempo limite de 5 minutos.", "The Fabric installer exceeded the 5-minute time limit."),
    "mc.fabricWait" => ("Erro ao aguardar instalador do Fabric: {error}", "Error waiting for the Fabric installer: {error}"),
    "mc.fabricFailed" => ("Instalador do Fabric falhou com código: {code}", "The Fabric installer failed with code: {code}"),
    "mc.fabricNoVersion" => ("O instalador do Fabric rodou, mas não encontramos a versão instalada em versions/.", "The Fabric installer ran, but we couldn't find the installed version in versions/."),
    "mc.installNotFound" => ("Não encontramos sua instalação do Minecraft.", "We couldn't find your Minecraft installation."),
    "err.iconOpen" => ("Não foi possível abrir a imagem: {error}", "Couldn't open the image: {error}"),
    "err.iconSave" => ("Não foi possível salvar o ícone: {error}", "Couldn't save the icon: {error}"),
    "err.modNotFound" => ("Mod não encontrado: {file}", "Mod not found: {file}"),

    // ---------- Backups do mundo ----------
    "backup.noWorld" => ("Nenhuma pasta de mundo encontrada para fazer backup.", "No world folder found to back up."),
    "backup.noWorldReset" => ("Nenhuma pasta de mundo encontrada para resetar.", "No world folder found to reset."),
    "backup.notFound" => ("Backup não encontrado: {file}", "Backup not found: {file}"),
    "backup.openFailed" => ("Não foi possível abrir o backup: {error}", "Couldn't open the backup: {error}"),
    "backup.corrupted" => ("Backup corrompido ou inválido — mundo atual preservado: {error}", "Corrupted or invalid backup — current world preserved: {error}"),
    "backup.corruptedEntry" => ("Backup corrompido (entrada {index} ilegível) — mundo atual preservado: {error}", "Corrupted backup (entry {index} unreadable) — current world preserved: {error}"),
    "backup.prepareFailed" => ("Não foi possível preparar a restauração (mundo atual preservado): {error}", "Couldn't prepare the restore (current world preserved): {error}"),
    "backup.extractFailed" => ("Falha ao extrair o backup — mundo original restaurado: {error}", "Failed to extract the backup — original world restored: {error}"),

    // ---------- Jogadores ----------
    "players.mojangNotFound" => ("Jogador \"{name}\" não encontrado (verifique o nome da conta Minecraft/Microsoft).", "Player \"{name}\" not found (check the Minecraft/Microsoft account name)."),
    "players.mojangHttp" => ("Falha ao consultar a API da Mojang: HTTP {status}", "Failed to query the Mojang API: HTTP {status}"),
    "players.alreadyWhitelisted" => ("\"{name}\" já está na whitelist.", "\"{name}\" is already on the whitelist."),
    "players.whitelistNotFound" => ("Jogador não encontrado na whitelist.", "Player not found on the whitelist."),
    "players.alreadyOp" => ("\"{name}\" já é operador.", "\"{name}\" is already an operator."),
    "players.opNotFound" => ("Operador não encontrado.", "Operator not found."),
    "players.alreadyBanned" => ("\"{name}\" já está banido.", "\"{name}\" is already banned."),
    "players.banNotFound" => ("Banimento não encontrado.", "Ban not found."),
    "players.ipAlreadyBanned" => ("O IP \"{ip}\" já está banido.", "The IP \"{ip}\" is already banned."),
    "players.ipBanNotFound" => ("Banimento de IP não encontrado.", "IP ban not found."),

    // ---------- Modpacks ----------
    "modpack.manifestInvalid" => ("manifest.json inválido: {error}", "Invalid manifest.json: {error}"),
    "modpack.noLoader" => ("Modpack não especifica um mod loader (Forge/Fabric/NeoForge).", "The modpack doesn't specify a mod loader (Forge/Fabric/NeoForge)."),
    "modpack.loaderParse" => ("Não foi possível interpretar o mod loader \"{loader}\".", "Couldn't parse the mod loader \"{loader}\"."),
    "modpack.loaderUnsupported" => ("Mod loader \"{loader}\" não é suportado pelo CubeForge.", "Mod loader \"{loader}\" isn't supported by CubeForge."),
    "modpack.indexInvalid" => ("modrinth.index.json inválido: {error}", "Invalid modrinth.index.json: {error}"),
    "modpack.noMcVersion" => ("Modpack não especifica a versão do Minecraft.", "The modpack doesn't specify the Minecraft version."),
    "modpack.quilt" => ("Modpacks Quilt não são suportados pelo CubeForge no momento.", "Quilt modpacks aren't supported by CubeForge at the moment."),
    "modpack.noSupportedLoader" => ("Modpack não especifica um mod loader suportado (Forge/Fabric/NeoForge).", "The modpack doesn't specify a supported mod loader (Forge/Fabric/NeoForge)."),
    "modpack.notAModpack" => (
        "Arquivo não é um modpack CurseForge (.zip) ou Modrinth (.mrpack) válido — manifest.json ou modrinth.index.json não encontrado.",
        "The file isn't a valid CurseForge (.zip) or Modrinth (.mrpack) modpack — manifest.json or modrinth.index.json not found."
    ),

    // ---------- Modrinth / API Central ----------
    "err.modrinthQuery" => ("Falha ao consultar o Modrinth: {error}", "Failed to query Modrinth: {error}"),
    "err.modrinthHttp" => ("Modrinth respondeu HTTP {status}", "Modrinth responded with HTTP {status}"),
    "err.modrinthUnexpected" => ("Resposta inesperada do Modrinth: {error}", "Unexpected response from Modrinth: {error}"),
    "err.connectionFailed" => ("Falha de conexão: {error}", "Connection failed: {error}"),
    "err.shortCodeRequired" => ("shortCode obrigatório", "shortCode required"),
    "err.queued" => ("Operação enfileirada.", "Operation queued."),
    "err.queuedForSync" => ("Operação enfileirada para sincronização.", "Operation queued for syncing."),
    "err.queuedWithError" => ("Operação enfileirada: {error}", "Operation queued: {error}"),
    "err.noNewShortCode" => ("Resposta da API sem o novo shortCode", "API response missing the new shortCode"),
    "err.neverTried" => ("Nunca tentado", "Never attempted"),
    "err.networkTimeout" => ("Timeout de {seconds}s esperando a rede (tentativa {attempt}/{max})", "Timed out after {seconds}s waiting for the network (attempt {attempt}/{max})"),
    "err.wakeNoJava" => (
        "Java ainda não instalado para este servidor — inicie-o manualmente pelo menos uma vez antes de ativar o modo de espera.",
        "Java isn't installed for this server yet — start it manually at least once before enabling standby mode."
    ),

    // ---------- Sessão / API client / providers ----------
    "session.invalidTransition" => ("Transição inválida: {from} → {to}", "Invalid transition: {from} → {to}"),
    "session.busy" => ("Já existe uma operação em andamento. Pare a sessão atual antes de iniciar outra.", "An operation is already in progress. Stop the current session before starting another one."),
    "session.internal" => ("Erro interno: {error}", "Internal error: {error}"),
    "session.sidecarApiFailed" => ("Sidecar online, mas API falhou: {error}", "Sidecar online, but the API failed: {error}"),
    "session.heartbeatFailed" => ("Heartbeat falhou: {error}", "Heartbeat failed: {error}"),
    "api.requestFailed" => ("Falha na requisição: {error}", "Request failed: {error}"),
    "api.parseFailed" => ("Falha ao parsear resposta: {error}", "Failed to parse the response: {error}"),
    "api.noData" => ("Resposta da API não contém 'data'", "The API response has no 'data'"),
    "api.sessionDeserialize" => ("Falha ao desserializar sessão: {error}", "Failed to deserialize the session: {error}"),
    "api.noDataShort" => ("Resposta não contém 'data'", "The response has no 'data'"),
    "provider.launcherUnsupported" => ("Launcher '{launcher}' não é suportado pelo ProviderManager.", "Launcher '{launcher}' isn't supported by the ProviderManager."),
    "provider.noAuthKey" => ("Credenciais não contêm 'authKey'", "Credentials don't contain 'authKey'"),
    "provider.dataDir" => ("Erro ao obter data_dir: {error}", "Error getting data_dir: {error}"),
    "provider.dataDirCreate" => ("Erro ao criar data_dir: {error}", "Error creating data_dir: {error}"),
    "provider.serializeConfig" => ("Erro ao serializar config: {error}", "Error serializing config: {error}"),
    "provider.tempFile" => ("Erro ao criar arquivo temp: {error}", "Error creating temp file: {error}"),
    "provider.writeConfig" => ("Erro ao escrever config: {error}", "Error writing config: {error}"),
    "provider.createSidecar" => ("Erro ao criar sidecar: {error}", "Error creating sidecar: {error}"),
    "provider.spawnSidecar" => ("Erro ao spawnar sidecar: {error}", "Error spawning sidecar: {error}"),
    "provider.mockNoSidecar" => ("Mock provider não requer sidecar. Use o fluxo mock diretamente.", "The mock provider doesn't need a sidecar. Use the mock flow directly."),
}
