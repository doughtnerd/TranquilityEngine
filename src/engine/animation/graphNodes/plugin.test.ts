// ADR 0370, 0372 (T45t): third-party node kinds in the one node catalogue. From the sample module's descriptor
// (`plugin-sample`'s raw build, read as the loader reads it) the catalogue generates a kind per node with the
// descriptor's named parameters (units, ranges, defaults, animatable as graph-parameter types), the registry lists them
// for the graph editor and tells listeners, and the compiler packs a plugin node's named parameters into the block the
// core reads (`anim-graph/src/plugin.rs`: module, kind, state bytes, the block in the descriptor's order, bindings), the
// same words as the raw-word form; problems name their parameter.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AnimGraph, GraphNode, GraphParameter } from "../animGraph";
import { readAnimationHeader } from "../binaryHeader";
import { compileAnimGraph } from "../graphCompile";
import { readPluginDescriptor, type PluginModuleDescriptor } from "../pluginDescriptor";
import { onPluginNodeKindsChanged, pluginNodeKinds, pluginNodeKindSchema, pluginNodeModuleDescriptor, registerPluginNodeModule } from "./plugin";
import { nodeKindSchema, PARAM_UNITS } from "./index";

const f32 = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0]!;
const MODULE = "plugins/acme/nodes/sample.wasm";

function sampleDescriptor(): PluginModuleDescriptor {
  const bytes = readFileSync(new URL("../../../plugins/animation/runtime/wasm/fixtures/plugin_sample_raw.wasm", import.meta.url));
  const e = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports as unknown as { memory: WebAssembly.Memory; myco_node_describe(): number };
  const at = e.myco_node_describe();
  const blob = new Uint8Array(e.memory.buffer, at, new DataView(e.memory.buffer).getUint32(at + 8, true)).slice();
  const read = readPluginDescriptor(blob);
  if ("error" in read) throw new Error(read.error);
  return read.descriptor;
}
const descriptor = sampleDescriptor();

const param = (name: string, type: GraphParameter["type"]): GraphParameter => ({ name, type, default: type === "bool" ? false : 0, replicate: false, predicted: false, computed: false });
const rest: GraphNode = { id: "rest", family: "sources", kind: "referencePose", name: "", inputs: [], params: {} };
const plugin = (params: GraphNode["params"]): GraphNode => ({ id: "p", family: "plugin", kind: "plugin", name: "", inputs: ["rest"], params: { module: `asset:${MODULE}`, ...params } });
const graphOf = (parameters: GraphParameter[], nodes: GraphNode[]): AnimGraph => ({ format: "myco.animgraph-source@1", name: "", skeleton: null, output: nodes.at(-1)!.id, parameters, nodes, layers: [] });
const compile = (g: AnimGraph) => compileAnimGraph(g, { pluginDescriptors: (m) => (m === MODULE ? descriptor : undefined) });

/** The plugin node's parameter words and the string table (test-side reader of `graph.rs`'s layout). */
function pluginWords(bytes: Uint8Array): { words: number[]; strings: string[] } {
  const h = readAnimationHeader(bytes, "myco.animgraph@1");
  if (!h.ok) throw new Error(h.problem);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sec = (name: string) => h.header.sections.find((s) => s.name === name)!;
  const nodes = sec("NODES"), blocks = sec("PARAM_BLOCKS"), st = sec("STRINGS");
  const ends = Array.from({ length: st.count + 1 }, (_, i) => v.getUint32(st.offset + 4 * i, true));
  const chars = st.offset + 4 * (st.count + 1);
  const strings = Array.from({ length: st.count }, (_, i) => new TextDecoder().decode(bytes.subarray(chars + ends[i]!, chars + ends[i + 1]!)));
  for (let i = 0; i < nodes.count; i++) {
    const w = (k: number) => v.getUint32(nodes.offset + i * 24 + 4 * k, true);
    if ((w(0) & 0xff) !== 9) continue; // the plugin family
    return { words: Array.from({ length: w(4) }, (_, k) => v.getUint32(blocks.offset + 4 * (w(3) + k), true)), strings };
  }
  throw new Error("no plugin node");
}

