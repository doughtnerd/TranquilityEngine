/**
 * Internal (ADR 0097): the `audio` section of `project.json`, a tree of mixer buses with per-bus
 * volume, mute and effects, plus snapshots and ducking rules.
 *
 * ```jsonc
 * "audio": {
 *   "buses": [
 *     { "name": "Master" },
 *     { "name": "Music", "parent": "Master", "volume": 0.8, "effects": [{ "type": "lowpass", "frequency": 18000 }] },
 *     { "name": "SFX",   "parent": "Master", "effects": [{ "type": "reverb", "send": 0.2 }] },
 *     { "name": "Voice", "parent": "Master" }
 *   ],
 *   "snapshots": [{ "name": "Paused", "volumes": { "Music": 0.3, "SFX": 0 }, "lowpass": { "Music": 800 } }],
 *   "ducking": [{ "target": "Music", "trigger": "Voice", "amount": 0.4, "attack": 0.1, "release": 0.6 }],
 *   "parameters": [{ "name": "Intensity", "min": 0, "max": 1 }, { "name": "Area", "labels": ["Outdoor", "Cave"] }],  // ADR 0158
 *   "automation": [{ "bus": "Music", "parameter": "Intensity", "target": "volume", "curve": [[0, 0.4], [1, 1]] }]
 * }
 * ```
 */

import type { Curve } from "../core/curve";
import { detectPlatform, type PlatformEnv } from "../core/graphics";
import { audioCurve, parseParameters, type ParameterDef } from "./eventFormat";
import { DEFAULT_MATERIAL_NAME, builtinMaterials, parseOccluderMaterials, resolveDefaultMaterial, type OccluderMaterial } from "./occlusionMaterials";

export type BusEffect =
  | { type: "lowpass"; frequency: number; q: number }
  | { type: "highpass"; frequency: number; q: number }
  | { type: "compressor"; threshold: number; knee: number; ratio: number; attack: number; release: number }
  /** Sends the bus's output to the shared reverb return, `send` (0..1) of its level. */
  | { type: "reverb"; send: number };

export const EFFECT_TYPES = ["lowpass", "highpass", "compressor", "reverb"] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

export interface BusSettings {
  /** Unique. The first bus is the root (Master). */
  name: string;
  /** The bus this one feeds; omitted only on the root. */
  parent?: string;
  /** Linear gain, 0..2 (1 = unity). */
  volume: number;
  mute: boolean;
  effects: BusEffect[];
  /** §2: at most this many sounds play on the bus at once (integer 1..`voices.logical`); absent is unlimited. Inert until the core (M1a). */
  maxVoices?: number;
  /** ADR 0162 §2.1: how the bus gets an ambisonic bed. Absent (never written when default): the root `own`, others `parent`; read it with `busBed`. Inert until beds (A4). */
  bed?: BusBed;
  /** ADR 0162 §2.1: 0..255, higher wins a bed slot. Absent: the root 255, others 128; read it with `busBedPriority`. Inert until beds (A4). */
  bedPriority?: number;
}

export type BusBed = "own" | "parent" | "none";
export const BUS_BEDS = ["own", "parent", "none"] as const;

/** A named mix: per-bus volume multipliers (and optional low-pass cutoffs in Hz) the mixer fades to. */
export interface SnapshotSettings {
  name: string;
  /** Bus name → volume multiplier applied on top of the bus's own volume. Unlisted buses are 1. */
  volumes: Record<string, number>;
  /** Bus name → low-pass cutoff (Hz) applied on top of the bus's effects (muffled music under a pause menu). */
  lowpass: Record<string, number>;
}

/** Lowers `target` while `trigger` has sounds playing: music under voice. */
export interface DuckingRule {
  target: string;
  trigger: string;
  /** Volume multiplier on the target while ducked, 0..1 (0.4 = down 60%). */
  amount: number;
  /** Seconds to reach the ducked level. */
  attack: number;
  /** Seconds to come back. */
  release: number;
}

/** ADR 0158 §3: a bus property driven by a global parameter through a curve. Multiplies with snapshots and ducking (volume) or takes the lowest cutoff (lowpass). */
export interface BusAutomation {
  bus: string;
  parameter: string;
  /** `volume`: a linear gain multiplier; `lowpass`: a cutoff in Hz. */
  target: "volume" | "lowpass";
  curve: Curve;
}

