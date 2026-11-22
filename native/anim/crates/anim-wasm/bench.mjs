#!/usr/bin/env node
// Measures the committed animation core on wasm in Node (ADR 0340's budgets are tripwires): `evaluate` for 100
// instances of the 60-bone fixture humanoid, (a) all playing one clip, (b) all mid-crossfade between two clips,
// (c) T31: all running the locomotion graph (fixtures/loco.animgraph: a state machine with a 2D blend space of three
// clips, synced and speed-scaled, under an upper-body slot playing a one-shot, under an inertialization node), (d) T40:
// the same graph with a two-foot grounder (hits fed each frame from last frame's rays, the host's round trip) and a
// look-at on the neck and head (fixtures/loco_rig.animgraph; ADR 0340's budget scenario shape), plus the wasm's size. Prints the numbers; asserts nothing (wall-clock). Run: node native/anim/crates/anim-wasm/bench.mjs
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmDir = new URL("../../../../src/plugins/animation/runtime/wasm/", import.meta.url);
const glue = await import(new URL("myco_anim.js", wasmDir).href);
const exports = glue.initSync({ module: readFileSync(new URL("myco_anim_bg.wasm", wasmDir)) });
const fixture = (n) => new Uint8Array(readFileSync(new URL(`fixtures/${n}`, wasmDir)));

// INIT (anim-wire core, version 1): opcode 0x0101, version 1, maxInstances, maxBones, arenaInitialBytes.
const init = new DataView(new ArrayBuffer(16));
init.setUint16(0, 0x0101, true);
init.setUint16(2, 1, true);
init.setUint32(4, 128, true);
init.setUint32(8, 64, true);
init.setUint32(12, 1 << 22, true);
const reply = new DataView(glue.init(new Uint8Array(init.buffer)).buffer);
console.log(`memory needed for 128 instances x 64 bones: ${reply.getUint32(8, true)} bytes`);

const skel = glue.load_skeleton(fixture("humanoid.skel"));
const walk = glue.load_clip(fixture("humanoid_walk.anim"));
const run = glue.load_clip(fixture("humanoid_run.anim"));
const N = 100;
const handles = Array.from({ length: N }, () => glue.create_instance(0, skel, 0));

// PLAY records (opcode 0x0103, 36 bytes): instance, clip, playId, layer, fade, speed, start, flags.
function play(clip, fade) {
  const view = new DataView(exports.memory.buffer);
  let at = glue.commands_ptr();
  const start = at;
  for (const h of handles) {
    view.setUint16(at, 0x0103, true);
    view.setUint16(at + 2, 1, true);
    view.setUint32(at + 4, h, true);
    view.setUint32(at + 8, clip, true);
    view.setUint32(at + 12, 0, true);
    view.setUint32(at + 16, 0, true);
    view.setFloat32(at + 20, fade, true);
    view.setFloat32(at + 24, 1, true);
    view.setFloat32(at + 28, 0, true);
    view.setUint32(at + 32, 0, true);
    at += 36;
  }
  glue.write_inputs(at - start);
}

function measure(label, frames) {
  const dt = 1 / 60;
  for (let i = 0; i < 30; i++) {
    glue.write_inputs(0);
    glue.evaluate(0, 0, dt, dt);
  }
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    glue.write_inputs(0);
    glue.evaluate(0, 0, dt, dt);
  }
  const ms = (performance.now() - t0) / frames;
  console.log(`${label}: ${ms.toFixed(3)} ms per frame (${N} instances x 60 bones, mean of ${frames})`);
}

play(walk, 0);
measure("one clip", 300);
play(run, 1000); // a 1000 s fade: both clips stay sampled and blended for the whole run
measure("crossfading two clips", 300);
for (const h of handles) glue.destroy_instance(h);

// (c) The locomotion graph. String ids and parameter indices from fixtures/graph_expected.json; records by hand
// (graph family, version 1): SET_PARAM 0x0301 (32 bytes), SLOT_PLAY 0x0305 (44 bytes).
const fixtureJson = JSON.parse(readFileSync(new URL("fixtures/graph_expected.json", wasmDir), "utf8"));
const idle = glue.load_clip(fixture("humanoid_idle.anim"));
const mask = glue.load_mask(new Float32Array(Array.from({ length: 60 }, (_, i) => (i >= 3 && i < 33 ? 1 : 0))));
const graph = glue.load_graph(fixture("loco.animgraph"));
const b = fixtureJson.binds;
for (const [id, asset] of [[b.idle, idle], [b.walk, walk], [b.run, run], [b.upper, mask]]) glue.graph_bind(graph, id, asset);
const gh = Array.from({ length: N }, () => glue.create_instance(0, skel, graph));
{
  const view = new DataView(exports.memory.buffer);
  let at = glue.commands_ptr();
  const start = at;
  const setParam = (h, param, type, w0) => {
    view.setUint16(at, 0x0301, true);
    view.setUint16(at + 2, 1, true);
    for (const [o, v] of [[4, h], [8, param], [12, type], [16, w0], [20, 0], [24, 0], [28, 0]]) view.setUint32(at + o, v, true);
    at += 32;
  };
  const f32 = (x) => new Uint32Array(new Float32Array([x]).buffer)[0];
  gh.forEach((h, i) => {
    setParam(h, 3, 2, 1); // moving = true
    setParam(h, 0, 0, f32((i % 10) / 10)); // x
    setParam(h, 1, 0, f32(0.5 + (i % 5) / 10)); // y
    setParam(h, 2, 0, f32(1 + (i % 3))); // speed
    view.setUint16(at, 0x0305, true); // SLOT_PLAY: a looping upper-body section
    view.setUint16(at + 2, 1, true);
    for (const [o, v] of [[4, h], [8, 0], [12, run], [16, 0]]) view.setUint32(at + o, v, true);
    for (const [o, v] of [[20, 0.1], [24, 0.1], [28, 1], [32, 0], [36, 0.5]]) view.setFloat32(at + o, v, true);
    view.setUint32(at + 40, 1, true);
    at += 44;
  });
  const applied = glue.write_inputs(at - start);
  if (applied !== N * 5) console.log(`warning: ${applied} of ${N * 5} graph commands applied`);
}
measure("locomotion graph (state machine + 2D blend space of 3 clips + upper-body slot)", 300);

