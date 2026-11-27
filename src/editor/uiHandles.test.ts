// Scene-view handles on UI elements (ADR 0077 wave B part 3, on Svelte UI since ADR 0423 wave C): a resize, a move and
// a reorder drag, from the element's real layout (the renderer-neutral UI core, as the Babylon backend lays out), each
// one undo step written to the view's `.svelte` source; Escape putting the file back; refusals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { UIPanel } from "../engine/ui/components";
import { UICore } from "../engine/ui/UICore";
import type { UIHostElement } from "../engine/ui/host/UIHost";
import { UIView } from "../plugins/ui/runtime/UIView";
import { loadProjectCode } from "../plugins/thirdPartyEditor";
import { useEditorPlugins } from "../plugins/testEditorPlugins";
import { uiEditorPlugin } from "../plugins/ui/editor";
import { useCoreAssetKinds } from "./testing";
import { loadSvelteParser } from "./uiEdit/svelteText";
import "./session"; // what reloads the project's code when an edit writes UI code
import type { UIComponentType } from "../engine/ui/components";
import { MemoryFileSystem } from "./memoryFs";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, playState, sceneCamera, status } from "./state";
import { select } from "./inspectorTarget";
import { editorTextFiles } from "./textFiles";
import { beginMove, beginResize, whyNoHandles, type BoxOf } from "./uiHandleDrags";
import { boxMap } from "./uiHandleMath";
import { refOfViewElement, type UIViewRef } from "./uiViews";

const ROOT = "C:\\Games\\handles";
const DT = 1 / 60;

const MENU = `<div id="row" flex-direction="row" gap="10" padding="20" width="100%" height="100%">
  <div id="a" width="50" height="40"></div>
  <div id="b" width="50" height="40"></div>
  <div id="c" width="50" height="40"></div>
  <div id="abs" position="absolute" left="100" top="200" width="25%" height="60"></div>
  <div id="pinned" position="absolute" right="10" bottom="10" width="40" height="40"></div>
  <div id="turned" position="absolute" left="400" top="300" width="100" height="50" rotate="90" translate-x="30"></div>
  <div id="slid" position="absolute" width="40" height="40" translate-x="200"></div>
</div>
`;

const SCENE = {
  format: "myco.scene@1",
  nodes: [
    { id: "cam", name: "Camera", components: [{ type: "engine.Transform" }, { type: "engine.Camera" }] },
    { id: "hud", name: "HUD", components: [{ type: "engine.Transform" }, { type: "engine.UIView", data: { component: "asset:ui/Menu.svelte" } }] },
  ],
};

// The first link loads svelte/compiler and TypeScript: seconds when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

useCoreAssetKinds();
useEditorPlugins([uiEditorPlugin], "each");

let engine: Engine;
let project: EditorProject;
let core: UICore;
/** The viewport's size in CSS pixels; the canvas scale is this over 1280×720. */
let size = [1280, 720];

beforeEach(async () => {
  Input.reset();
  status.value = null;
  size = [1280, 720];
  const fs = new MemoryFileSystem();
  const files: Record<string, string> = { "project.json": JSON.stringify({ name: "Handles" }), "scenes/main.scene.json": JSON.stringify(SCENE, null, 2), "ui/Menu.svelte": MENU };
  for (const [path, text] of Object.entries(files)) fs.files.set(joinPath(ROOT, path), text);
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  await loadSvelteParser();
  expect((await loadProjectCode(project)).problems).toEqual([]);
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
  await view().ready;
  engine.step(DT);
  core = new UICore({ interactive: false });
  await core.ready;
  layout();
});

afterEach(async () => {
  await editorTextFiles.flush();
  core.dispose();
  select([]);
  playState.value = "edit";
  openScene.value?.sync.dispose();
  openScene.value = null;
  currentProject.value = null;
  engine.dispose();
  vi.restoreAllMocks();
});

