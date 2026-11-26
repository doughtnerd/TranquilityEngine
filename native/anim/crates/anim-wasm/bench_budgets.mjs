#!/usr/bin/env node
// ADR 0370's budget scenarios on the committed wasm in Node (T82r). The budgets are tripwires; this prints, asserts nothing.
//
//   node native/anim/crates/anim-wasm/bench_budgets.mjs [--rounds N] [--frames N] [--only substring] [--regen] [--compare FILE]
//     [--characters N] [--max-instances N] [--max-bones N] [--gap MS] [--busy MS] [--prime]
//
// `--characters N` (default 100) sets the character scenarios' instance count, and `--max-instances`/`--max-bones` the
// core's INIT limits (defaults 128 and the skeleton's bones rounded up): the shipped player starts the core with 512
// instances and 256 bones (DEFAULT_CORE_LIMITS), so `--characters 300 --max-instances 512 --max-bones 256` measures the
// player's 300-clip scene's core work alone.
//
// `--gap MS` waits MS milliseconds before each timed frame (a timer, as a page's frame loop leaves the thread idle
// between frames) and times the frames alone: back-to-back frames (the default) measure the core with a busy CPU and
// warm caches, spaced ones what a 60 Hz host sees.
//
// `--compare FILE` also runs another build of the module (same exports, e.g. the committed one saved before a change)
// in alternate rounds and prints both medians and their ratio: an A/B on a shared, noisy machine.
//
// Scenarios (each `write_inputs` + `evaluate` per frame, as a host runs them):
// - characters, 100 instances, 60 bones (the committed fixtures, as bench.mjs) and 80 bones (the budget skeleton): one clip,
//   a crossfade of two, the locomotion graph (a state machine with a 2D blend space of 3 clips, synced and speed-scaled,
//   under an upper-body slot looping a section, under an inertialization node), and `locomotion + rig`, the budget
//   scenario (the same graph plus a two-foot grounder, its rays answered each frame on flat ground, and a look-at on the
//   neck and head): tripwire 1.5 ms;
// - motion matching, 20 characters on a synthetic 30-minute database (54,000 frames, 180 raw clips over anim-match's
//   8-bone skeleton), searching every 6 frames by KD-tree or brute force, each driven by a simulated controller: 0.6 ms;
// - 1,000 tweens (linear floats; every easing, half yoyo; half vec3, half quaternion slerp): 0.2 ms.
//
// Each scenario runs in its own Node process per round (`--rounds`, default 5): after a warm-up, the mean of `--frames`
// frames (default 300; matching 600). Printed: the median of the rounds and their range. The 80-bone and matching files
// are generated (never committed) by `cargo run --release -p anim-bench --example fixtures` into native/anim/target/
// bench-fixtures/ the first time (or with --regen), so this needs the Rust toolchain once.
//
// Records are encoded from the generated wire definitions (src/plugins/animation/runtime/wasm/wire/*.ts, imported with
// Node's type stripping, Node 22.18+), so a family's version or layout change reaches the bench with the core.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmDir = new URL("../../../../src/plugins/animation/runtime/wasm/", import.meta.url);
const animRoot = fileURLToPath(new URL("../../", import.meta.url));
const genDir = new URL("../../target/bench-fixtures/", import.meta.url);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const SCENARIOS = [
  "one_clip_60", "crossfade_60", "locomotion_60", "locomotion_rig_60",
  "one_clip_80", "crossfade_80", "locomotion_80", "locomotion_rig_80",
  "match_kd", "match_bf",
  "tweens_linear", "tweens_eased", "tweens_vec_quat",
];
const TRIPWIRE = { locomotion_rig_80: 1.5, match_kd: 0.6, match_bf: 0.6, tweens_linear: 0.2, tweens_eased: 0.2, tweens_vec_quat: 0.2 };

if (opt("child", null) !== null) {
  await child(opt("child"), Number(opt("frames", 0)));
} else {
  parent();
}

