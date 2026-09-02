// ============================================================
// Testes automatizados do backend
// ============================================================
// Cobre a lógica com mais risco de regressão silenciosa: gerenciamento de
// jogadores (whitelist/ops/banidos), backup/restauração de mundo, parsing de
// server.properties, detecção de erros conhecidos do Minecraft/sidecar, e o
// cálculo de UUID offline (que precisa bater exatamente com o algoritmo do
// próprio Minecraft, ou bans/whitelist por UUID silenciosamente não fazem
// efeito nenhum).
//
// Roda com `cargo test` (ou `npm run test:backend`, que já usa --quiet pra
// não poluir o console). Tudo aqui é local — sem rede, sem AppHandle, sem
// subir o app de verdade — só arquivos temporários descartados no final de
// cada teste.
// ============================================================

use super::*;
use std::fs;
use tempfile::TempDir;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

fn server_dir(tmp: &TempDir) -> String {
    tmp.path().to_string_lossy().to_string()
}

fn write_properties(tmp: &TempDir, content: &str) {
    fs::write(tmp.path().join("server.properties"), content).unwrap();
}

fn make_world(tmp: &TempDir, level_name: &str, suffix: &str) -> std::path::PathBuf {
    let dir = tmp.path().join(format!("{}{}", level_name, suffix));
    fs::create_dir_all(&dir).unwrap();
    dir
}

// ------------------------------------------------------------
// map_sidecar_error_code / detect_known_mc_error / truncate_chars / read_log_tail
// ------------------------------------------------------------

#[test]
fn sidecar_error_known_codes_have_friendly_messages() {
    for code in [
        "config_missing",
        "config_read_failed",
        "config_decode_failed",
        "mesh_auth_failed",
        "no_ip_assigned",
        "listen_mesh_failed",
    ] {
        let (title, message) = map_sidecar_error_code(code, "");
        assert!(!title.is_empty());
        assert!(!message.is_empty());
    }
}

#[test]
fn sidecar_error_listen_local_failed_includes_detail() {
    let (title, message) = map_sidecar_error_code("listen_local_failed", "port 25565 in use");
    assert_eq!(title, "Porta local já em uso");
    assert!(message.contains("port 25565 in use"));
}

#[test]
fn sidecar_error_unknown_code_falls_back_to_detail_or_code() {
    let (_, with_detail) = map_sidecar_error_code("something_new", "raw detail here");
    assert_eq!(with_detail, "raw detail here");

    let (_, without_detail) = map_sidecar_error_code("something_new", "");
    assert!(without_detail.contains("something_new"));
}

#[test]
fn detects_known_minecraft_errors() {
    let cases = [
        ("java.lang.OutOfMemoryError: Java heap space", "out_of_memory"),
        ("Could not reserve enough space for object heap", "out_of_memory"),
        ("UnsupportedClassVersionError: app has been compiled by a more recent version", "java_version_incompatible"),
        ("java.net.BindException: Address already in use", "port_in_use"),
        ("Exception: BindException at ...", "port_in_use"),
        ("You need to agree to the EULA in order to run the server", "eula_not_accepted"),
    ];
    for (line, expected_code) in cases {
        let result = detect_known_mc_error(line);
        assert!(result.is_some(), "esperava detectar erro na linha: {line}");
        assert_eq!(result.unwrap().0, expected_code);
    }
}

#[test]
fn detects_known_minecraft_errors_returns_none_for_unrelated_lines() {
    assert!(detect_known_mc_error("[Server thread/INFO]: Done (12.345s)! For help, type \"help\"").is_none());
    assert!(detect_known_mc_error("").is_none());
}

#[test]
fn truncate_chars_keeps_short_strings_untouched() {
    assert_eq!(truncate_chars("curto", 100), "curto");
    assert_eq!(truncate_chars("exato", 5), "exato"); // no limite exato, não trunca
}

#[test]
fn truncate_chars_truncates_by_char_count_not_bytes() {
    // "áéíóú" tem 5 chars mas mais de 5 bytes em UTF-8 — truncar por byte quebraria no meio de um caractere.
    let s = "áéíóúçãõ";
    let truncated = truncate_chars(s, 3);
    assert_eq!(truncated, "áéí\n... (truncado)");
}

#[test]
fn read_log_tail_missing_file_returns_none() {
    let tmp = TempDir::new().unwrap();
    assert!(read_log_tail(&server_dir(&tmp), 10).is_none());
}

