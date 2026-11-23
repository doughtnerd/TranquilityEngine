// ADR 0350 (T45 core half): a third-party graph node through the committed wasm in Node. The host is implemented here
// the way the Phase B loader will be: it instantiates plugin-sample's metered module (fixtures/plugin_sample.wasm,
// built and metered by native/anim/crates/anim-wasm/tests/plugin_fixtures.rs) with no imports, reads its descriptor
// from the module's memory and registers it with `plugin_register`, then answers the core's
// `mycoAnimPluginHost.call(record)`: copy the `PLUGIN_CALL` record's buffers from the core's memory into the module's,
// set the fuel, call `myco_node_evaluate`, copy the output and state back. The graph is the sample's `scale` node over
// the reference pose of a chain with identity rotations and bind matrices, so a bone matrix's translation column is
// the bone's model position and scaling every local translation by `factor` scales it exactly.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "./wire/core";
import * as graph from "./wire/graph";
import * as plugin from "./wire/plugin";
import {
  commands_ptr,
  create_instance,
  destroy_instance,
  evaluate,
  graph_bind,
  init,
  initSync,
  last_status,
  load_graph,
  load_skeleton,
  matrices_ptr,
  plugin_fault_count,
  plugin_faults_ptr,
  plugin_register,
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
  module: number;
  factorParam: number;
  plugin: string;
}

const file = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/plugin_expected.json", import.meta.url), "utf8")) as Fixture;

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

interface NodeModule {
  memory: WebAssembly.Memory;
  myco_node_describe: () => number;
  myco_node_alloc: (bytes: number) => number;
  myco_node_evaluate: (...args: number[]) => number;
  myco_fuel_set: (fuel: bigint) => void;
  myco_fuel_get: () => bigint;
}

const BUFFER_BYTES = 64 * 1024;

/** What the Phase B loader does with one metered node module. */
class SampleHost {
  private readonly module = new WebAssembly.Module(readFileSync(new URL(`./fixtures/${fixture.plugin}`, import.meta.url)));
  private node!: NodeModule;
  private buffer = 0;
  fuel = 1_000_000n;
  calls = 0;
  traps = 0;

  constructor(private readonly coreMemory: () => ArrayBuffer) {
    this.instantiate();
  }

  private instantiate(): void {
    const instance = new WebAssembly.Instance(this.module, {});
    expect(WebAssembly.Module.imports(this.module)).toEqual([]);
    this.node = instance.exports as unknown as NodeModule;
    this.node.myco_fuel_set(1n << 20n);
    this.buffer = this.node.myco_node_alloc(BUFFER_BYTES);
  }

  /** The module's descriptor blob, copied out of its memory. */
  descriptor(): Uint8Array {
    const at = this.node.myco_node_describe();
    const len = new DataView(this.node.memory.buffer).getUint32(at + 8, true);
    return new Uint8Array(this.node.memory.buffer, at, len).slice();
  }

  call(record: number): number {
    this.calls++;
    const c = get(new DataView(this.coreMemory()), record, plugin.PLUGIN_CALL);
    const poseBytes = c.bones! * 40;
    const sizes = {
      input: c.count! * c.inputs! * poseBytes,
      output: c.count! * poseBytes,
      params: c.count! * c.paramWords! * 4,
      state: c.count! * Math.ceil(c.stateBytes! / 16) * 16,
      parents: c.parents ? c.bones! * 2 : 0,
    };
    // Lay the buffers out in the module's block (16-aligned).
    let at = this.buffer;
    const place = (n: number): number => {
      const p = at;
      at += Math.ceil(n / 16) * 16;
      return p;
    };
    const p = { input: place(sizes.input), output: place(sizes.output), params: place(sizes.params), state: place(sizes.state), parents: place(sizes.parents) };
    if (at - this.buffer > BUFFER_BYTES) return plugin.FAULT_TRAP;
    const from = new Uint8Array(this.coreMemory());
    const to = new Uint8Array(this.node.memory.buffer);
    const copyIn = (src: number, dst: number, n: number): void => {
      if (n > 0) to.set(from.subarray(src, src + n), dst);
    };
    copyIn(c.input!, p.input, sizes.input);
    copyIn(c.params!, p.params, sizes.params);
    copyIn(c.state!, p.state, sizes.state);
    copyIn(c.parents!, p.parents, sizes.parents);
    this.node.myco_fuel_set(this.fuel);
    let status: number;
    try {
      status = this.node.myco_node_evaluate(c.kind!, c.count!, c.bones!, c.parents ? p.parents : 0, p.input, p.output, p.params, p.state, c.dt!);
    } catch {
      // A trap (or fuel running out): the instance may be half-written, so a fresh one serves the next call.
      this.traps++;
      this.instantiate();
      return plugin.FAULT_TRAP;
    }
    if (status === 0) {
      const back = new Uint8Array(this.node.memory.buffer);
      const core8 = new Uint8Array(this.coreMemory());
      core8.set(back.subarray(p.output, p.output + sizes.output), c.output!);
      if (sizes.state > 0) core8.set(back.subarray(p.state, p.state + sizes.state), c.state!);
    }
    return status;
  }
}

