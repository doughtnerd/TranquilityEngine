// Graph-asset Animators at run time (ADR 0372; T32): their core instances, what the API queues for them, and what the
// core's graph state-change records tell them back.
//
// - **Instances.** An Animator with a `graph` gets a graph instance instead of the implicit graph's (`../instances.ts`
//   calls `createGraphInstance` through its `graphInstanceHooks`): the graph is compiled for the Skeleton's bones (or
//   for none: a zero-bone instance, D109) and loaded with its assets bound (`asset.ts`), the instance is created, the
//   Animator's `parameters` overrides and `linkedGraphs` choices are queued, and the instance is flagged for the debug
//   report `state()` reads. Losing the instance (deactivation, a Skeleton change) ends its slot plays `stopped`, its
//   travels `interrupted`, and drops its graph reference.
// - **Calls before the instance exists** (a `start()` setting parameters while the graph still loads) wait: parameter
//   values by name, commands in call order. Each gather turns them into blackboard writes (parameters 0–63, through
//   the blackboard view; later ones with `SET_PARAM`) and `graph` family commands, in call order; a slot play whose
//   clip, or a link whose graph, is still loading holds back what was queued after it (as `../playback/plays.ts` does).
// - **Apply** reads the graph state-change records: states entered (the `AnimatorStateChanges` buffer, travels that
//   arrived), slot plays finished, interrupted or stopped (their promises), and the core's refusals of graph commands
//   (`CHANGE_REFUSED` with the index the command named: an unreachable travel, a refused slot play or link).
import type { Animator } from "../../components/Animator";
import { AnimatorStateChanges } from "../../buffers";
import type { AnimationWorldCore } from "../../core/AnimationWorldCore";
import type { RecordFields } from "../../core/records";
import type { AnimationFrame } from "../../stages/frame";
import type { AnimationPlayEndReason, AnimationPlayResult, AnimatorLayer, AnimatorParameterValue, AnimatorStateInfo, AnimatorTravelResult } from "../../types";
import { CHANGE_REFUSED, HANDLE_INDEX_MASK, MAX_LAYERS, STATE_CHANGE, STATUS_TOO_LARGE } from "../../wasm/wire/core";
import {
  BLACKBOARD_DIRTY,
  BLACKBOARD_PARAMS,
  BLACKBOARD_STRIDE,
  BLACKBOARD_VALUES,
  DEBUG,
  DEBUG_ON,
  GRAPH_CHANGE,
  GRAPH_SLOT_FINISHED,
  GRAPH_SLOT_INTERRUPTED,
  GRAPH_STATE_ENTERED,
  JUMP,
  LINK,
  REASON_STOPPED,
  REQUEST,
  SECTION_LOOP,
  SET_PARAM,
  SLOT_PLAY,
  SLOT_STOP,
  STATUS_UNREACHABLE,
  TRAVEL,
} from "../../wasm/wire/graph";
import { animatorRuntime, animatorsOf, clipEntry, skeletonProfileOf, type AnimatorRuntime, type ClipEntry, type SkeletonRuntime } from "../instances";
import { readDebugReport, reportMachine, reportNode, type DebugReport } from "../debug/report";
import { acquireGraph, releaseGraph, type GraphMeta, type LoadedGraph } from "./asset";
import { readClipCues, sectionRange } from "./clipCues";
import { decodeParameter, encodeParameter, PARAM_TYPE_IDS } from "./parameters";
import { normalizeAssetPath } from "../../../../../engine/scene/assetPath";

const NONE = 0xffffffff;

const warned = new Set<string>();
/** @internal Logs `message` once per `key`. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

// ------------------------------------------------------------------------------------------------ state

/** @internal A section to play: a cue name of the clip, or clip seconds. */
export type SlotSection = string | { readonly start: number; readonly end?: number } | undefined;

/** @internal A slot play (a one-shot over the graph). */
export interface SlotPlayRecord {
  id: number;
  readonly slot: string;
  readonly clip: ClipEntry;
  readonly name: string;
  readonly fade: number;
  readonly speed: number;
  readonly loop: boolean;
  readonly section: SlotSection;
  readonly normalizedTime: number;
  /** The network tick it was asked for on (`slotNetHooks.admit`; -1 outside networked Worlds, T33). */
  readonly tick: number;
  /** Clip seconds it starts late by (a replicated or re-simulated play joining after its start tick, T33); not for loops. */
  readonly offset: number;
  readonly promise: Promise<AnimationPlayResult>;
  readonly resolve: (r: AnimationPlayResult) => void;
  done: boolean;
}

/** @internal How the network feature admits a slot play (T33): its tick and late start, or an existing play's promise (a repeat). */
export type SlotPlayAdmission = { readonly tick: number; readonly offset: number } | Promise<AnimationPlayResult>;

/**
 * @internal What the network feature hears from graph Animators (ADR 0370 "Networking"; T33 fills these from
 * `network/register.ts`): slot plays are stamped with the tick they're asked for on (and a re-simulated tick's repeat
 * of a play answered with the first one's promise), told when the core starts one, and slot stops and links are
 * reported as they're sent to the core.
 */
export const slotNetHooks: {
  admit?(animator: Animator, slot: string, clip: string, explicit: { readonly tick: number; readonly offset: number } | undefined, speed: number): SlotPlayAdmission;
  queued?(animator: Animator, play: SlotPlayRecord): void;
  started?(animator: Animator, play: SlotPlayRecord): void;
  stopped?(animator: Animator, slot: string | null, fade: number): void;
  linked?(animator: Animator, node: string, path: string | null): void;
} = {};