export interface AudioSettings {
  buses: BusSettings[];
  snapshots: SnapshotSettings[];
  ducking: DuckingRule[];
  /** ADR 0158 §2: global parameters (labelled ones are the states). */
  parameters: ParameterDef[];
  /** ADR 0158 §3: bus properties driven by global parameters. */
  automation: BusAutomation[];
  /** ADR 0158 §6: the seed for events' random picks (a whole number); absent: a new seed each run. */
  seed?: number;
  voices: VoiceSettings;
  /** What the page being hidden does to sound. Default `"mute"`. */
  background: AudioBackground;
  /** Clip arena ceiling in MB (integer 16..1024). Absent: the device preset's ceiling (architecture 5.3). */
  clipMemoryMB?: number;
  /** Decoded clip sample format. Default `"i16"`. */
  clipFormat: AudioClipFormat;
  /** `aac`: the audio core also decodes AAC (`.m4a`, `.mp4`, `.aac`), loading its larger AAC decoder build (B4). Default false: AAC assets don't play on the core and warn once each; the Babylon fallback is unaffected. */
  codecs: { aac: boolean };
  /** Default `"hrtf"`. */
  spatial: AudioSpatialMode;
  /** `"core"` (default, K3; `"babylon"` on macOS desktop until its gate passes, see `defaultBackend`) or `"babylon"` (Babylon.js AudioEngineV2, the fallback). The parse never gives the pre-0157 values (it reports them as problems). */
  backend: AudioBackendSetting;
  /**
   * The core's master limiter look-ahead in ms, 0..5, default 1.5 (A2.9). It delays all of the core's output by that
   * much (rounded to whole frames) so the limiter can lower the gain smoothly before a peak; 0 is no delay and an
   * instant attack. Read when the core starts (a reload or rebuild), never mid-session.
   */
  limiterLookaheadMs: number;
  /** ADR 0162 §2.1 (all of the keys below are inert until the feature that uses them lands, M3). */
  bed: BedSettings;
  ambisonic: AmbisonicSettings;
  occlusion: OcclusionSettings;
  zones: ZoneSettings;
  doppler: DopplerSettings;
  /** World units per second, 10..100000, default 343. */
  speedOfSound: number;
}

/** `audio.bed`: integer `maxBeds` 0..4, default 2 (0: no beds). */
export interface BedSettings { maxBeds: number }
/** `audio.ambisonic`: integer `maxClips` 0..4, default 1 (0 refuses ambisonic clips with a warning). */
export interface AmbisonicSettings { maxClips: number }
/** `audio.occlusion` (§2.1, §2.2). */
export interface OcclusionSettings {
  /** Physics layer names that occlude; null (default) is every layer, sensors excluded; an empty list turns occlusion off. */
  layers: string[] | null;
  /** Ray time per frame in ms, 0.02..2, default 0.25. */
  budgetMs: number;
  /** A name in `materials`, default "concrete". */
  defaultMaterial: string;
  /** 10..1000, default 100. */
  smoothingMs: number;
  /** The effective table: the built-ins, overridden or extended by the authored list (at most 32). */
  materials: OccluderMaterial[];
}
/** `audio.zones`: reverb zone slots and IR length (§2.1). Slots = `maxActive + standby`. */
export interface ZoneSettings {
  /** Integer 0..2, default 2 (0: zones inert). */
  maxActive: number;
  /** Integer 0..1, default 1: the spare slot a released zone's tail rings out in. 0: a third zone evicts a ringing slot with a 150 ms fade. */
  standby: number;
  /** Seconds, 0.5..8, default 2; longer IRs are cut with a 50 ms fade. */
  maxIrSeconds: number;
}
/** `audio.doppler`: `maxSpeed` in world units per second, above 0, default 150. */
export interface DopplerSettings { maxSpeed: number }

