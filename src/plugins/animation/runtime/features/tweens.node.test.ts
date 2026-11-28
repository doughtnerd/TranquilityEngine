// ADR 0371, 0372 (T22t): tweens, sequences and parallel groups in a headless Engine through the public API (`myco`).
// Time comes from `engine.step(dt)` only. Values pass through the core as f32: compared at 1e-5 (f32 rounding of
// values near 1–10), except slerped rotations (1e-5 on the quaternion's components).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { evalCurve } from "../../../../engine/core/curve";
import { animationCoreOf } from "../core/service";
import { Color, Engine, GameObject, Light, MeshRenderer, Quaternion, Time, Tweens, parallel, sequence, tween, type Curve, type Tween, type TweenResult } from "../../../../myco";

let engine: Engine;
const made: GameObject[] = [];
const steps = (n: number, dt: number) => {
  for (let i = 0; i < n; i++) engine.step(dt);
};
const TOL = 5;
/** Advances `seconds` in quarter-second frames (the Engine caps one frame's dt at 0.25 s). */
const go = (seconds: number) => steps(Math.round(seconds / 0.25), 0.25);

function lamp(name = "Lamp"): { node: GameObject; light: Light } {
  const node = GameObject.create(name);
  made.push(node);
  return { node, light: node.addComponent(Light, { type: "point" }) };
}

