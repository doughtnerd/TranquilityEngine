// UI documents in the editor (ADR 0077 wave B, part 1): documents build in the Editor World's scene
// and hot-reload when a file is saved; their elements map to selection refs, hierarchy rows, markup
// spans and value sources; they're selected apart from nodes; and they never reach saved files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Engine, GameObject, Input } from "../engine";
import { UIButton, UIText } from "../engine/ui/components";
import { UIDocument } from "../engine/ui/UIDocument";
import { loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { MemoryFileSystem } from "./memoryFs";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile, saveOpenScene } from "./project";
import { createPrefab } from "./prefabs";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, sceneCamera, select, selectedKeys, selectedUIElement } from "./state";
import {
  contentSpan,
  describeOrigin,
  documentRows,
  elementOfComponent,
  fieldSources,
  markupLocation,
  parseUIRefKey,
  refOfElement,
  resolveUIElement,
  rowAncestry,
  selectUIElement,
  selectedUIRef,
  uiRefKey,
  type FieldSourceRow,
} from "./uiDocuments";
import { applyClickSelection, chooseSelection, uiHitKeys } from "./viewportSelection";

const ROOT = "C:\\Games\\ui";
const DT = 1 / 60;

const MENU = `<Canvas>
  <Style src="menu.ui.css"/>
  <Panel id="menu" class="column" padding="12">
    <Text id="title">Score: {score}</Text>
    <Text class="note">Plain</Text>
    <Button id="play" class="primary">Play</Button>
    <Use src="widgets/badge.ui.xml" id="badge"/>
  </Panel>
</Canvas>`;
const MENU_CSS = `:root { --fg: #ffeedd; }
.column { flex-direction: column; color: var(--fg); }
.primary { background-color: #336699; }
.primary:hover { background-color: #4477aa; }
#title { font-size: 30px; }`;
const BADGE = `<Panel class="badge"><Text width="{w}">Badge</Text></Panel>`;

const SCENE = {
  format: "myco.scene@1",
  nodes: [
    { id: "cam", name: "Camera", components: [{ type: "engine.Transform" }, { type: "engine.Camera" }] },
    { id: "hud", name: "HUD", components: [{ type: "engine.Transform" }, { type: "engine.UIDocument", data: { document: "asset:ui/menu.ui.xml" } }] },
    { id: "child", name: "Child", parent: "hud", components: [{ type: "engine.Transform" }] },
  ],
};

let engine: Engine;
let project: EditorProject;

beforeEach(async () => {
  Input.reset();
  const fs = new MemoryFileSystem();
  const put = (path: string, text: string) => fs.files.set(joinPath(ROOT, path), text);
  put("project.json", JSON.stringify({ name: "UI test" }));
  put("scenes/main.scene.json", JSON.stringify(SCENE, null, 2));
  put("ui/menu.ui.xml", MENU);
  put("ui/menu.ui.css", MENU_CSS);
  put("ui/widgets/badge.ui.xml", BADGE);
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  await loadUIDocumentSupport();
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
});

afterEach(() => {
  select([]);
  openScene.value?.sync.dispose();
  openScene.value = null;
  currentProject.value = null;
  engine.dispose();
  vi.restoreAllMocks();
});

const scene = () => openScene.value!;
const hudDoc = () => scene().sync.nodeFor("hud")!.getComponent(UIDocument)!;