/** Ranges and defaults of the M3 keys (ADR 0162 §2.1), `[min, max]`. */
export const BED_LIMITS = { maxBeds: [0, 4] } as const;
export const AMBISONIC_LIMITS = { maxClips: [0, 4] } as const;
export const OCCLUSION_LIMITS = { budgetMs: [0.02, 2], smoothingMs: [10, 1000] } as const;
export const ZONE_LIMITS = { maxActive: [0, 2], standby: [0, 1], maxIrSeconds: [0.5, 8] } as const;
export const SPEED_OF_SOUND_LIMITS = [10, 100000] as const;
export const BED_PRIORITY_LIMITS = [0, 255] as const;
export const DEFAULT_BED_MAX_BEDS = 2;
export const DEFAULT_AMBISONIC_MAX_CLIPS = 1;
export const DEFAULT_OCCLUSION_BUDGET_MS = 0.25;
export const DEFAULT_OCCLUSION_SMOOTHING_MS = 100;
export const DEFAULT_ZONES: Readonly<ZoneSettings> = { maxActive: 2, standby: 1, maxIrSeconds: 2 };
export const DEFAULT_DOPPLER_MAX_SPEED = 150;
export const DEFAULT_SPEED_OF_SOUND = 343;
export const DEFAULT_BED_PRIORITY = 128;
export const ROOT_BED_PRIORITY = 255;

/** §2 `voices`: how many sounds the core mixes at once, tracks logically, and spatialises with HRTF. */
export interface VoiceSettings {
  /** Integer 8..512, default 128. */
  mixed: number;
  /** Integer `mixed`..8192, default 4096. */
  logical: number;
  /** Integer 0..32, default 8 (low preset 4; ADR 0162: the voices past it go to the bed, where the bus has one). 0 behaves as `spatial: "equalPower"`. */
  hrtf: number;
}

export type AudioBackground = "mute" | "pause" | "play";
export type AudioClipFormat = "i16" | "f32";
export type AudioSpatialMode = "hrtf" | "equalPower";

/** Which backend plays sound (§2, K3). Pre-ADR-0157 values are accepted as input only, where the parse reports them. */
export type AudioBackendSetting = "babylon" | "core";

export const MASTER = "Master";
export const MAX_BUSES = 32;

export const defaultBuses = (): BusSettings[] =>
  [MASTER, "Music", "SFX", "UI", "Voice"].map((name, i) => ({ name, ...(i > 0 ? { parent: MASTER } : {}), volume: 1, mute: false, effects: [] }));

/** Effects per bus the audio core runs (`MAX_EFFECTS` in `audio-core/src/fx.rs`); one of them at most may be a compressor. */
export const MAX_CORE_BUS_EFFECTS = 4;

/**
 * The backend a project gets without `audio.backend` (B7, ADR 0157): the core. To revert the switch, set this to
 * "babylon" (and `MACOS_DESKTOP_DEFAULT_BACKEND` becomes redundant).
 */
export const DEFAULT_BACKEND: "babylon" | "core" = "core";

/** The default on macOS desktop builds (ADR 0157 Gates): "babylon" until WKWebView passes the macOS gate. Drop it then. */
export const MACOS_DESKTOP_DEFAULT_BACKEND: "babylon" | "core" = "babylon";

/** What `isMacOSDesktop` reads: `detectPlatform`'s inputs plus the platform hints a browser engine gives. */
export interface BackendEnv extends PlatformEnv {
  navigator?: { userAgent?: string; maxTouchPoints?: number; platform?: string; userAgentData?: { platform?: string } };
}

/**
 * True in the desktop shell (Tauri, its `__TAURI_INTERNALS__` marker, the same test as `detectPlatform`) on macOS
 * (WKWebView). A browser, Safari on macOS included, is not macOS desktop, and neither is Tauri on iOS/iPadOS (a touch
 * screen reporting as a Mac). macOS is read from `userAgentData.platform`, `navigator.platform` or the user agent.
 */
export function isMacOSDesktop(env: BackendEnv = globalThis as BackendEnv): boolean {
  if (detectPlatform(env) !== "desktop") return false;
  const nav = env.navigator;
  if ((nav?.maxTouchPoints ?? 0) > 1 || /iPhone|iPad|iPod/i.test(nav?.userAgent ?? "")) return false;
  return /mac/i.test(nav?.userAgentData?.platform ?? "") || /^mac/i.test(nav?.platform ?? "") || /Macintosh|Mac OS X/.test(nav?.userAgent ?? "");
}

/** The backend a project gets when `audio.backend` is absent: `DEFAULT_BACKEND`, except `MACOS_DESKTOP_DEFAULT_BACKEND` on macOS desktop. An explicit `audio.backend` always wins. */
export function defaultBackend(env?: BackendEnv): "babylon" | "core" {
  return isMacOSDesktop(env) ? MACOS_DESKTOP_DEFAULT_BACKEND : DEFAULT_BACKEND;
}

