// ADR 0166 adds `musicInitParams` (ABI 3.0, the tenth `myco_audio_init` parameter).
// ADR 0162 (K2, K4; api-and-models §5.2, contract C8): the ABI 2.0 init parameters `myco_audio_init` takes after the
// M2 five, one function per feature, read by `presetFromSettings` (context.ts) into the `CorePreset`. Each sizes a
// region the core lays out before the arena; 0 lays out nothing. They return 0 until their feature's flip (`bedInitParams` has flipped, A5), so an M2
// project's core is laid out as before. **Each flip edits only its own function:** A5 `bedInitParams`
// (`audio.bed.maxBeds`), C5 `zoneInitParams` (`maxActive + standby` slots of `maxIrSeconds`), B5 `wideInitParams`
// (`audio.ambisonic.maxClips`, flipped: every core project pays the `Wide` region and the private decoders in `Beds`).
//
// K4 kept the three functions here rather than in `beds.ts`, `zones.ts` and `listener.ts`: this file must stay a leaf
// (it imports only the settings type), because `worklet/coreDriver.ts` imports it and `tests/e2e/audio-parity/
// coreRender.ts` puts coreDriver in `tsconfig.node.json`'s program; the feature files reach `context.ts` (and its
// `?worker&url` import) through the voice table, which that program can't type.
import type { AudioSettings } from "../../../../engine/audio/settings";
import { MUSIC_RINGS_LIMITS } from "../../../../engine/audio/settings";

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

/** @internal `max_beds` (A5's flip, on: `audio.bed.maxBeds`, 0..4). 0 lays out no bed, as M2. */
export function bedInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxBeds"> {
  const n = Math.floor(settings.bed.maxBeds);
  return { maxBeds: n > 0 ? Math.min(n, 4) : 0 };
}

/**
 * @internal `max_zone_slots` and the IR length (C5, the zone memory flip: `audio.zones`): `maxActive + standby` slots
 * (OD2: 3 on high and default, the standby slot letting a released zone ring out; 1 on low) of `maxIrSeconds` each.
 * `maxActive` 0 makes zones inert: no slot is laid out.
 */
export function zoneInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxZoneSlots" | "zoneMaxSeconds"> {
  const z = settings.zones;
  const active = Math.max(0, Math.min(2, Math.floor(z.maxActive)));
  if (active === 0) return { maxZoneSlots: 0, zoneMaxSeconds: 0 };
  const slots = Math.min(4, active + Math.max(0, Math.min(1, Math.floor(z.standby))));
  return { maxZoneSlots: slots, zoneMaxSeconds: z.maxIrSeconds };
}

/** @internal `max_wide` (B5, the wide memory flip: `audio.ambisonic.maxClips`, 0..4): that many wide stream rings and private decoders are laid out; 0 lays out none and refuses ambisonic clips. */
export function wideInitParams(settings: AudioSettings): Pick<SpatialInitParams, "maxWide"> {
  return { maxWide: settings.ambisonic.maxClips };
}

/** @internal The ABI 3.0 parameter (ADR 0166 M4, API section 4.5) as the preset carries it. */
export interface MusicInitParams {
  /** Music stream rings (`max_music_rings`, 0..16): `audio.music.rings`. 0 refuses streamed stems; decoded stems still play. */
  readonly maxMusicRings: number;
}

/** @internal `max_music_rings` (ABI 3.0, W1): `audio.music.rings` (Q0 parses it into 0..16; clamped again here). */
export function musicInitParams(settings: AudioSettings): MusicInitParams {
  const [lo, hi] = MUSIC_RINGS_LIMITS;
  const n = Math.floor(settings.music.rings);
  return { maxMusicRings: Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0 };
}

/** @internal All four, for `presetFromSettings`. */
export function spatialInitParams(settings: AudioSettings): SpatialInitParams {
  return { ...bedInitParams(settings), ...zoneInitParams(settings), ...wideInitParams(settings) };
}
