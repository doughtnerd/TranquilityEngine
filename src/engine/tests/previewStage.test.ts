// ADR 0300: the preview stage every Babylon preview draws on, run headless on Babylon's NullEngine: start-up and the
// preview disposed while its engine starts, the default light rig, the orbit camera turned by dragging (released on
// pointerup, pointercancel or lostpointercapture) and zoomed by the wheel, the loop, and GPU context loss.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewStage, type PreviewStageOptions } from "../render/babylon/previews/previewStage";

/** The engine factory (ADR 0244) hands out NullEngines when a test lets it (`arrive`), or fails (`fail`). */
const factory = vi.hoisted(() => ({ pending: [] as { resolve: (e: unknown) => void; reject: (err: unknown) => void }[] }));
vi.mock("../render/babylon/createEngine", () => ({
  createEngine: () => new Promise((resolve, reject) => factory.pending.push({ resolve, reject })),
}));
const arrive = (): NullEngine => {
  const engine = new NullEngine();
  factory.pending.shift()!.resolve(engine);
  return engine;
};

/** A canvas stand-in: pointer events, and a size so the loop draws. */
function fakeCanvas(): HTMLCanvasElement {
  return Object.assign(new EventTarget(), { style: {}, isConnected: true, clientWidth: 200, clientHeight: 100, setPointerCapture() {}, remove() {} }) as unknown as HTMLCanvasElement;
}
const pointer = (type: string, x: number, y: number) => Object.assign(new Event(type), { button: 0, clientX: x, clientY: y, pointerId: 1 });

const ORBIT: PreviewStageOptions["orbit"] = { fov: 40, near: 0.1, far: 100, target: [0, 1, 0], start: { yaw: 0, pitch: 0, distance: 5 }, minDistance: 1, maxDistance: 10 };