export const DEFAULT_VOICES: Readonly<VoiceSettings> = { mixed: 128, logical: 4096, hrtf: 8 };

/** `audio.limiterLookaheadMs` when absent (`DEFAULT_LOOKAHEAD_MS` in `audio-dsp/src/limiter.rs`). */
export const DEFAULT_LIMITER_LOOKAHEAD_MS = 1.5;
/** `audio.limiterLookaheadMs`'s range (`MAX_LOOKAHEAD_MS` in `audio-dsp/src/limiter.rs`). */
export const LIMITER_LOOKAHEAD_LIMITS = [0, 5] as const;

export const defaultAudioSettings = (): AudioSettings => ({
  buses: defaultBuses(), snapshots: [], ducking: [], parameters: [], automation: [],
  voices: { ...DEFAULT_VOICES }, background: "mute", clipFormat: "i16", codecs: { aac: false }, spatial: "hrtf", backend: defaultBackend(),
  limiterLookaheadMs: DEFAULT_LIMITER_LOOKAHEAD_MS,
  bed: { maxBeds: DEFAULT_BED_MAX_BEDS }, ambisonic: { maxClips: DEFAULT_AMBISONIC_MAX_CLIPS },
  occlusion: { layers: null, budgetMs: DEFAULT_OCCLUSION_BUDGET_MS, defaultMaterial: DEFAULT_MATERIAL_NAME, smoothingMs: DEFAULT_OCCLUSION_SMOOTHING_MS, materials: builtinMaterials() },
  zones: { ...DEFAULT_ZONES }, doppler: { maxSpeed: DEFAULT_DOPPLER_MAX_SPEED }, speedOfSound: DEFAULT_SPEED_OF_SOUND,
});

/** A bus's bed mode with the default applied: the root (first bus) `own`, others `parent`. Unknown bus: `parent`. */
export function busBed(a: Pick<AudioSettings, "buses">, name: string): BusBed {
  const bus = a.buses.find((b) => b.name === name);
  return bus?.bed ?? (a.buses[0]?.name === name ? "own" : "parent");
}

/** A bus's bed priority with the default applied: the root 255, others 128. Unknown bus: 128. */
export function busBedPriority(a: Pick<AudioSettings, "buses">, name: string): number {
  const bus = a.buses.find((b) => b.name === name);
  return bus?.bedPriority ?? (a.buses[0]?.name === name ? ROOT_BED_PRIORITY : DEFAULT_BED_PRIORITY);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

function parseEffect(raw: unknown, where: string, problems: string[]): BusEffect | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !(EFFECT_TYPES as readonly string[]).includes(raw.type)) {
    problems.push(`${where}: effect type must be one of ${EFFECT_TYPES.join(", ")}.`);
    return null;
  }
  switch (raw.type as EffectType) {
    case "lowpass": return { type: "lowpass", frequency: num(raw.frequency, 20000, 10, 24000), q: num(raw.q, 1, 0.0001, 30) };
    case "highpass": return { type: "highpass", frequency: num(raw.frequency, 20, 10, 24000), q: num(raw.q, 1, 0.0001, 30) };
    case "compressor":
      return {
        type: "compressor", threshold: num(raw.threshold, -24, -100, 0), knee: num(raw.knee, 30, 0, 40),
        ratio: num(raw.ratio, 12, 1, 20), attack: num(raw.attack, 0.003, 0, 1), release: num(raw.release, 0.25, 0, 1),
      };
    case "reverb": return { type: "reverb", send: num(raw.send, 0.2, 0, 1) };
  }
}

