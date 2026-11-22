// The Project panel's Audio section (ADR 0097): the settings draft's `audio` key (since ADR 0330 the old section shape of `audio.json`, which the draft's saves merge into, decision D2),
// edited by pure functions like navigation and graphics. Edits start from the leniently parsed section and
// write the whole section back, so the rest of the panel's undo/save machinery works unchanged. A scalar key has no
// setter here: the view sets it by path on the section handle (`audioSettings.set(d, "zones.standby", n)`), which stores
// what the parse makes of it (ADR 0306). The functions below are the edits with rules of their own; each one a user can
// get refused returns the refused-or-next `EditResult` (ADR 0307, 0313), which the section applies with `applyToSettings`.
import {
  busBed,
  busBedPriority,
  type BusBed,
  EFFECT_TYPES,
  LOUDNESS_TARGET_LIMITS,
  MAX_LOUDNESS_BUSES,
  MAX_TARGET_NAME,
  MASTER,
  MUSIC_RINGS_PRESETS,
  MAX_BUSES,
  parseAudioSettings,
  type AudioSettings,
  type BusAutomation,
  type BusEffect,
  type BusSettings,
  type DuckingRule,
  type LoudnessTarget,
  type EffectType,
} from "../../../engine/audio/settings";
import { BUILTIN_MATERIALS, DEFAULT_MATERIAL_NAME, MATERIAL_LIMITS, MAX_MATERIALS, type OccluderMaterial } from "../../../engine/audio/occlusionMaterials";
import { sameMaterial } from "../../../engine/audio/audioSection";
import { audioSettings } from "./audioDraft";
import { RUNTIME_SETTINGS } from "../../../engine/core/settings";
import { resolveBeds } from "../runtime/core/beds";
import type { Curve } from "../../../engine/core/curve";
import { MAX_CURVE_KEYS, MAX_PARAMETERS, parameterRange, type ParameterDef } from "../../../engine/audio/eventFormat";
import type { SettingsDraft } from "../../../editor/sdk";
import { duckRefusal, newDuckRule, ruleWithField } from "./mix/duckModel";
import { applyOpToDraft, loudnessTargetsOf, MAX_LOUDNESS_TARGETS, opRefusal, type MixOp } from "../../../engine/audio/mixOps";
import { uniqueName } from "../../../engine/core/uniqueName";
import { accept, refuse, type EditResult } from "./editResult";
import { parameterList } from "./parameterList";

export { EFFECT_TYPES, MAX_BUSES };


/** Buses in tree order (each bus after its parent), with their depth, for an indented list. */
export function busTree(a: AudioSettings): { bus: BusSettings; depth: number }[] {
  const out: { bus: BusSettings; depth: number }[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const bus of a.buses) if ((bus.parent ?? undefined) === parent && !(parent === undefined && bus !== a.buses[0])) { out.push({ bus, depth }); walk(bus.name, depth + 1); }
  };
  walk(undefined, 0);
  return out;
}

/** A bus's descendants, by name. */
export function descendants(a: AudioSettings, name: string): string[] {
  const out: string[] = [];
  for (const b of a.buses) if (b.parent === name) out.push(b.name, ...descendants(a, b.name));
  return out;
}

// --- live mix edits (ADR 0171 §6.2, task Mo1) -------------------------------------------------------------------------
// Every function in this block builds a `MixOp` and returns it as a refused-or-next result (`mixEdit`, ADR 0307, 0313):
// refused with the op's refusal (`opRefusal`, the parse's own rule), else the draft `applyOpToDraft`
// (`src/engine/audio/mixOps.ts`) makes, so the Project Settings UI and a live op edit the settings the same way and
// `audioEdit` can register `{ ops, inverse }`. The per-bus core and bed keys (`setBusMaxVoices`, `setBusBed`,
// `setBusBedPriority`) and the automation functions further down go through ops too.

/** One op as a refused-or-next result: refused with the op's refusal, else the draft it gives. */
export function mixEdit(d: SettingsDraft, op: MixOp): EditResult<SettingsDraft> {
  const refusal = opRefusal(audioSettings.read(d), op);
  return refusal ? refuse(refusal) : accept(applyOpToDraft(d, op));
}

