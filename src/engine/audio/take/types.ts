/**
 * Contract (ADR 0348): a take, `*.sporesample`. One file per recorded run in the capture file's framing: the engine profile
 * (every capture record) plus the requests the game made of audio. These are the decoded shapes of the request records;
 * the profile records keep the capture reader's types (`plugins/audio/runtime/capture/`).
 *
 * Times are seconds on the take's clock (0 = recording start). Pure; no plugin, no DOM.
 */
import type { Vec3 } from "../spatial/testSceneTypes";

export const TAKE_SUFFIX = ".sporesample";
export const TAKE_NOTES_SUFFIX = ".notes.json";
export const TAKE_NOTES_FORMAT = "myco.takenotes@1";

/**
 * A take picture's width, pixels (`FRAME`; its height keeps the view's aspect), settable per build at run time
 * (`setTakeFrameWidth`, the audio topic's `take.frames`): at least this...
 */
export const TAKE_PICTURE_MIN_WIDTH = 64;
/**
 * ...and at most this (well inside `TAKE_FRAME_MAX_SIDE`; a picture that encodes past `TAKE_FRAME_MAX_BYTES` makes the
 * take step its width down rather than lose pictures, `takeFrames.ts`).
 */
export const TAKE_PICTURE_MAX_WIDTH = 1920;
/** The width a build takes pictures at until told otherwise. */
export const TAKE_PICTURE_DEFAULT_WIDTH = 640;

/** Play options that matter for replay (a subset of `EventOptions` / one-shot options). */
export interface TakePlayOptions {
  volume?: number;
  pitch?: number;
  bus?: string;
  priority?: number;
  parameters?: Record<string, number>;
}

export type TakeRequest =
  | { kind: "play"; t: number; instance: number; path: string; emitter: number | null; options: TakePlayOptions }
  | { kind: "stop"; t: number; instance: number; fade: number }
  | { kind: "release"; t: number; instance: number }
  | { kind: "param"; t: number; instance: number | null; name: string; value: number }
  | { kind: "pose"; t: number; emitter: number; position: Vec3; velocity: Vec3; forward?: Vec3 }
  | { kind: "mix"; t: number; op: "busVolume" | "busFade" | "snapshotStart" | "snapshotStop" | "masterVolume"; target: string; value: number; seconds: number }
  | { kind: "trigger"; t: number; instance: number; name: string }
  | { kind: "mark"; t: number; text: string }
  /** ADR 0354 §10: a line played by key (`Audio.line`), in the language it was heard in (null: nothing played). */
  | { kind: "line"; t: number; instance: number; key: string; language: string | null; options: TakePlayOptions }
  /** ADR 0354 §10, 0357 §2: the audio and subtitle languages changed (subtitles null: following the text language). */
  | { kind: "language"; t: number; audio: string; subtitles: string | null }
  /**
   * ADR 0355 §6: `Audio.say` as asked: the resolved value of every argument (globals and defaults included, so replay
   * doesn't depend on the order globals changed in), its options, what it did (`state`), the pick (null while queued:
   * a queued say decides when it starts) and the World generator's state just before it decided (absent: unseeded).
   */
  | { kind: "say"; t: number; instance: number; event: string; args: Record<string, string>; options: TakeSayOptions; state: TakeSayState; picked: TakeSayPick | null; random?: number }
  /** ADR 0355 §6: a queued say started (with its pick, decided then) or was dropped. */
  | { kind: "sayState"; t: number; instance: number; state: "playing" | "dropped"; picked: TakeSayPick | null; random?: number }
  /** ADR 0386: a handle paused or resumed its instance (playlist and `AudioSource` handles). */
  | { kind: "pause"; t: number; instance: number }
  | { kind: "resume"; t: number; instance: number }
  /** ADR 0386: a handle faded its instance's fade gain to `to` (linear, 0..4) over `seconds`. */
  | { kind: "fade"; t: number; instance: number; to: number; seconds: number };

/** What a say did when asked: started, waits in its channel's queue, or was refused (`picked.none` says why). */
export type TakeSayState = "playing" | "queued" | "refused";

/** A say's pick: the line and the path index that gave it, or why there was none (an `AudioReason`). */
export type TakeSayPick = { key: string; pathIndex: number } | { none: string };

/** `SayOptions` a take keeps (the play options, the channel, priority and `whenBusy`). */
export interface TakeSayOptions extends TakePlayOptions {
  channel?: string;
  whenBusy?: "queue" | "interrupt" | "drop";
}

/** Emitter id 0 is the listener. */
export const LISTENER_EMITTER = 0;

/** Every second: what is alive, for seeking. */
export interface TakeKeyframe {
  t: number;
  instances: { instance: number; path: string; started: number; emitter: number | null; parameters: Record<string, number> }[];
  globals: Record<string, number>;
  /**
   * The pick generator's state of the World the game played in (`World.active`), a u32, at the keyframe: replay restarts
   * the Studio World's generator from it at a seek, so random picks after it match the recording. Absent when the World's
   * picks were unseeded (no `audio.seed`) or in a take recorded before it was written.
   */
  random?: number;
}

export interface TakeMeta {
  project: string;
  engine: string;
  /** Hash of `audio.json` at start. */
  audioHash: string;
  /**
   * The pick generator's state of the World the game played in, a u32, when the take began (the first keyframe's
   * `random`): replay restarts the Studio World's generator from it, so random picks match the recording. (Takes
   * recorded before ADR 0348's reseed carry `audio.seed` here.)
   */
  seed: number;
  /** False when the project had no `audio.seed` (picks were unseeded; `seed` is then 0). Absent: true. */
  seeded?: boolean;
  device: string;
  started: string;
  duration: number;
  /** Names of emitters by id (entity names or paths), for display. */
  emitters: Record<number, string>;
  frames: boolean;
}

/** Designer annotations beside a take (`<take>.notes.json`), an asset document with history. */
export interface TakeNotes {
  format: typeof TAKE_NOTES_FORMAT;
  markers: { id: string; at: number; text: string; color: number }[];
  regions: { id: string; from: number; to: number; text: string; color: number }[];
}

/** A picture of the game view (`FRAME`, optional, about once a second): a small JPEG. */
export interface TakeFrame {
  t: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
}
