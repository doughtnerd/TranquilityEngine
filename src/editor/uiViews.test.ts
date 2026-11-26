// Svelte UI in the editor (ADR 0419 wave C): a UIView's rendered elements as hierarchy rows addressed by template
// location, picking, the Inspector's value sources, and editing the static parts back into the `.svelte` source
// (one undo step each, the view hot-reloading), with dynamic parts view-only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Engine, GameObject, Input } from "../engine";
import { UIButton, UIPanel, UIText } from "../engine/ui/components";
import type { UIHostElement } from "../engine/ui/host/UIHost";
import { UIView } from "../plugins/ui/runtime/UIView";
import { loadProjectCode } from "../plugins/thirdPartyEditor";
import { useEditorPlugins } from "../plugins/testEditorPlugins";
import { uiEditorPlugin } from "../plugins/ui/editor";
import { MemoryFileSystem } from "./memoryFs";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, readOnlyProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, playState, sceneCamera, scriptProblems, status } from "./state";
import { inspectorTarget, select, selectUIElement } from "./inspectorTarget";
import { editorTextFiles } from "./textFiles";
import { useCoreAssetKinds } from "./testing";
import { loadSvelteParser } from "./uiEdit/svelteText";
import { UICore } from "../engine/ui/UICore";
import type { UIComponentType } from "../engine/ui/components";
import { beginMove, beginResize, whyNoHandles, type BoxOf } from "./uiHandleDrags";
import "./session"; // what reloads the project's code when an edit writes UI code
import {
  refOfViewElement,
  resolveUIViewElement,
  selectedUIViewRef,
  viewElementOfComponent,
  viewFieldSources,
  viewRows,
  whyViewOnly,
  type UIViewRef,
  type UIViewRow,
} from "./uiViews";
import {
  createUIViewElement,
  deleteUIViewElement,
  duplicateUIViewElement,
  moveUIViewElement,
  moveUIViewElementToClass,
  renameUIViewElement,
  setUIViewElementAttributes,
  setUIViewElementClasses,
  setUIViewElementField,
  setUIViewElementText,
  whyNotMovableView,
} from "./uiViewEdits";

const ROOT = "C:\\Games\\svelte-edit";
const DT = 1 / 60;

const HUD = `<script lang="ts">
  import Badge from "./Badge.svelte";
  import "./theme.css";
  let { w = 120, items = ["a", "b"] }: { w?: number; items?: string[] } = $props();
</script>

<section id="hud" gap="4">
  <h1 id="title" class="title">Hello</h1>
  <p id="score" width={w}>Score: {w}</p>
  <button id="play" class="primary">Play</button>
  {#each items as item}
    <span class="row">{item}</span>
  {/each}
  <Badge />
  <div id="box" style="height: 20px" width="50"></div>
</section>

<style>
  .title { font-size: 30px; }
  .primary { background-color: #336699; }
  #hud { color: #ff0000; }
</style>
`;
const BADGE = `<div id="badge" class="badge"><span>Badge</span></div>

<style>
  .badge { gap: 3px; }
</style>
`;
const THEME = `.title { color: #00ff00; }\n`;

const SCENE = {
  format: "myco.scene@1",
  nodes: [
    { id: "cam", name: "Camera", components: [{ type: "engine.Transform" }, { type: "engine.Camera" }] },
    { id: "hud", name: "HUD", components: [{ type: "engine.Transform" }, { type: "engine.UIView", data: { component: "asset:ui/Hud.svelte" } }] },
  ],
};

const FILES: Record<string, string> = {
  "project.json": JSON.stringify({ name: "Svelte edit test" }),
  "scenes/main.scene.json": JSON.stringify(SCENE, null, 2),
  "ui/Hud.svelte": HUD,
  "ui/Badge.svelte": BADGE,
  "ui/theme.css": THEME,
};

// The first link loads svelte/compiler and TypeScript: seconds when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

useCoreAssetKinds();
useEditorPlugins([uiEditorPlugin], "each");

let engine: Engine;
let project: EditorProject;

async function open(p: EditorProject): Promise<void> {
  project = p;
  useProjectAssets(project);
  currentProject.value = project;
  await loadSvelteParser();
  expect((await loadProjectCode(project)).problems).toEqual([]);
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
  await settle();
}