/** Append a bus "Bus" (unique: "Bus 2"…) under `parent` (an unknown parent: the root). Refused past the bus count rule (`busCapability.ts`, ADR 0175). */
export function addBus(d: SettingsDraft, parent = MASTER): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const p = a.buses.some((b) => b.name === parent) ? parent : a.buses[0].name;
  return mixEdit(d, { op: "addBus", name: uniqueName("Bus", a.buses.map((b) => b.name)), parent: p });
}

/** Remove a bus and everything under it, and the snapshot entries and ducking rules that named them. The root is refused. */
export const removeBus = (d: SettingsDraft, name: string): EditResult<SettingsDraft> => mixEdit(d, { op: "removeBus", bus: name });

/**
 * Rename a bus everywhere it's named in the section (the scenes and events that name it follow through `audioNames.ts`,
 * ADR 0262). Trimmed; an empty or taken name is refused; the same name is no change.
 */
export const renameBus = (d: SettingsDraft, from: string, to: string): EditResult<SettingsDraft> =>
  to.trim() === from && audioSettings.read(d).buses.some((b) => b.name === from) ? accept(d) : mixEdit(d, { op: "renameBus", from, to });

/** Move a bus under another (not itself or its own descendant; the root has no parent). */
export const setBusParent = (d: SettingsDraft, name: string, parent: string): EditResult<SettingsDraft> => mixEdit(d, { op: "moveBus", bus: name, parent });

export const setBusValue = (d: SettingsDraft, name: string, key: "volume" | "mute", value: number | boolean): EditResult<SettingsDraft> =>
  mixEdit(d, { op: "setBus", bus: name, key, value });

/** ADR 0171 §2.1: meter a bus's loudness, or stop. Refused on the root (always metered) and past `MAX_LOUDNESS_BUSES`. */
export const setBusMeter = (d: SettingsDraft, name: string, on: boolean): EditResult<SettingsDraft> =>
  mixEdit(d, { op: "setBus", bus: name, key: "meter", value: on ? "loudness" : null });

export const defaultEffect = (type: EffectType): BusEffect => parseAudioSettings({ buses: [{ name: "x", effects: [{ type }] }] }).settings.buses[0].effects[0];

/** Append an effect with its defaults (an unknown bus is refused). */
export function addEffect(d: SettingsDraft, bus: string, type: EffectType): EditResult<SettingsDraft> {
  const b = audioSettings.read(d).buses.find((x) => x.name === bus);
  return mixEdit(d, { op: "addEffect", bus, index: b?.effects.length ?? 0, effect: defaultEffect(type) });
}
export const removeEffect = (d: SettingsDraft, bus: string, index: number): EditResult<SettingsDraft> => mixEdit(d, { op: "removeEffect", bus, index });
/** Move the effect at `from` to `to` in the bus's chain. */
export const moveEffect = (d: SettingsDraft, bus: string, from: number, to: number): EditResult<SettingsDraft> => mixEdit(d, { op: "moveEffect", bus, from, to });
/** Set one numeric field of an effect (a key the effect doesn't have is refused). */
export const setEffectValue = (d: SettingsDraft, bus: string, index: number, key: string, value: number): EditResult<SettingsDraft> =>
  mixEdit(d, { op: "setEffect", bus, index, key, value });

// --- snapshots and ducking ------------------------------------------------------------------------

/** Append a snapshot named "Snapshot" (unique: "Snapshot 2"…). */
export const addSnapshot = (d: SettingsDraft): EditResult<SettingsDraft> => mixEdit(d, { op: "addSnapshot", index: audioSettings.read(d).snapshots.length });
export const removeSnapshot = (d: SettingsDraft, index: number): EditResult<SettingsDraft> => mixEdit(d, { op: "removeSnapshot", index });
/** Trimmed; an empty or taken name is refused; the same name is no change. */
export const renameSnapshot = (d: SettingsDraft, index: number, to: string): EditResult<SettingsDraft> =>
  audioSettings.read(d).snapshots[index]?.name === to.trim() ? accept(d) : mixEdit(d, { op: "renameSnapshot", index, name: to });
/** Set a bus's multiplier in a snapshot (undefined: unlisted, so 1). */
export const setSnapshotVolume = (d: SettingsDraft, index: number, bus: string, value: number | undefined): EditResult<SettingsDraft> =>
  mixEdit(d, { op: "setSnapshot", index, bus, key: "volume", value: value ?? null });
export const setSnapshotLowpass = (d: SettingsDraft, index: number, bus: string, hz: number | undefined): EditResult<SettingsDraft> =>
  mixEdit(d, { op: "setSnapshot", index, bus, key: "lowpass", value: hz ?? null });

