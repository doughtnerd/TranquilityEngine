// The Project panel's Audio section (ADR 0097): `project.json`'s `audio` key as part of the settings draft,
// edited by pure functions like navigation and graphics. Edits start from the leniently parsed section and
// write the whole section back, so the rest of the panel's undo/save machinery works unchanged.
import {
  AMBISONIC_LIMITS,
  BED_LIMITS,
  BED_PRIORITY_LIMITS,
  DEFAULT_BED_PRIORITY,
  OCCLUSION_LIMITS,
  ROOT_BED_PRIORITY,
  SPEED_OF_SOUND_LIMITS,
  ZONE_LIMITS,
  busBed,
  busBedPriority,
  type BusBed,
  DEFAULT_LIMITER_LOOKAHEAD_MS,
  EFFECT_TYPES,
  LIMITER_LOOKAHEAD_LIMITS,
  MASTER,
  MAX_BUSES,
  parseAudioSettings,
  type AudioSettings,
  type BusAutomation,
  type BusEffect,
  type BusSettings,
  type DuckingRule,
  type EffectType,
  type AudioBackground,
  type AudioClipFormat,
  type AudioSpatialMode,
  type VoiceSettings,
} from "../../../engine/audio/settings";
import { BUILTIN_MATERIALS, DEFAULT_MATERIAL_NAME, MATERIAL_LIMITS, MAX_MATERIALS, type OccluderMaterial } from "../../../engine/audio/occlusionMaterials";
import { defaultSettings } from "../../../engine/core/settings";
import { resolveBeds } from "../runtime/core/beds";
import type { Curve } from "../../../engine/core/curve";
import { isLabelled, MAX_CURVE_KEYS, MAX_PARAMETERS, parameterDefault, parameterRange, type ParameterDef } from "../../../engine/audio/eventFormat";
import type { SettingsDraft } from "../../../editor/sdk";

/** A name not in `taken`: `base`, else `base 2`, `base 3`… */
function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

export { EFFECT_TYPES, LIMITER_LOOKAHEAD_LIMITS, MAX_BUSES };

export const audioOf = (d: SettingsDraft): AudioSettings => parseAudioSettings(d.audio).settings;
export const audioProblems = (d: SettingsDraft): string[] => parseAudioSettings(d.audio).problems;
const sameMaterial = (a: OccluderMaterial, b: OccluderMaterial): boolean =>
  a.name === b.name && a.transmissionDb === b.transmissionDb && a.cutoffHz === b.cutoffHz && a.wetOcclusion === b.wetOcclusion && a.attackMs === b.attackMs && a.releaseMs === b.releaseMs;

/**
 * The section as written to `project.json`: `occlusion.materials` keeps only the rows that differ from the built-ins (the
 * parse re-adds the others), so a later retune of a built-in reaches projects that never edited it.
 */
function withAudio(d: SettingsDraft, a: AudioSettings): SettingsDraft {
  const materials = a.occlusion.materials.filter((m) => { const b = BUILTIN_MATERIALS.find((x) => x.name === m.name); return !b || !sameMaterial(m, b); });
  return { ...d, audio: { ...a, occlusion: { ...a.occlusion, materials } } as unknown as Record<string, unknown> };
}

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

export function addBus(d: SettingsDraft, parent = MASTER): SettingsDraft {
  const a = audioOf(d);
  if (a.buses.length >= MAX_BUSES) return d;
  const p = a.buses.some((b) => b.name === parent) ? parent : a.buses[0].name;
  const name = uniqueName("Bus", a.buses.map((b) => b.name));
  return withAudio(d, { ...a, buses: [...a.buses, { name, parent: p, volume: 1, mute: false, effects: [] }] });
}

/** Remove a bus and everything under it, and the snapshot entries and ducking rules that named them. The root stays. */
export function removeBus(d: SettingsDraft, name: string): SettingsDraft {
  const a = audioOf(d);
  if (name === a.buses[0].name) return d;
  const gone = new Set([name, ...descendants(a, name)]);
  const scrub = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).filter(([k]) => !gone.has(k)));
  return withAudio(d, {
    ...a,
    buses: a.buses.filter((b) => !gone.has(b.name)),
    snapshots: a.snapshots.map((s) => ({ ...s, volumes: scrub(s.volumes), lowpass: scrub(s.lowpass) })),
    ducking: a.ducking.filter((r) => !gone.has(r.target) && !gone.has(r.trigger)),
    automation: a.automation.filter((r) => !gone.has(r.bus)),
  });
}