/** @internal A travel waiting to arrive. */
interface TravelWait {
  readonly promise: Promise<AnimatorTravelResult>;
  readonly resolve: (r: AnimatorTravelResult) => void;
  machine: number;
  state: number;
  done: boolean;
}

type Intent =
  | { readonly kind: "request"; readonly name: string; readonly within: number }
  | { readonly kind: "travel"; readonly state: string; readonly layer: AnimatorLayer | undefined; readonly wait: TravelWait }
  | { readonly kind: "jump"; readonly state: string; readonly layer: AnimatorLayer | undefined; readonly normalizedTime: number; readonly time: number }
  | { readonly kind: "slot"; readonly play: SlotPlayRecord }
  | { readonly kind: "stop"; readonly slot: string | null; readonly fade: number }
  | { readonly kind: "link"; readonly node: string; readonly path: string | null; loaded?: LoadedGraph | null; loading?: boolean; dropped?: boolean }
  | { readonly kind: "weight"; readonly layer: AnimatorLayer; readonly weight: number };

interface MachineClock {
  current: number;
  previous: number;
  /** Seconds in the current state (host clock), and in the previous one when it was left. */
  time: number;
  previousTime: number;
}

/** @internal A graph instance's host state. */
interface GraphRuntime {
  readonly rt: AnimatorRuntime;
  readonly ns: AnimationWorldCore;
  readonly graph: LoadedGraph;
  readonly instance: number;
  /** Parameter words waiting for the blackboard (4 per parameter) and which are dirty. */
  readonly values: Uint32Array;
  readonly dirty: Uint8Array;
  /** Parameters the host has written at least once (the others hold the graph's defaults in the core). */
  readonly written: Uint8Array;
  anyDirty: boolean;
  debugSent: boolean;
  readonly machines: MachineClock[];
  /** Machines (re)started at their entry state whose first entry `AnimatorStateChanges` hasn't had yet. */
  started: number[];
  readonly plays: Map<number, SlotPlayRecord>;
  readonly travels: TravelWait[];
  /** Graphs linked at run time, by linked-graph slot. */
  readonly links: Map<number, LoadedGraph>;
  /** This frame's debug report, once read. */
  debug: DebugReport | null;
}

/** Per Animator, across its instances: what waits for an instance, computed parameters, the latest slot play. */
interface AnimatorGraph {
  readonly named: Map<string, AnimatorParameterValue | readonly number[]>;
  readonly queue: Intent[];
  readonly computes: Map<string, () => AnimatorParameterValue>;
  readonly computeErrors: Set<string>;
  latest: SlotPlayRecord | null;
  runtime: GraphRuntime | null;
}

const animatorGraphs = new WeakMap<Animator, AnimatorGraph>();
/** Graph runtimes by core instance handle, per World core. */
const byInstance = new WeakMap<AnimationWorldCore, Map<number, GraphRuntime>>();

/** @internal An Animator's graph state (made on first use). */
export function animatorGraph(animator: Animator): AnimatorGraph {
  let g = animatorGraphs.get(animator);
  if (!g) animatorGraphs.set(animator, (g = { named: new Map(), queue: [], computes: new Map(), computeErrors: new Set(), latest: null, runtime: null }));
  return g;
}

/** @internal The graph tables of an Animator's live graph instance, or null (no graph, or still loading). */
export function graphMeta(animator: Animator): GraphMeta | null {
  return animatorGraphs.get(animator)?.runtime?.graph.meta ?? null;
}

const STOPPED: AnimationPlayResult = Object.freeze({ reason: "stopped" });
let nextSlotPlayId = 1;

// ------------------------------------------------------------------------------------------------ instances

/**
 * @internal `graphInstanceHooks.create`: compiles and loads `rt`'s graph for `skeleton` (null: none), then, while
 * `current()` holds, creates its instance. Returns the instance, or 0.
 */
export async function createGraphInstance(rt: AnimatorRuntime, ns: AnimationWorldCore, skeleton: SkeletonRuntime | null, current: () => boolean): Promise<number> {
  const a = rt.animator;
  const retargetSource = (skeleton?.component as { retargetSource?: unknown } | undefined)?.retargetSource;
  const rig = skeleton?.info
    ? { path: skeleton.path, info: skeleton.info, profile: skeletonProfileOf(skeleton), retargetSource: typeof retargetSource === "string" ? retargetSource : "" }
    : null;
  const graph = await acquireGraph(ns, a.graph, rig);
  if (!graph) return 0;
  // Another activation of the same Animator (a Skeleton finishing its load) may have made the instance meanwhile.
  if (!current() || !ns.open || animatorGraph(a).runtime) {
    releaseGraph(ns, graph);
    return 0;
  }
  const instance = ns.createInstance(skeleton?.handle ?? 0, graph.handle);
  if (!instance) {
    console.warn(`[myco] ${a.node.name}: Animator couldn't get a graph instance (status ${ns.core.lastStatus()}).`);
    releaseGraph(ns, graph);
    return 0;
  }
  const meta = graph.meta;
  const n = meta.paramTypes.length;
  const g: GraphRuntime = {
    rt,
    ns,
    graph,
    instance,
    values: new Uint32Array(n * 4),
    dirty: new Uint8Array(n),
    written: new Uint8Array(n),
    anyDirty: false,
    debugSent: false,
    // Top machines start in their entry state at creation (the core doesn't report it; `apply` does, once).
    machines: meta.machines.map((m) => ({ current: m.parent ? -1 : m.entry, previous: -1, time: 0, previousTime: 0 })),
    started: meta.machines.flatMap((m, i) => (m.parent ? [] : [i])),
    plays: new Map(),
    travels: [],
    links: new Map(),
    debug: null,
  };
  let map = byInstance.get(ns);
  if (!map) byInstance.set(ns, (map = new Map()));
  map.set(instance, g);
  const ag = animatorGraph(a);
  ag.runtime = g;
  // The Animator's own starting values, then what code set while the graph loaded.
  for (const [name, value] of Object.entries(a.parameters ?? {})) writeParameter(g, name, value, `parameters.${name}`);
  for (const [name, value] of ag.named) writeParameter(g, name, value, name);
  ag.named.clear();
  // Linked-graph choices made in the Inspector go first, before anything code queued.
  const links: Intent[] = [];
  a.linkedGraphNodes.forEach((node, i) => {
    const path = a.linkedGraphs[i];
    if (node && path) links.push({ kind: "link", node, path });
  });
  ag.queue.unshift(...links);
  // Layer weights start at the graph's defaults (the input view's 4 weights).
  for (let l = 0; l < MAX_LAYERS; l++) if (Number.isNaN(rt.layerWeights[l]!) && l < meta.layerWeights.length) rt.layerWeights[l] = meta.layerWeights[l]!;
  return instance;
}

