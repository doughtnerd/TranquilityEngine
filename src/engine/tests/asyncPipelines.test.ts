// ADR 0080 on WebGPU: the warm-up's pipelines compile asynchronously (`render/babylon/asyncPipelines.ts`).
// No WebGPU in Node, so the hook runs against a stand-in for Babylon's pipeline cache and engine with
// the members it reads: a miss while active starts one async compile per state and skips that draw,
// the compiled pipeline then comes from the cache, and the clear quad's lookups pass straight through.
import { describe, expect, it } from "vitest";
import { AsyncPipelines, FirstFrames } from "../render/babylon/asyncPipelines";

function fakes() {
  const stored = new Map<string, object>();
  let state = "a";
  const resolvers: ((p: object) => void)[] = [];
  const log: string[] = [];
  const cache = {
    disabled: false,
    _parameter: { token: null as unknown, pipeline: null as object | null },
    _lookupRenderPipeline() {
      this._parameter.token = state; // Babylon's token is the cache node for the current state
      return stored.get(state) ?? null;
    },
    _buildRenderPipelineDescriptor: () => ({ state }),
    _setRenderPipeline(param: { token: unknown; pipeline: object | null }) {
      stored.set(param.token as string, param.pipeline!);
    },
    getRenderPipeline() {
      log.push(`sync ${state}`);
      const p = { sync: state };
      stored.set(state, p);
      return p;
    },
    constructor: { _GetTopology: () => "triangle-list" },
  };
  const device = { createRenderPipelineAsync: () => new Promise<object>((r) => resolvers.push(r)) };
  const engine = {
    isWebGPU: true,
    _cacheRenderPipeline: cache,
    _device: device,
    drew: [] as string[],
    _draw() {
      const p = (cache.getRenderPipeline as (...args: unknown[]) => object)(0, {}, 1, 0);
      this.drew.push(`${state}:${JSON.stringify(p)}`);
    },
  };
  return { cache, engine, resolvers, log, setState: (s: string) => (state = s) };
}

describe("async warm-up pipelines (ADR 0080)", () => {
  it("compiles a missing pipeline asynchronously while active, skipping that draw, then draws with it", async () => {
    const f = fakes();
    let active = true;
    const a = AsyncPipelines.install(f.engine as never, () => active)!;
    expect(a).not.toBeNull();
    f.engine._draw();
    f.engine._draw(); // the same state again: no second compile
    expect(f.engine.drew).toEqual([]); // both skipped
    expect(f.resolvers).toHaveLength(1);
    expect(a.busy).toBe(true);
    expect(a.skipped).toBe(2);
    const pipeline = { compiled: "a" };
    f.resolvers[0](pipeline);
    await a.settled();
    expect(a.busy).toBe(false);
    expect(a.compiled).toBe(1);
    f.engine._draw();
    expect(f.engine.drew).toEqual([`a:${JSON.stringify(pipeline)}`]); // from the cache: no blocking compile
    expect(f.log).toEqual([]);
    // Not active (the warmer is idle): a miss compiles as Babylon does, and the draw happens.
    active = false;
    f.setState("b");
    f.engine._draw();
    expect(f.log).toEqual(["sync b"]);
    expect(f.engine.drew).toHaveLength(2);
    a.dispose();
  });

  it("leaves lookups outside a mesh draw alone (the clear quad), so a skip never escapes", () => {
    const f = fakes();
    AsyncPipelines.install(f.engine as never, () => true);
    // What Babylon's clear quad does: ask the cache directly, not through `_draw`.
    expect(() => f.cache.getRenderPipeline()).not.toThrow();
    expect(f.log).toEqual(["sync a"]);
  });

  it("isn't installed where the engine has no WebGPU pipeline cache", () => {
    expect(AsyncPipelines.install({ isWebGPU: false } as never, () => true)).toBeNull();
    const f = fakes();
    expect(AsyncPipelines.install({ ...f.engine, _cacheRenderPipeline: { ...f.cache, _lookupRenderPipeline: undefined } } as never, () => true)).toBeNull();
  });
});

describe("a World's first frames (ADR 0120)", () => {
  it("counts skipped draws that would have shown apart from the warmer's own", () => {
    const f = fakes();
    let warm = true;
    const a = AsyncPipelines.install(f.engine as never, () => true, () => !warm)!;
    f.engine._draw(); // the warmer's
    warm = false;
    f.setState("b");
    f.engine._draw(); // content in a held first frame
    expect(a.skipped).toBe(2);
    expect(a.skippedShown).toBe(1);
    a.dispose();
  });

  it("holds every frame until the content has loaded and a frame draws complete, then never again", () => {
    const ff = new FirstFrames(3000);
    expect(ff.begin(false, 0)).toBe(false); // the graph isn't ready: the view shows the clear colour anyway
    expect(ff.begin(true, 100)).toBe(true);
    expect(ff.end(true, true, 100)).toBe(true); // a draw was skipped: held
    expect(ff.begin(true, 116)).toBe(true);
    expect(ff.end(false, false, 116)).toBe(true); // complete, but textures are still loading: held
    expect(ff.begin(true, 132)).toBe(true);
    expect(ff.end(false, true, 132)).toBe(false); // complete and loaded: shown
    expect(ff.done).toBe(true);
    expect(ff.begin(true, 148)).toBe(false); // later frames (a rebuilt graph) compile as they draw
    expect(ff.end(true, true, 148)).toBe(false);
  });

  it("stops holding after its time limit, counted from the first frame", () => {
    const ff = new FirstFrames(1000);
    ff.begin(false, 0);
    expect(ff.begin(true, 900)).toBe(true);
    expect(ff.end(true, false, 900)).toBe(true);
    expect(ff.begin(true, 1001)).toBe(true);
    expect(ff.end(true, false, 1001)).toBe(true); // this frame is still missing draws: covered
    expect(ff.done).toBe(true);
    expect(ff.begin(true, 1017)).toBe(false);
  });
});
