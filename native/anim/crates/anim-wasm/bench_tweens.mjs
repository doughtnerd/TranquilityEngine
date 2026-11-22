#!/usr/bin/env node
// Measures tweens and timelines on the committed wasm in Node (ADR 0340's budgets are tripwires: 1,000 tweens <= 0.2 ms
// per frame): (a) 1,000 endless float tweens (linear), (b) 1,000 endless float tweens over every easing id, (c) 1,000
// endless vec3 and quaternion tweens, (d) a sequence timeline with 20 bindings (members), (e) the fixture clip timeline
// with a nested subclip. Each figure is `write_inputs(0)` plus `evaluate` per frame, the mean over 2,000 frames after a
// warm-up. Prints the numbers; asserts nothing (wall-clock). Run: node native/anim/crates/anim-wasm/bench_tweens.mjs
import { readFileSync } from "node:fs";

const wasmDir = new URL("../../../../src/plugins/animation/runtime/wasm/", import.meta.url);
const glue = await import(new URL("myco_anim.js", wasmDir).href);
const exports = glue.initSync({ module: readFileSync(new URL("myco_anim_bg.wasm", wasmDir)) });
const fixture = (n) => new Uint8Array(readFileSync(new URL(`fixtures/${n}`, wasmDir)));

function record(opcode, version, words) {
  // words: [type, value][] after the 4-byte header; every field is 4 bytes.
  const view = new DataView(new ArrayBuffer(4 + words.length * 4));
  view.setUint16(0, opcode, true);
  view.setUint16(2, version, true);
  words.forEach(([type, v], i) => (type === "f" ? view.setFloat32(4 + i * 4, v, true) : view.setUint32(4 + i * 4, v >>> 0, true)));
  return new Uint8Array(view.buffer);
}
const u = (v) => ["u", v];
const f = (v) => ["f", v];

// INIT: opcode 0x0101.
const reply = new DataView(glue.init(record(0x0101, 1, [u(8), u(64), u(1 << 20)])).buffer);
console.log(`memory needed: ${reply.getUint32(8, true)} bytes`);

// TWEEN_CREATE (family 6, kind 1): world host_id column value_kind width ease flags time_mode loops | duration delay speed | from[4] to[4].
const tween = (i, { kind = 0, width = 1, ease = 0, flags = 0 } = {}) =>
  record(0x0601, 1, [u(0), u(i), u(i), u(kind), u(width), u(ease), u(flags), u(0), u(0xffffffff), f(1.5), f(0), f(1), f(0), f(0), f(0), f(1), f(1), f(2), f(3), f(1)]);

function measure(label, frames = 2000) {
  const dt = 1 / 60;
  for (let i = 0; i < 200; i++) {
    glue.write_inputs(0);
    glue.evaluate(0, 0, dt, dt);
  }
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    glue.write_inputs(0);
    glue.evaluate(0, 0, dt, dt);
  }
  const ms = (performance.now() - t0) / frames;
  console.log(`${label}: ${ms.toFixed(4)} ms per frame`);
  return ms;
}

function reset() {
  glue.tweens_configure(2048);
  glue.timelines_configure(64, 1 << 16);
}

reset();
for (let i = 0; i < 1000; i++) glue.tween_create(tween(i, { flags: 0 }));
const linear = measure("1,000 float tweens, linear, endless");
reset();
for (let i = 0; i < 1000; i++) glue.tween_create(tween(i, { ease: i % 31, flags: i % 2 ? 2 : 0 }));
const eased = measure("1,000 float tweens, every easing id, half yoyo");
reset();
for (let i = 0; i < 1000; i++) glue.tween_create(tween(i, i % 2 ? { kind: 2, width: 4, ease: 15 } : { width: 3, ease: 6 }));
const vec = measure("1,000 tweens, 500 vec3 + 500 quaternion slerp");
console.log(`tripwire 0.2 ms: linear ${linear < 0.2 ? "ok" : "OVER"}, eased ${eased < 0.2 ? "ok" : "OVER"}, vec/quat ${vec < 0.2 ? "ok" : "OVER"}`);

// A sequence of 20 members (20 bindings), endless loop wrap, each member a 0.5 s tween.
reset();
const head = record(0x0702, 1, [u(0), u(1), u(0), u(2), u(1), f(1), u(20)]);
// SEQ_MEMBER (family 7, kind 3): host_id column value_kind width ease flags loops | offset duration delay | from[4] to[4].
const member = (i) => record(0x0703, 1, [u(i), u(i), u(0), u(1), u(i % 31), u(0), u(1), f(i * 0.05), f(0.5), f(0), f(0), f(0), f(0), f(0), f(1), f(0), f(0), f(0)]);
const parts = [head, ...Array.from({ length: 20 }, (_, i) => member(i))];
const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
parts.reduce((at, p) => (bytes.set(p, at), at + p.length), 0);
const seq = glue.timeline_create_sequence(bytes);
if (seq === 0) throw new Error(`sequence refused (${glue.last_status()})`);
measure("sequence timeline, 20 bindings, looping");

// The fixture clip timeline (a root ramp and a subclip entry over a leaf clip).
reset();
const leaf = glue.load_clip(fixture("timeline_leaf.anim"));
const root = glue.load_clip(fixture("timeline_root.anim"));
// TIMELINE_CREATE (family 7, kind 1): world host_id clip time_mode wrap flags | speed start.
const h = glue.timeline_create(record(0x0701, 1, [u(0), u(1), u(root), u(0), u(2), u(1), f(1), f(0)]));
glue.timeline_bind(h, root, 0, leaf);
measure("clip timeline, one root track and one nested subclip, looping");
