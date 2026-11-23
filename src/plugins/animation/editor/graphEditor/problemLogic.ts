// The compiler's problems on the graph (T30: each problem names a path into the source model, `nodes[3].params.speed`,
// `nodes[5].machine.states[1].transitions[0].if.any[1]`): where each one shows in the graph editor — on a node, on one of
// its fields, on a state, on a transition, a parameter or a layer.
import type { AnimGraph } from "../../../../engine/animation/animGraph";
import type { CompileProblem } from "../../../../engine/animation/graphCompile";
import type { TransitionRef } from "./machineLogic";

/** Where a problem shows. */
export interface ProblemPlace {
  /** The node it's on (its id). */
  readonly node?: string;
  /** The node parameter it's about. */
  readonly field?: string;
  /** The node's side table it's about ("machine", "chooser", "slot", "linked", "inputs"). */
  readonly part?: string;
  /** A state of the node's machine. */
  readonly state?: string;
  /** A transition of the node's machine. */
  readonly transition?: TransitionRef;
  /** A chooser row. */
  readonly row?: number;
  readonly parameter?: string;
  readonly layer?: string;
  /** The graph's output. */
  readonly output?: boolean;
}

const INDEXED = /^([A-Za-z]+)\[(\d+)\]/;

/** Where the problem at `path` shows in `graph` (empty when the path names nothing there). */
export function problemPlace(graph: AnimGraph, path: string): ProblemPlace {
  const parts = path.split(".");
  const head = INDEXED.exec(parts[0] ?? "");
  if (parts[0] === "output") return { output: true };
  if (!head) return {};
  const index = Number(head[2]);
  if (head[1] === "parameters") return graph.parameters[index] ? { parameter: graph.parameters[index]!.name } : {};
  if (head[1] === "layers") return graph.layers[index] ? { layer: graph.layers[index]!.name } : {};
  if (head[1] !== "nodes") return {};
  const node = graph.nodes[index];
  if (!node) return {};
  const rest = parts.slice(1);
  const first = rest[0] ?? "";
  if (first === "params") return { node: node.id, field: rest[1]?.replace(/\[\d+\]$/, "") };
  if (first.startsWith("inputs")) return { node: node.id, part: "inputs" };
  if (first === "machine" && node.machine) {
    const second = rest[1] ?? "";
    const st = INDEXED.exec(second);
    if (st && st[1] === "states") {
      const state = node.machine.states[Number(st[2])];
      if (!state) return { node: node.id, part: "machine" };
      const tr = INDEXED.exec(rest[2] ?? "");
      if (tr && tr[1] === "transitions") return { node: node.id, part: "machine", state: state.name, transition: { from: state.name, index: Number(tr[2]) } };
      return { node: node.id, part: "machine", state: state.name };
    }
    if (st && st[1] === "anyState") return { node: node.id, part: "machine", transition: { from: null, index: Number(st[2]) } };
    return { node: node.id, part: "machine" };
  }
  if (first === "chooser") {
    const row = INDEXED.exec(rest[1] ?? "");
    return row && row[1] === "rows" ? { node: node.id, part: "chooser", row: Number(row[2]) } : { node: node.id, part: "chooser" };
  }
  return { node: node.id, ...(first ? { part: first.replace(/\[\d+\]$/, "") } : {}) };
}

/** A problem with its place. */
export interface PlacedProblem extends CompileProblem {
  readonly place: ProblemPlace;
}

/** The problems by where they show: per node, per node field (`<node>/<field>`), per state (`<node>/<state>`), per transition (`<node>/<from|@any>/<index>`). */
export interface ProblemIndex {
  readonly all: readonly PlacedProblem[];
  readonly byNode: ReadonlyMap<string, readonly PlacedProblem[]>;
  readonly byField: ReadonlyMap<string, readonly PlacedProblem[]>;
  readonly byState: ReadonlyMap<string, readonly PlacedProblem[]>;
  readonly byTransition: ReadonlyMap<string, readonly PlacedProblem[]>;
  readonly byParameter: ReadonlyMap<string, readonly PlacedProblem[]>;
  readonly byLayer: ReadonlyMap<string, readonly PlacedProblem[]>;
}

/** A transition's key in `byTransition`. */
export const transitionKey = (node: string, ref: TransitionRef) => `${node}/${ref.from ?? "@any"}/${ref.index}`;

/** Index `problems` by where they show in `graph`. */
export function indexProblems(graph: AnimGraph, problems: readonly CompileProblem[]): ProblemIndex {
  const maps = { byNode: new Map(), byField: new Map(), byState: new Map(), byTransition: new Map(), byParameter: new Map(), byLayer: new Map() } as Record<string, Map<string, PlacedProblem[]>>;
  const add = (map: string, key: string, p: PlacedProblem) => {
    const m = maps[map]!;
    m.set(key, [...(m.get(key) ?? []), p]);
  };
  const all = problems.map((p): PlacedProblem => ({ ...p, place: problemPlace(graph, p.path) }));
  for (const p of all) {
    const { node, field, state, transition, parameter, layer } = p.place;
    if (node) add("byNode", node, p);
    if (node && field) add("byField", `${node}/${field}`, p);
    if (node && state) add("byState", `${node}/${state}`, p);
    if (node && transition) add("byTransition", transitionKey(node, transition), p);
    if (parameter) add("byParameter", parameter, p);
    if (layer) add("byLayer", layer, p);
  }
  return { all, ...(maps as unknown as Omit<ProblemIndex, "all">) };
}

/** The worst severity among `problems` (null for none). */
export const worst = (problems: readonly CompileProblem[] | undefined): "error" | "warning" | null =>
  !problems?.length ? null : problems.some((p) => p.severity === "error") ? "error" : "warning";