describe("third-party graph nodes in Node", () => {
  const exports = initSync({ module: readFileSync(new URL("./myco_anim_bg.wasm", import.meta.url)) });
  const memory = (): DataView => new DataView(exports.memory.buffer);
  const initBytes = new Uint8Array(core.INIT.stride);
  put(new DataView(initBytes.buffer), 0, core.INIT, { maxInstances: 8, maxBones: fixture.maxBones, arenaInitialBytes: 1 << 20 });
  init(initBytes);
  const skel = load_skeleton(file("plugin.skel"));
  const g = load_graph(file("plugin.animgraph"));
  const host = new SampleHost(() => exports.memory.buffer);
  const module = plugin_register(host.descriptor());
  const global = globalThis as { mycoAnimPluginHost?: { call(record: number): number } };

  afterEach(() => {
    delete global.mycoAnimPluginHost;
  });

  function frame(h: number, factor: number): void {
    const view = memory();
    const start = commands_ptr();
    const len = put(view, start, graph.SET_PARAM, { instance: h, param: fixture.factorParam, paramType: 0, w0: new Uint32Array(new Float32Array([factor]).buffer)[0]! });
    expect(write_inputs(len)).toBe(1);
    const dt = Math.fround(1 / 30);
    evaluate(0, core.PASS_NORMAL, dt, dt);
  }

  function translations(h: number): number[] {
    const row = (h & core.HANDLE_INDEX_MASK) * fixture.maxBones * core.MATRIX_FLOATS;
    const m = new Float32Array(exports.memory.buffer, matrices_ptr() + row * 4, fixture.bones * core.MATRIX_FLOATS);
    return Array.from({ length: fixture.bones }, (_, b) => [m[b * 12 + 3]!, m[b * 12 + 7]!, m[b * 12 + 11]!]).flat();
  }

  function faults(): Record<string, number>[] {
    const view = memory();
    return Array.from({ length: plugin_fault_count() }, (_, i) => get(view, plugin_faults_ptr() + i * plugin.PLUGIN_FAULT.stride, plugin.PLUGIN_FAULT));
  }

  it("registers the module's descriptor and binds it into the graph", () => {
    expect([skel, g, module].every((h) => h !== 0), `last status ${last_status()}`).toBe(true);
    expect(graph_bind(g, fixture.module, module)).toBe(core.STATUS_OK);
  });

  it("runs the sample's scale node through the host", () => {
    global.mycoAnimPluginHost = { call: (r) => host.call(r) };
    const h = create_instance(0, skel, g);
    expect(h).not.toBe(0);
    frame(h, 1);
    const one = translations(h);
    expect(one.slice(0, 3)).toEqual([0, 1, 0]);
    frame(h, 2);
    expect(translations(h)).toEqual(one.map((v) => v * 2));
    frame(h, 0.5);
    expect(translations(h)).toEqual(one.map((v) => v * 0.5));
    expect(faults()).toEqual([]);
    expect(host.calls).toBe(3);
    expect(destroy_instance(h)).toBe(core.STATUS_OK);
  });

  it("passes the input through and reports once when the host throws or the module traps", () => {
    // No host: the import throws, which is a fault.
    const a = create_instance(0, skel, g);
    frame(a, 2);
    const rest = translations(a);
    expect(rest.slice(0, 3)).toEqual([0, 1, 0]);
    expect(faults()).toEqual([{ instance: a, node: 1, module, kind: 2, status: plugin.FAULT_HOST_THREW }]);
    frame(a, 2);
    expect(faults()).toEqual([]);
    expect(translations(a)).toEqual(rest);
    expect(destroy_instance(a)).toBe(core.STATUS_OK);

    // The module runs out of fuel: a trap; the host replaces the instance and the next call succeeds.
    global.mycoAnimPluginHost = { call: (r) => host.call(r) };
    const b = create_instance(0, skel, g);
    host.fuel = 0n;
    frame(b, 2);
    expect(host.traps).toBe(1);
    expect(translations(b)).toEqual(rest);
    expect(faults()).toEqual([{ instance: b, node: 1, module, kind: 2, status: plugin.FAULT_TRAP }]);
    host.fuel = 1_000_000n;
    frame(b, 2);
    expect(faults()).toEqual([]);
    expect(translations(b)).toEqual(rest.map((v) => v * 2));
  });
});
