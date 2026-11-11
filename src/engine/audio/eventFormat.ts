/**
 * Audio event assets (ADR 0158 §1): `*.audioevent.json`, `"format": "myco.audioevent@1"`. A pure, lenient parser:
 * bad values fall back to defaults and are reported in `problems`; it never throws. The runtime
 * (`plugins/audio/runtime/events/`) plays the parsed value; the editor reads and writes it.
 *
 * ```jsonc
 * {
 *   "format": "myco.audioevent@1",
 *   "bus": "SFX", "volume": 1, "pitch": 1, "volumeRandom": [-2, 0], "pitchRandom": [-1, 1], "priority": 128,
 *   "spatial": { "minDistance": 1, "maxDistance": 30, "rolloff": "inverse",      // absent: flat
 *                "occlusion": true, "dopplerLevel": 0, "reverbSendCurve": [[0, 1], [1, 0.5]] },   // ADR 0162 §2.5
 *   "filter": { "lowpass": 9000, "highpass": 80 }, "sends": { "reverb": 0.5, "Cave": 0.3 },   // ADR 0162 §2.5
 *   "limit": { "maxInstances": 4, "steal": "oldest" }, "cooldown": 0.05,
 *   "parameters": [{ "name": "Speed", "min": 0, "max": 10, "default": 0, "seekSpeed": 20 }],
 *   "automation": [{ "parameter": "Speed", "target": "volume", "curve": [[0, 0.5], [10, 1]] }],
 *   "root": { "type": "random", "avoidRepeat": 1, "children": [{ "type": "clip", "clip": "sfx/a.ogg" }] }
 * }
 * ```
 *
 * Names of parameters are checked against the event's own parameters only; global parameters live in the project's
 * `audio` section, so the runtime checks those when it plays the event.
 */

import { parseCurve, type Curve } from "../core/curve";

export const AUDIO_EVENT_FORMAT = "myco.audioevent@1";
export const AUDIO_EVENT_SUFFIX = ".audioevent.json";

/** True for an audio event asset path. */
export const isAudioEventPath = (path: string): boolean => path.toLowerCase().endsWith(AUDIO_EVENT_SUFFIX);

// --- parameters -----------------------------------------------------------------------------------------------------

/** A continuous parameter. `seekSpeed` is units per second toward a new value; 0 jumps. */
export interface NumericParameter {
  name: string;
  min: number;
  max: number;
  default: number;
  seekSpeed: number;
}

/** A labelled parameter (a "state"): one of `labels`; it always jumps. Its numeric value is the label's index. */
export interface LabelledParameter {
  name: string;
  labels: string[];
  default: string;
}

export type ParameterDef = NumericParameter | LabelledParameter;

export const isLabelled = (p: ParameterDef): p is LabelledParameter => "labels" in p;

/** The numeric range of a parameter: labelled ones are 0..labels-1. */
export const parameterRange = (p: ParameterDef): [number, number] => (isLabelled(p) ? [0, Math.max(0, p.labels.length - 1)] : [p.min, p.max]);

/** The default as a number (a label's index). */
export const parameterDefault = (p: ParameterDef): number => (isLabelled(p) ? Math.max(0, p.labels.indexOf(p.default)) : p.default);

/** At most this many parameters globally (the core's global slots). */
export const MAX_PARAMETERS = 64;
/** At most this many local parameters per event (the core's slots per instance). */
export const MAX_LOCAL_PARAMETERS = 16;
/** At most this many keys per automation curve (the core's curve table). */
export const MAX_CURVE_KEYS = 32;

/** An automation curve: `parseCurve`, capped at `MAX_CURVE_KEYS` keys. `null` when it has no keys. */
export function audioCurve(raw: unknown, where: string, problems: string[]): Curve | null {
  const curve = parseCurve(raw, where, problems);
  if (!curve || curve.length === 0) return null;
  if (curve.length > MAX_CURVE_KEYS) {
    problems.push(`${where}: at most ${MAX_CURVE_KEYS} keys; the rest are dropped.`);
    curve.length = MAX_CURVE_KEYS;
  }
  return curve;
}