#[test]
fn read_log_tail_returns_only_last_n_lines() {
    let tmp = TempDir::new().unwrap();
    let logs_dir = tmp.path().join("logs");
    fs::create_dir_all(&logs_dir).unwrap();
    let lines: Vec<String> = (1..=20).map(|i| format!("linha {i}")).collect();
    fs::write(logs_dir.join("latest.log"), lines.join("\n")).unwrap();

    let tail = read_log_tail(&server_dir(&tmp), 3).unwrap();
    assert_eq!(tail, "linha 18\nlinha 19\nlinha 20");
}

#[test]
fn read_log_tail_returns_everything_if_fewer_lines_than_requested() {
    let tmp = TempDir::new().unwrap();
    let logs_dir = tmp.path().join("logs");
    fs::create_dir_all(&logs_dir).unwrap();
    fs::write(logs_dir.join("latest.log"), "a\nb").unwrap();

    let tail = read_log_tail(&server_dir(&tmp), 50).unwrap();
    assert_eq!(tail, "a\nb");
}

// ------------------------------------------------------------
// server.properties (read/write) + online-mode + level-name
// ------------------------------------------------------------

#[tokio::test]
async fn read_server_properties_parses_key_value_and_skips_comments() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "# comentário\n\nlevel-name=meu-mundo\nmax-players=10\n");

    let result = read_server_properties(server_dir(&tmp)).await.unwrap();
    assert_eq!(result["level-name"], "meu-mundo");
    assert_eq!(result["max-players"], "10");
}

#[tokio::test]
async fn read_server_properties_missing_file_is_error() {
    let tmp = TempDir::new().unwrap();
    assert!(read_server_properties(server_dir(&tmp)).await.is_err());
}

#[tokio::test]
async fn write_server_properties_updates_existing_key_in_place() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "level-name=world\nmax-players=10\n");

    let mut props = HashMap::new();
    props.insert("max-players".to_string(), "20".to_string());
    write_server_properties(server_dir(&tmp), props).await.unwrap();

    let content = fs::read_to_string(tmp.path().join("server.properties")).unwrap();
    assert!(content.contains("max-players=20"));
    assert!(content.contains("level-name=world"));
    assert!(!content.contains("max-players=10"));
}

#[tokio::test]
async fn write_server_properties_appends_new_key_and_creates_file_if_missing() {
    let tmp = TempDir::new().unwrap();
    let mut props = HashMap::new();
    props.insert("online-mode".to_string(), "false".to_string());
    write_server_properties(server_dir(&tmp), props).await.unwrap();

    let content = fs::read_to_string(tmp.path().join("server.properties")).unwrap();
    assert!(content.contains("online-mode=false"));
}

#[test]
fn read_online_mode_defaults_to_true_when_missing() {
    let tmp = TempDir::new().unwrap();
    assert!(read_online_mode(&server_dir(&tmp)));
}

#[test]
fn read_online_mode_respects_explicit_false() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "online-mode=false\n");
    assert!(!read_online_mode(&server_dir(&tmp)));
}

#[test]
fn read_online_mode_respects_explicit_true() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "online-mode=true\n");
    assert!(read_online_mode(&server_dir(&tmp)));
}

#[test]
fn read_level_name_defaults_to_world() {
    let tmp = TempDir::new().unwrap();
    assert_eq!(read_level_name(&server_dir(&tmp)), "world");
}

#[test]
fn read_level_name_reads_custom_value() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "level-name=meu-mundo\n");
    assert_eq!(read_level_name(&server_dir(&tmp)), "meu-mundo");
}

#[test]
fn read_level_name_falls_back_when_value_is_empty() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "level-name=\n");
    assert_eq!(read_level_name(&server_dir(&tmp)), "world");
}

#[test]
fn world_folder_paths_only_returns_existing_dirs() {
    let tmp = TempDir::new().unwrap();
    make_world(&tmp, "world", "");
    make_world(&tmp, "world", "_nether");
    // world_the_end não existe

    let paths = world_folder_paths(&server_dir(&tmp), "world");
    assert_eq!(paths.len(), 2);
}

#[test]
fn world_folder_paths_empty_when_nothing_exists() {
    let tmp = TempDir::new().unwrap();
    assert!(world_folder_paths(&server_dir(&tmp), "world").is_empty());
}

// ------------------------------------------------------------
// world_last_modified
// ------------------------------------------------------------

#[test]
fn world_last_modified_none_when_world_never_existed() {
    let tmp = TempDir::new().unwrap();
    assert_eq!(world_last_modified(server_dir(&tmp)).unwrap(), None);
}