function endPlay(p: SlotPlayRecord, reason: AnimationPlayEndReason): void {
  if (p.done) return;
  p.done = true;
  p.resolve(reason === "stopped" ? STOPPED : { reason });
}

function endTravel(w: TravelWait, reason: AnimatorTravelResult["reason"]): void {
  if (w.done) return;
  w.done = true;
  w.resolve({ reason });
}

/** @internal `clipUsers`: the clips `rt`'s slot plays still use (queued or playing). */
export function* graphClipsInUse(rt: AnimatorRuntime): Iterable<ClipEntry> {
  const ag = animatorGraphs.get(rt.animator);
  if (!ag) return;
  for (const i of ag.queue) if (i.kind === "slot" && !i.play.done) yield i.play.clip;
  for (const p of ag.runtime?.plays.values() ?? []) if (!p.done) yield p.clip;
}

/** @internal `graphInstanceHooks.unbound`: the Animator's `instance` is going; its plays end, its graph is released. */
export function graphInstanceUnbound(rt: AnimatorRuntime, instance: number): void {
  const ag = animatorGraphs.get(rt.animator);
  // A stale instance (one given back before adoption) leaves the live one alone; 0: none was made yet.
  if (!ag || (instance !== 0 && ag.runtime?.instance !== instance)) return;
  for (const i of ag.queue.splice(0)) {
    if (i.kind === "slot") endPlay(i.play, "stopped");
    else if (i.kind === "travel") endTravel(i.wait, "interrupted");
    else if (i.kind === "link") {
      i.dropped = true;
      if (i.loaded && rt.ns) releaseGraph(rt.ns, i.loaded);
    }
  }
  const g = ag.runtime;
  if (!g) return;
  ag.runtime = null;
  byInstance.get(g.ns)?.delete(g.instance);
  for (const p of g.plays.values()) endPlay(p, "stopped");
  g.plays.clear();
  for (const w of g.travels) endTravel(w, "interrupted");
  g.travels.length = 0;
  for (const l of g.links.values()) releaseGraph(g.ns, l);
  g.links.clear();
  releaseGraph(g.ns, g.graph);
}

// ------------------------------------------------------------------------------------------------ parameters

function writeParameter(g: GraphRuntime, name: string | number, value: AnimatorParameterValue | readonly number[], label: string): boolean {
  const meta = g.graph.meta;
  const index = typeof name === "number" ? (Number.isInteger(name) && name >= 0 && name < meta.paramTypes.length ? name : -1) : (meta.params.get(name) ?? -1);
  const who = g.rt.animator.node.name;
  if (index < 0) {
    warnOnce(`param:${g.graph.path}:${label}`, `[myco] ${who}: the graph "${g.graph.path}" has no parameter ${JSON.stringify(label)}; set ignored.`);
    return false;
  }
  const type = meta.paramTypes[index]!;
  if (!encodeParameter(type, value, g.values, index * 4)) {
    warnOnce(`ptype:${g.graph.path}:${index}`, `[myco] ${who}: parameter "${meta.compiled.parameters[index]}" of "${g.graph.path}" is a ${type}; ${describe(value)} doesn't fit, ignored.`);
    return false;
  }
  g.dirty[index] = 1;
  g.written[index] = 1;
  g.anyDirty = true;
  return true;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === "object") return `a ${(v as object).constructor?.name ?? "object"}`;
  return `${typeof v} ${String(v)}`;
}

/** @internal `Animator.set` and `AnimatorParams.set`: a typed write, landing at the next gather. */
export function setParameter(animator: Animator, name: string | number, value: AnimatorParameterValue): void {
  if (!animator.graph) {
    warnOnce(`nograph:${animator.node.name}`, `[myco] ${animator.node.name}: Animator has no graph, so it has no parameters; set ignored.`);
    return;
  }
  const ag = animatorGraph(animator);
  if (ag.runtime) writeParameter(ag.runtime, name, value, String(name));
  else if (typeof name === "string") ag.named.set(name, value);
  else warnOnce(`early:${animator.node.name}`, `[myco] ${animator.node.name}: Animator's graph hasn't loaded yet, so parameters can't be set by index; set by name instead.`);
}

/** @internal `AnimatorParams.indexOf`. */
export function parameterIndex(animator: Animator, name: string): number {
  return graphMeta(animator)?.params.get(name) ?? -1;
}

