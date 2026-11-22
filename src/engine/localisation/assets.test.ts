// ADR 0342 §10 (T5): localised textures and fonts under `languages.assetRoots`, through the public `Assets` and `Locale`
// on an Engine: a reference names the reference language's file and serves the current language's variant through its
// fallback chain; a switch preloads the new variants of what was loaded before it commits, then announces each
// reference whose file changed (`Assets.onChanged`), so a runtime caching it reloads it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Locale, MemoryStorage } from "../../myco";

const LANGUAGES = {
  list: [{ code: "en" }, { code: "fr" }, { code: "fr-CA", fallback: ["fr"] }, { code: "de" }],
  reference: "en",
  default: "en",
  useSystemLanguage: false,
  assetRoots: ["images/loc", "fonts/loc"],
};

const FILES = {
  "images/loc/en/logo.png": "blob:logo-en",
  "images/loc/fr/logo.png": "blob:logo-fr",
  "images/loc/en/sign.png": "blob:sign-en",
  "fonts/loc/en/title.woff2": "blob:title-en",
  "fonts/loc/fr/title.woff2": "blob:title-fr",
  "images/plain.png": "blob:plain",
};

const engines: Engine[] = [];
async function boot(): Promise<Engine> {
  const engine = await Engine.create({ headless: true, project: { languages: LANGUAGES }, assets: Assets.fromObject({ ...FILES }), storage: new MemoryStorage() });
  engines.push(engine);
  return engine;
}

afterEach(async () => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("localised assets (ADR 0342 §10)", () => {
  it("resolves a texture and a font per language through the fallback chain", async () => {
    await boot();
    expect(Assets.url("images/loc/en/logo.png")).toBe("blob:logo-en");
    expect(Assets.url("fonts/loc/en/title.woff2")).toBe("blob:title-en");
    await Locale.setLanguage("fr");
    expect(Assets.url("images/loc/en/logo.png")).toBe("blob:logo-fr");
    expect(Assets.url("fonts/loc/en/title.woff2")).toBe("blob:title-fr");
    // Missing in French: the English file. A reference into another language's folder swaps the same way.
    expect(Assets.url("images/loc/en/sign.png")).toBe("blob:sign-en");
    expect(Assets.url("images/loc/fr/logo.png")).toBe("blob:logo-fr");
    // fr-CA falls back to fr; de (no files) to English.
    await Locale.setLanguage("fr-CA");
    expect(Assets.url("images/loc/en/logo.png")).toBe("blob:logo-fr");
    await Locale.setLanguage("de");
    expect(Assets.url("images/loc/en/logo.png")).toBe("blob:logo-en");
    // Outside the asset roots nothing changes.
    expect(Assets.url("images/plain.png")).toBe("blob:plain");
  });

  it("preloads the new language's variants of loaded references before the switch commits, then announces the changed ones", async () => {
    await boot();
    Assets.url("images/loc/en/logo.png");
    Assets.url("images/loc/en/sign.png");
    const fetched: string[] = [];
    const languageAtFetch: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      languageAtFetch.push(Locale.language);
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
    });
    const changed: string[] = [];
    const off = Assets.onChanged((p) => changed.push(p));
    await Locale.setLanguage("fr");
    off();
    // Each new file once; sign.png has no French file: nothing to preload or announce.
    expect(fetched).toContain("blob:logo-fr");
    expect(fetched).not.toContain("blob:sign-en");
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(new Set(languageAtFetch)).toEqual(new Set(["en"])); // before the switch committed
    expect(changed).toContain("images/loc/en/logo.png");
    expect(changed).not.toContain("images/loc/en/sign.png");
  });
});
