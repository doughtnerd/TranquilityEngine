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

/**
 * ADR 0336: a length in milliseconds or in beats of the playing entry's musical clock (a beat is the fallback 500 ms
 * without one).
 */
export type TimeLength = { ms: number } | { beats: number };

/**
 * ADR 0336: the shape of a fade (the Wwise set, less its duplicate sine): `equalPower` is sin in / cos out (power
 * complementary), `sCurve` and `invSCurve` smoothstep and its inverse, `logN` change fast at first (1 − (1 − u)^p, p
 * 1.41, 2, 3), `expN` change slowly at first (u^p). The levels are `fadeShapes.ts`'s.
 */
export const FADE_SHAPES = ["linear", "equalPower", "sCurve", "invSCurve", "log1", "log2", "log3", "exp1", "exp2", "exp3"] as const;
export type FadeShape = (typeof FADE_SHAPES)[number];

/** ADR 0336: one fade: its length and shape. */
export interface Fade { length: TimeLength; shape: FadeShape }

/**
 * ADR 0336: when automation keyed on a parameter takes effect: the next beat, bar or `beats`-beat boundary (counted from
 * the bar) of the instance's musical clock, as a stamped 20 ms ramp starting exactly there. Absent: continuously.
 */
export type Quantize = "beat" | "bar" | { beats: number };

/** What a curve is keyed on (ADR 0332: time is a parameter). */
export type CurveInput = "voiceTime" | "clipTime" | "sequenceTime" | { parameter: string };

/** Per-entry voice curves (prototype "voice curves"): property → curve. */
export interface VoiceCurve {
  input: CurveInput;
  curve: Curve;
  bypass: boolean;
  /** A curve keyed on a parameter moves only on this musical boundary (as `Automation.quantize`); absent: continuously. */
  quantize?: Quantize;
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
  /**
   * ADR 0336: a parameter-keyed lane moves only on this musical boundary; absent: continuously. Volume, enabled, pitch,
   * pan and the effect parameters the voice carries (low-pass and high-pass cutoff, a gain effect's gain) take it.
   */
  quantize?: Quantize;
}

/** A loop's behaviour, shared by sample loops (ADR 0328), clip loop overrides and sequence loops. */
export interface LoopBehaviour {
  active: "always" | "held" | "parameter";
  /** Only for `active: "parameter"` (a clip override or a sequence loop). */
  binding?: { parameter: string; op: ">" | "<"; value: number };
  exit: "finish" | "jump" | "crossfade";
  exitFadeMs: number;
  reentry: "ignore" | "reenter";
  /**
   * ADR 0336 (the audio core's ABI 4.9): a sample loop's seam crossfade shape (also its hold point's fades, a jump exit
   * and a re-entry); absent: equalPower. Sequence loops splice and ignore it.
   */
  crossfadeShape?: FadeShape;
  /** ADR 0336: the exit crossfade's shape (`exit: "crossfade"`; a sequence loop's both sides); absent: equalPower. */
  exitShape?: FadeShape;
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
  /** ADR 0336: a 1D Blend entry's explicit region on the axis; absent: derived from `x` and its neighbours (ADR 0329's weights). */
  region?: BlendRegion;
  /**
   * ADR 0336: a Blend entry's weight curve: its raw weight (0..1; 2D the barycentric or edge weight, 1D after its region)
   * in, its gain (0..1) out. Absent: today's (the weight, √ for equal power). With `curve: "equalPower"` a 2D blend whose
   * entries have curves is normalised to constant power.
   */
  weightCurve?: Curve;
}

/**
 * ADR 0336 (FMOD instrument regions, Wwise blend-track ranges): where a 1D Blend entry plays, in the axis's units. Its
 * weight is 0 outside [start, end], ramps up over `fadeIn` from `start` and down over `fadeOut` to `end`, 1 between.
 * The shapes default to the blend's `curve` (`linear` or `equalPower`).
 */
export interface BlendRegion {
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
  shapeIn?: FadeShape;
  shapeOut?: FadeShape;
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
   *  `gapMs` overlaps consecutive entries with a crossfade of that length and `shape` (ADR 0336; absent: equalPower). */
  continuous: { gapMs: number; shape?: FadeShape } | null;
}

export type ChangeWhen = "now" | "beat" | "bar" | "exit" | "nextTrigger";
export interface ChangeHow {
  when: ChangeWhen;
  how: "crossfade" | "cut" | "transition";
  length: TimeLength;
  /** The transition playlist for `how: "transition"`. */
  transition?: Entry;
  /** ADR 0336: the outgoing and incoming fade shapes over `length`; absent: equalPower. */
  shapeOut?: FadeShape;
  shapeIn?: FadeShape;
  /**
   * ADR 0336 (Wwise post-exit): when the outgoing entry has an Exit marker, its audio plays on past the hand-over to its
   * natural end instead of being cut (a crossfade still fades it out). Absent: true; false cuts as before.
   */
  tail?: boolean;
  /** ADR 0336: the transition playlist's own fade in and fade out (a Wwise transition segment's); absent: the rule's. */
  transitionIn?: Fade;
  transitionOut?: Fade;
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

export interface SequenceLoop extends LoopBehaviour {
  id: string;
  start: number;
  end: number;
  /**
   * ADR 0336: true: on each wrap, the audio between the loop's end and the first `exit` marker after it rings on over
   * the next pass (the music tail; with no Exit marker after the loop's end there is none). Absent: false (a splice).
   */
  tail?: boolean;
  /** ADR 0336: the shape of an `exit: "crossfade"` (both sides); absent: equalPower. */
  exitShape?: FadeShape;
}
/**
 * `exit` markers are where Switch rules timed `exit` and sync clips may leave (ADR 0329) and what follows the first one
 * is the post-exit tail (ADR 0336); `cue` reports to the game; `entry` (ADR 0336, pre-entry) is the point a Switch change
 * lands on its boundary, the audio before it starting early.
 */
export interface SequenceMarker { id: string; name: string; at: number; type?: "note" | "cue" | "exit" | "entry" }
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
