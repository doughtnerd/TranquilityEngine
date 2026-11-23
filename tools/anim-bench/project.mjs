// Writes the animation bench's project (T82) into a folder: project.json, one scene, the game script (game/bench.ts) and
// the assets its scenarios use. The binary animation files come from anim-bench's fixture generator (the same files
// native/anim/crates/anim-wasm/bench_budgets.mjs runs: the 80-bone humanoid with idle/walk/run, and the synthetic
// 30-minute pose database with its 180 clips and 8-bone skeleton); the rest is written here:
//
// - graphs (`myco.animgraph-source@1`): T31's locomotion graph and the budget graph (plus T40's grounder and look-at),
//   mirroring anim-bench's `loco_graph`/`add_rig`; the KD-tree and brute-force matching graphs (`match_graph`);
// - the upper-body mask (bones 3–32, `upper_mask`);
// - a skinned glTF (`models/body.gltf`): one small box per bone, skinned to the humanoid's bones in its order, so a
//   SkinnedMeshRenderer draws a character through the GPU skinning path;
// - a timeline of 200 vec3 tracks over 100 nodes.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** The locomotion graph (T31, `loco.animgraph.json`), with T40's rig stack when `rig` (ADR 0370's budget scenario). */
function locoGraph(rig) {
  const nodes = [
    { id: "idle", family: "sources", kind: "clipPlayer", params: { clip: "asset:anim/idle.anim" } },
    { id: "walk", family: "sources", kind: "clipPlayer", params: { clip: "asset:anim/walk.anim" } },
    { id: "run", family: "sources", kind: "clipPlayer", params: { clip: "asset:anim/run.anim" } },
    { id: "idleSample", family: "sources", kind: "clipPlayer", params: { clip: "asset:anim/idle.anim" } },
    { id: "jump", family: "sources", kind: "clipPlayer", params: { clip: "asset:anim/run.anim", speed: 1.5, loop: "once" } },
    {
      id: "move", family: "sources", kind: "blendSpace2D", inputs: ["idleSample", "walk", "run"],
      params: { x: "x", y: "y", speed: "speed", glideMs: 150, sync: true, speedScale: true, coords: [0, 0, 0, 1, 1, 1] },
    },
    {
      id: "machine", family: "logic", kind: "stateMachine",
      machine: {
        entry: "Idle",
        states: [
          { name: "Idle", root: "idle", transitions: [{ to: "Locomotion", if: { param: "moving", op: "==", value: true }, how: "crossfade", duration: 0.2, shape: "smoothstep" }] },
          { name: "Locomotion", root: "move", transitions: [{ to: "Idle", if: { param: "moving", op: "==", value: false }, how: "inertialize", duration: 0.25 }] },
          { name: "Jump", root: "jump", transitions: [{ to: "Locomotion", when: "exit", duration: 0.15 }] },
        ],
        anyState: [{ to: "Jump", if: { request: "Jump" }, how: "inertialize", duration: 0.2 }],
      },
    },
    { id: "upper", family: "slots", kind: "slot", inputs: ["machine"], params: { mask: "asset:masks/upper.mask.json" }, slot: { name: "UpperBody" } },
    { id: "loco", family: "mixing", kind: "inertialize", inputs: ["upper"] },
  ];
  let output = "loco";
  if (rig) {
    // anim-bench's add_rig: a two-foot grounder (pelvis 1, legs 52–54 and 56–58, LOD skip 2, default settings), then a
    // look-at on the neck (share 0.4, limit 0.8) and head (1, 1) fed by the "Look" target, max angle 1.2, LOD skip 1.
    nodes.push(
      { id: "grounder", family: "rig", kind: "grounder", inputs: ["loco"], params: { lodSkip: 2, pelvis: 1, up: [0, 1, 0], legs: [52, 53, 54, 56, 57, 58] } },
      { id: "look", family: "rig", kind: "lookAt", inputs: ["grounder"], params: { lodSkip: 1, target: "Look", upWeight: 0, maxAngle: 1.2, forward: [0, 0, 1], up: [0, 1, 0], bones: [5, 6], shares: [0.4, 1], limits: [0.8, 1] } },
    );
    output = "look";
  }
  return {
    format: "myco.animgraph-source@1",
    output,
    parameters: [
      { name: "x", type: "float" },
      { name: "y", type: "float" },
      { name: "speed", type: "float", default: 1 },
      { name: "moving", type: "bool" },
    ],
    nodes,
  };
}

