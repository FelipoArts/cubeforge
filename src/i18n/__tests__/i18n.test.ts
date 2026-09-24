import { describe, it, expect } from "vitest";
import { ptBR, en } from "../messages";
import { MODULES } from "../messages";
import { detectLocale, translate } from "../index";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

describe("dicionários", () => {
  it("en tem exatamente as mesmas chaves de pt-BR", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ptBR).sort());
  });
  it("nenhuma chave é definida por dois módulos", () => {
    const seen = new Map<string, string>();
    for (const [mod, def] of Object.entries(MODULES)) {
      for (const k of Object.keys(def["pt-BR"])) {
        expect(seen.get(k), `${k} duplicada em ${mod} e ${seen.get(k)}`).toBeUndefined();
        seen.set(k, mod);
      }
    }
  });
  it("placeholders {x} são idênticos entre idiomas", () => {
    for (const k of Object.keys(ptBR) as (keyof typeof ptBR)[]) {
      expect(placeholders(en[k]), k).toBe(placeholders(ptBR[k]));
    }
  });
  it("nenhuma tradução está vazia", () => {
    for (const [k, v] of Object.entries(en)) expect(v.trim(), k).not.toBe("");
  });
  it("plurais têm _one e _other nos dois idiomas", () => {
    for (const dict of [ptBR, en] as Record<string, string>[]) {
      for (const k of Object.keys(dict)) {
        if (k.endsWith("_one")) expect(dict[k.replace(/_one$/, "_other")], k).toBeDefined();
      }
    }
  });
});

describe("detectLocale", () => {
  it("pt-* → pt-BR", () => expect(detectLocale(["pt-PT"])).toBe("pt-BR"));
  it("en-* → en", () => expect(detectLocale(["en-GB"])).toBe("en"));
  it("respeita a ordem de preferência", () => expect(detectLocale(["de", "pt-BR"])).toBe("pt-BR"));
  it("idioma desconhecido → en", () => expect(detectLocale(["ja"])).toBe("en"));
  it("lista vazia → pt-BR", () => expect(detectLocale([])).toBe("pt-BR"));
});

describe("translate", () => {
  it("traduz por locale", () => {
    expect(translate("en", "language.label")).toBe("Language");
    expect(translate("pt-BR", "language.label")).toBe("Idioma");
  });
});