// --- automation -----------------------------------------------------------------------------------------------------

export const EVENT_TARGETS = ["volume", "pitch", "lowpass"] as const;
/** `volume` is a linear gain multiplier, `pitch` a ratio multiplier, `lowpass` a cutoff in Hz (the lowest wins). */
export type EventTarget = (typeof EVENT_TARGETS)[number];

export interface Automation {
  parameter: string;
  target: EventTarget;
  curve: Curve;
}

// --- nodes ----------------------------------------------------------------------------------------------------------

export type PlayMode = "step" | "continuous";

/** What every node may carry. Child-specific keys are read only where they mean something. */
export interface NodeBase {
  volume: number;
  pitch: number;
  /** dB added per play, uniform in the range. */
  volumeRandom: [number, number];
  /** Semitones added per play, uniform in the range. */
  pitchRandom: [number, number];
  /** Seconds before the node starts. */
  delay: number;
  automation: Automation[];
  /** As a child of `random`: its relative chance (default 1). */
  weight: number;
  /** As a child of `switch`: the label it plays for. */
  value?: string;
  /** As a child of `blend`: the parameter range where it is at full level. */
  range?: [number, number];
  /** As a child of `blend`: the width, in parameter units, of its fade in below `range` and out above it. */
  fade: number;
}

export interface ClipNode extends NodeBase {
  type: "clip";
  /** Asset path, without `asset:`. */
  clip: string;
  loop: boolean;
  /** Seconds into the clip to start at. */
  startOffset: number;
  /** Seconds: loop only this part (default: the clip's own loop points, else the whole clip). */
  loopRegion?: [number, number];
  /** Loop until the instance is released, then play the rest of the clip (ADR 0158 §4). Implies looping. */
  sustain: boolean;
}

export interface RandomNode extends NodeBase {
  type: "random";
  children: EventNode[];
  /** Skip the last n picks (capped at children − 1). */
  avoidRepeat: number;
  mode: PlayMode;
  /** Continuous: seconds between one pick's end and the next's start; negative overlaps with a crossfade. */
  gap: number;
}

export interface SequenceNode extends NodeBase {
  type: "sequence";
  children: EventNode[];
  mode: PlayMode;
  /** Continuous: start over after the last child; otherwise stop. */
  loop: boolean;
  gap: number;
  /** Step: go back to the first child after this many idle seconds; 0 never. */
  reset: number;
}

export type SwitchChange = "keep" | "restart" | "crossfade";

export interface SwitchNode extends NodeBase {
  type: "switch";
  /** A labelled parameter. */
  parameter: string;
  children: EventNode[];
  /** The label to use when no child matches; absent: the first child. */
  default?: string;
  onChange: SwitchChange;
  /** `onChange: "crossfade"`: seconds. */
  crossfade: number;
}

export interface BlendNode extends NodeBase {
  type: "blend";
  parameter: string;
  children: EventNode[];
}

export interface LayerNode extends NodeBase {
  type: "layer";
  children: EventNode[];
}

export type SustainRelease = "now" | "loopEnd";

export interface SustainNode extends NodeBase {
  type: "sustain";
  start?: EventNode;
  loop: EventNode;
  end?: EventNode;
  release: SustainRelease;
  /** `release: "now"`: crossfade seconds from the loop into `end` (when `releaseFade` is absent). */
  fade: number;
  /**
   * `release: "now"`: crossfade seconds from the loop into `end`, separate from `fade` so a sustain that is itself a
   * blend child can keep its blend fade (m2-decisions entry 10, owner 2026-11-10). Absent: `fade` is used, as before.
   */
  releaseFade?: number;
}

/** The release crossfade of a sustain node: `releaseFade` when set, else `fade` (files written before the key). */
export function sustainReleaseFade(node: SustainNode): number {
  return node.releaseFade ?? node.fade;
}

