// What the Mixer's panels read off the mix and the running runtime (ADR 0344 "Gain", ADR 0171 loudness; the
// prototype's Gain lanes, Loudness and live board): automation values at the test parameters, the gain lane inputs
// (authored values, with the runtime's public `Bus` readings when it runs), meter readings, loudness readouts, and the
// live board's pins (a per-user preference, at most 8). Pure.
import { evalCurve } from "../../../engine/core/curve";
import { isLabelled, type ParameterDef } from "../../../engine/audio/parameters";
import type { AudioProject, MixAutomation } from "../../../engine/audio/project/types";
import type { GainInputs, LiveLanes } from "../../components/gainLanesModel";
import { effectParamSpec, effectSpec } from "../../../engine/audio/effects/catalogue";
import type { EffectType } from "../../../engine/audio/effects/types";
import { resolveSnapshots, startHolds, testValueOf, type TestValues } from "./snapshotBlend";
import { editedSnapshot } from "./mixEdits";

// --- automation at the test values ---------------------------------------------------------------------------------------

/** A lane's value at the test value of its parameter (dB for volume and sends; the parameter's units for fx). */
export function automationValue(a: Pick<MixAutomation, "parameter" | "curve">, params: readonly ParameterDef[], values: TestValues): number | null {
  const def = params.find((p) => p.name === a.parameter);
  if (!def || a.curve.length === 0) return null;
  return evalCurve(a.curve, testValueOf(def, values));
}

/** The summed level automation on `name` at the test values, dB (bypassed lanes left out). */
export function levelAutomationDb(p: Pick<AudioProject, "automation" | "parameters">, name: string, values: TestValues): number {
  let db = 0;
  for (const a of p.automation) if (!a.bypass && a.on === name && a.target === "volume") db += automationValue(a, p.parameters, values) ?? 0;
  return db;
}

const round = (v: number, places = 1) => Math.round(v * 10 ** places) / 10 ** places;

/** `EffectChain`'s `automated`: effect id → parameter → "800 Hz", for the effects of `name` with live lanes. */
export function automatedParams(p: AudioProject, name: string, values: TestValues): Record<string, Record<string, string>> {
  const owner = p.buses.find((b) => b.name === name) ?? p.returns.find((r) => r.name === name);
  const out: Record<string, Record<string, string>> = {};
  for (const a of p.automation) {
    if (a.bypass || a.on !== name || !a.target.startsWith("fx:")) continue;
    const [, id, param] = a.target.split(":") as [string, string, string];
    const effect = owner?.effects.find((e) => e.id === id);
    const v = automationValue(a, p.parameters, values);
    const unit = effect ? (effectParamSpec(effect.type, param)?.unit ?? "") : "";
    (out[id] ??= {})[param] = v === null ? "—" : `${round(v, 2)}${unit ? ` ${unit}` : ""}`;
  }
  return out;
}

/** The send level text when its lane is live ("-14 dB"), else undefined. */
export function automatedSend(p: AudioProject, name: string, to: string, values: TestValues): string | undefined {
  const a = p.automation.find((x) => !x.bypass && x.on === name && x.target === `send:${to}`);
  if (!a) return undefined;
  const v = automationValue(a, p.parameters, values);
  return v === null ? "—" : `${round(v)} dB`;
}

// --- gain lanes ----------------------------------------------------------------------------------------------------------

/** The runtime's public reading of a bus (`Audio.bus(name)`), as far as the lanes use it. */
export interface BusReading {
  /** `Bus.volume`: the runtime multiplier scripts set, linear. */
  readonly volume: number;
  /** `Bus.duckGain`, linear 0..1. */
  readonly duckGain: number;
  /** `Bus.peak`, linear. */
  readonly peak: number;
  readonly activeVoices: number;
}

const toDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/**
 * The gain lanes' inputs for the mix as edited (`editing` is the snapshot whose offsets show), the soloed bus, and the
 * runtime's readings by bus when it runs (runtime and duck lanes; automation from the test values either way).
 */
export function gainInputs(p: AudioProject, editing: string | null, solo: string | null, values: TestValues, readings?: (name: string) => BusReading | null): GainInputs {
  const live: Record<string, LiveLanes> = {};
  for (const owner of [...p.buses, ...p.returns]) {
    const lanes: LiveLanes = {};
    const auto = levelAutomationDb(p, owner.name, values);
    if (auto !== 0) lanes.automation = auto;
    const r = readings?.(owner.name);
    if (r) {
      const rt = toDb(r.volume);
      if (rt !== 0) lanes.runtime = rt;
      const duck = toDb(r.duckGain);
      if (duck !== 0) lanes.duck = duck;
    }
    if (Object.keys(lanes).length > 0) live[owner.name] = lanes;
  }
  return { buses: p.buses, returns: p.returns, vcas: p.vcas, snapshot: snapshotLane(p, editing, values), solo, live, master: p.buses[0]?.name };
}

