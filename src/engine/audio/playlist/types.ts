/**
 * Contract (ADR 0329): the playlist asset, `*.playlist.json` (`myco.playlist@1`). One playlist per file; embedded
 * playlists are inline objects of the same shape without `format`. These are the parsed (canonical) shapes the parse
 * (`format.ts`) produces and the writer writes; every optional field here is optional in the file too.
 *
 * Times are seconds unless a field says `Ms`. Gains are dB, pitch semitones.
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve } from "../../core/curve";
import type { Attenuation } from "../attenuation/types";
import type { Effect } from "../effects/types";
import type { ParameterDef } from "../parameters";

export const PLAYLIST_FORMAT = "myco.playlist@1";
export const PLAYLIST_SUFFIX = ".playlist.json";

export const PLAYLIST_TYPES = ["clip", "queue", "switch", "blend", "layer", "sequence"] as const;
export type PlaylistType = (typeof PLAYLIST_TYPES)[number];

// --- shared pieces ---------------------------------------------------------------------------------------------------

/** How many instances may play and what happens when full (prototype "Playback"). */
export interface PlaybackRules {
  plays: "oneShot" | "untilStopped";
  /** 0 = no limit, else 1..32. */
  maxInstances: number;
  whenFull: "stealOldest" | "stealQuietest" | "stealFarthest" | "refuse";
  /** Seconds since the last accepted trigger, 0..5. */
  cooldown: number;
  /** 0..1. */
  chance: number;
  /** Seconds, 0..2. */
  delay: number;
  /** 0..255, default 128 (the engine's voice priority). */
  priority: number;
}

/** A playlist's spatial block (ADR 0333). `attenuation` is a preset path or inline curves. */
export interface PlaylistSpatial {
  attenuation: string | Attenuation | null;
  occlusion: boolean;
  /** Doppler level, 0..5. */
  doppler: number;
  /** Degrees; null = from the attenuation's spread curve, else 0. */
  spread: number | null;
}

/** What a curve is keyed on (ADR 0332: time is a parameter). */
export type CurveInput = "voiceTime" | "clipTime" | "sequenceTime" | { parameter: string };

/** Per-entry voice curves (prototype "voice curves"): property → curve. */
export interface VoiceCurve {
  input: CurveInput;
  curve: Curve;
  bypass: boolean;
}
export type VoiceCurveTarget = "gain" | "pitch" | "pan" | "lowpass" | "highpass";

/**
 * Automation on sequence clips and tracks and on a playlist instance (`PlaylistBody.automation`): `fx:<effectId>:<param>`
 * targets an effect parameter of the owner's own chain.
 */
export interface Automation {
  id: string;
  target: "volume" | "pitch" | "pan" | "enabled" | `fx:${string}:${string}`;
  input: CurveInput;
  curve: Curve;
  bypass: boolean;
}

/** A loop's behaviour, shared by sample loops (ADR 0328), clip loop overrides and sequence loops. */
export interface LoopBehaviour {
  active: "always" | "held" | "parameter";
  /** Only for `active: "parameter"` (a clip override or a sequence loop). */
  binding?: { parameter: string; op: ">" | "<"; value: number };
  exit: "finish" | "jump" | "crossfade";
  exitFadeMs: number;
  reentry: "ignore" | "reenter";
}

// --- entries ---------------------------------------------------------------------------------------------------------

/** Settings that belong to one use of an entry (not to the entry's playlist). */
export interface EntryUse {
  volume: number;
  pitch: number;
  /** Queue random weight, 0..100 (0 = never). */
  weight: number;
  /** Blend position, in the axis's units. */
  x?: number;
  y?: number;
  atZeroWeight: "stop" | "continue";
  curves: Partial<Record<VoiceCurveTarget, VoiceCurve>>;
}

/** A linked playlist (by project path). */
export interface LinkedEntry extends EntryUse { kind: "linked"; playlist: string }
/** An embedded playlist, owned by its parent. */
export interface EmbeddedEntry extends EntryUse { kind: "embedded"; embedded: PlaylistBody }
/** A sample; only inside a Clip playlist. */
export interface SampleEntry extends EntryUse {
  kind: "sample";
  sample: string;
  /** Seconds in the sample; null = the sample's own trim. */
  trim: [number, number] | null;
  loop: "inherit" | "off" | "on";
}
export type Entry = LinkedEntry | EmbeddedEntry | SampleEntry;

// --- type-specific blocks --------------------------------------------------------------------------------------------

export interface QueueSettings {
  pick: "random" | "shuffle" | "roundRobin";
  /** 0..5. */
  avoidRepeat: number;
  /** Back to back until stopped (the engine's continuous containers); null = one pick per trigger. A negative
   *  `gapMs` overlaps consecutive entries with an equal-power crossfade of that length. */
  continuous: { gapMs: number } | null;
}