export type EventNode = ClipNode | RandomNode | SequenceNode | SwitchNode | BlendNode | LayerNode | SustainNode;
export const NODE_TYPES = ["clip", "random", "sequence", "switch", "blend", "layer", "sustain"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// --- the event ------------------------------------------------------------------------------------------------------

export type Steal = "oldest" | "quietest" | "none";
export type EventRolloff = "linear" | "inverse" | "exponential";

/** A spatial event. The ADR 0162 §2.5 keys are absent when the file doesn't set them (the runtime applies the defaults). */
export interface EventSpatial {
  minDistance: number;
  maxDistance: number;
  rolloff: EventRolloff;
  /** Default true. */
  occlusion?: boolean;
  /** 0..5, default 0. */
  dopplerLevel?: number;
  /** The reverb send against distance (`SendCurve`, ADR 0162 §1.1); default `[[0, 1], [1, 0.5]]`. */
  reverbSendCurve?: Curve;
}

export interface EventFilter {
  lowpass?: number;
  highpass?: number;
}

/** The `sends` key that is the event's own `reverbSend`; every other key is an aux send to the bus of that name. */
export const REVERB_SEND_KEY = "reverb";

export interface AudioEventAsset {
  format: typeof AUDIO_EVENT_FORMAT;
  /** Empty: Master. */
  bus: string;
  volume: number;
  pitch: number;
  volumeRandom: [number, number];
  pitchRandom: [number, number];
  /** 0..255. */
  priority: number;
  /** Absent: the event plays flat. */
  spatial?: EventSpatial;
  /** ADR 0162 §2.5: per-voice filters, Hz (10..24000; lowpass at or above 20000 and highpass at or below 20 are off). Absent: none. */
  filter?: EventFilter;
  /** ADR 0162 §2.5: `reverb` (0..2) is the event's `reverbSend`; at most one other key, an aux send to that bus (0..2). Absent: none. */
  sends?: Record<string, number>;
  /** `maxInstances` 0 is unlimited. `steal` decides who goes when a new instance would pass it. */
  limit: { maxInstances: number; steal: Steal };
  /** Seconds; a play sooner than this after the last one is refused. */
  cooldown: number;
  parameters: ParameterDef[];
  automation: Automation[];
  root: EventNode;
}

/** Nesting deeper than this is cut (a child at the limit is dropped). */
export const MAX_EVENT_DEPTH = 16;
/** At most this many nodes per event; more are dropped. */
export const MAX_EVENT_NODES = 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

class Reader {
  nodes = 0;
  constructor(readonly problems: string[]) {}

  num(raw: unknown, where: string, fallback: number, min = -Infinity, max = Infinity): number {
    if (raw === undefined) return fallback;
    if (!finite(raw)) { this.problems.push(`${where}: must be a number; using ${fallback}.`); return fallback; }
    if (raw < min || raw > max) {
      const c = Math.min(max, Math.max(min, raw));
      this.problems.push(`${where}: ${raw} is outside ${min}..${max}; using ${c}.`);
      return c;
    }
    return raw;
  }

  bool(raw: unknown, where: string, fallback: boolean): boolean {
    if (raw === undefined) return fallback;
    if (typeof raw !== "boolean") { this.problems.push(`${where}: must be true or false; using ${fallback}.`); return fallback; }
    return raw;
  }

  str(raw: unknown, where: string, fallback: string): string {
    if (raw === undefined) return fallback;
    if (typeof raw !== "string") { this.problems.push(`${where}: must be a string; using "${fallback}".`); return fallback; }
    return raw;
  }

  pick<T extends string>(raw: unknown, where: string, options: readonly T[], fallback: T): T {
    if (raw === undefined) return fallback;
    if (typeof raw === "string" && (options as readonly string[]).includes(raw)) return raw as T;
    this.problems.push(`${where}: must be one of ${options.join(", ")}; using "${fallback}".`);
    return fallback;
  }

  /** `[lo, hi]` with lo <= hi (swapped with a problem); absent gives `fallback`. */
  pair(raw: unknown, where: string, fallback: [number, number] | undefined, min = -Infinity, max = Infinity): [number, number] | undefined {
    if (raw === undefined) return fallback;
    if (!Array.isArray(raw) || raw.length !== 2 || !finite(raw[0]) || !finite(raw[1])) {
      this.problems.push(`${where}: must be [low, high] numbers.`);
      return fallback;
    }
    let lo = Math.min(max, Math.max(min, raw[0])), hi = Math.min(max, Math.max(min, raw[1]));
    if (lo !== raw[0] || hi !== raw[1]) this.problems.push(`${where}: clamped to ${min}..${max}.`);
    if (lo > hi) { this.problems.push(`${where}: low was above high; swapped.`); [lo, hi] = [hi, lo]; }
    return [lo, hi];
  }

  automation(raw: unknown, where: string): Automation[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) { this.problems.push(`${where}: must be a list.`); return []; }
    const out: Automation[] = [];
    raw.forEach((a, i) => {
      const w = `${where}[${i}]`;
      if (!isRecord(a) || typeof a.parameter !== "string" || a.parameter === "") return void this.problems.push(`${w}: parameter must name a parameter; dropped.`);
      if (typeof a.target !== "string" || !(EVENT_TARGETS as readonly string[]).includes(a.target)) return void this.problems.push(`${w}: target must be one of ${EVENT_TARGETS.join(", ")}; dropped.`);
      const curve = audioCurve(a.curve, `${w}.curve`, this.problems);
      if (!curve) return void this.problems.push(`${w}: the curve has no keys; dropped.`);
      out.push({ parameter: a.parameter, target: a.target as EventTarget, curve });
    });
    return out;
  }

  children(raw: unknown, where: string, depth: number): EventNode[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) { this.problems.push(`${where}: must be a list.`); return []; }
    const out: EventNode[] = [];
    raw.forEach((c, i) => { const n = this.node(c, `${where}[${i}]`, depth + 1); if (n) out.push(n); });
    return out;
  }

  node(raw: unknown, where: string, depth: number): EventNode | null {
    if (depth >= MAX_EVENT_DEPTH) { this.problems.push(`${where}: nested deeper than ${MAX_EVENT_DEPTH}; dropped.`); return null; }
    if (this.nodes >= MAX_EVENT_NODES) { this.problems.push(`${where}: more than ${MAX_EVENT_NODES} nodes; dropped.`); return null; }
    if (!isRecord(raw) || typeof raw.type !== "string" || !(NODE_TYPES as readonly string[]).includes(raw.type)) {
      this.problems.push(`${where}: type must be one of ${NODE_TYPES.join(", ")}; dropped.`);
      return null;
    }
    this.nodes++;
    const base: NodeBase = {
      volume: this.num(raw.volume, `${where}.volume`, 1, 0, 4),
      pitch: this.num(raw.pitch, `${where}.pitch`, 1, 0.0625, 16),
      volumeRandom: this.pair(raw.volumeRandom, `${where}.volumeRandom`, [0, 0], -96, 24)!,
      pitchRandom: this.pair(raw.pitchRandom, `${where}.pitchRandom`, [0, 0], -48, 48)!,
      delay: this.num(raw.delay, `${where}.delay`, 0, 0, 60),
      automation: this.automation(raw.automation, `${where}.automation`),
      weight: this.num(raw.weight, `${where}.weight`, 1, 0, 1e6),
      fade: this.num(raw.fade, `${where}.fade`, 0, 0, 1e6),
    };
    if (raw.value !== undefined) base.value = this.str(raw.value, `${where}.value`, "");
    const range = this.pair(raw.range, `${where}.range`, undefined);
    if (range) base.range = range;
    const mode = (): PlayMode => this.pick(raw.mode, `${where}.mode`, ["step", "continuous"] as const, "step");
    const gap = (): number => this.num(raw.gap, `${where}.gap`, 0, -10, 60);
    const type = raw.type as NodeType;
    switch (type) {
      case "clip": {
        const clip = this.str(raw.clip, `${where}.clip`, "").replace(/^asset:/, "");
        if (clip === "") this.problems.push(`${where}: clip is empty; it plays nothing.`);
        const node: ClipNode = {
          ...base, type, clip, loop: this.bool(raw.loop, `${where}.loop`, false),
          startOffset: this.num(raw.startOffset, `${where}.startOffset`, 0, 0), sustain: this.bool(raw.sustain, `${where}.sustain`, false),
        };
        const region = this.pair(raw.loopRegion, `${where}.loopRegion`, undefined, 0);
        if (region) {
          if (region[1] > region[0]) node.loopRegion = region;
          else this.problems.push(`${where}.loopRegion: must be longer than zero; ignored.`);
        }
        return node;
      }
      case "random":
      case "layer": {
        const children = this.children(raw.children, `${where}.children`, depth);
        if (children.length === 0) this.problems.push(`${where}: has no children; it plays nothing.`);
        if (type === "layer") return { ...base, type, children };
        return {
          ...base, type, children, mode: mode(), gap: gap(),
          avoidRepeat: Math.round(this.num(raw.avoidRepeat, `${where}.avoidRepeat`, 0, 0, Math.max(0, children.length - 1))),
        };
      }
      case "sequence": {
        const children = this.children(raw.children, `${where}.children`, depth);
        if (children.length === 0) this.problems.push(`${where}: has no children; it plays nothing.`);
        return {
          ...base, type, children, mode: mode(), gap: gap(), loop: this.bool(raw.loop, `${where}.loop`, false),
          reset: this.num(raw.reset, `${where}.reset`, 0, 0),
        };
      }
      case "switch":
      case "blend": {
        const parameter = this.str(raw.parameter, `${where}.parameter`, "");
        if (parameter === "") this.problems.push(`${where}: parameter is empty; it plays its ${type === "switch" ? "default" : "children at their lowest"}.`);
        const children = this.children(raw.children, `${where}.children`, depth);
        if (children.length === 0) this.problems.push(`${where}: has no children; it plays nothing.`);
        if (type === "blend") {
          children.forEach((c, i) => { if (!c.range) this.problems.push(`${where}.children[${i}]: a blend child needs a range; it plays at every value.`); });
          return { ...base, type, parameter, children };
        }
        children.forEach((c, i) => { if (c.value === undefined) this.problems.push(`${where}.children[${i}]: a switch child needs a value; it plays only as the default.`); });
        const node: SwitchNode = {
          ...base, type, parameter, children,
          onChange: this.pick(raw.onChange, `${where}.onChange`, ["keep", "restart", "crossfade"] as const, "keep"),
          crossfade: this.num(raw.crossfade, `${where}.crossfade`, 0.1, 0, 10),
        };
        if (raw.default !== undefined) node.default = this.str(raw.default, `${where}.default`, "");
        return node;
      }
      case "sustain": {
        const loop = this.node(raw.loop, `${where}.loop`, depth + 1);
        if (!loop) { this.problems.push(`${where}: needs a loop node; dropped.`); return null; }
        const node: SustainNode = { ...base, type, loop, release: this.pick(raw.release, `${where}.release`, ["now", "loopEnd"] as const, "loopEnd") };
        if (raw.start !== undefined) { const s = this.node(raw.start, `${where}.start`, depth + 1); if (s) node.start = s; }
        if (raw.end !== undefined) { const e = this.node(raw.end, `${where}.end`, depth + 1); if (e) node.end = e; }
        if (raw.releaseFade !== undefined) node.releaseFade = this.num(raw.releaseFade, `${where}.releaseFade`, 0, 0, 1e6);
        return node;
      }
    }
  }
}