/** Rename a bus everywhere it's named in the section (AudioSources that name it aren't updated, like physics layers). */
export function renameBus(d: SettingsDraft, from: string, to: string): SettingsDraft {
  const a = audioOf(d);
  const name = to.trim();
  if (name === "" || name === from || a.buses.some((b) => b.name === name) || !a.buses.some((b) => b.name === from)) return d;
  const re = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k === from ? name : k, v]));
  const fix = (n: string) => (n === from ? name : n);
  return withAudio(d, {
    ...a,
    buses: a.buses.map((b) => ({ ...b, name: fix(b.name), ...(b.parent !== undefined ? { parent: fix(b.parent) } : {}) })),
    snapshots: a.snapshots.map((s) => ({ ...s, volumes: re(s.volumes), lowpass: re(s.lowpass) })),
    ducking: a.ducking.map((r) => ({ ...r, target: fix(r.target), trigger: fix(r.trigger) })),
    automation: a.automation.map((r) => ({ ...r, bus: fix(r.bus) })),
  });
}

/** Move a bus under another (not itself or its own descendant; the root has no parent). */
export function setBusParent(d: SettingsDraft, name: string, parent: string): SettingsDraft {
  const a = audioOf(d);
  if (name === a.buses[0].name || parent === name || descendants(a, name).includes(parent) || !a.buses.some((b) => b.name === parent)) return d;
  return withAudio(d, { ...a, buses: a.buses.map((b) => (b.name === name ? { ...b, parent } : b)) });
}

export function setBusValue(d: SettingsDraft, name: string, key: "volume" | "mute", value: number | boolean): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, buses: a.buses.map((b) => (b.name === name ? { ...b, [key]: value } : b)) });
}

export const defaultEffect = (type: EffectType): BusEffect => parseAudioSettings({ buses: [{ name: "x", effects: [{ type }] }] }).settings.buses[0].effects[0];

export function addEffect(d: SettingsDraft, bus: string, type: EffectType): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, buses: a.buses.map((b) => (b.name === bus ? { ...b, effects: [...b.effects, defaultEffect(type)] } : b)) });
}
export function removeEffect(d: SettingsDraft, bus: string, index: number): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, buses: a.buses.map((b) => (b.name === bus ? { ...b, effects: b.effects.filter((_, i) => i !== index) } : b)) });
}
export function setEffectValue(d: SettingsDraft, bus: string, index: number, key: string, value: number): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, buses: a.buses.map((b) => (b.name === bus ? { ...b, effects: b.effects.map((e, i) => (i === index ? ({ ...e, [key]: value } as BusEffect) : e)) } : b)) });
}

// --- snapshots and ducking ------------------------------------------------------------------------

export function addSnapshot(d: SettingsDraft): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, snapshots: [...a.snapshots, { name: uniqueName("Snapshot", a.snapshots.map((s) => s.name)), volumes: {}, lowpass: {} }] });
}
export function removeSnapshot(d: SettingsDraft, index: number): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, snapshots: a.snapshots.filter((_, i) => i !== index) });
}
export function renameSnapshot(d: SettingsDraft, index: number, to: string): SettingsDraft {
  const a = audioOf(d);
  const name = to.trim();
  if (name === "" || a.snapshots.some((s, i) => i !== index && s.name === name)) return d;
  return withAudio(d, { ...a, snapshots: a.snapshots.map((s, i) => (i === index ? { ...s, name } : s)) });
}
/** Set a bus's multiplier in a snapshot (undefined: unlisted, so 1). */
export function setSnapshotVolume(d: SettingsDraft, index: number, bus: string, value: number | undefined): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, snapshots: a.snapshots.map((s, i) => {
    if (i !== index) return s;
    const volumes = { ...s.volumes };
    if (value === undefined) delete volumes[bus]; else volumes[bus] = value;
    return { ...s, volumes };
  }) });
}
export function setSnapshotLowpass(d: SettingsDraft, index: number, bus: string, hz: number | undefined): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, snapshots: a.snapshots.map((s, i) => {
    if (i !== index) return s;
    const lowpass = { ...s.lowpass };
    if (hz === undefined) delete lowpass[bus]; else lowpass[bus] = hz;
    return { ...s, lowpass };
  }) });
}