/** Records the order promises resolve in. */
function watch(log: string[], name: string, t: PromiseLike<TweenResult>): void {
  void t.then((r) => log.push(`${name}:${r.reason}`));
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeAll(async () => {
  engine = await Engine.create({ headless: true });
  // The first tween starts the World's core (loaded lazily); wait for it once.
  const { light } = lamp("Warmup");
  const t = tween(light, "intensity", 2, { duration: 0 });
  await vi.waitFor(() => {
    engine.step(0);
    expect(t.isPlaying).toBe(false);
  });
});

afterEach(() => {
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  Time.timeScale = 1;
  engine.step(0);
});

describe("tween()", () => {
  it("drives a light's intensity linearly to its end and resolves finished", async () => {
    const { light } = lamp();
    const t = tween(light, "intensity", 5, { duration: 1, from: 1, ease: "linear" });
    expect(t.isPlaying).toBe(true);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      engine.step(0.25);
      seen.push(light.intensity);
    }
    seen.forEach((v, i) => expect(v).toBeCloseTo(2 + i, TOL));
    expect(t.isPlaying).toBe(false);
    await expect(t).resolves.toEqual({ reason: "finished" });
  });

  it("starts at the next update from the field's value then, with outQuad by default", () => {
    const { light } = lamp();
    light.intensity = 0;
    tween(light, "intensity", 1, { duration: 1 });
    light.intensity = 0.5; // before the next update: this is the start
    engine.step(0.25);
    // outQuad at 0.25: 1 - 0.75² = 0.4375 of the way from 0.5 to 1.
    expect(light.intensity).toBeCloseTo(0.5 + 0.5 * 0.4375, TOL);
  });

  it("uses each Penner easing by name", () => {
    const { light } = lamp();
    tween(light, "intensity", 1, { duration: 1, from: 0, ease: "inCubic" });
    go(0.5);
    expect(light.intensity).toBeCloseTo(0.125, TOL);
  });

  it("moves a Transform's position by a relative amount", () => {
    const { node } = lamp();
    node.transform!.position = [1, 2, 3];
    tween(node.transform!, "position", [1, 0, -2], { duration: 1, relative: true, ease: "linear" });
    go(0.5);
    const p = node.transform!.position;
    expect([p.x, p.y, p.z].map((v) => +v.toFixed(5))).toEqual([1.5, 2, 2]);
    go(0.5);
    expect([p.x, p.y, p.z].map((v) => +v.toFixed(5))).toEqual([2, 2, 1]);
  });

  it("turns a rotation by slerp and lands exactly", () => {
    const { node } = lamp();
    const end = Quaternion.euler(0, Math.PI / 2, 0);
    tween(node.transform!, "rotation", end, { duration: 1, ease: "linear" });
    go(0.5);
    const half = Quaternion.euler(0, Math.PI / 4, 0);
    const q = node.transform!.rotation;
    for (const k of ["x", "y", "z", "w"] as const) expect(q[k]).toBeCloseTo(half[k], TOL);
    go(0.5);
    for (const k of ["x", "y", "z", "w"] as const) expect(q[k]).toBeCloseTo(end[k], TOL);
  });

  it("fades a colour", () => {
    const { light } = lamp();
    light.color = new Color(1, 1, 1, 1);
    tween(light, "color", new Color(0, 0.5, 1, 0), { duration: 1, ease: "linear" });
    go(0.5);
    const c = light.color;
    expect([c.r, c.g, c.b, c.a].map((v) => +v.toFixed(5))).toEqual([0.5, 0.75, 1, 0.5]);
  });

  it("drives a material property override through the renderer", () => {
    const node = GameObject.create("Box");
    made.push(node);
    const mr = node.addComponent(MeshRenderer);
    mr.setMaterialProperty("metalness", 0);
    tween(mr, "material.metalness", 1, { duration: 1, ease: "linear" });
    engine.step(0.25);
    expect(mr.getMaterialProperty("metalness")).toBeCloseTo(0.25, TOL);
  });

  it("drives one material slot's override (materials[N].<name>, the form property tracks bind)", () => {
    const node = GameObject.create("Box");
    made.push(node);
    const mr = node.addComponent(MeshRenderer);
    mr.setMaterialProperty("metalness", 0, 1);
    const t = tween(mr, "materials[1].metalness", 1, { duration: 1, ease: "linear" });
    expect(t.isPlaying).toBe(true);
    engine.step(0.25);
    expect(mr.getMaterialProperty("metalness", 1)).toBeCloseTo(0.25, TOL);
    expect(mr.getMaterialProperty("metalness")).toBeUndefined(); // slot 1 only, not the whole renderer
  });

  it("waits out its delay", () => {
    const { light } = lamp();
    light.intensity = 0;
    tween(light, "intensity", 1, { duration: 1, delay: 0.5, ease: "linear" });
    engine.step(0.25);
    expect(light.intensity).toBe(0);
    go(0.5);
    expect(light.intensity).toBeCloseTo(0.25, TOL);
  });

  it("restarts each loop", async () => {
    const { light } = lamp();
    const t = tween(light, "intensity", 1, { duration: 1, from: 0, ease: "linear", loops: 2 });
    go(1.5);
    expect(light.intensity).toBeCloseTo(0.5, TOL);
    go(0.5);
    expect(light.intensity).toBe(1);
    await expect(t).resolves.toEqual({ reason: "finished" });
  });

  it("goes back and forth with yoyo and ends at the start after an even count", async () => {
    const { light } = lamp();
    const t = tween(light, "intensity", 1, { duration: 1, from: 0, ease: "linear", loops: 2, loopMode: "yoyo" });
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      go(0.5);
      seen.push(+light.intensity.toFixed(5));
    }
    expect(seen).toEqual([0.5, 1, 0.5, 0]);
    await expect(t).resolves.toEqual({ reason: "finished" });
  });

  it("loops forever with loops: -1 until stopped", async () => {
    const { light } = lamp();
    const t = tween(light, "intensity", 1, { duration: 1, from: 0, ease: "linear", loops: -1 });
    go(4.5);
    expect(t.isPlaying).toBe(true);
    t.stop();
    await expect(t).resolves.toEqual({ reason: "stopped" });
  });

  it("follows unscaled time when asked, and scaled time by default", () => {
    const a = lamp("A").light, b = lamp("B").light;
    tween(a, "intensity", 1, { duration: 1, from: 0, ease: "linear" });
    tween(b, "intensity", 1, { duration: 1, from: 0, ease: "linear", time: "unscaled" });
    Time.timeScale = 0;
    engine.step(0.25);
    expect(a.intensity).toBe(0);
    expect(b.intensity).toBeCloseTo(0.25, TOL);
  });

  it("scales its own time by speed", () => {
    const { light } = lamp();
    tween(light, "intensity", 1, { duration: 1, from: 0, ease: "linear", speed: 2 });
    engine.step(0.25);
    expect(light.intensity).toBeCloseTo(0.5, TOL);
  });

  it("maps its progress through an engine Curve", () => {
    const { light } = lamp();
    const ease: Curve = [[0, 0], [0.5, 1], [1, 1]];
    tween(light, "intensity", 10, { duration: 1, from: 0, ease });
    engine.step(0.25);
    expect(light.intensity).toBeCloseTo(5, TOL);
    go(0.5);
    expect(light.intensity).toBeCloseTo(10, TOL);
  });

  describe("engine Curve easing (T70: the core's evaluator)", () => {
    // Each curve eases a 0 → 1 intensity over 4 s in sixteenth steps: the value is the curve at the progress, as the engine's
    // `evalCurve` (what the host evaluated before T70) gives it, within f32 (1e-6 of the 0..1 scale).
    const CURVES: [string, Curve][] = [
      ["linear keys", [[0, 0], [0.25, 0.8], [1, 1]]],
      ["smooth and ease shapes", [[0, 0, "smooth"], [0.5, 0.7, "easeIn"], [0.75, 0.2, "easeOut"], [1, 1]]],
      ["a step", [[0, 0, "step"], [0.5, 1], [1, 0.25]]],
      ["Bézier keys", [[0, 0, "bezier", { in: [0, 0], out: [0.2, 0.9] }], [0.6, 0.4, "bezier", { in: [-0.2, -0.3], out: [0.1, 0.6] }], [1, 1]]],
      ["an overshoot", [[0, 0, "bezier", { in: [0, 0], out: [0.3, 1.6] }], [1, 1, "bezier", { in: [-0.3, 0.4], out: [0, 0] }]]],
    ];
    for (const [name, ease] of CURVES) {
      it(`matches the TypeScript evaluator: ${name}`, () => {
        const { light } = lamp();
        tween(light, "intensity", 1, { duration: 4, from: 0, ease });
        for (let i = 1; i <= 16; i++) {
          engine.step(0.25);
          expect(Math.abs(light.intensity - evalCurve(ease, i / 16)), `progress ${i}/16`).toBeLessThanOrEqual(1e-6);
        }
      });
    }

    it("eases yoyo cycles and delays in the core", () => {
      const { light } = lamp();
      const ease: Curve = [[0, 0, "smooth"], [1, 1]];
      tween(light, "intensity", 1, { duration: 1, from: 0, ease, loops: 2, loopMode: "yoyo", delay: 0.5 });
      go(0.5);
      expect(light.intensity).toBeCloseTo(0, 5);
      go(0.25); // a quarter into the forward cycle
      expect(Math.abs(light.intensity - evalCurve(ease, 0.25))).toBeLessThanOrEqual(1e-6);
      go(1); // a quarter into the way back: progress 0.75 of the reversed cycle
      expect(Math.abs(light.intensity - evalCurve(ease, 0.75))).toBeLessThanOrEqual(1e-6);
    });

    it("eases a sequence's members, and a chained member starts where a curve tween ended", () => {
      const { light } = lamp();
      const ease: Curve = [[0, 0], [1, 0.5]]; // ends half way: the next member starts there
      sequence(tween(light, "intensity", 1, { duration: 1, from: 0, ease }), tween(light, "intensity", 3, { duration: 1, ease: "linear" }));
      go(0.5);
      expect(Math.abs(light.intensity - 0.25)).toBeLessThanOrEqual(1e-6);
      go(1); // half way through the second: from 0.5 to 3
      expect(Math.abs(light.intensity - 1.75)).toBeLessThanOrEqual(1e-5);
    });

    it("uses linear easing, with one warning, for a curve the core refuses", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { light } = lamp();
      tween(light, "intensity", 1, { duration: 1, from: 0, ease: [[1, 0], [0, 1]] });
      engine.step(0.25);
      expect(light.intensity).toBeCloseTo(0.25, TOL);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("easing curve"))).toBe(true);
      warn.mockRestore();
    });

    it("loads each distinct curve once and frees it when no tween uses it", async () => {
      const core = animationCoreOf(engine.world)!.core;
      const baseline = core.stats().assets;
      const a = lamp("A").light, b = lamp("B").light, c = lamp("C").light;
      const shared = (): Curve => [[0, 0], [0.5, 1], [1, 1]]; // equal content, a new array each time
      const ta = tween(a, "intensity", 1, { duration: 1, from: 0, ease: shared() });
      const tb = tween(b, "intensity", 1, { duration: 2, from: 0, ease: shared() });
      const tc = tween(c, "intensity", 1, { duration: 4, from: 0, ease: [[0, 0], [1, 1, "smooth"]] });
      engine.step(0);
      expect(core.stats().assets).toBe(baseline + 2); // two distinct curves
      go(1); // `ta` ended: `tb` still holds the shared curve
      await expect(ta).resolves.toEqual({ reason: "finished" });
      expect(core.stats().assets).toBe(baseline + 2);
      go(1);
      await expect(tb).resolves.toEqual({ reason: "finished" });
      expect(core.stats().assets).toBe(baseline + 1);
      tc.stop();
      expect(core.stats().assets).toBe(baseline);
    });

    it("frees the curve of a tween whose target is destroyed, and of a group's members", async () => {
      const core = animationCoreOf(engine.world)!.core;
      const baseline = core.stats().assets;
      const d = lamp("D");
      const td = tween(d.light, "intensity", 1, { duration: 4, from: 0, ease: [[0, 0], [1, 1, "easeIn"]] });
      const e = lamp("E").light;
      const g = parallel(tween(e, "intensity", 1, { duration: 1, from: 0, ease: [[0, 0], [1, 0.5]] }), tween(e, "range", 5, { duration: 1, from: 0, ease: [[0, 0], [1, 0.25, "smooth"]] }));
      engine.step(0.25);
      expect(core.stats().assets).toBe(baseline + 3);
      GameObject.destroy(d.node);
      steps(2, 0.25);
      await expect(td).resolves.toEqual({ reason: "destroyed" });
      expect(core.stats().assets).toBe(baseline + 2);
      go(1);
      await expect(g).resolves.toEqual({ reason: "finished" });
      expect(core.stats().assets).toBe(baseline);
    });
  });

  it("pauses, resumes and stops where it is", async () => {
    const { light } = lamp();
    const t = tween(light, "intensity", 1, { duration: 1, from: 0, ease: "linear" });
    engine.step(0.25);
    t.pause();
    steps(4, 0.25);
    expect(light.intensity).toBeCloseTo(0.25, TOL);
    t.resume();
    engine.step(0.25);
    expect(light.intensity).toBeCloseTo(0.5, TOL);
    t.stop();
    engine.step(0.25);
    expect(light.intensity).toBeCloseTo(0.5, TOL);
    expect(t.isPlaying).toBe(false);
    await expect(t).resolves.toEqual({ reason: "stopped" });
  });

  it("resolves destroyed when its node is destroyed or its component removed", async () => {
    const a = lamp("A"), b = lamp("B");
    const ta = tween(a.light, "intensity", 1, { duration: 1 });
    const tb = tween(b.light, "intensity", 1, { duration: 1 });
    engine.step(0.25);
    GameObject.destroy(a.node);
    GameObject.destroy(b.light);
    steps(2, 0.25); // destruction lands at the end of a frame; the next update notices
    await expect(ta).resolves.toEqual({ reason: "destroyed" });
    await expect(tb).resolves.toEqual({ reason: "destroyed" });
  });

  it("marks its node with animation.Tweens while it runs", () => {
    const { node, light } = lamp();
    tween(light, "intensity", 2, { duration: 0.5 });
    tween(node.transform!, "scale", [2, 2, 2], { duration: 1 });
    engine.step(0.25);
    expect(node.getData(Tweens)?.count).toBe(2);
    engine.step(0.25);
    expect(node.getData(Tweens)?.count).toBe(1);
    go(0.5);
    expect(node.hasData(Tweens)).toBe(false);
  });

  it("refuses a field it can't drive, already ended", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { light } = lamp();
    const t = tween(light, "type" as never, 1, { duration: 1 });
    expect(t.isPlaying).toBe(false);
    await expect(t).resolves.toEqual({ reason: "stopped" });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("sequence() and parallel()", () => {
  it("plays a sequence in order, each member from where the last left the field", async () => {
    const { light } = lamp();
    light.intensity = 0;
    const log: string[] = [];
    const a = tween(light, "intensity", 1, { duration: 1, ease: "linear" });
    const b = tween(light, "intensity", 3, { duration: 1, ease: "linear" });
    const s = sequence(a, b);
    watch(log, "a", a);
    watch(log, "b", b);
    watch(log, "seq", s);
    go(0.5);
    expect(light.intensity).toBeCloseTo(0.5, TOL);
    go(1);
    expect(light.intensity).toBeCloseTo(2, TOL);
    await flush();
    expect(log).toEqual(["a:finished"]);
    go(0.5);
    expect(light.intensity).toBeCloseTo(3, TOL);
    await flush();
    expect(log).toEqual(["a:finished", "b:finished", "seq:finished"]);
  });

  it("plays a parallel group together and ends with the longest", async () => {
    const { node, light } = lamp();
    light.intensity = 0;
    node.transform!.position = [0, 0, 0];
    const log: string[] = [];
    const a = tween(light, "intensity", 1, { duration: 0.5, ease: "linear" });
    const b = tween(node.transform!, "position", [2, 0, 0], { duration: 1, ease: "linear" });
    const p = parallel(a, b);
    watch(log, "a", a);
    watch(log, "b", b);
    watch(log, "par", p);
    engine.step(0.25);
    expect(light.intensity).toBeCloseTo(0.5, TOL);
    expect(node.transform!.position.x).toBeCloseTo(0.5, TOL);
    engine.step(0.25);
    await flush();
    expect(log).toEqual(["a:finished"]);
    go(0.5);
    await flush();
    expect(log).toEqual(["a:finished", "b:finished", "par:finished"]);
    expect(node.transform!.position.x).toBeCloseTo(2, TOL);
  });

  it("nests groups: sequence(t1, parallel(t2, t3)) with members' delays and loops counted", async () => {
    const x = lamp("X").light, y = lamp("Y").light, z = lamp("Z").light;
    for (const l of [x, y, z]) l.intensity = 0;
    const log: string[] = [];
    const t1 = tween(x, "intensity", 1, { duration: 0.5, delay: 0.5, ease: "linear" }); // 1 s long
    const t2 = tween(y, "intensity", 1, { duration: 0.5, loops: 2, ease: "linear" }); // 1 s long
    const t3 = tween(z, "intensity", 1, { duration: 0.5, ease: "linear" });
    const inner = parallel(t2, t3);
    const all = sequence(t1, inner);
    for (const [n, t] of [["t1", t1], ["t2", t2], ["t3", t3], ["inner", inner], ["all", all]] as [string, Tween][]) watch(log, n, t);
    go(0.75);
    expect(x.intensity).toBeCloseTo(0.5, TOL);
    expect(y.intensity).toBe(0);
    go(0.5); // 1.25
    expect(y.intensity).toBeCloseTo(0.5, TOL);
    expect(z.intensity).toBeCloseTo(0.5, TOL);
    engine.step(0.25); // 1.5
    await flush();
    expect(log).toEqual(["t1:finished", "t3:finished"]);
    go(0.5); // 2
    await flush();
    expect(log).toEqual(["t1:finished", "t3:finished", "t2:finished", "inner:finished", "all:finished"]);
  });

  it("pauses, resumes and stops a whole group; a stopped member stops writing", async () => {
    const x = lamp("X").light, y = lamp("Y").light;
    x.intensity = 0;
    y.intensity = 0;
    const a = tween(x, "intensity", 1, { duration: 1, ease: "linear" });
    const b = tween(y, "intensity", 1, { duration: 1, ease: "linear" });
    const p = parallel(a, b);
    engine.step(0.25);
    a.pause(); // pauses the group
    steps(2, 0.25);
    expect(y.intensity).toBeCloseTo(0.25, TOL);
    p.resume();
    b.stop();
    engine.step(0.25);
    expect(x.intensity).toBeCloseTo(0.5, TOL);
    expect(y.intensity).toBeCloseTo(0.25, TOL);
    await expect(b).resolves.toEqual({ reason: "stopped" });
    p.stop();
    await expect(a).resolves.toEqual({ reason: "stopped" });
    await expect(p).resolves.toEqual({ reason: "stopped" });
  });

  it("resolves a member destroyed when its target goes, and the group destroyed when all have", async () => {
    const a = lamp("A"), b = lamp("B");
    const ta = tween(a.light, "intensity", 1, { duration: 1 });
    const tb = tween(b.light, "intensity", 1, { duration: 1 });
    const s = sequence(ta, tb);
    engine.step(0.25);
    GameObject.destroy(a.node);
    steps(2, 0.25);
    await expect(ta).resolves.toEqual({ reason: "destroyed" });
    expect(s.isPlaying).toBe(true);
    GameObject.destroy(b.node);
    steps(2, 0.25);
    await expect(s).resolves.toEqual({ reason: "destroyed" });
  });

  it("won't take a tween that has started", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { light } = lamp();
    const a = tween(light, "intensity", 1, { duration: 1 });
    engine.step(0.1);
    const s = sequence(a);
    expect(warn).toHaveBeenCalledOnce();
    engine.step(0);
    expect(s.isPlaying).toBe(false);
    expect(a.isPlaying).toBe(true);
    warn.mockRestore();
  });
});