/**
 * The parameter list of an event or of the project's `audio.parameters`, leniently. Names must be unique and
 * non-empty; numeric ones get `min <= default <= max`; labelled ones need at least one label.
 */
export function parseParameters(raw: unknown, where: string, problems: string[], limit = MAX_PARAMETERS): ParameterDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { problems.push(`${where}: must be a list.`); return []; }
  const r = new Reader(problems);
  const out: ParameterDef[] = [];
  raw.forEach((p, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(p) || typeof p.name !== "string" || p.name.trim() === "") return void problems.push(`${w}: name must be a non-empty string; dropped.`);
    if (out.some((o) => o.name === p.name)) return void problems.push(`${w}: another parameter is already named "${p.name}"; dropped.`);
    if (out.length >= limit) return void problems.push(`${w}: at most ${limit} parameters; dropped.`);
    if (p.labels !== undefined) {
      const labels = Array.isArray(p.labels) ? [...new Set(p.labels.filter((l): l is string => typeof l === "string" && l !== ""))] : [];
      if (labels.length === 0) return void problems.push(`${w}: labels must be a list of names; dropped.`);
      let def = typeof p.default === "string" ? p.default : labels[0];
      if (!labels.includes(def)) { problems.push(`${w}: default "${def}" is not one of its labels; using "${labels[0]}".`); def = labels[0]; }
      return void out.push({ name: p.name, labels, default: def });
    }
    let min = r.num(p.min, `${w}.min`, 0), max = r.num(p.max, `${w}.max`, 1);
    if (min > max) { problems.push(`${w}: min was above max; swapped.`); [min, max] = [max, min]; }
    out.push({ name: p.name, min, max, default: r.num(p.default, `${w}.default`, min, min, max), seekSpeed: r.num(p.seekSpeed, `${w}.seekSpeed`, 0, 0) });
  });
  return out;
}

