import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ensureContrast } from "./colorMath";
import {
  BASE_KEYS,
  clampSize,
  CODE_FONTS,
  codeFontFamily,
  codeFontSize,
  contrast,
  cssVar,
  activePreset,
  fonts,
  installTheme,
  mergeBase,
  mix,
  monacoColors,
  parseHex,
  PRESETS,
  resetOverrides,
  setOverride,
  theme,
  themePreset,
  uiFontFamily,
  uiFontSize,
  UI_FONTS,
  viewportColors,
  type ThemeBase,
  type ThemePreset,
  type ThemeTokens,
} from "./theme";

const presetById = (id: string) => PRESETS.find((p) => p.id === id)!;

/** The editor's theme tokens with `preset` chosen and `overrides` of its key colours set. */
function resolveTheme(preset: ThemePreset, overrides: Partial<ThemeBase> = {}): ThemeTokens {
  themePreset.value = preset.id;
  resetOverrides();
  for (const [key, value] of Object.entries(overrides)) setOverride(key as keyof ThemeBase, value);
  const tokens = theme.value;
  resetOverrides();
  themePreset.value = "myco-dark";
  return tokens;
}

describe("colour maths", () => {
  it("parses short and long hex, and mixes", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("19e6e6")).toEqual([25, 230, 230]);
    expect(parseHex("teal")).toBeNull();
    expect(parseHex("#ffcc0080")).toEqual([255, 204, 0]); // alpha forms parse as the engine's (ADR 0461); was null
    expect(parseHex("#fc08")).toEqual([255, 204, 0]);
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("computes WCAG contrast and moves a colour until it's readable", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    const fixed = ensureContrast("#202020", "#101010", 4.5, "#ffffff");
    expect(contrast(fixed, "#101010")).toBeGreaterThanOrEqual(4.5);
  });

  it("names tokens as CSS custom properties", () => {
    expect(cssVar("bg")).toBe("--bg");
    expect(cssVar("buttonHover")).toBe("--button-hover");
    expect(cssVar("accent2Soft")).toBe("--accent2-soft");
  });
});

describe("presets", () => {
  it("include Myco Dark (the default), Myco Light and a high-contrast theme", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(["myco-dark", "myco-light", "high-contrast"]));
    themePreset.value = "nonsense";
    expect(activePreset.value.id).toBe("myco-dark");
    themePreset.value = "myco-dark";
  });

  it.each(PRESETS.map((p) => [p.name, p] as const))("%s keeps text readable", (_name, preset) => {
    const t = resolveTheme(preset);
    expect(contrast(t.text, t.panel)).toBeGreaterThanOrEqual(7);
    expect(contrast(t.muted, t.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.link, t.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.accentText, t.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.selectionText, t.selection)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.danger, t.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.warning, t.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.dangerText, t.dangerStrong)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.accent, t.panel)).toBeGreaterThanOrEqual(3);
  });

  const STUDIO_KEYS = ["markerExit", "markerHit", "markerCue", "markerNote", "rangeTrim", "rangeLoop", "rangePickup", "rangeTail", ...Array.from({ length: 8 }, (_, i) => `series-${i + 1}`)] as (keyof ThemeTokens)[];

  it.each(PRESETS.map((p) => [p.name, p] as const))("%s gives the Audio Studio legible marker, range and series colours", (_name, preset) => {
    const t = resolveTheme(preset);
    const min = preset.kind === "high-contrast" ? 4.5 : 3;
    for (const key of STUDIO_KEYS) expect(contrast(t[key], t.panel), key).toBeGreaterThanOrEqual(min - 0.01);
    const series = Array.from({ length: 8 }, (_, i) => t[`series-${i + 1}` as keyof ThemeTokens]);
    expect(new Set(series).size).toBe(8);
    expect(new Set([t.markerExit, t.markerHit, t.markerCue, t.markerNote]).size).toBe(4);
    expect(cssVar("series-1")).toBe("--series-1");
    expect(cssVar("markerExit")).toBe("--marker-exit");
  });

  it("paints the Audio Studio tokens at first paint as Myco Dark resolves them (editor.css)", () => {
    const css = readFileSync(new URL("./ui/editor.css", import.meta.url), "utf8");
    const t = resolveTheme(presetById("myco-dark"));
    for (const key of STUDIO_KEYS) expect(css, key).toContain(`${cssVar(key)}: ${t[key]};`);
  });

  it("Myco Dark follows the brand art: near-black, glowing cyan, moss green, warm white", () => {
    const t = resolveTheme(presetById("myco-dark"));
    expect(t.accent).toBe("#2ad4d4");
    expect(t.accent2).toBe("#8bd12a");
    expect(t.text).toBe("#f4efe6");
    expect(contrast(t.bg, "#000000")).toBeLessThan(1.2);
  });
});

