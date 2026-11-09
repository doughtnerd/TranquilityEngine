// ADR 0128: the editor viewport handle (lazy loading, state hand-over, derived queries) over the
// in-memory fake adapter, and `viewport(world)` from the editor API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { renderDiagnostics, viewport } from "../editor";
import { Assets, Engine, GameObject, SceneManager, Vector2 } from "../index";
import { SpriteRenderer } from "../render/components";
import { FakeRenderPolicyPort, FakeRenderSurface, FakeViewportAdapter } from "../render/fakeViewport";
import { ViewportHandle } from "../render/editorViewport";

const COLORS = { background: 1, grid: 2, gridCenter: 3, outline: 4, cameraGizmo: 5 };

describe("the editor viewport handle (ADR 0128)", () => {
  let engine: Engine;
  let adapter: FakeViewportAdapter;
  let loaded: boolean;
  let connects: number;
  let handle: ViewportHandle;
  let port: FakeRenderPolicyPort;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    adapter = new FakeViewportAdapter();
    loaded = false;
    connects = 0;
    port = new FakeRenderPolicyPort();
    handle = new ViewportHandle(() => (connects++, loaded ? adapter : null), port);
  });
  afterEach(() => engine.dispose());

  it("answers nothing until the tools load, without losing the state set meanwhile", async () => {
    const a = GameObject.create("a");
    adapter.rects.set(a, { left: 0, top: 0, right: 800, bottom: 600 });
    handle.setSelection([a]);
    expect(handle.ready).toBe(false);
    expect(handle.pick(10, 10)).toEqual([]);
    expect(handle.rayAt(10, 10)).toBeNull();
    expect(handle.grid()).toBeNull();
    expect(handle.drawn()).toEqual({ segments: 0, handles: 0, outlines: 0, drawnObjects: 0, lightWires: 0, cameraPreview: false });
    await expect(handle.bakeReflectionProbe({} as never)).rejects.toThrow(/hasn't started/);
    expect(adapter.calls).toEqual([]);
    loaded = true;
    expect(handle.pick(10, 10)).toEqual([a]);
    expect(adapter.selection).toEqual([a]);
  });

  it("hands every piece of state over exactly once, in order, when the tools arrive", () => {
    const a = GameObject.create("a");
    const handlers = { onStart() {}, onChange() {}, onEnd() {} };
    handle.setColors(COLORS);
    handle.setGrid({ plane: "xy" });
    handle.setGrid({ cellSize: 0.5 });
    handle.setSelection([a]);
    handle.setSelectionShown(false);
    handle.setOverlay(() => ({ lines: [], handles: [] }));
    handle.setGizmo([a], { mode: "rotate", planar: true, snap: false }, handlers);
    loaded = true;
    handle.poll();
    expect(adapter.calls).toEqual(["setColors", "setGrid", "setSelection", "setOverlay", "setGizmo"]);
    expect(adapter.gridState).toEqual({ plane: "xy", cellSize: 0.5, visible: true });
    expect(adapter.selectionShown).toBe(false);
    expect(adapter.gizmo).toMatchObject({ nodes: [a], options: { mode: "rotate" }, handlers });
    handle.poll();
    handle.pick(0, 0);
    expect(adapter.calls).toHaveLength(5); // no second replay
    handle.setGrid({ visible: false }); // later calls go straight through, merged with what was set
    expect(adapter.gridState).toEqual({ plane: "xy", cellSize: 0.5, visible: false });
    expect(handle.grid()).toEqual({ plane: "xy", cellSize: 0.5, visible: false, divisions: 100 });
  });

  it("only tries to connect once something wants it, unless eager", () => {
    handle.poll();
    expect(connects).toBe(0); // a game World nobody asked about never loads the tools
    handle.pick(0, 0);
    handle.poll();
    expect(connects).toBe(2);
    const eager = new ViewportHandle(() => (connects++, null), new FakeRenderPolicyPort(), true);
    eager.poll();
    expect(connects).toBe(3);
  });

  it("derives plane hits, overlay handle picking and UI boxes from the adapter's ray and projection", () => {
    loaded = true;
    // The fake's camera: 100 px per metre, origin at the canvas centre (400, 300), looking down -Z.
    expect(handle.pointOnPlane(500, 200, [0, 0, 1], [0, 0, 2])).toEqual([1, 1, 2]);
    expect(handle.pointOnPlane(500, 200, [1, 0, 0], [0, 0, 0])).toBeNull(); // parallel to the ray
    handle.setOverlay(() => ({ lines: [], handles: [{ id: "a", position: [0, 0, 0], color: 0 }, { id: "b", position: [0.05, 0, 0], color: 0 }] }));
    expect(handle.overlayHandles()).toEqual([{ id: "a", x: 400, y: 300 }, { id: "b", x: 405, y: 300 }]);
    expect(handle.pickOverlayHandle(404, 300)).toBe("b");
    expect(handle.pickOverlayHandle(420, 300)).toBeNull();
    expect(handle.pickOverlayHandle(420, 300, 20)).toBe("b");
    adapter.uiCore = {
      pickAll: () => [],
      pickCanvases: () => [],
      cornersOf: (c) => (c === ("screen" as never) ? { space: "screen", points: [[1, 2], [3, 2], [3, 4], [1, 4]], size: [2, 2] } : { space: "world", points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], size: [64, 64] }) as never,
    };
    expect(handle.uiElementBox("screen" as never)).toEqual({ points: [[1, 2], [3, 2], [3, 4], [1, 4]], size: [2, 2] });
    expect(handle.uiElementBox("world" as never)).toEqual({ points: [[400, 300], [500, 300], [500, 200], [400, 200]], size: [64, 64] });
  });

  it("answers a sprite's size from its own size field before asking the renderer", () => {
    loaded = true;
    const node = GameObject.create("s");
    const sprite = node.addBehavior(SpriteRenderer, {});
    expect(handle.spriteSize(node)).toBeNull();
    adapter.spriteSizes.set(sprite, [2, 3]);
    expect(handle.spriteSize(node)).toEqual([2, 3]);
    sprite.size = new Vector2(5, 6);
    expect(handle.spriteSize(node)).toEqual([5, 6]);
  });
});

describe("viewport(world) and renderDiagnostics(world) (ADR 0128)", () => {
  let engine: Engine;
  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
  });
  afterEach(() => engine.dispose());

  it("gives a headless World a viewport that keeps state and answers nothing, and no diagnostics", () => {
    const world = World.require();
    expect(viewport(world)).toBe(viewport(world));
    viewport(world).setSelection([world.root]);
    expect(viewport(world).pick(0, 0)).toEqual([]);
    expect(viewport(world).ready).toBe(false);
    expect(renderDiagnostics(world)).toBeNull();
  });

  it("asks a World's render surface for its viewport and diagnostics", () => {
    const world = World.require();
    const surface = new FakeRenderSurface({ loaded: false });
    world.render = surface;
    viewport(world).setColors(COLORS);
    expect(surface.adapter.colors).toBeNull();
    surface.loaded = true;
    surface.sync(world); // the surface's frame hands the state over
    expect(surface.adapter.colors).toEqual(COLORS);
    surface.diagnosticsSnapshot = { features: { water: { surfaces: 2 } } };
    expect(renderDiagnostics(world)?.features.water).toEqual({ surfaces: 2 });
    world.render = null;
  });
});
