// ADR 0130: the game UI render feature, on Babylon's NullEngine with a fake host. The GUI needs a 2D
// canvas, so `createCanvas` returns a stub context (as babylonUI.test.ts does). Nothing here needs a GPU.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Layer } from "@babylonjs/core/Layers/layer.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../core/World";
import { Engine, GameObject, Input } from "../index";
import { UIButton, UICanvas, type UILength } from "../ui/components";
import { BabylonUI } from "../render/babylon/ui";
import { BabylonUIFeature, type BabylonUIHost } from "../render/babylon/uiFeature";
import { _registeredRenderFeatures, ownerOf, specNeeded } from "../render/renderFeatures";
import { DomInput } from "./domInput";

/** A plugin's render feature spec, as its activation registered it. */
const registeredSpec = (name: string) => _registeredRenderFeatures().find((f) => f.spec.name === name)!.spec;
const UI_SPEC = registeredSpec("ui");

function fakeCanvas(width: number, height: number) {
  const ctx: Record<string, unknown> = { font: "16px sans-serif", canvas: null };
  for (const m of ["save", "restore", "clearRect", "fillRect", "scale", "translate", "rotate", "beginPath", "closePath", "clip", "fill", "stroke", "fillText", "strokeText", "drawImage", "setTransform", "moveTo", "lineTo", "arc", "rect", "quadraticCurveTo", "arcTo"]) ctx[m] = () => undefined;
  ctx.measureText = (s: string) => ({ width: s.length * 8, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 0 });
  const canvas = { width, height, getContext: () => ctx, style: {}, toDataURL: () => "" };
  ctx.canvas = canvas;
  return canvas;
}

let engine: Engine;
let babylon: NullEngine;
let scene: Scene;
let feature: BabylonUIFeature | null = null;
const state = { interactive: true, rect: null as null | { x: number; top: number; width: number; height: number } };
let frameUI: (() => Layer | null) | null;
let framePreview: (() => Layer | null) | null;

function host(): BabylonUIHost {
  return {
    scene,
    texture: async () => new Texture("data:,", scene, { noMipmap: true }),
    viewCamera: () => null,
    interactive: () => state.interactive,
    previewRect: () => state.rect,
    canvasSize: () => ({ cssW: 1280, cssH: 720, pixelRatio: 1 }),
    setFrameUI: (fn) => void (frameUI = fn),
    setFramePreviewUI: (fn) => void (framePreview = fn),
  };
}

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  babylon = new NullEngine();
  (babylon as unknown as { createCanvas: typeof fakeCanvas }).createCanvas = fakeCanvas;
  scene = new Scene(babylon);
  state.interactive = true;
  state.rect = null;
  frameUI = null;
  framePreview = null;
});

afterEach(() => {
  feature?.dispose();
  feature = null;
  scene.dispose();
  babylon.dispose();
  engine.dispose();
  Input.reset();
  vi.restoreAllMocks();
});

async function make(): Promise<BabylonUIFeature> {
  feature = await BabylonUIFeature.create(host());
  await feature.core().ready;
  return feature;
}

function menu() {
  const canvas = GameObject.create("Canvas").addBehavior(UICanvas);
  const play = GameObject.create("Play", { parent: canvas.node }).addBehavior(UIButton, { width: 200 as UILength, height: 50 as UILength } as never);
  return { canvas, play };
}

