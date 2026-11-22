// The preset's share of the core's INIT record past the M2 five (ADR 0162 K2, K4 and C8; ADR 0166 W1; ADR 0328): the
// counts `presetFromSettings` (context.ts) reads from the project's `audio` settings into the `CorePreset`, which the
// shell writes into the INIT record (`worklet/coreMemory.ts`). Each sizes a region the core lays out before the arena;
// 0 lays out nothing. The settings parser already holds every value in its range (`AUDIO_NUMBERS`), and the core refuses
// anything else naming the field (`ERR_INIT_MAX_BEDS`, ...), so nothing here clamps again.
//
// K4 kept these functions here rather than in `beds.ts`, `zones.ts` and `listener.ts`: this file must stay a leaf
// (it imports only the settings type), because `worklet/coreDriver.ts` imports it and `tests/e2e/audio-parity/
// coreRender.ts` puts coreDriver in `tsconfig.node.json`'s program; the feature files reach `context.ts` (and its
// `?worker&url` import) through the voice table, which that program can't type.
import type { AudioSettings } from "../../../../engine/audio/settings";

/** @internal The four ABI 2.0 counts as the preset carries them (`zoneMaxSeconds` becomes INIT `zoneMaxFrames` at the context rate). */
export interface SpatialInitParams {
  /** Bed slots (INIT `maxBeds`): `audio.bed.maxBeds`. */
  readonly maxBeds: number;
  /** Zone convolver slots (INIT `maxZoneSlots`). */
  readonly maxZoneSlots: number;
  /** The longest zone IR in seconds; the shell turns it into `zoneMaxFrames` at the context rate. 0 without slots. */
  readonly zoneMaxSeconds: number;
  /** Wide (3-16 channel) stream rings and their private decoders (INIT `maxWide`): `audio.ambisonic.maxClips`. */
  readonly maxWide: number;
}

/** @internal The ABI 3.0 count (ADR 0166 M4, API section 4.5) as the preset carries it. */
export interface MusicInitParams {
  /** Music stream rings (INIT `maxMusicRings`): `audio.music.rings`. 0 refuses streamed stems; decoded stems still play. */
  readonly maxMusicRings: number;
}

/**
 * @internal The spatial counts: `audio.bed.maxBeds` beds, `audio.ambisonic.maxClips` wide rings (each with a private
 * decoder), and `maxActive + standby` zone slots of `maxIrSeconds` (OD2: 3 on high and default, the standby slot letting a
 * released zone ring out; 1 on low). `maxActive` 0 makes zones inert: no slot is laid out.
 */
export function spatialInitParams(settings: AudioSettings): SpatialInitParams {
  const z = settings.zones;
  const zones = z.maxActive > 0 ? { maxZoneSlots: z.maxActive + z.standby, zoneMaxSeconds: z.maxIrSeconds } : { maxZoneSlots: 0, zoneMaxSeconds: 0 };
  return { maxBeds: settings.bed.maxBeds, ...zones, maxWide: settings.ambisonic.maxClips };
}

/** @internal The music count: `audio.music.rings`. */
export function musicInitParams(settings: AudioSettings): MusicInitParams {
  return { maxMusicRings: settings.music.rings };
}
