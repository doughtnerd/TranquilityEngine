// ADR 0370 (T45t): reading a node module's descriptor blob. The blob is the sample module's own
// (`native/anim/examples/plugin-sample`, its committed raw build), read from the module's memory as the loader does; the
// expected schema is the sample's `PARAMS` tables. Refusals: a short, foreign, mis-sized or trailing blob.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODE_ABI_VERSION, readPluginDescriptor } from "./pluginDescriptor";

interface Exports {
  memory: WebAssembly.Memory;
  myco_node_describe(): number;
}

function sampleBlob(): Uint8Array {
  const bytes = readFileSync(new URL("../../plugins/animation/runtime/wasm/fixtures/plugin_sample_raw.wasm", import.meta.url));
  const e = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports as unknown as Exports;
  const at = e.myco_node_describe();
  const len = new DataView(e.memory.buffer).getUint32(at + 8, true);
  return new Uint8Array(e.memory.buffer, at, len).slice();
}

describe("readPluginDescriptor", () => {
  it("reads the sample's node kinds and parameter schemas", () => {
    const read = readPluginDescriptor(sampleBlob());
    if ("error" in read) throw new Error(read.error);
    const d = read.descriptor;
    expect(d.abiVersion).toBe(NODE_ABI_VERSION);
    expect(d.nodes.map((n) => [n.kind, n.name, n.inputs, n.stateBytes, n.needsSkeleton, n.blockWords])).toEqual([
      [1, "sway", 1, 4, false, 7],
      [2, "scale", 1, 0, false, 1],
    ]);
    const sway = d.nodes[0]!.params;
    expect(sway.map((p) => [p.name, p.kind, p.unit, p.animatable, p.words])).toEqual([
      ["amplitude", "float", "degrees", true, 1],
      ["frequency", "float", "hertz", true, 1],
      ["axis", "vec3", "none", false, 3],
      ["first_bone", "int", "none", false, 1],
      ["falloff", "float", "ratio", false, 1],
    ]);
    expect(sway.map((p) => [p.min, p.max, p.default])).toEqual([
      [0, 90, 5],
      [0, 10, 0.5],
      [-1, 1, [0, 0, 1]],
      [0, 65534, 1],
      [0, 1, expect.closeTo(0.8, 6)],
    ]);
    expect(d.nodes[1]!.params).toEqual([{ name: "factor", kind: "float", unit: "multiplier", animatable: true, min: 0, max: 10, default: 1, words: 1 }]);
  });

  it("refuses blobs that don't read", () => {
    const blob = sampleBlob();
    const err = (b: Uint8Array) => {
      const r = readPluginDescriptor(b);
      return "error" in r ? r.error : "";
    };
    expect(err(blob.subarray(0, 8))).toMatch(/shorter than its header/);
    const foreign = blob.slice();
    foreign[0] = 0x58;
    expect(err(foreign)).toMatch(/bad magic/);
    const version = blob.slice();
    version[4] = 9;
    expect(err(version)).toMatch(/ABI version 9/);
    expect(err(blob.subarray(0, blob.length - 1))).toMatch(/length field/);
    const trailing = new Uint8Array(blob.length + 1);
    trailing.set(blob);
    new DataView(trailing.buffer).setUint32(8, trailing.length, true);
    expect(err(trailing)).toMatch(/after the last record/);
  });
});
