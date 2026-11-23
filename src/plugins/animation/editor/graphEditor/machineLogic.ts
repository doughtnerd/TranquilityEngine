// State machine edits of the animation graph editor (ADR 0373 "state machines as nested canvases, transitions drawn with
// their priority number; a transition list panel per state: reorder, a condition editor, blend settings and
// interruption"; D50–D54): states (unique names, entry, exit, sub-graph root), transitions (priority = list order, highest
// first; any-state ones checked before a state's own, D51), their `when`, `how`, duration, fade shape (D53) and interrupt
// list, and "Add as state" for a dropped clip (T18's refusal, now built). Pure functions; every edit a user can get
// refused is refused-or-next (ADR 0307, 0313).
import {
  DEFAULT_TRANSITION_DURATION, FADE_SHAPES, GRAPH_LIMITS, TRANSITION_HOWS,
  type AnimGraph, type Condition, type FadeShape, type MachineState, type StateMachine, type Transition, type TransitionHow, type TransitionWhen,
} from "../../../../engine/animation/animGraph";
import { AUDIO_FADE_SHAPE } from "../../../../engine/animation/graphCompile";
import { shapeLevel } from "../../../../engine/audio/playlist/fadeShapes";
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import { uniqueName } from "../../../../engine/core/uniqueName";
import { addNode, nodeById, nodeTitle, reaches, withMachine, type Added } from "./graphEditLogic";

/** Where a transition lives: a state's list (by name) or the machine's any-state list (null). */
export type TransitionOwner = string | null;

/** One transition's place. */
export interface TransitionRef {
  readonly from: TransitionOwner;
  readonly index: number;
}

/** The ids the machine canvas gives its pseudo-states (state names can't start with "@"). */
export const ENTRY_ID = "@entry";
export const ANY_ID = "@any";

export const stateOf = (m: StateMachine, name: string): MachineState | undefined => m.states.find((s) => s.name === name);
/** The machine's entry state (null entry: the first). */
export const entryOf = (m: StateMachine): string | null => m.entry ?? m.states[0]?.name ?? null;

/** A transition list (a state's, or the any-state list). */
export function transitionsOf(m: StateMachine, from: TransitionOwner): readonly Transition[] {
  return from === null ? m.anyState : (stateOf(m, from)?.transitions ?? []);
}

/** A transition's priority label: 1 is tried first; any-state ones are "A1", "A2"… (tried before every state's). */
export const priorityLabel = (ref: TransitionRef): string => (ref.from === null ? `A${ref.index + 1}` : String(ref.index + 1));

/** A new transition to `to` with the format's defaults (crossfade 0.2 s, linear, now, never interrupted). */
export const newTransition = (to: string): Transition => ({ id: "", to, if: null, when: "now", how: "crossfade", duration: DEFAULT_TRANSITION_DURATION, shape: "linear", bridge: null, interrupt: "never" });

const setList = (m: StateMachine, from: TransitionOwner, list: readonly Transition[]): StateMachine =>
  from === null ? { ...m, anyState: list } : { ...m, states: m.states.map((s) => (s.name === from ? { ...s, transitions: list } : s)) };

/** Every transition id of the machine except `except`'s. */
function transitionIds(m: StateMachine, except?: TransitionRef): string[] {
  const out: string[] = [];
  const add = (from: TransitionOwner, list: readonly Transition[]) => list.forEach((t, i) => t.id && !(except && except.from === from && except.index === i) && out.push(t.id));
  add(null, m.anyState);
  for (const s of m.states) add(s.name, s.transitions);
  return out;
}

/** Every named transition of the machine, with where it is: what an interrupt list may name. */
export function interruptChoices(m: StateMachine, except?: TransitionRef): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const add = (from: TransitionOwner, list: readonly Transition[]) =>
    list.forEach((t, i) => t.id && !(except && except.from === from && except.index === i) && out.push({ id: t.id, label: `${t.id} (${from ?? "Any State"} → ${t.to})` }));
  add(null, m.anyState);
  for (const s of m.states) add(s.name, s.transitions);
  return out;
}

