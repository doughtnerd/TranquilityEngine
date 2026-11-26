// ADR 0356 §7: key gathering over a project — where each key is used (UI documents' `t:` attributes,
// `Locale.t`/`Locale.text` in scripts, line tables' subtitle keys, playlist captions), and the report lists built from
// it: missing translations, keys used but defined nowhere, keys never used, unkeyed literal text in UI documents.
// Scenes aren't read (ADR 0417: game UI is built only from documents). Driven through `gatherKeys` over a fixture project of files.
import { describe, expect, it } from "vitest";
import { parseLanguages } from "../languages";
import { textHash } from "../textHash";
import { gatherKeys, unkeyedId } from "./gather";

const languages = parseLanguages({ list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }, { code: "de", name: "Deutsch", ship: false }], reference: "en" }).languages;

const FILES: [string, unknown][] = [
  ["project.json", { name: "Fixture" }],
  ["strings/menu.strings.json", {
    format: "myco.strings@1", language: "en",
    strings: [
      { key: "menu.start", text: "Start game" },
      { key: "menu.quit", text: "Quit" },
      { key: "hud.coins", text: "{count, plural, one {# coin} other {# coins}}" },
      { key: "weapon.sword.name", text: "Sword" },
      { key: "weapon.axe.name", text: "Axe" },
      { key: "old.unused", text: "Nobody uses me" },
      { key: "credits.title", text: "Credits" },
    ],
  }],
  ["strings/menu.fr.strings.json", {
    format: "myco.translation@1", language: "fr",
    strings: { "menu.start": { text: "Commencer", source: textHash("Start game") }, "menu.quit": { text: "Quitter", source: textHash("Quit (old)") } },
  }],
  ["audio/vo/ch1.strings.json", { format: "myco.strings@1", language: "en", strings: [{ key: "intro_01", text: "Hello." }, { key: "ch1.late", text: "You're late." }] }],
  ["audio/vo/ch1.lines.json", { format: "myco.lines@1", lines: [{ key: "intro_01", speaker: "Ava" }, { key: "intro_02", speaker: "Ava", textKey: "ch1.late" }, { key: "breath_03", textKey: null }, { key: "intro_04" }] }],
  ["audio/sfx/door.playlist.json", { format: "myco.playlist@1", caption: { key: "cc.door_slams", minGap: 2 } }],
  ["ui/menu.ui.xml", `<Canvas>
  <Text id="title" t:text="menu.start"/>
  <Button id="go" t:text="menu.missing"/>
  <Text id="hint">Press any key</Text>
  <Text translate="no">MYCO</Text>
  <Panel translate="no"><Text>Logo text</Text></Panel>
  <Text>{score}</Text>
  <InputField id="name" placeholder="Your name"/>
  <Text t:text="hud.coins">12 coins</Text>
  <Panel id="weapons"><Template><Text t:text="weapon.{id}.name"/></Template></Panel>
</Canvas>`],
  // An old scene still saving UI and LocalizedText: not read (ADR 0417).
  ["scenes/main.scene.json", {
    format: "myco.scene@4",
    nodes: [
      { id: "hud", name: "Hud", components: [{ type: "engine.UIText", data: { text: "Coins" } }, { type: "engine.LocalizedText", data: { key: "hud.coins" } }] },
      { id: "score", name: "Score", components: [{ type: "engine.UIText", data: { text: "Score" } }] },
      { id: "credits", prefab: "prefabs/credits.prefab.json", overrides: [{ component: "engine.LocalizedText", field: "key", value: "credits.title" }] },
    ],
  }],
  ["scripts/menu.ts", `import { Locale } from "myco";\nconst a = Locale.t("menu.quit");\nconst b = Locale.text('script.only', { n: 1 });\nconst c = Locale.t(dynamicKey);\n`],
];

describe("key gathering", () => {
  const report = gatherKeys({ files: FILES, languages });

  it("finds each kind of key use", () => {
    const by = (kind: string) => report.uses.filter((u) => u.kind === kind).map((u) => u.key).sort();
    expect(by("document")).toEqual(["hud.coins", "menu.missing", "menu.start", "weapon.{id}.name"]);
    expect(report.uses.some((u) => u.path.startsWith("scenes/"))).toBe(false);
    expect(by("script")).toEqual(["menu.quit", "script.only"]);
    expect(by("line")).toEqual(["ch1.late", "intro_01", "intro_04"]);
    expect(by("caption")).toEqual(["cc.door_slams"]);
    expect(report.uses.find((u) => u.key === "weapon.{id}.name")?.template).toBe(true);
    expect(report.uses.find((u) => u.key === "menu.start")).toMatchObject({ path: "ui/menu.ui.xml", where: "#title" });
  });

  it("lists keys used but defined nowhere", () => {
    expect(report.undefinedKeys.map((u) => u.key).sort()).toEqual(["cc.door_slams", "intro_04", "menu.missing", "script.only"]);
    expect(report.undefinedKeys.find((u) => u.key === "menu.missing")?.uses[0]).toMatchObject({ kind: "document", path: "ui/menu.ui.xml" });
  });

  it("lists keys never used (a key template covers the keys it matches)", () => {
    expect(report.unused.map((d) => d.key)).toEqual(["old.unused", "credits.title"]); // credits.title only in the unread scene
    expect(report.unused[0].table).toBe("strings/menu.strings.json");
  });

  it("lists missing translations per key in the shipped languages, and those needing review", () => {
    const missing = Object.fromEntries(report.missing.map((m) => [m.key, m.languages]));
    expect(missing["menu.start"]).toBeUndefined();
    expect(missing["hud.coins"]).toEqual(["fr"]); // de isn't shipped
    expect(missing["intro_01"]).toEqual(["fr"]);
    expect(report.missing.find((m) => m.key === "hud.coins")?.used).toBe(true);
    expect(report.missing.find((m) => m.key === "old.unused")?.used).toBe(false);
    expect(report.needsReview).toEqual([{ key: "menu.quit", table: "strings/menu.strings.json", languages: ["fr"] }]);
    expect(report.counts.fr).toEqual({ translated: 1, needsReview: 1, missing: 7 });
  });

  it("lists unkeyed literal text in UI documents, minus translate=\"no\", bindings and keyed fields", () => {
    expect(report.unkeyed.map((u) => [u.path, u.field, u.text])).toEqual([
      ["ui/menu.ui.xml", "text", "Press any key"],
      ["ui/menu.ui.xml", "placeholder", "Your name"],
    ]);
    expect(report.unkeyed[0]).toMatchObject({ where: "#hint", id: "hint" });
  });

  it("leaves out dismissed unkeyed text", () => {
    const again = gatherKeys({ files: FILES, languages, ignore: [unkeyedId(report.unkeyed[0])] });
    expect(again.unkeyed.map((u) => u.text)).toEqual(["Your name"]);
  });

  it("reports a key defined in two tables", () => {
    const twice = gatherKeys({ files: [...FILES, ["strings/other.strings.json", { format: "myco.strings@1", language: "en", strings: [{ key: "menu.quit", text: "Exit" }] }]], languages });
    expect(twice.duplicates).toEqual([{ key: "menu.quit", tables: ["strings/menu.strings.json", "strings/other.strings.json"] }]);
  });
});