export function addDucking(d: SettingsDraft): SettingsDraft {
  const a = audioOf(d);
  const [target, trigger] = [a.buses.find((b) => b.name === "Music") ?? a.buses[1] ?? a.buses[0], a.buses.find((b) => b.name === "Voice") ?? a.buses[2] ?? a.buses[0]];
  if (target.name === trigger.name) return d; // needs two buses
  return withAudio(d, { ...a, ducking: [...a.ducking, { target: target.name, trigger: trigger.name, amount: 0.4, attack: 0.1, release: 0.5 }] });
}
export function removeDucking(d: SettingsDraft, index: number): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, ducking: a.ducking.filter((_, i) => i !== index) });
}
export function setDuckingValue(d: SettingsDraft, index: number, key: keyof DuckingRule, value: string | number): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, ducking: a.ducking.map((r, i) => (i === index ? ({ ...r, [key]: value } as DuckingRule) : r)) });
}

export function setBackend(d: SettingsDraft, backend: "babylon" | "core"): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, backend });
}

// --- §2 core keys (ADR 0157, K13) -------------------------------------------------------------------

const clampInt = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(n)));

export const VOICE_LIMITS = { mixed: [8, 512], logical: [8, 8192], hrtf: [0, 32] } as const;
export const CLIP_MEMORY_LIMITS = [16, 1024] as const;

/** A bus's `maxVoices`: rounded and clamped to 1..`voices.logical`; `undefined` is unlimited. Unknown buses change nothing. */
export function setBusMaxVoices(d: SettingsDraft, name: string, value: number | undefined): SettingsDraft {
  const a = audioOf(d);
  if (!a.buses.some((b) => b.name === name)) return d;
  const max = value === undefined || !Number.isFinite(value) ? undefined : clampInt(value, 1, a.voices.logical);
  return withAudio(d, { ...a, buses: a.buses.map((b) => {
    if (b.name !== name) return b;
    const { maxVoices: _drop, ...rest } = b;
    return max === undefined ? rest : { ...rest, maxVoices: max };
  }) });
}

/**
 * Voice counts: a partial update, each number rounded and clamped to its range. `logical` never falls below `mixed`
 * (it is raised), and per-bus `maxVoices` above a lowered `logical` are clamped to it, as the parse would.
 */
export function setVoices(d: SettingsDraft, patch: Partial<VoiceSettings>): SettingsDraft {
  const a = audioOf(d);
  const pick = (v: number | undefined, key: keyof VoiceSettings, [min, max]: readonly [number, number]) => (v === undefined || !Number.isFinite(v) ? a.voices[key] : clampInt(v, min, max));
  const mixed = pick(patch.mixed, "mixed", VOICE_LIMITS.mixed);
  const logical = Math.max(mixed, pick(patch.logical, "logical", VOICE_LIMITS.logical));
  const hrtf = pick(patch.hrtf, "hrtf", VOICE_LIMITS.hrtf);
  return withAudio(d, { ...a, voices: { mixed, logical, hrtf }, buses: a.buses.map((b) => (b.maxVoices !== undefined && b.maxVoices > logical ? { ...b, maxVoices: logical } : b)) });
}

/** Named bundles of the voice numbers and the clip ceiling (architecture 5.3); the file stores the numbers. "low" is provisional until the low-end soak (C3) sizes it. */
export const VOICE_PRESETS = {
  low: { voices: { mixed: 64, logical: 1024, hrtf: 4 }, clipMemoryMB: 64 },
  default: { voices: { mixed: 128, logical: 4096, hrtf: 16 }, clipMemoryMB: undefined },
  high: { voices: { mixed: 256, logical: 4096, hrtf: 32 }, clipMemoryMB: 256 },
} as const;
export type VoicePresetName = keyof typeof VOICE_PRESETS;
export const VOICE_PRESET_NAMES = Object.keys(VOICE_PRESETS) as VoicePresetName[];

/** The preset the section's numbers match exactly, or "custom". */
export function voicesPreset(a: AudioSettings): VoicePresetName | "custom" {
  for (const name of VOICE_PRESET_NAMES) {
    const p = VOICE_PRESETS[name];
    if (p.voices.mixed === a.voices.mixed && p.voices.logical === a.voices.logical && p.voices.hrtf === a.voices.hrtf && p.clipMemoryMB === a.clipMemoryMB) return name;
  }
  return "custom";
}

/** Apply a preset: voices and the clip ceiling (the default preset leaves the ceiling unset). Per-bus limits are kept, clamped to `logical`. */
export function applyVoicesPreset(d: SettingsDraft, name: VoicePresetName): SettingsDraft {
  const p = VOICE_PRESETS[name];
  return setClipMemory(setVoices(d, p.voices), p.clipMemoryMB);
}

export function setBackground(d: SettingsDraft, background: AudioBackground): SettingsDraft {
  const a = audioOf(d);
  return a.background === background ? d : withAudio(d, { ...a, background });
}