/**
 * @internal The values the host has written to `animator`'s parameters that `include` accepts (by index), as plain
 * values (`decodeParameter`; `node` parameters are left out). Parameters never written hold the graph's defaults and
 * are left out too. Empty while the graph loads.
 */
export function writtenParameters(animator: Animator, include: (index: number) => boolean): [number, number | boolean | number[]][] {
  const g = animatorGraphs.get(animator)?.runtime;
  if (!g) return [];
  const out: [number, number | boolean | number[]][] = [];
  const types = g.graph.meta.paramTypes;
  for (let i = 0; i < types.length; i++) {
    if (!g.written[i] || !include(i)) continue;
    const v = decodeParameter(types[i]!, g.values, i * 4);
    if (v !== null) out.push([i, v]);
  }
  return out;
}

/** Copies dirty parameters into the instance's blackboard row (0–63) or `SET_PARAM` commands (64 and up). */
function flushParameters(frame: AnimationFrame, g: GraphRuntime): void {
  if (!g.anyDirty) return;
  g.anyDirty = false;
  const bb = frame.core.core.views().blackboard;
  const row = (g.instance & HANDLE_INDEX_MASK) * BLACKBOARD_STRIDE;
  let lo = bb.getUint32(row + BLACKBOARD_DIRTY, true), hi = bb.getUint32(row + BLACKBOARD_DIRTY + 4, true);
  const types = g.graph.meta.paramTypes;
  for (let i = 0; i < g.dirty.length; i++) {
    if (!g.dirty[i]) continue;
    g.dirty[i] = 0;
    const w = i * 4;
    if (i < BLACKBOARD_PARAMS) {
      const at = row + BLACKBOARD_VALUES + 16 * i;
      for (let k = 0; k < 4; k++) bb.setUint32(at + 4 * k, g.values[w + k]!, true);
      if (i < 32) lo |= 1 << i;
      else hi |= 1 << (i - 32);
    } else {
      frame.core.commands.put(SET_PARAM, { instance: g.instance, param: i, paramType: PARAM_TYPE_IDS[types[i]!], w0: g.values[w]!, w1: g.values[w + 1]!, w2: g.values[w + 2]!, w3: g.values[w + 3]! });
    }
  }
  bb.setUint32(row + BLACKBOARD_DIRTY, lo >>> 0, true);
  bb.setUint32(row + BLACKBOARD_DIRTY + 4, hi >>> 0, true);
}

// ------------------------------------------------------------------------------------------------ API intents

/** @internal Queues `intent` for `animator`'s next gather (refused with a warning without a graph). */
function queue(animator: Animator, intent: Intent, what: string): boolean {
  if (!animator.graph) {
    warnOnce(`nograph-${what}:${animator.node.name}`, `[myco] ${animator.node.name}: Animator has no graph; ${what} needs one and was ignored.`);
    return false;
  }
  if (!animatorRuntime(animator)) return false;
  animatorGraph(animator).queue.push(intent);
  return true;
}

/** @internal `Animator.request`. */
export function queueRequest(animator: Animator, name: string, within: number): void {
  queue(animator, { kind: "request", name, within }, "request()");
}

/** @internal `Animator.travel`: resolves when the machine enters `state`, or at once when it can't. */
export function queueTravel(animator: Animator, state: string, layer: AnimatorLayer | undefined): Promise<AnimatorTravelResult> {
  let resolve!: (r: AnimatorTravelResult) => void;
  const promise = new Promise<AnimatorTravelResult>((r) => (resolve = r));
  const wait: TravelWait = { promise, resolve, machine: -1, state: -1, done: false };
  if (!queue(animator, { kind: "travel", state, layer, wait }, "travel()")) endTravel(wait, "unreachable");
  return promise;
}

/**
 * @internal `Animator.jump`: the state is entered `normalizedTime` cycles of its clips plus `time` seconds in (T70: the
 * core's `JUMP` offsets; the network client passes the server's seconds since the state's entry tick).
 */
export function queueJump(animator: Animator, state: string, layer: AnimatorLayer | undefined, normalizedTime = 0, time = 0): void {
  const clean = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  queue(animator, { kind: "jump", state, layer, normalizedTime: clean(normalizedTime), time: clean(time) }, "jump()");
}

/** @internal `Animator.link`. */
export function queueLink(animator: Animator, node: string, path: string | null): void {
  const p = path ? normalizeAssetPath(path) : null;
  queue(animator, { kind: "link", node, path: p }, "link()");
}

/** @internal `Animator.layerWeight` on a graph Animator. */
export function queueLayerWeight(animator: Animator, layer: AnimatorLayer, weight: number): void {
  queue(animator, { kind: "weight", layer, weight }, "layerWeight()");
}

/**
 * @internal `Animator.play` with a slot. `net` (the network feature's replicated plays, T33) gives the play's tick and
 * late start instead of asking `slotNetHooks.admit`. `options.startIn`: clip seconds it starts late by on top of that
 * (a musical play released after its boundary, T72); not for loops.
 */
