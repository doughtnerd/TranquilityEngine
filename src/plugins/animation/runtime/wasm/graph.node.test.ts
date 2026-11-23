// ADR 0372 (T31): the graph runtime through the committed wasm in Node. Loads the locomotion graph (a state machine
// with a 2D blend space of three clips and an any-state jump, under an upper-body slot and an inertialization node)
// and its clips (written by native/anim/crates/anim-wasm/tests/graph_fixtures.rs), runs the fixture's command script
// through the `graph` family's records (parameters, a slot play with a section, a request), and compares the states
// entered and the final bone matrices with what the native core showed for the same script. The core is
// deterministic (no FMA, no relaxed SIMD), so the tolerance is the fixture's (1e-5 on matrix entries, for printing).
// Then it reads the instance's debug report (the `debug` family).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "./wire/core";
import * as debug from "./wire/debug";
import * as graph from "./wire/graph";
import {
  commands_ptr,
  create_instance,
  debug_ptr,
  debug_write,
  evaluate,
  graph_bind,
  graph_change_count,
  graph_changes_ptr,
  init,
  initSync,
  last_status,
  load_clip,
  load_graph,
  load_mask,
  load_skeleton,
  matrices_ptr,
  write_inputs,
} from "./myco_anim.js";

type ScalarType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32";
interface RecordLayout {
  readonly opcode: number;
  readonly version: number;
  readonly stride: number;
  readonly fields: Readonly<Record<string, { readonly offset: number; readonly type: ScalarType }>>;
}

interface Fixture {
  maxBones: number;
  bones: number;
  dt: number;
  frames: number;
  tolerance: number;
  maskFrom: number;
  binds: { idle: number; walk: number; run: number; upper: number };
  script: { frame: number; record: string; values: Record<string, number> }[];
  entered: [number, number, number][];
  matrices: number[];
}

const file = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/graph_expected.json", import.meta.url), "utf8")) as Fixture;

function put(view: DataView, at: number, layout: RecordLayout, values: Record<string, number>): number {
  view.setUint16(at + core.WIRE_HEADER.opcode, layout.opcode, true);
  view.setUint16(at + core.WIRE_HEADER.version, layout.version, true);
  for (const [name, f] of Object.entries(layout.fields)) {
    const v = values[name] ?? 0;
    if (f.type === "f32") view.setFloat32(at + f.offset, v, true);
    else view.setUint32(at + f.offset, v >>> 0, true);
  }
  return layout.stride;
}

function get(view: DataView, at: number, layout: RecordLayout): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, f] of Object.entries(layout.fields)) {
    out[name] = f.type === "f32" ? view.getFloat32(at + f.offset, true) : view.getUint32(at + f.offset, true);
  }
  return out;
}

describe("animation graph in Node", () => {
  const exports = initSync({ module: readFileSync(new URL("./myco_anim_bg.wasm", import.meta.url)) });
  const memory = (): DataView => new DataView(exports.memory.buffer);
  const initBytes = new Uint8Array(core.INIT.stride);
  put(new DataView(initBytes.buffer), 0, core.INIT, { maxInstances: 4, maxBones: fixture.maxBones, arenaInitialBytes: 1 << 20 });
  init(initBytes);
  const skel = load_skeleton(file("small.skel"));
  const clips = {
    idle: load_clip(file("graph_idle.anim")),
    walk: load_clip(file("graph_walk.anim")),
    run: load_clip(file("graph_run.anim")),
  };
  const shot = load_clip(file("graph_shot.anim"));
  const mask = load_mask(new Float32Array(Array.from({ length: fixture.bones }, (_, i) => (i >= fixture.maskFrom ? 1 : 0))));
  const g = load_graph(file("loco.animgraph"));
  const layouts = graph as unknown as Record<string, RecordLayout>;

  it("loads the graph and its assets", () => {
    expect([skel, clips.idle, clips.walk, clips.run, shot, mask, g].every((h) => h !== 0), `last status ${last_status()}`).toBe(true);
    for (const [name, asset] of [
      ["idle", clips.idle],
      ["walk", clips.walk],
      ["run", clips.run],
      ["upper", mask],
    ] as const) {
      expect(graph_bind(g, fixture.binds[name], asset)).toBe(core.STATUS_OK);
    }
  });

  it("runs the script like the native core and reports its states and debug view", () => {
    const h = create_instance(0, skel, g);
    expect(h).not.toBe(0);
    const entered: [number, number, number][] = [];
    const dt = Math.fround(fixture.dt);
    for (let f = 0; f < fixture.frames; f++) {
      const view = memory();
      let at = commands_ptr();
      const start = at;
      if (f === 0) at += put(view, at, graph.DEBUG, { instance: h, flags: graph.DEBUG_ON });
      for (const e of fixture.script.filter((s) => s.frame === f)) {
        const layout = layouts[e.record];
        if (!layout) throw new Error(`no record ${e.record}`);
        at += put(view, at, layout, { ...e.values, instance: h, ...(e.record === "SLOT_PLAY" ? { clip: shot } : {}) });
      }
      const applied = write_inputs(at - start);
      expect(applied).toBe(fixture.script.filter((s) => s.frame === f).length + (f === 0 ? 1 : 0));
      evaluate(0, core.PASS_NORMAL, dt, dt);
      const v = memory();
      for (let i = 0; i < graph_change_count(); i++) {
        const c = get(v, graph_changes_ptr() + i * graph.GRAPH_CHANGE.stride, graph.GRAPH_CHANGE);
        if (c.kind === graph.GRAPH_STATE_ENTERED) entered.push([f, c.index!, c.value!]);
      }
    }
    expect(entered).toEqual(fixture.entered);
    const row = (h & core.HANDLE_INDEX_MASK) * fixture.maxBones * core.MATRIX_FLOATS;
    const m = new Float32Array(exports.memory.buffer, matrices_ptr() + row * 4, fixture.bones * core.MATRIX_FLOATS);
    const worst = m.reduce((w, x, i) => Math.max(w, Math.abs(x - fixture.matrices[i]!)), 0);
    expect(worst).toBeLessThan(fixture.tolerance);

    // The debug report: one machine in the last state entered, its candidates, the request name.
    const bytes = debug_write(h);
    expect(bytes).toBeGreaterThan(debug.DEBUG_HEADER.stride);
    const dv = memory();
    const header = get(dv, debug_ptr(), debug.DEBUG_HEADER);
    expect([header.instance, header.machines, header.requests, header.dropped]).toEqual([h, 1, 1, 0]);
    expect(header.nodes).toBeGreaterThan(0);
    let p = debug_ptr() + debug.DEBUG_HEADER.stride;
    const end = p + header.recordBytes!;
    let machine: Record<string, number> | undefined;
    while (p < end) {
      const op = dv.getUint16(p, true);
      const layout = [debug.DEBUG_NODE, debug.DEBUG_MACHINE, debug.DEBUG_TRANSITION, debug.DEBUG_REQUEST].find((l) => l.opcode === op);
      if (!layout) throw new Error(`unknown debug opcode ${op}`);
      if (layout === debug.DEBUG_MACHINE) machine = get(dv, p, layout);
      p += layout.stride;
    }
    expect(machine?.current).toBe(fixture.entered.at(-1)![2]);
  });
});