/**
 * The snapshot lane's offsets: the snapshot being edited (what you hear while you edit it), else the blend of the
 * snapshots on with the test values (base mixes and matching conditions, in list order as their start order, by
 * ADR 0344's rules), named after them ("Gameplay + Underwater"); null when none is on.
 */
export function snapshotLane(p: AudioProject, editing: string | null, values: TestValues): { name: string; buses: Record<string, number> } | null {
  const snap = editedSnapshot(p, editing);
  if (snap) return { name: snap.name, buses: snap.buses };
  const on = p.snapshots.filter((s) => startHolds(s.start, p.parameters, values));
  if (on.length === 0) return null;
  const { levels } = resolveSnapshots(on.map((snapshot) => ({ snapshot })));
  return { name: on.map((s) => s.name).join(" + "), buses: { ...levels } };
}

/** A meter's peak in dBFS from a reading (null while silent or not running). */
export const peakDb = (r: BusReading | null | undefined): number | null => (r && r.peak > 0 ? 20 * Math.log10(r.peak) : null);

// --- loudness ------------------------------------------------------------------------------------------------------------

/** The readings the Loudness panel shows (`Bus.loudness`). */
export interface LoudnessReading {
  readonly momentary: number;
  readonly shortTerm: number;
  readonly integrated: number;
  readonly lra: number;
  readonly maxTruePeak: number;
  readonly tainted: boolean;
}

export interface LoudnessRow {
  readonly key: "momentary" | "shortTerm" | "integrated" | "lra" | "truePeak";
  readonly label: string;
  /** The value with its unit ("-16.4 LUFS"), or "—". */
  readonly text: string;
  /** Over the target's ceiling or outside its tolerance. */
  readonly warn: string | null;
  /** The tile's big figure ("−16.4", "—"), with a true minus. */
  readonly value: string;
  /** The tile's last line: its unit, or its verdict against the target ("Warning · 7.6 LU over −24", "On target (−16)"). */
  readonly note: string;
  /** How the verdict reads: a warning, on target, or none (no target or no reading, or a row with no verdict). */
  readonly verdict: "warn" | "ok" | null;
}

const lufs = (v: number, unit: string) => (Number.isFinite(v) ? `${round(v)} ${unit}` : "—");
const minus = (v: number) => (v < 0 ? `−${Math.abs(v)}` : String(v));

/** The five readouts (M, S, I, LRA, TP), "—" without a reading; warnings and verdicts against `target`. */
export function loudnessRows(r: LoudnessReading | null, target: { integrated: number; tolerance: number; truePeak: number } | null): LoudnessRow[] {
  const v = (x: number | undefined) => (r && x !== undefined ? x : -Infinity);
  const i = v(r?.integrated), tp = v(r?.maxTruePeak);
  const off = target && Number.isFinite(i) ? round(Math.abs(i - target.integrated)) : null;
  const iWarn = target && off !== null && Math.abs(i - target.integrated) > target.tolerance ? `${i > target.integrated ? "Over" : "Under"} the ${target.integrated} LUFS target by ${off} LU` : null;
  const tpWarn = target && Number.isFinite(tp) && tp > target.truePeak ? `Over ${target.truePeak} dBTP` : null;
  const row = (key: LoudnessRow["key"], label: string, x: number, unit: string, warn: string | null = null, verdict: { note: string; verdict: "warn" | "ok" } | null = null): LoudnessRow => ({
    key, label, text: lufs(x, unit), warn, value: Number.isFinite(x) ? minus(round(x)) : "—", note: verdict?.note ?? unit, verdict: verdict?.verdict ?? null,
  });
  const iVerdict = target && off !== null ? (iWarn ? { note: `Warning · ${off} LU ${i > target.integrated ? "over" : "under"} ${minus(target.integrated)}`, verdict: "warn" as const } : { note: `On target (${minus(target.integrated)})`, verdict: "ok" as const }) : null;
  const tpVerdict = tpWarn && target ? { note: `Warning · over ${minus(target.truePeak)} dBTP`, verdict: "warn" as const } : null;
  return [
    row("momentary", "Momentary", v(r?.momentary), "LUFS"),
    row("shortTerm", "Short-term", v(r?.shortTerm), "LUFS"),
    row("integrated", "Integrated", i, "LUFS", iWarn, iVerdict),
    row("lra", "Range", v(r?.lra), "LU"),
    row("truePeak", "True peak", tp, "dBTP", tpWarn, tpVerdict),
  ];
}

