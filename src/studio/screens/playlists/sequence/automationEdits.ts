// Automation on clips and tracks (ADR 0343, 0346; proto §3.4 "Envelope drawing", "Write automation"). A clip's curves
// read clip time (or a parameter), a track's read sequence time; targets are volume, pitch, pan, enabled and effect
// parameters (`fx:<id>:<param>`). Point edits (add, drag clamped between neighbours, delete, shape), "Add volume
// envelope", the curve editor's result, and touch-mode writing: samples recorded while a control is held during
// playback replace the keys over the range they cover; parameter-driven curves are never overwritten. Pure.
import { effectParamValue, effectSpec } from "../../../../engine/audio/effects/catalogue";
import { parameterRange, type ParameterDef } from "../../../../engine/audio/parameters";
import type { Effect } from "../../../../engine/audio/effects/types";
import { evalCurve, type CurveInterp, type CurveKey } from "../../../../engine/core/curve";
import type { Automation, Clip, CurveInput, SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import { accept, refuse, type EditResult } from "../../../../plugins/audio/editor/editResult";
import { findClip, mapClips, mapTrack, nextId, tidy, trackIndex } from "./sequenceModel";

type R = EditResult<SequenceSettings>;

/** Whose automation: a clip's or a track's. */
export type AutomationOwner = { readonly clip: string } | { readonly track: string };

/** The format's lane limit (ADR 0343). */
export const MAX_AUTOMATION = 32;
export const MAX_KEYS = 64;

/** A target's name, unit and range: what a lane draws and what the curve editor edits. */
export interface TargetSpec {
  readonly target: Automation["target"];
  readonly name: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** The plain value (a flat curve, Clear). */
  readonly base: number;
  readonly bool?: boolean;
  readonly scale?: "linear" | "log";
}

const BASE_TARGETS: readonly TargetSpec[] = [
  { target: "volume", name: "Volume", unit: "dB", min: -60, max: 12, step: 0.5, base: 0 },
  { target: "pitch", name: "Pitch", unit: "st", min: -24, max: 24, step: 0.1, base: 0 },
  { target: "pan", name: "Pan", unit: "", min: -1, max: 1, step: 0.01, base: 0 },
  { target: "enabled", name: "Enabled", unit: "", min: 0, max: 1, step: 1, base: 1, bool: true },
];

/** What can be automated on an owner with `effects`: the base targets, then each effect's On and parameters. */
export function targetSpecs(effects: readonly Effect[]): TargetSpec[] {
  const out = [...BASE_TARGETS];
  for (const e of effects) {
    const spec = effectSpec(e.type);
    const name = spec.label;
    out.push({ target: `fx:${e.id}:on`, name: `${name} · On`, unit: "", min: 0, max: 1, step: 1, base: e.on ? 1 : 0, bool: true });
    for (const p of spec.params) {
      out.push({ target: `fx:${e.id}:${p.name}`, name: `${name} · ${p.label}`, unit: p.unit, min: p.min, max: p.max, step: p.step, base: effectParamValue(e, p.name) ?? p.default, scale: p.scale, bool: p.bool });
    }
  }
  return out;
}

export function targetSpec(target: string, effects: readonly Effect[]): TargetSpec | null {
  return targetSpecs(effects).find((t) => t.target === target) ?? null;
}

interface OwnerView {
  readonly automation: readonly Automation[];
  readonly effects: readonly Effect[];
  /** The input a time curve on this owner reads. */
  readonly timeInput: CurveInput;
}

export function ownerOf(s: SequenceSettings, o: AutomationOwner): OwnerView | null {
  if ("clip" in o) {
    const f = findClip(s, o.clip);
    return f ? { automation: f.clip.automation, effects: f.clip.effects, timeInput: "clipTime" } : null;
  }
  const t = s.tracks[trackIndex(s, o.track)];
  return t ? { automation: t.automation, effects: t.effects, timeInput: "sequenceTime" } : null;
}

function setOwnerAutomation(s: SequenceSettings, o: AutomationOwner, fn: (list: readonly Automation[]) => Automation[]): SequenceSettings {
  if ("clip" in o) return mapClips(s, (c: Clip) => (c.id === o.clip ? { ...c, automation: fn(c.automation) } : c));
  return mapTrack(s, o.track, (t: Track) => ({ ...t, automation: fn(t.automation) }));
}

function mapAutomation(s: SequenceSettings, o: AutomationOwner, id: string, fn: (a: Automation) => Automation | null): R {
  const view = ownerOf(s, o);
  if (!view) return refuse("that clip or track isn't there any more");
  if (!view.automation.some((a) => a.id === id)) return refuse("that automation isn't there any more");
  return accept(setOwnerAutomation(s, o, (list) => list.flatMap((a) => {
    if (a.id !== id) return [a];
    const n = fn(a);
    return n ? [n] : [];
  })));
}

export const isTimeInput = (input: CurveInput): boolean => typeof input === "string";

/**
 * The x range a parameter-driven lane draws its curve over (proto §2.7.3: the parameter's range, its min and max named
 * at the lane's ends): the parameter's own range (a labelled one 0..labels-1), or the curve's keys when the parameter
 * isn't defined. Null for a time-driven lane.
 */
export function parameterLaneRange(input: CurveInput, curve: readonly CurveKey[], parameters: readonly ParameterDef[]): { readonly name: string; readonly min: number; readonly max: number } | null {
  if (typeof input === "string") return null;
  const def = parameters.find((p) => p.name === input.parameter);
  let [min, max] = def ? parameterRange(def) : [Math.min(0, ...curve.map((k) => k[0])), Math.max(1, ...curve.map((k) => k[0]))];
  if (!(max > min)) max = min + 1;
  return { name: input.parameter, min, max };
}

/** "Automate X": a flat time curve at the target's plain value over `[0, length]`. Returns the lane's id. */
export function addAutomation(s: SequenceSettings, o: AutomationOwner, target: Automation["target"], length: number, input?: CurveInput): EditResult<{ seq: SequenceSettings; id: string }> {
  const view = ownerOf(s, o);
  if (!view) return refuse("that clip or track isn't there any more");
  const existing = view.automation.find((a) => a.target === target);
  if (existing) return accept({ seq: s, id: existing.id });
  if (view.automation.length >= MAX_AUTOMATION) return refuse(`at most ${MAX_AUTOMATION} automation lanes`);
  const spec = targetSpec(target, view.effects);
  if (!spec) return refuse(`"${target}" isn't something this ${"clip" in o ? "clip" : "track"} can automate`);
  const id = nextId("a", view.automation.map((a) => a.id));
  const curve: CurveKey[] = [[0, spec.base], [tidy(Math.max(0.01, length)), spec.base]];
  return accept({ seq: setOwnerAutomation(s, o, (list) => [...list, { id, target, input: input ?? view.timeInput, curve, bypass: false }]), id });
}

/** "Add volume envelope": a clip's first curve, 0 dB at both ends plus the double-clicked point. */
export function addVolumeEnvelope(s: SequenceSettings, clipId: string, x: number, y: number, length: number): EditResult<{ seq: SequenceSettings; id: string }> {
  const f = findClip(s, clipId);
  if (!f) return refuse("that clip isn't there any more");
  if (f.clip.automation.some((a) => a.target === "volume")) return refuse("this clip already has a volume envelope");
  const r = addAutomation(s, { clip: clipId }, "volume", length);
  if ("refused" in r) return r;
  const all: [number, number][] = [[0, 0], [tidy(x), clampVolume(y)], [tidy(length), 0]];
  const keys: CurveKey[] = all.filter((k, i) => i === 0 || k[0] > all[i - 1]![0] + 1e-6);
  const m = mapAutomation(r.next.seq, { clip: clipId }, r.next.id, (a) => ({ ...a, curve: keys }));
  return "refused" in m ? m : accept({ seq: m.next, id: r.next.id });
}

const clampVolume = (y: number) => Math.max(BASE_TARGETS[0]!.min, Math.min(BASE_TARGETS[0]!.max, y));

/** The shape a key's segment has ("Linear" etc. in the shape menu); "hold" is the engine's step. */
export const SHAPES: readonly { readonly shape: CurveInterp; readonly label: string }[] = [
  { shape: "linear", label: "Linear" },
  { shape: "easeIn", label: "Ease in" },
  { shape: "easeOut", label: "Ease out" },
  { shape: "smooth", label: "S-curve" },
  { shape: "step", label: "Hold" },
];

const keyShape = (k: CurveKey): CurveInterp | undefined => (k.length >= 3 && k[2] !== "bezier" ? (k[2] as CurveInterp) : undefined);
const withShape = (x: number, y: number, shape: CurveInterp | undefined): CurveKey => (shape && shape !== "linear" ? [x, y, shape] : [x, y]);

/** "Add automation point": a key at `x` (y in the target's units), taking the previous key's shape. Returns its index. */
export function addPoint(s: SequenceSettings, o: AutomationOwner, id: string, x: number, y: number): EditResult<{ seq: SequenceSettings; index: number }> {
  const view = ownerOf(s, o);
  const a = view?.automation.find((l) => l.id === id);
  if (!view || !a) return refuse("that automation isn't there any more");
  if (a.curve.length >= MAX_KEYS) return refuse(`a curve holds at most ${MAX_KEYS} keys`);
  const spec = targetSpec(a.target, view.effects);
  const yy = spec ? clampSpec(spec, y) : y;
  const xx = tidy(Math.max(0, x));
  if (a.curve.some((k) => Math.abs(k[0] - xx) < 1e-6)) return refuse("there's a point there already");
  let index = a.curve.findIndex((k) => k[0] > xx);
  if (index < 0) index = a.curve.length;
  const prev = a.curve[index - 1];
  const curve = [...a.curve];
  curve.splice(index, 0, withShape(xx, yy, prev ? keyShape(prev) : undefined));
  const r = mapAutomation(s, o, id, (l) => ({ ...l, curve }));
  return "refused" in r ? r : accept({ seq: r.next, index });
}

const clampSpec = (spec: TargetSpec, y: number): number => (spec.bool ? (y >= (spec.min + spec.max) / 2 ? spec.max : spec.min) : Math.max(spec.min, Math.min(spec.max, y)));

/**
 * "Move automation point(s)": keys `indices` by `dx`, `dy`. Each moved key stays between its unmoved neighbours (and
 * at x ≥ 0); y stays in the target's range.
 */
export function movePoints(s: SequenceSettings, o: AutomationOwner, id: string, indices: readonly number[], dx: number, dy: number): R {
  const view = ownerOf(s, o);
  const a = view?.automation.find((l) => l.id === id);
  if (!view || !a) return refuse("that automation isn't there any more");
  const spec = targetSpec(a.target, view.effects);
  const sel = new Set(indices);
  const keys = a.curve;
  // The group's x move, limited so no moved key passes an unmoved neighbour.
  let d = dx;
  keys.forEach((k, i) => {
    if (!sel.has(i)) return;
    let lo = 0, hi = Infinity;
    for (let j = i - 1; j >= 0; j--) if (!sel.has(j)) { lo = keys[j]![0] + 1e-4; break; }
    for (let j = i + 1; j < keys.length; j++) if (!sel.has(j)) { hi = keys[j]![0] - 1e-4; break; }
    d = Math.max(lo - k[0], Math.min(hi - k[0], d));
  });
  const curve = keys.map((k, i) => {
    if (!sel.has(i)) return k;
    const x = tidy(k[0] + d), y = spec ? clampSpec(spec, k[1] + dy) : k[1] + dy;
    return k.length === 2 ? ([x, y] as CurveKey) : k[2] === "bezier" ? ([x, y, "bezier", (k as readonly [number, number, "bezier", never])[3]] as CurveKey) : ([x, y, k[2]] as CurveKey);
  });
  return mapAutomation(s, o, id, (l) => ({ ...l, curve }));
}

/** "Delete automation point(s)"; deleting every key removes the lane. */
export function deletePoints(s: SequenceSettings, o: AutomationOwner, id: string, indices: readonly number[]): R {
  return mapAutomation(s, o, id, (a) => {
    const curve = a.curve.filter((_, i) => !indices.includes(i));
    return curve.length ? { ...a, curve } : null;
  });
}

/** "Curve shape: X" for the segments starting at keys `indices`. */
export function setPointShape(s: SequenceSettings, o: AutomationOwner, id: string, indices: readonly number[], shape: CurveInterp): R {
  return mapAutomation(s, o, id, (a) => ({ ...a, curve: a.curve.map((k, i) => (indices.includes(i) ? withShape(k[0], k[1], shape) : k)) }));
}

/** The curve editor's result for one lane (or "Drive by X": a new input). */
export function setAutomation(s: SequenceSettings, o: AutomationOwner, id: string, patch: Partial<Pick<Automation, "curve" | "input" | "bypass" | "quantize">>): R {
  if (patch.curve && patch.curve.length === 0) return removeAutomation(s, o, id);
  return mapAutomation(s, o, id, (a) => {
    const next = { ...a, ...patch };
    // ADR 0350: quantize patched to undefined goes back to continuous (absent).
    if ("quantize" in patch && patch.quantize === undefined) delete next.quantize;
    return next;
  });
}

/** ADR 0350: the quantize choices a lane offers (its menu), and the value of each. */
export const QUANTIZE_CHOICES: readonly { readonly value: string; readonly label: string; readonly quantize: Automation["quantize"] }[] = [
  { value: "off", label: "Continuous", quantize: undefined },
  { value: "beat", label: "Next beat", quantize: "beat" },
  { value: "bar", label: "Next bar", quantize: "bar" },
  { value: "2", label: "Every 2 beats", quantize: { beats: 2 } },
  { value: "8", label: "Every 8 beats", quantize: { beats: 8 } },
];

/** The menu value of a lane's quantize (a beats count not in the menu reads as "n beats"). */
export const quantizeChoice = (q: Automation["quantize"]): string => (q === undefined ? "off" : typeof q === "string" ? q : String(q.beats));

/** "Remove automation". */
export const removeAutomation = (s: SequenceSettings, o: AutomationOwner, id: string): R => mapAutomation(s, o, id, () => null);

/**
 * "Paste curves" (proto: the Automate button's menu): each copied lane replaces this owner's lane of the same target,
 * or is added; a time curve reads this owner's time, a parameter curve keeps its parameter. Lanes of targets this owner
 * can't automate (another clip's effect) are skipped; refused when none fits.
 */
export function pasteCurves(s: SequenceSettings, o: AutomationOwner, lanes: readonly Automation[]): R {
  const view = ownerOf(s, o);
  if (!view) return refuse("that clip or track isn't there any more");
  const fits = lanes.filter((a) => targetSpec(a.target, view.effects));
  if (!fits.length) return refuse("those curves are for something this one doesn't have");
  return accept(setOwnerAutomation(s, o, (list) => {
    const out = [...list];
    for (const a of fits) {
      const input = isTimeInput(a.input) ? view.timeInput : a.input;
      const i = out.findIndex((x) => x.target === a.target);
      if (i >= 0) out[i] = { ...out[i]!, input, curve: a.curve.map((k) => [...k] as CurveKey), bypass: a.bypass };
      else if (out.length < MAX_AUTOMATION) out.push({ ...a, id: nextId("a", out.map((x) => x.id)), input, curve: a.curve.map((k) => [...k] as CurveKey) });
    }
    return out;
  }));
}

/**
 * A lane's "Driven by" (proto A5): the timeline or a game parameter. Changing it reseeds the curve flat at the target's
 * plain value over the new axis (`[from, to]`: the clip's or sequence's length, or the parameter's range).
 */
export function setDrivenBy(s: SequenceSettings, o: AutomationOwner, id: string, input: CurveInput, from: number, to: number): R {
  const view = ownerOf(s, o);
  const a = view?.automation.find((x) => x.id === id);
  if (!view || !a) return refuse("that automation isn't there any more");
  const spec = targetSpec(a.target, view.effects);
  const base = spec?.base ?? a.curve[0]?.[1] ?? 0;
  const next = isTimeInput(input) ? view.timeInput : input;
  return mapAutomation(s, o, id, (x) => ({ ...x, input: next, curve: [[tidy(from), base], [tidy(Math.max(from + 0.01, to)), base]] }));
}

/** Touch writing keeps a key every this many seconds (proto: the control writes every 60 ms while held). */
export const WRITE_INTERVAL = 0.06;

/**
 * "Write X automation" (touch mode): `samples` ([time, value], in the order recorded) replace the keys of `target`'s
 * time lane over the range they cover; a key just outside each end holds the curve's old value there, so what was
 * before and after stays. Creates the lane when there is none. A parameter-driven lane is never overwritten.
 */
export function writeAutomation(s: SequenceSettings, o: AutomationOwner, target: Automation["target"], samples: readonly (readonly [number, number])[]): EditResult<{ seq: SequenceSettings; id: string }> {
  const view = ownerOf(s, o);
  if (!view) return refuse("that clip or track isn't there any more");
  if (!samples.length) return refuse("nothing was written");
  const spec = targetSpec(target, view.effects);
  if (!spec) return refuse(`"${target}" can't be automated here`);
  const existing = view.automation.find((a) => a.target === target);
  if (existing && !isTimeInput(existing.input)) return refuse("it is driven by a parameter; parameter curves are never overwritten");
  const sorted = [...samples].map(([t, v]) => [tidy(Math.max(0, t)), clampSpec(spec, v)] as const).sort((a, b) => a[0] - b[0]);
  const t0 = sorted[0]![0], t1 = sorted[sorted.length - 1]![0];
  // Thin to one key per interval, keeping the last.
  const thin: CurveKey[] = [];
  for (const [t, v] of sorted) if (!thin.length || t - thin[thin.length - 1]![0] >= WRITE_INTERVAL - 1e-9) thin.push([t, v]);
  if (thin[thin.length - 1]![0] !== t1) thin.push([t1, sorted[sorted.length - 1]![1]]);
  const old = existing?.curve ?? [];
  const before = old.filter((k) => k[0] < t0 - 1e-9);
  const after = old.filter((k) => k[0] > t1 + 1e-9);
  const keys: CurveKey[] = [...before];
  if (old.length && before.length && !after.length && t0 > before[before.length - 1]![0] + WRITE_INTERVAL) keys.push([tidy(t0 - 1e-3), evalCurve(old, t0)]);
  keys.push(...thin);
  if (old.length && after.length) keys.push([tidy(t1 + 1e-3), evalCurve(old, t1 + 1e-3)]);
  keys.push(...after);
  const curve = keys.slice(0, MAX_KEYS);
  if (existing) {
    const r = mapAutomation(s, o, existing.id, (a) => ({ ...a, curve }));
    return "refused" in r ? r : accept({ seq: r.next, id: existing.id });
  }
  if (view.automation.length >= MAX_AUTOMATION) return refuse(`at most ${MAX_AUTOMATION} automation lanes`);
  const id = nextId("a", view.automation.map((a) => a.id));
  return accept({ seq: setOwnerAutomation(s, o, (list) => [...list, { id, target, input: view.timeInput, curve, bypass: false }]), id });
}