#[test]
fn world_last_modified_some_when_world_has_files() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"fake nbt data").unwrap();

    let result = world_last_modified(server_dir(&tmp)).unwrap();
    assert!(result.is_some());
    // precisa ser um RFC3339 válido, já que autoBackup.ts compara essas strings como opacas.
    assert!(chrono::DateTime::parse_from_rfc3339(&result.unwrap()).is_ok());
}

// ------------------------------------------------------------
// offline_player_uuid / format_uuid_with_dashes
// ------------------------------------------------------------

#[test]
fn offline_player_uuid_matches_minecraft_algorithm() {
    // Valores de referência calculados independentemente (MD5 de
    // "OfflinePlayer:<nome>" com os bits de versão/variante ajustados para
    // UUID v3), não copiados da implementação em Rust.
    assert_eq!(
        offline_player_uuid("TestPlayer123").to_string(),
        "d80b74d8-555e-3ea2-8280-a62da27307e1"
    );
    assert_eq!(
        offline_player_uuid("").to_string(),
        "fc5bc365-aedf-30a8-8b89-04e462e29bde"
    );
}

#[test]
fn offline_player_uuid_is_deterministic_and_unique_per_name() {
    assert_eq!(offline_player_uuid("Steve"), offline_player_uuid("Steve"));
    assert_ne!(offline_player_uuid("Steve"), offline_player_uuid("Alex"));
}

#[test]
fn offline_player_uuid_has_correct_version_and_variant_bits() {
    let uuid = offline_player_uuid("QualquerNome");
    let bytes = uuid.as_bytes();
    assert_eq!(bytes[6] & 0xf0, 0x30, "deveria ser UUID versão 3");
    assert_eq!(bytes[8] & 0xc0, 0x80, "variante deveria ser RFC 4122");
}

#[test]
fn format_uuid_with_dashes_inserts_dashes_correctly() {
    assert_eq!(
        format_uuid_with_dashes("d80b74d8555e3ea28280a62da27307e1"),
        "d80b74d8-555e-3ea2-8280-a62da27307e1"
    );
}

#[test]
fn format_uuid_with_dashes_leaves_wrong_length_untouched() {
    assert_eq!(format_uuid_with_dashes("nao-tem-32-chars"), "nao-tem-32-chars");
    assert_eq!(format_uuid_with_dashes(""), "");
}

#[test]
fn current_ban_timestamp_matches_expected_format() {
    // Formato "YYYY-MM-DD HH:MM:SS +ZZZZ" (o mesmo que banned-players.json do
    // Minecraft usa) — não dá pra comparar o valor exato (depende do agora),
    // então valida a estrutura.
    let ts = current_ban_timestamp();
    let parts: Vec<&str> = ts.split(' ').collect();
    assert_eq!(parts.len(), 3, "esperava 3 partes separadas por espaço: {ts}");
    assert_eq!(parts[0].len(), 10); // YYYY-MM-DD
    assert_eq!(parts[1].len(), 8); // HH:MM:SS
    assert!(parts[2].starts_with('+') || parts[2].starts_with('-'));
}

// ------------------------------------------------------------
// Whitelist / Operadores / Banidos (offline-mode, sem rede)
// ------------------------------------------------------------

fn offline_server(tmp: &TempDir) -> String {
    write_properties(tmp, "online-mode=false\n");
    server_dir(tmp)
}

#[tokio::test]
async fn whitelist_add_list_remove_round_trip() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);

    assert!(list_whitelist(dir.clone()).await.unwrap().is_empty());

    let added = add_whitelist_player(dir.clone(), "Steve".to_string()).await.unwrap();
    assert_eq!(added.name, "Steve");
    assert_eq!(added.uuid, offline_player_uuid("Steve").to_string());

    let listed = list_whitelist(dir.clone()).await.unwrap();
    assert_eq!(listed.len(), 1);

    remove_whitelist_player(dir.clone(), added.uuid).await.unwrap();
    assert!(list_whitelist(dir.clone()).await.unwrap().is_empty());
}

#[tokio::test]
async fn whitelist_rejects_duplicate_name_case_insensitive() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);

    add_whitelist_player(dir.clone(), "Steve".to_string()).await.unwrap();
    let err = add_whitelist_player(dir.clone(), "STEVE".to_string()).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn whitelist_remove_nonexistent_is_error() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let err = remove_whitelist_player(dir, "uuid-que-nao-existe".to_string()).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn ops_add_grants_level_four_by_default() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);

    let op = add_op(dir.clone(), "Alex".to_string()).await.unwrap();
    assert_eq!(op.level, 4);
    assert!(!op.bypasses_player_limit);

    remove_op(dir.clone(), op.uuid).await.unwrap();
    assert!(list_ops(dir).await.unwrap().is_empty());
}

