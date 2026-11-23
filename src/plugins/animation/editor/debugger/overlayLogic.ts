// The live graph overlay's view model (ADR 0373 "Live debugger"; T52): one frame's debug report named by the graph
// editor's ids. Node indices become node ids (the compile's node table), machine indices machine node ids, state
// indices state names, transition indices the editor's transition places (`TransitionRef`, from the compile's
// transition paths through T51's `problemPlace`), and each blocker a sentence saying why the transition doesn't fire —
// for a false condition, the failing comparison and its operand's current value. Pure.
import type { AnimGraph, Condition, Transition } from "../../../../engine/animation/animGraph";
import type { CompiledAnimGraph } from "../../../../engine/animation/graphCompile";
import { BLOCK_CONDITION, BLOCK_INTERRUPT, BLOCK_READY, BLOCK_SHADOWED, BLOCK_TRAVEL, BLOCK_WHEN } from "../../runtime/wasm/wire/debug";
import { DEBUG_NONE, type DebugMachineRecord, type DebugReport, type DebugTransitionRecord } from "../../runtime/features/debug/report";
import { conditionText, OPERAND_LABELS } from "../graphEditor/conditionLogic";
import { nodeById } from "../graphEditor/graphEditLogic";
import { priorityLabel, transitionsOf, type TransitionRef } from "../graphEditor/machineLogic";
import { problemPlace, transitionKey } from "../graphEditor/problemLogic";

/** An active node: its effective weight and its timing clip's playhead. */
export interface LiveNode {
  readonly weight: number;
  /** Seconds into its timing clip (0 without one). */
  readonly time: number;
  /** The playhead over the clip's duration (its phase, 0–1). */
  readonly normalized: number;
}

/** A state machine's live state. */
export interface LiveMachine {
  /** The current state's name (null when the report names none the graph has). */
  readonly current: string | null;
  /** The state a bridge leads to, or null. */
  readonly target: string | null;
  /** The travel target, or null. */
  readonly travel: string | null;
  /** The transition in progress (fading), or null. */
  readonly active: TransitionRef | null;
  /** Its fade, 0–1 (null when none is in progress). */
  readonly fade: number | null;
  readonly stateTime: number;
  readonly normalized: number;
  /** The last transition fired, or null. */
  readonly lastFired: TransitionRef | null;
}

/** What blocks a candidate transition (`ready`: it fires this frame). */
export type BlockerKind = "ready" | "condition" | "shadowed" | "interrupt" | "when" | "travel";

/** A candidate transition of a machine's current state. */
export interface LiveTransition {
  readonly blocker: BlockerKind;
  /** Why it doesn't fire (or that it does): the tooltip. */
  readonly why: string;
}

/** A request name the conditions read. */
export interface LiveRequest {
  readonly name: string;
  /** Seconds left (0: not live). */
  readonly life: number;
}

/** One frame of the graph, by the editor's ids. */
export interface GraphOverlay {
  /** Node id → its live state (active nodes only). */
  readonly nodes: ReadonlyMap<string, LiveNode>;
  /** Machine node id → its live state. */
  readonly machines: ReadonlyMap<string, LiveMachine>;
  /** `transitionKey(machine, ref)` → the candidate's blocker (candidates of each machine's current state only). */
  readonly transitions: ReadonlyMap<string, LiveTransition>;
  readonly requests: readonly LiveRequest[];
}

const BLOCKERS: Readonly<Record<number, BlockerKind>> = {
  [BLOCK_READY]: "ready",
  [BLOCK_CONDITION]: "condition",
  [BLOCK_SHADOWED]: "shadowed",
  [BLOCK_INTERRUPT]: "interrupt",
  [BLOCK_WHEN]: "when",
  [BLOCK_TRAVEL]: "travel",
};

const INDEXED = /^([A-Za-z]+)\[(\d+)\]$/;

/** A number as the debugger prints it: whole numbers plain, others to 2 decimals. */
export const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/** The machine node and transition place a compile's transition path names in `graph`, or null. */
export function transitionAt(graph: AnimGraph, path: string | undefined): { machine: string; ref: TransitionRef; transition: Transition } | null {
  if (!path) return null;
  const place = problemPlace(graph, path);
  const m = place.node ? nodeById(graph, place.node)?.machine : undefined;
  if (!place.node || !place.transition || !m) return null;
  const transition = transitionsOf(m, place.transition.from)[place.transition.index];
  return transition ? { machine: place.node, ref: place.transition, transition } : null;
}

/** The condition term a compile's condition path names (`….transitions[0].if.all[1]`), or null. */
export function conditionAt(graph: AnimGraph, path: string | undefined): Condition | null {
  if (!path) return null;
  const i = path.indexOf(".if");
  const t = transitionAt(graph, i < 0 ? undefined : path.slice(0, i));
  let c: Condition | null = t?.transition.if ?? null;
  for (const part of path.slice(i + 3).split(".").filter(Boolean)) {
    const m = INDEXED.exec(part);
    if (!c || !m) return null;
    const list = m[1] === "all" && "all" in c ? c.all : m[1] === "any" && "any" in c ? c.any : null;
    c = list?.[Number(m[2])] ?? null;
  }
  return c;
}