/** The `audio` section, read leniently: bad entries are dropped or clamped, and each is reported in `problems`. */
export function parseAudioSettings(input: unknown, options: AudioParseOptions = {}): { settings: AudioSettings; problems: string[] } {
  const problems: string[] = [];
  if (input === undefined) return { settings: defaultAudioSettings(), problems };
  if (!isRecord(input)) return { settings: defaultAudioSettings(), problems: ["audio must be an object."] };
  const settings = defaultAudioSettings();

  if (input.buses !== undefined) {
    const buses: BusSettings[] = [];
    if (!Array.isArray(input.buses)) problems.push("audio.buses must be a list.");
    else {
      input.buses.forEach((raw, i) => {
        const where = `audio.buses[${i}]`;
        if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim() === "") return void problems.push(`${where}: name must be a non-empty string.`);
        if (buses.some((b) => b.name === raw.name)) return void problems.push(`${where}: another bus is already named "${raw.name}".`);
        const effects: BusEffect[] = [];
        if (Array.isArray(raw.effects)) raw.effects.forEach((e, j) => { const fx = parseEffect(e, `${where}.effects[${j}]`, problems); if (fx) effects.push(fx); });
        // The audio core runs a bus's first MAX_CORE_BUS_EFFECTS effects and at most one compressor (`audio-core/src/fx.rs`).
        // Kept as authored (the Web Audio reference runs them all); the problem says what the core skips.
        if (effects.length > MAX_CORE_BUS_EFFECTS) problems.push(`${where}: the audio core runs only the first ${MAX_CORE_BUS_EFFECTS} effects of a bus; the rest are skipped.`);
        if (effects.filter((fx) => fx.type === "compressor").length > 1) problems.push(`${where}: the audio core runs one compressor per bus (the first); the others are skipped.`);
        buses.push({
          name: raw.name,
          ...(typeof raw.parent === "string" ? { parent: raw.parent } : {}),
          volume: num(raw.volume, 1, 0, 2),
          mute: raw.mute === true,
          effects,
        });
      });
    }
    if (buses.length > 0) {
      // The root is the first bus; others without a valid parent hang off it. Cycles are cut the same way.
      const root = buses[0];
      delete root.parent;
      for (const b of buses.slice(1)) {
        if (b.parent === undefined || !buses.some((o) => o.name === b.parent) || b.parent === b.name) {
          if (b.parent !== undefined) problems.push(`audio.buses: "${b.name}" names the unknown parent "${b.parent}"; using "${root.name}".`);
          b.parent = root.name;
        }
      }
      for (const b of buses.slice(1)) {
        const seen = new Set([b.name]);
        for (let p = buses.find((o) => o.name === b.parent); p; p = buses.find((o) => o.name === p!.parent)) {
          if (seen.has(p.name)) { problems.push(`audio.buses: "${b.name}" is in a parent loop; using "${root.name}".`); b.parent = root.name; break; }
          seen.add(p.name);
        }
      }
      if (buses.length > MAX_BUSES) problems.push(`audio.buses: at most ${MAX_BUSES} buses; the rest are ignored.`);
      settings.buses = buses.slice(0, MAX_BUSES);
    }
  }
  const known = (name: unknown): name is string => typeof name === "string" && settings.buses.some((b) => b.name === name);

  if (Array.isArray(input.snapshots)) {
    for (const [i, raw] of input.snapshots.entries()) {
      if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") { problems.push(`audio.snapshots[${i}]: name must be a non-empty string.`); continue; }
      const volumes: Record<string, number> = {}, lowpass: Record<string, number> = {};
      for (const [bus, v] of Object.entries(isRecord(raw.volumes) ? raw.volumes : {})) {
        if (known(bus)) volumes[bus] = num(v, 1, 0, 2); else problems.push(`audio.snapshots[${i}]: unknown bus "${bus}".`);
      }
      for (const [bus, v] of Object.entries(isRecord(raw.lowpass) ? raw.lowpass : {})) {
        if (known(bus)) lowpass[bus] = num(v, 24000, 10, 24000); else problems.push(`audio.snapshots[${i}]: unknown bus "${bus}".`);
      }
      settings.snapshots.push({ name: raw.name, volumes, lowpass });
    }
  }
  if (Array.isArray(input.ducking)) {
    for (const [i, raw] of input.ducking.entries()) {
      if (!isRecord(raw) || !known(raw.target) || !known(raw.trigger)) { problems.push(`audio.ducking[${i}]: target and trigger must name buses.`); continue; }
      if (raw.target === raw.trigger) { problems.push(`audio.ducking[${i}]: a bus can't duck itself.`); continue; }
      settings.ducking.push({ target: raw.target, trigger: raw.trigger, amount: num(raw.amount, 0.4, 0, 1), attack: num(raw.attack, 0.1, 0, 10), release: num(raw.release, 0.5, 0, 10) });
    }
  }
  parseCoreKeys(input, settings, problems);
  parseSpatialKeys(input, settings, problems, options);
  parseEventKeys(input, settings, problems);
  return { settings, problems };
}

