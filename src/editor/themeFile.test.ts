import { describe, expect, it } from "vitest";
import { PRESETS, presetById, resolveTheme, luminance } from "./theme";
import { cleanThemeName, parseThemeFile, serializeThemeFile, themeIdFor, THEME_FORMAT_ID, toThemeFile } from "./themeFile";

const light = PRESETS.find((p) => p.kind === "light")!;

describe("theme files (ADR 0116)", () => {
  it("round-trips a preset with overrides", () => {
    const file = toThemeFile(PRESETS[0], { accent: "#FF0000", bogus: "#123456", text: "nope" }, "My Theme");
    expect(file.format).toBe(THEME_FORMAT_ID);
    expect(file.base.accent).toBe("#ff0000");
    expect(file.base.text).toBe(PRESETS[0].base.text); // invalid override ignored
    const { theme, problems } = parseThemeFile(serializeThemeFile(file));
    expect(problems).toEqual([]);
    expect(theme).toMatchObject({ id: "custom-my-theme", name: "My Theme", kind: "dark", base: file.base, danger: file.danger });
    expect(Object.keys(resolveTheme(theme!)).length).toBeGreaterThan(40); // usable as a preset
  });

  it("reads leniently: partial colours fall back to the same-kind built-in", () => {
    const { theme, problems } = parseThemeFile(JSON.stringify({ name: "Sky", kind: "light", base: { panel: "#fff", accent: "blue", extra: 1 }, unknown: true }));
    expect(theme!.kind).toBe("light");
    expect(theme!.base.panel).toBe("#ffffff");
    expect(theme!.base.bg).toBe(light.base.bg);
    expect(theme!.base.accent).toBe(light.base.accent);
    expect(problems.some((p) => p.includes('"accent"'))).toBe(true);
  });

  it("guesses the kind from the panel colour and notes newer formats", () => {
    const a = parseThemeFile(JSON.stringify({ format: "myco.theme@9", base: { panel: "#fafafa" } }));
    expect(a.theme!.kind).toBe("light");
    expect(a.theme!.name).toBe("Imported theme");
    expect(a.problems[0]).toMatch(/newer/);
    expect(parseThemeFile(JSON.stringify({ base: { panel: "#101010" }, kind: "weird" })).theme!.kind).toBe("dark");
  });

  it("rejects what isn't a theme", () => {
    for (const text of ["", "not json", "[]", "null", "{}", '{"base":{"panel":"red"}}', '{"base":5}']) {
      const r = parseThemeFile(text);
      expect(r.theme).toBeNull();
      expect(r.problems.length).toBeGreaterThan(0);
    }
  });

  it("cleans names and makes stable ids", () => {
    expect(cleanThemeName("  <b>Hi</b>\n there ")).toBe("bHi/b there");
    expect(cleanThemeName(5)).toBe("Imported theme");
    expect(cleanThemeName("x".repeat(100)).length).toBe(60);
    expect(themeIdFor("Dark & Stormy!")).toBe("custom-dark-stormy");
    expect(themeIdFor("!!!")).toBe("custom-theme");
  });

  it("has built-in presets of each luminance for the logo variant", () => {
    expect(luminance(presetById("myco-light").base.panel)).toBeGreaterThan(0.4);
    expect(luminance(presetById("myco-dark").base.panel)).toBeLessThan(0.4);
  });
});