/** Interrupt lists without `ids`. */
function dropInterrupters(t: Transition, ids: ReadonlySet<string>): Transition {
  if (typeof t.interrupt === "string" || !t.interrupt.some((x) => ids.has(x))) return t;
  const left = t.interrupt.filter((x) => !ids.has(x));
  return { ...t, interrupt: left.length ? left : "never" };
}
const mapTransitions = (m: StateMachine, f: (t: Transition) => Transition): StateMachine => ({
  ...m, anyState: m.anyState.map(f), states: m.states.map((s) => ({ ...s, transitions: s.transitions.map(f) })),
});

/** Why `name` can't name a state of `m` (other than `from`), or null. */
function whyNotStateName(m: StateMachine, name: string, from?: string): string | null {
  if (name === "") return "a state needs a name";
  if (name.startsWith("@")) return "a state's name can't start with @";
  if (name !== from && stateOf(m, name)) return `another state is named "${name}"`;
  return null;
}

// --- states ---------------------------------------------------------------------------------------------------------

/** What adding a state made. */
export interface AddedState {
  readonly graph: AnimGraph;
  readonly state: string;
}

/** A state named `name` (unique: "State", "State 2"…) at `position`, playing `root` (null: none yet). */
export function addState(graph: AnimGraph, machine: string, position: readonly [number, number], name = "State", root: string | null = null): EditResult<AddedState> {
  let made = "";
  const r = withMachine(graph, machine, (m) => {
    if (m.states.length >= GRAPH_LIMITS.states) return refuse(`a state machine has at most ${GRAPH_LIMITS.states} states`);
    made = uniqueName(name.trim() || "State", m.states.map((s) => s.name));
    const why = whyNotStateName(m, made);
    if (why) return refuse(why);
    if (root !== null) {
      const rootWhy = whyNotRoot(graph, machine, root);
      if (rootWhy) return refuse(rootWhy);
    }
    return accept({ ...m, states: [...m.states, { name: made, root, exit: false, transitions: [], position: [Math.round(position[0]), Math.round(position[1])] }] });
  });
  return "refused" in r ? r : accept({ graph: r.next, state: made });
}

/** A state removed with the transitions into it (and their ids from interrupt lists); the entry moves to the first state if it was this one. */
export function removeState(graph: AnimGraph, machine: string, name: string): EditResult<AnimGraph> {
  return withMachine(graph, machine, (m) => {
    const s = stateOf(m, name);
    if (!s) return refuse(`there's no state named "${name}"`);
    const gone = new Set<string>();
    for (const t of s.transitions) if (t.id) gone.add(t.id);
    const keep = (t: Transition) => { if (t.to === name) { if (t.id) gone.add(t.id); return false; } return true; };
    let next: StateMachine = {
      entry: m.entry === name ? null : m.entry,
      anyState: m.anyState.filter(keep),
      states: m.states.filter((x) => x.name !== name).map((x) => ({ ...x, transitions: x.transitions.filter(keep) })),
    };
    next = mapTransitions(next, (t) => dropInterrupters(t, gone));
    return accept(next);
  });
}

/** Rename a state and every transition into it (and the entry). Empty, "@…" and taken names are refused. */
export function renameState(graph: AnimGraph, machine: string, from: string, to: string): EditResult<AnimGraph> {
  const name = to.trim();
  return withMachine(graph, machine, (m) => {
    if (!stateOf(m, from)) return refuse(`there's no state named "${from}"`);
    if (name === from) return accept(m);
    const why = whyNotStateName(m, name, from);
    if (why) return refuse(why);
    const r = (x: string) => (x === from ? name : x);
    const renamed = mapTransitions(m, (t) => ({ ...t, to: r(t.to) }));
    return accept({ ...renamed, entry: m.entry === from ? name : m.entry, states: renamed.states.map((s) => (s.name === from ? { ...s, name } : s)) });
  });
}

/** The machine's entry state. */
export const setEntry = (graph: AnimGraph, machine: string, name: string) =>
  withMachine(graph, machine, (m) => (stateOf(m, name) ? accept(entryOf(m) === name && m.entry !== null ? m : { ...m, entry: name }) : refuse(`there's no state named "${name}"`)));