/** anim-bench's match_graph: INERTIALIZE(POSE_DATABASE) searching every 6 frames (force 1e30: exactly every interval). */
function matchGraph(bruteForce) {
  return {
    format: "myco.animgraph-source@1",
    output: "out",
    parameters: [
      { name: "position", type: "vec2" },
      { name: "yaw", type: "float" },
      { name: "velocity", type: "vec2" },
      { name: "desired", type: "vec2" },
      { name: "desiredYaw", type: "float" },
      { name: "lod", type: "int", default: 1 },
    ],
    nodes: [
      {
        id: "match", family: "matching", kind: "poseDatabase",
        params: {
          database: "asset:match/match.posedb.bin", bruteForce, interval: 6, force: 1e30, bias: 0.1, minSwitch: 0.2, neighbours: 6,
          velocityHalfLife: 0.3, facingHalfLife: 0.2, blend: 0.2,
          position: "position", yaw: "yaw", velocity: "velocity", desiredVelocity: "desired", desiredYaw: "desiredYaw", lod: "lod",
        },
      },
      { id: "out", family: "mixing", kind: "inertialize", inputs: ["match"] },
    ],
  };
}

/** A glTF 2.0 file (buffers inline) with one mesh, "Body": a box per bone, each vertex fully on its bone. */
function skinnedBody(info) {
  const n = info.bones;
  const HALF = 0.04;
  const corners = [];
  for (let k = 0; k < 8; k++) corners.push([k & 1 ? HALF : -HALF, k & 2 ? HALF : -HALF, k & 4 ? HALF : -HALF]);
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const positions = new Float32Array(n * 8 * 3);
  const joints = new Uint16Array(n * 8 * 4);
  const weights = new Float32Array(n * 8 * 4);
  const indices = new Uint16Array(n * 36);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let b = 0; b < n; b++) {
    const m = info.restModel.subarray(b * 12, b * 12 + 12);
    const origin = [m[3], m[7], m[11]];
    for (let k = 0; k < 8; k++) {
      const v = b * 8 + k;
      for (let c = 0; c < 3; c++) {
        const p = origin[c] + corners[k][c];
        positions[v * 3 + c] = p;
        min[c] = Math.min(min[c], p);
        max[c] = Math.max(max[c], p);
      }
      joints[v * 4] = b;
      weights[v * 4] = 1;
    }
    faces.forEach((f, i) => indices.set([f[0], f[1], f[2], f[0], f[2], f[3]].map((k) => b * 8 + k), b * 36 + i * 6));
  }
  // Inverse bind matrices: the skeleton's row-major 3×4 as glTF's column-major 4×4.
  const ibm = new Float32Array(n * 16);
  for (let b = 0; b < n; b++) {
    const m = info.inverseBind.subarray(b * 12, b * 12 + 12);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) ibm[b * 16 + c * 4 + r] = r < 3 ? m[r * 4 + c] : c === 3 ? 1 : 0;
  }
  const parts = [positions, joints, weights, indices, ibm];
  const views = [];
  let offset = 0;
  const chunks = [];
  for (const p of parts) {
    const bytes = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
  }
  const buffer = Buffer.concat(chunks);
  const nodes = [];
  for (let b = 0; b < n; b++) {
    const r = info.rest.subarray(b * 10, b * 10 + 10);
    nodes.push({ name: info.names[b], translation: [r[0], r[1], r[2]], rotation: [r[3], r[4], r[5], r[6]], scale: [r[7], r[8], r[9]] });
  }
  for (let b = 0; b < n; b++) {
    const p = info.parents[b];
    if (p >= 0) (nodes[p].children ??= []).push(b);
  }
  nodes.push({ name: "Body", mesh: 0, skin: 0 });
  const roots = [...Array(n).keys()].filter((b) => info.parents[b] < 0);
  return {
    asset: { version: "2.0", generator: "myco anim-bench" },
    scene: 0,
    scenes: [{ nodes: [...roots, n] }],
    nodes,
    skins: [{ joints: [...Array(n).keys()], inverseBindMatrices: 4, skeleton: roots[0] }],
    meshes: [{ name: "Body", primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3 }] }],
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString("base64")}` }],
    bufferViews: views.map((v, i) => (i === 3 ? { ...v, target: 34963 } : i < 3 ? { ...v, target: 34962 } : v)),
    accessors: [
      { bufferView: 0, componentType: 5126, count: n * 8, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5123, count: n * 8, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: n * 8, type: "VEC4" },
      { bufferView: 3, componentType: 5123, count: n * 36, type: "SCALAR" },
      { bufferView: 4, componentType: 5126, count: n, type: "MAT4" },
    ],
  };
}

/** A looping 4 s timeline: each of 100 child nodes (T0–T99) bobs its position and pulses its scale, out of phase. */
function benchTimeline() {
  const tracks = [];
  for (let i = 0; i < 100; i++) {
    const nodePath = `T${i}`;
    const x = (i % 10) - 4.5;
    const z = Math.floor(i / 10) - 4.5;
    const lift = 0.5 + (i % 7) / 10;
    tracks.push({
      kind: "vec3", target: { nodePath, component: "engine.Transform", field: "position" },
      curves: [[[0, x]], [[0, 0], [1 + (i % 3) * 0.5, lift, "smooth"], [4, 0, "smooth"]], [[0, z]]],
    });
    tracks.push({
      kind: "vec3", target: { nodePath, component: "engine.Transform", field: "scale" },
      curves: [0, 1, 2].map(() => [[0, 1], [2, 1.5, "smooth"], [4, 1, "smooth"]]),
    });
  }
  return { format: "myco.timeline@1", name: "Bench", rate: 30, duration: 4, loop: true, tracks };
}

function scene() {
  const node = (id, name, components, extra = {}) => ({ id, name, ...extra, components });
  return {
    format: "myco.scene@5",
    settings: { physics: "3d" },
    nodes: [
      node("camera", "Camera", [
        { type: "engine.Transform", data: { position: [0, 22, -26], rotation: [0.3420201, 0, 0, 0.9396926] } },
        { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 55 } },
      ]),
      node("sun", "Sun", [
        { type: "engine.Transform", data: { position: [0, 8, 0], rotation: [0.4403775, -0.2667293, -0.1388505, 0.8459573] } },
        { type: "engine.Light", data: { type: "directional", intensity: 1.2 } },
      ]),
      // Flat ground at y = 0 for the grounder's foot rays (ADR 0370's scenario answers them on flat ground).
      node("ground", "Ground", [
        { type: "engine.Transform", data: { position: [0, -0.5, 0] } },
        { type: "engine.BoxCollider", data: { size: [400, 1, 400] } },
      ]),
      node("bench", "Animation Bench", [{ type: "bench.AnimBench", data: {} }], { transform: false }),
    ],
  };
}

/**
 * Writes the project into `dir` from anim-bench's fixtures in `fixtures` (its `--example fixtures` output) and
 * `info`, the 80-bone skeleton as `readSkeletonInfo` reads it.
 */
export function writeProject(dir, fixtures, info) {
  json(join(dir, "project.json"), {
    name: "anim-bench",
    display: { width: 960, height: 540, backgroundColor: "#101318" },
    time: { fixedDeltaTime: 1 / 60 },
    physics: { gravity: [0, -9.81], layers: ["Default"] },
    render: { sortingLayers: ["Default"], pixelsPerUnit: 100 },
    autoload: [],
  });
  json(join(dir, "scenes/main.scene.json"), scene());
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(join(here, "game/bench.ts"), join(dir, "scripts/bench.ts"));

  mkdirSync(join(dir, "anim"), { recursive: true });
  copyFileSync(join(fixtures, "humanoid80.skel"), join(dir, "anim/humanoid80.skel"));
  for (const c of ["idle", "walk", "run"]) copyFileSync(join(fixtures, `humanoid80_${c}.anim`), join(dir, `anim/${c}.anim`));
  json(join(dir, "masks/upper.mask.json"), {
    format: "myco.mask@1",
    entries: info.names.slice(3, 33).map((bone) => ({ bone, weight: 1, recursive: false })),
  });
  json(join(dir, "graphs/loco.animgraph.json"), locoGraph(false));
  json(join(dir, "graphs/loco_rig.animgraph.json"), locoGraph(true));
  json(join(dir, "graphs/match_kd.animgraph.json"), matchGraph(false));
  json(join(dir, "graphs/match_bf.animgraph.json"), matchGraph(true));
  json(join(dir, "models/body.gltf"), skinnedBody(info));
  json(join(dir, "timelines/bench.timeline.json"), benchTimeline());

  // The pose database lists its clips by bare name ("clip0.anim"), so they sit at the project root.
  mkdirSync(join(dir, "match"), { recursive: true });
  copyFileSync(join(fixtures, "match.skel"), join(dir, "match/match.skel"));
  copyFileSync(join(fixtures, "match.posedb"), join(dir, "match/match.posedb.bin"));
  for (const f of readdirSync(fixtures)) if (/^clip\d+\.anim$/.test(f)) copyFileSync(join(fixtures, f), join(dir, f));
  return JSON.parse(readFileSync(join(fixtures, "bench.json"), "utf8"));
}