/** The empty event the parse falls back to: a layer with no children (plays nothing). */
export const emptyAudioEvent = (): AudioEventAsset => ({
  format: AUDIO_EVENT_FORMAT, bus: "", volume: 1, pitch: 1, volumeRandom: [0, 0], pitchRandom: [0, 0], priority: 128,
  limit: { maxInstances: 0, steal: "oldest" }, cooldown: 0, parameters: [], automation: [],
  root: { type: "layer", children: [], volume: 1, pitch: 1, volumeRandom: [0, 0], pitchRandom: [0, 0], delay: 0, automation: [], weight: 1, fade: 0 },
});

/** Every node in the tree, depth first (sustain slots in start, loop, end order). */
export function* eventNodes(node: EventNode): Generator<EventNode> {
  yield node;
  if (node.type === "sustain") {
    if (node.start) yield* eventNodes(node.start);
    yield* eventNodes(node.loop);
    if (node.end) yield* eventNodes(node.end);
  } else if (node.type !== "clip") for (const c of node.children) yield* eventNodes(c);
}

/** The clip paths an event references, once each, in tree order (for preloading, export and rename tracking). */
export function eventClips(event: AudioEventAsset): string[] {
  const out = new Set<string>();
  for (const n of eventNodes(event.root)) if (n.type === "clip" && n.clip) out.add(n.clip);
  return [...out];
}