/**
 * Append a rule: a **level** rule with an RMS detector at -30 dBFS (ADR 0172 owner decision 8), on the first pair of buses
 * the parse keeps (Music ducked by Voice when both exist). Refused, with the parse's message, at the 33rd rule, the 9th
 * level rule, or when no pair of buses can form a rule.
 */
export function addDucking(d: SettingsDraft): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const names = a.buses.map((b) => b.name);
  const pairs: [string, string][] = [];
  if (names.includes("Music") && names.includes("Voice")) pairs.push(["Music", "Voice"]);
  for (const target of names) for (const trigger of names) if (target !== trigger) pairs.push([target, trigger]);
  let first: string | null = null;
  for (const [target, trigger] of pairs) {
    const rule = newDuckRule(target, trigger);
    const refusal = duckRefusal(a, [...a.ducking, rule]);
    if (refusal === null) return accept(applyOpToDraft(d, { op: "setDucking", index: a.ducking.length, rule, insert: true }));
    first ??= refusal;
  }
  return refuse(first ?? "A ducking rule needs two buses.");
}
export const removeDucking = (d: SettingsDraft, index: number): EditResult<SettingsDraft> => mixEdit(d, { op: "setDucking", index, rule: null });

/**
 * Set one field of a rule (`duckModel.ruleWithField`: numbers clamped, `mode` adds or drops `detector` and `threshold`).
 * Refused, with the parse's message, when the rule would be dropped: a bus ducking itself, a trigger above its target, a
 * level cycle (naming the rules), the 9th level rule.
 */
export function setDuckingValue(d: SettingsDraft, index: number, key: keyof DuckingRule, value: string | number): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const old = a.ducking[index];
  if (!old) return refuse(`No ducking rule ${index + 1}.`);
  const rule = ruleWithField(old, key, value);
  const refusal = duckRefusal(a, a.ducking.map((r, i) => (i === index ? rule : r)));
  return refusal ? refuse(refusal) : accept(applyOpToDraft(d, { op: "setDucking", index, rule }));
}

/**
 * Swap a rule with its neighbour up (`delta` -1) or down (+1) the list; past the ends is refused. The order is the index
 * the messages and the core's rule table use.
 */
export function moveDucking(d: SettingsDraft, index: number, delta: number): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const other = index + delta;
  if (!a.ducking[index]) return refuse(`No ducking rule ${index + 1}.`);
  if (!a.ducking[other] || Math.abs(delta) !== 1) return refuse("The rule is already at that end of the list.");
  const swapped = a.ducking.map((r, i) => (i === index ? a.ducking[other]! : i === other ? a.ducking[index]! : r));
  const refusal = duckRefusal(a, swapped);
  if (refusal !== null) return refuse(refusal);
  return accept(applyOpToDraft(applyOpToDraft(d, { op: "setDucking", index, rule: swapped[index]! }), { op: "setDucking", index: other, rule: swapped[other]! }));
}

// --- ADR 0171 §2.1: loudness targets and the reset option -------------------------------------------------------------

export { MAX_LOUDNESS_TARGETS };
/** The project's loudness targets, the default list when unset; the first is the default target. */
export const loudnessTargets = (a: AudioSettings): LoudnessTarget[] => loudnessTargetsOf(a);
/** Append a target "Target" (unique: "Target 2"…) with the first target's numbers. Refused at `MAX_LOUDNESS_TARGETS`. */
export function addLoudnessTarget(d: SettingsDraft): EditResult<SettingsDraft> {
  const list = loudnessTargetsOf(audioSettings.read(d));
  const name = uniqueName("Target", list.map((t) => t.name));
  return mixEdit(d, { op: "setTarget", index: list.length, target: { ...list[0], name }, insert: true });
}
/** Remove the target at `index` (the last one stays: refused). */
export const removeLoudnessTarget = (d: SettingsDraft, index: number): EditResult<SettingsDraft> => mixEdit(d, { op: "setTarget", index, target: null });
/** Edit a target's fields; a name that's empty, too long or taken, or a number out of range, is refused with the parse's message. */
export function setLoudnessTarget(d: SettingsDraft, index: number, patch: Partial<LoudnessTarget>): EditResult<SettingsDraft> {
  const old = loudnessTargetsOf(audioSettings.read(d))[index];
  if (!old) return refuse(`No loudness target ${index + 1}.`);
  const target = { ...old, ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) };
  return mixEdit(d, { op: "setTarget", index, target });
}
export { LOUDNESS_TARGET_LIMITS, MAX_LOUDNESS_BUSES, MAX_TARGET_NAME };
/** Is the bus metered? The root always is. */
export const isBusMetered = (a: AudioSettings, name: string): boolean => a.buses[0]?.name === name || a.buses.find((b) => b.name === name)?.meter !== undefined;
/** `loudnessResetOnPlay`: reset the meters when the editor's Play starts (default on). */
export const setLoudnessResetOnPlay = (d: SettingsDraft, on: boolean): EditResult<SettingsDraft> => mixEdit(d, { op: "setOption", key: "loudnessResetOnPlay", value: on });