export type ChangeWhen = "now" | "beat" | "bar" | "exit" | "nextTrigger";
export interface ChangeHow {
  when: ChangeWhen;
  how: "crossfade" | "cut" | "transition";
  length: { ms: number } | { beats: number };
  /** The transition playlist for `how: "transition"`. */
  transition?: Entry;
}
export interface ChangeRule extends ChangeHow {
  /** A label, or `"*"` for any. */
  from: string;
  to: string;
}
export interface SwitchSettings {
  parameter: string;
  /** label → entry index; null = plays nothing. */
  map: Record<string, number | null>;
  labelGain: Record<string, number>;
  onChange: ChangeHow;
  rules: ChangeRule[];
}

export type BlendAxis = { parameter: string } | { voiceTime: number };
export interface Adsr { attackMs: number; decayMs: number; sustain: number; releaseMs: number }
export interface BlendSettings {
  axes: [BlendAxis] | [BlendAxis, BlendAxis];
  fade: "crossfade" | "layer";
  curve: "linear" | "equalPower";
  follow: { glideMs: number } | "hold";
  envelope: { mode: "off" | "morph" | "zone"; low: Adsr; high: Adsr };
}

export interface SequenceLoop extends LoopBehaviour { id: string; start: number; end: number }
/** `exit` markers are where Switch rules timed `exit` and sync clips may leave (ADR 0329); `cue` reports to the game. */
export interface SequenceMarker { id: string; name: string; at: number; type?: "note" | "cue" | "exit" }
export interface Clip {
  id: string;
  /** Exactly one of `sample` / `playlist`. */
  sample?: string;
  playlist?: string | PlaylistBody;
  at: number;
  /** Seconds; 0 = to the end of the source (the sample after its trim, or the playlist's natural length). */
  length: number;
  offset: number;
  gain: number;
  pitch: number;
  pan: number;
  reverse: boolean;
  /** Locked to the playhead. The file default is false; an editor adding a clip uses `defaultClipSync` (`clipDefaults.ts`). */
  sync: boolean;
  enabled: boolean;
  /** Per-clip overrides of the sample's loops, by loop id. */
  loops: Record<string, Partial<LoopBehaviour> & { start?: number; end?: number }>;
  hiddenMarkers: string[];
  effects: Effect[];
  automation: Automation[];
}
export interface Track {
  id: string;
  name: string;
  kind: "audio" | "playlist";
  /** A theme series index 1..8 or a `#rrggbb` colour. */
  color: number | string;
  volume: number;
  pan: number;
  /** Bus name; null = the sequence's output. */
  output: string | null;
  mute: boolean;
  solo: boolean;
  enabled: boolean;
  effects: Effect[];
  automation: Automation[];
  clips: Clip[];
}
export interface SequenceSettings {
  /** Seconds; 0 = to the end of the longest clip. */
  length: number;
  tempo: { bpm: number; meter: string } | null;
  tracks: Track[];
  loops: SequenceLoop[];
  markers: SequenceMarker[];
}

export interface Stinger {
  trigger: string;
  playlist: Entry;
  at: "now" | "beat" | "bar" | "exit" | "hit";
  ifLate: "nextGrid" | "playNow" | "skip";
  /** Seconds. */
  dontRepeat: number;
}

// --- the playlist ----------------------------------------------------------------------------------------------------

/** A playlist without its `format` line: what an embedded entry holds. */
export interface PlaylistBody {
  type: PlaylistType;
  /** Bus name; null = inherited from the referencing playlist, else Master. */
  output: string | null;
  playback: PlaybackRules;
  volume: number;
  pitch: number;
  volumeRandom: [number, number];
  pitchRandom: [number, number];
  effects: Effect[];
  /**
   * Instance-level automation (ADR 0329, decision log D23): curves on the playing instance of this playlist, over all
   * its voices. Targets `volume`, `pitch`, `pan`, `enabled` and `fx:<id>:<param>` (an effect of this playlist's own
   * `effects`); input `voiceTime` (seconds since this playlist started playing) or a parameter. The parse turns a
   * `clipTime` or `sequenceTime` input (which belong to sequence clips and tracks) into `voiceTime`.
   */
  automation: Automation[];
  spatial: PlaylistSpatial | null;
  parameters: ParameterDef[];
  stingers: Stinger[];
  /** A help note shown on the title. */
  note?: string;
  entries: Entry[];
  queue: QueueSettings | null;
  switch: SwitchSettings | null;
  blend: BlendSettings | null;
  sequence: SequenceSettings | null;
}

/** The asset file. */
export interface PlaylistAsset extends PlaylistBody {
  format: typeof PLAYLIST_FORMAT;
}

/** What the parse returns (the engine's lenient parse: never throws). */
export interface PlaylistParse {
  playlist: PlaylistAsset;
  problems: string[];
}