/** The clip arena ceiling in MB (rounded, clamped 16..1024); `undefined` goes back to the device preset's. */
export function setClipMemory(d: SettingsDraft, mb: number | undefined): SettingsDraft {
  const a = audioOf(d);
  const { clipMemoryMB: _drop, ...rest } = a;
  return withAudio(d, mb === undefined || !Number.isFinite(mb) ? rest : { ...a, clipMemoryMB: clampInt(mb, CLIP_MEMORY_LIMITS[0], CLIP_MEMORY_LIMITS[1]) });
}

/** The limiter's look-ahead in ms (clamped 0..5; not rounded); a non-finite value goes back to the 1.5 ms default. */
export function setLimiterLookahead(d: SettingsDraft, ms: number): SettingsDraft {
  const a = audioOf(d);
  const [min, max] = LIMITER_LOOKAHEAD_LIMITS;
  const v = Number.isFinite(ms) ? Math.min(max, Math.max(min, ms)) : DEFAULT_LIMITER_LOOKAHEAD_MS;
  return a.limiterLookaheadMs === v ? d : withAudio(d, { ...a, limiterLookaheadMs: v });
}

export function setClipFormat(d: SettingsDraft, clipFormat: AudioClipFormat): SettingsDraft {
  const a = audioOf(d);
  return a.clipFormat === clipFormat ? d : withAudio(d, { ...a, clipFormat });
}

/** A codec switch (`codecs.aac`). */
export function setCodec(d: SettingsDraft, codec: "aac", on: boolean): SettingsDraft {
  const a = audioOf(d);
  return a.codecs[codec] === on ? d : withAudio(d, { ...a, codecs: { ...a.codecs, [codec]: on } });
}

export function setSpatial(d: SettingsDraft, spatial: AudioSpatialMode): SettingsDraft {
  const a = audioOf(d);
  return a.spatial === spatial ? d : withAudio(d, { ...a, spatial });
}

// --- ADR 0158 §2, §3: global parameters and bus automation ----------------------------------------------------------

export { MAX_CURVE_KEYS, MAX_PARAMETERS };

/** What `setParameterRange` may change on a numeric parameter. */
export interface ParameterRangePatch { min?: number; max?: number; default?: number; seekSpeed?: number }

/**
 * Append a global parameter named "Parameter" (unique: "Parameter 2"…): numeric `min 0, max 1, default 0, seekSpeed 0`,
 * or, when `labelled`, `labels ["State 1", "State 2"]` with default "State 1". At `MAX_PARAMETERS`, returns `d`.
 */
export function addParameter(d: SettingsDraft, labelled = false): SettingsDraft {
  const a = audioOf(d);
  if (a.parameters.length >= MAX_PARAMETERS) return d;
  const name = uniqueName("Parameter", a.parameters.map((p) => p.name));
  const param: ParameterDef = labelled ? { name, labels: ["State 1", "State 2"], default: "State 1" } : { name, min: 0, max: 1, default: 0, seekSpeed: 0 };
  return withAudio(d, { ...a, parameters: [...a.parameters, param] });
}

/** Remove a parameter and the automation entries that name it. Unknown names return `d`. */
export function removeParameter(d: SettingsDraft, name: string): SettingsDraft {
  const a = audioOf(d);
  if (!a.parameters.some((p) => p.name === name)) return d;
  return withAudio(d, { ...a, parameters: a.parameters.filter((p) => p.name !== name), automation: a.automation.filter((r) => r.parameter !== name) });
}

/** Rename a parameter, and the `parameter` of every automation entry that names it. Trimmed; empty, unchanged, taken or unknown names return `d`. */
export function renameParameter(d: SettingsDraft, from: string, to: string): SettingsDraft {
  const a = audioOf(d);
  const next = to.trim();
  if (next === "" || next === from || a.parameters.some((p) => p.name === next) || !a.parameters.some((p) => p.name === from)) return d;
  const fix = (n: string) => (n === from ? next : n);
  return withAudio(d, { ...a, parameters: a.parameters.map((p) => ({ ...p, name: fix(p.name) })), automation: a.automation.map((r) => ({ ...r, parameter: fix(r.parameter) })) });
}

/**
 * Switch a parameter between numeric and labelled, keeping its name and position. Numeric to labelled: labels
 * ["State 1", "State 2"], default "State 1". Labelled to numeric: `min 0, max labels-1 (at least 1)`, default the old
 * default's index, `seekSpeed 0`. Already that kind, or unknown: returns `d`. Automation is kept as authored.
 */
