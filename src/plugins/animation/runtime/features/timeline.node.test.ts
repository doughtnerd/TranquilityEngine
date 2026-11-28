// ADR 0371, 0372 (T22t): TimelineDirector in a headless Engine through the public API (`myco`): `*.timeline.json`
// assets (`myco.timeline@1`) driving two nodes, a subclip crossfade, wrap modes, seeks, the play promise, binding
// overrides and the control track actions (particles, camera cut). Time comes from `engine.step(dt)` only, in quarter
// seconds (the Engine caps a frame's dt at 0.25 s). The timelines are linear curves sampled at 30 Hz into f32 samples:
// values are compared at 1e-4.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Camera, Engine, GameObject, Light, ParticleSystem, TimelineDirector, type AnimationPlayResult } from "../../../../myco";
import { previewTimeline } from "./timeline";

const TOL = 4;
let engine: Engine;
const made: GameObject[] = [];
const steps = (n: number) => {
  for (let i = 0; i < n; i++) engine.step(0.25);
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const light = (nodePath: string, keys: [number, number][]) => ({
  kind: "float",
  target: { nodePath, component: "engine.Light", field: "intensity" },
  curves: [keys],
});
const timeline = (duration: number, tracks: unknown[]) => ({ format: "myco.timeline@1", duration, tracks });

const ASSETS: Record<string, unknown> = {
  // Two nodes: A's light 0 → 2 and B's position x 0 → 4 over 2 s.
  "tl/two.timeline.json": timeline(2, [
    light("A", [[0, 0], [2, 2]]),
    { kind: "vec3", target: { nodePath: "B", component: "engine.Transform", field: "position" }, curves: [[[0, 0], [2, 4]], [[0, 1]], [[0, 0]]] },
  ]),
  "tl/ramp.timeline.json": timeline(1, [light("A", [[0, 0], [1, 1]])]),
  // 1.01 s isn't a whole number of 30 Hz frames: its last frame sits at 1.01 s, a third of a frame after 1.0 s.
  "tl/tail.timeline.json": timeline(1.01, [light("A", [[0, 0], [1.01, 1.01]])]),
  // Two entries on one subclip track, overlapping from 1 to 2 s: the first blends out, the second in.
  "tl/one.timeline.json": timeline(2, [light("A", [[0, 1]])]),
  "tl/three.timeline.json": timeline(2, [light("A", [[0, 3]])]),
  "tl/fade.timeline.json": timeline(3, [
    {
      kind: "subclip",
      keys: [
        { time: 0, end: 2, clip: "asset:tl/one.timeline.json", blendOut: 1 },
        { time: 1, end: 3, clip: "asset:tl/three.timeline.json", blendIn: 1 },
      ],
    },
  ]),
  // Control keys: sparks play at 0.5 s and stop at 1.5 s; the camera cuts to Cam2 at 1 s.
  "tl/controls.timeline.json": timeline(2, [
    light("A", [[0, 0], [2, 2]]),
    {
      kind: "control",
      keys: [
        { time: 0.5, action: "particlePlay", target: "Fx" },
        { time: 1, action: "cameraCut", target: "Cam2" },
        { time: 1.5, action: "particleStop", target: "Fx", payload: { clear: true } },
      ],
    },
  ]),
  "tl/slot.timeline.json": timeline(1, [
    light("A", [[0, 0], [1, 1]]),
    { kind: "control", keys: [{ time: 0.25, action: "slotPlay", target: "Hero", payload: { clip: "anims/wave.anim", slot: "UpperBody", fade: 0.1 } }] },
  ]),
};

interface Rig {
  dir: TimelineDirector;
  a: Light;
  b: GameObject;
}

/** A director with children A (a Light) and B, playing `path`; resolves once its timeline shows (values at 0 written). */
async function rig(path: string, init: Partial<Pick<TimelineDirector, "wrapMode" | "playOnStart">> = {}): Promise<Rig> {
  const node = GameObject.create("Dir");
  made.push(node);
  const a = GameObject.create("A", { parent: node }).addComponent(Light, { type: "point", intensity: 99 });
  const b = GameObject.create("B", { parent: node });
  const dir = node.addComponent(TimelineDirector, { timeline: path, ...init });
  await vi.waitFor(() => {
    engine.step(0);
    expect(a.intensity).not.toBe(99);
  });
  return { dir, a, b };
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(ASSETS));
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  engine.step(0);
  vi.restoreAllMocks();
});