/** What the parse can't know from the `audio` section alone. */
export interface AudioParseOptions {
  /** The project's physics layer names. When given, `audio.occlusion.layers` entries not in it are dropped with a problem; when absent they are kept as authored. */
  physicsLayers?: readonly string[];
}

/**
 * Integer `min`..`max`: a finite number is rounded then clamped (a problem only when clamping changed it).
 * `undefined` gives `undefined` with no problem; a non-number, NaN or Infinity gives `undefined` plus a problem.
 */
function wholeNumber(raw: unknown, key: string, min: number, max: number, problems: string[]): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    problems.push(`${key}: must be a whole number from ${min} to ${max}.`);
    return undefined;
  }
  const rounded = Math.round(raw);
  const clamped = Math.min(max, Math.max(min, rounded));
  if (clamped !== rounded) problems.push(`${key}: ${rounded} is outside ${min}..${max}; using ${clamped}.`);
  return clamped;
}

/** `audio.limiterLookaheadMs`: a number clamped to 0..5 (a problem when clamped); absent is 1.5; anything else is 1.5 plus a problem. */
function lookaheadMs(raw: unknown, problems: string[]): number {
  const key = "audio.limiterLookaheadMs";
  const [min, max] = LIMITER_LOOKAHEAD_LIMITS;
  if (raw === undefined) return DEFAULT_LIMITER_LOOKAHEAD_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    problems.push(`${key}: must be a number of milliseconds from ${min} to ${max}; using ${DEFAULT_LIMITER_LOOKAHEAD_MS}.`);
    return DEFAULT_LIMITER_LOOKAHEAD_MS;
  }
  const clamped = Math.min(max, Math.max(min, raw));
  if (clamped !== raw) problems.push(`${key}: ${raw} is outside ${min}..${max}; using ${clamped}.`);
  return clamped;
}

/** An enum: `undefined` gives `fallback`; any other value outside `options` gives `fallback` plus a problem. */
function pick<T extends string>(raw: unknown, key: string, options: readonly T[], fallback: T, problems: string[]): T {
  if (raw === undefined) return fallback;
  if (typeof raw === "string" && (options as readonly string[]).includes(raw)) return raw as T;
  problems.push(`${key}: must be one of ${options.join(", ")}; using "${fallback}".`);
  return fallback;
}

/**
 * §2, K13: parse every key the core adds, leniently, into `settings` (which already holds the parsed buses,
 * snapshots and ducking, and the defaults), appending to `problems`. Runs after the buses are parsed, so
 * `settings.buses` is the final list. Keys the playing backend doesn't use yet stay inert.
 */
