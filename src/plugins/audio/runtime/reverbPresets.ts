/**
 * The reverb zone presets (ADR 0162 R10, ADR 0333). Every preset is a reverb the audio core generates (`IR_GENERATED`,
 * each an `{ rt60, hfDamping, predelayMs }` in `native/audio/crates/audio-dsp/src/convolver/presets.rs`): ADR 0162's
 * `room`, `corridor`, `hall`, `cave` and `open`, and ADR 0333's four named spaces, each with its own times, set from the
 * I3DL2 / EAX environment family its name belongs to:
 *
 * - `smallStone` (1.1 s, HF damping 0.3, 7 ms predelay): a small stone chamber; hard walls keep the highs (EAX "Stone
 *   room", shorter for a small one).
 * - `canyonHall` (4.8 s, HF damping 0.4, 70 ms predelay): rock walls far apart; a long tail with a late onset (between
 *   EAX "Arena" and "Mountains").
 * - `metalTunnel` (2.8 s, HF damping 0.15, 12 ms predelay): metal rings and keeps its highs (EAX "Sewer pipe"'s decay).
 * - `forest` (1.5 s, HF damping 0.46, 60 ms predelay): sparse, distant reflections off trunks, highs soaked up by
 *   foliage (EAX "Forest").
 *
 * The prototype's send levels for them (Small stone −6 dB, Canyon hall −12, Metal tunnel −4, Forest −16) are the zone's
 * `wet`, which stays the zone's own field. A zone's `maxIrSeconds` (`audio.zones`) still cuts a longer response.
 *
 * Pure; no imports (the decoder worker reads it too).
 */

/** The reverbs the audio core generates, in its preset index order (`myco_ir_generate`'s `preset`). */
export const IR_GENERATED = ["room", "corridor", "hall", "cave", "open", "smallStone", "canyonHall", "metalTunnel", "forest"] as const;

/** The built-in reverbs a zone can use without an impulse response. */
export const ZONE_PRESETS = IR_GENERATED;
/** One of `ZONE_PRESETS`. */
export type ZonePreset = (typeof ZONE_PRESETS)[number];