// --- §2 core keys (ADR 0157, K13) -------------------------------------------------------------------

/** A bus's `maxVoices`: rounded and clamped to 1..`voices.logical`; `undefined` is unlimited. Unknown buses change nothing. */
export function setBusMaxVoices(d: SettingsDraft, name: string, value: number | undefined): EditResult<SettingsDraft> {
  return mixEdit(d, { op: "setBus", bus: name, key: "maxVoices", value: value === undefined || !Number.isFinite(value) ? null : value });
}

/** Named bundles of the voice numbers and the clip ceiling (architecture 5.3); the file stores the numbers. "low" is provisional until the low-end soak (C3) sizes it. */
export const VOICE_PRESETS = {
  low: { voices: { mixed: 64, logical: 1024, hrtf: 4 }, clipMemoryMB: 64, maxBeds: 0, maxClips: 1, musicRings: MUSIC_RINGS_PRESETS.low },
  default: { voices: { mixed: 128, logical: 4096, hrtf: 8 }, clipMemoryMB: undefined, maxBeds: 2, maxClips: 1, musicRings: MUSIC_RINGS_PRESETS.default },
  high: { voices: { mixed: 256, logical: 4096, hrtf: 8 }, clipMemoryMB: 256, maxBeds: 4, maxClips: 2, musicRings: MUSIC_RINGS_PRESETS.high },
} as const;
export type VoicePresetName = keyof typeof VOICE_PRESETS;
export const VOICE_PRESET_NAMES = Object.keys(VOICE_PRESETS) as VoicePresetName[];

/** The preset the section's numbers match exactly, or "custom". */
export function voicesPreset(a: AudioSettings): VoicePresetName | "custom" {
  for (const name of VOICE_PRESET_NAMES) {
    const p = VOICE_PRESETS[name];
    if (p.voices.mixed === a.voices.mixed && p.voices.logical === a.voices.logical && p.voices.hrtf === a.voices.hrtf && p.clipMemoryMB === a.clipMemoryMB && p.maxBeds === a.bed.maxBeds && p.maxClips === a.ambisonic.maxClips && p.musicRings === a.music.rings) return name;
  }
  return "custom";
}

/**
 * Apply a preset: voices, the clip ceiling (the default preset leaves it unset), `bed.maxBeds`, `ambisonic.maxClips` and
 * `music.rings`. Per-bus limits are kept, clamped to `logical` by the parse.
 */
export function applyVoicesPreset(d: SettingsDraft, name: VoicePresetName): SettingsDraft {
  const p = VOICE_PRESETS[name];
  const values: [string, unknown][] = [["voices", { ...p.voices }], ["clipMemoryMB", p.clipMemoryMB], ["bed.maxBeds", p.maxBeds], ["ambisonic.maxClips", p.maxClips], ["music.rings", p.musicRings]];
  return values.reduce((next, [path, value]) => audioSettings.set(next, path, value), d);
}

// --- ADR 0158 §2, §3: global parameters and bus automation ----------------------------------------------------------

export { MAX_CURVE_KEYS, MAX_PARAMETERS };

/**
 * The project's global parameters as a holder of the one parameter list (ADR 0304): a rename renames the `parameter` of
 * every automation entry that names it (scenes and event files follow through `audioNames.ts`, ADR 0262), a remove drops
 * those entries.
 */