function parent() {
  const rounds = Number(opt("rounds", 5));
  const only = opt("only", "");
  if (args.includes("--regen") || !existsSync(new URL("bench.json", genDir))) {
    console.log("generating bench fixtures (cargo run --release -p anim-bench --example fixtures)...");
    execFileSync("cargo", ["run", "--release", "-q", "-p", "anim-bench", "--example", "fixtures", "--", fileURLToPath(genDir)], { cwd: animRoot, stdio: "inherit" });
  }
  const compare = opt("compare", null);
  const builds = [fileURLToPath(new URL("myco_anim_bg.wasm", wasmDir)), ...(compare ? [compare] : [])];
  console.log(`wasm: ${builds.map((b) => `${b} (${statSync(b).size} bytes)`).join(" vs ")}; ${rounds} rounds per scenario, one Node process each`);
  const stats = (ms) => {
    ms.sort((a, b) => a - b);
    const median = ms[Math.floor(ms.length / 2)];
    return { median, text: `median ${median.toFixed(3)} ms  range ${ms[0].toFixed(3)}–${ms[ms.length - 1].toFixed(3)} (${(((ms[ms.length - 1] - ms[0]) / median) * 100).toFixed(0)}%)` };
  };
  for (const name of SCENARIOS.filter((s) => s.includes(only))) {
    const frames = Number(opt("frames", name.startsWith("match") ? 600 : name.startsWith("tweens") ? 2000 : 300));
    const ms = builds.map(() => []);
    let note = "";
    for (let r = 0; r < rounds; r++) {
      builds.forEach((wasm, b) => {
        const pass = ["characters", "max-instances", "max-bones", "gap", "busy"].flatMap((k) => (opt(k, null) === null ? [] : [`--${k}`, opt(k)])).concat(args.includes("--prime") ? ["--prime"] : []);
        const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--child", name, "--frames", String(frames), "--wasm", wasm, ...pass], { encoding: "utf8" });
        const line = JSON.parse(out.trim().split("\n").pop());
        ms[b].push(line.ms);
        note = line.note ?? "";
      });
    }
    const [a, b] = ms.map(stats);
    const wire = TRIPWIRE[name] ? `  (tripwire ${TRIPWIRE[name]} ms: ${a.median <= TRIPWIRE[name] ? "under" : "OVER"})` : "";
    console.log(`${name.padEnd(18)} ${a.text}${wire}${note ? `  ${note}` : ""}`);
    if (b) console.log(`${"  compare".padEnd(18)} ${b.text}  this/compare ${(a.median / b.median).toFixed(3)}`);
  }
}

