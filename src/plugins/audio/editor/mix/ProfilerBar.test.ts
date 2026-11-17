// ADR 0171/0172 (Pf8): no colour literals in the bar slot's files; they read the theme tokens. What the bar shows and
// does (labels, the open progress and Cancel, the legend, Open, a chosen file) is ProfilerBar.stories.tsx.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("theme tokens only", () => {
  const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/;
  for (const file of ["openSaveFlow.css", "openSaveFlow.ts", "ProfilerBar.tsx", "ProfilerBanners.tsx", "profilerKeys.ts"]) {
    it(`${file} has no colour literal`, () => {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(COLOUR.test(text)).toBe(false);
    });
  }
  it("the stylesheet reads its colours from var(--token)", () => {
    const css = readFileSync(new URL("./openSaveFlow.css", import.meta.url), "utf8");
    expect(css).toMatch(/var\(--(accent|danger|muted|border|panel|text)\)/);
  });
});