export function setParameterLabelled(d: SettingsDraft, name: string, labelled: boolean): SettingsDraft {
  const a = audioOf(d);
  const p = parameterOf(a, name);
  if (!p || isLabelled(p) === labelled) return d;
  const next: ParameterDef = labelled
    ? { name, labels: ["State 1", "State 2"], default: "State 1" }
    : { name, min: 0, max: Math.max(1, parameterRange(p)[1]), default: parameterDefault(p), seekSpeed: 0 };
  return withAudio(d, { ...a, parameters: a.parameters.map((q) => (q.name === name ? next : q)) });
}

/**
 * Edit a numeric parameter (labelled or unknown ones return `d`). Non-finite fields are ignored, `seekSpeed` is clamped
 * to 0 or more. If `min` ends up above `max` the two are swapped; `default` (the patched or the existing one) is clamped
 * into the final range.
 */
export function setParameterRange(d: SettingsDraft, name: string, patch: ParameterRangePatch): SettingsDraft {
  const a = audioOf(d);
  const p = parameterOf(a, name);
  if (!p || isLabelled(p)) return d;
  const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);
  let min = finite(patch.min) ?? p.min;
  let max = finite(patch.max) ?? p.max;
  if (min > max) [min, max] = [max, min];
  const seekSpeed = Math.max(0, finite(patch.seekSpeed) ?? p.seekSpeed);
  const def = Math.min(max, Math.max(min, finite(patch.default) ?? p.default));
  return withAudio(d, { ...a, parameters: a.parameters.map((q) => (q.name === name ? { name, min, max, default: def, seekSpeed } : q)) });
}

/**
 * Replace a labelled parameter's labels: each trimmed, empty ones and repeats dropped (first kept). No labels left, a
 * numeric or unknown parameter: returns `d`. The default stays if it is still a label, else becomes the first.
 */
export function setParameterLabels(d: SettingsDraft, name: string, labels: readonly string[]): SettingsDraft {
  const a = audioOf(d);
  const p = parameterOf(a, name);
  if (!p || !isLabelled(p)) return d;
  const list = [...new Set(labels.map((l) => l.trim()).filter((l) => l !== ""))];
  if (list.length === 0) return d;
  const def = list.includes(p.default) ? p.default : list[0];
  return withAudio(d, { ...a, parameters: a.parameters.map((q) => (q.name === name ? { name, labels: list, default: def } : q)) });
}

/** A labelled parameter's default, which must be one of its labels (else `d`). */
export function setParameterDefaultLabel(d: SettingsDraft, name: string, label: string): SettingsDraft {
  const a = audioOf(d);
  const p = parameterOf(a, name);
  if (!p || !isLabelled(p) || !p.labels.includes(label)) return d;
  return withAudio(d, { ...a, parameters: a.parameters.map((q) => (q.name === name ? { ...p, default: label } : q)) });
}

/**
 * Append a bus automation entry: the bus `bus` (a known bus; default "Music", else the first bus after the root, else
 * the root), the first global parameter, `target: "volume"`, and a flat curve `[[lo, 1], [hi, 1]]` over that parameter's
 * range (`parameterRange`). No parameters or an unknown explicit bus: returns `d`.
 */
export function addBusAutomation(d: SettingsDraft, bus?: string): SettingsDraft {
  const a = audioOf(d);
  const target = bus ?? (a.buses.find((b) => b.name === "Music") ?? a.buses[1] ?? a.buses[0]).name;
  if (!a.buses.some((b) => b.name === target)) return d;
  const p = a.parameters[0];
  if (!p) return d;
  const [lo, hi] = parameterRange(p);
  const curve: Curve = lo === hi ? [[lo, 1], [lo + 1, 1]] : [[lo, 1], [hi, 1]];
  return withAudio(d, { ...a, automation: [...a.automation, { bus: target, parameter: p.name, target: "volume", curve }] });
}

/** Remove the entry at `index` (out of range returns `d`). */
export function removeBusAutomation(d: SettingsDraft, index: number): SettingsDraft {
  const a = audioOf(d);
  if (!a.automation[index]) return d;
  return withAudio(d, { ...a, automation: a.automation.filter((_, i) => i !== index) });
}

/** Point an entry at another bus (unknown bus or index returns `d`). */
export function setBusAutomationBus(d: SettingsDraft, index: number, bus: string): SettingsDraft {
  const a = audioOf(d);
  if (!a.automation[index] || !a.buses.some((b) => b.name === bus)) return d;
  return withAudio(d, { ...a, automation: a.automation.map((r, i) => (i === index ? { ...r, bus } : r)) });
}

