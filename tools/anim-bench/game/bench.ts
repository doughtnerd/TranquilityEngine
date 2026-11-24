// The animation bench's game script (T82; `npm run bench:anim`, see tools/anim-bench/run.mjs). `run.mjs` copies it into a
// generated project as scripts/bench.ts, exports the project with the shipped player and opens the build in headless
// Chromium with `?bench=<scenario>`. Everything here is the public `myco` API, as any game would use it:
//
// - the scenario is built with GameObject/addComponent (Skeleton, Animator, SkinnedMeshRenderer, TimelineDirector, tween);
// - the timings come from probe systems ordered around the animation plugin's built-in systems by name (`defineSystem`'s
//   `before`/`after`, which is how any game orders against a built-in): the gap between two probes is the stage between
//   them (animation.Timeline, Gather, Evaluate, Apply), read with `performance.now()`;
// - the rest of the frame (lateUpdate scripts, propagation, render sync and the Babylon render: the skinning upload and
//   kernel dispatch are in here) is the time from the last probe to a MessageChannel message posted there, which runs
//   when the frame's task ends; the frame starts at a requestAnimationFrame callback requested in the previous frame,
//   which runs just before the Engine's (the Engine requests its next frame after its step).
//
// The result is one console line, `[anim-bench] {json}`, that run.mjs reads. Nothing here reads engine internals.
import { Animator, Camera, GameBehavior, GameObject, MeshRenderer, Quaternion, Skeleton, SkinnedMeshRenderer, Time, TimelineDirector, Vector2, Vector3, behavior, defineSystem, tween } from "myco";

const params = new URLSearchParams(globalThis.location?.search ?? "");
const SCENARIO = params.get("bench") ?? "empty";
const num = (key: string, fallback: number) => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
};
/** Seconds to wait after building the scene before warming up (assets load meanwhile). */
const SETTLE = num("settle", 3);
const WARM = num("warm", 120);
const FRAMES = num("frames", 300);
/** `camera=0` switches the camera off, so nothing renders: the animation stages without the renderer competing for the CPU. */
const CAMERA = num("camera", 1) !== 0;

// --- GPU call counts (run.mjs --count) ------------------------------------------------------------------------------

/** run.mjs's counting init script (gpuCounts.js), present only in a counted run: the page's own WebGL2/WebGPU calls. */
interface Counts {
  info: { contexts: string[]; skinning: string | null };
  snapshot(): Record<string, number>;
}
const counts = (globalThis as { __animBenchCounts?: Counts }).__animBenchCounts ?? null;
let countsAtStart: Record<string, number> | null = null;

/** Each counter's change per measured frame since `countsAtStart`. */
function countsPerFrame(frames: number): Record<string, number> | null {
  if (!counts || !countsAtStart) return null;
  const end = counts.snapshot();
  const out: Record<string, number> = {};
  for (const k of Object.keys(end).sort()) {
    const d = end[k] - (countsAtStart[k] ?? 0);
    if (d) out[k] = Math.round((d / frames) * 100) / 100;
  }
  return out;
}

// --- Probes --------------------------------------------------------------------------------------------------------

type Mark = "p0" | "p1" | "p2" | "p3" | "p4";
const now = () => performance.now();
const marks: Record<Mark, number> = { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 };
let frameStart = 0;
let measuring = false;
let onFrameEnd: ((end: number) => void) | null = null;
const channel = new MessageChannel();
channel.port1.onmessage = () => onFrameEnd?.(now());

const STAGES = ["animation.Timeline", "animation.Gather", "animation.Evaluate", "animation.Apply"] as const;
const LATE_SCRIPTS = "engine.LateUpdateScripts";
const probe = (name: Mark, after: readonly string[], before: readonly string[], last = false) =>
  defineSystem({
    name: `bench.${name}`,
    phase: "lateUpdate",
    after,
    before,
    run() {
      marks[name] = now();
      if (last && measuring) {
        channel.port2.postMessage(0);
        requestAnimationFrame(() => (frameStart = now()));
      }
    },
  });