describe("documents in the Editor World", () => {
  it("build with the scene, under their node, in edit mode", () => {
    const doc = hudDoc();
    expect(doc.root).not.toBeNull();
    expect(engine.world.inEditMode(doc.root!.node.entity)).toBe(true);
    expect(doc.query("#play")!.as(UIButton).backgroundColor).toEqual(Color.from("#336699"));
  });

  it("hot-reload when a markup or stylesheet file is saved", async () => {
    await project.writeFile("ui/menu.ui.css", MENU_CSS.replace("#336699", "#aa0000"));
    engine.step(DT);
    expect(hudDoc().query("#play")!.as(UIButton).backgroundColor).toEqual(Color.from("#aa0000"));
    await project.writeFile("ui/menu.ui.xml", MENU.replace(`<Text class="note">Plain</Text>`, `<Text id="added">New</Text>`));
    engine.step(DT);
    expect(hudDoc().query("#added")!.as(UIText).text).toBe("New");
  });

  it("never reach the scene file, a prefab made from their node, or play mode's snapshot", async () => {
    const json = JSON.stringify(scene().doc.toJSON());
    expect(json).not.toContain("engine.UIButton");
    expect(scene().doc.children("hud")).toEqual(["child"]);
    await saveOpenScene();
    expect(project.textOf("scenes/main.scene.json")).not.toContain("UIButton");
    const prefab = await createPrefab(scene(), project, "hud");
    const text = project.textOf(prefab)!;
    expect(text).toContain("engine.UIDocument");
    expect(text).not.toMatch(/engine\.UI(Canvas|Panel|Text|Button)/);
  });

  it("survive a rebuild of their node from the document (an edit to the UIDocument)", () => {
    const sync = scene().sync;
    const ref = { host: "hud", index: 0, path: "/#menu/#play" };
    const before = resolveUIElement(sync, ref)!;
    sync.build(); // what a script reload does
    const after = resolveUIElement(sync, ref)!;
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});

describe("refs and hierarchy rows", () => {
  it("round-trip between keys, refs and live elements", () => {
    const sync = scene().sync;
    const play = hudDoc().query("#play")!;
    const ref = refOfElement(sync, play)!;
    expect(ref).toEqual({ host: "hud", index: 0, path: "/#menu/#play" });
    expect(parseUIRefKey(uiRefKey(ref))).toEqual(ref);
    expect(parseUIRefKey("hud/inner")).toBeNull();
    expect(resolveUIElement(sync, ref)).toBe(play);
    expect(elementOfComponent(play.component)).toBe(play);
    expect(resolveUIElement(sync, { ...ref, path: "/#gone" })).toBeNull();
    expect(resolveUIElement(sync, { ...ref, index: 1 })).toBeNull();
  });

  it("list a node's documents as element trees, labelled and marked with their file", () => {
    const sync = scene().sync;
    expect(documentRows(sync, "cam")).toEqual([]);
    const [d] = documentRows(sync, "hud");
    expect(d.file).toBe("ui/menu.ui.xml");
    const root = d.root!;
    expect(root.label).toBe("Canvas");
    const menu = root.children[0];
    expect(menu.label).toBe("Panel#menu.column");
    expect(menu.children.map((c) => c.label)).toEqual(["Text#title", "Text.note", "Button#play.primary", "Panel#badge.badge"]);
    const play = menu.children[2];
    expect(play.children[0]).toMatchObject({ label: 'Label "Play"', synthetic: true });
    const badge = menu.children[3];
    expect(badge.file).toBe("ui/widgets/badge.ui.xml");
    expect(rowAncestry([d], play.children[0].key)).toEqual([root.key, menu.key, play.key]);
    expect(rowAncestry([d], "ui:nope|0|")).toBeNull();
  });

  it("give an element's markup location and text content span", () => {
    const play = hudDoc().query("#play")!;
    const where = markupLocation(play);
    expect(where.file).toBe("ui/menu.ui.xml");
    expect(where.line).toBe(6);
    expect(MENU.slice(where.openTagSpan.start, where.openTagSpan.end)).toBe(`<Button id="play" class="primary">`);
    const span = contentSpan(play._markup, MENU)!;
    expect(MENU.slice(span.start, span.end)).toBe("Play");
    const badge = hudDoc().query("#badge")!;
    expect(markupLocation(badge).from).toBe("ui/widgets/badge.ui.xml");
    expect(contentSpan(hudDoc().root!._markup, MENU)).not.toBeNull();
  });
});

describe("value sources", () => {
  const field = (rows: FieldSourceRow[], name: string) => rows.find((r) => r.field === name)!;

  it("name the attribute, the rule, the inheritance, the content and the default", () => {
    const menu = fieldSources(hudDoc().query("#menu")!);
    const padding = field(menu, "padding");
    expect(padding.origin).toMatchObject({ kind: "attribute", file: "ui/menu.ui.xml", line: 3 });
    expect(padding.display).toBe("12");
    expect(field(menu, "flexDirection").origin).toMatchObject({ kind: "rule", selector: ".column", property: "flex-direction", file: "ui/menu.ui.css", line: 2 });
    expect(field(menu, "gap").origin).toEqual({ kind: "default" });
    expect(field(menu, "backgroundColor").display).toBe("none");

    const title = fieldSources(hudDoc().query("#title")!);
    expect(field(title, "fontSize").origin).toMatchObject({ kind: "rule", selector: "#title" });
    expect(field(title, "text").origin).toMatchObject({ kind: "content", bound: true, line: 4 });
    const color = field(title, "color");
    expect(color.display).toBe("#ffeedd");
    expect(color.origin).toMatchObject({ kind: "inherited", fromLabel: "Panel#menu.column", origin: { kind: "rule", selector: ".column", property: "color" } });
    expect(describeOrigin(color.origin)).toMatch(/^Inherited from Panel#menu\.column · \.column \{ color: var\(--fg\) \} · ui\/menu\.ui\.css:2$/);
    expect(field(fieldSources(hudDoc().query(".note")!), "text").origin).toMatchObject({ kind: "content", bound: false });
  });

  it("follow inheritance through several elements to where it's set, and name a button's :hover colour rule", () => {
    const label = hudDoc().query("#play")!.children[0];
    const rows = fieldSources(label);
    const color = field(rows, "color");
    if (color.origin.kind !== "inherited") throw new Error("not inherited");
    expect(color.origin.from).toBe(hudDoc().query("#menu"));
    expect(field(rows, "text").origin).toMatchObject({ kind: "content" });
    const play = fieldSources(hudDoc().query("#play")!);
    expect(field(play, "hoverColor").origin).toMatchObject({ kind: "rule", selector: ".primary:hover", state: "hover" });
    expect(field(play, "pressedColor").origin).toMatchObject({ kind: "rule", selector: ".primary:hover", state: "pressed" });
  });

  it("mark bound attributes, in used documents too", () => {
    const text = hudDoc().query("#badge Text")!;
    const width = field(fieldSources(text), "width");
    expect(width.origin).toMatchObject({ kind: "binding", file: "ui/widgets/badge.ui.xml" });
    expect(describeOrigin(width.origin)).toMatch(/^Bound: width="\{w\}"/);
  });
});

describe("selecting elements", () => {
  it("is apart from nodes: each clears the other", () => {
    select(["cam"]);
    selectUIElement({ host: "hud", index: 0, path: "/#menu" });
    expect(selectedKeys.value).toEqual([]);
    expect(selectedUIRef()).toEqual({ host: "hud", index: 0, path: "/#menu" });
    select(["child"]);
    expect(selectedUIElement.value).toBeNull();
    selectUIElement({ host: "hud", index: 0, path: "/#menu" });
    select([]); // clicking empty space
    expect(selectedUIElement.value).toBeNull();
  });

  it("maps picked UI to element keys (document UI) and node ids (hand-built UI), skipping locked hosts", () => {
    const sync = scene().sync;
    const play = hudDoc().query("#play")!;
    const label = play.children[0];
    const keys = uiHitKeys([label.component, play.component, label.component], sync, () => true);
    expect(keys).toEqual([uiRefKey(refOfElement(sync, label)!), uiRefKey(refOfElement(sync, play)!)]);
    expect(uiHitKeys([play.component], sync, (n) => n !== hudDoc().node)).toEqual([]);
  });

  it("a click on the same spot cycles from the topmost element down to scene nodes", () => {
    const sync = scene().sync;
    const play = hudDoc().query("#play")!;
    const hits = [...uiHitKeys([play.children[0].component, play.component], sync, () => true), "cam"];
    let current: string | null = null;
    const chosen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const key = chooseSelection(hits, current, i > 0);
      applyClickSelection(key);
      current = selectedUIElement.value ?? selectedKeys.value.at(-1) ?? null;
      chosen.push(current!);
    }
    expect(chosen).toEqual([hits[0], hits[1], "cam", hits[0]]);
    expect(selectedUIRef()).toEqual(parseUIRefKey(hits[0]));
    applyClickSelection(null);
    expect(selectedUIElement.value).toBeNull();
    expect(selectedKeys.value).toEqual([]);
  });
});
