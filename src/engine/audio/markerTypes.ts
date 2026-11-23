/**
 * ADR 0343: a marker passing in a playing playlist, the engine side of it. `AudioPlaylistHandle.onMarker` and the
 * component hook `onAudioMarker` (`LifecycleHooks`, `core/Component.ts`) both pass this; it lives in the engine because
 * the core's hooks can't name the audio plugin's types (the plugin re-exports it as its public `AudioMarkerEvent`).
 *
 * Pure types; no plugin, no DOM.
 */

/** The marker types a game hears: Cue, Exit and Hit markers of samples, and a sequence's `cue` and `exit` markers. */
export type AudioMarkerType = "cue" | "exit" | "hit";

/** What `onMarker` and `onAudioMarker` pass: the marker, the sample it is in and its heard time. */
export interface AudioMarkerEvent {
  type: AudioMarkerType;
  /** The marker's name. */
  name: string;
  /** The sample path it is in. */
  sample: string;
  /** Heard time (seconds, `Audio.time`'s base) it passed at. */
  time: number;
}