describe("TimelineDirector", () => {
  it("plays on start, drives two nodes' properties and moves its playhead", async () => {
    const { dir, a, b } = await rig("tl/two.timeline.json");
    expect(a.intensity).toBeCloseTo(0, TOL);
    steps(2);
    expect(dir.playhead).toBeCloseTo(0.5, 6);
    expect(a.intensity).toBeCloseTo(0.5, TOL);
    const p = b.transform!.position;
    expect([p.x, p.y, p.z].map((v) => +v.toFixed(4))).toEqual([1, 1, 0]);
  });

  it("resolves play() finished at the end and holds the last frame (wrapMode hold)", async () => {
    const { dir, a } = await rig("tl/ramp.timeline.json", { playOnStart: false });
    const played = dir.play();
    steps(3);
    expect(a.intensity).toBeCloseTo(0.75, TOL);
    steps(2);
    await expect(played).resolves.toEqual({ reason: "finished" });
    expect(a.intensity).toBeCloseTo(1, TOL);
    expect(dir.playhead).toBe(1);
    steps(2);
    expect(a.intensity).toBeCloseTo(1, TOL);
  });

  it("ends on the last key when the duration isn't a whole number of frames (ADR 0451)", async () => {
    const { dir, a } = await rig("tl/tail.timeline.json", { playOnStart: false });
    dir.playhead = 1.005; // halfway between the frames at 1.0 s and 1.01 s
    steps(1);
    expect(a.intensity).toBeCloseTo(1.005, TOL);
    const played = dir.play();
    steps(1);
    await expect(played).resolves.toEqual({ reason: "finished" });
    expect(dir.playhead).toBeCloseTo(1.01, 6);
    expect(a.intensity).toBeCloseTo(1.01, TOL);
  });

  it("loops with wrapMode loop", async () => {
    const { dir, a } = await rig("tl/ramp.timeline.json", { wrapMode: "loop", playOnStart: false });
    let result: AnimationPlayResult | null = null;
    void dir.play().then((r) => (result = r));
    steps(5);
    expect(dir.playhead).toBeCloseTo(0.25, 6);
    expect(a.intensity).toBeCloseTo(0.25, TOL);
    await flush();
    expect(result).toBeNull();
    dir.stop();
    await flush();
    expect(result).toEqual({ reason: "stopped" });
  });

  it("stops and goes back to the start at the end with wrapMode none", async () => {
    const { dir, a } = await rig("tl/ramp.timeline.json", { wrapMode: "none", playOnStart: false });
    const played = dir.play();
    steps(4);
    await expect(played).resolves.toEqual({ reason: "finished" });
    expect(dir.playhead).toBe(0);
    steps(1);
    expect(a.intensity).toBeCloseTo(0, TOL);
    expect(dir.playhead).toBe(0);
  });

  it("pauses, resumes, stops, and interrupts a waiting play", async () => {
    const { dir, a } = await rig("tl/ramp.timeline.json", { playOnStart: false });
    const first = dir.play();
    steps(1);
    const second = dir.play();
    await expect(first).resolves.toEqual({ reason: "interrupted" });
    dir.pause();
    steps(2);
    expect(a.intensity).toBeCloseTo(0.25, TOL);
    void dir.play();
    steps(1);
    expect(a.intensity).toBeCloseTo(0.5, TOL);
    dir.stop();
    await expect(second).resolves.toEqual({ reason: "interrupted" });
    steps(1);
    expect(dir.playhead).toBe(0);
    expect(a.intensity).toBeCloseTo(0, TOL);
  });

  it("crossfades overlapping subclip entries", async () => {
    const { a } = await rig("tl/fade.timeline.json");
    steps(2); // 0.5: the first entry alone
    expect(a.intensity).toBeCloseTo(1, TOL);
    steps(4); // 1.5: halfway through the overlap
    expect(a.intensity).toBeCloseTo(2, TOL);
    steps(4); // 2.5: the second entry alone
    expect(a.intensity).toBeCloseTo(3, TOL);
  });

  it("plays an authored clip nested as a subclip whatever the case of its ending (ADR 0460)", async () => {
    // The editor's drop accepts `clips/Glow.Anim.JSON` as a clip; the runtime reads it as one, not as a timeline.
    ASSETS["tl/Glow.Anim.JSON"] = { format: "myco.anim-source@1", duration: 1, tracks: [light("A", [[0, 6]])] };
    ASSETS["tl/nest.timeline.json"] = timeline(1, [{ kind: "subclip", keys: [{ time: 0, end: 1, clip: "asset:tl/Glow.Anim.JSON" }] }]);
    const { a } = await rig("tl/nest.timeline.json");
    expect(a.intensity).toBeCloseTo(6, TOL);
  });

  it("drives a bound node instead of the track's path (bindingTracks / bindingNodes)", async () => {
    const other = GameObject.create("Other");
    made.push(other);
    const lamp = other.addComponent(Light, { type: "point", intensity: 99 });
    const node = GameObject.create("Dir");
    made.push(node);
    node.addComponent(TimelineDirector, { timeline: "tl/ramp.timeline.json", bindingTracks: ["A"], bindingNodes: [other] });
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).not.toBe(99);
    });
    steps(2);
    expect(lamp.intensity).toBeCloseTo(0.5, TOL);
  });
});

