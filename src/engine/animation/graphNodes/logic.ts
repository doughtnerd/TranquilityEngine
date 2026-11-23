/**
 * Node family `logic` (`anim-graph/src/logic.rs`): state machines (a `MACHINES` record names the node; no words),
 * the seeded random selector, and chooser tables (a `CHOOSERS` record names the node). Internal: not public API.
 */
import { I, kind, P, type NodeFamilyCatalogue } from "./schema";

export const LOGIC_NODES: NodeFamilyCatalogue = {
  family: "logic",
  kinds: [
    kind("logic", "stateMachine", 0, "A state machine: states, priority transitions, any-state, travel and jump (its `machine`).", I.none, [], undefined, "machine"),
    kind("logic", "random", 1, "Picks one input each time it is initialised, from the instance's seeded generator.", I.range(1, 32, "choices"), [
      P.enum("mode", ["weighted", "shuffle", "roundRobin"], "Weighted (avoiding the last picks), every choice once per cycle, or in order."),
      P.int("avoid", 0, "Weighted: none of the last N picks while another has weight; shuffle: N ≥ 1 keeps a new cycle from starting with the last pick.", { min: 0, max: 8 }),
      P.list("weights", "floatList", "Weighted: one weight per input (1 when absent).", { min: 0 }),
    ], (p) => {
      p.push(p.choice("mode"), p.int("avoid") ?? 0);
      const w = p.list("weights");
      if (w.length > p.inputCount) p.problem(`has ${w.length} weights for ${p.inputCount} inputs; the rest are dropped.`, "weights");
      p.push(...w.slice(0, p.inputCount));
    }),
    kind("logic", "chooser", 2, "A chooser table: the first row whose condition holds picks its result (its `chooser`).", I.none, [
      P.bool("everyUpdate", false, "Re-evaluate the rows every update (else only when initialised)."),
      P.float("blendTime", 0, "Blend time when the pick changes.", { unit: "seconds", min: 0 }),
    ], undefined, "chooser"),
  ],
};