/**
 * Point an entry at another global parameter (unknown parameter or index returns `d`). The curve's x values are mapped
 * linearly from the old parameter's range to the new one's (a zero-width old range maps every key to the new min), so the
 * curve keeps its shape over the new range; interpolation keys are kept.
 */
export function setBusAutomationParameter(d: SettingsDraft, index: number, parameter: string): SettingsDraft {
  const a = audioOf(d);
  const entry = a.automation[index];
  const next = parameterOf(a, parameter);
  if (!entry || !next || entry.parameter === parameter) return d;
  const old = parameterOf(a, entry.parameter);
  const [oLo, oHi] = old ? parameterRange(old) : [0, 0];
  const [nLo, nHi] = parameterRange(next);
  const span = oHi - oLo;
  const mapX = (x: number) => (span === 0 ? nLo : nLo + ((x - oLo) / span) * (nHi - nLo));
  const curve: Curve = entry.curve.map((k) => (k.length > 2 ? [mapX(k[0]), k[1], k[2]] : [mapX(k[0]), k[1]]) as Curve[number]);
  return withAudio(d, { ...a, automation: a.automation.map((r, i) => (i === index ? { ...r, parameter, curve } : r)) });
}

/** Switch an entry between `volume` and `lowpass`; the curve resets to flat over the parameter's range at 1 (volume) or 24000 Hz (lowpass), as the units differ. Same target or unknown index: returns `d`. */
export function setBusAutomationTarget(d: SettingsDraft, index: number, target: BusAutomation["target"]): SettingsDraft {
  const a = audioOf(d);
  const entry = a.automation[index];
  if (!entry || entry.target === target) return d;
  const p = parameterOf(a, entry.parameter);
  const [lo, hi] = p ? parameterRange(p) : [0, 1];
  const v = target === "volume" ? 1 : 24000;
  const curve: Curve = [[lo, v], [hi, v]];
  return withAudio(d, { ...a, automation: a.automation.map((r, i) => (i === index ? { ...r, target, curve } : r)) });
}