export function queueSlotPlay(
  animator: Animator,
  clip: string,
  options: { slot: string; fade: number; speed: number; loop: boolean; section: SlotSection; normalizedTime: number; startIn?: number },
  net?: { readonly tick: number; readonly offset: number },
): Promise<AnimationPlayResult> {
  const rt = animatorRuntime(animator);
  if (!rt || !clip) return Promise.resolve(STOPPED);
  const path = normalizeAssetPath(clip);
  let admission: SlotPlayAdmission = net ?? { tick: -1, offset: 0 };
  if (animator.graph && slotNetHooks.admit) admission = slotNetHooks.admit(animator, options.slot, path, net, options.speed);
  if (admission instanceof Promise) return admission; // a re-simulated tick asking again for a play it already made
  let resolve!: (r: AnimationPlayResult) => void;
  const promise = new Promise<AnimationPlayResult>((r) => (resolve = r));
  const play: SlotPlayRecord = {
    id: 0,
    slot: options.slot,
    clip: clipEntry(rt, path),
    name: clip,
    fade: options.fade,
    speed: options.speed,
    loop: options.loop,
    section: options.section,
    normalizedTime: options.normalizedTime,
    tick: admission.tick,
    offset: options.loop ? 0 : Math.max(0, admission.offset) + (options.startIn !== undefined && Number.isFinite(options.startIn) ? Math.max(0, options.startIn) : 0),
    promise,
    resolve,
    done: false,
  };
  if (!queue(animator, { kind: "slot", play }, "play() with a slot")) {
    endPlay(play, "stopped");
    return promise;
  }
  animatorGraph(animator).latest = play;
  slotNetHooks.queued?.(animator, play);
  return promise;
}

/** @internal `Animator.stop` on a graph Animator: one slot, or every slot. */
export function queueSlotStop(animator: Animator, slot: string | null, fade: number): void {
  queue(animator, { kind: "stop", slot, fade }, "stop()");
}

/** @internal The latest slot play's promise, or null. */
export function latestSlotPlay(animator: Animator): Promise<AnimationPlayResult> | null {
  return animatorGraphs.get(animator)?.latest?.promise ?? null;
}

/** @internal `Animator.compute`. */
export function setCompute(animator: Animator, name: string, fn: (() => AnimatorParameterValue) | null): void {
  const ag = animatorGraph(animator);
  if (fn) ag.computes.set(name, fn);
  else ag.computes.delete(name);
}

// ------------------------------------------------------------------------------------------------ names

/** @internal The machine `layer` names (default and 0: "Base"; a layer's name, n ≥ 1 its index + 1, or a machine node's id), or -1. */
export function machineFor(meta: GraphMeta, layer: AnimatorLayer | undefined): number {
  let key: string | undefined;
  if (layer === undefined || layer === 0 || layer === "Base") key = "Base";
  else if (typeof layer === "number") key = meta.compiled.layers[layer - 1];
  else key = layer;
  return key === undefined ? -1 : (meta.layerMachines.get(key) ?? -1);
}

/** @internal The input view's weight index of `layer` (a layer's name, or n ≥ 1 for layer n − 1), or -1. */
export function layerWeightIndex(meta: GraphMeta, layer: AnimatorLayer): number {
  const i = typeof layer === "number" ? layer - 1 : meta.compiled.layers.indexOf(layer);
  return Number.isInteger(i) && i >= 0 && i < meta.compiled.layers.length ? i : -1;
}

// ------------------------------------------------------------------------------------------------ gather

function machineAndState(g: GraphRuntime, layer: AnimatorLayer | undefined, state: string, what: string): [number, number] | null {
  const meta = g.graph.meta;
  const who = g.rt.animator.node.name;
  const m = machineFor(meta, layer);
  if (m < 0) {
    warnOnce(`layer:${g.graph.path}:${String(layer)}`, `[myco] ${who}: the graph "${g.graph.path}" has no state machine in layer ${JSON.stringify(layer ?? "Base")}; ${what} ignored.`);
    return null;
  }
  const s = meta.machines[m]!.states.indexOf(state);
  if (s < 0) {
    warnOnce(`state:${g.graph.path}:${m}:${state}`, `[myco] ${who}: the state machine "${meta.machines[m]!.node}" has no state "${state}"; ${what} ignored.`);
    return null;
  }
  return [m, s];
}

function slotIndex(g: GraphRuntime, slot: string): number {
  const i = g.graph.meta.compiled.slots.indexOf(slot);
  if (i < 0) warnOnce(`slot:${g.graph.path}:${slot}`, `[myco] ${g.rt.animator.node.name}: the graph "${g.graph.path}" has no slot "${slot}"; the play was refused.`);
  return i;
}

function linkedIndex(meta: GraphMeta, node: string): number {
  return meta.compiled.linked.indexOf(node);
}

/**
 * Section `[start, end)` in clip seconds for a slot play, its start moved on by the play's late start (`offset`, T33);
 * null (with a warning) when the cue isn't in the clip.
 */
function sectionOf(g: GraphRuntime, p: SlotPlayRecord): { start: number; end: number } | null {
  const range = sectionRangeOf(g, p);
  if (!range || !p.offset) return range;
  const last = range.end > range.start ? range.end : (p.clip.info?.duration ?? range.start);
  return { start: Math.min(last, range.start + p.offset), end: range.end };
}

/**
 * @internal A slot play's section `[start, end)` in clip seconds, before any late start (end 0: the clip's end):
 * undefined while its clip or the graph loads, null when it can't play (no clip, no such cue).
 */
export function slotPlaySection(animator: Animator, p: SlotPlayRecord): { start: number; end: number } | null | undefined {
  const g = animatorGraphs.get(animator)?.runtime;
  if (!g || p.clip.handle === undefined) return undefined;
  return p.clip.handle ? sectionRangeOf(g, p) : null;
}

