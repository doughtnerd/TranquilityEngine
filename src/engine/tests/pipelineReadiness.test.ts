// ADR 0163: pipeline readiness (ADR 0080's warm-up rules and ADR 0120's held first frames) through the
// calls the renderer makes around a frame. No WebGPU in Node: the engine is a stand-in with the pipeline
// cache members `AsyncPipelines` reads (a draw whose pipeline is missing is skipped while it compiles), and
// the warmer and report are fakes recording what readiness asked of them.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { describe, expect, it } from "vitest";
import { World } from "../core/World";
import { defaultGraphics, type QualityTier } from "../core/graphics";
import { BabylonRenderer } from "../render/babylon/BabylonRenderer";
import { PipelineReadiness, pipelineTierKey, type ReadinessReport, type ReadinessWarmer } from "../render/babylon/pipelineReadiness";
import type { WarmItem } from "../render/babylon/warmUp";

const [LOW, , HIGH] = defaultGraphics().tiers as [QualityTier, QualityTier, QualityTier];

/** An engine whose pipelines compile only when `compile()` says, one state at a time. */
function fakeEngine(webgpu = true) {
  const stored = new Map<string, object>();
  const pending: ((p: object) => void)[] = [];
  let state = "a";
  const cache = {
    disabled: false,
    _parameter: { token: null as unknown, pipeline: null as object | null },
    _lookupRenderPipeline() {
      this._parameter.token = state;
      return stored.get(state) ?? null;
    },
    _buildRenderPipelineDescriptor: () => ({}),
    _setRenderPipeline(param: { token: unknown; pipeline: object | null }) {
      stored.set(param.token as string, param.pipeline!);
    },
    getRenderPipeline() {
      const p = { sync: state }; // a blocking compile, as Babylon makes it
      stored.set(state, p);
      return p;
    },
    constructor: { _GetTopology: () => "triangle-list" },
  };
  const engine = {
    isWebGPU: webgpu,
    _cacheRenderPipeline: cache,
    _device: { createRenderPipelineAsync: () => new Promise<object>((r) => pending.push(r)) },
    drawn: [] as string[],
    _draw() {
      (cache.getRenderPipeline as (...args: unknown[]) => object)(0, {}, 1, 0);
      this.drawn.push(state);
    },
    createEffect: () => ({}),
  };
  return {
    engine,
    /** Draw content with pipeline state `s` (a mesh in the frame graph). */
    draw(s: string) {
      state = s;
      engine._draw();
    },
    /** Finish every compile started so far. */
    async compile() {
      for (const r of pending.splice(0)) r({ async: true });
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

function fakeWarmer() {
  const waiting: (() => void)[] = [];
  const w = {
    drawing: false,
    onDrained: null as (() => void) | null,
    added: [] as WarmItem[][],
    rewarms: 0,
    frames: 0,
    disposed: false,
    add(items: readonly WarmItem[]) {
      w.added.push([...items]);
      return new Promise<void>((r) => waiting.push(r));
    },
    rewarm() {
      w.rewarms++;
      return Promise.resolve();
    },
    beforeRender() {},
    afterRender() {
      w.frames++;
    },
    dispose() {
      w.disposed = true;
    },
    drain: () => waiting.splice(0).forEach((r) => r()),
  };
  return w;
}

function setup(options: { webgpu?: boolean; holdMs?: number } = {}) {
  const gpu = fakeEngine(options.webgpu ?? true);
  const warmer = fakeWarmer();
  const reports: { quiet: number; frames: number; disposed: boolean }[] = [];
  const clock = { now: 0 };
  let tier: Readonly<QualityTier> = HIGH;
  let warmerDeps: { compiling?: () => Promise<void>; effectMs?: () => number } = {};
  const readiness = new PipelineReadiness({
    engine: gpu.engine as never,
    warmer: (deps) => ((warmerDeps = deps), warmer as unknown as ReadinessWarmer),
    report: () => {
      const r = { quiet: 0, frames: 0, disposed: false };
      reports.push(r);
      return { quiet: () => void r.quiet++, afterRender: () => void r.frames++, dispose: () => void (r.disposed = true) } as ReadinessReport;
    },
    tier: () => tier,
    now: () => clock.now,
    holdMs: options.holdMs ?? 3000,
  });
  /** One frame: the renderer's calls in order. Returns whether it was held. */
  const frame = (content: string[], opts: { loaded?: boolean; graphReady?: boolean; rebuilt?: boolean } = {}) => {
    readiness.beforeFrame(null, []);
    const held = readiness.drawFrame(
      opts.graphReady ?? true,
      () => {
        for (const s of content) gpu.draw(s);
        return !opts.rebuilt;
      },
      () => opts.loaded ?? true,
    );
    if (!opts.rebuilt && (opts.graphReady ?? true)) readiness.afterFrame();
    clock.now += 16;
    return held;
  };
  return { gpu, warmer, reports, clock, readiness, frame, setTier: (t: Readonly<QualityTier>) => (tier = t), warmerDeps: () => warmerDeps };
}

describe("a World's first frames (ADR 0120, 0163)", () => {
  it("holds frames while a draw that would show compiles, until content has loaded, then never again", async () => {
    const { gpu, frame } = setup();
    expect(frame(["a"])).toBe(true); // a's pipeline is compiling: the draw was skipped, the frame held
    expect(gpu.engine.drawn).toEqual([]);
    await gpu.compile();
    expect(frame(["a"], { loaded: false })).toBe(true); // complete, but textures still load
    expect(frame(["a"])).toBe(false); // complete and loaded: shown
    expect(gpu.engine.drawn).toEqual(["a", "a"]);
    expect(frame(["a", "b"])).toBe(false); // later: a missing pipeline compiles as Babylon makes it, drawn now
    expect(gpu.engine.drawn).toEqual(["a", "a", "a", "b"]);
  });

  it("doesn't count the warmer's own skipped draws", () => {
    const { gpu, warmer, readiness } = setup();
    readiness.beforeFrame(null, []);
    const held = readiness.drawFrame(
      true,
      () => {
        warmer.drawing = true;
        gpu.draw("warm"); // skipped while it compiles, but never shown
        warmer.drawing = false;
        return true;
      },
      () => true,
    );
    expect(held).toBe(false);
  });

  it("doesn't count frames where the graph wasn't ready or was rebuilt instead of run", async () => {
    const { gpu, frame } = setup();
    expect(frame([], { graphReady: false })).toBe(false); // the renderer clears these frames anyway
    expect(frame(["a"], { rebuilt: true })).toBe(false);
    expect(frame(["a"])).toBe(true); // still the first frames
    await gpu.compile();
    expect(frame(["a"])).toBe(false);
  });

  it("stops holding after its time limit, counted from the first frame", () => {
    const { clock, frame } = setup({ holdMs: 1000 });
    expect(frame(["a"])).toBe(true);
    clock.now = 1001;
    expect(frame(["a"])).toBe(true); // still missing a draw: covered, and the hold ends
    expect(frame(["b"])).toBe(false); // compiled as Babylon makes it
  });

  it("never holds where pipelines can't compile asynchronously (WebGL2), and leaves its draws alone", () => {
    const { gpu, frame } = setup({ webgpu: false });
    expect(frame(["a"], { loaded: false })).toBe(false);
    expect(gpu.engine.drawn).toEqual(["a"]);
  });
});

describe("pipeline warm-up rules (ADR 0080, 0163)", () => {
  it("warms everything again when the tier changes what draws need, not for render scale", () => {
    const { warmer, frame, setTier } = setup();
    const high = HIGH;
    frame([]);
    expect(warmer.rewarms).toBe(0);
    setTier({ ...high, renderScale: 0.5 });
    frame([]);
    expect(warmer.rewarms).toBe(0);
    setTier(LOW);
    frame([]);
    frame([]);
    expect(warmer.rewarms).toBe(1);
    expect(pipelineTierKey(high)).not.toBe(pipelineTierKey(LOW));
  });

  it("warms probe copies again when more probes have captured", () => {
    const { warmer, readiness } = setup();
    readiness.probesCaptured(0);
    readiness.probesCaptured(1);
    readiness.probesCaptured(1);
    readiness.probesCaptured(0);
    readiness.probesCaptured(1);
    expect(warmer.rewarms).toBe(2);
  });

  it("resolves a warm-up at once before frames are drawn, and waits for its draws while they are", async () => {
    const { warmer, readiness, frame, clock } = setup();
    const item = {} as WarmItem;
    await readiness.warm([item]); // no frame yet: drawn over the first frames instead
    frame([]);
    let done = false;
    const later = readiness.warm([], [Promise.resolve([item])]).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(warmer.added).toEqual([[item], [], [item]]); // a lazy feature's items join once they arrive
    expect(done).toBe(false);
    warmer.drain();
    await later;
    clock.now += 1000;
    await readiness.warm([item]); // no frame drawn for a while: at once
  });

  it("gives the warmer async compiles on WebGPU only, and an effect clock", () => {
    expect(setup().warmerDeps().compiling).toBeTypeOf("function");
    expect(setup({ webgpu: false }).warmerDeps().compiling).toBeUndefined();
    expect(setup().warmerDeps().effectMs!()).toBe(0);
  });

  it("keeps the variant report quiet while a warm-up drains, and moves it on after drawn frames", () => {
    const { warmer, readiness, reports, frame } = setup();
    readiness.setVariantReport(true);
    readiness.setVariantReport(true);
    expect(reports).toHaveLength(1);
    warmer.onDrained?.();
    frame([], { graphReady: false }); // not drawn: the report doesn't look
    frame([]);
    expect(reports[0]).toMatchObject({ quiet: 1, frames: 1 });
    readiness.setVariantReport(false);
    expect(reports[0].disposed).toBe(true);
  });

  it("unhooks the engine when disposed", () => {
    const { gpu, warmer, readiness } = setup();
    const draw = gpu.engine._draw, create = gpu.engine.createEffect;
    readiness.dispose();
    expect(warmer.disposed).toBe(true);
    expect(gpu.engine._draw).not.toBe(draw);
    expect(gpu.engine.createEffect).not.toBe(create);
  });
});

describe("a thumbnail renderer has no readiness (ADR 0163)", () => {
  it("leaves the shared engine unwrapped and undisposed", () => {
    const engine = new NullEngine();
    const create = engine.createEffect;
    const world = new World("editor");
    const renderer = BabylonRenderer.forThumbnail(engine, world.settings, [], { studio: null });
    expect(engine.createEffect).toBe(create); // no effect clock, no variant report
    renderer.sync(world);
    return renderer.warmUp({ meshes: [] } as never).then(() => {
      renderer.dispose();
      expect(engine.isDisposed).toBe(false);
      engine.dispose();
    });
  });
});
