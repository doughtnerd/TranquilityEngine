// ADR 0356 §5: localised UI. Stylesheets match the current language with `:lang()`, restyled as `Locale.epoch` moves.
// Text runs align `start` by the language's direction. (`LocalizedText` is gone, ADR 0417; UI documents' `t:` attributes
// with them, ADR 0419: components use `t()` from "myco", tested with the Svelte renderer, and scripts `Locale.t`.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Locale, MemoryStorage, UIPanel, UIText, type ProjectSettingsInput } from "../../myco";
import { World } from "../core/World";
import { UIPointer } from "./uiPointer";
import { buildUI, byId, loadUITestSupport, uiAs, type TestUI } from "./uiMarkup";

const DT = 1 / 60;

const FILES: Record<string, unknown> = {
  "strings/ui.strings.json": {
    format: "myco.strings@1",
    language: "en",
    strings: [
      { key: "menu.start", text: "Start game" },
      { key: "menu.quit", text: "Quit" },
      { key: "hud.coins", text: "{count, plural, one {# coin} other {# coins}}" },
      { key: "profile.name_hint", text: "Your name" },
      { key: "weapon.sword.name", text: "Sword" },
      { key: "weapon.bow.name", text: "Bow" },
      { key: "weapon.ammo", text: "{name}: {ammo, plural, one {# shot} other {# shots}}" },
    ],
  },
  "strings/ui.fr.strings.json": {
    format: "myco.translation@1",
    language: "fr",
    strings: {
      "menu.start": "Commencer",
      "menu.quit": "Quitter",
      "hud.coins": "{count, plural, one {# pièce} other {# pièces}}",
      "profile.name_hint": "Votre nom",
      "weapon.sword.name": "Épée",
      "weapon.bow.name": "Arc",
      "weapon.ammo": "{name} : {ammo, plural, one {# tir} other {# tirs}}",
    },
  },
  "strings/ui.de-AT.strings.json": { format: "myco.translation@1", language: "de-AT", strings: { "menu.start": "Spiel starten" } },
};

const LANGUAGES = {
  list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }, { code: "de-AT", name: "Deutsch (Österreich)" }, { code: "ar", name: "العربية" }],
  reference: "en",
  default: "en",
  useSystemLanguage: false,
};

let engine: Engine | null = null;
const pointers: UIPointer[] = [];

async function boot(): Promise<Engine> {
  engine = await Engine.create({ headless: true, project: { languages: LANGUAGES } as ProjectSettingsInput, assets: Assets.fromObject(FILES), storage: new MemoryStorage() });
  return engine;
}

/** A menu whose stylesheet has `:lang()` rules, its text a script's `Locale.t` writes. */
async function open(): Promise<TestUI> {
  await boot();
  await loadUITestSupport();
  return buildUI(`<Canvas><div id="menu"><p id="start" class="title">${Locale.t("menu.start")}</p></div></Canvas>`, {
    css: `.title { font-size: 24px; }
.title:lang(fr) { font-size: 20px; }
p:lang(de) { color: #ff0000; }
#menu:lang(ar) { flex-direction: row-reverse; }`,
  });
}

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  engine?.dispose();
  engine = null;
  vi.restoreAllMocks();
});

describe("UI stylesheets: :lang()", () => {
  it("matches the current language by BCP 47 prefix, restyling on a switch", async () => {
    const doc = await open();
    const title = uiAs(doc.query("#start")!, UIText);
    expect(title.fontSize).toBe(24);
    await Locale.setLanguage("fr");
    engine!.step(DT);
    expect(title.fontSize).toBe(20);
    expect([title.color.r, title.color.g, title.color.b]).toEqual([1, 1, 1]);
    await Locale.setLanguage("de-AT");
    engine!.step(DT);
    expect(title.fontSize).toBe(24); // back from the :lang(fr) rule
    expect([title.color.r, title.color.g, title.color.b]).toEqual([1, 0, 0]); // :lang(de) matches de-AT
    expect(Locale.t("menu.start")).toBe("Spiel starten");
    const menu = uiAs(doc.query("#menu")!, UIPanel);
    expect(menu.flexDirection).toBe("row");
    await Locale.setLanguage("ar");
    engine!.step(DT);
    expect(menu.flexDirection).toBe("row-reverse"); // mirroring by a :lang() rule (ADR 0356 §5)
  });

  it("reports a malformed :lang() when the styles are parsed", async () => {
    await boot();
    await loadUITestSupport();
    expect(() => buildUI(`<Canvas><p id="t">x</p></Canvas>`, { css: `p:lang() { font-size: 9px; }` })).toThrow(/:lang\(\) takes one language code/);
  });
});

describe("text direction", () => {
  it("aligns start to the left in English and to the right in Arabic, through the core's text runs", async () => {
    await boot();
    await loadUITestSupport();
    const doc = buildUI(`<Canvas><p id="start">Hi</p><p id="end" text-align="end">Hi</p><p id="left" text-align="left">Hi</p></Canvas>`);
    const [start, end, left] = ["start", "end", "left"].map((id) => byId(doc, id, UIText));
    expect(start.textAlign).toBe("start"); // the default
    const p = await UIPointer.create(World.require());
    pointers.push(p);
    const run = (c: UIText) => p.core.elements().find((e) => e.comp === c)!.text!;
    expect([run(start).align, run(end).align, run(left).align, run(start).direction]).toEqual(["left", "right", "left", "ltr"]);
    await Locale.setLanguage("ar");
    p.sync();
    expect([run(start).align, run(end).align, run(left).align, run(start).direction]).toEqual(["right", "left", "left", "rtl"]);
  });
});
