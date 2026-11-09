// ADR 0129 part 3: the editor viewport handle sets renderer policy through the RenderPolicyPort,
// live before the editor tools load; the adapter gets only the editor-tool state.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject } from "../index";
import { ViewportHandle } from "../render/editorViewport";
import { FakeRenderPolicyPort, FakeViewportAdapter } from "../render/fakeViewport";
import { GAME_POLICY, previewInset, type ClientRect } from "../render/renderPolicy";

/** A canvas 800 x 400 at (100, 50) on the page, as the surface measures it. */
const CANVAS: ClientRect = { left: 100, top: 50, width: 800, height: 400 };

function setup(eager: boolean) {
  const port = new FakeRenderPolicyPort();
  const adapter = new FakeViewportAdapter();
  let loaded = false;
  /** Where each frame element lies on the page (what `getBoundingClientRect` would say), and how often it was measured. */
  const layout = new Map<HTMLElement, ClientRect>();
  const measured = { count: 0 };
  const measure = (frame: HTMLElement) => (measured.count++, previewInset(CANVAS, layout.get(frame) ?? { left: 0, top: 0, width: 0, height: 0 }));
  const handle = new ViewportHandle(() => (loaded ? adapter : null), port, eager, measure);
  return { port, adapter, handle, layout, measured, load: () => (loaded = true) };
}