async function child(name, frames) {
  const glue = await import(new URL("myco_anim.js", wasmDir).href);
  const wire = async (family) => import(new URL(`wire/${family}.ts`, wasmDir).href);
  const { INIT, PLAY } = await wire("core");
  const { SET_PARAM, SLOT_PLAY, SECTION_LOOP } = await wire("graph");
  const { TWEEN_CREATE, KIND_VALUE, KIND_QUAT_SLERP, FLAG_YOYO, LOOPS_INFINITE, TIME_SCALED } = await wire("tween");
  const exports = glue.initSync({ module: readFileSync(opt("wasm", fileURLToPath(new URL("myco_anim_bg.wasm", wasmDir)))) });
  const committed = (n) => new Uint8Array(readFileSync(new URL(`fixtures/${n}`, wasmDir)));
  const generated = (n) => new Uint8Array(readFileSync(new URL(n, genDir)));
  const view = () => new DataView(exports.memory.buffer);
  // Allocation-free, as the shipped host encodes (so the bench's own JS doesn't inflate the per-frame time).
  const bitsF32 = new Float32Array(1);
  const bitsU32 = new Uint32Array(bitsF32.buffer);
  const f32bits = (x) => ((bitsF32[0] = x), bitsU32[0]);
  const fieldLists = new Map();
  /** Writes record `def` (a generated wire definition) at `at` in `v`: its header, then `values` by field name (unnamed fields 0). */
  const put = (v, at, def, values) => {
    v.setUint16(at, def.opcode, true);
    v.setUint16(at + 2, def.version, true);
    let fields = fieldLists.get(def);
    if (!fields) fieldLists.set(def, (fields = Object.entries(def.fields)));
    for (const [field, { offset, type }] of fields) {
      const x = values[field] ?? 0;
      if (type === "f32") v.setFloat32(at + offset, x, true);
      else if (type === "u32") v.setUint32(at + offset, x >>> 0, true);
      else if (type === "i32") v.setInt32(at + offset, x, true);
      else throw new Error(`${def.opcode.toString(16)}.${field}: field type ${type} not handled`);
    }
    return at + def.stride;
  };
  const record = (def, values) => {
    const bytes = new Uint8Array(def.stride);
    put(new DataView(bytes.buffer), 0, def, values);
    return bytes;
  };
  const init = (maxInstances, maxBones) => glue.init(record(INIT, { maxInstances, maxBones, arenaInitialBytes: 1 << 22 }));
  // Writes records into the command buffer and applies them.
  const send = (records) => {
    const mem = new Uint8Array(exports.memory.buffer);
    let at = glue.commands_ptr();
    const start = at;
    for (const r of records) {
      mem.set(r, at);
      at += r.length;
    }
    return glue.write_inputs(at - start);
  };
  const setParam = (instance, param, paramType, w0, w1 = 0) => record(SET_PARAM, { instance, param, paramType, w0, w1 });
  const dt = 1 / 60;
  let step = () => {
    glue.write_inputs(0);
    glue.evaluate(0, 0, dt, dt);
  };
  let note;
  let warm = 30;

  if (name.startsWith("tweens")) {
    init(8, 64);
    glue.tweens_configure(2048);
    for (let i = 0; i < 1000; i++) {
      const [valueKind, width, ease, flags] =
        name === "tweens_linear"
          ? [KIND_VALUE, 1, 0, 0]
          : name === "tweens_eased"
            ? [KIND_VALUE, 1, i % 31, i % 2 ? FLAG_YOYO : 0]
            : i % 2
              ? [KIND_QUAT_SLERP, 4, 15, 0]
              : [KIND_VALUE, 3, 6, 0];
      glue.tween_create(
        record(TWEEN_CREATE, {
          world: 0, hostId: i, column: i, valueKind, width, ease, flags, timeMode: TIME_SCALED, loops: LOOPS_INFINITE,
          duration: 1.5, delay: 0, speed: 1, from0: 0, from1: 0, from2: 0, from3: 1, to0: 1, to1: 2, to2: 3, to3: 1,
        }),
      );
    }
    warm = 200;
  } else if (name.startsWith("match")) {
    const ids = JSON.parse(readFileSync(new URL("bench.json", genDir), "utf8")).match;
    init(64, 16);
    const skel = glue.load_skeleton(generated("match.skel"));
    const db = glue.posedb_load(generated("match.posedb"));
    if (db === 0) throw new Error(`posedb_load refused (${glue.last_status()})`);
    for (let i = 0; i < ids.clips; i++) {
      const clip = glue.load_clip(generated(glue.posedb_clip(db, i)));
      if (glue.posedb_bind(db, i, clip) !== 0) throw new Error(`posedb_bind ${i} refused`);
    }
    const g = glue.load_graph(generated(name === "match_bf" ? "match_bf.animgraph" : "match_kd.animgraph"));
    glue.graph_bind(g, ids.db, db);
    const n = 20;
    const hs = Array.from({ length: n }, () => glue.create_instance(0, skel, g));
    const pos = hs.map(() => [0, 0]);
    const vel = hs.map(() => [0, 0]);
    const yaw = hs.map(() => 0);
    const desiredYaw = hs.map(() => 0);
    let frame = 0;
    // anim-bench's scenario::desired_velocity and Matchers::frame, ported.
    const desired = (i, f) => {
      const phase = (Math.floor(f / 120) + i) % 8;
      const speed = [0, 1.2, 3.5, 1.5, 0, 2.5, 4, 1][phase];
      const angle = i * 0.7 + f * dt * (i % 2 === 0 ? 0.4 : -0.4);
      return [speed * Math.sin(angle), speed * Math.cos(angle)];
    };
    step = () => {
      const k = Math.min(dt * 4, 1);
      // SET_PARAM records written straight into the command buffer, as a host does.
      const v = view();
      const start = glue.commands_ptr();
      let at = start;
      const param = (instance, p, paramType, x, y) => {
        at = put(v, at, SET_PARAM, { instance, param: p, paramType, w0: f32bits(x), w1: f32bits(y) });
      };
      hs.forEach((h, i) => {
        const d = desired(i, frame);
        for (let a = 0; a < 2; a++) {
          vel[i][a] += (d[a] - vel[i][a]) * k;
          pos[i][a] += vel[i][a] * dt;
        }
        const [vx, vz] = vel[i];
        if (vx * vx + vz * vz > 0.01) {
          const tau = 2 * Math.PI;
          const turn = ((((Math.atan2(vx, vz) - yaw[i] + Math.PI) % tau) + tau) % tau) - Math.PI;
          yaw[i] += Math.max(-4 * dt, Math.min(4 * dt, turn));
        }
        if (d[0] !== 0 || d[1] !== 0) desiredYaw[i] = Math.atan2(d[0], d[1]);
        param(h, ids.position, 3, pos[i][0], pos[i][1]);
        param(h, ids.yaw, 0, yaw[i], 0);
        param(h, ids.velocity, 3, vel[i][0], vel[i][1]);
        param(h, ids.desired, 3, d[0], d[1]);
        param(h, ids.desiredYaw, 0, desiredYaw[i], 0);
      });
      const applied = glue.write_inputs(at - start);
      if (applied !== hs.length * 5) throw new Error(`${applied} of ${hs.length * 5} parameter commands applied`);
      glue.evaluate(0, 0, dt, dt);
      frame++;
    };
    warm = 60;
    note = `(${ids.frames} database frames, ${ids.clips} clips)`;
  } else {
    // Characters: [scenario]_[bones].
    const bones = Number(name.slice(-2));
    const kind = name.slice(0, -3);
    const file = bones === 60 ? (n) => committed(`humanoid${n}`) : (n) => generated(`humanoid80${n}`);
    const count = Number(opt("characters", 100));
    init(Number(opt("max-instances", Math.max(128, count))), Number(opt("max-bones", bones === 60 ? 64 : 80)));
    const skel = glue.load_skeleton(file(".skel"));
    const idle = glue.load_clip(file("_idle.anim"));
    const walk = glue.load_clip(file("_walk.anim"));
    const run = glue.load_clip(file("_run.anim"));
    const mask = glue.load_mask(new Float32Array(Array.from({ length: bones }, (_, i) => (i >= 3 && i < 33 ? 1 : 0))));
    let graph = 0;
    if (kind.startsWith("locomotion")) {
      const rig = kind === "locomotion_rig";
      graph = glue.load_graph(bones === 60 ? committed(rig ? "loco_rig.animgraph" : "loco.animgraph") : generated(rig ? "loco_rig.animgraph" : "loco.animgraph"));
      if (glue.last_status() !== 0) throw new Error(`graph refused (${glue.last_status()})`);
      const b = bones === 60 ? JSON.parse(readFileSync(new URL("fixtures/graph_expected.json", wasmDir), "utf8")).binds : JSON.parse(readFileSync(new URL("bench.json", genDir), "utf8")).loco;
      for (const [id, asset] of [[b.idle, idle], [b.walk, walk], [b.run, run], [b.upper, mask]]) glue.graph_bind(graph, id, asset);
    }
    const hs = Array.from({ length: count }, () => glue.create_instance(0, skel, graph));
    const play = (clip, fade) => send(hs.map((instance) => record(PLAY, { instance, clip, playId: 0, layer: 0, fade, speed: 1, start: 0, flags: 0 })));
    if (kind === "one_clip" || kind === "crossfade") {
      play(walk, 0);
      if (kind === "crossfade") {
        for (let i = 0; i < 30; i++) step();
        play(run, 1000); // a 1000 s fade: both clips stay sampled and blended for the whole run
      }
    } else {
      // x, y, speed, moving are parameters 0..3 (anim-wasm/tests/common/graph.rs `locomotion`).
      const applied = send(
        hs.flatMap((h, i) => [
          setParam(h, 3, 2, 1),
          setParam(h, 0, 0, f32bits((i % 10) / 10)),
          setParam(h, 1, 0, f32bits(0.5 + (i % 5) / 10)),
          setParam(h, 2, 0, f32bits(1 + (i % 3))),
          record(SLOT_PLAY, { instance: h, slot: 0, clip: run, playId: 0, blendIn: 0.1, blendOut: 0.1, speed: 1, start: 0, end: 0.5, flags: SECTION_LOOP }),
        ]),
      );
      if (applied !== count * 5) throw new Error(`${applied} of ${count * 5} graph commands applied`);
    }
    if (kind === "locomotion_rig") {
      // Target slot 0 (the look-at's), then each frame the hits for last frame's rays: flat ground at y = 0.
      const r = await wire("rig");
      for (const h of hs) {
        const row = glue.rig_inputs_ptr() + (h & 0xffff) * r.RIG_INPUT_STRIDE + r.RIG_TARGETS + r.TARGET_STRIDE * 0;
        const at = [[r.TARGET_POSITION, 1.5], [r.TARGET_POSITION + 4, 1.6], [r.TARGET_POSITION + 8, 2.0], [r.TARGET_POSITION_WEIGHT, 1], [r.TARGET_ROTATION_WEIGHT, 1]];
        for (const [o, x] of at) view().setFloat32(row + o, x, true);
      }
      step = () => {
        const v = view();
        for (const h of hs) {
          const i = h & 0xffff;
          const rays = glue.rig_rays_ptr() + i * r.RAY_ROW_STRIDE;
          const hits = glue.rig_inputs_ptr() + i * r.RIG_INPUT_STRIDE + r.RIG_HITS;
          for (let k = 0; k < 2; k++) {
            const ray = rays + k * r.RAY_STRIDE + r.RAY_ORIGIN;
            const hit = hits + k * r.HIT_STRIDE;
            v.setFloat32(hit + r.HIT_POINT, v.getFloat32(ray, true), true);
            v.setFloat32(hit + r.HIT_POINT + 4, 0, true);
            v.setFloat32(hit + r.HIT_POINT + 8, v.getFloat32(ray + 8, true), true);
            v.setFloat32(hit + r.HIT_NORMAL + 4, 1, true);
            v.setUint32(hit + r.HIT_FLAGS, v.getUint32(rays + k * r.RAY_STRIDE + r.RAY_FLAGS, true) & r.RAY_VALID ? r.HIT_VALID : 0, true);
          }
        }
        glue.write_inputs(0);
        glue.evaluate(0, 0, dt, dt);
      };
    }
  }
  for (let i = 0; i < warm; i++) step();
  const gap = Number(opt("gap", 0));
  const busy = Number(opt("busy", 0));
  const prime = args.includes("--prime");
  let ms = 0;
  let sink = 0;
  if (gap > 0 || busy > 0) {
    for (let i = 0; i < frames; i++) {
      if (gap > 0) await new Promise((done) => setTimeout(done, gap));
      // Arithmetic until `busy` ms pass (not a sleep: the core stays loaded), its result kept so it isn't optimised away.
      for (const until = performance.now() + busy; performance.now() < until; ) for (let k = 0; k < 1000; k++) sink += Math.sqrt(k + sink) * 1e-9;
      if (prime) step();
      const t0 = performance.now();
      step();
      ms += (performance.now() - t0) / frames;
    }
  } else {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) step();
    ms = (performance.now() - t0) / frames;
  }
  console.log(JSON.stringify({ ms, note, ...(sink < 0 ? { sink } : {}) }));
}
