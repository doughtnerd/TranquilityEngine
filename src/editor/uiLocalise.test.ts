// ADR 0356 §9: the Inspector's Localise and Extract to string table on a UI document element — bind a text field to a
// key (`t:text`, literal text removed), unlink it, and extract the literal text into a string table under a new key,
// the markup and the table written as one undo step in the scene's history. Driven through `uiDocumentEdits.ts` and the
// Localise model, as the Inspector calls them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { formatStringTable, parseStringTable } from "../engine/localisation/strings/format";
import { parseLanguages } from "../engine/localisation/languages";
import { MemoryFileSystem } from "./memoryFs";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, playState, sceneCamera, status } from "./state";
import { select } from "./inspectorTarget";
import { editorTextFiles } from "./textFiles";
import { extractUIElementText, localiseUIElement, uiElementKey, uiElementLiteral } from "./uiDocumentEdits";
import { resolveUIElement, type UIElementRef } from "./uiDocuments";
import { exchangeProjectOf } from "./ui/localisation/localisationData";
import { extractToTable, suggestKey, suggestTable } from "./ui/localisation/localiseModel";

const ROOT = "C:\\Games\\loc";
const MENU = `<Canvas>
  <Text id="title">Main menu</Text>
  <InputField id="name" placeholder="Your name"/>
</Canvas>
`;
const TABLE = { format: "myco.strings@1", language: "en", strings: [{ key: "menu.start", text: "Start" }] };
const FILES: Record<string, string> = {
  "project.json": JSON.stringify({ name: "Loc", languages: { list: ["en", "fr"], reference: "en" } }),
  "scenes/main.scene.json": JSON.stringify({ format: "myco.scene@1", nodes: [{ id: "hud", name: "HUD", components: [{ type: "engine.Transform" }, { type: "engine.UIDocument", data: { document: "asset:ui/menu.ui.xml" } }] }] }),
  "ui/menu.ui.xml": MENU,
  "strings/menu.strings.json": formatStringTable(parseStringTable(TABLE).table),
};

let engine: Engine;
let project: EditorProject;

beforeEach(async () => {
  Input.reset();
  status.value = null;
  const fs = new MemoryFileSystem();
  for (const [path, text] of Object.entries(FILES)) fs.files.set(joinPath(ROOT, path), text);
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  await loadUIDocumentSupport();
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
});

afterEach(async () => {
  await editorTextFiles.flush();
  select([]);
  playState.value = "edit";
  openScene.value?.sync.dispose();
  openScene.value = null;
  currentProject.value = null;
  engine.dispose();
});

const ref = (path: string): UIElementRef => ({ host: "hud", index: 0, path });
const el = (path: string) => resolveUIElement(openScene.value!.sync, ref(path))!;
const text = (path: string) => project.textOf(path) ?? null;
async function settle(): Promise<void> {
  await editorTextFiles.flush();
  engine.step(1 / 60);
}
/** The project's tables, as the Inspector reads them. */
const data = () => exchangeProjectOf(parseLanguages(project.settings.languages).languages, project.files.filter((f) => f.endsWith(".strings.json")).map((f) => [f, project.assets.get(f)] as const));

describe("Localise on a text field", () => {
  it("reads the field's literal text and key", () => {
    expect(uiElementLiteral(el("/#title"), "text")).toBe("Main menu");
    expect(uiElementLiteral(el("/#name"), "placeholder")).toBe("Your name");
    expect(uiElementKey(el("/#title"), "text")).toBeNull();
  });

  it("binds a field to a picked key, replacing its literal text, and unlinks it", async () => {
    expect(localiseUIElement(ref("/#title"), "text", "menu.start")).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toContain('<Text id="title" t:text="menu.start"></Text>');
    expect(uiElementKey(el("/#title"), "text")).toBe("menu.start");
    expect(localiseUIElement(ref("/#name"), "placeholder", "menu.start")).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toContain('<InputField id="name" t:placeholder="menu.start"/>');
    expect(localiseUIElement(ref("/#title"), "text", null)).toBe(true);
    await settle();
    expect(uiElementKey(el("/#title"), "text")).toBeNull();
  });

  it("extracts the literal text to a string table under a suggested key, both files in one undo step", async () => {
    const p = data();
    const key = suggestKey(p, "ui/menu.ui.xml", "title", "Text", "text");
    expect(key).toBe("menu.title");
    const table = suggestTable(p, "ui/menu.ui.xml");
    expect(table).toBe("strings/menu.strings.json");
    const r = extractToTable(p, table, project.assets.get(table), key, uiElementLiteral(el("/#title"), "text")!);
    if ("refused" in r) throw new Error(r.refused);
    expect(extractUIElementText(ref("/#title"), "text", key, table, formatStringTable(r.next))).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toContain('<Text id="title" t:text="menu.title"></Text>');
    expect(parseStringTable(JSON.parse(text(table)!)).table.strings.map((e) => [e.key, e.text])).toEqual([["menu.start", "Start"], ["menu.title", "Main menu"]]);
    expect(openScene.value!.stack.undo()).toBe(true);
    await settle();
    expect(text("ui/menu.ui.xml")).toBe(MENU);
    expect(parseStringTable(JSON.parse(text(table)!)).table.strings.map((e) => e.key)).toEqual(["menu.start"]);
  });

  it("creates a new table in the reference language, and refuses a taken key", async () => {
    const p = data();
    const r = extractToTable(p, "strings/ui.strings.json", undefined, "ui.name_hint", "Your name");
    if ("refused" in r) throw new Error(r.refused);
    expect(r.next.language).toBe("en");
    expect(extractUIElementText(ref("/#name"), "placeholder", "ui.name_hint", "strings/ui.strings.json", formatStringTable(r.next))).toBe(true);
    await settle();
    expect(project.files).toContain("strings/ui.strings.json");
    expect(text("ui/menu.ui.xml")).toContain('t:placeholder="ui.name_hint"');
    const taken = extractToTable(p, "strings/menu.strings.json", project.assets.get("strings/menu.strings.json"), "menu.start", "x");
    expect(taken).toEqual({ refused: '"menu.start" is a key of strings/menu.strings.json already' });
    expect(extractToTable(p, "strings/bad.name.strings.json", undefined, "k", "x")).toMatchObject({ refused: expect.stringMatching(/isn't a string table path/) });
  });
});