describe("BabylonUIFeature", () => {
  it("has a lazy overlay spec that owns UI components, needed once the World has a canvas", () => {
    expect(UI_SPEC).toMatchObject({ name: "ui", phase: "overlay", lazy: true, holdsFirstFrame: true });
    const w = World.require();
    expect(specNeeded(UI_SPEC, w)).toBe(false);
    const { canvas, play } = menu();
    expect(ownerOf([UI_SPEC], canvas)).toBe(0);
    expect(ownerOf([UI_SPEC], play)).toBe(0);
    expect(specNeeded(UI_SPEC, w)).toBe(true);
  });

  it("creates after the bundled font loads, and installs the screen hook", async () => {
    const f = await make();
    expect(f.core()).toBeDefined();
    expect(frameUI).toBeTypeOf("function");
    expect(framePreview).toBeNull();
    expect(f.hasPreviewUI()).toBe(false);
  });

  it("reports what it drew (ADR 0276): a world canvas's plane, left to the UI core's picking, and no screen canvas", async () => {
    const f = await make();
    const { canvas } = menu();
    const world = GameObject.create("Sign").addBehavior(UICanvas, { mode: "world" } as never);
    f.sync(World.require());
    const drawn = [...f.drawn()];
    expect(drawn.map((d) => d.component)).toEqual([world]); // a screen canvas has no shape in the scene
    expect(drawn[0].shape?.kind).toBe("meshes");
    expect(drawn[0].pickable).toBe(false); // the UI core picks canvases (ADR 0117)
    expect(drawn.some((d) => d.component === canvas)).toBe(false);
    world.enabled = false;
    f.sync(World.require());
    expect([...f.drawn()]).toEqual([]);
  });

  it("syncs and lays out a UICanvas with a button", async () => {
    const f = await make();
    const { canvas, play } = menu();
    f.sync(World.require());
    expect(f.core().rectOf(canvas)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(f.core().rectOf(play)).toMatchObject({ width: 200, height: 50 });
  });

  it("applies interactive() on each sync", async () => {
    state.interactive = false;
    const f = await make();
    const { play } = menu();
    f.sync(World.require());
    // A press on Play: not interactive (the editor's scene view, where clicks select), it doesn't press it.
    const dom = DomInput.attach();
    dom.pointerDown(0, 100, 25);
    engine.step(1 / 60);
    expect(play.pressed).toBe(false);
    expect(Input.pointerOverUI).toBe(false);
    dom.pointerUp(0);
    engine.step(1 / 60);
    state.interactive = true;
    f.sync(World.require());
    dom.pointerDown(0);
    engine.step(1 / 60);
    expect(play.pressed).toBe(true);
    expect(play.isActiveAndEnabled).toBe(true);
  });

  it("builds the preview core and hook for a preview rect, and tears them down for null", async () => {
    const f = await make();
    menu();
    state.rect = { x: 0.1, top: 0.1, width: 0.4, height: 0.4 };
    f.sync(World.require());
    expect(f.hasPreviewUI()).toBe(true);
    expect(framePreview).toBeTypeOf("function");
    state.rect = null;
    f.sync(World.require());
    expect(f.hasPreviewUI()).toBe(false);
    expect(framePreview).toBeNull();
    expect(frameUI).toBeTypeOf("function");
  });

  it("releases a UI component from the core and drawing", async () => {
    const f = await make();
    const { canvas } = menu();
    state.rect = { x: 0, top: 0, width: 0.5, height: 0.5 };
    f.sync(World.require());
    expect(f.core().rectOf(canvas)).not.toBeNull();
    const release = vi.spyOn(BabylonUI.prototype, "release");
    f.release(canvas);
    expect(f.core().rectOf(canvas)).toBeNull();
    expect(release).toHaveBeenCalledTimes(2); // the main drawing and the preview's
  });

  it("clears both frame hooks on dispose", async () => {
    const f = await make();
    menu();
    state.rect = { x: 0, top: 0, width: 0.5, height: 0.5 };
    f.sync(World.require());
    expect(frameUI).not.toBeNull();
    expect(framePreview).not.toBeNull();
    f.dispose();
    expect(frameUI).toBeNull();
    expect(framePreview).toBeNull();
    f.sync(World.require()); // a no-op after dispose
  });

  it("warms one world UI canvas item only when the content has world UI", async () => {
    const f = await make();
    expect(f.warm({ meshes: [], effects: [], worldUI: false })).toEqual([]);
    const items = f.warm({ meshes: [], effects: [], worldUI: true });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "worldUI" });
  });
});
