// ADR 0162 (K2, K4; api-and-models §5.2, contract C8): the ABI 2.0 init parameters `myco_audio_init` takes after the
// M2 five, one function per feature, read by `presetFromSettings` (context.ts) into the `CorePreset`. Each sizes a
// region the core lays out before the arena; 0 lays out nothing. They return 0 until their feature's flip, so an M2
// project's core is laid out as before. **Each flip edits only its own function:** A5 `bedInitParams`
// (`audio.bed.maxBeds`), C5 `zoneInitParams` (`maxActive + standby` slots of `maxIrSeconds`), B5 `wideInitParams`
// (`audio.ambisonic.maxClips`, flipped: every core project pays the `Wide` region and the private decoders in `Beds`).
//
// K4 kept the three functions here rather than in `beds.ts`, `zones.ts` and `listener.ts`: this file must stay a leaf
// (it imports only the settings type), because `worklet/coreDriver.ts` imports it and `tests/e2e/audio-parity/
// coreRender.ts` puts coreDriver in `tsconfig.node.json`'s program; the feature files reach `context.ts` (and its
// `?worker&url` import) through the voice table, which that program can't type.
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

/** @internal `max_beds` (A5's flip: `audio.bed.maxBeds`). 0 until then: no bed is laid out. */
export function bedInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxBeds"> {
  void settings;
  return { maxBeds: 0 };
}

/** @internal `max_zone_slots` and the IR length (C5's flip: `audio.zones`). 0 until then: no zone slot is laid out. */
export function zoneInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxZoneSlots" | "zoneMaxSeconds"> {
  void settings;
  return { maxZoneSlots: 0, zoneMaxSeconds: 0 };
}

/** @internal `max_wide` (B5, the wide memory flip: `audio.ambisonic.maxClips`, 0..4): that many wide stream rings and private decoders are laid out; 0 lays out none and refuses ambisonic clips. */
export function wideInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxWide"> {
  return { maxWide: settings.ambisonic.maxClips };
}

/** @internal All four, for `presetFromSettings`. */
export function spatialInitParams(settings: AudioSettings): SpatialInitParams {
  return { ...bedInitParams(settings), ...zoneInitParams(settings), ...wideInitParams(settings) };
}
