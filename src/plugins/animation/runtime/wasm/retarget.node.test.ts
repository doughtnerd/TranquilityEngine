// ADR 0342 (T41): retargeting through the committed wasm in Node. Guesses both humanoid skeletons' bone maps
// (`guess_bone_map`), creates the retarget map, loads the source graph (a clip player on the T-pose skeleton) and the
// target graph (a RETARGET node pinning every IK goal) written by native/anim/crates/anim-wasm/tests/retarget_fixtures.rs,
// runs the frames and compares the bone matrices with what the native core showed. The core is deterministic (no FMA,
// no relaxed SIMD), so the tolerance is the fixture's (1e-5 on matrix entries, for printing).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "./wire/core";
import {
  create_instance,
  evaluate,
  graph_bind,
  guess_bone_map,
  init,
  initSync,
  last_status,
  load_clip,
  load_graph,
  load_skeleton,
  matrices_ptr,
  retarget_goal_count,
  retarget_map_create,
  write_inputs,
} from "./myco_anim.js";

interface Fixture {
  maxBones: number;
  bones: number;
  dt: number;
  frames: number;
  tolerance: number;
  alignFlag: number;
  goals: number;
  binds: { clip: number; map: number; src: number };
  srcMap: number[];
  tgtMap: number[];
  matrices: number[];
}

const file = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/retarget_expected.json", import.meta.url), "utf8")) as Fixture;

describe("animation retargeting in Node", () => {
  const exports = initSync({ module: readFileSync(new URL("./myco_anim_bg.wasm", import.meta.url)) });
  const initBytes = new Uint8Array(core.INIT.stride);
  const view = new DataView(initBytes.buffer);
  view.setUint16(core.WIRE_HEADER.opcode, core.INIT.opcode, true);
  view.setUint16(core.WIRE_HEADER.version, core.INIT.version, true);
  view.setUint32(core.INIT.fields.maxInstances.offset, 4, true);
  view.setUint32(core.INIT.fields.maxBones.offset, fixture.maxBones, true);
  view.setUint32(core.INIT.fields.arenaInitialBytes.offset, 1 << 20, true);
  init(initBytes);
  const srcFile = file("retarget_src.skel");
  const tgtFile = file("retarget_tgt.skel");

  it("guesses both bone maps like the native core", () => {
    for (const [bytes, expected] of [
      [srcFile, fixture.srcMap],
      [tgtFile, fixture.tgtMap],
    ] as const) {
      const bones = new Uint16Array(expected.length);
      const confidence = new Float32Array(expected.length);
      expect(guess_bone_map(bytes, 0, bones, confidence), `last status ${last_status()}`).toBe(expected.length);
      expect(Array.from(bones)).toEqual(expected);
    }
  });

  it("retargets a clip on one skeleton onto the other like the native core", () => {
    const src = load_skeleton(srcFile);
    const tgt = load_skeleton(tgtFile);
    const map = retarget_map_create(src, 0, new Uint16Array(fixture.srcMap), tgt, 0, new Uint16Array(fixture.tgtMap), fixture.alignFlag);
    expect([src, tgt, map].every((h) => h !== 0), `last status ${last_status()}`).toBe(true);
    expect(retarget_goal_count(map)).toBe(fixture.goals);
    const clip = load_clip(file("retarget_walk.anim"));
    const source = load_graph(file("retarget_source.animgraph"));
    const graph = load_graph(file("retarget.animgraph"));
    expect(graph_bind(source, fixture.binds.clip, clip)).toBe(core.STATUS_OK);
    expect(graph_bind(graph, fixture.binds.map, map)).toBe(core.STATUS_OK);
    expect(graph_bind(graph, fixture.binds.src, source)).toBe(core.STATUS_OK);
    const h = create_instance(0, tgt, graph);
    expect(h, `last status ${last_status()}`).not.toBe(0);
    const dt = Math.fround(fixture.dt);
    for (let f = 0; f < fixture.frames; f++) {
      write_inputs(0);
      evaluate(0, core.PASS_NORMAL, dt, dt);
    }
    const row = (h & core.HANDLE_INDEX_MASK) * fixture.maxBones * core.MATRIX_FLOATS;
    const m = new Float32Array(exports.memory.buffer, matrices_ptr() + row * 4, fixture.bones * core.MATRIX_FLOATS);
    const worst = m.reduce((w, x, i) => Math.max(w, Math.abs(x - fixture.matrices[i]!)), 0);
    expect(worst).toBeLessThan(fixture.tolerance);
  });
});