function sectionRangeOf(g: GraphRuntime, p: SlotPlayRecord): { start: number; end: number } | null {
  const duration = p.clip.info?.duration ?? 0;
  if (p.section === undefined) return { start: Math.min(1, Math.max(0, p.normalizedTime)) * duration, end: 0 };
  if (typeof p.section === "object") {
    const start = Number.isFinite(p.section.start) ? Math.max(0, p.section.start) : 0;
    const end = p.section.end !== undefined && Number.isFinite(p.section.end) && p.section.end > start ? p.section.end : 0;
    return { start, end };
  }
  const bytes = g.ns.core.assetBytes(p.clip.handle!);
  const range = bytes ? sectionRange(readClipCues(bytes), p.section) : null;
  if (!range) warnOnce(`section:${p.clip.path}:${p.section}`, `[myco] ${g.rt.animator.node.name}: the clip "${p.clip.path}" has no section (cue) "${p.section}"; the play was refused.`);
  return range;
}

/** Turns one intent into commands; false when it must wait (later intents wait behind it). */
function flushIntent(frame: AnimationFrame, g: GraphRuntime, intent: Intent): boolean {
  const meta = g.graph.meta;
  const cmds = frame.core.commands;
  const instance = g.instance;
  const who = g.rt.animator.node.name;
  switch (intent.kind) {
    case "request": {
      const id = meta.requests.get(intent.name);
      if (id === undefined) warnOnce(`req:${g.graph.path}:${intent.name}`, `[myco] ${who}: no transition of "${g.graph.path}" reads the request "${intent.name}"; ignored.`);
      else cmds.put(REQUEST, { instance, name: id, lifetime: intent.within });
      return true;
    }
    case "travel":
    case "jump": {
      const ms = machineAndState(g, intent.layer, intent.state, intent.kind === "travel" ? "travel()" : "jump()");
      if (!ms) {
        if (intent.kind === "travel") endTravel(intent.wait, "unreachable");
        return true;
      }
      const [m, s] = ms;
      // A later travel or jump on the machine replaces a travel still on its way.
      for (const w of g.travels) if (w.machine === m) endTravel(w, "interrupted");
      if (intent.kind === "jump") {
        cmds.put(JUMP, { instance, machine: m, state: s, normalizedTime: intent.normalizedTime, time: intent.time });
        return true;
      }
      if (g.machines[m]!.current === s) {
        endTravel(intent.wait, "arrived");
        return true;
      }
      intent.wait.machine = m;
      intent.wait.state = s;
      g.travels.push(intent.wait);
      cmds.put(TRAVEL, { instance, machine: m, state: s });
      return true;
    }
    case "slot": {
      const p = intent.play;
      if (p.done) return true;
      if (p.clip.handle === undefined) return false; // still loading
      const slot = slotIndex(g, p.slot);
      if (slot < 0 || !p.clip.handle) {
        endPlay(p, "stopped");
        return true;
      }
      const section = sectionOf(g, p);
      if (!section) {
        endPlay(p, "stopped");
        return true;
      }
      p.id = nextSlotPlayId;
      nextSlotPlayId = nextSlotPlayId >= 0xffffffff ? 1 : nextSlotPlayId + 1;
      g.plays.set(p.id, p);
      cmds.put(SLOT_PLAY, { instance, slot, clip: p.clip.handle, playId: p.id, blendIn: p.fade, blendOut: p.fade, speed: p.speed, start: section.start, end: section.end, flags: p.loop ? SECTION_LOOP : 0 });
      slotNetHooks.started?.(g.rt.animator, p);
      return true;
    }
    case "stop": {
      if (intent.slot === null) {
        meta.compiled.slots.forEach((_, slot) => cmds.put(SLOT_STOP, { instance, slot, playId: 0, fade: intent.fade }));
        slotNetHooks.stopped?.(g.rt.animator, null, intent.fade);
        return true;
      }
      const slot = meta.compiled.slots.indexOf(intent.slot);
      if (slot < 0) warnOnce(`slot:${g.graph.path}:${intent.slot}`, `[myco] ${who}: the graph "${g.graph.path}" has no slot "${intent.slot}"; stop ignored.`);
      else {
        cmds.put(SLOT_STOP, { instance, slot, playId: 0, fade: intent.fade });
        slotNetHooks.stopped?.(g.rt.animator, intent.slot, intent.fade);
      }
      return true;
    }
    case "link": {
      const index = linkedIndex(meta, intent.node);
      if (index < 0) {
        warnOnce(`linked:${g.graph.path}:${intent.node}`, `[myco] ${who}: the graph "${g.graph.path}" has no linked graph "${intent.node}"; link ignored.`);
        return true;
      }
      let handle = 0;
      if (intent.path === null) {
        const def = meta.linkedDefaults[index]!;
        handle = def ? (g.graph.graphHandles.get(def) ?? 0) : 0;
      } else {
        if (intent.loaded === undefined) {
          if (!intent.loading) {
            intent.loading = true;
            const rig = g.rt.skeleton?.info ? { path: g.rt.skeleton.path, info: g.rt.skeleton.info, profile: skeletonProfileOf(g.rt.skeleton) } : null;
            const ns = g.ns;
            void acquireGraph(ns, intent.path, rig).then((l) => {
              if (intent.dropped) {
                if (l) releaseGraph(ns, l); // the instance went while it loaded
              } else intent.loaded = l;
            });
          }
          return false;
        }
        if (!intent.loaded) return true; // couldn't load (warned)
        handle = intent.loaded.handle;
      }
      const old = g.links.get(index);
      if (intent.path !== null && intent.loaded) g.links.set(index, intent.loaded);
      else g.links.delete(index);
      if (old) releaseGraph(g.ns, old);
      cmds.put(LINK, { instance, linked: index, graph: handle });
      slotNetHooks.linked?.(g.rt.animator, intent.node, intent.path);
      return true;
    }
    case "weight": {
      const i = layerWeightIndex(meta, intent.layer);
      if (i < 0 || i >= MAX_LAYERS) {
        warnOnce(`lw:${g.graph.path}:${String(intent.layer)}`, `[myco] ${who}: the graph "${g.graph.path}" has no layer ${JSON.stringify(intent.layer)} with a run-time weight (the first ${MAX_LAYERS} named layers have one; "Base" has none); ignored.`);
        return true;
      }
      g.rt.layerWeights[i] = Math.min(1, Math.max(0, Number.isFinite(intent.weight) ? intent.weight : 0));
      return true;
    }
  }
}