function parseCoreKeys(input: Record<string, unknown>, settings: AudioSettings, problems: string[]): void {
  if (input.voices !== undefined) {
    if (!isRecord(input.voices)) problems.push("audio.voices must be an object.");
    else {
      const v = input.voices;
      const mixed = wholeNumber(v.mixed, "audio.voices.mixed", 8, 512, problems) ?? DEFAULT_VOICES.mixed;
      const logical = wholeNumber(v.logical, "audio.voices.logical", mixed, 8192, problems) ?? DEFAULT_VOICES.logical;
      const hrtf = wholeNumber(v.hrtf, "audio.voices.hrtf", 0, 32, problems) ?? DEFAULT_VOICES.hrtf;
      settings.voices = { mixed, logical, hrtf };
    }
  }
  settings.background = pick(input.background, "audio.background", ["mute", "pause", "play"] as const, "mute", problems);
  const clipMemoryMB = wholeNumber(input.clipMemoryMB, "audio.clipMemoryMB", 16, 1024, problems);
  if (clipMemoryMB !== undefined) settings.clipMemoryMB = clipMemoryMB;
  settings.clipFormat = pick(input.clipFormat, "audio.clipFormat", ["i16", "f32"] as const, "i16", problems);
  if (input.codecs !== undefined) {
    if (!isRecord(input.codecs)) problems.push("audio.codecs must be an object.");
    else {
      const aac = input.codecs.aac;
      if (aac !== undefined && typeof aac !== "boolean") problems.push("audio.codecs.aac: must be true or false; using false.");
      settings.codecs = { aac: aac === true };
    }
  }
  settings.spatial = pick(input.spatial, "audio.spatial", ["hrtf", "equalPower"] as const, "hrtf", problems);
  settings.limiterLookaheadMs = lookaheadMs(input.limiterLookaheadMs, problems);
  if (input.backend !== undefined) {
    if (input.backend === "babylon" || input.backend === "core") settings.backend = input.backend;
    else if (input.backend === "howler") {
      settings.backend = "babylon";
      problems.push(`audio.backend "howler" was replaced by "babylon" (ADR 0157); using "babylon".`);
    }
    else if (input.backend === "fmod") problems.push(`audio.backend "fmod" was removed (ADR 0157); using "${defaultBackend()}".`);
    else problems.push(`audio.backend must be "babylon" or "core".`);
  }
  // `settings.voices` is parsed above, so `voices.logical` is the bound. Only the first valid entry per name counts,
  // the same entry the bus parse kept.
  if (Array.isArray(input.buses)) {
    const named = new Set<string>();
    for (const [i, raw] of input.buses.entries()) {
      if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim() === "" || named.has(raw.name)) continue;
      named.add(raw.name);
      const bus = settings.buses.find((b) => b.name === raw.name);
      if (!bus) continue;
      if (raw.maxVoices !== undefined && raw.maxVoices !== null) {
        const maxVoices = wholeNumber(raw.maxVoices, `audio.buses[${i}].maxVoices`, 1, settings.voices.logical, problems);
        if (maxVoices !== undefined) bus.maxVoices = maxVoices;
      }
      // ADR 0162 §2.1: stored only when authored and valid; `busBed` and `busBedPriority` apply the defaults.
      if (raw.bed !== undefined && raw.bed !== null) {
        const fallback = bus === settings.buses[0] ? "own" : "parent";
        const bed = pick(raw.bed, `audio.buses[${i}].bed`, BUS_BEDS, fallback, problems);
        if (raw.bed === bed) bus.bed = bed;
      }
      if (raw.bedPriority !== undefined && raw.bedPriority !== null) {
        const [lo, hi] = BED_PRIORITY_LIMITS;
        const bedPriority = wholeNumber(raw.bedPriority, `audio.buses[${i}].bedPriority`, lo, hi, problems);
        if (bedPriority !== undefined) bus.bedPriority = bedPriority;
      }
    }
  }
}

/** A number `min`..`max`: clamped (a problem when clamping changed it); absent is `fallback`; a non-number or NaN is `fallback` plus a problem. */
function rangedNumber(raw: unknown, key: string, min: number, max: number, fallback: number, problems: string[]): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    problems.push(`${key}: must be a number from ${min} to ${max}; using ${fallback}.`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, raw));
  if (clamped !== raw) problems.push(`${key}: ${raw} is outside ${min}..${max}; using ${clamped}.`);
  return clamped;
}

/** A section object (`audio.zones`…): `undefined` gives `undefined`, a non-object gives `undefined` plus a problem. */
function section(raw: unknown, key: string, problems: string[]): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (isRecord(raw)) return raw;
  problems.push(`${key} must be an object.`);
  return undefined;
}

/**
 * ADR 0162 §2.1: `bed`, `ambisonic`, `occlusion`, `zones`, `doppler`, `speedOfSound`, parsed leniently into `settings`
 * (the bus `bed` and `bedPriority` are parsed with the buses in `parseCoreKeys`). Every key is inert until the feature
 * that uses it lands.
 */