describe("descriptor-generated node kinds", () => {
  it("give each module node its named parameters with units, ranges, defaults and animatable types", () => {
    const sway = pluginNodeKindSchema(MODULE, "sway", descriptor)!;
    expect(sway.family).toBe("plugin");
    expect(sway.id).toBe(0);
    expect(sway.inputs).toEqual({ min: 1, max: 1, names: ["input"] });
    expect(sway.params.map((p) => p.name)).toEqual(["module", "node", "amplitude", "frequency", "axis", "first_bone", "falloff"]);
    expect(sway.params[1]).toMatchObject({ kind: "enum", choices: ["sway", "scale"], default: "sway" });
    const by = Object.fromEntries(sway.params.map((p) => [p.name, p]));
    expect(by.amplitude).toMatchObject({ kind: "float", unit: "degrees", min: 0, max: 90, default: 5, animatable: true, parameterTypes: ["float"] });
    expect(by.frequency).toMatchObject({ unit: "hertz", animatable: true });
    expect(by.axis).toMatchObject({ kind: "vec3", min: -1, max: 1, default: [0, 0, 1], animatable: false });
    expect(by.first_bone).toMatchObject({ kind: "int", min: 0, max: 65534, default: 1 });
    expect(by.falloff).toMatchObject({ kind: "float", unit: "ratio", animatable: false });
    for (const p of sway.params) {
      expect(PARAM_UNITS).toContain(p.unit);
      expect(p.doc.length).toBeGreaterThan(0);
      if (p.animatable) expect(p.parameterTypes?.length).toBeGreaterThan(0);
    }
    expect(pluginNodeKindSchema(MODULE, "scale", descriptor)!.params.map((p) => p.name)).toEqual(["module", "node", "factor"]);
    expect(pluginNodeKindSchema(MODULE, "nope", descriptor)).toBeUndefined();
    expect(pluginNodeKindSchema("plugins/other.wasm", "sway")).toBeUndefined();
  });

  it("are listed from the registry, which tells listeners and unregisters", () => {
    const heard = vi.fn();
    const off = onPluginNodeKindsChanged(heard);
    const unregister = registerPluginNodeModule(`asset:./${MODULE}`, descriptor);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(pluginNodeModuleDescriptor(MODULE)).toBe(descriptor);
    expect(pluginNodeKinds().map((k) => [k.module, k.node.name, k.schema.params.length])).toEqual([
      [MODULE, "sway", 7],
      [MODULE, "scale", 3],
    ]);
    // The generic kind resolves to the generated one for a node naming a module node.
    const generic = nodeKindSchema("plugin", "plugin")!;
    expect(generic.resolve!({ module: MODULE, node: "scale" }, { pluginDescriptor: pluginNodeModuleDescriptor })).toBe(pluginNodeKinds()[1]!.schema);
    expect(generic.resolve!({ module: MODULE, nodeKind: 2 }, { pluginDescriptor: pluginNodeModuleDescriptor })).toBeUndefined();
    unregister();
    expect(heard).toHaveBeenCalledTimes(2);
    expect(pluginNodeKinds()).toEqual([]);
    off();
  });
});

describe("compiling plugin nodes with named parameters", () => {
  it("packs the block in the descriptor's order, defaults absent values and binds animatable ones", () => {
    const out = compile(graphOf([param("hz", "float")], [rest, plugin({ node: "sway", amplitude: 10, frequency: "hz", first_bone: 2 })]));
    expect(out.problems).toEqual([]);
    const { words, strings } = pluginWords(out.bytes!);
    const module = strings.indexOf(MODULE);
    expect(module).toBeGreaterThanOrEqual(0);
    // module, kind, state bytes, block (amplitude, frequency's default, axis, first_bone, falloff), one binding.
    expect(words).toEqual([module, 1, 4, 7, f32(10), f32(0.5), f32(0), f32(0), f32(1), 2, f32(0.8), 1, 1, 1, 0]);
    expect(out.bindings).toEqual([{ stringId: module, ref: `asset:${MODULE}`, asset: "plugin" }]);
  });

  it("packs the same words as the raw-word form", () => {
    const named = compile(graphOf([param("factor", "float")], [rest, plugin({ node: "scale", factor: "factor" })]));
    const raw = compile(graphOf([param("factor", "float")], [rest, plugin({ nodeKind: 2, stateBytes: 0, block: [f32(1)], bindOffsets: [0], bindCounts: [1], bindParameters: ["factor"] })]));
    expect(named.problems).toEqual([]);
    expect(pluginWords(named.bytes!).words).toEqual(pluginWords(raw.bytes!).words);
  });

  it("clamps values to the descriptor's ranges and names what it can't use", () => {
    const out = compile(graphOf([param("on", "bool"), param("hz", "float")], [rest, plugin({ node: "sway", amplitude: 200, axis: [0, 0, 3], falloff: "hz", frequency: "on" })]));
    expect(out.problems.map((p) => [p.path, p.severity])).toEqual([
      ["nodes[1].params.amplitude", "warning"],
      ["nodes[1].params.frequency", "error"],
      ["nodes[1].params.axis", "warning"],
      ["nodes[1].params.falloff", "error"],
    ]);
    const { words } = pluginWords(out.bytes!);
    expect(words.slice(4, 11)).toEqual([f32(90), f32(0.5), f32(0), f32(0), f32(1), 1, f32(0.8)]);
    expect(words.slice(11)).toEqual([0]); // no binding: "on" is a bool parameter, falloff isn't animatable
  });

  it("falls back to raw words with an error when the descriptor isn't known", () => {
    const out = compileAnimGraph(graphOf([], [rest, plugin({ node: "sway", amplitude: 10 })]), { pluginDescriptors: () => undefined });
    expect(out.problems.map((p) => [p.path, p.severity])).toEqual([
      ["nodes[1].params.amplitude", "warning"],
      ["nodes[1].params.node", "error"],
    ]);
    expect(pluginWords(out.bytes!).words.slice(1)).toEqual([0, 0, 0, 0]);
  });
});