/** Replace an entry's curve (an empty curve, or an unknown index, returns `d`; more than `MAX_CURVE_KEYS` keys are cut to that). */
export function setBusAutomationCurve(d: SettingsDraft, index: number, curve: Curve): SettingsDraft {
  const a = audioOf(d);
  if (curve.length === 0 || !a.automation[index]) return d;
  const kept: Curve = curve.slice(0, MAX_CURVE_KEYS);
  return withAudio(d, { ...a, automation: a.automation.map((r, i) => (i === index ? { ...r, curve: kept } : r)) });
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

/** `zones.standby`: rounded and clamped to 0..1. Non-finite changes nothing. */
export function setZoneStandby(d: SettingsDraft, standby: number): SettingsDraft {
  const a = audioOf(d);
  if (!Number.isFinite(standby)) return d;
  const v = clampInt(standby, 0, 1);
  return a.zones.standby === v ? d : withAudio(d, { ...a, zones: { ...a.zones, standby: v } });
}

// --- ADR 0162 E3: beds, ambisonic clips, occlusion, zones, Doppler (api-and-models section 7, 2.1, 2.2) -------------------

/** `audio.bed.maxBeds`: rounded, clamped 0..4 (0 turns beds off). Non-finite changes nothing. */
export function setBed(d: SettingsDraft, maxBeds: number): SettingsDraft {
  const a = audioOf(d);
  if (!Number.isFinite(maxBeds)) return d;
  const v = clampInt(maxBeds, ...BED_LIMITS.maxBeds);
  return a.bed.maxBeds === v ? d : withAudio(d, { ...a, bed: { ...a.bed, maxBeds: v } });
}

/** A bus's bed mode. The default (the root `own`, others `parent`) is stored as absent. Unknown buses change nothing. */
export function setBusBed(d: SettingsDraft, name: string, bed: BusBed): SettingsDraft {
  const a = audioOf(d);
  if (!a.buses.some((b) => b.name === name) || busBed(a, name) === bed) return d;
  const isDefault = bed === (a.buses[0].name === name ? "own" : "parent");
  return withAudio(d, { ...a, buses: a.buses.map((b) => {
    if (b.name !== name) return b;
    const { bed: _drop, ...rest } = b;
    return isDefault ? rest : { ...rest, bed };
  }) });
}

/** A bus's `bedPriority`: rounded, clamped 0..255; `undefined` (or the bus's default: root 255, others 128) is stored as absent. */
export function setBusBedPriority(d: SettingsDraft, name: string, priority: number | undefined): SettingsDraft {
  const a = audioOf(d);
  if (!a.buses.some((b) => b.name === name)) return d;
  const def = a.buses[0].name === name ? ROOT_BED_PRIORITY : DEFAULT_BED_PRIORITY;
  const v = priority === undefined || !Number.isFinite(priority) ? undefined : clampInt(priority, ...BED_PRIORITY_LIMITS);
  const next = v === undefined || v === def ? undefined : v;
  if (busBedPriority(a, name) === (next ?? def)) return d;
  return withAudio(d, { ...a, buses: a.buses.map((b) => {
    if (b.name !== name) return b;
    const { bedPriority: _drop, ...rest } = b;
    return next === undefined ? rest : { ...rest, bedPriority: next };
  }) });
}

/** `audio.ambisonic.maxClips`: rounded, clamped 0..4 (0 refuses ambisonic clips with a warning). Non-finite changes nothing. */
export function setMaxClips(d: SettingsDraft, maxClips: number): SettingsDraft {
  const a = audioOf(d);
  if (!Number.isFinite(maxClips)) return d;
  const v = clampInt(maxClips, ...AMBISONIC_LIMITS.maxClips);
  return a.ambisonic.maxClips === v ? d : withAudio(d, { ...a, ambisonic: { ...a.ambisonic, maxClips: v } });
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

/** The buses that asked for their own bed and lost it to priority: the lost-bed warning's rows (empty when `maxBeds` is 0). */
export const lostBeds = (a: AudioSettings): BedPlan["lost"] => bedPlan(a).lost;

export interface OcclusionPatch {
  /** Physics layer names; `null` is every layer, an empty list turns occlusion off. Repeats and blanks are dropped. */
  layers?: readonly string[] | null;
  budgetMs?: number;
  smoothingMs?: number;
  /** Must name a material in the table, else ignored. */
  defaultMaterial?: string;
}

/** `audio.occlusion`'s scalar keys and layers: a partial update, numbers clamped (`OCCLUSION_LIMITS`), non-finite ignored. */
export function setOcclusion(d: SettingsDraft, patch: OcclusionPatch): SettingsDraft {
  const a = audioOf(d);
  const o = a.occlusion;
  const num = (v: number | undefined, [min, max]: readonly [number, number], old: number) => (v === undefined || !Number.isFinite(v) ? old : Math.min(max, Math.max(min, v)));
  const layers = patch.layers === undefined ? o.layers : patch.layers === null ? null : [...new Set(patch.layers.map((l) => l.trim()).filter((l) => l !== ""))];
  const defaultMaterial = patch.defaultMaterial !== undefined && o.materials.some((m) => m.name === patch.defaultMaterial) ? patch.defaultMaterial : o.defaultMaterial;
  const next = { ...o, layers, budgetMs: num(patch.budgetMs, OCCLUSION_LIMITS.budgetMs, o.budgetMs), smoothingMs: num(patch.smoothingMs, OCCLUSION_LIMITS.smoothingMs, o.smoothingMs), defaultMaterial };
  return JSON.stringify(next) === JSON.stringify(o) ? d : withAudio(d, { ...a, occlusion: next });
}

/** Turn one physics layer on or off in `occlusion.layers`. From "every layer" (null), `all` (the draft's layers) is the starting list; ticking every layer goes back to null. */
export function toggleOcclusionLayer(d: SettingsDraft, layer: string, on: boolean, all: readonly string[]): SettingsDraft {
  const current = audioOf(d).occlusion.layers ?? [...all];
  const next = on ? (current.includes(layer) ? current : [...current, layer]) : current.filter((l) => l !== layer);
  const ordered = all.filter((l) => next.includes(l)).concat(next.filter((l) => !all.includes(l)));
  return setOcclusion(d, { layers: all.every((l) => ordered.includes(l)) && ordered.length === all.length ? null : ordered });
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
  withAudio(d, { ...a, occlusion: { ...a.occlusion, materials, defaultMaterial } });

/** Append a custom material "Material" (unique: "Material 2"…) with concrete's values. At `MAX_MATERIALS`, returns `d`. */
export function addMaterial(d: SettingsDraft): SettingsDraft {
  const a = audioOf(d);
  const table = a.occlusion.materials;
  if (table.length >= MAX_MATERIALS) return d;
  const base = table.find((m) => m.name === DEFAULT_MATERIAL_NAME) ?? table[0];
  const name = uniqueName("Material", table.map((m) => m.name));
  return withMaterials(d, a, [...table, { name, transmissionDb: base.transmissionDb, cutoffHz: base.cutoffHz, wetOcclusion: base.wetOcclusion }]);
}

/** Edit a material's numbers, each clamped to `MATERIAL_LIMITS`; non-finite ignored. Unknown names return `d`. */
export function setMaterial(d: SettingsDraft, name: string, patch: MaterialPatch): SettingsDraft {
  const a = audioOf(d);
  const old = a.occlusion.materials.find((m) => m.name === name);
  if (!old) return d;
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
  return sameMaterial(next, old) ? d : withMaterials(d, a, a.occlusion.materials.map((m) => (m.name === name ? next : m)));
}

/** Rename a custom material (built-ins keep their names). Trimmed; empty, taken or unknown names return `d`. `defaultMaterial` follows. */
export function renameMaterial(d: SettingsDraft, from: string, to: string): SettingsDraft {
  const a = audioOf(d);
  const name = to.trim();
  const table = a.occlusion.materials;
  if (isBuiltinMaterial(from) || name === "" || name === from || table.some((m) => m.name === name) || !table.some((m) => m.name === from)) return d;
  return withMaterials(d, a, table.map((m) => (m.name === from ? { ...m, name } : m)), a.occlusion.defaultMaterial === from ? name : a.occlusion.defaultMaterial);
}

/** Remove a custom material (a built-in is reset instead: returns `d`). If it was the default, `concrete` becomes it. */
export function removeMaterial(d: SettingsDraft, name: string): SettingsDraft {
  const a = audioOf(d);
  const table = a.occlusion.materials;
  if (isBuiltinMaterial(name) || !table.some((m) => m.name === name)) return d;
  return withMaterials(d, a, table.filter((m) => m.name !== name), a.occlusion.defaultMaterial === name ? DEFAULT_MATERIAL_NAME : a.occlusion.defaultMaterial);
}

/** Put a built-in material back to its shipped values (custom, unchanged or unknown names return `d`). */
export function resetMaterial(d: SettingsDraft, name: string): SettingsDraft {
  const a = audioOf(d);
  const b = BUILTIN_MATERIALS.find((m) => m.name === name);
  if (!b || !materialIsModified(a, name)) return d;
  return withMaterials(d, a, a.occlusion.materials.map((m) => (m.name === name ? { ...b } : m)));
}

export interface ZonesPatch { maxActive?: number; standby?: number; maxIrSeconds?: number }

/** `audio.zones`: a partial update; the integers are rounded and clamped, `maxIrSeconds` clamped to 0.5..8 (not rounded); non-finite ignored. */
export function setZones(d: SettingsDraft, patch: ZonesPatch): SettingsDraft {
  const a = audioOf(d);
  const z = a.zones;
  const int = (v: number | undefined, [min, max]: readonly [number, number], old: number) => (v === undefined || !Number.isFinite(v) ? old : clampInt(v, min, max));
  const [lo, hi] = ZONE_LIMITS.maxIrSeconds;
  const next = {
    maxActive: int(patch.maxActive, ZONE_LIMITS.maxActive, z.maxActive),
    standby: int(patch.standby, ZONE_LIMITS.standby, z.standby),
    maxIrSeconds: patch.maxIrSeconds === undefined || !Number.isFinite(patch.maxIrSeconds) ? z.maxIrSeconds : Math.min(hi, Math.max(lo, patch.maxIrSeconds)),
  };
  return next.maxActive === z.maxActive && next.standby === z.standby && next.maxIrSeconds === z.maxIrSeconds ? d : withAudio(d, { ...a, zones: next });
}

export interface DopplerPatch {
  /** World units per second; must be above 0 (others ignored). */
  maxSpeed?: number;
  /** World units per second, clamped 10..100000. */
  speedOfSound?: number;
}

/** `audio.doppler.maxSpeed` and `audio.speedOfSound`. */
export function setDoppler(d: SettingsDraft, patch: DopplerPatch): SettingsDraft {
  const a = audioOf(d);
  const maxSpeed = patch.maxSpeed !== undefined && Number.isFinite(patch.maxSpeed) && patch.maxSpeed > 0 ? patch.maxSpeed : a.doppler.maxSpeed;
  const [lo, hi] = SPEED_OF_SOUND_LIMITS;
  const speedOfSound = patch.speedOfSound !== undefined && Number.isFinite(patch.speedOfSound) ? Math.min(hi, Math.max(lo, patch.speedOfSound)) : a.speedOfSound;
  return maxSpeed === a.doppler.maxSpeed && speedOfSound === a.speedOfSound ? d : withAudio(d, { ...a, doppler: { maxSpeed }, speedOfSound });
}

/** The project's physics layer names (what `occlusion.layers` chooses from). */
export const physicsLayerNames = (d: SettingsDraft): string[] => d.physics?.layers ?? defaultSettings.physics.layers;
