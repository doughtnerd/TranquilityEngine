// ADR 0356 §6: the `Locale` runtime, through the public API: an Engine boots it from project.json's `languages` and the
// project's string tables (asset sources), and scripts read, format and switch through `Locale`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Locale, LocalText, MemoryStorage, Storage, UIView } from "../../myco";

const TABLES = {
  "strings/menu.strings.json": {
    format: "myco.strings@1",
    language: "en",
    strings: [
      { key: "menu.start", text: "Start game" },
      { key: "hud.coins", text: "{count, plural, =0 {No coins} one {# coin} other {# coins}}" },
      { key: "only.en", text: "English only" },
      { key: "quest.title", text: "The quest of {name}" },
      { key: "quest.line", text: "{title}: go north" },
      { key: "place", text: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place" },
      { key: "broken.fr", text: "Fine in English" },
    ],
  },
  "strings/menu.fr.strings.json": {
    format: "myco.translation@1",
    language: "fr",
    strings: {
      "menu.start": "Commencer",
      "hud.coins": { text: "{count, plural, =0 {Aucune pièce} one {# pièce} other {# pièces}}", status: "needsReview" },
      "quest.title": "La quête de {name}",
      "quest.line": "{title} : allez au nord",
      "broken.fr": "{oops",
    },
  },
  "strings/menu.ar.strings.json": { format: "myco.translation@1", language: "ar", strings: { "menu.start": "ابدأ اللعبة" } },
};

const LANGUAGES = {
  list: [
    { code: "en", name: "English" },
    { code: "fr", name: "Français" },
    { code: "ar", name: "العربية", fonts: ["fonts/arabic.woff2"] },
    { code: "de", name: "Deutsch", ship: false },
  ],
  reference: "en",
  default: "en",
  useSystemLanguage: false,
};

const engines: Engine[] = [];
async function boot(options: { languages?: object; storage?: MemoryStorage; files?: Record<string, unknown> } = {}): Promise<Engine> {
  const engine = await Engine.create({
    headless: true,
    project: { languages: options.languages ?? LANGUAGES },
    // The caller's object is the source (so a test can change a file), with the tables beside its own files.
    assets: Assets.fromObject(Object.assign(options.files ?? {}, { ...TABLES, "fonts/arabic.woff2": "blob:arabic" }, { ...options.files })),
    storage: options.storage ?? new MemoryStorage(),
  });
  engines.push(engine);
  return engine;
}

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Locale: lookup and fallback", () => {
  it("starts in the default language and resolves keys from the project's tables", async () => {
    await boot();
    expect(Locale.language).toBe("en");
    expect(Locale.languages.map((l) => [l.code, l.name, l.direction])).toEqual([["en", "English", "ltr"], ["fr", "Français", "ltr"], ["ar", "العربية", "rtl"]]); // de isn't shipped
    expect(Locale.t("menu.start")).toBe("Start game");
    expect(Locale.has("menu.start")).toBe(true);
    expect(Locale.has("nope")).toBe(false);
  });

  it("falls back through the chain and reports the keys that fell back", async () => {
    await boot();
    await Locale.setLanguage("fr");
    expect(Locale.t("menu.start")).toBe("Commencer");
    expect(Locale.t("only.en")).toBe("English only"); // fr → en
    expect(Locale.debug().missing).toContainEqual({ key: "only.en", language: "fr" });
    expect(Locale.languages.find((l) => l.code === "fr")?.fallback).toEqual(["en"]);
  });

  it("skips a malformed translation for the next language, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await boot();
    await Locale.setLanguage("fr");
    expect(Locale.t("broken.fr")).toBe("Fine in English");
    expect(Locale.t("broken.fr")).toBe("Fine in English");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("broken.fr"))).toHaveLength(1);
  });

  it("returns the key itself for a key missing in every language, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await boot();
    expect(Locale.t("menu.nowhere")).toBe("menu.nowhere");
    expect(Locale.t("menu.nowhere")).toBe("menu.nowhere");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('"menu.nowhere"'))).toHaveLength(1);
    expect(Locale.debug().missing).toContainEqual({ key: "menu.nowhere", language: "en" });
  });
});

