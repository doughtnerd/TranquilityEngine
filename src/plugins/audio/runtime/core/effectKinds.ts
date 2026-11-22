// ADR 0331 (ABI 4.6): the one table from the effect catalogue's types to the audio core's effect kinds, shared by the
// instance submixes (SUBMIX, `submixes.ts`) and the bus chains (BUS_CONFIG / BUS_SLOT, `busIndex.ts`). The core runs
// every type `CORE_EFFECT_TYPES` lists (`engine/audio/busCapability.ts`, the rule module, says which); `effectKinds.test.ts`
// holds the two lists equal. A kind's parameters are the catalogue's, in the catalogue's order, its defaults filled in
// (`audio_dsp::fx` in the core reads them by position).
import { effectSpec } from "../../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../../engine/audio/effects/types";
import type { CoreEffectType } from "../../../../engine/audio/busCapability";
import {
  BUS_FX_CATALOGUE, SUBMIX_FX_BANDPASS, SUBMIX_FX_BITCRUSH, SUBMIX_FX_CHORUS, SUBMIX_FX_COMPRESSOR, SUBMIX_FX_DELAY, SUBMIX_FX_DISTORTION,
  SUBMIX_FX_EQ, SUBMIX_FX_FORMANT, SUBMIX_FX_GAIN, SUBMIX_FX_HIGHPASS, SUBMIX_FX_LIMITER, SUBMIX_FX_LOWPASS, SUBMIX_FX_PITCH, SUBMIX_FX_REVERB,
  SUBMIX_FX_SATURATION, SUBMIX_FX_SIDECHAIN,
} from "../wire.generated";

/** The core's kind for each catalogue type it runs. */
export const FX_KINDS: Readonly<Record<CoreEffectType, number>> = Object.freeze({
  lowpass: SUBMIX_FX_LOWPASS,
  highpass: SUBMIX_FX_HIGHPASS,
  compressor: SUBMIX_FX_COMPRESSOR,
  eq: SUBMIX_FX_EQ,
  bandpass: SUBMIX_FX_BANDPASS,
  saturation: SUBMIX_FX_SATURATION,
  distortion: SUBMIX_FX_DISTORTION,
  bitcrush: SUBMIX_FX_BITCRUSH,
  chorus: SUBMIX_FX_CHORUS,
  delay: SUBMIX_FX_DELAY,
  reverb: SUBMIX_FX_REVERB,
  formantShift: SUBMIX_FX_FORMANT,
  pitchShift: SUBMIX_FX_PITCH,
  limiter: SUBMIX_FX_LIMITER,
  sidechainCompressor: SUBMIX_FX_SIDECHAIN,
  gain: SUBMIX_FX_GAIN,
});

/** The core's kind for catalogue type `type`, or 0 (a type the core doesn't run: passed through). */
export const fxKind = (type: string): number => (FX_KINDS as Readonly<Record<string, number>>)[type] ?? 0;

/** The catalogue parameters of `type` from `params`, in the catalogue's order, defaults filled in, padded with 0 to `n`. */
export function fxParams(type: Effect["type"], params: Readonly<Record<string, number>>, n: number): number[] {
  const p = new Array<number>(n).fill(0);
  effectSpec(type).params.slice(0, n).forEach((q, i) => {
    const v = params[q.name];
    p[i] = typeof v === "number" && Number.isFinite(v) ? v : q.default;
  });
  return p;
}

/** A bus effect type on the wire (BUS_CONFIG / BUS_SLOT) for catalogue type `type`: `BUS_FX_CATALOGUE` plus its kind. */
export const busFxType = (type: CoreEffectType): number => BUS_FX_CATALOGUE + FX_KINDS[type];

/** Where a sidechain compressor's key bus slot goes in a bus effect's `p` (after its three catalogue parameters). */
export const SIDECHAIN_KEY_PARAM = 3;