export const globalParameterList = parameterList<SettingsDraft>({
  read: (d) => audioSettings.read(d).parameters,
  write: (d, parameters) => audioSettings.write(d, { ...audioSettings.read(d), parameters }),
  limit: MAX_PARAMETERS,
  rename(d, from, to) {
    const a = audioSettings.read(d);
    const fix = (n: string) => (n === from ? to : n);
    return audioSettings.write(d, { ...a, parameters: a.parameters.map((p) => ({ ...p, name: fix(p.name) })), automation: a.automation.map((r) => ({ ...r, parameter: fix(r.parameter) })) });
  },
  remove(d, name) {
    const a = audioSettings.read(d);
    return audioSettings.write(d, { ...a, parameters: a.parameters.filter((p) => p.name !== name), automation: a.automation.filter((r) => r.parameter !== name) });
  },
});

/** "No automation 3." for an index that names no entry. */
const noAutomation = (index: number) => `No automation ${index + 1}.`;

/**
 * Append a bus automation entry: the bus `bus` (a known bus; default "Music", else the first bus after the root, else
 * the root), the first global parameter, `target: "volume"`, and a flat curve `[[lo, 1], [hi, 1]]` over that parameter's
 * range (`parameterRange`). Refused with no global parameter or an unknown explicit bus.
 */
export function addBusAutomation(d: SettingsDraft, bus?: string): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const target = bus ?? (a.buses.find((b) => b.name === "Music") ?? a.buses[1] ?? a.buses[0]).name;
  if (!a.buses.some((b) => b.name === target)) return refuse(`No bus named "${target}".`);
  const p = a.parameters[0];
  if (!p) return refuse("Automation reads a global parameter: add one first.");
  const [lo, hi] = parameterRange(p);
  const curve: Curve = lo === hi ? [[lo, 1], [lo + 1, 1]] : [[lo, 1], [hi, 1]];
  return mixEdit(d, { op: "setAutomation", index: a.automation.length, rule: { bus: target, parameter: p.name, target: "volume", curve }, insert: true });
}

/** Remove the entry at `index` (out of range is refused). */
export function removeBusAutomation(d: SettingsDraft, index: number): EditResult<SettingsDraft> {
  if (!audioSettings.read(d).automation[index]) return refuse(noAutomation(index));
  return mixEdit(d, { op: "setAutomation", index, rule: null });
}

/** Point an entry at another bus (an unknown bus or index is refused). */
export function setBusAutomationBus(d: SettingsDraft, index: number, bus: string): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  if (!a.automation[index]) return refuse(noAutomation(index));
  if (!a.buses.some((b) => b.name === bus)) return refuse(`No bus named "${bus}".`);
  return mixEdit(d, { op: "setAutomation", index, rule: { ...a.automation[index], bus } });
}

/**
 * Point an entry at another global parameter (an unknown parameter or index is refused; the same one is no change). The
 * curve's x values are mapped linearly from the old parameter's range to the new one's (a zero-width old range maps every
 * key to the new min), so the curve keeps its shape over the new range; interpolation keys are kept.
 */
export function setBusAutomationParameter(d: SettingsDraft, index: number, parameter: string): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const entry = a.automation[index];
  const next = parameterOf(a, parameter);
  if (!entry) return refuse(noAutomation(index));
  if (!next) return refuse(`No global parameter named "${parameter}".`);
  if (entry.parameter === parameter) return accept(d);
  const old = parameterOf(a, entry.parameter);
  const [oLo, oHi] = old ? parameterRange(old) : [0, 0];
  const [nLo, nHi] = parameterRange(next);
  const span = oHi - oLo;
  const mapX = (x: number) => (span === 0 ? nLo : nLo + ((x - oLo) / span) * (nHi - nLo));
  const curve: Curve = entry.curve.map((k) => (k.length > 2 ? [mapX(k[0]), k[1], k[2]] : [mapX(k[0]), k[1]]) as Curve[number]);
  return mixEdit(d, { op: "setAutomation", index, rule: { ...entry, parameter, curve } });
}

/** Switch an entry between `volume` and `lowpass`; the curve resets to flat over the parameter's range at 1 (volume) or 24000 Hz (lowpass), as the units differ. The same target is no change; an unknown index is refused. */
export function setBusAutomationTarget(d: SettingsDraft, index: number, target: BusAutomation["target"]): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const entry = a.automation[index];
  if (!entry) return refuse(noAutomation(index));
  if (entry.target === target) return accept(d);
  const p = parameterOf(a, entry.parameter);
  const [lo, hi] = p ? parameterRange(p) : [0, 1];
  const v = target === "volume" ? 1 : 24000;
  const curve: Curve = [[lo, v], [hi, v]];
  return mixEdit(d, { op: "setAutomation", index, rule: { ...entry, target, curve } });
}