/** Whether a state is an exit state (a sub-machine's `exit` fires on it, D53). */
export const setExit = (graph: AnimGraph, machine: string, name: string, exit: boolean) =>
  withMachine(graph, machine, (m) => (stateOf(m, name) ? accept({ ...m, states: m.states.map((s) => (s.name === name ? { ...s, exit } : s)) }) : refuse(`there's no state named "${name}"`)));

function whyNotRoot(graph: AnimGraph, machine: string, root: string): string | null {
  if (!nodeById(graph, root)) return "that node isn't in the graph";
  if (root === machine) return "a state can't play its own machine";
  if (reaches(graph, root, machine)) return `that would make a cycle: ${nodeTitle(nodeById(graph, root)!)} already evaluates this machine`;
  return null;
}

/** The node a state plays (its sub-graph's root; null: none). */
export function setStateRoot(graph: AnimGraph, machine: string, name: string, root: string | null): EditResult<AnimGraph> {
  if (root !== null) {
    const why = whyNotRoot(graph, machine, root);
    if (why) return refuse(why);
  }
  return withMachine(graph, machine, (m) => (stateOf(m, name) ? accept({ ...m, states: m.states.map((s) => (s.name === name ? { ...s, root } : s)) }) : refuse(`there's no state named "${name}"`)));
}

/** States moved on the machine canvas (whole units). */
export function moveStates(graph: AnimGraph, machine: string, to: ReadonlyMap<string, { x: number; y: number }>): AnimGraph {
  const r = withMachine(graph, machine, (m) => accept({ ...m, states: m.states.map((s) => { const p = to.get(s.name); return p ? { ...s, position: [Math.round(p.x), Math.round(p.y)] as const } : s; }) }));
  return "refused" in r ? graph : r.next;
}

// --- transitions ----------------------------------------------------------------------------------------------------

/** A transition from `from` (a state, or null for any state) to `to`, with the lowest priority of its list. */
export function addTransition(graph: AnimGraph, machine: string, from: TransitionOwner, to: string): EditResult<AnimGraph> {
  return withMachine(graph, machine, (m) => {
    if (!stateOf(m, to)) return refuse(`there's no state named "${to}"`);
    if (from !== null && !stateOf(m, from)) return refuse(`there's no state named "${from}"`);
    const list = transitionsOf(m, from);
    if (list.length >= GRAPH_LIMITS.transitions) return refuse(`a state has at most ${GRAPH_LIMITS.transitions} transitions`);
    return accept(setList(m, from, [...list, newTransition(to)]));
  });
}

const withTransition = (graph: AnimGraph, machine: string, ref: TransitionRef, f: (t: Transition, m: StateMachine) => EditResult<Transition>): EditResult<AnimGraph> =>
  withMachine(graph, machine, (m) => {
    const list = transitionsOf(m, ref.from);
    const t = list[ref.index];
    if (!t) return refuse("there's no such transition");
    const r = f(t, m);
    if ("refused" in r) return r;
    return accept(r.next === t ? m : setList(m, ref.from, list.map((x, i) => (i === ref.index ? r.next : x))));
  });

/** A transition removed (and its id from interrupt lists). */
export function removeTransition(graph: AnimGraph, machine: string, ref: TransitionRef): EditResult<AnimGraph> {
  return withMachine(graph, machine, (m) => {
    const list = transitionsOf(m, ref.from);
    const t = list[ref.index];
    if (!t) return refuse("there's no such transition");
    const next = setList(m, ref.from, list.filter((_, i) => i !== ref.index));
    return accept(t.id ? mapTransitions(next, (x) => dropInterrupters(x, new Set([t.id]))) : next);
  });
}

/** Move a transition to place `to` of its list: its priority (place 0 is tried first). */
export function moveTransition(graph: AnimGraph, machine: string, ref: TransitionRef, to: number): EditResult<AnimGraph> {
  return withMachine(graph, machine, (m) => {
    const list = [...transitionsOf(m, ref.from)];
    if (!list[ref.index] || to < 0 || to >= list.length) return refuse("there's no such place");
    if (to === ref.index) return accept(m);
    const [t] = list.splice(ref.index, 1);
    list.splice(to, 0, t!);
    return accept(setList(m, ref.from, list));
  });
}

