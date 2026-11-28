/**
 * Node family `plugin` (`anim-graph/src/plugin.rs`): one node kind of a third-party module (ADR 0370 "Third-party graph
 * and rig nodes"). The block's own layout is the module descriptor's (`anim-plugin-sdk/src/descriptor.rs`, the same
 * schema fields and unit ids as this catalogue).
 *
 * - **Named parameters (T45t).** A node that names its module and one of the module's nodes
 *   (`{ module: "asset:plugins/acme/nodes/sway.wasm", node: "sway", amplitude: 10, frequency: "swayHz" }`) takes that
 *   node kind's parameters by name, with the descriptor's kinds, units, ranges and defaults: the generic kind
 *   `resolve`s to a kind generated from the descriptor ({@link pluginNodeKindSchema}), the compiler packs the block in
 *   the descriptor's order (values clamped to their ranges, absent ones at their defaults), and a parameter given a
 *   graph parameter's name becomes a binding when the descriptor marks it animatable. The graph editor builds the
 *   node's card from the same schema. Descriptors come from the loader (`registerPluginNodeModule`: the runtime loads a
 *   graph's modules before compiling it; the editor registers the project plugins' declared modules), and
 *   {@link pluginNodeKinds} lists every kind they provide for the graph editor's palette.
 * - **Raw words.** Without `node` (or before its module's descriptor is known), the block is given as raw words with
 *   bindings that copy graph parameters into it each evaluation.
 *
 * The registry is page-wide and holds descriptors only (no module code). Internal: not public API.
 */
import type { NodeParamValue } from "../animGraph";
import { f32Bits } from "../binaryWriter";
import type { PluginModuleDescriptor, PluginNodeDescriptor, PluginParamDescriptor } from "../pluginDescriptor";
import { I, kind, NONE, P, type NodeFamilyCatalogue, type NodeKindSchema, type NodePacker, type NodeParamSchema, type NodeResolveContext } from "./schema";
import { normalizeAssetPath } from "../../scene/assetPath";

/** `anim-plugin-sdk`'s `abi::MAX_INPUTS`. */
const MAX_INPUTS = 8;

// --- the registry ----------------------------------------------------------------------------------------------------

const modules = new Map<string, PluginModuleDescriptor>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of [...listeners]) {
    try {
      l();
    } catch (err) {
      console.warn("[myco] animation: a plugin node listener failed:", err);
    }
  }
};

/**
 * @internal Makes `descriptor` the node kinds of the module at `module` (a project path or asset reference), replacing an
 * earlier one; returns the unregister, which removes it only while it is still the module's.
 */
export function registerPluginNodeModule(module: string, descriptor: PluginModuleDescriptor): () => void {
  const path = normalizeAssetPath(module);
  modules.set(path, descriptor);
  changed();
  return () => {
    if (modules.get(path) !== descriptor) return;
    modules.delete(path);
    changed();
  };
}

/** @internal The registered descriptor of a module (project path or asset reference), or undefined. */
export function pluginNodeModuleDescriptor(module: string): PluginModuleDescriptor | undefined {
  return modules.get(normalizeAssetPath(module));
}

/** @internal One node kind a registered module provides. */
export interface PluginNodeKind {
  /** The module's project path. */
  readonly module: string;
  readonly node: PluginNodeDescriptor;
  /** Its catalogue entry, with the descriptor's named parameters (the graph editor's card). */
  readonly schema: NodeKindSchema;
}

/** @internal Every node kind of every registered module, by module path then the descriptor's order. */
export function pluginNodeKinds(): readonly PluginNodeKind[] {
  return [...modules.keys()].sort().flatMap((module) => modules.get(module)!.nodes.map((node) => ({ module, node, schema: pluginNodeKindSchema(module, node.name, modules.get(module))! })));
}