#[tokio::test]
async fn ban_player_uses_default_reason_when_none_given() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);

    let banned = ban_player(dir.clone(), "Grief3r".to_string(), None).await.unwrap();
    assert_eq!(banned.reason, "Banido por um operador.");
    assert_eq!(banned.expires, "forever");

    let err = ban_player(dir.clone(), "Grief3r".to_string(), None).await;
    assert!(err.is_err(), "não deveria permitir banir o mesmo jogador duas vezes");

    pardon_player(dir.clone(), banned.uuid).await.unwrap();
    assert!(list_banned_players(dir).await.unwrap().is_empty());
}

#[tokio::test]
async fn ban_player_keeps_custom_reason() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);

    let banned = ban_player(dir, "Grief3r".to_string(), Some("Xingou no chat".to_string())).await.unwrap();
    assert_eq!(banned.reason, "Xingou no chat");
}

#[tokio::test]
async fn ban_ip_round_trip_and_duplicate_rejection() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);

    ban_ip(dir.clone(), "203.0.113.9".to_string(), None).await.unwrap();
    let err = ban_ip(dir.clone(), "203.0.113.9".to_string(), None).await;
    assert!(err.is_err());

    pardon_ip(dir.clone(), "203.0.113.9".to_string()).await.unwrap();
    assert!(list_banned_ips(dir).await.unwrap().is_empty());
}

#[tokio::test]
async fn pardon_ip_nonexistent_is_error() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    assert!(pardon_ip(dir, "203.0.113.9".to_string()).await.is_err());
}

// ------------------------------------------------------------
// read_json_list / write_json_list (usados por whitelist/ops/bans)
// ------------------------------------------------------------

#[test]
fn read_json_list_missing_file_returns_empty() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nao-existe.json");
    let result: Vec<WhitelistEntry> = read_json_list(&path).unwrap();
    assert!(result.is_empty());
}

#[test]
fn read_json_list_empty_file_returns_empty() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("vazio.json");
    fs::write(&path, "").unwrap();
    let result: Vec<WhitelistEntry> = read_json_list(&path).unwrap();
    assert!(result.is_empty());
}

#[test]
fn read_json_list_malformed_json_is_error() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("corrompido.json");
    fs::write(&path, "{ isso nao eh um array valido").unwrap();
    let result: Result<Vec<WhitelistEntry>, String> = read_json_list(&path);
    assert!(result.is_err());
}

// ------------------------------------------------------------
// Backup / restauração / reset de mundo
// ------------------------------------------------------------

#[tokio::test]
async fn backup_world_fails_when_no_world_exists() {
    let tmp = TempDir::new().unwrap();
    let err = backup_world(server_dir(&tmp)).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn backup_world_creates_zip_with_world_contents() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"conteudo de teste").unwrap();

    let info = backup_world(server_dir(&tmp)).await.unwrap();
    assert!(info.file_name.starts_with("world_"));
    assert!(info.file_name.ends_with(".zip"));
    assert!(info.size_bytes > 0);

    let backups = list_world_backups(server_dir(&tmp)).await.unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].file_name, info.file_name);
}

#[tokio::test]
async fn list_world_backups_empty_when_no_backups_dir() {
    let tmp = TempDir::new().unwrap();
    assert!(list_world_backups(server_dir(&tmp)).await.unwrap().is_empty());
}

#[tokio::test]
async fn restore_world_backup_round_trip_replaces_world_contents() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"versao original").unwrap();

    let info = backup_world(server_dir(&tmp)).await.unwrap();

    // Simula progresso do jogo depois do backup.
    fs::write(world.join("level.dat"), b"versao mais nova, sera perdida").unwrap();
    fs::write(world.join("novo-arquivo.txt"), b"nao existia no backup").unwrap();

    restore_world_backup(server_dir(&tmp), info.file_name).await.unwrap();

    let restored = fs::read(world.join("level.dat")).unwrap();
    assert_eq!(restored, b"versao original");
}

#[tokio::test]
async fn restore_world_backup_missing_file_is_error() {
    let tmp = TempDir::new().unwrap();
    make_world(&tmp, "world", "");
    let err = restore_world_backup(server_dir(&tmp), "nao-existe.zip".to_string()).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn restore_world_backup_rejects_corrupted_zip_and_preserves_world() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"mundo original intacto").unwrap();

    let backups_dir = tmp.path().join("backups");
    fs::create_dir_all(&backups_dir).unwrap();
    fs::write(backups_dir.join("corrompido.zip"), b"isso nao eh um zip de verdade").unwrap();

    let err = restore_world_backup(server_dir(&tmp), "corrompido.zip".to_string()).await;
    assert!(err.is_err());

    // O mundo original não pode ter sido tocado por um backup corrompido.
    let content = fs::read(world.join("level.dat")).unwrap();
    assert_eq!(content, b"mundo original intacto");
}