function runComputes(ag: AnimatorGraph, g: GraphRuntime): void {
  for (const [name, fn] of ag.computes) {
    let value: AnimatorParameterValue;
    try {
      value = fn();
    } catch (err) {
      if (!ag.computeErrors.has(name)) {
        ag.computeErrors.add(name);
        console.error(`[myco] ${g.rt.animator.node.name}: the computed parameter "${name}" threw (logged once):`, err);
      }
      continue;
    }
    writeParameter(g, name, value, name);
  }
}

/** @internal Whether `rt` runs in `frame`'s pass with a live graph instance. */
function graphInPass(frame: AnimationFrame, rt: AnimatorRuntime): GraphRuntime | null {
  if (rt.instance === 0 || rt.ns !== frame.core || (rt.animator.updateMode === "fixed") !== frame.fixed) return null;
  const g = animatorGraphs.get(rt.animator)?.runtime ?? null;
  return g && g.instance === rt.instance ? g : null;
}

/** @internal `animation.Gather`'s graph step: computed parameters, parameter rows, then queued commands in call order. */
export function gatherGraphs(frame: AnimationFrame): void {
  for (const rt of animatorsOf(frame.world)) {
    const g = graphInPass(frame, rt);
    if (!g) continue;
    const ag = animatorGraph(rt.animator);
    runComputes(ag, g);
    flushParameters(frame, g);
    if (!g.debugSent) {
      g.debugSent = true;
      frame.core.commands.put(DEBUG, { instance: g.instance, flags: DEBUG_ON });
    }
    flushIntents(frame, g, ag);
  }
}

function flushIntents(frame: AnimationFrame, g: GraphRuntime, ag: AnimatorGraph): void {
  while (ag.queue.length) {
    if (!flushIntent(frame, g, ag.queue[0]!)) break;
    ag.queue.shift();
  }
}

/**
 * @internal Sends `rt`'s queued graph commands now, in call order, when it takes part in `frame`'s pass: for intents
 * queued after the graph step of `animation.Gather` (musical timing releasing a held play, travel or request, T72).
 */
export function flushGraphQueue(frame: AnimationFrame, rt: AnimatorRuntime): void {
  const g = graphInPass(frame, rt);
  if (g) flushIntents(frame, g, animatorGraph(rt.animator));
}

// ------------------------------------------------------------------------------------------------ apply

const change = {} as RecordFields<typeof GRAPH_CHANGE>;
const refused = {} as RecordFields<typeof STATE_CHANGE>;

/** @internal `animation.Apply`'s graph step: state changes into `AnimatorStateChanges`, play and travel promises, clocks. */
export function applyGraphs(frame: AnimationFrame): void {
  const core = frame.core.core;
  const map = byInstance.get(frame.core);
  if (map && map.size) {
    const n = core.graphChangeCount();
    for (let i = 0; i < n; i++) {
      core.graphChange(i, change);
      const g = map.get(change.instance);
      if (!g) continue;
      flushStarted(g);
      if (change.kind === GRAPH_STATE_ENTERED) entered(g, change.index, change.value);
      else if (change.kind === GRAPH_SLOT_FINISHED || change.kind === GRAPH_SLOT_INTERRUPTED) {
        const p = g.plays.get(change.value);
        if (!p) continue;
        g.plays.delete(change.value);
        endPlay(p, change.kind === GRAPH_SLOT_FINISHED ? "finished" : change.reason === REASON_STOPPED ? "stopped" : "interrupted");
      }
    }
    const r = core.stateChangeCount();
    for (let i = 0; i < r; i++) {
      core.stateChange(i, refused);
      if (refused.kind !== CHANGE_REFUSED) continue;
      const g = map.get(refused.instance);
      if (g) refusal(g, refused);
    }
  }
  for (const rt of animatorsOf(frame.world)) {
    const g = graphInPass(frame, rt);
    if (!g) continue;
    g.debug = null;
    flushStarted(g);
    const dt = rt.animator.updateMode === "unscaled" ? frame.unscaledDt : frame.dt;
    for (const m of g.machines) if (m.current >= 0) m.time += dt;
  }
}

/** The first entries of machines started at creation (before any later change of the frame). */
function flushStarted(g: GraphRuntime): void {
  if (!g.started.length) return;
  const started = g.started;
  g.started = [];
  for (const m of started) {
    const entry = g.graph.meta.machines[m]!.entry;
    pushChange(g, m, -1, entry);
    restartNested(g, m, entry);
  }
}

/** The `AnimatorStateChanges` record of machine `machine` entering `state` from `from` (-1: its first entry). */
function pushChange(g: GraphRuntime, machine: number, from: number, state: number): void {
  const meta = g.graph.meta.machines[machine]!;
  AnimatorStateChanges.push({ animator: g.rt.animator, layer: meta.layer ?? meta.node, from: from >= 0 ? (meta.states[from] ?? null) : null, to: meta.states[state] ?? "" });
}