beforeEach(async () => {
  Input.reset();
  status.value = null;
  const fs = new MemoryFileSystem();
  for (const [path, text] of Object.entries(FILES)) fs.files.set(joinPath(ROOT, path), text);
  await open(await openFolderProject(fs, ROOT));
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
const view = () => scene().sync.nodeFor("hud")!.getComponent(UIView)!;
const text = (path = "ui/Hud.svelte") => project.textOf(path)!;
/** Let queued file writes land (and the project's code reload), and the view mount the new version. */
async function settle(): Promise<void> {
  await editorTextFiles.flush();
  await view().ready;
  engine.step(DT);
}
const find = (id: string): UIHostElement => view().query(`#${id}`)!;
const refOf = (el: UIHostElement): UIViewRef => refOfViewElement(scene().sync, el)!;
const ref = (id: string) => refOf(find(id));
const row = (rows: readonly UIViewRow[], label: string): UIViewRow | undefined => {
  for (const r of rows) {
    if (r.label === label) return r;
    const inner = row(r.children, label);
    if (inner) return inner;
  }
  return undefined;
};
const source = (el: UIHostElement, field: string) => viewFieldSources(el).find((r) => r.field === field)!.origin;

describe("the model", () => {
  it("lists a view's rendered elements under its node, addressed by template location, and resolves them back", () => {
    const [v] = viewRows(scene().sync, "hud");
    expect(v.file).toBe("ui/Hud.svelte");
    const hud = v.rows[0];
    expect(hud.label).toBe("section#hud");
    expect(hud.ref).toMatchObject({ host: "hud", index: 0, file: "ui/Hud.svelte", line: 7, column: 0, nth: 0 });
    expect(hud.children.map((c) => c.label)).toEqual(["h1#title.title", "p#score", "button#play.primary", "span.row", "span.row", "div#badge.badge", "div#box"]);
    const rows = hud.children.filter((c) => c.label === "span.row");
    expect(rows.map((r) => r.ref.nth)).toEqual([0, 1]);
    expect(row(v.rows, "div#badge.badge")!.file).toBe("ui/Badge.svelte");
    for (const r of [hud, ...hud.children]) expect(resolveUIViewElement(scene().sync, r.ref)).not.toBeNull();
    expect(resolveUIViewElement(scene().sync, rows[1].ref)).not.toBe(resolveUIViewElement(scene().sync, rows[0].ref));
  });

  it("picks the element a click lands on (a button's label picks the button), and selecting it shows it in the Inspector", () => {
    const play = find("play");
    const label = play.children.find((c) => c.synthetic)!;
    expect(viewElementOfComponent(label.component)).toBe(play);
    expect(viewElementOfComponent(play.component)).toBe(play);
    selectUIElement(refOf(play));
    expect(selectedUIViewRef()).toEqual(refOf(play));
    expect(inspectorTarget.value).toMatchObject({ kind: "uiViewElement", ref: refOf(play) });
  });

  it("says where each value comes from: literal attributes, the literal style, expressions, scoped and global rules, inheritance, text", () => {
    expect(source(find("box"), "width")).toMatchObject({ kind: "attribute", file: "ui/Hud.svelte", line: 15, attribute: { name: "width", value: "50" } });
    expect(source(find("box"), "height")).toMatchObject({ kind: "attribute", attribute: { name: "style" } });
    expect(source(find("score"), "width")).toMatchObject({ kind: "expression", file: "ui/Hud.svelte", line: 9, name: "width", source: "{w}" });
    expect(source(find("score"), "text")).toMatchObject({ kind: "expression", source: "Score: {w}" });
    expect(source(find("title"), "text")).toMatchObject({ kind: "content", line: 8 });
    expect(source(find("title"), "fontSize")).toMatchObject({ kind: "rule", file: "ui/Hud.svelte", selector: ".title", line: 19 });
    expect(source(find("title"), "color")).toMatchObject({ kind: "rule", file: "ui/theme.css", selector: ".title", line: 1 });
    expect(source(find("score"), "color")).toMatchObject({ kind: "inherited", fromLabel: "section#hud", origin: { kind: "rule", selector: "#hud", line: 21 } });
    expect(source(find("hud"), "padding")).toEqual({ kind: "default" });
  });

  it("makes {#each} rows and child components' insides view-only, with the reason", () => {
    const [v] = viewRows(scene().sync, "hud");
    const each = v.rows[0].children.find((c) => c.label === "span.row")!;
    expect(whyViewOnly(scene().sync, each.ref)).toMatch(/row of the \{#each\} at line 11/);
    expect(whyViewOnly(scene().sync, ref("badge"))).toMatch(/inside a child component \(Badge\.svelte\)/);
    expect(whyViewOnly(scene().sync, ref("title"))).toBeNull();
    expect(setUIViewElementAttributes(each.ref, { width: "10" })).toBe(false);
    expect(status.value?.text).toMatch(/Can't edit that element: it's a row of the \{#each\}/);
  });
});

describe("editing", () => {
  it("writes a field as a literal attribute, hot-reloads, and undoes and redoes in the scene's history", async () => {
    expect(setUIViewElementField(ref("play"), "backgroundColor", "#00ff00")).toBe(true);
    await settle();
    expect(text()).toBe(HUD.replace(`<button id="play" class="primary">`, `<button id="play" class="primary" background-color="#00ff00">`));
    expect(find("play").as(UIButton).backgroundColor).toEqual(Color.from("#00ff00"));
    expect(source(find("play"), "backgroundColor")).toMatchObject({ kind: "attribute" });
    expect(scene().stack.undo()).toBe(true);
    await settle();
    expect(text()).toBe(HUD);
    expect(find("play").as(UIButton).backgroundColor).toEqual(Color.from("#336699"));
    expect(scene().stack.redo()).toBe(true);
    await settle();
    expect(find("play").as(UIButton).backgroundColor).toEqual(Color.from("#00ff00"));
    expect(scriptProblems.value).toEqual([]);
  });

  it("changes the literal style where it sets the property, resets attributes, refuses expressions and bad values", async () => {
    setUIViewElementAttributes(ref("box"), { height: "30px", width: null });
    await settle();
    expect(text()).toContain(`<div id="box" style="height: 30px"></div>`);
    expect(find("box").as(UIPanel).height).toBe("30");
    expect(setUIViewElementField(ref("score"), "width", "10")).toBe(false);
    expect(status.value?.text).toMatch(/width is an expression \(\{w\}\)/);
    expect(setUIViewElementField(ref("title"), "color", "blurple")).toBe(false);
    expect(status.value?.text).toMatch(/isn't a valid color/);
  });

  it("edits literal text, the id (keeping the selection) and the static class", async () => {
    selectUIElement(ref("title"));
    expect(setUIViewElementText(ref("title"), "Welcome")).toBe(true);
    expect(renameUIViewElement(ref("title"), "heading")).toBe(true);
    expect(setUIViewElementClasses(ref("play"), "primary big")).toBe(true);
    await settle();
    expect(text()).toContain(`<h1 id="heading" class="title">Welcome</h1>`);
    expect(text()).toContain(`<button id="play" class="primary big">`);
    expect(find("heading").as(UIText).text).toBe("Welcome");
    expect(resolveUIViewElement(scene().sync, selectedUIViewRef()!)).toBe(find("heading"));
    expect(setUIViewElementText(ref("score"), "x")).toBe(false);
    expect(renameUIViewElement(ref("play"), "box")).toBe(false);
    expect(status.value?.text).toMatch(/is #box already/);
  });

  it("creates, duplicates, moves and deletes elements, selecting where they went", async () => {
    const made = createUIViewElement("button", ref("hud"))!;
    await settle();
    expect(text()).toContain(`<div id="box" style="height: 20px" width="50"></div>\n  <button width="160" height="40">Button</button>\n</section>`);
    expect(resolveUIViewElement(scene().sync, made)!.tag).toBe("button");
    expect(selectedUIViewRef()).toEqual(made);

    expect(duplicateUIViewElement(ref("title"))).toBe(true);
    await settle();
    expect(text()).toContain(`<h1 id="title" class="title">Hello</h1>\n  <h1 id="title-2" class="title">Hello</h1>`);
    expect(resolveUIViewElement(scene().sync, selectedUIViewRef()!)).toBe(find("title-2"));

    expect(whyNotMovableView(scene(), ref("box"), ref("title"))).toBeNull();
    expect(moveUIViewElement(ref("box"), ref("hud"), 0)).toBe(true);
    await settle();
    expect(text()).toContain(`<section id="hud" gap="4">\n  <div id="box"`);
    expect(resolveUIViewElement(scene().sync, selectedUIViewRef()!)).toBe(find("box"));
    expect(view().query("section")!.children[0]).toBe(find("box"));

    expect(deleteUIViewElement(ref("box"))).toBe(true);
    await settle();
    expect(text()).not.toContain(`id="box"`);
    expect(resolveUIViewElement(scene().sync, selectedUIViewRef()!)).toBe(find("hud"));

    // A new element at the view's top level, when the view itself is the target.
    createUIViewElement("p", { host: "hud", index: 0 });
    await settle();
    expect(text()).toContain(`</section>\n<p>New Text</p>`);
  });

  it("moves literal attributes into a class rule in the component's <style>", async () => {
    expect(moveUIViewElementToClass(ref("box"), "panel")).toBe(true);
    await settle();
    expect(text()).toContain(`<div id="box" class="panel"></div>`);
    expect(text()).toContain(`.panel { width: 50px; height: 20px; }`);
    expect(find("box").as(UIPanel).width).toBe("50");
    expect(source(find("box"), "width")).toMatchObject({ kind: "rule", selector: ".panel", file: "ui/Hud.svelte" });
  });

  it("refuses edits in read-only projects and while playing", async () => {
    playState.value = "playing";
    expect(setUIViewElementField(ref("play"), "width", "10")).toBe(false);
    expect(status.value?.text).toMatch(/stop playing/i);
    playState.value = "edit";
    await editorTextFiles.flush();
    openScene.value?.sync.dispose();
    openScene.value = null;
    engine.dispose();
    const values = new Map<string, unknown>(), texts = new Map<string, string>();
    for (const [path, t] of Object.entries(FILES)) {
      values.set(path, path.endsWith(".json") ? JSON.parse(t) : t);
      texts.set(path, t);
    }
    await open(readOnlyProject("Sample", { values, texts }));
    expect(setUIViewElementField(ref("play"), "width", "10")).toBe(false);
    expect(status.value?.text).toMatch(/read-only/);
  });
});

describe("scene-view handles", () => {
  it("resize a static element (the literal attribute, and the style where it sets the size) as one undo step; reorder in flow; refuse dynamic ones", async () => {
    const core = new UICore({ interactive: false });
    await core.ready;
    try {
      const layout = () => core.sync(engine.world, 1280, 720, DT);
      const boxOf: BoxOf = (c: UIComponentType) => {
        const corners = core.cornersOf(c);
        return corners ? { points: corners.points.map((p) => [p[0], p[1]] as const), size: corners.size, layoutPoints: corners.layoutPoints.map((p) => [p[0], p[1]] as const) } : null;
      };
      layout();
      const corner = (id: string): [number, number] => {
        const p = boxOf(find(id).component)!.points;
        return [p[2][0], p[2][1]];
      };
      const start = corner("box");
      const before = scene().stack.allStates.length;
      const drag = beginResize(ref("box"), "se", start, boxOf)!;
      expect(drag).not.toBeNull();
      drag.update([start[0] + 10, start[1] + 5]);
      expect(drag.finish()).toBe(true);
      expect(scene().stack.allStates.length).toBe(before + 1);
      await settle();
      layout();
      expect(text()).toContain(`<div id="box" style="height: 25px" width="60"></div>`);
      expect(find("box").as(UIPanel).width).toBe("60");

      // The sections's children flow in a row: dragging the box to the front reorders it in the file.
      const title = boxOf(find("title").component)!.points[0];
      const move = beginMove(ref("box"), corner("box").map((v) => v - 2) as [number, number], boxOf)!;
      expect(move.kind).toBe("reorder");
      move.update([title[0] + 1, title[1] + 1]);
      expect(move.finish()).toBe(true);
      await settle();
      expect(text()).toContain(`<section id="hud" gap="4">\n  <div id="box"`);

      const [v] = viewRows(scene().sync, "hud");
      const each = v.rows[0].children.find((c) => c.label === "span.row")!;
      expect(whyNoHandles(each.ref)).toMatch(/\{#each\}/);
      expect(beginResize(each.ref, "se", [0, 0], boxOf)).toBeNull();
      expect(whyNoHandles(ref("badge"))).toMatch(/child component/);
    } finally {
      core.dispose();
    }
  });
});