/** Replace an entry's curve (an empty curve or an unknown index is refused; more than `MAX_CURVE_KEYS` keys are cut to that). */
export function setBusAutomationCurve(d: SettingsDraft, index: number, curve: Curve): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  if (!a.automation[index]) return refuse(noAutomation(index));
  if (curve.length === 0) return refuse("A curve needs at least one key.");
  const kept: Curve = curve.slice(0, MAX_CURVE_KEYS);
  return mixEdit(d, { op: "setAutomation", index, rule: { ...a.automation[index], curve: kept } });
}

/** The parameter a name refers to, or undefined. */
export const parameterOf = (a: AudioSettings, name: string): ParameterDef | undefined => a.parameters.find((p) => p.name === name);

// --- ADR 0162 C6: zone slots, memory accounting and warning data -------------------------------------------------------

/** Core zone slots: `maxActive + standby` (0 when `maxActive` is 0: zones are inert and nothing is reserved). */
export function zoneSlots(zones: Pick<AudioSettings["zones"], "maxActive" | "standby">): number {
  return zones.maxActive <= 0 ? 0 : zones.maxActive + zones.standby;
}

/** What the zone slots cost at 48 kHz (doubles at 96 kHz), in MB: the `Zones` region's state plus the kernels in the arena (outside `clipMemoryMB`). */
export interface ZoneMemory { slots: number; stateMB: number; kernelMB: number; totalMB: number }

/** Per-slot cost at `maxIrSeconds` (architecture section 6, the convolver spike): `[seconds, state MB, kernel MB]`. */
export const ZONE_SLOT_COST = [[1, 0.9, 0.8], [2, 1.6, 4.4 / 3], [4, 3.1, 8.8 / 3]] as const;

/** Piecewise-linear in IR length through `ZONE_SLOT_COST`, continuing the first and last slope outside it. */
function slotCost(seconds: number, column: 1 | 2): number {
  const pts = ZONE_SLOT_COST;
  const i = seconds <= pts[1][0] ? 0 : 1;
  const [x0, x1] = [pts[i][0], pts[i + 1][0]];
  const [y0, y1] = [pts[i][column], pts[i + 1][column]];
  return Math.max(0, y0 + ((seconds - x0) / (x1 - x0)) * (y1 - y0));
}

/** The zone memory of a section: low (1 x 1 s) 1.7 MB, default (3 x 2 s) 9.2, high (3 x 4 s) 18.0, as the architecture's table. */
export function zoneMemory(a: Pick<AudioSettings, "zones">): ZoneMemory {
  const slots = zoneSlots(a.zones);
  const stateMB = slots * slotCost(a.zones.maxIrSeconds, 1);
  const kernelMB = slots * slotCost(a.zones.maxIrSeconds, 2);
  return { slots, stateMB, kernelMB, totalMB: stateMB + kernelMB };
}

export const ZONE_EVICTION_FADE_MS = 150;

/** A zone-layout notice for the Settings UI (E3 words it). */
export type ZoneWarning =
  /** `maxActive` 0: zones are inert; every AudioReverbZone is ignored. */
  | { code: "zonesOff" }
  /** No standby slot: a zone beyond `maxActive` evicts a ringing slot with a 150 ms fade, and the incoming kernel loads 50..200 ms later. */
  | { code: "evictionFade"; maxActive: number; fadeMs: typeof ZONE_EVICTION_FADE_MS };

/** Notices for a zone layout: off, or no standby slot (swaps cut a tail). */
export function zoneWarnings(a: Pick<AudioSettings, "zones">): ZoneWarning[] {
  if (a.zones.maxActive <= 0) return [{ code: "zonesOff" }];
  return a.zones.standby === 0 ? [{ code: "evictionFade", maxActive: a.zones.maxActive, fadeMs: ZONE_EVICTION_FADE_MS }] : [];
}

// --- ADR 0162 E3: beds, ambisonic clips, occlusion, zones, Doppler (api-and-models section 7, 2.1, 2.2) -------------------

/** A bus's bed mode. The default (the root `own`, others `parent`) is stored as absent. Unknown buses change nothing. */
export function setBusBed(d: SettingsDraft, name: string, bed: BusBed): EditResult<SettingsDraft> {
  return mixEdit(d, { op: "setBus", bus: name, key: "bed", value: bed });
}