describe("viewport handle render policy (ADR 0129)", () => {
  let engine: Engine;
  beforeEach(async () => {
    engine = await Engine.create({ headless: true });
  });
  afterEach(() => engine.dispose());

  it("an eager handle sets the scene view policy at construction, before any adapter connects", () => {
    const { port, adapter } = setup(true);
    expect(port.calls).toEqual(["setPolicy"]);
    expect(port.policy).toMatchObject({ sceneView: true, drawPolicy: "perObject" });
    expect(port.policy.particlePreview).not.toBeNull();
    expect(adapter.calls).toEqual([]);
  });

  it("a non-eager handle sets nothing at construction and perObject once, on first use", () => {
    const { port, handle } = setup(false);
    expect(port.calls).toEqual([]);
    expect(port.policy).toEqual({ ...GAME_POLICY });
    handle.setSelectionShown(true);
    handle.pick(0, 0);
    handle.grid();
    expect(port.calls).toEqual(["setPolicy"]);
    expect(port.policy).toMatchObject({ sceneView: false, drawPolicy: "perObject" });
  });

  it("an eager handle does not set perObject a second time on first use", () => {
    const { port, handle } = setup(true);
    handle.pick(0, 0);
    handle.setColors({ background: 1, grid: 2, gridCenter: 3, outline: 4, cameraGizmo: 5 });
    expect(port.calls).toEqual(["setPolicy"]);
  });

  it("the particle preview's selected predicate follows later setSelection calls", () => {
    const { port, handle } = setup(true);
    const a = GameObject.create("a"), b = GameObject.create("b");
    const selected = port.policy.particlePreview!.selected;
    expect(selected(a)).toBe(false);
    handle.setSelection([a]);
    expect(selected(a)).toBe(true);
    expect(selected(b)).toBe(false);
    handle.setSelection([b]);
    expect(selected(a)).toBe(false);
    expect(selected(b)).toBe(true);
    expect(port.calls).toEqual(["setPolicy"]);
  });

  it("camera and particle previews reach the port while the adapter is still null, and never the adapter", () => {
    const { port, adapter, handle, layout, load } = setup(true);
    const camera = { node: GameObject.create("cam") } as never;
    const frame = {} as HTMLElement;
    layout.set(frame, { left: 700, top: 250, width: 160, height: 90 });
    handle.setCameraPreview(camera, frame);
    expect(port.policy.cameraPreview).toEqual({ camera, inset: { x: 0.75, top: 0.5, width: 0.2, height: 0.225, aspect: 160 / 90 } });
    handle.setCameraPreview(camera, null);
    expect(port.policy.cameraPreview).toBeNull();
    handle.setCameraPreview(null, frame);
    expect(port.policy.cameraPreview).toBeNull();
    handle.setParticlePreview({ playing: false });
    handle.setParticlePreview({ speed: 3 });
    handle.restartParticlePreview();
    // ADR 0154: the playback and restarts are render policy, the one route to the renderer.
    expect(port.policy.particlePreview).toMatchObject({ playing: false, speed: 3, simulateAll: false, restarts: 1 });
    expect(handle.ready).toBe(false);
    load();
    handle.poll();
    expect(handle.ready).toBe(true);
    expect(adapter.calls).toEqual(["setSelection", "setOverlay"]); // no preview replay
  });

  it("measures the camera preview's frame once a frame and hands the policy its inset only when it changes (ADR 0163)", () => {
    const { port, handle, layout, measured } = setup(true);
    const camera = { node: GameObject.create("cam") } as never;
    const frame = {} as HTMLElement;
    handle.measurePreview(); // no preview: nothing measured or set
    expect(measured.count).toBe(0);
    handle.setCameraPreview(camera, frame); // not laid out yet: nothing to draw
    expect(port.policy.cameraPreview).toBeNull();
    const calls = port.calls.length;
    layout.set(frame, { left: 100, top: 50, width: 200, height: 100 });
    handle.measurePreview();
    expect(port.policy.cameraPreview?.inset).toEqual({ x: 0, top: 0, width: 0.25, height: 0.25, aspect: 2 });
    handle.measurePreview(); // unchanged: the policy isn't touched
    expect(port.calls.length).toBe(calls + 1);
    layout.set(frame, { left: 500, top: 50, width: 200, height: 100 }); // the panel moved it
    handle.measurePreview();
    expect(port.policy.cameraPreview?.inset.x).toBe(0.5);
    layout.delete(frame); // collapsed
    handle.measurePreview();
    expect(port.policy.cameraPreview).toBeNull();
    expect(measured.count).toBe(5);
  });

  it("a headless handle (no measurer) never draws a camera preview", () => {
    const port = new FakeRenderPolicyPort();
    const handle = new ViewportHandle(() => null, port);
    handle.setCameraPreview({ node: GameObject.create("cam") } as never, {} as HTMLElement);
    handle.measurePreview();
    expect(port.policy.cameraPreview).toBeNull();
    expect(port.calls).toEqual([]);
  });

  it("a non-eager handle keeps the particle playback without turning preview mode on (game rules)", () => {
    const { port, handle } = setup(false);
    handle.setParticlePreview({ simulateAll: true });
    handle.restartParticlePreview();
    expect(port.calls).toEqual([]);
    expect(port.policy.particlePreview).toBeNull();
  });
});

describe("the camera preview inset (ADR 0163)", () => {
  it("is the frame's place on the canvas in fractions from its top-left, clamped to it", () => {
    expect(previewInset(CANVAS, { left: 500, top: 250, width: 400, height: 200 })).toEqual({ x: 0.5, top: 0.5, width: 0.5, height: 0.5, aspect: 2 });
    // Hanging off the right and bottom edges: cut at the canvas, the aspect still the frame's own.
    const cut = previewInset(CANVAS, { left: 820, top: 370, width: 160, height: 90 })!;
    expect([cut.x, cut.top, cut.aspect]).toEqual([0.9, 0.8, 160 / 90]);
    expect(cut.width).toBeCloseTo(0.1);
    expect(cut.height).toBeCloseTo(0.2);
  });

  it("is nothing for a frame under 2 px, a canvas not laid out, or a frame off the canvas", () => {
    expect(previewInset(CANVAS, { left: 200, top: 100, width: 1, height: 50 })).toBeNull();
    expect(previewInset({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 100, height: 50 })).toBeNull();
    expect(previewInset(CANVAS, { left: 1000, top: 100, width: 100, height: 50 })).toBeNull();
  });
});
