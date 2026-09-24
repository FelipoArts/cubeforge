//! i18n do backend — mesmo modelo do front (`src/i18n`): PT-BR e EN lado a lado.
//!
//! O front avisa o idioma efetivo via o comando `set_locale` (ver lib.rs) na
//! inicialização e a cada troca; daí em diante todo texto que o backend devolve
//! ao usuário (erros de comandos, diagnósticos, logs de rede, menu do tray)
//! já sai no idioma certo — sem o front precisar mapear códigos de erro.
//!
//! Uso: `tr!("chave")` ou `tr!("chave", nome = valor, outro = valor2)`. Os
//! placeholders são `{nome}` no catálogo. Chave inexistente devolve a própria
//! chave (e um teste garante que toda chave usada no código existe no catálogo).
//! O idioma padrão é pt-BR (também o dos testes existentes).

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
    PtBr,
    En,
}

// 0 = pt-BR, 1 = en
static LOCALE: AtomicU8 = AtomicU8::new(0);

pub fn locale() -> Locale {
    match LOCALE.load(Ordering::Relaxed) {
        1 => Locale::En,
        _ => Locale::PtBr,
    }
}

/// Aceita tags como "pt-BR", "en", "en-US". Qualquer coisa que não seja inglês cai em pt-BR.
pub fn parse_locale(tag: &str) -> Locale {
    if tag.trim().to_ascii_lowercase().starts_with("en") {
        Locale::En
    } else {
        Locale::PtBr
    }
}

pub fn set_locale(tag: &str) -> Locale {
    let parsed = parse_locale(tag);
    LOCALE.store(if parsed == Locale::En { 1 } else { 0 }, Ordering::Relaxed);
    parsed
}

/// Devolve o par (pt-BR, en) de uma chave, se existir.
pub fn lookup(key: &str) -> Option<(&'static str, &'static str)> {
    crate::i18n_messages::lookup(key)
}

/// Traduz `key` no idioma atual, substituindo `{nome}` pelos argumentos.
pub fn translate(key: &str, args: &[(&str, String)]) -> String {
    translate_in(locale(), key, args)
}

pub fn translate_in(locale: Locale, key: &str, args: &[(&str, String)]) -> String {
    let template = match lookup(key) {
        Some((pt, en)) => match locale {
            Locale::PtBr => pt,
            Locale::En => en,
        },
        None => return key.to_string(),
    };
    let mut out = template.to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{}}}", name), value);
    }
    out
}

/// `tr!("chave")` / `tr!("chave", nome = valor, ...)` — ver a documentação do módulo.
#[macro_export]
macro_rules! tr {
    ($key:literal) => {
        $crate::i18n::translate($key, &[])
    };
    ($key:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::translate($key, &[$((stringify!($name), $value.to_string())),+])
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn placeholders(s: &str) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let mut rest = s;
        while let Some(start) = rest.find('{') {
            let after = &rest[start + 1..];
            if let Some(end) = after.find('}') {
                let name = &after[..end];
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    out.insert(name.to_string());
                }
                rest = &after[end + 1..];
            } else {
                break;
            }
        }
        out
    }

    #[test]
    fn placeholders_batem_entre_idiomas_e_nada_esta_vazio() {
        for key in crate::i18n_messages::KEYS {
            let (pt, en) = lookup(key).expect("chave listada em KEYS");
            assert!(!pt.trim().is_empty() && !en.trim().is_empty(), "tradução vazia em {key}");
            assert_eq!(placeholders(pt), placeholders(en), "placeholders diferentes em {key}");
        }
    }

    #[test]
    fn toda_chave_usada_no_codigo_existe_no_catalogo() {
        // Varre o código-fonte por `tr!("chave"` e garante que a chave está no catálogo.
        let sources = [
            include_str!("lib.rs"),
            include_str!("session_manager.rs"),
            include_str!("api_client.rs"),
            include_str!("provider_manager.rs"),
            include_str!("panel_agent.rs"),
        ];
        let mut checked = 0;
        for src in sources {
            let mut rest = src;
            while let Some(pos) = rest.find("tr!(\"") {
                let after = &rest[pos + 5..];
                if let Some(end) = after.find('"') {
                    let key = &after[..end];
                    assert!(lookup(key).is_some(), "chave i18n inexistente no catálogo: {key}");
                    checked += 1;
                    rest = &after[end..];
                } else {
                    break;
                }
            }
        }
        assert!(checked > 0);
    }

    #[test]
    fn traduz_e_substitui_argumentos() {
        assert_eq!(
            translate_in(Locale::PtBr, "err.modNotFound", &[("file", "a.jar".to_string())]),
            "Mod não encontrado: a.jar"
        );
        assert_eq!(
            translate_in(Locale::En, "err.modNotFound", &[("file", "a.jar".to_string())]),
            "Mod not found: a.jar"
        );
        assert_eq!(translate_in(Locale::En, "chave.que.nao.existe", &[]), "chave.que.nao.existe");
    }

    #[test]
    fn parse_locale_reconhece_ingles_e_cai_em_ptbr() {
        // Não usa set_locale: o idioma global é compartilhado entre testes em paralelo.
        assert_eq!(parse_locale("en-US"), Locale::En);
        assert_eq!(parse_locale("EN"), Locale::En);
        assert_eq!(parse_locale("pt-BR"), Locale::PtBr);
        assert_eq!(parse_locale("de"), Locale::PtBr);
    }
}