/** A bus's `bedPriority`: rounded, clamped 0..255; `undefined` (or the bus's default: root 255, others 128) is stored as absent. */
export function setBusBedPriority(d: SettingsDraft, name: string, priority: number | undefined): EditResult<SettingsDraft> {
  return mixEdit(d, { op: "setBus", bus: name, key: "bedPriority", value: priority === undefined || !Number.isFinite(priority) ? null : priority });
}

/** What the bed resolution gives a section: who hosts a bed, who asked for one and lost it, and where each bus mixes. */
export interface BedPlan {
  /** Hosts in rank order (the best first). */
  hosts: string[];
  /** Buses that asked `own` and were outranked, in rank order, each with the winners that outranked it and the bus whose bed it now shares (null: none, so it is flat). */
  lost: { bus: string; outrankedBy: string[]; sharesWith: string | null }[];
  /** Per bus, the host whose bed it mixes into (null: no bed). A host is its own. */
  hostOf: Record<string, string | null>;
  /** Nobody asked for `own` and the root was granted a bed implicitly. */
  implicitRoot: boolean;
  /** `bed.maxBeds`. */
  maxBeds: number;
}

/** Run the planner's own `resolveBeds` over the section (the editor knows `bed.maxBeds`, not the slots the core laid out). */
export function bedPlan(a: AudioSettings): BedPlan {
  const names = a.buses.map((b) => b.name);
  const res = resolveBeds({
    busCount: names.length,
    parents: a.buses.map((b) => (b.parent === undefined ? -1 : names.indexOf(b.parent))),
    modes: names.map((n) => busBed(a, n)),
    priorities: names.map((n) => busBedPriority(a, n)),
    maxBeds: a.bed.maxBeds,
  });
  const hostOf: Record<string, string | null> = {};
  names.forEach((n, i) => { const s = res.bedSlot[i]; hostOf[n] = s === undefined || s === 0xff ? null : (names[res.hostBus[s]] ?? null); });
  const winners = res.winners.map((w) => names[w]);
  return {
    hosts: winners,
    lost: res.denied.map((b) => ({ bus: names[b], outrankedBy: winners, sharesWith: hostOf[names[b]] })),
    hostOf,
    implicitRoot: res.implicitRoot,
    maxBeds: a.bed.maxBeds,
  };
}

/** Turn one physics layer on or off in `occlusion.layers`. From "every layer" (null), `all` (the draft's layers) is the starting list; ticking every layer goes back to null. */
export function toggleOcclusionLayer(d: SettingsDraft, layer: string, on: boolean, all: readonly string[]): SettingsDraft {
  const current = audioSettings.read(d).occlusion.layers ?? [...all];
  const next = on ? (current.includes(layer) ? current : [...current, layer]) : current.filter((l) => l !== layer);
  const ordered = all.filter((l) => next.includes(l)).concat(next.filter((l) => !all.includes(l)));
  return audioSettings.set(d, "occlusion.layers", all.every((l) => ordered.includes(l)) && ordered.length === all.length ? null : ordered);
}

// Material table (section 2.2). The section holds the effective table: the built-ins, overridden or extended.

export const isBuiltinMaterial = (name: string): boolean => BUILTIN_MATERIALS.some((m) => m.name === name);
/** True when a built-in row has been changed (it can be reset). Custom materials are never "modified". */
export function materialIsModified(a: AudioSettings, name: string): boolean {
  const b = BUILTIN_MATERIALS.find((m) => m.name === name);
  const m = a.occlusion.materials.find((x) => x.name === name);
  return !!b && !!m && !sameMaterial(m, b);
}

/** What `setMaterial` may change; `attackMs`/`releaseMs` of `null` go back to "use the smoothing time". */
export interface MaterialPatch { transmissionDb?: number; cutoffHz?: number; wetOcclusion?: number; attackMs?: number | null; releaseMs?: number | null }

const withMaterials = (d: SettingsDraft, a: AudioSettings, materials: OccluderMaterial[], defaultMaterial = a.occlusion.defaultMaterial): SettingsDraft =>
  audioSettings.write(d, { ...a, occlusion: { ...a.occlusion, materials, defaultMaterial } });

/** "No material named …" for a name the table doesn't have. */
const noMaterial = (name: string) => `No material named "${name}".`;

