#!/usr/bin/env node
// Measures the committed animation core on wasm in Node (ADR 0340's budgets are tripwires): `evaluate` for 100
// instances of the 60-bone fixture humanoid, (a) all playing one clip, (b) all mid-crossfade between two clips, plus
// the wasm's size. Prints the numbers; asserts nothing (wall-clock). Run: node native/anim/crates/anim-wasm/bench.mjs
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
const wasm = fileURLToPath(new URL("myco_anim_bg.wasm", wasmDir));
console.log(`wasm: ${statSync(wasm).size} bytes`);
