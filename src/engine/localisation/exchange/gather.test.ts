// ADR 0356 §7: key gathering over a project — where each key is used (`t()`/`tHtml()` in Svelte UI, ADR 0423;
// `Locale.t`/`Locale.text` in scripts, line tables' subtitle keys, playlist captions), and the report lists built from
// it: missing translations, keys used but defined nowhere, keys never used. Scenes aren't read (ADR 0421: game UI is
// built only by UI views), nor retired UI documents (ADR 0423). Driven through `gatherKeys` over a fixture project of files.
import { describe, expect, it } from "vitest";
import { parseLanguages } from "../languages";
import { textHash } from "../textHash";
import { gatherKeys } from "./gather";

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
  ["ui/Menu.svelte", `<script lang="ts">
  import { t, tHtml } from "myco";
  import { greet } from "./greet.svelte";
  let { count }: { count: number } = $props();
</script>

<h1 id="title">{t("menu.start")}</h1>
<button id="go">{t('menu.missing')}</button>
<p>{@html tHtml("hud.coins", { count })}</p>
<p>{greet.t("not.a.key")} {format("not.either")}</p>
`],
  ["ui/greet.svelte.ts", `import { Locale, t } from "myco";\nexport const greet = { line: () => t("weapon.sword.name"), axe: () => Locale.text("weapon.axe.name") };\n`],
  // A retired UI document (ADR 0423): not read.
  ["ui/menu.ui.xml", `<Canvas><Text t:text="menu.quit"/></Canvas>`],
  // An old scene still saving UI and LocalizedText: not read (ADR 0421).
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
    expect(by("component")).toEqual(["hud.coins", "menu.missing", "menu.start", "weapon.axe.name", "weapon.sword.name"]);
    expect(report.uses.some((u) => u.path.startsWith("scenes/") || u.path.endsWith(".ui.xml"))).toBe(false);
    expect(by("script")).toEqual(["menu.quit", "script.only"]);
    expect(by("line")).toEqual(["ch1.late", "intro_01", "intro_04"]);
    expect(by("caption")).toEqual(["cc.door_slams"]);
    expect(report.uses.find((u) => u.key === "menu.start")).toMatchObject({ path: "ui/Menu.svelte", where: "line 7" });
  });

  it("lists keys used but defined nowhere", () => {
    expect(report.undefinedKeys.map((u) => u.key).sort()).toEqual(["cc.door_slams", "intro_04", "menu.missing", "script.only"]);
    expect(report.undefinedKeys.find((u) => u.key === "menu.missing")?.uses[0]).toMatchObject({ kind: "component", path: "ui/Menu.svelte", where: "line 8" });
  });

  it("lists keys never used", () => {
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

  it("reports a key defined in two tables", () => {
    const twice = gatherKeys({ files: [...FILES, ["strings/other.strings.json", { format: "myco.strings@1", language: "en", strings: [{ key: "menu.quit", text: "Exit" }] }]], languages });
    expect(twice.duplicates).toEqual([{ key: "menu.quit", tables: ["strings/menu.strings.json", "strings/other.strings.json"] }]);
  });
});