describe("the preview stage (ADR 0300)", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    factory.pending = [];
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => (frames = []));
  });
  afterEach(() => vi.unstubAllGlobals());
  /** Run the frames asked for so far, at `now`. */
  const runFrames = (now: number) => frames.splice(0).forEach((f) => f(now));

  it("disposes an engine that arrives after the preview went, and never comes up", async () => {
    const onUp = vi.fn();
    const stage = new PreviewStage(fakeCanvas(), { onUp, frame: () => undefined });
    stage.dispose();
    const engine = arrive();
    expect(await stage.ready).toBe(false);
    expect(engine.isDisposed).toBe(true);
    expect(onUp).not.toHaveBeenCalled();
    expect(stage.engine).toBeNull();
    expect(frames).toHaveLength(0);
  });

  it("warns once under the preview's name when no engine starts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stage = new PreviewStage(fakeCanvas(), { name: "test preview" });
    factory.pending.shift()!.reject(new Error("no GPU"));
    expect(await stage.ready).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("test preview couldn't start");
    warn.mockRestore();
  });

  it("comes up with a scene lit by the default rig and a camera on its orbit, before the first frame", async () => {
    const order: string[] = [];
    const stage = new PreviewStage(fakeCanvas(), { orbit: ORBIT, onUp: (s) => order.push(`up:${!!s.scene}`), frame: () => order.push("frame") });
    const engine = arrive();
    expect(await stage.ready).toBe(true);
    expect(stage.engine).toBe(engine);
    expect(stage.scene!.lights.map((l) => l.getClassName()).sort()).toEqual(["DirectionalLight", "HemisphericLight"]); // ADR 0277
    expect(stage.scene!.activeCamera).toBe(stage.camera);
    runFrames(16);
    expect(order).toEqual(["up:true", "frame"]);
    stage.draw();
    // Yaw 0 is in front of the target, on +Z (thumbnailMath's orbit).
    expect(stage.camera!.position.asArray().map((v) => +v.toFixed(5))).toEqual([0, 1, 5]);
    stage.dispose();
    expect(engine.isDisposed).toBe(true);
  });

  it("makes an unlit scene, or none, when asked", async () => {
    const unlit = new PreviewStage(fakeCanvas(), { scene: "unlit" });
    arrive();
    await unlit.ready;
    expect(unlit.scene!.lights).toHaveLength(0);
    expect(unlit.camera).toBeNull();
    const bare = new PreviewStage(fakeCanvas(), { scene: "none" });
    arrive();
    expect(await bare.ready).toBe(true);
    expect(bare.scene).toBeNull();
    unlit.dispose();
    bare.dispose();
  });

  it("turns the camera with a drag (right: toward +X) and lets go on pointercancel or lostpointercapture", async () => {
    const canvas = fakeCanvas();
    const stage = new PreviewStage(canvas, { orbit: ORBIT });
    arrive();
    await stage.ready;
    const x = () => {
      stage.draw();
      return stage.camera!.position.x;
    };
    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    canvas.dispatchEvent(pointer("pointermove", 30, 0));
    const turned = x();
    expect(turned).toBeGreaterThan(0);
    for (const end of ["pointercancel", "lostpointercapture", "pointerup"]) {
      canvas.dispatchEvent(pointer("pointerdown", 0, 0));
      canvas.dispatchEvent(pointer(end, 0, 0));
      const before = x();
      canvas.dispatchEvent(pointer("pointermove", 80, 0)); // no longer dragging
      expect(x()).toBe(before);
    }
    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    canvas.dispatchEvent(pointer("pointermove", 0, 40)); // down: the camera rises
    stage.draw();
    expect(stage.camera!.position.y).toBeGreaterThan(1);
    stage.dispose();
  });

  it("zooms with the wheel within its limits, and has no wheel without them", async () => {
    const canvas = fakeCanvas();
    const stage = new PreviewStage(canvas, { orbit: ORBIT });
    arrive();
    await stage.ready;
    const distance = () => {
      stage.draw();
      const p = stage.camera!.position;
      return Math.hypot(p.x, p.y - 1, p.z); // from the target
    };
    const wheel = (deltaY: number) => canvas.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { deltaY }));
    wheel(1e5);
    expect(distance()).toBeCloseTo(10);
    wheel(-1e5);
    expect(distance()).toBeCloseTo(1);
    stage.dispose();

    const fixedCanvas = fakeCanvas();
    const fixed = new PreviewStage(fixedCanvas, { orbit: { ...ORBIT, minDistance: undefined, maxDistance: undefined } });
    arrive();
    await fixed.ready;
    fixedCanvas.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { deltaY: 1e5 }));
    fixed.draw();
    expect(fixed.camera!.position.z).toBeCloseTo(5);
    fixed.dispose();
  });

  it("skips frames while the canvas is hidden, and reports the seconds since the last (at most 0.1)", async () => {
    const canvas = fakeCanvas();
    const steps: number[] = [];
    const stage = new PreviewStage(canvas, { frame: (dt) => steps.push(dt) });
    arrive();
    await stage.ready;
    const start = performance.now();
    runFrames(start + 16);
    (canvas as { clientWidth: number }).clientWidth = 0;
    runFrames(start + 32);
    (canvas as { clientWidth: number }).clientWidth = 200;
    runFrames(start + 2000);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBeCloseTo(0.016, 2);
    expect(steps[1]).toBe(0.1);
    stage.dispose();
  });

  it("pauses on a lost GPU context, tells its listeners once, and resumes when it comes back", async () => {
    const steps: number[] = [];
    const stage = new PreviewStage(fakeCanvas(), { frame: (dt) => steps.push(dt) });
    const engine = arrive();
    await stage.ready;
    const lost = vi.fn();
    stage.onContextLost(lost);
    engine.onContextLostObservable.notifyObservers(engine);
    expect(stage.lost).toBe(true);
    expect(lost).toHaveBeenCalledTimes(1);
    runFrames(16);
    expect(steps).toHaveLength(0);
    const late = vi.fn();
    stage.onContextLost(late); // lost now: at once
    expect(late).toHaveBeenCalledTimes(1);
    engine.onContextRestoredObservable.notifyObservers(engine);
    expect(stage.lost).toBe(false);
    runFrames(performance.now() + 16);
    expect(steps).toHaveLength(1);
    expect(lost).toHaveBeenCalledTimes(1);
    stage.dispose();
  });
});
