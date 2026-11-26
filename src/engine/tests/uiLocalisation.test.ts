// ADR 0356 §4–§5: localised UI. UI documents bind keys with `t:` attributes (arguments and per-row keys from the row's
// item, then `ui.data`), leave `translate="no"` text alone and match `:lang()` rules; all of it follows `Locale.epoch`.
// (`LocalizedText` is gone, ADR 0417: scripts use `Locale.t`.) Text runs align `start` by the language's direction.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Locale, MemoryStorage, UICanvas, UIDocument, UIInputField, UIPanel, UIText, type ProjectSettingsInput } from "../../myco";
import { World } from "../core/World";
import { UIPointer } from "./uiPointer";

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
  "ui/menu.ui.xml": `<Canvas>
  <Style src="menu.ui.css"/>
  <Panel id="menu">
    <Text id="start" class="title" t:text="menu.start"/>
    <Text id="coins" t:text="hud.coins"/>
    <Text id="old" t:text="menu.start">Start</Text>
    <Text id="draft" t:text="menu.not_yet">Coming soon</Text>
    <Text id="brand" translate="no">MYCO</Text>
    <Text id="plain">Hard-coded</Text>
    <Button id="quit" t:text="menu.quit"/>
    <InputField id="name" t:placeholder="profile.name_hint"/>
    <Panel id="weapons"><Template><Text class="weapon" t:text="weapon.{id}.name"/></Template></Panel>
    <Panel id="ammo"><Template><Text t:text="weapon.ammo"/></Template></Panel>
  </Panel>
</Canvas>`,
  "ui/menu.ui.css": `.title { font-size: 24px; }
.title:lang(fr) { font-size: 20px; }
Text:lang(de) { color: #ff0000; }
#menu:lang(ar) { flex-direction: row-reverse; }`,
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

async function open(): Promise<UIDocument> {
  await boot();
  const doc = GameObject.create("UI").addBehavior(UIDocument, { document: "asset:ui/menu.ui.xml" });
  await doc.ready;
  return doc;
}

const textOf = (doc: UIDocument, selector: string) => doc.query(selector)!.as(UIText).text;

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  engine?.dispose();
  engine = null;
  vi.restoreAllMocks();
});

describe("UI documents: t: attributes", () => {
  it("shows the key's message and follows a language switch live", async () => {
    const doc = await open();
    expect(doc.problems).toEqual([]);
    expect(textOf(doc, "#start")).toBe("Start game");
    await Locale.setLanguage("fr");
    engine!.step(DT);
    expect(textOf(doc, "#start")).toBe("Commencer");
    await Locale.setLanguage("en");
    engine!.step(DT);
    expect(textOf(doc, "#start")).toBe("Start game");
  });

  it("reads arguments from ui.data, as {name} bindings do", async () => {
    const doc = await open();
    doc.data.count = 12;
    engine!.step(DT);
    expect(textOf(doc, "#coins")).toBe("12 coins");
    doc.data.count = 1;
    engine!.step(DT);
    expect(textOf(doc, "#coins")).toBe("1 coin");
    await Locale.setLanguage("fr");
    engine!.step(DT);
    expect(textOf(doc, "#coins")).toBe("1 pièce");
  });

  it("builds keys per row and reads arguments from the row's item first", async () => {
    const doc = await open();
    doc.list("#weapons", [{ id: "sword" }, { id: "bow" }]);
    expect(doc.queryAll(".weapon").map((e) => e.as(UIText).text)).toEqual(["Sword", "Bow"]);
    doc.data.name = "not this one";
    const rows = doc.list("#ammo", [{ name: "Sword", ammo: 1 }, { name: "Bow", ammo: 12 }]);
    expect(rows.map((r) => r.as(UIText).text)).toEqual(["Sword: 1 shot", "Bow: 12 shots"]);
    await Locale.setLanguage("fr");
    engine!.step(DT);
    expect(doc.queryAll(".weapon").map((e) => e.as(UIText).text)).toEqual(["Épée", "Arc"]);
    expect(rows.map((r) => r.as(UIText).text)).toEqual(["Sword : 1 tir", "Bow : 12 tirs"]);
  });

  it("shows an element's text content only while its key resolves nowhere", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await open();
    expect(textOf(doc, "#old")).toBe("Start game");
    expect(textOf(doc, "#draft")).toBe("Coming soon");
  });

  it("localises a button's label and an input field's placeholder", async () => {
    const doc = await open();
    expect(doc.query("#quit")!.query("Text")!.as(UIText).text).toBe("Quit");
    expect(doc.query("#name")!.as(UIInputField).placeholder).toBe("Your name");
    await Locale.setLanguage("fr");
    engine!.step(DT);
    expect(doc.query("#quit")!.query("Text")!.as(UIText).text).toBe("Quitter");
    expect(doc.query("#name")!.as(UIInputField).placeholder).toBe("Votre nom");
  });

  it('leaves translate="no" and literal text plain, even in the pseudo-language', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await open();
    expect(textOf(doc, "#brand")).toBe("MYCO");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("translate"))).toBe(false); // not taken for a field
    await Locale.setLanguage("qps-ploc");
    engine!.step(DT);
    expect(textOf(doc, "#start")).toBe("[!! Šţàŕţ ĝàɱé ~~ !!]");
    expect(textOf(doc, "#brand")).toBe("MYCO");
    expect(textOf(doc, "#plain")).toBe("Hard-coded");
  });
});

