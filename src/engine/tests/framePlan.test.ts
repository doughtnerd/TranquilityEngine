// ADR 0129: the frame plan, a pure function, without a GPU.
import { describe, expect, it } from "vitest";
import { defaultGraphics } from "../core/graphics";
import type { Camera } from "../render/components";
import { planFrame, type FrameCamera, type FrameInput, type Rgb } from "../render/framePlan";
import type { PostSettings } from "../render/postEffects";

const tiers = defaultGraphics().tiers;
const high = tiers.find((t) => t.name === "High")!;
const low = tiers.find((t) => t.name === "Low")!;

const rect = { x: 0, y: 0, width: 1, height: 1 };
const cam = (name: string, over: Partial<FrameCamera> = {}): FrameCamera => ({
  camera: { name } as unknown as Camera,
  depth: 0,
  rect,
  target: "",
  background: null,
  post: null,
  editMode: false,
  ...over,
});
const post = (over: Partial<PostSettings> = {}): PostSettings => ({
  enabled: true, toneMapping: "aces", exposure: 1, bloom: true, bloomIntensity: 1, bloomThreshold: 1, bloomRadius: 1,
  ambientOcclusion: false, aoIntensity: 1, aoRadius: 1, brightness: 0, contrast: 0, saturation: 0, hue: 0,
  vignette: false, vignetteDarkness: 0.5, vignetteOffset: 0.5, depthOfField: true, focusDistance: 10, focusRange: 5, bokehScale: 1,
  chromaticAberration: false, chromaticAberrationAmount: 0, ...over,
});
const CLEAR: Rgb = [0.1, 0.2, 0.3];
const input = (cameras: FrameCamera[], over: Partial<FrameInput> = {}): FrameInput => ({
  cameras, clearColor: CLEAR, skyFog: null, tier: high, sceneView: false, overlay: false, preview: null, ...over,
});
const names = (views: ReturnType<typeof planFrame>) => views.map((v) => (v.camera as unknown as { name: string }).name);
const close = (a: Rgb | null, b: Rgb) => {
  expect(a).not.toBeNull();
  a!.forEach((x, i) => expect(x).toBeCloseTo(b[i], 10));
};