/** A transition's condition (null: always). */
export const setTransitionCondition = (graph: AnimGraph, machine: string, ref: TransitionRef, condition: Condition | null) =>
  withTransition(graph, machine, ref, (t) => accept(JSON.stringify(t.if) === JSON.stringify(condition) ? t : { ...t, if: condition }));

/** What `setTransition` may change. */
export interface TransitionPatch {
  readonly id?: string;
  readonly to?: string;
  readonly when?: TransitionWhen;
  readonly how?: TransitionHow;
  readonly duration?: number;
  readonly shape?: FadeShape;
  readonly bridge?: string | null;
  readonly interrupt?: "never" | "any" | readonly string[];
}

/**
 * A transition's fields: its id (unique in the machine; a rename follows into interrupt lists), target, when (now, exit,
 * `marker:<name>` or a normalised time ≥ 0), how (a cut has no duration; a bridge needs its node), duration (≥ 0), fade
 * shape and interrupt list (other transitions' ids of this machine).
 */
export function setTransition(graph: AnimGraph, machine: string, ref: TransitionRef, patch: TransitionPatch): EditResult<AnimGraph> {
  let renamed = null as [string, string] | null;
  const r = withTransition(graph, machine, ref, (t, m) => {
    const next: { -readonly [K in keyof Transition]: Transition[K] } = { ...t };
    if (patch.id !== undefined) {
      const id = patch.id.trim();
      if (id !== t.id) {
        if (id !== "" && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(id)) return refuse("a transition id is letters, digits, _ and ., not starting with a digit");
        if (id !== "" && transitionIds(m, ref).includes(id)) return refuse(`another transition is named "${id}"`);
        if (t.id) renamed = [t.id, id];
        next.id = id;
      }
    }
    if (patch.to !== undefined) {
      if (!stateOf(m, patch.to)) return refuse(`there's no state named "${patch.to}"`);
      next.to = patch.to;
    }
    if (patch.when !== undefined) {
      const w = patch.when;
      if (typeof w === "number" ? !(Number.isFinite(w) && w >= 0) : !(w === "now" || w === "exit" || (w.startsWith("marker:") && w.length > 7))) {
        return refuse(typeof w === "number" ? "a normalised time is 0 or more" : "a marker needs a name");
      }
      next.when = w;
    }
    if (patch.how !== undefined) {
      if (!TRANSITION_HOWS.includes(patch.how)) return refuse(`a transition blends by ${TRANSITION_HOWS.join(", ")}`);
      next.how = patch.how;
    }
    if (patch.bridge !== undefined) next.bridge = patch.bridge;
    if (next.how === "bridge") {
      if (!next.bridge) return refuse("a bridge transition needs its bridge node: pick one first");
      if (!nodeById(graph, next.bridge)) return refuse("that node isn't in the graph");
      if (next.bridge === machine || reaches(graph, next.bridge, machine)) return refuse("that would make a cycle");
    } else next.bridge = null;
    if (patch.duration !== undefined) {
      if (!Number.isFinite(patch.duration) || patch.duration < 0) return refuse("a duration is 0 seconds or more");
      if (next.how === "cut" && patch.duration !== 0) return refuse("a cut has no duration");
      next.duration = patch.duration;
    }
    if (next.how === "cut") next.duration = 0;
    else if (t.how === "cut" && patch.duration === undefined) next.duration = DEFAULT_TRANSITION_DURATION;
    if (patch.shape !== undefined) {
      if (!FADE_SHAPES.includes(patch.shape)) return refuse(`a fade shape is ${FADE_SHAPES.join(", ")}`);
      next.shape = patch.shape;
    }
    if (patch.interrupt !== undefined) {
      const ir = patch.interrupt;
      if (typeof ir !== "string") {
        const ids = transitionIds(m, ref);
        const bad = ir.find((x) => !ids.includes(x));
        if (bad !== undefined) return refuse(bad === t.id ? "a transition can't interrupt itself" : `"${bad}" isn't another transition of this machine`);
        if (ir.length > GRAPH_LIMITS.interrupters) return refuse(`at most ${GRAPH_LIMITS.interrupters} transitions may interrupt one`);
        next.interrupt = ir.length ? [...new Set(ir)] : "never";
      } else next.interrupt = ir;
    }
    return accept(JSON.stringify(next) === JSON.stringify(t) ? t : next);
  });
  const ids = renamed as [string, string] | null; // set inside the closure
  if ("refused" in r || !ids) return r;
  const [from, to] = ids;
  // An id renamed (or cleared) follows into the interrupt lists that named it.
  return withMachine(r.next, machine, (m) => accept(mapTransitions(m, (t) => {
    if (typeof t.interrupt === "string" || !t.interrupt.includes(from)) return t;
    const list = to ? t.interrupt.map((x) => (x === from ? to : x)) : t.interrupt.filter((x) => x !== from);
    return { ...t, interrupt: list.length ? list : "never" };
  })));
}

