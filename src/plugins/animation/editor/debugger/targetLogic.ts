// Which running Animator the graph editor debugs (ADR 0373 "on a selected Animator"; T52): the one picked in the
// debugger's menu, else the one the Hierarchy's live selection points at, else the only one running the graph. Pure.
import type { DebugTarget } from "./source";

/** The target to show: `chosen` while it runs, else `selected` when it runs this graph, else the only target. */
export function pickTarget(targets: readonly DebugTarget[], chosen: string | null, selected: string | null): DebugTarget | null {
  const by = (id: string | null) => (id ? (targets.find((t) => t.id === id) ?? null) : null);
  return by(chosen) ?? by(selected) ?? (targets.length === 1 ? targets[0]! : null);
}

/** The debugger bar's status line. */
export function debugStatus(live: boolean, targets: readonly DebugTarget[], target: DebugTarget | null): string {
  if (!live) return "Play the game to debug this graph live.";
  if (targets.length === 0) return "No Animator in the running game uses this graph.";
  if (!target) return "Select an Animator in the Hierarchy, or pick one here.";
  return `Debugging ${target.label}`;
}
