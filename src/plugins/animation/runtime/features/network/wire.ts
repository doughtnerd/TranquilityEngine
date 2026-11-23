// The Animator's replicated fields (ADR 0370 "Networking", 0372 "Replication"; D93, T33): four string fields that
// replicate as 0033's replicated strings do (sent whole and reliably when they change, ADR 0068), each a compact JSON
// array. Ticks are server ticks, so a client places each change on its own timeline (the interpolation tick for
// interpolated ghosts, the newest snapshot for the owner's predicted one).
//
//   netStates      [[machine, state, enteredTick], …]            each layer's state machine (graph indices)
//   netParameters  [changedTick, [[param, value], …]]            parameters declared `replicate` (numbers to 1/1024)
//   netSlots       [[slot, clip, tick, start, end, speed, loop, fade, stopTick, stopFade], …]
//                                                                 each slot's latest play: clip path, start tick,
//                                                                 section in clip seconds (end 0: the clip's end),
//                                                                 loop 0/1, blend seconds, and the tick (-1: none) and
//                                                                 fade of a stop
//   netLinks       [[node, graph, tick], …]                       linked-graph choices made by `link` (graph null: the default)
//
// Replicated strings are at most `MAX_STR_BYTES` (255) UTF-8 bytes each (ADR 0068): an encoder leaves out the entries
// that don't fit (for slots, the oldest plays go first) and says how many it left out, so a string is never cut
// mid-JSON. The normalised time of a state is its time since `enteredTick` (so the string changes only when the state does).
// Slot section times are written exactly, so a client sampling a play's root curve gets the server's numbers. Decoding
// is lenient: anything malformed decodes as empty, never throws. A pure library.
import { MAX_STR_BYTES } from "../../../../../engine/net/messages";

/** @internal A layer's state machine in its state, since a tick. */
export interface NetState {
  readonly machine: number;
  readonly state: number;
  readonly tick: number;
}

/** @internal A parameter value as it replicates. */
export type NetParameterValue = number | boolean | number[];

/** @internal Replicated parameter values, as of the tick they last changed. */
export interface NetParameters {
  readonly tick: number;
  readonly values: readonly (readonly [number, NetParameterValue])[];
}

/** @internal A slot's latest play. */
export interface NetSlot {
  readonly slot: string;
  readonly clip: string;
  readonly tick: number;
  readonly start: number;
  readonly end: number;
  readonly speed: number;
  readonly loop: boolean;
  readonly fade: number;
  readonly stopTick: number;
  readonly stopFade: number;
}

/** @internal A linked-graph choice. */
export interface NetLink {
  readonly node: string;
  readonly graph: string | null;
  readonly tick: number;
}

/** @internal An encoded field and how many entries didn't fit in it. */
export interface Encoded {
  readonly raw: string;
  readonly dropped: number;
}

const bytes = new TextEncoder();

/** `wrap(entries)` with as many of `entries` (from the front) as fit in `MAX_STR_BYTES`; "" for none. */
function fit<T>(entries: readonly T[], wrap: (entries: readonly T[]) => string): Encoded {
  for (let n = entries.length; n > 0; n--) {
    const raw = wrap(entries.slice(0, n));
    if (raw.length <= MAX_STR_BYTES && bytes.encode(raw).byteLength <= MAX_STR_BYTES) return { raw, dropped: entries.length - n };
  }
  return { raw: "", dropped: entries.length };
}

/** Parameter numbers replicate in steps of 1/1024 (exact in binary, finer than any blend shows). */
export const PARAMETER_STEP = 1 / 1024;

const quantize = (v: number): number => Math.round(v / PARAMETER_STEP) * PARAMETER_STEP;
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";

function parse(raw: string): unknown[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** @internal `netStates`. */
export function encodeStates(states: readonly NetState[]): Encoded {
  return fit(states, (list) => JSON.stringify(list.map((s) => [s.machine, s.state, s.tick])));
}

/** @internal `netStates`, leniently. */
export function decodeStates(raw: string): NetState[] {
  const out: NetState[] = [];
  for (const e of parse(raw)) if (Array.isArray(e) && int(e[0]) && int(e[1]) && int(e[2]) && e[0] >= 0 && e[1] >= 0) out.push({ machine: e[0], state: e[1], tick: e[2] });
  return out;
}

/** @internal A parameter value in its replicated form (numbers quantised). */
export function quantizeParameter(v: NetParameterValue): NetParameterValue {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isInteger(v) ? v : quantize(v);
  return v.map(quantize);
}

/** @internal `netParameters` (values already quantised). */
export function encodeParameters(p: NetParameters): Encoded {
  return fit(p.values, (list) => JSON.stringify([p.tick, list]));
}

/** @internal `netParameters`, leniently. */
export function decodeParameters(raw: string): NetParameters | null {
  const v = parse(raw);
  if (!int(v[0]) || !Array.isArray(v[1])) return null;
  const values: [number, NetParameterValue][] = [];
  for (const e of v[1] as unknown[]) {
    if (!Array.isArray(e) || !int(e[0]) || e[0] < 0) continue;
    const x: unknown = e[1];
    if (typeof x === "boolean" || num(x)) values.push([e[0], x]);
    else if (Array.isArray(x) && x.length >= 2 && x.length <= 4 && x.every(num)) values.push([e[0], x as number[]]);
  }
  return { tick: v[0], values };
}

/** @internal `netSlots`: the newest plays first, so the oldest are left out when they don't all fit. */
export function encodeSlots(slots: readonly NetSlot[]): Encoded {
  const newest = [...slots].sort((a, b) => b.tick - a.tick);
  return fit(newest, (list) => JSON.stringify(list.map((s) => [s.slot, s.clip, s.tick, s.start, s.end, s.speed, s.loop ? 1 : 0, s.fade, s.stopTick, s.stopFade])));
}

/** @internal `netSlots`, leniently. */
export function decodeSlots(raw: string): NetSlot[] {
  const out: NetSlot[] = [];
  for (const e of parse(raw)) {
    if (!Array.isArray(e) || !str(e[0]) || !str(e[1]) || !e[1] || !int(e[2])) continue;
    const [start, end, speed, loop, fade, stopTick, stopFade] = e.slice(3);
    if (!num(start) || !num(end) || !num(speed) || !num(fade) || !int(stopTick) || !num(stopFade)) continue;
    out.push({ slot: e[0], clip: e[1], tick: e[2], start, end, speed, loop: loop === 1, fade, stopTick, stopFade });
  }
  return out;
}

/** @internal `netLinks`. */
export function encodeLinks(links: readonly NetLink[]): Encoded {
  return fit(links, (list) => JSON.stringify(list.map((l) => [l.node, l.graph, l.tick])));
}

/** @internal `netLinks`, leniently. */
export function decodeLinks(raw: string): NetLink[] {
  const out: NetLink[] = [];
  for (const e of parse(raw)) if (Array.isArray(e) && str(e[0]) && (e[1] === null || str(e[1])) && int(e[2])) out.push({ node: e[0], graph: e[1] || null, tick: e[2] });
  return out;
}
