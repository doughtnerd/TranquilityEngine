// ADR 0162 (K2; api-and-models §5.2, contract C8): the ABI 2.0 init parameters `myco_audio_init` takes after the
// M2 five, one function per feature, read by `presetFromSettings` (context.ts) into the `CorePreset`. Each sizes a
// region the core lays out before the arena; 0 lays out nothing. They return 0 until their feature's flip (K4 owns
// this file from then): beds `audio.bed.maxBeds`, zones `maxActive + standby` slots of `maxIrSeconds`, wide rings
// `audio.ambisonic.maxClips`. No settings key is read before then, so an M2 project's core is laid out as before.
import type { AudioSettings } from "../../../../engine/audio/settings";

/** @internal The four ABI 2.0 parameters as the preset carries them (`zoneMaxSeconds` becomes frames at init). */
export interface SpatialInitParams {
  /** Bed slots (`max_beds`, 0..4). */
  readonly maxBeds: number;
  /** Zone convolver slots (`max_zone_slots`, 0..4). */
  readonly maxZoneSlots: number;
  /** The longest zone IR in seconds; the shell turns it into `zone_max_frames` at the context rate. 0 without slots. */
  readonly zoneMaxSeconds: number;
  /** Wide (3-16 channel) stream rings and their private decoders (`max_wide`, 0..4). */
  readonly maxWide: number;
}

/** @internal `max_beds`. K2: 0 (beds aren't laid out before their flip). */
export function bedInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxBeds"> {
  void settings;
  return { maxBeds: 0 };
}

/** @internal `max_zone_slots` and the IR length. K2: 0 (zones aren't laid out before their flip). */
export function zoneInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxZoneSlots" | "zoneMaxSeconds"> {
  void settings;
  return { maxZoneSlots: 0, zoneMaxSeconds: 0 };
}

/** @internal `max_wide`. K2: 0 (wide rings aren't laid out before their flip). */
export function wideInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxWide"> {
  void settings;
  return { maxWide: 0 };
}

/** @internal All four, for `presetFromSettings`. */
export function spatialInitParams(settings: AudioSettings): SpatialInitParams {
  return { ...bedInitParams(settings), ...zoneInitParams(settings), ...wideInitParams(settings) };
}
