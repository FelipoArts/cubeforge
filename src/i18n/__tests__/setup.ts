// Os testes existentes afirmam sobre textos em português; fixa o idioma para
// não depender do locale da máquina/CI (Node 21+ expõe `navigator.language`).
import { setLanguagePreference } from "../index";

setLanguagePreference("pt-BR");