const scene = () => openScene.value!;
const view = () => scene().sync.nodeFor("hud")!.getComponent(UIView)!;
const el = (id: string): UIHostElement => view().query(`#${id}`)!;
const ref = (id: string): UIViewRef => refOfViewElement(scene().sync, el(id))!;
const text = () => editorTextFiles.read("ui/Menu.svelte")!;
/** The layout as the viewport would have it (the UI core, as on Babylon). */
function layout(): void {
  core.sync(engine.world, size[0], size[1], DT);
}
const boxOf: BoxOf = (c: UIComponentType) => {
  const corners = core.cornersOf(c);
  return corners ? { points: corners.points.map((p) => [p[0], p[1]] as const), size: corners.size, layoutPoints: corners.layoutPoints.map((p) => [p[0], p[1]] as const) } : null;
};
/** The canvas point of an element's box at fractions of its width and height. */
function at(id: string, fx: number, fy: number): [number, number] {
  const p = boxOf(el(id).component)!.points;
  return [p[0][0] + (p[1][0] - p[0][0]) * fx, p[0][1] + (p[3][1] - p[0][1]) * fy];
}
async function settle(): Promise<void> {
  await editorTextFiles.flush();
  await view().ready;
  engine.step(DT);
  layout();
}

describe("resize handles", () => {
  it("a drag is one undo step, the file rewritten as it goes, in UI pixels at the canvas scale", async () => {
    size = [2560, 1440]; // scale 2: two CSS pixels per UI pixel
    layout();
    const stack = scene().stack;
    const before = stack.allStates.length;
    const start = at("a", 1, 1);
    const drag = beginResize(ref("a"), "se", start, boxOf)!;
    expect(drag).not.toBeNull();
    drag.update([start[0] + 20, start[1] + 10]);
    expect(text()).toContain(`<div id="a" width="60" height="45"></div>`);
    drag.update([start[0] + 60, start[1] + 20]);
    expect(text()).toContain(`<div id="a" width="80" height="50"></div>`);
    expect(drag.finish()).toBe(true);
    expect(stack.allStates.length).toBe(before + 1);
    expect(stack.undoLabel).toBe("Resize div#a");
    await settle();
    expect((el("a").component as UIPanel).width).toBe("80");
    expect(boxOf(el("a").component)!.size).toEqual([80, 50]);
    expect(stack.undo()).toBe(true);
    await settle();
    expect(text()).toBe(MENU);
  });

  it("keeps a percentage width a percentage, and moves left with the west edge", async () => {
    const start = at("abs", 0, 0.5);
    const drag = beginResize(ref("abs"), "w", start, boxOf)!;
    drag.update([start[0] - 32, start[1]]); // 25% of the parent's 1280-wide padding box is 320; 32 more is 352
    drag.finish();
    expect(text()).toContain(`<div id="abs" position="absolute" left="68" top="200" width="27.5%" height="60"></div>`);
  });

  it("Escape puts the file back and records nothing", async () => {
    const stack = scene().stack;
    const before = stack.allStates.length;
    const start = at("b", 1, 0.5);
    const drag = beginResize(ref("b"), "e", start, boxOf)!;
    drag.update([start[0] + 30, start[1]]);
    expect(text()).not.toBe(MENU);
    drag.cancel();
    expect(text()).toBe(MENU);
    expect(stack.allStates.length).toBe(before);
  });
});

