/**
 * Node family `retarget` (`anim-graph/src/retarget.rs`): the runtime retarget node, running a source graph on the
 * map's source skeleton inside its own state words (declared capacities, D70) and retargeting its pose (D47).
 * Internal: not public API.
 */
import { I, kind, NONE, P, type NodeFamilyCatalogue } from "./schema";

/** `MAX_GOALS`. */
const MAX_GOALS = 8;
const ROOT_AXES = ["scaled", "unscaled", "locked"];

export const RETARGET_NODES: NodeFamilyCatalogue = {
  family: "retarget",
  kinds: [
    kind("retarget", "retarget", 0, "Runs a source graph on another skeleton and retargets its pose onto this one.", I.none, [
      P.asset("map", "retargetMap", "The retarget map (source and target skeletons, profiles and bone maps)."),
      P.asset("source", "graph", "The source graph, evaluated on the map's source skeleton."),
      P.int("stateWords", 16384, "State capacity: words the source graph may use at the source skeleton's size.", { min: 0 }),
      P.int("depth", 8, "The source graph's pose-stack levels.", { min: 0, max: 64 }),
      P.int("parameters", 64, "Parameter capacity.", { min: 0, max: 1024 }),
      P.enum("rootX", ROOT_AXES, "The root's x translation: scaled by the leg ratio, unscaled, or locked."),
      P.enum("rootY", ROOT_AXES, "The root's y translation."),
      P.enum("rootZ", ROOT_AXES, "The root's z translation."),
      P.list("goalWeights", "floatList", "Pin weight per IK goal, in the map's goal order.", { unit: "ratio", min: 0, max: 1, maxItems: MAX_GOALS }),
      P.list("goalParameters", "parameterList", "Per goal, a float parameter giving its weight instead (\"\" for none).", { parameterTypes: ["float"], maxItems: MAX_GOALS }),
    ], (p) => {
      p.push(p.asset("map"), p.asset("source"), p.int("stateWords") ?? 0, p.int("depth") ?? 0, p.int("parameters") ?? 0);
      p.push(p.choice("rootX"), p.choice("rootY"), p.choice("rootZ"));
      const w = p.list("goalWeights");
      const q = p.list("goalParameters");
      const n = Math.min(MAX_GOALS, Math.max(w.length, q.length));
      if (Math.max(w.length, q.length) > MAX_GOALS) p.problem(`at most ${MAX_GOALS} goals; the rest are dropped.`, "goalWeights");
      p.push(n);
      for (let k = 0; k < n; k++) p.push(w[k] ?? 0x3f800000, q[k] ?? NONE);
    }),
  ],
};