// --- fade shapes ----------------------------------------------------------------------------------------------------

/** Labels of the fade shapes (D53's ids 0–3). */
export const FADE_SHAPE_LABELS: Readonly<Record<FadeShape, string>> = { linear: "Linear", smoothstep: "Smoothstep", easeIn: "Ease in", easeOut: "Ease out" };

/**
 * The incoming state's weight across a transition of `shape`, at `samples + 1` evenly spaced points (0..1): the core's
 * curve, read through audio's fade shape with the same curve (`AUDIO_FADE_SHAPE`, `shapeLevel`). The outgoing weight is
 * 1 minus it.
 */
export function fadePreview(shape: FadeShape, samples = 24): number[] {
  const audio = AUDIO_FADE_SHAPE[shape];
  return Array.from({ length: samples + 1 }, (_, i) => shapeLevel(audio, i / samples));
}

// --- Add as state (a clip dropped on an Animator with a graph) ------------------------------------------------------

/** What "Add as state" made. */
export interface ClipState extends Added {
  readonly machine: string;
  readonly state: string;
}

/** The machine a dropped clip goes in: the output's, else the first machine. */
export function targetMachine(graph: AnimGraph): string | null {
  const out = graph.output ? nodeById(graph, graph.output) : undefined;
  if (out?.machine) return out.id;
  return graph.nodes.find((n) => n.machine)?.id ?? null;
}

/**
 * The clip `clip` (an `asset:` reference) added as a state named `name` playing it through a new clip player, in the
 * output's state machine (else the first one). A graph with no machine gets one when it has no output yet (it becomes
 * the output); a graph whose output is something else is refused (the state would never play).
 */
export function addClipAsState(graph: AnimGraph, clip: string, name: string): EditResult<ClipState> {
  let g = graph;
  let machine = targetMachine(g);
  if (!machine) {
    if (g.output) return refuse("the graph has no state machine to add a state to; add one in the Animation Graph editor");
    const made = addNode(g, "logic", "stateMachine", [0, 0]);
    if ("refused" in made) return made;
    g = made.next.graph;
    machine = made.next.id;
  }
  const m = nodeById(g, machine)!.machine!;
  const base = nodeById(g, machine)!.position ?? [0, 0];
  const index = m.states.length;
  const player = addNode(g, "sources", "clipPlayer", [base[0] - 260, base[1] + 120 * index], { clip });
  if ("refused" in player) return player;
  const stateName = name.replace(/^@+/, "").trim() || "State";
  const state = addState(player.next.graph, machine, [60 + 200 * (index % 4), 60 + 100 * Math.floor(index / 4)], stateName, player.next.id);
  if ("refused" in state) return state;
  // The new clip player never takes over the output: the machine is it (or what it was).
  const output = g.output === player.next.id || g.output === null ? machine : g.output;
  return accept({ graph: { ...state.next.graph, output }, id: player.next.id, machine, state: state.next.state });
}