function parseSpatialKeys(input: Record<string, unknown>, settings: AudioSettings, problems: string[], options: AudioParseOptions): void {
  const bed = section(input.bed, "audio.bed", problems);
  if (bed) settings.bed.maxBeds = wholeNumber(bed.maxBeds, "audio.bed.maxBeds", ...BED_LIMITS.maxBeds, problems) ?? DEFAULT_BED_MAX_BEDS;
  const ambisonic = section(input.ambisonic, "audio.ambisonic", problems);
  if (ambisonic) settings.ambisonic.maxClips = wholeNumber(ambisonic.maxClips, "audio.ambisonic.maxClips", ...AMBISONIC_LIMITS.maxClips, problems) ?? DEFAULT_AMBISONIC_MAX_CLIPS;

  const occ = section(input.occlusion, "audio.occlusion", problems);
  if (occ) {
    const o = settings.occlusion;
    o.layers = occlusionLayers(occ.layers, options.physicsLayers, problems);
    o.budgetMs = rangedNumber(occ.budgetMs, "audio.occlusion.budgetMs", ...OCCLUSION_LIMITS.budgetMs, DEFAULT_OCCLUSION_BUDGET_MS, problems);
    o.smoothingMs = rangedNumber(occ.smoothingMs, "audio.occlusion.smoothingMs", ...OCCLUSION_LIMITS.smoothingMs, DEFAULT_OCCLUSION_SMOOTHING_MS, problems);
    if (occ.materials !== undefined) o.materials = parseOccluderMaterials(occ.materials, "audio.occlusion.materials", problems);
    o.defaultMaterial = resolveDefaultMaterial(occ.defaultMaterial, o.materials, "audio.occlusion.defaultMaterial", problems);
  }

  const zones = section(input.zones, "audio.zones", problems);
  if (zones) {
    settings.zones = {
      maxActive: wholeNumber(zones.maxActive, "audio.zones.maxActive", ...ZONE_LIMITS.maxActive, problems) ?? DEFAULT_ZONES.maxActive,
      standby: wholeNumber(zones.standby, "audio.zones.standby", ...ZONE_LIMITS.standby, problems) ?? DEFAULT_ZONES.standby,
      maxIrSeconds: rangedNumber(zones.maxIrSeconds, "audio.zones.maxIrSeconds", ...ZONE_LIMITS.maxIrSeconds, DEFAULT_ZONES.maxIrSeconds, problems),
    };
  }

  const doppler = section(input.doppler, "audio.doppler", problems);
  if (doppler && doppler.maxSpeed !== undefined) {
    const v = doppler.maxSpeed;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) settings.doppler.maxSpeed = v;
    else problems.push(`audio.doppler.maxSpeed: must be a number above 0; using ${DEFAULT_DOPPLER_MAX_SPEED}.`);
  }
  settings.speedOfSound = rangedNumber(input.speedOfSound, "audio.speedOfSound", ...SPEED_OF_SOUND_LIMITS, DEFAULT_SPEED_OF_SOUND, problems);
}

/** `audio.occlusion.layers`: null or absent is null (every layer); a list keeps its distinct strings (a problem for each other entry, and for each name outside `known` when given); an empty list is occlusion off; anything else is null plus a problem. */
function occlusionLayers(raw: unknown, known: readonly string[] | undefined, problems: string[]): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    problems.push("audio.occlusion.layers: must be a list of layer names or null; using null (every layer).");
    return null;
  }
  const out: string[] = [];
  raw.forEach((name, i) => {
    if (typeof name !== "string" || name === "") return void problems.push(`audio.occlusion.layers[${i}]: must be a layer name; dropped.`);
    if (known && !known.includes(name)) return void problems.push(`audio.occlusion.layers[${i}]: unknown layer "${name}"; dropped.`);
    if (!out.includes(name)) out.push(name);
  });
  return out;
}

/** ADR 0158: `parameters`, `automation` and `seed`. Runs after the buses are parsed, so automation can check bus names. */
function parseEventKeys(input: Record<string, unknown>, settings: AudioSettings, problems: string[]): void {
  settings.parameters = parseParameters(input.parameters, "audio.parameters", problems);
  if (input.automation !== undefined) {
    if (!Array.isArray(input.automation)) problems.push("audio.automation must be a list.");
    else input.automation.forEach((raw, i) => {
      const where = `audio.automation[${i}]`;
      if (!isRecord(raw)) return void problems.push(`${where}: must be an object; dropped.`);
      if (typeof raw.bus !== "string" || !settings.buses.some((b) => b.name === raw.bus)) return void problems.push(`${where}: bus must name a bus; dropped.`);
      if (typeof raw.parameter !== "string" || !settings.parameters.some((p) => p.name === raw.parameter)) return void problems.push(`${where}: parameter must name a global parameter; dropped.`);
      if (raw.target !== "volume" && raw.target !== "lowpass") return void problems.push(`${where}: target must be "volume" or "lowpass"; dropped.`);
      const curve = audioCurve(raw.curve, `${where}.curve`, problems);
      if (!curve) return void problems.push(`${where}: the curve has no keys; dropped.`);
      settings.automation.push({ bus: raw.bus, parameter: raw.parameter, target: raw.target, curve });
    });
  }
  const seed = wholeNumber(input.seed, "audio.seed", 0, 0xffffffff, problems);
  if (seed !== undefined) settings.seed = seed;
}