describe("UI stylesheets: :lang()", () => {
  it("matches the current language by BCP 47 prefix, restyling on a switch", async () => {
    const doc = await open();
    const title = doc.query("#start")!.as(UIText);
    expect(title.fontSize).toBe(24);
    await Locale.setLanguage("fr");
    engine!.step(DT);
    expect(title.fontSize).toBe(20);
    expect([title.color.r, title.color.g, title.color.b]).toEqual([1, 1, 1]);
    await Locale.setLanguage("de-AT");
    engine!.step(DT);
    expect(title.fontSize).toBe(24); // back from the :lang(fr) rule
    expect([title.color.r, title.color.g, title.color.b]).toEqual([1, 0, 0]); // :lang(de) matches de-AT
    expect(textOf(doc, "#start")).toBe("Spiel starten");
    const menu = doc.query("#menu")!.as(UIPanel);
    expect(menu.flexDirection).toBe("row");
    await Locale.setLanguage("ar");
    engine!.step(DT);
    expect(menu.flexDirection).toBe("row-reverse"); // mirroring by a :lang() rule (ADR 0356 §5)
  });

  it("parses :lang() into the selector, counted like a class, and reports a malformed one", async () => {
    await boot();
    FILES["ui/bad.ui.xml"] = `<Canvas><Style src="bad.ui.css"/><Text id="t">x</Text></Canvas>`;
    FILES["ui/bad.ui.css"] = `Text:lang() { font-size: 9px; }`;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = GameObject.create("Bad").addBehavior(UIDocument, { document: "asset:ui/bad.ui.xml" });
    await doc.ready;
    expect(doc.problems.map((p) => p.message).join("\n")).toMatch(/:lang\(\) takes one language code/);
    expect(textOf(doc, "#t")).toBe("x");
  });
});

describe("text direction", () => {
  it("aligns start to the left in English and to the right in Arabic, through the core's text runs", async () => {
    await boot();
    const canvas = GameObject.create("Canvas").addBehavior(UICanvas);
    const start = GameObject.create("Start", { parent: canvas.node }).addBehavior(UIText, { text: "Hi" });
    const end = GameObject.create("End", { parent: canvas.node }).addBehavior(UIText, { text: "Hi", textAlign: "end" });
    const left = GameObject.create("Left", { parent: canvas.node }).addBehavior(UIText, { text: "Hi", textAlign: "left" });
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