describe("overrides", () => {
  const dark = presetById("myco-dark");

  it("replace a preset's key colours; anything that isn't a colour is ignored", () => {
    const base = mergeBase(dark, { accent: "#FF00AA", panel: "not a colour", text: 42, bogus: "#123456" });
    expect(base.accent).toBe("#ff00aa");
    expect(base.panel).toBe(dark.base.panel);
    expect(base.text).toBe(dark.base.text);
    expect(Object.keys(base).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("carry through to derived tokens", () => {
    const plain = resolveTheme(dark);
    const pink = resolveTheme(dark, { accent: "#ff4fa0" });
    expect(pink.accent).toBe("#ff4fa0");
    expect(pink.focusRing).toBe("#ff4fa0");
    expect(pink.selection).not.toBe(plain.selection);
    expect(pink.viewportOutline).toBe("#ff4fa0");
    expect(pink.panel).toBe(plain.panel);
  });

  it("can't make the accent or muted text unreadable", () => {
    const t = resolveTheme(dark, { accent: "#101618" }); // almost the panel colour
    expect(contrast(t.accent, t.panel)).toBeGreaterThanOrEqual(3);
    // Muted text is never fainter than needed, up to the text colour itself (a pale text override).
    const light = resolveTheme(presetById("myco-light"), { panel: "#ffffff", text: "#6a6a6a" });
    expect(contrast(light.muted, light.panel)).toBeGreaterThanOrEqual(Math.min(4.5, contrast(light.text, light.panel)) - 0.01);
  });
});

describe("applying a theme", () => {
  it("sets every token, the fonts and the colour scheme on the element", () => {
    const props = new Map<string, string>();
    const el = { style: { setProperty: (k: string, v: string) => props.set(k, v), colorScheme: "" }, dataset: {} as Record<string, string> };
    const t = resolveTheme(presetById("myco-light"));
    themePreset.value = "myco-light";
    [uiFontFamily.value, uiFontSize.value, codeFontFamily.value, codeFontSize.value] = ["Verdana, sans-serif", 15, "monospace", 16];
    const stop = installTheme(el as unknown as HTMLElement);
    stop();
    themePreset.value = "myco-dark";
    [uiFontFamily.value, uiFontSize.value, codeFontFamily.value, codeFontSize.value] = [UI_FONTS[0].value, 13, CODE_FONTS[0].value, 13];
    for (const key of Object.keys(t) as (keyof ThemeTokens)[]) expect(props.get(cssVar(key))).toBe(t[key]);
    // The names other panels' CSS uses keep working.
    for (const name of ["--bg", "--panel", "--border", "--text", "--muted", "--accent", "--button", "--button-hover"]) expect(props.has(name)).toBe(true);
    expect(props.get("--font-ui")).toBe("Verdana, sans-serif");
    expect(props.get("--font-size-ui")).toBe("15px");
    expect(Number(props.get("--ui-scale"))).toBeCloseTo(15 / 13);
    expect(props.get("--font-size-code")).toBe("16px");
    expect(el.style.colorScheme).toBe("light");
    expect(el.dataset.theme).toBe("light");
  });

  it("gives Monaco hex colours and the viewport numeric ones", () => {
    const t = resolveTheme(presetById("myco-dark"));
    const colors = monacoColors(t);
    for (const v of Object.values(colors)) expect(v).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    expect(colors["editor.background"]).toBe(t.bgSunken);
    const vp = viewportColors(t);
    expect(vp.outline).toBe(0x2ad4d4);
    expect(vp.handle).toBe(0x2ad4d4);
  });

  it("gives Monaco well-formed hex for short and translucent tokens (ADR 0461)", () => {
    const t = { ...resolveTheme(presetById("myco-dark")), text: "#ffffff80", accent: "#0f0" };
    const colors = monacoColors(t);
    for (const v of Object.values(colors)) expect(v).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    expect(colors["editor.foreground"]).toBe("#ffffff80"); // its own alpha kept
    expect(colors["editor.lineHighlightBackground"]).toBe("#ffffff06"); // 0.5 × 0.05, not "#ffffff800d"
    expect(colors["editorCursor.foreground"]).toBe("#00ff00");
  });

  it("cleans font settings", () => {
    expect(clampSize(100, { min: 10, max: 20 }, 13)).toBe(20);
    expect(clampSize("abc", { min: 10, max: 20 }, 13)).toBe(13);
    expect(clampSize(14.6, { min: 10, max: 20 }, 13)).toBe(15);
    uiFontFamily.value = "  ";
    expect(fonts.value.ui).toBe(UI_FONTS[0].value);
    uiFontFamily.value = "Inter; } body { color: red";
    expect(fonts.value.ui).toBe("Inter  body  color: red");
    uiFontFamily.value = UI_FONTS[0].value;
  });
});

describe("theme settings", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("are remembered per user, with overrides per preset, and reset", async () => {
    const m = await import("./theme");
    expect(m.activePreset.value.id).toBe("myco-dark");
    m.setOverride("accent", "#ff8800");
    expect(m.theme.value.accent).toBe("#ff8800");
    expect(JSON.parse(store.get("myco.editor.themeOverrides")!)).toEqual({ "myco-dark": { accent: "#ff8800" } });

    m.themePreset.value = "myco-light"; // another preset: its own (no) overrides
    expect(m.theme.value.accent).toBe(m.PRESETS.find((p) => p.id === "myco-light")!.base.accent);
    expect(store.get("myco.editor.theme")).toBe('"myco-light"');
    m.themePreset.value = "myco-dark";
    expect(m.theme.value.accent).toBe("#ff8800");

    m.setOverride("accent", "#2AD4D4"); // the preset's own colour: no override
    expect(m.activeOverrides.value).toEqual({});
    m.setOverride("text", "#ffffff");
    m.resetOverrides();
    expect(m.activeOverrides.value).toEqual({});

    m.uiFontSize.value = 16;
    expect(store.get("myco.editor.uiFontSize")).toBe("16");
  });

  it("load what was saved", async () => {
    store.set("myco.editor.theme", '"high-contrast"');
    store.set("myco.editor.themeOverrides", JSON.stringify({ "high-contrast": { accent: "#ffff00" }, "myco-dark": { accent: "nope" } }));
    store.set("myco.editor.codeFontSize", "99");
    const m = await import("./theme");
    expect(m.activePreset.value.kind).toBe("high-contrast");
    expect(m.theme.value.accent).toBe("#ffff00");
    expect(m.fonts.value.codeSize).toBe(28);
    m.themePreset.value = "myco-dark";
    expect(m.activeOverrides.value).toEqual({}); // an invalid override is dropped
  });
});
