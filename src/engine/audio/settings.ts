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
  codecs: { aac: boolean };
  /** Default `"hrtf"`. */
  spatial: AudioSpatialMode;
  /** `"babylon"` (default; resolves to the Howler backend until BB2) or `"core"` (K3). Once A0.4-L1 lands the parse never gives `"howler"` or `"fmod"`. */
  backend: AudioBackendSetting;
  /** @deprecated A0.5 removes it with the FMOD backend. Once A0.4-L1 lands the parse drops it. */
  fmod?: { sdkPath: string; banks: string[] };
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

/**
 * Which backend plays sound (§2, K3). `"howler"` and `"fmod"` are pre-ADR-0157 values the parse maps away;
 * they stay in the type only until A0.5 removes the FMOD and editor code that names them.
 */
export type AudioBackendSetting = "babylon" | "core" | "howler" | "fmod";

export const MASTER = "Master";
export const MAX_BUSES = 32;

export const defaultBuses = (): BusSettings[] =>
  [MASTER, "Music", "SFX", "UI", "Voice"].map((name, i) => ({ name, ...(i > 0 ? { parent: MASTER } : {}), volume: 1, mute: false, effects: [] }));

export const DEFAULT_VOICES: Readonly<VoiceSettings> = { mixed: 128, logical: 4096, hrtf: 16 };

export const defaultAudioSettings = (): AudioSettings => ({
  buses: defaultBuses(), snapshots: [], ducking: [],
  voices: { ...DEFAULT_VOICES }, background: "mute", clipFormat: "i16", codecs: { aac: false }, spatial: "hrtf", backend: "babylon",
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
  // A0.4-L1: the backend and fmod lines up to the `return` are replaced by `parseCoreKeys`; delete them.
  if (input.backend === "fmod") settings.backend = "fmod";
  else if (input.backend !== undefined && input.backend !== "howler") problems.push(`audio.backend must be "howler" or "fmod".`);
  if (isRecord(input.fmod) && typeof input.fmod.sdkPath === "string") {
    settings.fmod = { sdkPath: input.fmod.sdkPath, banks: Array.isArray(input.fmod.banks) ? input.fmod.banks.filter((b): b is string => typeof b === "string") : [] };
  }
  if (settings.backend === "fmod" && !settings.fmod) problems.push(`audio.backend "fmod" needs audio.fmod.sdkPath.`);
  // A0.4-L1: delete `CORE_KEYS_PARSED` and this `if` (call `parseCoreKeys` unconditionally) once it is filled in.
  if (CORE_KEYS_PARSED) parseCoreKeys(input, settings, problems);
  return { settings, problems };
}

/** A0.4-L1: false while `parseCoreKeys` is a stub, so the section still parses as before. */
const CORE_KEYS_PARSED = false;

/**
 * §2, K13: parse every key the core adds, leniently, into `settings` (which already holds the parsed buses,
 * snapshots and ducking, and the defaults), appending to `problems`. Runs after the buses are parsed, so
 * `settings.buses` is the final list. Keys the playing backend doesn't use yet stay inert.
 */
function parseCoreKeys(input: Record<string, unknown>, settings: AudioSettings, problems: string[]): void {
  void input; void settings; void problems;
  throw new Error("not implemented: A0.4-L1");
}