probe("p0", [], [STAGES[0]]);
probe("p1", [STAGES[0]], [STAGES[1]]);
probe("p2", [STAGES[1]], [STAGES[2]]);
probe("p3", [STAGES[2]], [STAGES[3]]);
probe("p4", [STAGES[3]], [LATE_SCRIPTS], true);

interface Row {
  timeline: number;
  gather: number;
  evaluate: number;
  apply: number;
  animation: number;
  rest: number;
  step: number;
  interval: number;
}

function summary(rows: readonly Row[]): Record<keyof Row, { mean: number; median: number; p95: number }> {
  const out = {} as Record<keyof Row, { mean: number; median: number; p95: number }>;
  for (const key of Object.keys(rows[0]) as (keyof Row)[]) {
    const v = rows.map((r) => r[key]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const mean = v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
    out[key] = { mean, median: v[Math.floor(v.length / 2)] ?? NaN, p95: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] ?? NaN };
  }
  return out;
}

// --- Scenarios ------------------------------------------------------------------------------------------------------

const SKELETON = "asset:anim/humanoid80.skel";
const CLIPS = { idle: "asset:anim/idle.anim", walk: "asset:anim/walk.anim", run: "asset:anim/run.anim" };
const BODY = "asset:models/body.gltf#Body";

interface Built {
  animators: Animator[];
  /** Called every update with the seconds since the scene was built and the frame's dt (scenarios that drive parameters). */
  update?: (time: number, dt: number) => void;
  /** Whether `state(0)` names a state (graphs with a state machine, the implicit graph); false: no count is reported. */
  hasState?: boolean;
  note: string;
}

/** A grid position for item `i` of `n`, spaced `gap` metres, centred on the origin. */
function grid(i: number, n: number, gap: number): Vector3 {
  const side = Math.ceil(Math.sqrt(n));
  return new Vector3((i % side - (side - 1) / 2) * gap, 0, (Math.floor(i / side) - (side - 1) / 2) * gap);
}

/** How a character's body is drawn: skinned (GPU skinning), the same mesh static (a MeshRenderer: the per-mesh draw cost without skinning), or not at all. */
type Body = "skinned" | "static" | "none";

function character(name: string, at: Vector3, init: Record<string, unknown>, body: Body, skeleton = SKELETON): Animator {
  const node = GameObject.create(name);
  node.transform!.position = at;
  node.addComponent(Skeleton, { skeleton });
  const animator = node.addComponent(Animator, { cullingMode: "always", lodMetric: "off", ...init });
  if (body === "skinned") GameObject.create(`${name} Body`, { parent: node }).addComponent(SkinnedMeshRenderer, { mesh: BODY });
  else if (body === "static") GameObject.create(`${name} Body`, { parent: node }).addComponent(MeshRenderer, { mesh: BODY });
  return animator;
}

/** ADR 0370's character budget scene (bench_budgets.mjs `locomotion_rig_80`): the locomotion graph, grounder and look-at. */
function characters(graph: string, rig: boolean, skin: Body): Built {
  const n = num("n", 100);
  const look = GameObject.create("Look Target");
  const animators: Animator[] = [];
  for (let i = 0; i < n; i++) {
    const at = grid(i, n, 2);
    const a = character(`Character ${i}`, at, { graph }, skin);
    // anim-bench's loco_commands: moving, a spread of blend-space positions and speeds, the slot looping half a second of run.
    a.set("moving", true);
    a.set("x", (i % 10) / 10);
    a.set("y", 0.5 + (i % 5) / 10);
    a.set("speed", 1 + (i % 3));
    void a.play(CLIPS.run, { slot: "UpperBody", fade: 0.1, section: { start: 0, end: 0.5 }, loop: true });
    if (rig) a.ik("Look").target(look);
    animators.push(a);
  }
  look.transform!.position = new Vector3(1.5, 1.6, 2);
  return { animators, note: `${n} characters, 80 bones, ${rig ? "locomotion graph + grounder + look-at" : "locomotion graph"}${skin === "skinned" ? ", skinned meshes" : skin === "static" ? ", the same meshes static (MeshRenderer)" : ", no meshes"}` };
}