/** An `*.audioevent.json` value, leniently. A wrong or missing `format` is a problem but the rest is still read. */
export function parseAudioEvent(raw: unknown): { value: AudioEventAsset; problems: string[] } {
  const problems: string[] = [];
  const value = emptyAudioEvent();
  if (!isRecord(raw)) return { value, problems: ["an audio event must be a JSON object."] };
  if (raw.format !== AUDIO_EVENT_FORMAT) problems.push(`format: expected "${AUDIO_EVENT_FORMAT}"${raw.format === undefined ? "" : `, found ${JSON.stringify(raw.format)}`}; reading it anyway.`);
  const r = new Reader(problems);
  value.bus = r.str(raw.bus, "bus", "");
  value.volume = r.num(raw.volume, "volume", 1, 0, 4);
  value.pitch = r.num(raw.pitch, "pitch", 1, 0.0625, 16);
  value.volumeRandom = r.pair(raw.volumeRandom, "volumeRandom", [0, 0], -96, 24)!;
  value.pitchRandom = r.pair(raw.pitchRandom, "pitchRandom", [0, 0], -48, 48)!;
  value.priority = Math.round(r.num(raw.priority, "priority", 128, 0, 255));
  if (raw.spatial !== undefined && raw.spatial !== null && raw.spatial !== false) {
    if (!isRecord(raw.spatial)) problems.push("spatial: must be an object; playing flat.");
    else if (raw.spatial.enabled !== false) {
      const min = r.num(raw.spatial.minDistance, "spatial.minDistance", 1, 0);
      const spatial: EventSpatial = {
        minDistance: min, maxDistance: r.num(raw.spatial.maxDistance, "spatial.maxDistance", Math.max(min, 100), min),
        rolloff: r.pick(raw.spatial.rolloff, "spatial.rolloff", ["linear", "inverse", "exponential"] as const, "inverse"),
      };
      if (raw.spatial.occlusion !== undefined) spatial.occlusion = r.bool(raw.spatial.occlusion, "spatial.occlusion", true);
      if (raw.spatial.dopplerLevel !== undefined) spatial.dopplerLevel = r.num(raw.spatial.dopplerLevel, "spatial.dopplerLevel", 0, 0, 5);
      if (raw.spatial.reverbSendCurve !== undefined) {
        const curve = audioCurve(raw.spatial.reverbSendCurve, "spatial.reverbSendCurve", problems);
        if (curve) spatial.reverbSendCurve = curve;
        else if (Array.isArray(raw.spatial.reverbSendCurve)) problems.push("spatial.reverbSendCurve: the curve has no keys; using the default.");
      }
      value.spatial = spatial;
    }
  }
  if (raw.filter !== undefined) {
    if (!isRecord(raw.filter)) problems.push("filter: must be an object.");
    else {
      const filter: EventFilter = {};
      if (raw.filter.lowpass !== undefined) filter.lowpass = r.num(raw.filter.lowpass, "filter.lowpass", 24000, 10, 24000);
      if (raw.filter.highpass !== undefined) filter.highpass = r.num(raw.filter.highpass, "filter.highpass", 10, 10, 24000);
      if (filter.lowpass !== undefined || filter.highpass !== undefined) value.filter = filter;
    }
  }
  if (raw.sends !== undefined) {
    if (!isRecord(raw.sends)) problems.push("sends: must be an object.");
    else {
      const sends: Record<string, number> = {};
      let aux: string | null = null;
      for (const [key, v] of Object.entries(raw.sends)) {
        const where = `sends.${key}`;
        if (key !== REVERB_SEND_KEY) {
          if (aux !== null) { problems.push(`${where}: an event has one aux send ("${aux}" is the first); this one is dropped.`); continue; }
          if (!finite(v)) { problems.push(`${where}: must be a number; dropped.`); continue; }
          aux = key;
          sends[key] = r.num(v, where, 0, 0, 2);
        } else if (v !== undefined) sends[key] = r.num(v, where, 1, 0, 2);
      }
      if (Object.keys(sends).length > 0) value.sends = sends;
    }
  }
  if (raw.limit !== undefined) {
    if (!isRecord(raw.limit)) problems.push("limit: must be an object.");
    else value.limit = {
      maxInstances: Math.round(r.num(raw.limit.maxInstances, "limit.maxInstances", 0, 0, 4096)),
      steal: r.pick(raw.limit.steal, "limit.steal", ["oldest", "quietest", "none"] as const, "oldest"),
    };
  }
  value.cooldown = r.num(raw.cooldown, "cooldown", 0, 0, 60);
  value.parameters = parseParameters(raw.parameters, "parameters", problems, MAX_LOCAL_PARAMETERS);
  value.automation = r.automation(raw.automation, "automation");
  if (raw.root === undefined) problems.push("root: missing; the event plays nothing.");
  else { const root = r.node(raw.root, "root", 0); if (root) value.root = root; }

  // Local checks: a switch must name a labelled parameter when it names a local one; automation on a local labelled
  // parameter reads its index. Unknown names may be global and are left to the runtime.
  const local = new Map(value.parameters.map((p) => [p.name, p]));
  for (const n of eventNodes(value.root)) {
    if (n.type === "switch") {
      const p = local.get(n.parameter);
      if (p && !isLabelled(p)) problems.push(`switch on "${n.parameter}": a switch needs a labelled parameter; it plays its default.`);
    }
  }
  return { value, problems };
}

/** The asset as JSON text, `format` first, two-space indent (as the editor writes every asset). */
export function formatAudioEvent(value: AudioEventAsset): string {
  const { format: _f, filter, sends, root, ...rest } = value;
  // `filter` and `sends` only when set, ahead of `root` (which stays last).
  return JSON.stringify({ format: AUDIO_EVENT_FORMAT, ...rest, ...(filter ? { filter } : {}), ...(sends ? { sends } : {}), root }, null, 2) + "\n";
}
