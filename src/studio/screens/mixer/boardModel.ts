// What the Mixer's panels read off the mix and the running runtime (ADR 0330 "Gain", ADR 0171 loudness; the
// prototype's Gain lanes, Loudness and live board): automation values at the test parameters, the gain lane inputs
// (authored values, with the runtime's public `Bus` readings when it runs), meter readings, loudness readouts, and the
// live board's pins (a per-user preference, at most 8). Pure.
import { evalCurve } from "../../../engine/core/curve";
import { isLabelled, type ParameterDef } from "../../../engine/audio/eventFormat";
import type { AudioProject, MixAutomation } from "../../../engine/audio/project/types";
import type { GainInputs, LiveLanes } from "../../components/gainLanesModel";
import { effectParamSpec } from "../../../engine/audio/effects/catalogue";
import { testValueOf, type TestValues } from "./snapshotBlend";
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

/** `EffectChain`'s `automated`: effect id → parameter → "auto · 800 Hz", for the effects of `name` with live lanes. */
export function automatedParams(p: AudioProject, name: string, values: TestValues): Record<string, Record<string, string>> {
  const owner = p.buses.find((b) => b.name === name) ?? p.returns.find((r) => r.name === name);
  const out: Record<string, Record<string, string>> = {};
  for (const a of p.automation) {
    if (a.bypass || a.on !== name || !a.target.startsWith("fx:")) continue;
    const [, id, param] = a.target.split(":") as [string, string, string];
    const effect = owner?.effects.find((e) => e.id === id);
    const v = automationValue(a, p.parameters, values);
    const unit = effect ? (effectParamSpec(effect.type, param)?.unit ?? "") : "";
    (out[id] ??= {})[param] = `auto · ${v === null ? "—" : `${round(v, 2)}${unit ? ` ${unit}` : ""}`}`;
  }
  return out;
}

/** The send level text when its lane is live ("auto · −14.0 dB"), else undefined. */
export function automatedSend(p: AudioProject, name: string, to: string, values: TestValues): string | undefined {
  const a = p.automation.find((x) => !x.bypass && x.on === name && x.target === `send:${to}`);
  if (!a) return undefined;
  const v = automationValue(a, p.parameters, values);
  return `auto · ${v === null ? "—" : `${round(v)} dB`}`;
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
  const snap = editedSnapshot(p, editing);
  return { buses: p.buses, returns: p.returns, vcas: p.vcas, snapshot: snap ? { name: snap.name, buses: snap.buses } : null, solo, live, master: p.buses[0]?.name };
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
  readonly text: string;
  /** Over the target's ceiling or outside its tolerance. */
  readonly warn: string | null;
}

const lufs = (v: number, unit: string) => (Number.isFinite(v) ? `${round(v)} ${unit}` : "—");

/** The five readouts (M, S, I, LRA, TP), "—" without a reading; warnings against `target`. */
export function loudnessRows(r: LoudnessReading | null, target: { integrated: number; tolerance: number; truePeak: number } | null): LoudnessRow[] {
  const v = (x: number | undefined) => (r && x !== undefined ? x : -Infinity);
  const i = v(r?.integrated), tp = v(r?.maxTruePeak);
  const iWarn = target && Number.isFinite(i) && Math.abs(i - target.integrated) > target.tolerance ? `${i > target.integrated ? "Over" : "Under"} the ${target.integrated} LUFS target by ${round(Math.abs(i - target.integrated))} LU` : null;
  const tpWarn = target && Number.isFinite(tp) && tp > target.truePeak ? `Over ${target.truePeak} dBTP` : null;
  return [
    { key: "momentary", label: "Momentary", text: lufs(v(r?.momentary), "LUFS"), warn: null },
    { key: "shortTerm", label: "Short-term", text: lufs(v(r?.shortTerm), "LUFS"), warn: null },
    { key: "integrated", label: "Integrated", text: lufs(i, "LUFS"), warn: iWarn },
    { key: "lra", label: "Range", text: lufs(v(r?.lra), "LU"), warn: null },
    { key: "truePeak", label: "True peak", text: lufs(tp, "dBTP"), warn: tpWarn },
  ];
}

// --- live board pins -----------------------------------------------------------------------------------------------------

/** At most this many pinned buses (ADR 0330). */
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

/** A parameter's display unit-free range text ("0..1", "Off, On"), for the condition rows. */
export const parameterNote = (def: ParameterDef): string => (isLabelled(def) ? def.labels.join(", ") : `${def.min}..${def.max}`);