/** Many Animators on the implicit graph, each playing one clip (bench_budgets.mjs `one_clip_80`). */
function clips(): Built {
  const n = num("n", 300);
  const animators: Animator[] = [];
  for (let i = 0; i < n; i++) animators.push(character(`Clip ${i}`, grid(i, n, 2), { defaultClip: CLIPS.walk }, "none"));
  return { animators, note: `${n} clip players (implicit graph, walk), 80 bones, no meshes` };
}

/** 1,000 tweens: half Transform positions (vec3, eased, yoyo), half rotations (quaternion slerp), endless. */
function tweens(): Built {
  const n = num("n", 1000);
  for (let i = 0; i < n; i++) {
    const node = GameObject.create(`Tween ${i}`);
    const t = node.transform!;
    t.position = grid(i, n, 0.5);
    if (i % 2 === 0) void tween(t, "position", [0, 1, 0], { relative: true, duration: 1 + (i % 7) / 10, ease: "inOutSine", loops: -1, loopMode: "yoyo" });
    else void tween(t, "rotation", [0, 0.7071068, 0, 0.7071068], { duration: 1.5, ease: "linear", loops: -1, loopMode: "yoyo" });
  }
  return { animators: [], note: `${n} endless tweens (half vec3 eased yoyo, half quaternion)` };
}

/** A looping timeline animating the position and scale of 100 child nodes (200 vec3 tracks). */
function timeline(): Built {
  const director = GameObject.create("Director");
  director.addComponent(TimelineDirector, { timeline: "asset:timelines/bench.timeline.json", playOnStart: true, wrapMode: "loop" });
  for (let i = 0; i < 100; i++) GameObject.create(`T${i}`, { parent: director });
  return { animators: [], note: "one looping timeline, 100 nodes, 200 vec3 tracks (position, scale)" };
}

/** Motion matching (bench_budgets.mjs `match_kd`): 20 characters on the synthetic 30-minute database, simulated controllers. */
function matching(): Built {
  const n = num("n", 20);
  const graph = params.get("graph") ?? "asset:graphs/match_kd.animgraph.json";
  const animators: Animator[] = [];
  for (let i = 0; i < n; i++) animators.push(character(`Matcher ${i}`, grid(i, n, 3), { graph }, "none", "asset:match/match.skel"));
  const home = animators.map((a) => a.node.transform!.position.clone());
  const pos = animators.map(() => [0, 0]);
  const vel = animators.map(() => [0, 0]);
  const yaw = animators.map(() => 0);
  const desiredYaw = animators.map(() => 0);
  const SPEEDS = [0, 1.2, 3.5, 1.5, 0, 2.5, 4, 1];
  // anim-bench's desired_velocity and Matchers::frame, ported to the frame's real dt. The host fills the graph's
  // position, yaw and velocity from the node's own motion (no CharacterController here), so the controller moves the
  // node and code sets only the desired velocity and yaw, as a game does.
  const update = (time: number, dt: number) => {
    const k = Math.min(dt * 4, 1);
    animators.forEach((a, i) => {
      const speed = SPEEDS[(Math.floor(time / 2) + i) % 8];
      const angle = i * 0.7 + time * (i % 2 === 0 ? 0.4 : -0.4);
      const desired = [speed * Math.sin(angle), speed * Math.cos(angle)];
      for (let c = 0; c < 2; c++) {
        vel[i][c] += (desired[c] - vel[i][c]) * k;
        pos[i][c] += vel[i][c] * dt;
      }
      const [vx, vz] = vel[i];
      if (vx * vx + vz * vz > 0.01) {
        const tau = Math.PI * 2;
        const turn = ((((Math.atan2(vx, vz) - yaw[i] + Math.PI) % tau) + tau) % tau) - Math.PI;
        yaw[i] += Math.max(-4 * dt, Math.min(4 * dt, turn));
      }
      if (desired[0] !== 0 || desired[1] !== 0) desiredYaw[i] = Math.atan2(desired[0], desired[1]);
      const t = a.node.transform!;
      t.position = new Vector3(home[i].x + pos[i][0], 0, home[i].z + pos[i][1]);
      t.rotation = new Quaternion(0, Math.sin(yaw[i] / 2), 0, Math.cos(yaw[i] / 2));
      a.set("desired", new Vector2(desired[0], desired[1]));
      a.set("desiredYaw", desiredYaw[i]);
    });
  };
  return { animators, update, hasState: false, note: `${n} characters, motion matching (${graph.includes("_bf") ? "brute force" : "KD-tree"}), 54,000-frame database, search every 6 frames` };
}

