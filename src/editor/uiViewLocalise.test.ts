// Localising Svelte UI from the editor (ADR 0356 §9, ADR 0423 wave F): the Inspector's Localise and Extract to string
// table write `{t("key")}` into the view's `.svelte` source (importing `t` from `myco` when the script doesn't) and, for
// Extract, the key into the table, as one undo step on the scene's history; Unlink writes the text back; dynamic parts
// are refused with the reason. The fit check's targets come from what the views rendered, with their boxes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import type { UIComponentType } from "../engine/ui/components";
import { UICore } from "../engine/ui/UICore";
import type { UIHostElement } from "../engine/ui/host/UIHost";
import { estimateText } from "../engine/ui/layout";
import { UIView } from "../plugins/ui/runtime/UIView";
import { loadProjectCode } from "../plugins/thirdPartyEditor";
import { useEditorPlugins } from "../plugins/testEditorPlugins";
import { uiEditorPlugin } from "../plugins/ui/editor";
import { MemoryFileSystem } from "./memoryFs";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, playState, sceneCamera, status } from "./state";
import { select } from "./inspectorTarget";
import { editorTextFiles } from "./textFiles";
import { useCoreAssetKinds } from "./testing";
import { loadSvelteParser } from "./uiEdit/svelteText";
import { refOfViewElement, type UIViewRef } from "./uiViews";
import { extractUIViewText, localiseUIViewText, uiViewElementTexts, unlinkUIViewText } from "./uiViewEdits";
import { fitTargets } from "./uiViewStrings";
import { fitCheck } from "./ui/localisation/textFit";
import { exchangeProjectOf } from "./ui/localisation/localisationData";
import { parseLanguages } from "../engine/localisation/languages";
import "./session"; // what reloads the project's code when an edit writes UI code

const ROOT = "C:\\Games\\svelte-localise";
const DT = 1 / 60;

const MENU = `<script lang="ts">
  let { w = 120 }: { w?: number } = $props();
</script>

<section id="menu" flex-direction="column">
  <p id="hint">Press any key</p>
  <p id="score">Score: {w}</p>
  <input id="name" placeholder="Your name" />
  <p id="start" width="40" height="20" padding="2">Start</p>
  <button id="quit" width="300" height="50">Quit</button>
  <p id="free">Free text</p>
</section>
`;
const OTHER = `<script lang="ts">\n  import { t } from "myco";\n</script>\n\n<p>{t("menu.quit")}</p>\n`;
const TABLE = `${JSON.stringify({ format: "myco.strings@1", language: "en", strings: [{ key: "menu.start", text: "Start the game now" }, { key: "menu.quit", text: "Quit" }, { key: "hud.coins", text: "{n} coins" }] }, null, 2)}\n`;

const SCENE = {
  format: "myco.scene@1",
  nodes: [
    { id: "cam", name: "Camera", components: [{ type: "engine.Transform" }, { type: "engine.Camera" }] },
    { id: "menu", name: "Menu", components: [{ type: "engine.Transform" }, { type: "engine.UIView", data: { component: "asset:ui/Menu.svelte" } }] },
  ],
};

const FILES: Record<string, string> = {
  "project.json": JSON.stringify({ name: "Svelte localise test" }),
  "scenes/main.scene.json": JSON.stringify(SCENE, null, 2),
  "ui/Menu.svelte": MENU,
  "ui/Other.svelte": OTHER,
  "strings/menu.strings.json": TABLE,
};

vi.setConfig({ testTimeout: 60_000 });

useCoreAssetKinds();
useEditorPlugins([uiEditorPlugin], "each");

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
  await loadSvelteParser();
  expect((await loadProjectCode(project)).problems).toEqual([]);
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
  await settle();
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

const scene = () => openScene.value!;
const view = () => scene().sync.nodeFor("menu")!.getComponent(UIView)!;
const text = (path = "ui/Menu.svelte") => project.textOf(path)!;
async function settle(): Promise<void> {
  await editorTextFiles.flush();
  await view().ready;
  engine.step(DT);
}
const find = (id: string): UIHostElement => view().query(`#${id}`)!;
const ref = (id: string): UIViewRef => refOfViewElement(scene().sync, find(id))!;

