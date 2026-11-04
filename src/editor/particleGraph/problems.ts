// Where a particle graph problem points (ADR 0060): the compiler and the parser give each problem
// an id path (`s1`, `s1.b3.rate`, `s1.spawn.settings`, `n2`, `n2.x`); the panel badges the
// system, block or node it names and frames it when the problem is clicked.
import type { GraphProblem, ParticleGraph } from "../../engine/scene/particleGraph";
import { findBlock } from "./graphEdit";

export interface ProblemPlace {
  system?: string;
  block?: string;
  /** A block's or node's input. */
  input?: string;
  node?: string;
}

/** The system, block (and input) or node a problem's `at` names, or null. */
export function locateProblem(graph: ParticleGraph, at: string | undefined): ProblemPlace | null {
  if (!at) return null;
  const parts = at.split(/[.[\]]/).filter(Boolean);
  const head = parts[0];
  if (graph.nodes.some((n) => n.id === head)) return parts[1] ? { node: head, input: parts[1] } : { node: head };
  if (!graph.systems.some((s) => s.id === head)) return null;
  if (parts[1] && findBlock(graph, head, parts[1])) return parts[2] ? { system: head, block: parts[1], input: parts[2] } : { system: head, block: parts[1] };
  return { system: head };
}

/** The compiler's warning on a wire whose source combines per-particle values (it runs only on a GPU backend). */
export const isGpuProblem = (p: GraphProblem) => /GPU backend/.test(p.message);

export interface ProblemIndex {
  /** By system id, block key (`system.block`) and node id: the messages about it. */
  byItem: Map<string, GraphProblem[]>;
  /** Value-wire targets (`s1.b3.rate`) the CPU backend can't run. */
  gpuWires: Set<string>;
}

/** Group problems by the item they're about, for badges. */
export function indexProblems(graph: ParticleGraph, problems: readonly GraphProblem[]): ProblemIndex {
  const byItem = new Map<string, GraphProblem[]>();
  const gpuWires = new Set<string>();
  const add = (key: string, p: GraphProblem) => byItem.set(key, [...(byItem.get(key) ?? []), p]);
  for (const p of problems) {
    const place = locateProblem(graph, p.at);
    if (!place) continue;
    if (place.node) add(place.node, p);
    else if (place.block) {
      add(`${place.system}.${place.block}`, p);
      if (place.input && isGpuProblem(p) && graph.edges.some((e) => e.to === p.at)) gpuWires.add(p.at!);
    } else if (place.system) add(place.system, p);
  }
  return { byItem, gpuWires };
}
