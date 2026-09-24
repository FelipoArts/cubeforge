// Cada arquivo em ./messages define UM módulo de textos com PT e EN lado a
// lado. O compilador garante que `en` tem exatamente as chaves de `pt-BR`.
//
// Convenções:
//  - chaves planas "area.subarea.nome" (o prefixo do módulo evita colisões;
//    um teste falha se duas áreas definirem a mesma chave);
//  - {variavel} para interpolação;
//  - plural: chaves "nome_one" / "nome_other" e chamar t("nome", { count }).
export function defineMessages<const P extends Record<string, string>>(m: {
  "pt-BR": P;
  en: { [K in keyof P]: string };
}) {
  return m;
}
