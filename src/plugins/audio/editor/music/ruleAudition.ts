// Ed7: "audition this transition". Pure planning (which pair the rule wins, which segment to start in, where to seek, which
// parameter asks for the change) and one thin runner over Ed5's transport, so the audition is the shared `activeAudition`
// and the change goes through the same music player a game's script reaches.
//
// Reach: the change is requested from outside only for a music switch (its parameter picks the child; R2 turns the new
// value into a transition and R1's rule shapes it). A playlist changes only by its natural advance, so a playlist is
// auditioned when `to` follows `from` at the head of a sequence list. A container that is not the event's root can't be
// started on a chosen child through the event's parameters yet; the plan says so.
import { ticksToPosition, compileSegmentGrid, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { MusicContainerNode } from "../../../../engine/audio/musicFormat";
import { leafSegments } from "./ruleLint";
import { effectiveRule, ruleMatchesPair } from "./rulesModel";
import type { Transport, TransportTarget } from "./transport";

export interface TransitionAuditionPlan {
  readonly ok: true;
  readonly event: string;
  /** The segment the music starts in (the first segment under the `from` child). */
  readonly segmentId: string;
  readonly grid: SegmentGrid;
  readonly parameters: Record<string, number | string>;
  readonly from: TransportTarget;
  /** The pair the rule was auditioned on. */
  readonly pair: { readonly from: string; readonly to: string };
  /** The parameter change that asks for the transition, or null when the playlist advances by itself. */
  readonly request: { readonly name: string; readonly value: string } | null;
  /** A line for the person: what will happen. */
  readonly note: string;
}
export type TransitionAuditionRefusal = { readonly ok: false; readonly reason: string };

export interface AuditionOptions {
  /** A pair to prefer (the grid's chosen cell); used when this rule wins it. */
  readonly pair?: { readonly from: string; readonly to: string };
  /** The bar to start from in the `from` segment; default two bars before its exit cue (bar 1 when the exit is unknown). */
  readonly bar?: number;
}

const refuse = (reason: string): TransitionAuditionRefusal => ({ ok: false, reason });

/** The pair of two different children the rule `index` wins: the preferred one when it wins it, else the first in grid order. */
export function auditionPair(container: MusicContainerNode, index: number, prefer?: { from: string; to: string }): { from: string; to: string } | null {
  const ids = container.children.map((c) => c.id);
  const wins = (f: string, t: string): boolean => f !== t && ids.includes(f) && ids.includes(t) && effectiveRule(container, f, t).rule === index;
  if (prefer && wins(prefer.from, prefer.to)) return { from: prefer.from, to: prefer.to };
  const rule = container.transitions[index];
  if (!rule) return null;
  for (const f of ids) for (const t of ids) if (ruleMatchesPair(rule, f, t) && wins(f, t)) return { from: f, to: t };
  return null;
}

/** The default start bar of the audition: two bars before the exit cue, never before bar 1. */
export function leadBar(grid: SegmentGrid): number {
  if (!Number.isFinite(grid.exitTicks)) return 1;
  const p = ticksToPosition(grid, grid.exitTicks);
  return p ? Math.max(1, p.bar - 2) : 1;
}

export function planTransitionAudition(
  path: string, event: AudioEventAsset, container: MusicContainerNode, index: number, options: AuditionOptions = {},
): TransitionAuditionPlan | TransitionAuditionRefusal {
  const rule = container.transitions[index];
  if (!rule) return refuse("That rule no longer exists.");
  if (!event.musicRoot || event.musicRoot.id !== container.id) {
    return refuse("Audition plays the whole event from its root, so it can only start this transition when the container is the event's root.");
  }
  const pair = auditionPair(container, index, options.pair);
  if (!pair) return refuse("This rule wins no pair of two different children, so no change reaches it.");
  const fromNode = container.children.find((c) => c.id === pair.from)!;
  const toNode = container.children.find((c) => c.id === pair.to)!;
  const start = leafSegments(fromNode)[0];
  if (!start) return refuse(`${pair.from} has no segment to start in.`);
  const grid = compileSegmentGrid(start, { endSeconds: NaN });

  let parameters: Record<string, number | string> = {};
  let request: TransitionAuditionPlan["request"] = null;
  let note: string;
  if (container.type === "musicSwitch") {
    if (fromNode.value === undefined || toNode.value === undefined) {
      return refuse(`${fromNode.value === undefined ? pair.from : pair.to} has no value, so the switch's parameter can't pick it.`);
    }
    parameters = { [container.parameter]: fromNode.value };
    request = { name: container.parameter, value: toNode.value };
    note = `Starts in ${pair.from}, then sets ${container.parameter} to “${toNode.value}”.`;
  } else {
    if (container.mode !== "sequence" || container.children[0]?.id !== pair.from || container.children[1]?.id !== pair.to) {
      return refuse("A playlist changes only when it advances, so audition works for the first two items of a sequence playlist.");
    }
    note = `Starts in ${pair.from}; the playlist advances to ${pair.to} at the exit cue (a rule's own exit is ignored there).`;
  }
  const bar = options.bar !== undefined && Number.isInteger(options.bar) && options.bar >= 1 ? options.bar : leadBar(grid);
  const from: TransportTarget = bar <= 1 ? { kind: "start" } : { kind: "bar", bar };
  return { ok: true, event: path, segmentId: start.id, grid, parameters, from, pair, request, note: `${note} Playing from ${bar <= 1 ? "the start" : `bar ${bar}`}.` };
}

/** Play from `plan.from`, then request the change once the position has landed (through the shared audition). */
export async function runTransitionAudition(transport: Transport, plan: TransitionAuditionPlan): Promise<void> {
  await transport.play({ event: plan.event, segmentId: plan.segmentId, grid: plan.grid, parameters: plan.parameters, from: plan.from });
  if (plan.request && transport.state.value.phase === "playing") transport.requestParameter(plan.request.name, plan.request.value);
}
