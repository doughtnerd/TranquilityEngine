// ADR 0354 §1, 0356 §9: the Play toolbar's Language menu — the shipped languages and the two pseudo-languages — and the
// per-user preview language driving `Locale.setLanguage` in editor Play: the game starts in it, and choosing another
// while playing switches the running game. Driven through `startPlay` and the public `Locale`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { Locale } from "../engine/localisation/Locale";
import { parseLanguages } from "../engine/localisation/languages";
import { choosePlayLanguage, playLanguageChoices, playLanguageOf, previewLanguage } from "./playLanguage";
import { startPlay, type PlaySession } from "./playMode";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { currentProject, openScene } from "./state";
import { closeTestProject, openTestProject } from "./testing";

const LANGUAGES = { list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }, { code: "de", name: "Deutsch", ship: false }], reference: "en", default: "en" };

describe("the Play toolbar's Language menu", () => {
  const s = parseLanguages(LANGUAGES).languages;

  it("lists the shipped languages, then the pseudo-languages", () => {
    expect(playLanguageChoices(s).map((c) => [c.code, c.label, c.pseudo])).toEqual([
      ["en", "English (en)", false],
      ["fr", "Français (fr)", false],
      ["qps-ploc", "Pseudo (accented, longer)", true],
      ["qps-plocm", "Pseudo, right to left", true],
    ]);
  });

  it("falls back to the start language for a stored code that isn't shipped", () => {
    expect(playLanguageOf(null, s)).toBe("en");
    expect(playLanguageOf("FR", s)).toBe("fr");
    expect(playLanguageOf("de", s)).toBe("en");
    expect(playLanguageOf("QPS-PLOC", s)).toBe("qps-ploc");
  });
});

describe("editor Play in the preview language", () => {
  let editor: Engine;
  let play: PlaySession | null = null;

  beforeEach(async () => {
    const { project } = await openTestProject({
      "project.json": JSON.stringify({ name: "Lang", languages: LANGUAGES }),
      "scenes/main.scene.json": JSON.stringify({ format: "myco.scene@4", nodes: [] }),
      "strings/menu.strings.json": JSON.stringify({ format: "myco.strings@1", language: "en", strings: [{ key: "menu.start", text: "Start game" }] }),
      "strings/menu.fr.strings.json": JSON.stringify({ format: "myco.translation@1", language: "fr", strings: { "menu.start": { text: "Commencer" } } }),
    });
    useProjectAssets(project);
    editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    openSceneFile(editor, "scenes/main.scene.json");
  });

  afterEach(() => {
    play?.stop();
    play = null;
    previewLanguage.value = null;
    closeTestProject();
  });

  const start = async () => (play = await startPlay({ editor, scene: openScene.value!, project: currentProject.value! }));

  it("starts the game in the preview language", async () => {
    previewLanguage.value = "fr";
    await start();
    expect(Locale.language).toBe("fr");
    expect(Locale.t("menu.start")).toBe("Commencer");
  });

  it("starts in the project's start language without a preference", async () => {
    await start();
    expect(Locale.language).toBe("en");
    expect(Locale.t("menu.start")).toBe("Start game");
  });

  it("switches the running game when the menu picks another language, pseudo-languages included", async () => {
    await start();
    const s = parseLanguages(LANGUAGES).languages;
    await choosePlayLanguage("fr", s, true);
    expect(previewLanguage.value).toBe("fr");
    expect(Locale.t("menu.start")).toBe("Commencer");
    await choosePlayLanguage("qps-ploc", s, true);
    expect(Locale.language).toBe("qps-ploc");
    expect(Locale.t("menu.start")).toMatch(/^\[!! Šţàŕţ ĝàɱé/);
  });

  it("only remembers the choice while editing", async () => {
    const s = parseLanguages(LANGUAGES).languages;
    await choosePlayLanguage("fr", s, false);
    expect(previewLanguage.value).toBe("fr");
    await start();
    expect(Locale.language).toBe("fr");
  });
});
