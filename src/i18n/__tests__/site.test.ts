import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkSite, buildSite } from "../../../scripts/site-i18n.mjs";

describe("i18n do site (docs/)", () => {
  it("todo texto das páginas e todo i18n.t() está no dicionário", () => {
    expect(checkSite()).toEqual([]);
  });

  it("as páginas /en/ versionadas estão em dia com o dicionário (rode `npm run site:i18n`)", () => {
    const root = path.resolve(__dirname, "../../..");
    const before = ["docs/en/index.html", "docs/en/download/index.html"].map((f) => fs.readFileSync(path.join(root, f), "utf8"));
    buildSite();
    const after = ["docs/en/index.html", "docs/en/download/index.html"].map((f) => fs.readFileSync(path.join(root, f), "utf8"));
    expect(after).toEqual(before);
  });
});
