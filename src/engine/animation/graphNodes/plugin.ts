/**
 * Node family `plugin` (`anim-graph/src/plugin.rs`): one node kind of a third-party module (ADR 0370). The block's
 * own layout is the module descriptor's (`anim-plugin-sdk/src/descriptor.rs`, the same schema fields and unit ids as
 * this catalogue); here it is given as raw words, with bindings that copy graph parameters into it each evaluation
 * (the descriptor's animatable parameters). T45t generates named parameters from descriptors. Internal: not public API.
 */
import { I, kind, NONE, P, type NodeFamilyCatalogue } from "./schema";

/** `anim-plugin-sdk`'s `abi::MAX_INPUTS`. */
const MAX_INPUTS = 8;

export const PLUGIN_NODES: NodeFamilyCatalogue = {
  family: "plugin",
  kinds: [
    kind("plugin", "plugin", 0, "A third-party node, run in its module's sandbox.", I.range(0, MAX_INPUTS, "inputs"), [
      P.asset("module", "plugin", "The plugin module."),
      P.int("nodeKind", 0, "The node kind in the module (the descriptor's `kind`).", { min: 0 }),
      P.int("stateBytes", 0, "The kind's per-instance state bytes, as the descriptor says.", { min: 0 }),
      P.list("block", "intList", "The parameter block's words, in the descriptor's layout (missing words take its defaults)."),
      P.list("bindOffsets", "intList", "Per binding, the block word it writes.", { min: 0 }),
      P.list("bindCounts", "intList", "Per binding, its word count (1–4).", { min: 1, max: 4 }),
      P.list("bindParameters", "parameterList", "Per binding, the graph parameter copied there each evaluation.", { parameterTypes: ["float", "int", "bool", "vec2", "vec3", "quat"] }),
    ], (p) => {
      p.push(p.asset("module"), p.int("nodeKind") ?? 0, p.int("stateBytes") ?? 0);
      const block = p.list("block");
      p.push(block.length, ...block);
      const off = p.list("bindOffsets"), cnt = p.list("bindCounts"), par = p.list("bindParameters");
      if (off.length !== cnt.length || off.length !== par.length) p.problem("bindOffsets, bindCounts and bindParameters need the same length; the shortest is used.", "bindOffsets");
      const m = Math.min(off.length, cnt.length, par.length);
      p.push(m);
      for (let i = 0; i < m; i++) p.push(off[i], cnt[i], par[i] ?? NONE);
    }),
  ],
};