/** The default targets' names as the spec words them (§4.3.6); a project's own target shows its name. */
const TARGET_LABELS: Readonly<Record<string, string>> = { console: "Console", "pc-web": "PC / web", mobile: "Mobile" };
const signed = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v)}`;

/** A loudness target as the Platform target picker lists it: "Console · −24 LUFS, −1 dBTP". */
export function targetOptionText(t: { name: string; integrated: number; truePeak: number }): string {
  return `${TARGET_LABELS[t.name] ?? t.name} · ${signed(t.integrated)} LUFS, ${signed(t.truePeak)} dBTP`;
}

// --- live board pins -----------------------------------------------------------------------------------------------------

/** At most this many pinned buses (ADR 0344). */
export const MAX_PINS = 8;

/** The pins that still name a bus or return, in order, at most `MAX_PINS`. */
export const livePins = (pins: readonly string[], p: Pick<AudioProject, "buses" | "returns">): string[] =>
  pins.filter((n, i) => pins.indexOf(n) === i && (p.buses.some((b) => b.name === n) || p.returns.some((r) => r.name === n))).slice(0, MAX_PINS);

/** `name` pinned or unpinned; refused (null) when pinning a ninth. */
export function togglePin(pins: readonly string[], name: string): string[] | null {
  if (pins.includes(name)) return pins.filter((n) => n !== name);
  if (pins.length >= MAX_PINS) return null;
  return [...pins, name];
}

/** The default pins (the prototype's), kept to those the mix has. */
export const DEFAULT_PINS: readonly string[] = ["Music", "Dialogue", "SFX", "Ambience"];

// --- the curve editor's lanes --------------------------------------------------------------------------------------------

const effectParams = (type: EffectType) => effectSpec(type).params.filter((q) => !q.bool);

/** One automatable property of a bus or return: a lane of the curve editor (`automationCurves.ts`). */
export interface AutomatableLane {
  readonly target: MixAutomation["target"];
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  /** A typed value's step (and its shown precision). */
  readonly step: number;
  readonly scale: "linear" | "log";
  readonly plain: number;
  readonly current: { readonly parameter: string; readonly curve: MixAutomation["curve"]; readonly bypass: boolean } | null;
}

/**
 * The automatable properties of `name` (ADR 0344 targets): its level, each send, each effect parameter. `only` keeps
 * the ones the button asked for: "volume", "send:<return>", or "fx:<id>" (every parameter of that effect).
 */
export function automatableLanes(p: AudioProject, name: string, only?: string): AutomatableLane[] {
  const bus = p.buses.find((b) => b.name === name);
  const owner = bus ?? p.returns.find((r) => r.name === name);
  if (!owner) return [];
  const current = (target: string) => {
    const a = p.automation.find((x) => x.on === name && x.target === target);
    return a ? { parameter: a.parameter, curve: a.curve, bypass: a.bypass } : null;
  };
  const out: AutomatableLane[] = [{ target: "volume", label: "Level", min: -60, max: 6, unit: "dB", step: 0.5, scale: "linear", plain: 0, current: current("volume") }];
  for (const s of bus?.sends ?? []) out.push({ target: `send:${s.to}`, label: `Send to ${s.to}`, min: -60, max: 6, unit: "dB", step: 0.5, scale: "linear", plain: 0, current: current(`send:${s.to}`) });
  for (const e of owner.effects) {
    // "Low-pass cutoff"; with two effects of a type on one bus, their ids tell them apart ("Low-pass (fx2) cutoff").
    const spec = effectSpec(e.type);
    const twin = owner.effects.some((o) => o !== e && o.type === e.type);
    for (const q of effectParams(e.type)) {
      const target = `fx:${e.id}:${q.name}` as const;
      out.push({ target, label: `${spec.label}${twin ? ` (${e.id})` : ""} ${q.label.toLowerCase()}`, min: q.min, max: q.max, unit: q.unit, step: q.step, scale: q.scale, plain: e.params[q.name] ?? q.default, current: current(target) });
    }
  }
  if (only === undefined) return out;
  return out.filter((l) => l.target === only || (only.startsWith("fx:") && l.target.startsWith(`${only}:`)));
}

/** A parameter's display unit-free range text ("0..1", "Off, On"), for the condition rows. */
export const parameterNote = (def: ParameterDef): string => (isLabelled(def) ? def.labels.join(", ") : `${def.min}..${def.max}`);
