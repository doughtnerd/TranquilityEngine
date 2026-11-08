// ADR 0129 part 3: the editor viewport handle sets renderer policy through the RenderPolicyPort,
// live before the editor tools load; the adapter gets only the editor-tool state.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject } from "../index";
import { ViewportHandle } from "../render/editorViewport";
import { FakeRenderPolicyPort, FakeViewportAdapter } from "../render/fakeViewport";
import { GAME_POLICY } from "../render/renderPolicy";

function setup(eager: boolean) {
  const port = new FakeRenderPolicyPort();
  const adapter = new FakeViewportAdapter();
  let loaded = false;
  const handle = new ViewportHandle(() => (loaded ? adapter : null), port, eager);
  return { port, adapter, handle, load: () => (loaded = true) };
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
    const { port, adapter, handle, load } = setup(true);
    const camera = { node: GameObject.create("cam") } as never;
    const frame = {} as HTMLElement;
    handle.setCameraPreview(camera, frame);
    expect(port.policy.cameraPreview).toEqual({ camera, frame });
    handle.setCameraPreview(camera, null);
    expect(port.policy.cameraPreview).toBeNull();
    handle.setCameraPreview(null, frame);
    expect(port.policy.cameraPreview).toBeNull();
    handle.setParticlePreview({ playing: false });
    handle.setParticlePreview({ speed: 3 });
    handle.restartParticlePreview();
    expect(port.particlePreview).toEqual({ playing: false, speed: 3 });
    expect(port.restarts).toBe(1);
    expect(handle.ready).toBe(false);
    load();
    handle.poll();
    expect(handle.ready).toBe(true);
    expect(adapter.calls).toEqual(["setSelection", "setOverlay"]); // no preview replay
  });
});
