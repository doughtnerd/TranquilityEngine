// King of Pirates' sounds (ADR 0343, 0344): each sound is a playlist in `sounds/`, which holds its
// level, pitch variation, voice limits, bus and (for sounds heard from where they happen) the shared
// `sounds/sea.attenuation.json` falloff, so scripts only say what happened and where. The mix is in
// `audio.json`: SFX, Weather, UI and Ambience buses (Rain under Ambience), the `Storm` parameter the
// rain bus follows, ducking, and the `Harbour` snapshot under the "Leave the match?" dialog.
import { FxKind } from "./data";

export const UI_CLICK = "sounds/ui-click.playlist.json";

/** The playlist each effect the server reports plays, by `FxKind`. */
export const FX_SOUNDS: Readonly<Record<number, string>> = {
  [FxKind.fire]: "sounds/cannon-fire.playlist.json",
  [FxKind.splash]: "sounds/splash.playlist.json",
  [FxKind.hit]: "sounds/hit.playlist.json",
  [FxKind.crunch]: "sounds/crunch.playlist.json",
  [FxKind.sink]: "sounds/sink.playlist.json",
  [FxKind.lightning]: "sounds/thunder.playlist.json",
  [FxKind.pickup]: "sounds/pickup.playlist.json",
  [FxKind.flag]: "sounds/flag.playlist.json",
  [FxKind.cloud]: "sounds/cloud.playlist.json",
};

/** The global parameter (0..1) the weather sets as a storm builds and passes: the rain bus's level and the sea's brightness follow it. */
export const STORM_PARAMETER = "Storm";

/** The snapshot that dips and muffles the sea and the guns while the "Leave the match?" dialog is open. */
export const HARBOUR_SNAPSHOT = "Harbour";