function build(): Built {
  switch (SCENARIO) {
    case "characters": return characters("asset:graphs/loco_rig.animgraph.json", true, "skinned");
    case "characters_static": return characters("asset:graphs/loco_rig.animgraph.json", true, "static");
    case "characters_noskin": return characters("asset:graphs/loco_rig.animgraph.json", true, "none");
    case "locomotion": return characters("asset:graphs/loco.animgraph.json", false, "none");
    case "clips": return clips();
    case "tweens": return tweens();
    case "timeline": return timeline();
    case "matching": return matching();
    default: return { animators: [], note: "empty scene (probe overhead and the bare frame)" };
  }
}

// --- The run --------------------------------------------------------------------------------------------------------

@behavior("bench.AnimBench")
export class AnimBench extends GameBehavior {
  private built: Built | null = null;
  private elapsed = 0;
  private warmed = 0;
  private readonly rows: Row[] = [];
  private lastStart = 0;
  private done = false;

  start(): void {
    if (!CAMERA) GameObject.findObjectOfType(Camera)?.node.setActive(false);
    this.built = build();
  }

  update(): void {
    if (!this.built || this.done) return;
    this.built.update?.(this.elapsed, Time.deltaTime);
    this.elapsed += Time.deltaTime;
    if (this.elapsed < SETTLE) return;
    if (!measuring) {
      measuring = true;
      onFrameEnd = (end) => this.record(end);
    }
  }

  private record(end: number): void {
    if (this.done) return;
    const start = frameStart;
    const row: Row = {
      timeline: marks.p1 - marks.p0,
      gather: marks.p2 - marks.p1,
      evaluate: marks.p3 - marks.p2,
      apply: marks.p4 - marks.p3,
      animation: marks.p4 - marks.p0,
      rest: end - marks.p4,
      step: start > 0 && start <= marks.p0 ? end - start : NaN,
      interval: this.lastStart > 0 && start > this.lastStart ? start - this.lastStart : NaN,
    };
    this.lastStart = start;
    if (this.warmed++ < WARM) return;
    if (this.rows.length === 0) {
      countsAtStart = counts?.snapshot() ?? null;
      (globalThis as { __animBenchMeasuring?: boolean }).__animBenchMeasuring = true; // run.mjs --profile starts its profiler here
    }
    this.rows.push(row);
    if (this.rows.length < FRAMES) return;
    this.done = true;
    measuring = false;
    const animators = this.built!.animators;
    const playing = this.built!.hasState === false ? null : animators.filter((a) => a.state(0).name !== "").length;
    console.log(`[anim-bench] ${JSON.stringify({ scenario: SCENARIO, note: this.built!.note, camera: CAMERA, frames: this.rows.length, warm: WARM, animators: animators.length, playing, stats: summary(this.rows), ...(counts && { counts: { contexts: [...new Set(counts.info.contexts)], skinning: counts.info.skinning, perFrame: countsPerFrame(this.rows.length) } }) })}`);
  }
}
