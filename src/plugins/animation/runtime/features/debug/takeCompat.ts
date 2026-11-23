// What changed in the project since a take recorded an Animator (ADR 0348 "replays against current ..."; T73): the take
// keeps the graph's compiled tables and a hash of its bytes, so a replay can say which names went missing and whether
// the graph's logic differs, and the debugger can show what it still can (the recorded report and parameters need only the
// take's own tables; a pose needs the current graph to accept the recorded snapshot). Pure.
import type { CompiledAnimGraph } from "../../../../../engine/animation/graphCompile";
import type { TakeTargetInfo } from "./takeRecords";

/** What the project's graph is now (null: the graph isn't loaded or no longer exists). */
export interface CurrentGraph {
  readonly graphHash: number;
  readonly tables: CompiledAnimGraph;
  readonly bones: number;
}

/** How a replay stands against the current project. */
export interface TakeCompat {
  /** Poses can be re-evaluated: the graph compiles to the same bytes on the same bone count. */
  readonly poses: boolean;
  /** What differs, one sentence each (empty: nothing). */
  readonly notes: readonly string[];
}

const names = (list: readonly string[]): string[] => list.filter((n) => n !== "");

/** A list's entries that were added and removed, as sentences of `what` ("parameter"). */
function listDiff(what: string, was: readonly string[], now: readonly string[]): string[] {
  const before = new Set(names(was));
  const after = new Set(names(now));
  const out: string[] = [];
  for (const n of before) if (!after.has(n)) out.push(`The ${what} "${n}" is gone from the graph.`);
  for (const n of after) if (!before.has(n)) out.push(`The graph has a new ${what} "${n}".`);
  return out;
}

/** The states of every machine as `machine/state` names. */
const stateNames = (t: CompiledAnimGraph): string[] => t.machines.flatMap((m) => m.states.map((s) => `${m.node}/${s}`));

/** Compares what a take recorded of an Animator with the project's graph now. */
export function compareGraph(recorded: TakeTargetInfo, current: CurrentGraph | null, changedWhileRecording = false): TakeCompat {
  const notes: string[] = [];
  if (changedWhileRecording) notes.push("The graph changed while the take was recording, so earlier frames may not match it.");
  if (!current) {
    notes.push(`The graph "${recorded.graph}" isn't loaded in this project: the recorded graph states and parameters are shown, but no poses.`);
    return { poses: false, notes };
  }
  const before = notes.length;
  notes.push(
    ...listDiff("parameter", recorded.tables.parameters, current.tables.parameters),
    ...listDiff("layer", recorded.tables.layers, current.tables.layers),
    ...listDiff("slot", recorded.tables.slots, current.tables.slots),
    ...listDiff("linked graph", recorded.tables.linked, current.tables.linked),
    ...listDiff("state", stateNames(recorded.tables), stateNames(current.tables)),
  );
  const hashed = recorded.graphHash !== current.graphHash;
  if (hashed && notes.length === before) notes.push("The graph's logic changed since the take (a condition, a duration or a clip reference): the recorded states are shown against it.");
  const bones = recorded.bones !== current.bones;
  if (bones) notes.push(`The skeleton has ${current.bones} bones now; the take recorded ${recorded.bones}.`);
  const poses = !hashed && !bones;
  if (!poses) notes.push("Poses can't be re-evaluated: the recorded state doesn't fit the graph as it is now.");
  return { poses, notes };
}