/** A comparison's operand and its current value, as words ("moving is false", "request Jump isn't live"). */
export function operandNow(graph: AnimGraph, c: Condition, value: number): string {
  if ("request" in c) return `request ${c.request} ${value !== 0 ? "is live" : "isn't live"}`;
  if ("param" in c) {
    const type = graph.parameters.find((p) => p.name === c.param)?.type;
    return `${c.param} is ${type === "bool" ? String(value !== 0) : type === "int" ? String(Math.round(value)) : num(value)}`;
  }
  if ("operand" in c) return `${OPERAND_LABELS[c.operand].toLowerCase()} is ${num(value)}`;
  if ("curve" in c) return `curve ${c.curve} is ${num(value)}`;
  return `the value is ${num(value)}`;
}

/** Why a candidate transition doesn't fire (or that it does), in a sentence. */
export function blockerText(graph: AnimGraph, tables: CompiledAnimGraph, record: DebugTransitionRecord, machine: DebugMachineRecord | undefined, machineId: string): string {
  const kind = BLOCKERS[record.blocker];
  const self = transitionAt(graph, tables.transitions[record.transition]);
  switch (kind) {
    case "ready":
      return "Ready: it fires this frame.";
    case "condition": {
      const term = conditionAt(graph, tables.conditions[record.detail]);
      if (!term) return "Its condition is false.";
      return `Its condition is false: ${conditionText(term)} fails, because ${operandNow(graph, term, record.value)}.`;
    }
    case "shadowed": {
      const by = transitionAt(graph, tables.transitions[record.detail]);
      const label = by && by.machine === machineId ? priorityLabel(by.ref) : "another one";
      return `Ready, but transition ${label} is tried first and fires instead.`;
    }
    case "interrupt":
      return "The transition in progress doesn't let it interrupt.";
    case "when": {
      const when = self?.transition.when;
      const now = machine ? ` (normalised time is ${num(machine.normalized)})` : "";
      if (when === "exit") return `It waits for the state's exit time${now}.`;
      if (typeof when === "string" && when.startsWith("marker:")) return `It waits for the marker "${when.slice(7)}".`;
      if (typeof when === "number") return `It waits for normalised time ${num(when)}${now}.`;
      return "Its timing isn't reached.";
    }
    case "travel":
      return "The machine is travelling along another path.";
    default:
      return "Unknown blocker.";
  }
}

/** One frame's overlay: `report` named by `tables` (the game's compile) in `graph` (the edited source). */
export function overlayModel(graph: AnimGraph, tables: CompiledAnimGraph, report: DebugReport): GraphOverlay {
  const nodes = new Map<string, LiveNode>();
  for (const n of report.nodes) {
    const id = tables.nodes[n.node];
    if (!id) continue; // a node the compiler added
    const had = nodes.get(id);
    nodes.set(id, { weight: (had?.weight ?? 0) + n.weight, time: n.time, normalized: n.normalized });
  }
  const machines = new Map<string, LiveMachine>();
  const records = new Map<number, DebugMachineRecord>();
  for (const m of report.machines) {
    const info = tables.machines[m.machine];
    if (!info) continue;
    records.set(m.machine, m);
    const state = (i: number) => (i === DEBUG_NONE ? null : (info.states[i] ?? null));
    const ref = (t: number) => (t === DEBUG_NONE ? null : (transitionAt(graph, tables.transitions[t])?.ref ?? null));
    const fading = m.active !== DEBUG_NONE && m.duration > 0 && m.elapsed < m.duration;
    machines.set(info.node, {
      current: state(m.current),
      target: state(m.target),
      travel: state(m.travel),
      active: fading ? ref(m.active) : null,
      fade: fading ? Math.min(1, Math.max(0, m.elapsed / m.duration)) : null,
      stateTime: m.stateTime,
      normalized: m.normalized,
      lastFired: ref(m.lastFired),
    });
  }
  const transitions = new Map<string, LiveTransition>();
  for (const t of report.transitions) {
    const info = tables.machines[t.machine];
    const at = transitionAt(graph, tables.transitions[t.transition]);
    if (!info || !at || at.machine !== info.node) continue;
    transitions.set(transitionKey(at.machine, at.ref), { blocker: BLOCKERS[t.blocker] ?? "condition", why: blockerText(graph, tables, t, records.get(t.machine), info.node) });
  }
  const requests = report.requests.map((r) => ({ name: tables.strings[r.name] ?? `#${r.name}`, life: r.life }));
  return { nodes, machines, transitions, requests };
}
