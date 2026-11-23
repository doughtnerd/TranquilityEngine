// ADR 0348 "Replay": the take's pick generator state. A playlist's random picks (Queue picks, volume and pitch randomness,
// playback chance) draw from its World's seeded generator (`playlists/host.ts`, one per World). A take records that
// generator's state for the World plays go to (`World.active`, as `Audio.play` does) when it begins (META `seed`) and at
// each keyframe; replay restarts the replaying World's generator from it at the start and at each seek, so the picks
// after it match the recording when the project hasn't changed what they pick from.
import { World } from "../../../../engine/core/World";
import { worldKeyOf } from "../AudioSource";
import { playlistHost } from "../playlists/host";

/** @internal The pick generator state of the World plays go to now (a u32), or null when its picks are unseeded (no `audio.seed`). */
export function activeWorldRandomState(): number | null {
  return playlistHost().randomState(worldKeyOf(World.active));
}

/**
 * @internal Restart the generator of the World plays go to from `state` (a recorded `activeWorldRandomState`) and forget its
 * pick history. False when there is no World to reseed.
 */
export function reseedActiveWorld(state: number): boolean {
  if (!World.active) return false;
  playlistHost().reseedWorld(worldKeyOf(World.active), state);
  return true;
}
