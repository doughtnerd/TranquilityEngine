// The Project panel's Audio section (ADR 0097): `project.json`'s `audio` key as part of the settings draft,
// edited by pure functions like navigation and graphics. Edits start from the leniently parsed section and
// write the whole section back, so the rest of the panel's undo/save machinery works unchanged.
import {
  DEFAULT_LIMITER_LOOKAHEAD_MS,
  EFFECT_TYPES,
  LIMITER_LOOKAHEAD_LIMITS,
  MASTER,
  MAX_BUSES,
  parseAudioSettings,
  type AudioSettings,
  type BusEffect,
  type BusSettings,
  type DuckingRule,
  type EffectType,
  type AudioBackground,
  type AudioClipFormat,
  type AudioSpatialMode,
  type VoiceSettings,
} from "../../../engine/audio/settings";
import type { SettingsDraft } from "../../../editor/sdk";

/** A name not in `taken`: `base`, else `base 2`, `base 3`… */
function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

export { EFFECT_TYPES, LIMITER_LOOKAHEAD_LIMITS, MAX_BUSES };

export const audioOf = (d: SettingsDraft): AudioSettings => parseAudioSettings(d.audio).settings;
export const audioProblems = (d: SettingsDraft): string[] => parseAudioSettings(d.audio).problems;
const withAudio = (d: SettingsDraft, a: AudioSettings): SettingsDraft => ({ ...d, audio: a as unknown as Record<string, unknown> });

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
