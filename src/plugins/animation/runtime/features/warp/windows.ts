// Motion-warp windows of a compiled graph (ADR 0372; T40t, D67): the names `Animator.warp(window, target)` takes, each
// mapped to its `rig/motionWarp` node's index in the compiled graph. A window answers to its node's id, its node's
// name, and (for a window opened by cue markers) its start marker's name, the name the clip gives the window. The
// first node claiming a name keeps it. A pure library over the graph source and the compiler's node table.
import type { AnimGraph } from "../../../../../engine/animation/animGraph";

/** @internal Window name → `motionWarp` node index (see the file header). */
export function warpWindows(graph: AnimGraph, nodes: readonly string[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.family !== "rig" || n.kind !== "motionWarp") continue;
    const index = nodes.indexOf(n.id);
    if (index < 0) continue;
    const marker = n.params.window === "times" ? null : n.params.startMarker;
    for (const name of [n.id, n.name, typeof marker === "string" ? marker : null]) if (name && !out.has(name)) out.set(name, index);
  }
  return out;
}
