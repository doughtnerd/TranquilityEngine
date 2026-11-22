// ADR 0342 (T40): one IK target through the committed wasm in Node. Loads the rig test skeleton and a graph with a
// two-bone IK node on the left leg (written by native/anim/crates/anim-wasm/tests/rig_fixtures.rs), writes the
// character's transform and a world-space target into the `rig` family's input view, and compares the bone matrices
// with what the native core showed for the same rows. The core is deterministic (no FMA, no relaxed SIMD), so the
// tolerance is the fixture's (1e-5 on matrix entries, for printing). Then a `RIG_RESET` and a refused `WARP_TARGET`
// go through the command buffer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "./wire/core";
import * as rig from "./wire/rig";
import {
  changes_ptr,
  commands_ptr,
  create_instance,
  evaluate,
  init,
  initSync,
  last_status,
  load_graph,
  load_skeleton,
  matrices_ptr,
  rig_inputs_ptr,
  rig_rays_ptr,
  write_inputs,
} from "./myco_anim.js";

interface Fixture {
  maxBones: number;
  bones: number;
  dt: number;
  frames: number;
  tolerance: number;
  ikNode: number;
  footBone: number;
  character: { position: number[]; rotation: number[] };
  target: { slot: number; position: number[]; world: boolean };
  foot: number[];
  matrices: number[];
}

const file = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/rig_expected.json", import.meta.url), "utf8")) as Fixture;

describe("rig nodes in Node", () => {
  const exports = initSync({ module: readFileSync(new URL("./myco_anim_bg.wasm", import.meta.url)) });
  const memory = (): DataView => new DataView(exports.memory.buffer);
  const initBytes = new DataView(new ArrayBuffer(core.INIT.stride));
  initBytes.setUint16(core.WIRE_HEADER.opcode, core.INIT.opcode, true);
  initBytes.setUint16(core.WIRE_HEADER.version, core.INIT.version, true);
  initBytes.setUint32(core.INIT.fields.maxInstances.offset, 4, true);
  initBytes.setUint32(core.INIT.fields.maxBones.offset, fixture.maxBones, true);
  initBytes.setUint32(core.INIT.fields.arenaInitialBytes.offset, 1 << 20, true);
  init(new Uint8Array(initBytes.buffer));
  const skel = load_skeleton(file("rig.skel"));
  const g = load_graph(file("rig_ik.animgraph"));

  it("loads the skeleton and the rig graph with every node known", () => {
    expect(skel).not.toBe(0);
    expect(g).not.toBe(0);
    expect(last_status()).toBe(core.STATUS_OK);
  });

  it("solves a world-space IK target like the native core", () => {
    const h = create_instance(0, skel, g);
    expect(h).not.toBe(0);
    const row = rig_inputs_ptr() + (h & core.HANDLE_INDEX_MASK) * rig.RIG_INPUT_STRIDE;
    const v = memory();
    fixture.character.position.forEach((x, k) => v.setFloat32(row + rig.RIG_CHARACTER_POSITION + 4 * k, x, true));
    fixture.character.rotation.forEach((x, k) => v.setFloat32(row + rig.RIG_CHARACTER_ROTATION + 4 * k, x, true));
    const slot = row + rig.RIG_TARGETS + fixture.target.slot * rig.TARGET_STRIDE;
    fixture.target.position.forEach((x, k) => v.setFloat32(slot + rig.TARGET_POSITION + 4 * k, x, true));
    [0, 0, 0, 1].forEach((x, k) => v.setFloat32(slot + rig.TARGET_ROTATION + 4 * k, x, true));
    v.setFloat32(slot + rig.TARGET_POSITION_WEIGHT, 1, true);
    v.setFloat32(slot + rig.TARGET_ROTATION_WEIGHT, 0, true);
    v.setUint32(slot + rig.TARGET_FLAGS, fixture.target.world ? rig.TARGET_WORLD : 0, true);
    const dt = Math.fround(fixture.dt);
    for (let f = 0; f < fixture.frames; f++) {
      write_inputs(0);
      evaluate(0, core.PASS_NORMAL, dt, dt);
    }
    const at = matrices_ptr() + (h & core.HANDLE_INDEX_MASK) * fixture.maxBones * core.MATRIX_FLOATS * 4;
    const m = new Float32Array(exports.memory.buffer, at, fixture.bones * core.MATRIX_FLOATS);
    const worst = m.reduce((w, x, i) => Math.max(w, Math.abs(x - fixture.matrices[i]!)), 0);
    expect(worst).toBeLessThan(fixture.tolerance);
    const foot = fixture.footBone * core.MATRIX_FLOATS;
    const footWorst = [m[foot + 3], m[foot + 7], m[foot + 11]].reduce((w, x, k) => Math.max(w, Math.abs(x! - fixture.foot[k]!)), 0);
    expect(footWorst).toBeLessThan(fixture.tolerance);
    // No grounder in this graph: the instance's ray row stays empty.
    const rays = rig_rays_ptr() + (h & core.HANDLE_INDEX_MASK) * rig.RAY_ROW_STRIDE;
    for (let i = 0; i < rig.RIG_MAX_RAYS; i++) {
      expect(memory().getUint32(rays + i * rig.RAY_STRIDE + rig.RAY_FLAGS, true) & rig.RAY_VALID).toBe(0);
    }
  });

  it("applies RIG_RESET and refuses WARP_TARGET on a node of another kind", () => {
    const h = create_instance(0, skel, g);
    const view = memory();
    let at = commands_ptr();
    const start = at;
    const put = (layout: typeof rig.RIG_RESET | typeof rig.WARP_TARGET, values: Record<string, number>): void => {
      view.setUint16(at + core.WIRE_HEADER.opcode, layout.opcode, true);
      view.setUint16(at + core.WIRE_HEADER.version, layout.version, true);
      for (const [name, f] of Object.entries(layout.fields)) {
        const x = values[name] ?? 0;
        if (f.type === "f32") view.setFloat32(at + f.offset, x, true);
        else view.setUint32(at + f.offset, x >>> 0, true);
      }
      at += layout.stride;
    };
    put(rig.RIG_RESET, { instance: h, node: rig.NODE_ALL });
    put(rig.WARP_TARGET, { instance: h, node: fixture.ikNode, rw: 1 });
    expect(write_inputs(at - start)).toBe(1);
    const c = memory();
    const refused = changes_ptr();
    expect(c.getUint32(refused + core.STATE_CHANGE.fields.kind.offset, true)).toBe(core.CHANGE_REFUSED);
    expect(c.getUint32(refused + core.STATE_CHANGE.fields.layer.offset, true)).toBe(fixture.ikNode);
    expect(c.getUint32(refused + core.STATE_CHANGE.fields.status.offset, true)).toBe(core.STATUS_MISMATCH);
  });
});