/** @internal Calls `listener` whenever a module is registered or unregistered; returns the unsubscribe. */
export function onPluginNodeKindsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// --- descriptor-generated kinds --------------------------------------------------------------------------------------

/** Card names the generated kind uses itself; a descriptor parameter with one of them is shown with a trailing `_`. */
const RESERVED = new Set(["module", "node"]);
const cardName = (d: PluginParamDescriptor): string => (RESERVED.has(d.name) ? `${d.name}_` : d.name);

const generated = new WeakMap<PluginModuleDescriptor, Map<string, NodeKindSchema>>();

function paramDoc(d: PluginParamDescriptor): string {
  const range = d.min !== null && d.max !== null ? `, ${d.min} to ${d.max}` : "";
  const unit = d.unit === "none" ? "" : ` (${d.unit})`;
  return `The module's ${d.kind} parameter "${d.name}"${unit}${range}${d.animatable ? "; a graph parameter can drive it" : ""}.`;
}

function paramSchema(d: PluginParamDescriptor): NodeParamSchema {
  const extra = {
    unit: d.unit,
    ...(d.min !== null && { min: d.min }),
    ...(d.max !== null && { max: d.max }),
    ...(d.animatable && { animatable: true, parameterTypes: [d.kind] as const }),
  };
  const name = cardName(d), doc = paramDoc(d);
  switch (d.kind) {
    case "float": return P.float(name, d.default as number, doc, extra);
    case "int": return P.int(name, d.default as number, doc, extra);
    case "bool": return P.bool(name, d.default as boolean, doc, extra);
    case "vec2": return P.vec2(name, d.default as number[], doc, extra);
    case "vec3": return P.vec3(name, d.default as number[], doc, extra);
    case "quat": return P.quat(name, d.default as number[], doc, extra);
  }
}

/** A descriptor value's block words. */
function words(d: PluginParamDescriptor, v: number | boolean | readonly number[]): number[] {
  switch (d.kind) {
    case "float": return [f32Bits(v as number)];
    case "int": return [(v as number) >>> 0];
    case "bool": return [v ? 1 : 0];
    default: return (v as readonly number[]).map(f32Bits);
  }
}

/** The node's value of `d` as block words (clamped and defaulted by the packer). */
function valueWords(p: NodePacker, d: PluginParamDescriptor): number[] {
  const name = cardName(d);
  switch (d.kind) {
    case "float": return words(d, p.num(name));
    case "int": return words(d, p.int(name) ?? (d.default as number));
    case "bool": return words(d, p.bool(name));
    default: {
      let v = p.vec(name);
      if (d.min !== null && d.max !== null && v.some((c) => c < d.min! || c > d.max!)) {
        v = v.map((c) => Math.min(d.max!, Math.max(d.min!, c)));
        p.problem(`components outside ${d.min}..${d.max}; using ${JSON.stringify(v)}.`, name, true);
      }
      return words(d, v);
    }
  }
}

function generateKind(module: string, descriptor: PluginModuleDescriptor, node: PluginNodeDescriptor): NodeKindSchema {
  const names = descriptor.nodes.map((n) => n.name);
  const inputs = { min: node.inputs, max: node.inputs, names: node.inputs === 1 ? ["input"] : Array.from({ length: node.inputs }, (_, i) => `input${i}`) };
  const params: NodeParamSchema[] = [
    P.asset("module", "plugin", "The plugin module."),
    P.enum("node", names, "The module's node kind.", { default: node.name }),
    ...node.params.map(paramSchema),
  ];
  const doc = `${node.name}: a node of the third-party module ${module}, run in its sandbox.`;
  return kind("plugin", "plugin", 0, doc, inputs, params, (p) => {
    p.push(p.asset("module"), node.kind, node.stateBytes);
    const block: number[] = [];
    const binds: number[] = [];
    for (const d of node.params) {
      const v = p.value(cardName(d));
      if (typeof v === "string") {
        // A graph parameter's name: a binding for an animatable parameter; the default sits in the block under it.
        if (d.animatable) {
          const q = p.parameter(cardName(d));
          if (q !== NONE) binds.push(block.length, d.words, q);
        } else p.problem(`the module doesn't mark "${d.name}" animatable, so a graph parameter can't drive it; using its default.`, cardName(d));
        block.push(...words(d, d.default));
      } else block.push(...valueWords(p, d));
    }
    p.push(block.length, ...block, binds.length / 3, ...binds);
  });
}