/** Machines nested in `machine`'s `state` restart at their entry (re-initialised on entry, D50). */
function restartNested(g: GraphRuntime, machine: number, state: number): void {
  g.graph.meta.machines.forEach((m, i) => {
    if (m.parent?.machine !== machine || m.parent.state !== state) return;
    const clock = g.machines[i]!;
    clock.previous = -1;
    clock.current = m.entry;
    clock.time = 0;
    pushChange(g, i, -1, m.entry);
    restartNested(g, i, m.entry);
  });
}

function entered(g: GraphRuntime, machine: number, state: number): void {
  const clock = g.machines[machine];
  const meta = g.graph.meta.machines[machine];
  if (!clock || !meta) return;
  const from = clock.current;
  clock.previous = from;
  clock.previousTime = clock.time;
  clock.current = state;
  clock.time = 0;
  pushChange(g, machine, from, state);
  restartNested(g, machine, state);
  for (let i = g.travels.length - 1; i >= 0; i--) {
    const w = g.travels[i]!;
    if (w.done) g.travels.splice(i, 1);
    else if (w.machine === machine && w.state === state) {
      endTravel(w, "arrived");
      g.travels.splice(i, 1);
    }
  }
}

function refusal(g: GraphRuntime, c: RecordFields<typeof STATE_CHANGE>): void {
  const who = g.rt.animator.node.name;
  if (c.playId) {
    const p = g.plays.get(c.playId);
    if (p) {
      g.plays.delete(c.playId);
      warnOnce(`slotref:${g.graph.path}:${p.clip.path}:${c.status}`, `[myco] ${who}: the animation core refused a slot play of "${p.name}" (status ${c.status}).`);
      endPlay(p, "stopped");
    }
    return;
  }
  if (c.status === STATUS_UNREACHABLE) {
    const w = g.travels.find((t) => !t.done && t.machine === c.layer);
    const meta = g.graph.meta.machines[c.layer];
    warnOnce(`unreach:${g.graph.path}:${c.layer}:${w?.state ?? -1}`, `[myco] ${who}: travel() can't reach "${w && meta ? meta.states[w.state] : "?"}" from the current state of "${meta?.node ?? c.layer}"; no path leads there.`);
    if (w) {
      endTravel(w, "unreachable");
      g.travels.splice(g.travels.indexOf(w), 1);
    }
    return;
  }
  const hint = c.status === STATUS_TOO_LARGE ? " (a linked graph larger than its node's declared capacity)" : "";
  warnOnce(`ref:${g.graph.path}:${c.status}:${c.layer}`, `[myco] ${who}: the animation core refused a graph command for index ${c.layer} of "${g.graph.path}" (status ${c.status}${hint}).`);
}

// ------------------------------------------------------------------------------------------------ state()

function debugView(g: GraphRuntime): DebugReport | null {
  if (g.debug) return g.debug;
  const core = g.ns.core;
  if (!g.ns.open || core.debugWrite(g.instance) === 0) return null;
  g.debug = readDebugReport(core.views().data, core.debugPtr());
  return g.debug;
}

/**
 * @internal The debug report of `animator`'s graph instance as of its last evaluate (read once per frame and shared
 * with `state()`), or null: no graph instance, still loading, or the core not open.
 */
export function graphDebugReport(animator: Animator): DebugReport | null {
  const g = animatorGraphs.get(animator)?.runtime;
  return g ? debugView(g) : null;
}

/** @internal `animator`'s live graph instance: its handle, the loaded graph's handle and tables; null without one. */
export function graphInstanceOf(animator: Animator): { readonly instance: number; readonly graph: number; readonly meta: GraphMeta; readonly path: string } | null {
  const g = animatorGraphs.get(animator)?.runtime;
  return g ? { instance: g.instance, graph: g.graph.handle, meta: g.graph.meta, path: g.graph.path } : null;
}

const EMPTY_STATE: AnimatorStateInfo = Object.freeze({ name: "", time: 0, normalizedTime: 0, weight: 0, transitioningTo: null });

/** @internal `Animator.state(layer)` on a graph Animator, as of the last evaluation. */
export function graphState(animator: Animator, layer: AnimatorLayer): AnimatorStateInfo {
  const g = animatorGraphs.get(animator)?.runtime;
  if (!g) return EMPTY_STATE;
  const meta = g.graph.meta;
  const m = machineFor(meta, layer);
  const clock = g.machines[m];
  const mm = meta.machines[m];
  if (!clock || !mm || clock.current < 0) return EMPTY_STATE;
  const dbg = debugView(g);
  const rec = dbg ? reportMachine(dbg, m) : undefined;
  const blending = rec !== undefined && rec.active !== NONE && rec.duration > 0 && rec.elapsed < rec.duration && clock.previous >= 0;
  if (blending) {
    const root = mm.roots[clock.previous] ?? -1;
    return {
      name: mm.states[clock.previous] ?? "",
      time: clock.previousTime + rec.elapsed,
      normalizedTime: reportNode(dbg!, root)?.normalized ?? 0,
      weight: 1 - rec.elapsed / rec.duration,
      transitioningTo: mm.states[clock.current] ?? null,
    };
  }
  return { name: mm.states[clock.current] ?? "", time: rec ? rec.stateTime : clock.time, normalizedTime: rec ? rec.normalized : 0, weight: 1, transitioningTo: null };
}
