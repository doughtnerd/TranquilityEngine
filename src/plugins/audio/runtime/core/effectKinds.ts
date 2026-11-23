// ADR 0345 (ABI 4.6): the one table from the effect catalogue's types to the audio core's effect kinds, shared by the
// instance submixes (SUBMIX, `submixes.ts`) and the bus chains (BUS_CONFIG / BUS_SLOT, `busIndex.ts`). The core runs
// every type `CORE_EFFECT_TYPES` lists (`engine/audio/busCapability.ts`, the rule module, says which); `effectKinds.test.ts`
// holds the two lists equal. A kind's parameters are the catalogue's, in the catalogue's order, its defaults filled in
// (`audio_dsp::fx` in the core reads them by position).
//
// ADR 0352 (ABI 5.0): records carry `FX_PARAMS` (16) parameters, and a registered plugin effect's kind is
// `FX_PLUGIN_BASE + e`, `e` the index the core backend's plugin host gave it (`effectPlugins/host.ts`, which binds itself
// here with `bindPluginKinds`); a plugin type nobody registered is kind 0 (passed through).
import { effectSpec } from "../../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../../engine/audio/effects/types";
import type { CoreEffectType } from "../../../../engine/audio/busCapability";
import {
  BUS_FX_CATALOGUE, SUBMIX_FX_BANDPASS, SUBMIX_FX_BITCRUSH, SUBMIX_FX_CHORUS, SUBMIX_FX_COMPRESSOR, SUBMIX_FX_DELAY, SUBMIX_FX_DISTORTION,
  SUBMIX_FX_EQ, SUBMIX_FX_FORMANT, SUBMIX_FX_GAIN, SUBMIX_FX_HIGHPASS, SUBMIX_FX_LIMITER, SUBMIX_FX_LOWPASS, SUBMIX_FX_PITCH, SUBMIX_FX_REVERB,
  SUBMIX_FX_SATURATION, SUBMIX_FX_SIDECHAIN, FX_PARAMS,
} from "../wire.generated";

/** ABI 5.0: parameters an effect record carries. */
export const EFFECT_RECORD_PARAMS = FX_PARAMS;

/** The plugin host's kinds (`FX_PLUGIN_BASE + e`, 0 for a type it doesn't run); none until a core backend binds one. */
let pluginKind: (type: string) => number = () => 0;

/**
 * ADR 0352: the core backend's plugin host answers plugin types' kinds from now on (`effectPlugins/host.ts`). Returns the
 * unbind, which restores "no plugin kinds" if this binding is still the current one.
 */
export function bindPluginKinds(kindOf: (type: string) => number): () => void {
  pluginKind = kindOf;
  return () => {
    if (pluginKind === kindOf) pluginKind = () => 0;
  };
}

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

/** The core's kind for catalogue type `type` (a registered plugin effect's included, ABI 5.0), or 0 (a type the core doesn't run: passed through). */
export const fxKind = (type: string): number => (FX_KINDS as Readonly<Record<string, number>>)[type] ?? pluginKind(type);

/** The catalogue parameters of `type` from `params`, in the catalogue's order, defaults filled in, padded with 0 to `n`. */
export function fxParams(type: Effect["type"], params: Readonly<Record<string, number>>, n: number): number[] {
  const p = new Array<number>(n).fill(0);
  effectSpec(type).params.slice(0, n).forEach((q, i) => {
    const v = params[q.name];
    p[i] = typeof v === "number" && Number.isFinite(v) ? v : q.default;
  });
  return p;
}

/** A bus effect type on the wire (BUS_CONFIG / BUS_SLOT) for catalogue type `type`: `BUS_FX_CATALOGUE` plus its kind (a plugin's included, ABI 5.0). */
export const busFxType = (type: CoreEffectType | string): number => BUS_FX_CATALOGUE + fxKind(type);

/** Where a sidechain compressor's key bus slot goes in a bus effect's `p` (after its three catalogue parameters). */
export const SIDECHAIN_KEY_PARAM = 3;