describe("planFrame (ADR 0129)", () => {
  it("plans nothing without a drawing camera, preview included", () => {
    expect(planFrame(input([]))).toEqual([]);
    expect(planFrame(input([cam("e", { editMode: true })]))).toEqual([]);
    const e = cam("e", { editMode: true });
    expect(planFrame(input([e], { preview: { camera: e.camera, rect, aspect: 1, ui: true } }))).toEqual([]);
  });

  it("puts screen UI on the last canvas view and no overlay in play mode", () => {
    const v = planFrame(input([cam("a"), cam("b", { depth: 1 })]));
    expect(v.map((x) => x.ui)).toEqual([null, "screen"]);
    expect(v.every((x) => !x.overlay && !x.editorContent && !x.backdrop)).toBe(true);
  });

  it("puts UI and overlay on view 0 with an overlay", () => {
    const v = planFrame(input([cam("a"), cam("b", { depth: 1 })], { overlay: true }));
    expect(v.map((x) => x.ui)).toEqual(["screen", null]);
    expect(v.map((x) => x.overlay)).toEqual([true, false]);
  });

  it("orders by depth, stable on ties", () => {
    const v = planFrame(input([cam("c", { depth: 2 }), cam("a", { depth: 1 }), cam("b", { depth: 1 }), cam("z", { depth: -1 })]));
    expect(names(v)).toEqual(["z", "a", "b", "c"]);
  });

  it("never draws edit-mode cameras on the canvas, but draws their render textures", () => {
    const v = planFrame(input([cam("e", { editMode: true }), cam("a"), cam("t", { editMode: true, target: "t.rt" })]));
    expect(names(v)).toEqual(["a", "t"]);
    expect(v[1].output).toEqual({ kind: "texture", texture: "t.rt" });
  });

  it("draws texture views after canvas views without editor content or the scene post", () => {
    const v = planFrame(input([cam("t", { target: "x", depth: -5 }), cam("a", { post: post() }), cam("b", { depth: 1 })], { sceneView: true }));
    expect(names(v)).toEqual(["a", "b", "t"]);
    const t = v[2];
    expect(t.editorContent).toBe(false);
    expect(t.backdrop).toBeNull();
    expect(t.ui).toBeNull();
    expect(t.overlay).toBe(false);
    expect(t.clear).toEqual(CLEAR);
    expect(t.post.composer?.bloom ?? null).toBeNull();
    expect(t.post.toneMapping).toBe("none");
  });

  it("scene view: view 0 gets the scene post minus depth of field, later views do not", () => {
    const withPost = cam("p", { editMode: true, post: post() });
    const v = planFrame(input([withPost, cam("a"), cam("b", { depth: 1 })], { sceneView: true }));
    expect(v.map((x) => x.editorContent)).toEqual([true, true]);
    expect(v[0].post.composer?.bloom).not.toBeNull();
    expect(v[0].post.composer?.depthOfField).toBeNull();
    expect(v[0].post.toneMapping).toBe("aces");
    expect(v[1].post.composer?.bloom ?? null).toBeNull();
    expect(v[1].post.toneMapping).toBe("none");
  });

  it("does not use the scene post outside the scene view", () => {
    const v = planFrame(input([cam("a"), cam("p", { depth: 1, post: post() })]));
    expect(v[0].post.toneMapping).toBe("none");
  });

  it("shows a backdrop only on scene-view view 0 without background or post", () => {
    expect(planFrame(input([cam("a")], { sceneView: true }))[0].backdrop).toEqual(CLEAR);
    expect(planFrame(input([cam("a")]))[0].backdrop).toBeNull();
    expect(planFrame(input([cam("a", { background: [1, 0, 0] })], { sceneView: true }))[0].backdrop).toBeNull();
    expect(planFrame(input([cam("a", { post: post() })], { sceneView: true }))[0].backdrop).toBeNull();
    const v = planFrame(input([cam("a"), cam("b", { depth: 1 })], { sceneView: true }));
    expect(v[1].backdrop).toBeNull();
  });

  it("clears only view 0 or cameras with a background", () => {
    const bg: Rgb = [1, 0, 0];
    const v = planFrame(input([cam("a"), cam("b", { depth: 1 }), cam("c", { depth: 2, background: bg })]));
    expect(v.map((x) => x.clear)).toEqual([CLEAR, null, bg]);
  });

  it("tints canvas, texture and preview clear colours with sky fog", () => {
    const skyFog = { color: [1, 1, 1] as Rgb, amount: 0.5 };
    const a = cam("a"), t = cam("t", { target: "x" }), p = cam("p", { editMode: true, background: [0, 0, 0] });
    const v = planFrame(input([a, t, p], { skyFog, preview: { camera: p.camera, rect, aspect: 2, ui: false } }));
    close(v[0].clear, [0.55, 0.6, 0.65]);
    close(v[1].clear, [0.55, 0.6, 0.65]);
    close(v[2].clear, [0.5, 0.5, 0.5]);
  });

  describe("the preview inset", () => {
    const r = { x: 0.7, y: 0.05, width: 0.25, height: 0.25 };
    it("is last and carries its rect, aspect and UI only when asked", () => {
      const p = cam("p", { editMode: true });
      const base = [cam("a"), cam("t", { target: "x" }), p];
      const on = planFrame(input(base, { preview: { camera: p.camera, rect: r, aspect: 1.5, ui: true } }));
      expect(names(on)).toEqual(["a", "t", "p"]);
      expect(on[2].output).toEqual({ kind: "preview", rect: r, aspect: 1.5 });
      expect(on[2].ui).toBe("preview");
      expect(on[2].overlay).toBe(false);
      expect(on[2].editorContent).toBe(false);
      expect(on[2].backdrop).toBeNull();
      const off = planFrame(input(base, { preview: { camera: p.camera, rect: r, aspect: 1.5, ui: false } }));
      expect(off[2].ui).toBeNull();
    });
    it("is skipped when its camera already draws", () => {
      const a = cam("a"), t = cam("t", { target: "x" });
      expect(planFrame(input([a], { preview: { camera: a.camera, rect: r, aspect: 1, ui: true } })).length).toBe(1);
      expect(planFrame(input([a, t], { preview: { camera: t.camera, rect: r, aspect: 1, ui: true } })).length).toBe(2);
    });
    it("is skipped when its camera is not in the list", () => {
      const ghost = { name: "g" } as unknown as Camera;
      expect(planFrame(input([cam("a")], { preview: { camera: ghost, rect: r, aspect: 1, ui: true } })).length).toBe(1);
    });
    it("uses its own post settings", () => {
      const p = cam("p", { editMode: true, post: post() });
      const v = planFrame(input([cam("a"), p], { preview: { camera: p.camera, rect: r, aspect: 1, ui: false } }));
      expect(v[1].post.toneMapping).toBe("aces");
    });
  });

  it("turns post effects off on a tier without post-processing, and does not mutate the input", () => {
    const cameras = [cam("a", { post: post() })];
    const snapshot = JSON.stringify(cameras);
    const v = planFrame(input(cameras, { tier: low }));
    expect(v[0].post.composer).toBeNull();
    expect(JSON.stringify(cameras)).toBe(snapshot);
  });
});