describe("Locale: ICU messages and Intl formatting", () => {
  it("formats plurals, ordinals and arguments in the message's language", async () => {
    await boot();
    expect(Locale.t("hud.coins", { count: 0 })).toBe("No coins");
    expect(Locale.t("hud.coins", { count: 1 })).toBe("1 coin");
    expect(Locale.t("hud.coins", { count: 1234 })).toBe("1,234 coins");
    expect(Locale.t("place", { n: 22 })).toBe("22nd place");
    await Locale.setLanguage("fr");
    expect(Locale.t("hud.coins", { count: 0 })).toBe("Aucune pièce");
    expect(Locale.t("hud.coins", { count: 1 })).toBe("1 pièce"); // a translation that needs review is still used
    expect(Locale.t("hud.coins", { count: 1234 })).toBe(`${new Intl.NumberFormat("fr").format(1234)} pièces`);
    expect(Locale.t("place", { n: 2 })).toBe("2nd place"); // English text formats with English ordinals
  });

  it("formats a LocalText argument as its current string", async () => {
    await boot();
    const title = Locale.text("quest.title", { name: "Ada" });
    expect(Locale.t("quest.line", { title })).toBe("The quest of Ada: go north");
    await Locale.setLanguage("fr");
    expect(Locale.t("quest.line", { title })).toBe("La quête de Ada : allez au nord");
  });

  it("keeps a missing argument as written, warning once per key and name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await boot();
    expect(Locale.t("quest.title")).toBe("The quest of {name}");
    Locale.t("quest.title");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("{name}"))).toHaveLength(1);
  });

  it("formats runtime messages, numbers, dates, lists and relative times with the language's Intl tag", async () => {
    await boot();
    await Locale.setLanguage("fr");
    expect(Locale.format("{n, number, percent} fait", { n: 0.5 })).toBe(`${new Intl.NumberFormat("fr", { style: "percent" }).format(0.5)} fait`);
    expect(Locale.formatNumber(1234.5)).toBe(new Intl.NumberFormat("fr").format(1234.5));
    const date = new Date(Date.UTC(2026, 10, 22, 12));
    expect(Locale.formatDate(date, { dateStyle: "long", timeZone: "UTC" })).toBe(new Intl.DateTimeFormat("fr", { dateStyle: "long", timeZone: "UTC" }).format(date));
    expect(Locale.formatList(["a", "b", "c"])).toBe("a, b et c");
    expect(Locale.formatRelativeTime(-1, "day", { numeric: "auto" })).toBe("hier");
  });
});

