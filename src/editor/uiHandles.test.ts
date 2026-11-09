// Scene-view handles on UI document elements (ADR 0077 wave B part 3): a resize, a move and a
// reorder drag, from the element's real layout (the renderer-neutral UI core, as the Babylon backend
// lays out), each one undo step written to the markup; Escape putting the file back; refusals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { UIPanel } from "../engine/ui/components";
import { loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { UICore } from "../engine/ui/UICore";
import type { UIComponentType } from "../engine/ui/components";
import { MemoryFileSystem } from "./memoryFs";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, playState, sceneCamera, status } from "./state";
import { editorTextFiles } from "./textFiles";
import { beginMove, beginResize, whyNoHandles, type BoxOf } from "./uiHandles";
import { resolveUIElement, type UIElementRef } from "./uiDocuments";
import { select } from "./inspectorTarget";

const ROOT = "C:\\Games\\handles";
const DT = 1 / 60;

const MENU = `<Canvas>
  <Panel id="row" flex-direction="row" gap="10" padding="20" width="100%" height="100%">
    <Panel id="a" width="50" height="40"/>
    <Panel id="b" width="50" height="40"/>
    <Panel id="c" width="50" height="40"/>
    <Panel id="abs" position="absolute" left="100" top="200" width="25%" height="60"/>
    <Panel id="pinned" position="absolute" right="10" bottom="10" width="40" height="40"/>
  </Panel>
</Canvas>
`;

const SCENE = {
  format: "myco.scene@1",
  nodes: [
    { id: "cam", name: "Camera", components: [{ type: "engine.Transform" }, { type: "engine.Camera" }] },
    { id: "hud", name: "HUD", components: [{ type: "engine.Transform" }, { type: "engine.UIDocument", data: { document: "asset:ui/menu.ui.xml" } }] },
  ],
};

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
  const files: Record<string, string> = { "project.json": JSON.stringify({ name: "Handles" }), "scenes/main.scene.json": JSON.stringify(SCENE, null, 2), "ui/menu.ui.xml": MENU };
  for (const [path, text] of Object.entries(files)) fs.files.set(joinPath(ROOT, path), text);
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  await loadUIDocumentSupport();
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
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
const ref = (id: string): UIElementRef => ({ host: "hud", index: 0, path: id === "row" ? "/#row" : `/#row/#${id}` });
const el = (id: string) => resolveUIElement(scene().sync, ref(id))!;
const text = () => editorTextFiles.read("ui/menu.ui.xml")!;
/** The layout as the viewport would have it (the UI core, as on Babylon). */
function layout(): void {
  core.sync(engine.world, size[0], size[1], DT);
}
const boxOf: BoxOf = (c: UIComponentType) => {
  const corners = core.cornersOf(c);
  return corners ? { points: corners.points.map((p) => [p[0], p[1]] as const), size: corners.size } : null;
};
/** The canvas point of an element's box at fractions of its width and height. */
function at(id: string, fx: number, fy: number): [number, number] {
  const p = boxOf(el(id).component)!.points;
  return [p[0][0] + (p[1][0] - p[0][0]) * fx, p[0][1] + (p[3][1] - p[0][1]) * fy];
}
async function settle(): Promise<void> {
  await editorTextFiles.flush();
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
    expect(text()).toContain(`<Panel id="a" width="60" height="45"/>`);
    drag.update([start[0] + 60, start[1] + 20]);
    expect(text()).toContain(`<Panel id="a" width="80" height="50"/>`);
    expect(drag.finish()).toBe(true);
    expect(stack.allStates.length).toBe(before + 1);
    expect(stack.undoLabel).toBe("Resize Panel#a");
    await settle();
    expect(el("a").as(UIPanel).width).toBe("80");
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
    expect(text()).toContain(`<Panel id="abs" position="absolute" left="68" top="200" width="27.5%" height="60"/>`);
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
    expect(text()).toContain(`<Panel id="abs" position="absolute" left="115" top="150"`);
    expect(scene().stack.undoLabel).toBe("Move Panel#abs");

    const pin = beginMove(ref("pinned"), at("pinned", 0.5, 0.5), boxOf)!;
    const [px, py] = at("pinned", 0.5, 0.5);
    pin.update([px - 5, py - 5]);
    pin.finish();
    expect(text()).toContain(`<Panel id="pinned" position="absolute" right="15" bottom="15"`);
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

describe("refusals", () => {
  it("shows no handles in read-only projects, in play mode, or on the root", async () => {
    expect(whyNoHandles(el("a"))).toBeNull();
    expect(whyNoHandles(resolveUIElement(scene().sync, { host: "hud", index: 0, path: "" })!)).toMatch(/root/);
    playState.value = "playing";
    expect(whyNoHandles(el("a"))).toMatch(/stop playing/);
    expect(beginResize(ref("a"), "se", at("a", 1, 1), boxOf)).toBeNull();
    expect(beginMove(ref("a"), at("a", 0.5, 0.5), boxOf)).toBeNull();
    playState.value = "edit";
    currentProject.value = Object.create(project, { canSave: { value: false } }) as EditorProject;
    expect(whyNoHandles(el("a"))).toMatch(/read-only/);
    expect(beginResize(ref("a"), "se", at("a", 1, 1), boxOf)).toBeNull();
    expect(text()).toBe(MENU);
  });
});