#[tokio::test]
async fn delete_world_backup_missing_is_error_existing_is_removed() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"x").unwrap();
    let info = backup_world(server_dir(&tmp)).await.unwrap();

    assert!(delete_world_backup(server_dir(&tmp), "nao-existe.zip".to_string()).await.is_err());

    delete_world_backup(server_dir(&tmp), info.file_name).await.unwrap();
    assert!(list_world_backups(server_dir(&tmp)).await.unwrap().is_empty());
}

#[tokio::test]
async fn reset_world_removes_folders_and_errors_when_nothing_to_reset() {
    let tmp = TempDir::new().unwrap();
    assert!(reset_world(server_dir(&tmp)).await.is_err());

    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"x").unwrap();
    reset_world(server_dir(&tmp)).await.unwrap();
    assert!(!world.exists());
}

// ------------------------------------------------------------
// Mods (listar / habilitar-desabilitar / apagar)
// ------------------------------------------------------------

#[tokio::test]
async fn list_mods_filters_and_sorts_correctly() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    fs::create_dir_all(&mods_dir).unwrap();
    fs::write(mods_dir.join("Zebra.jar"), b"x").unwrap();
    fs::write(mods_dir.join("apple.jar.disabled"), b"x").unwrap();
    fs::write(mods_dir.join("nota-mod.txt"), b"x").unwrap(); // deve ser ignorado

    let mods = list_mods(server_dir(&tmp), None).await.unwrap();
    assert_eq!(mods.len(), 2);
    // ordenação case-insensitive: "apple" antes de "Zebra"
    assert_eq!(mods[0].display_name, "apple.jar");
    assert!(!mods[0].enabled);
    assert_eq!(mods[1].display_name, "Zebra.jar");
    assert!(mods[1].enabled);
}

#[tokio::test]
async fn list_mods_empty_when_folder_missing() {
    let tmp = TempDir::new().unwrap();
    assert!(list_mods(server_dir(&tmp), None).await.unwrap().is_empty());
}

#[tokio::test]
async fn toggle_mod_disables_and_reenables() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    fs::create_dir_all(&mods_dir).unwrap();
    fs::write(mods_dir.join("Test.jar"), b"x").unwrap();

    toggle_mod(server_dir(&tmp), "Test.jar".to_string(), None).await.unwrap();
    assert!(mods_dir.join("Test.jar.disabled").exists());
    assert!(!mods_dir.join("Test.jar").exists());

    toggle_mod(server_dir(&tmp), "Test.jar.disabled".to_string(), None).await.unwrap();
    assert!(mods_dir.join("Test.jar").exists());
}

#[tokio::test]
async fn toggle_mod_missing_file_is_error() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(tmp.path().join("mods")).unwrap();
    assert!(toggle_mod(server_dir(&tmp), "fantasma.jar".to_string(), None).await.is_err());
}

#[tokio::test]
async fn delete_mod_removes_file_missing_is_error() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    fs::create_dir_all(&mods_dir).unwrap();
    fs::write(mods_dir.join("Test.jar"), b"x").unwrap();

    assert!(delete_mod(server_dir(&tmp), "fantasma.jar".to_string(), None).await.is_err());

    delete_mod(server_dir(&tmp), "Test.jar".to_string(), None).await.unwrap();
    assert!(!mods_dir.join("Test.jar").exists());
}

// ------------------------------------------------------------
// Recorte/redimensionamento de ícone
// ------------------------------------------------------------

#[test]
fn crop_and_resize_icon_always_outputs_64x64_square() {
    // Imagem larga (100x50) — deve recortar o excesso e não distorcer.
    let wide = image::DynamicImage::ImageRgba8(image::RgbaImage::new(100, 50));
    let result = crop_and_resize_icon(wide);
    assert_eq!((result.width(), result.height()), (64, 64));

    // Imagem alta (50x100).
    let tall = image::DynamicImage::ImageRgba8(image::RgbaImage::new(50, 100));
    let result = crop_and_resize_icon(tall);
    assert_eq!((result.width(), result.height()), (64, 64));

    // Já quadrada, mas em tamanho diferente de 64.
    let square = image::DynamicImage::ImageRgba8(image::RgbaImage::new(200, 200));
    let result = crop_and_resize_icon(square);
    assert_eq!((result.width(), result.height()), (64, 64));
}