/**
 * @internal The catalogue entry of node `node` (its descriptor name) of the module `module`, generated from its
 * descriptor (the registered one unless given), or undefined when the module isn't known or has no such node.
 */
export function pluginNodeKindSchema(module: string, node: string, descriptor = pluginNodeModuleDescriptor(module)): NodeKindSchema | undefined {
  if (!descriptor) return undefined;
  let byNode = generated.get(descriptor);
  if (!byNode) generated.set(descriptor, (byNode = new Map()));
  const known = byNode.get(node);
  if (known) return known;
  const d = descriptor.nodes.find((n) => n.name === node);
  if (!d) return undefined;
  const out = generateKind(normalizeAssetPath(module), descriptor, d);
  byNode.set(node, out);
  return out;
}

const resolve = (params: Readonly<Record<string, NodeParamValue>>, context: NodeResolveContext): NodeKindSchema | undefined => {
  const { module, node } = params;
  if (typeof module !== "string" || typeof node !== "string") return undefined;
  return pluginNodeKindSchema(module, node, context.pluginDescriptor(normalizeAssetPath(module)));
};

/** The generic kind: raw words, or (with `node` and a known descriptor) the generated kind through `resolve`. */
const PLUGIN_NODE: NodeKindSchema = {
  ...kind("plugin", "plugin", 0, "A third-party node, run in its module's sandbox.", I.range(0, MAX_INPUTS, "inputs"), [
    P.asset("module", "plugin", "The plugin module."),
    P.name("node", "The module's node kind by its descriptor name: with the module's descriptor loaded, the node takes that kind's named parameters instead of raw words."),
    P.int("nodeKind", 0, "The node kind in the module (the descriptor's `kind`), for raw words.", { min: 0 }),
    P.int("stateBytes", 0, "The kind's per-instance state bytes, as the descriptor says, for raw words.", { min: 0 }),
    P.list("block", "intList", "The parameter block's words, in the descriptor's layout (missing words take its defaults)."),
    P.list("bindOffsets", "intList", "Per binding, the block word it writes.", { min: 0 }),
    P.list("bindCounts", "intList", "Per binding, its word count (1–4).", { min: 1, max: 4 }),
    P.list("bindParameters", "parameterList", "Per binding, the graph parameter copied there each evaluation.", { parameterTypes: ["float", "int", "bool", "vec2", "vec3", "quat"] }),
  ], (p) => {
    const node = p.value("node");
    if (node !== undefined) p.problem(`the module's descriptor isn't loaded or has no node ${JSON.stringify(node)}; the block is packed from raw words.`, "node");
    p.push(p.asset("module"), p.int("nodeKind") ?? 0, p.int("stateBytes") ?? 0);
    const block = p.list("block");
    p.push(block.length, ...block);
    const off = p.list("bindOffsets"), cnt = p.list("bindCounts"), par = p.list("bindParameters");
    if (off.length !== cnt.length || off.length !== par.length) p.problem("bindOffsets, bindCounts and bindParameters need the same length; the shortest is used.", "bindOffsets");
    const m = Math.min(off.length, cnt.length, par.length);
    p.push(m);
    for (let i = 0; i < m; i++) p.push(off[i], cnt[i], par[i] ?? NONE);
  }),
  resolve,
};

export const PLUGIN_NODES: NodeFamilyCatalogue = {
  family: "plugin",
  kinds: [PLUGIN_NODE],
};
