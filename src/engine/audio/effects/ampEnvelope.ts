/**
 * The Amp envelope (the catalogue's `envelope`, ADR 0345; on sequence clips, ADR 0362 item 2): attack, hold, decay,
 * sustain and release over a clip instance's own time, the release ending on the clip's end (its key-off). One model for
 * every place that reads the effect: the Studio draws its shape and handles from it (`adsrModel.ts`), the playlist runtime
 * hands its stages to the clip's voices, and the core backend fits it to frames for the audio core's AMP_ENVELOPE, whose
 * per-sample kernel (`native/audio/crates/audio-dsp/src/adsr.rs`) is the one the offline sample render bakes with. So
 * what the clip draws, what it plays and what a bake of it holds are the same envelope.
 *
 * - **Stages** (`ampStages`): the effect's parameters as seconds and a 0..1 sustain.
 * - **A span** (`fitAmpEnvelope`): a clip of `length` squeezes the stages in order (the attack takes what it needs of
 *   the span, then the hold, the decay, and the release last), and the release ends on the span's end: its key-off is
 *   `length - release`. Without a length (`null`) nothing is squeezed and it is never keyed off. Any unit works (seconds
 *   for the Studio, frames for the core), as `Adsr::fit` does in Rust.
 * - **Gain** (`ampEnvelopeGain`): the level rises from 0 to 1 over the attack, holds 1, falls to the sustain over the
 *   decay, holds it; from the key-off it falls from the level reached to 0 over the release, and is 0 after it.
 *
 * Pure; no plugin state.
 */
import { effectSpec } from "./catalogue";
import type { Effect } from "./types";

/** An envelope's stages: seconds (or frames), and the sustain level 0..1. */
export interface AmpStages {
  readonly attack: number;
  readonly hold: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

/** Stages fitted to a span: `keyOff` is where the release starts (null: never). */
export interface FittedAmpEnvelope extends AmpStages {
  readonly keyOff: number | null;
}

const param = (fx: Effect, name: string): number => {
  const v = fx.params[name];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return effectSpec("envelope").params.find((p) => p.name === name)?.default ?? 0;
};

/** The first enabled Amp envelope of a chain, or null. */
export function firstAmpEnvelope(effects: readonly Effect[]): Effect | null {
  return effects.find((e) => e.on && e.type === "envelope") ?? null;
}

/** An Amp envelope effect's stages in seconds (its parameters are ms and %). */
export function ampStages(fx: Effect): AmpStages {
  const ms = (name: string) => Math.max(0, param(fx, name)) / 1000;
  return { attack: ms("attack"), hold: ms("hold"), decay: ms("decay"), sustain: Math.max(0, Math.min(1, param(fx, "sustain") / 100)), release: ms("release") };
}

/** `s` fitted to a span of `length` (null: unbounded): the stages squeezed in order, the release ending on its end. */
export function fitAmpEnvelope(s: AmpStages, length: number | null): FittedAmpEnvelope {
  if (length === null || !Number.isFinite(length)) return { ...s, keyOff: null };
  const len = Math.max(0, length);
  const attack = Math.min(len, s.attack);
  const hold = Math.min(len - attack, s.hold);
  const decay = Math.min(len - attack - hold, s.decay);
  const release = Math.min(len - attack - hold - decay, s.release);
  return { attack, hold, decay, sustain: s.sustain, release, keyOff: len - release };
}

/** The level before any key-off at time `t`. */
function level(e: AmpStages, t: number): number {
  if (t < e.attack) return t / e.attack;
  if (t < e.attack + e.hold) return 1;
  if (t < e.attack + e.hold + e.decay) return 1 - (1 - e.sustain) * ((t - e.attack - e.hold) / e.decay);
  return e.sustain;
}

/** The gain at time `t` of the envelope (0 before it starts). */
export function ampEnvelopeGain(e: FittedAmpEnvelope, t: number): number {
  if (!(t >= 0)) return 0;
  if (e.keyOff === null || t < e.keyOff) return level(e, t);
  const x = t - e.keyOff;
  if (x >= e.release) return 0;
  return level(e, e.keyOff) * (1 - x / e.release);
}