describe("Locale: switching", () => {
  it("rejects an unknown or unshipped language with one warning and changes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await boot();
    const epoch = Locale.epoch;
    await expect(Locale.setLanguage("de")).rejects.toThrow(/isn't a shipped language/);
    await expect(Locale.setLanguage("xx")).rejects.toThrow();
    expect(Locale.language).toBe("en");
    expect(Locale.epoch).toBe(epoch);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("changes language, epoch and listeners together, and a later switch supersedes a pending one", async () => {
    await boot();
    const heard: string[] = [];
    const off = Locale.onChange((e) => heard.push(`${e.previous}→${e.language} ${Locale.language} ${Locale.t("menu.start")}`));
    const epoch = Locale.epoch;
    const first = Locale.setLanguage("fr");
    expect(Locale.pendingLanguage).toBe("fr");
    expect(Locale.language).toBe("en"); // nothing changes before the language is ready
    const second = Locale.setLanguage("ar");
    await Promise.all([first, second]);
    expect(heard).toEqual(["en→ar ar ابدأ اللعبة"]); // the superseded switch never happened
    expect(Locale.epoch).toBeGreaterThan(epoch);
    expect(Locale.pendingLanguage).toBeNull();
    expect(Locale.direction).toBe("rtl");
    off();
    await Locale.setLanguage("en");
    expect(heard).toHaveLength(1);
  });

  it("loads the language's fonts before the switch completes", async () => {
    // A browser's font loading, stubbed: each face loads when the test says so.
    const loads: { family: string; resolve: () => void }[] = [];
    class FakeFontFace {
      constructor(readonly family: string) {}
      load(): Promise<void> {
        return new Promise((resolve) => loads.push({ family: this.family, resolve: () => resolve() }));
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    vi.stubGlobal("document", { fonts: { add: () => {}, delete: () => {} } });
    expect(UIView).toBeDefined(); // the UI (with its fonts) is part of the game
    // A font file no earlier test loaded (faces load once per process).
    await boot({ languages: { ...LANGUAGES, list: LANGUAGES.list.map((l) => (l.code === "ar" ? { ...l, fonts: ["fonts/naskh.woff2"] } : l)) }, files: { "fonts/naskh.woff2": "blob:naskh" } });
    const order: string[] = [];
    Locale.onChange((e) => order.push(`changed to ${e.language}`));
    const switched = Locale.setLanguage("ar").then(() => order.push("resolved"));
    await new Promise((r) => setTimeout(r, 0));
    expect(loads.map((l) => l.family)).toEqual(["myco-font-fonts-naskh-woff2"]);
    expect(order).toEqual([]); // waiting for the font
    expect(Locale.language).toBe("en");
    order.push("font loaded");
    loads[0].resolve();
    await switched;
    expect(order).toEqual(["font loaded", "changed to ar", "resolved"]);
  });
});

describe("Locale: table edits", () => {
  it("follows a string table the editor saved, raising the epoch", async () => {
    const files: Record<string, unknown> = { "strings/live.strings.json": { format: "myco.strings@1", language: "en", strings: [{ key: "live.k", text: "Before" }] } };
    await boot({ files });
    expect(Locale.t("live.k")).toBe("Before");
    const epoch = Locale.epoch;
    files["strings/live.strings.json"] = { format: "myco.strings@1", language: "en", strings: [{ key: "live.k", text: "After" }] };
    Assets.notifyChanged("strings/live.strings.json"); // what the editor does after a save
    expect(Locale.epoch).toBeGreaterThan(epoch);
    expect(Locale.t("live.k")).toBe("After");
  });
});

describe("Locale: LocalText", () => {
  it("re-resolves when the language changes", async () => {
    await boot();
    const start = Locale.text("menu.start");
    expect(start).toBeInstanceOf(LocalText);
    expect(String(start)).toBe("Start game");
    await Locale.setLanguage("fr");
    expect(`${start}`).toBe("Commencer");
    const coins = Locale.text("hud.coins").with({ count: 2 });
    expect(coins.key).toBe("hud.coins");
    expect(coins.args).toEqual({ count: 2 });
    expect(coins.toString()).toBe("2 pièces");
  });
});

describe("Locale: the player's language", () => {
  it("remembers the player's choice and starts in it next time", async () => {
    const storage = new MemoryStorage();
    await boot({ storage });
    await Locale.setLanguage("fr");
    expect(await storage.load("settings", "myco.locale.language")).toBe("fr");
    engines.pop()!.dispose();
    await boot({ storage });
    expect(Locale.language).toBe("fr");
    expect(Locale.t("menu.start")).toBe("Commencer");
  });

  it("ignores a remembered language the project no longer ships, or doesn't remember", async () => {
    const storage = new MemoryStorage();
    await storage.save("settings", "myco.locale.language", "de");
    await boot({ storage });
    expect(Locale.language).toBe("en");
    await storage.save("settings", "myco.locale.language", "fr");
    engines.pop()!.dispose();
    await boot({ storage, languages: { ...LANGUAGES, remember: false } });
    expect(Locale.language).toBe("en");
    await Locale.setLanguage("ar");
    expect(await Storage.load("myco.locale.language", "settings")).toBe("fr"); // not written either
  });
});

describe("Locale: pseudo-languages", () => {
  it("shows keyed text accented and expanded, leaving arguments alone, in the editor's project strings", async () => {
    await boot();
    expect(Locale.languages.map((l) => l.code)).not.toContain("qps-ploc"); // never a shipped language
    await Locale.setLanguage("qps-ploc");
    expect(Locale.direction).toBe("ltr");
    expect(Locale.t("menu.start")).toBe("[!! Šţàŕţ ĝàɱé ~~ !!]");
    const title = Locale.t("quest.title", { name: "Ada" });
    expect(title).toMatch(/^\[!! Ţĥé ǫûéšţ öƒ Ada ~+ !!\]$/); // the argument isn't accented
    expect(Locale.t("hud.coins", { count: 3 })).toMatch(/^\[!! 3 çöîñš ~* ?!!\]$/); // plural keywords and # kept
    await Locale.setLanguage("qps-plocm");
    expect(Locale.direction).toBe("rtl");
    expect(Locale.t("menu.start")).toBe("‮[!! Šţàŕţ ĝàɱé ~~ !!]‬");
  });
});