/** Append a custom material "Material" (unique: "Material 2"…) with concrete's values. Refused at `MAX_MATERIALS`. */
export function addMaterial(d: SettingsDraft): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const table = a.occlusion.materials;
  if (table.length >= MAX_MATERIALS) return refuse(`A project holds at most ${MAX_MATERIALS} materials.`);
  const base = table.find((m) => m.name === DEFAULT_MATERIAL_NAME) ?? table[0];
  const name = uniqueName("Material", table.map((m) => m.name));
  return accept(withMaterials(d, a, [...table, { name, transmissionDb: base.transmissionDb, cutoffHz: base.cutoffHz, wetOcclusion: base.wetOcclusion }]));
}

/** Edit a material's numbers, each clamped to `MATERIAL_LIMITS`; non-finite ignored. An unknown name is refused. */
export function setMaterial(d: SettingsDraft, name: string, patch: MaterialPatch): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const old = a.occlusion.materials.find((m) => m.name === name);
  if (!old) return refuse(noMaterial(name));
  const pick = (v: number | undefined, [min, max]: readonly [number, number], was: number) => (v === undefined || !Number.isFinite(v) ? was : Math.min(max, Math.max(min, v)));
  const next: OccluderMaterial = {
    name,
    transmissionDb: pick(patch.transmissionDb, MATERIAL_LIMITS.transmissionDb, old.transmissionDb),
    cutoffHz: pick(patch.cutoffHz, MATERIAL_LIMITS.cutoffHz, old.cutoffHz),
    wetOcclusion: pick(patch.wetOcclusion, MATERIAL_LIMITS.wetOcclusion, old.wetOcclusion),
  };
  for (const key of ["attackMs", "releaseMs"] as const) {
    const v = patch[key];
    const kept = v === undefined ? old[key] : v === null || !Number.isFinite(v) ? undefined : Math.min(MATERIAL_LIMITS[key][1], Math.max(MATERIAL_LIMITS[key][0], v));
    if (kept !== undefined) next[key] = kept;
  }
  return accept(sameMaterial(next, old) ? d : withMaterials(d, a, a.occlusion.materials.map((m) => (m.name === name ? next : m))));
}

/**
 * Rename a custom material; `defaultMaterial` follows. Trimmed; the same name is no change. Refused: a built-in (they
 * keep their names), an empty or taken name, an unknown material.
 */
export function renameMaterial(d: SettingsDraft, from: string, to: string): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const name = to.trim();
  const table = a.occlusion.materials;
  if (!table.some((m) => m.name === from)) return refuse(noMaterial(from));
  if (isBuiltinMaterial(from)) return refuse(`"${from}" is built in and keeps its name.`);
  if (name === from) return accept(d);
  if (name === "") return refuse("A material needs a name.");
  if (table.some((m) => m.name === name)) return refuse(`Another material is already named "${name}".`);
  return accept(withMaterials(d, a, table.map((m) => (m.name === from ? { ...m, name } : m)), a.occlusion.defaultMaterial === from ? name : a.occlusion.defaultMaterial));
}

/** Remove a custom material (a built-in is refused: it is reset instead). If it was the default, `concrete` becomes it. */
export function removeMaterial(d: SettingsDraft, name: string): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const table = a.occlusion.materials;
  if (!table.some((m) => m.name === name)) return refuse(noMaterial(name));
  if (isBuiltinMaterial(name)) return refuse(`"${name}" is built in: reset it instead.`);
  return accept(withMaterials(d, a, table.filter((m) => m.name !== name), a.occlusion.defaultMaterial === name ? DEFAULT_MATERIAL_NAME : a.occlusion.defaultMaterial));
}

/** Put a built-in material back to its shipped values (an unchanged one is no change; a custom or unknown name is refused). */
export function resetMaterial(d: SettingsDraft, name: string): EditResult<SettingsDraft> {
  const a = audioSettings.read(d);
  const b = BUILTIN_MATERIALS.find((m) => m.name === name);
  if (!b) return refuse(`"${name}" is not a built-in material.`);
  if (!materialIsModified(a, name)) return accept(d);
  return accept(withMaterials(d, a, a.occlusion.materials.map((m) => (m.name === name ? { ...b } : m))));
}

/** The project's physics layer names (what `occlusion.layers` chooses from). */
export const physicsLayerNames = (d: SettingsDraft): string[] => RUNTIME_SETTINGS.physics.parse(d.physics).value.layers;