// (d) T40: the locomotion graph + grounder + look-at. Rig rows (anim-wire rig family, version 1): the character
// transform (identity), target slot 0 (the look-at's, model space), and per frame the hits for last frame's rays
// (flat ground at y = 0: the hit is the ray origin dropped to the plane).
const RIG_STRIDE = 1088, TARGETS = 64, HITS = 832, RAY_ROW = 256;
const rigGraph = glue.load_graph(fixture("loco_rig.animgraph"));
if (glue.last_status() !== 0) console.log(`warning: loco_rig.animgraph loaded with status ${glue.last_status()}`);
for (const [id, asset] of [[b.idle, idle], [b.walk, walk], [b.run, run], [b.upper, mask]]) glue.graph_bind(rigGraph, id, asset);
for (const h of gh) glue.destroy_instance(h);
const rh = Array.from({ length: N }, () => glue.create_instance(0, skel, rigGraph));
{
  const view = new DataView(exports.memory.buffer);
  let at = glue.commands_ptr();
  const start = at;
  const f32 = (x) => new Uint32Array(new Float32Array([x]).buffer)[0];
  rh.forEach((h, i) => {
    for (const [param, type, w0] of [[3, 2, 1], [0, 0, f32((i % 10) / 10)], [1, 0, f32(0.5 + (i % 5) / 10)], [2, 0, f32(1 + (i % 3))]]) {
      view.setUint16(at, 0x0301, true);
      view.setUint16(at + 2, 1, true);
      for (const [o, v] of [[4, h], [8, param], [12, type], [16, w0], [20, 0], [24, 0], [28, 0]]) view.setUint32(at + o, v, true);
      at += 32;
    }
    const row = glue.rig_inputs_ptr() + (h & 0xffff) * RIG_STRIDE;
    for (const [o, v] of [[0, 1.5], [4, 1.6], [8, 2.0], [28, 1], [32, 1]]) view.setFloat32(row + TARGETS + o, v, true);
  });
  glue.write_inputs(at - start);
}
function feedHits() {
  const view = new DataView(exports.memory.buffer);
  for (const h of rh) {
    const i = h & 0xffff;
    const rays = glue.rig_rays_ptr() + i * RAY_ROW;
    const hits = glue.rig_inputs_ptr() + i * RIG_STRIDE + HITS;
    for (let k = 0; k < 2; k++) {
      const r = rays + k * 32;
      const valid = view.getUint32(r + 28, true) & 1;
      view.setFloat32(hits + k * 32, view.getFloat32(r, true), true);
      view.setFloat32(hits + k * 32 + 4, 0, true);
      view.setFloat32(hits + k * 32 + 8, view.getFloat32(r + 8, true), true);
      view.setFloat32(hits + k * 32 + 16, 1, true);
      view.setUint32(hits + k * 32 + 24, valid, true);
    }
  }
}
{
  const dt = 1 / 60;
  for (let i = 0; i < 30; i++) {
    feedHits();
    glue.write_inputs(0);
    glue.evaluate(0, 0, dt, dt);
  }
  const frames = 300;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    feedHits();
    glue.write_inputs(0);
    glue.evaluate(0, 0, dt, dt);
  }
  const ms = (performance.now() - t0) / frames;
  const view = new DataView(exports.memory.buffer);
  const asked = rh.reduce((n, h) => n + [0, 1].filter((k) => view.getUint32(glue.rig_rays_ptr() + (h & 0xffff) * RAY_ROW + k * 32 + 28, true) & 1).length, 0);
  console.log(`locomotion graph + two-foot grounder + look-at: ${ms.toFixed(3)} ms per frame (${N} instances x 60 bones, mean of ${frames}, hits fed each frame; ${asked} rays asked)`);
}
const wasm = fileURLToPath(new URL("myco_anim_bg.wasm", wasmDir));
console.log(`wasm: ${statSync(wasm).size} bytes`);
