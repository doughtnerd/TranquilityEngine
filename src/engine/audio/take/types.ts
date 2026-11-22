/**
 * Contract (ADR 0334): a take, `*.mycotake`. One file per recorded run in the capture file's framing: the engine profile
 * (every capture record) plus the requests the game made of audio. These are the decoded shapes of the request records;
 * the profile records keep the capture reader's types (`plugins/audio/runtime/capture/`).
 *
 * Times are seconds on the take's clock (0 = recording start). Pure; no plugin, no DOM.
 */
import type { Vec3 } from "../spatial/testSceneTypes";

export const TAKE_SUFFIX = ".mycotake";
export const TAKE_NOTES_SUFFIX = ".notes.json";
export const TAKE_NOTES_FORMAT = "myco.takenotes@1";

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
  | { kind: "mark"; t: number; text: string };

/** Emitter id 0 is the listener. */
export const LISTENER_EMITTER = 0;

/** Every second: what is alive, for seeking. */
export interface TakeKeyframe {
  t: number;
  instances: { instance: number; path: string; started: number; emitter: number | null; parameters: Record<string, number> }[];
  globals: Record<string, number>;
}

export interface TakeMeta {
  project: string;
  engine: string;
  /** Hash of `audio.json` at start. */
  audioHash: string;
  seed: number;
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