describe("Localise and Extract to string table", () => {
  it("lists an element's localisable text as written", () => {
    expect(uiViewElementTexts(scene(), ref("hint"))).toEqual([{ field: "text", state: { kind: "literal", text: "Press any key" } }]);
    expect(uiViewElementTexts(scene(), ref("name"))).toEqual([{ field: "placeholder", state: { kind: "literal", text: "Your name" } }]);
    expect(uiViewElementTexts(scene(), ref("score"))[0].state.kind).toBe("dynamic");
  });

  it("writes {t(\"key\")} in place of literal text, importing t from myco, as one undo step; Unlink writes the text back", async () => {
    expect(localiseUIViewText(ref("hint"), "text", "menu.start")).toBe(true);
    await settle();
    expect(text()).toBe(MENU.replace(`<script lang="ts">\n`, `<script lang="ts">\n  import { t } from "myco";\n`).replace(`<p id="hint">Press any key</p>`, `<p id="hint">{t("menu.start")}</p>`));
    expect(uiViewElementTexts(scene(), ref("hint"))).toEqual([{ field: "text", state: { kind: "keyed", call: { name: "t", key: "menu.start", args: false } } }]);
    expect(localiseUIViewText(ref("hint"), "text", "menu.quit")).toBe(false);
    expect(status.value?.text).toMatch(/shows the key menu.start already/);
    expect(unlinkUIViewText(ref("hint"), "text", "Start the game now")).toBe(true);
    await settle();
    expect(text()).toContain(`<p id="hint">Start the game now</p>`);
    expect(scene().stack.undo()).toBe(true);
    expect(scene().stack.undo()).toBe(true);
    await settle();
    expect(text()).toBe(MENU);
  });

  it("extracts a literal attribute to a table under a new key, both files in one undo step", async () => {
    const table = `${JSON.stringify({ ...JSON.parse(TABLE), strings: [...JSON.parse(TABLE).strings, { key: "menu.name", text: "Your name" }] }, null, 2)}\n`;
    expect(extractUIViewText(ref("name"), "placeholder", "menu.name", "strings/menu.strings.json", table)).toBe(true);
    await settle();
    expect(text()).toContain(`<input id="name" placeholder={t("menu.name")} />`);
    expect(text()).toContain(`import { t } from "myco";`);
    expect(text("strings/menu.strings.json")).toBe(table);
    expect(scene().stack.undo()).toBe(true);
    await settle();
    expect(text()).toBe(MENU);
    expect(text("strings/menu.strings.json")).toBe(TABLE);
  });

  it("refuses text with expressions, invalid keys and attributes the element doesn't have, with the reason", () => {
    expect(localiseUIViewText(ref("score"), "text", "menu.start")).toBe(false);
    expect(status.value?.text).toMatch(/Couldn't localise the text: its text has expressions \(Score: \{w\}\)/);
    expect(localiseUIViewText(ref("hint"), "text", "not a key")).toBe(false);
    expect(status.value?.text).toMatch(/isn't a key/);
    expect(localiseUIViewText(ref("hint"), "title", "menu.start")).toBe(false);
    expect(status.value?.text).toMatch(/has no title text/);
    expect(text()).toBe(MENU);
  });
});

describe("the fit check's targets", () => {
  it("takes each rendered keyed element's content box where its size is fixed, and counts keyed text no view rendered", async () => {
    expect(localiseUIViewText(ref("start"), "text", "menu.start")).toBe(true);
    await settle();
    expect(localiseUIViewText(ref("quit"), "text", "menu.quit")).toBe(true);
    await settle();
    expect(localiseUIViewText(ref("free"), "text", "hud.coins")).toBe(true);
    await settle();
    const core = new UICore({ interactive: false });
    await core.ready;
    try {
      core.sync(engine.world, 1280, 720, DT);
      const sizeOf = (c: UIComponentType) => core.cornersOf(c)?.size ?? null;
      const { targets, unrendered } = fitTargets(scene().sync.sceneNode, sizeOf, project.files);
      expect(targets.map((t) => [t.where, t.key, t.line, t.box.width, t.box.height])).toEqual([
        ["#start", "menu.start", 10, 36, 16],
        ["#quit", "menu.quit", 11, 276, 26], // a button's padding (12) taken off
        ["#free", "hud.coins", 12, null, null],
      ]);
      expect(unrendered).toBe(1); // ui/Other.svelte's
      const languages = parseLanguages({ list: [{ code: "en", name: "English" }], reference: "en" }).languages;
      const data = exchangeProjectOf(languages, [["strings/menu.strings.json", JSON.parse(TABLE)]]);
      const fit = fitCheck({ project: data, targets, unrendered, measure: estimateText, languages: ["en"] });
      expect(fit).toMatchObject({ checked: 2, skipped: 2 });
      expect(fit.overflows.map((o) => [o.where, o.reason])).toEqual([["#start", "lines"]]);
    } finally {
      core.dispose();
    }
  });
});