describe("editor preview (Q2)", () => {
  it("reloads a timeline whose file changed under the same path, nested files included", async () => {
    ASSETS["tl/edited.timeline.json"] = timeline(2, [light("A", [[0, 5]])]);
    ASSETS["tl/outer.timeline.json"] = timeline(2, [{ kind: "subclip", keys: [{ time: 0, end: 2, clip: "asset:tl/edited.timeline.json" }] }]);
    const { dir, a } = await rig("tl/edited.timeline.json");
    expect(a.intensity).toBeCloseTo(5, TOL);
    // Unchanged: a preview keeps what it loaded (no new content to show).
    a.intensity = 99;
    previewTimeline(dir);
    await vi.waitFor(() => {
      engine.step(0);
      expect(a.intensity).toBeCloseTo(5, TOL);
    });
    // The editor saves the file at the same path and says so: the preview shows the new content.
    ASSETS["tl/edited.timeline.json"] = timeline(2, [light("A", [[0, 7]])]);
    Assets.notifyChanged("tl/edited.timeline.json");
    previewTimeline(dir);
    await vi.waitFor(() => {
      engine.step(0);
      expect(a.intensity).toBeCloseTo(7, TOL);
    });
    // A file nested as a subclip changing reloads the timeline that uses it too.
    dir.timeline = "tl/outer.timeline.json";
    previewTimeline(dir);
    await vi.waitFor(() => {
      engine.step(0);
      expect(a.intensity).toBeCloseTo(7, TOL);
    });
    ASSETS["tl/edited.timeline.json"] = timeline(2, [light("A", [[0, 9]])]);
    Assets.notifyChanged("tl/edited.timeline.json");
    previewTimeline(dir);
    await vi.waitFor(() => {
      engine.step(0);
      expect(a.intensity).toBeCloseTo(9, TOL);
    });
  });
});

describe("control tracks and seeks", () => {
  async function controlRig() {
    const r = await rig("tl/controls.timeline.json", { playOnStart: false });
    const node = r.dir.node;
    const fx = GameObject.create("Fx", { parent: node }).addComponent(ParticleSystem, { playOnAwake: false });
    const cam1 = GameObject.create("Cam1", { parent: node }).addComponent(Camera);
    const cam2 = GameObject.create("Cam2", { parent: node }).addComponent(Camera, { enabled: false } as never);
    cam2.enabled = false;
    return { ...r, fx, cam1, cam2 };
  }

  it("plays and stops particles and cuts cameras as the playhead crosses their keys", async () => {
    const { dir, fx, cam1, cam2 } = await controlRig();
    const play = vi.spyOn(ParticleSystem.prototype, "play");
    const stop = vi.spyOn(ParticleSystem.prototype, "stop");
    void dir.play();
    steps(3); // 0.75: past the play key
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.contexts[0]).toBe(fx);
    expect(cam1.enabled).toBe(true);
    steps(2); // 1.25: past the cut
    expect(cam2.enabled).toBe(true);
    expect(cam1.enabled).toBe(false);
    steps(2); // 1.75: past the stop
    expect(stop).toHaveBeenCalledWith({ clear: true });
  });

  it("fires no key when a script seeks over it", async () => {
    const { dir, a, cam2 } = await controlRig();
    const play = vi.spyOn(ParticleSystem.prototype, "play");
    dir.playhead = 1.75; // paused: a seek past every key
    steps(1);
    expect(a.intensity).toBeCloseTo(1.75, TOL);
    expect(play).not.toHaveBeenCalled();
    expect(cam2.enabled).toBe(false);
    void dir.play();
    dir.playhead = 0.25; // playing: seek back, then play over the particle key
    steps(2);
    expect(play).toHaveBeenCalledOnce();
  });

  it("plays a nested Animator's slot through Animator.play (slot plays are built, T32)", async () => {
    const { dir } = await rig("tl/slot.timeline.json", { playOnStart: false });
    const hero = GameObject.create("Hero", { parent: dir.node }).addComponent(Animator);
    const play = vi.spyOn(Animator.prototype, "play");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    void dir.play();
    steps(2);
    expect(play).toHaveBeenCalledWith("anims/wave.anim", { slot: "UpperBody", fade: 0.1 });
    expect(play.mock.contexts[0]).toBe(hero);
    // The control handler no longer guards against an unbuilt slot play.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("can't play yet"))).toBe(false);
  });
});
