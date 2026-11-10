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
 *   "ducking": [{ "target": "Music", "trigger": "Voice", "amount": 0.4, "attack": 0.1, "release": 0.6 }]
 * }
 * ```
 */

import { detectPlatform, type PlatformEnv } from "../core/graphics";

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
}

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

export interface AudioSettings {
  buses: BusSettings[];
  snapshots: SnapshotSettings[];
  ducking: DuckingRule[];
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
}

/** §2 `voices`: how many sounds the core mixes at once, tracks logically, and spatialises with HRTF. */
export interface VoiceSettings {
  /** Integer 8..512, default 128. */
  mixed: number;
  /** Integer `mixed`..8192, default 4096. */
  logical: number;
  /** Integer 0..32, default 16 (low preset 4). 0 behaves as `spatial: "equalPower"`. */
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

export const DEFAULT_VOICES: Readonly<VoiceSettings> = { mixed: 128, logical: 4096, hrtf: 16 };

/** `audio.limiterLookaheadMs` when absent (`DEFAULT_LOOKAHEAD_MS` in `audio-dsp/src/limiter.rs`). */
export const DEFAULT_LIMITER_LOOKAHEAD_MS = 1.5;
/** `audio.limiterLookaheadMs`'s range (`MAX_LOOKAHEAD_MS` in `audio-dsp/src/limiter.rs`). */
export const LIMITER_LOOKAHEAD_LIMITS = [0, 5] as const;

export const defaultAudioSettings = (): AudioSettings => ({
  buses: defaultBuses(), snapshots: [], ducking: [],
  voices: { ...DEFAULT_VOICES }, background: "mute", clipFormat: "i16", codecs: { aac: false }, spatial: "hrtf", backend: defaultBackend(),
  limiterLookaheadMs: DEFAULT_LIMITER_LOOKAHEAD_MS,
});

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
export function parseAudioSettings(input: unknown): { settings: AudioSettings; problems: string[] } {
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
  return { settings, problems };
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
      if (!bus || raw.maxVoices === undefined || raw.maxVoices === null) continue;
      const maxVoices = wholeNumber(raw.maxVoices, `audio.buses[${i}].maxVoices`, 1, settings.voices.logical, problems);
      if (maxVoices !== undefined) bus.maxVoices = maxVoices;
    }
  }
}