describe("moving", () => {
  it("moves an absolute element by its left/top, or by right/bottom when those place it", async () => {
    const drag = beginMove(ref("abs"), at("abs", 0.5, 0.5), boxOf)!;
    expect(drag.kind).toBe("move");
    const [x, y] = at("abs", 0.5, 0.5);
    drag.update([x + 15, y - 50]);
    drag.finish();
    expect(text()).toContain(`<div id="abs" position="absolute" left="115" top="150"`);
    expect(scene().stack.undoLabel).toBe("Move div#abs");

    const pin = beginMove(ref("pinned"), at("pinned", 0.5, 0.5), boxOf)!;
    const [px, py] = at("pinned", 0.5, 0.5);
    pin.update([px - 5, py - 5]);
    pin.finish();
    expect(text()).toContain(`<div id="pinned" position="absolute" right="15" bottom="15"`);
  });

  it("reorders an element in flex flow among its siblings, as one move on release", async () => {
    const drag = beginMove(ref("a"), at("a", 0.5, 0.5), boxOf)!;
    expect(drag.kind).toBe("reorder");
    drag.update(at("b", 0.4, 0.5)); // still where it is: no marker
    expect(drag.marker()).toBeNull();
    drag.update(at("c", 0.9, 0.5)); // past c's middle: after c
    const marker = drag.marker()!;
    expect(marker[0][0]).toBeCloseTo(at("c", 1, 0)[0]);
    expect(marker[0][1]).toBe(20); // across the parent's content box (inside its padding)
    expect(marker[1][1]).toBe(700);
    expect(text()).toBe(MENU); // nothing written until release
    expect(drag.finish()).toBe(true);
    await settle();
    expect(text()).toMatch(/id="b"[^]*id="c"[^]*id="a"[^]*id="abs"/);
    expect(scene().stack.undoLabel).toBe("Move #a");
  });
});

describe("transformed elements (ADR 0422 wave 3)", () => {
  it("puts the handles on the box as drawn, and resizes in its own frame without moving left/top", async () => {
    const box = boxOf(el("turned").component)!;
    const map = boxMap(box)!;
    // Turned a quarter: its west edge's middle is at the top as drawn.
    const west = map.toCanvas([0, 25]);
    expect(west[0]).toBeCloseTo(400 + 30 + 50, 6);
    expect(west[1]).toBeCloseTo(325 - 50, 6);
    const drag = beginResize(ref("turned"), "w", west, boxOf)!;
    drag.update([west[0], west[1] - 20]); // outward along the turned box's own x axis
    drag.finish();
    expect(text()).toContain(`<div id="turned" position="absolute" left="400" top="300" width="120" height="50"`);
  });

  it("moves in the parent's frame, from where layout put the element, not where its transform draws it", async () => {
    const [x, y] = boxMap(boxOf(el("turned").component)!)!.toCanvas([50, 25]);
    const drag = beginMove(ref("turned"), [x, y], boxOf)!;
    drag.update([x + 15, y - 50]);
    drag.finish();
    expect(text()).toContain(`<div id="turned" position="absolute" left="415" top="250"`);

    const laid = core.cornersOf(el("slid").component)!.layoutPoints[0];
    const [sx, sy] = boxMap(boxOf(el("slid").component)!)!.toCanvas([20, 20]);
    const slide = beginMove(ref("slid"), [sx, sy], boxOf)!;
    slide.update([sx + 10, sy]);
    slide.finish();
    expect(text()).toContain(`<div id="slid" position="absolute" width="40" height="40" translate-x="200" left="${laid[0] + 10}"`);
  });
});

describe("refusals", () => {
  it("shows no handles in read-only projects or in play mode", async () => {
    expect(whyNoHandles(ref("a"))).toBeNull();
    playState.value = "playing";
    expect(whyNoHandles(ref("a"))).toMatch(/stop playing/);
    expect(beginResize(ref("a"), "se", at("a", 1, 1), boxOf)).toBeNull();
    expect(beginMove(ref("a"), at("a", 0.5, 0.5), boxOf)).toBeNull();
    playState.value = "edit";
    currentProject.value = Object.create(project, { canSave: { value: false } }) as EditorProject;
    expect(whyNoHandles(ref("a"))).toMatch(/read-only/);
    expect(beginResize(ref("a"), "se", at("a", 1, 1), boxOf)).toBeNull();
    expect(text()).toBe(MENU);
  });
});
