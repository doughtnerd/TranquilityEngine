// The Project panel's Audio section (ADR 0097): `project.json`'s `audio` key as part of the settings draft,
// edited by pure functions like navigation and graphics. Edits start from the leniently parsed section and
// write the whole section back, so the rest of the panel's undo/save machinery works unchanged.
import {
  EFFECT_TYPES,
  MASTER,
  MAX_BUSES,
  parseAudioSettings,
  type AudioSettings,
  type BusEffect,
  type BusSettings,
  type DuckingRule,
  type EffectType,
} from "../engine/audio/settings";
import type { SettingsDraft } from "./projectSettingsModel";
import { uniqueName } from "./worldsConfig";

export { EFFECT_TYPES, MAX_BUSES };

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

export function setBackend(d: SettingsDraft, backend: "howler" | "fmod"): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, backend });
}
export function setFmod(d: SettingsDraft, sdkPath: string, banks: string[]): SettingsDraft {
  const a = audioOf(d);
  return withAudio(d, { ...a, fmod: { sdkPath, banks } });
}
