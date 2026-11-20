// The fade laws main computes with (ADR 0166 §4.2, ADR 0248): one module for the curve a shaped fade follows, its wire code,
// and which law a transition's fade curve uses on each side. The core's music ops (main's estimate of a stamped ramp), the
// Babylon fallback (a shaped fade as linear `setVolume` steps) and the transition planner import it, so the curves can't
// drift apart. The Rust core keeps its own (`audio_dsp::curve_laws`); `golden/seamReference.ts` keeps an independent copy on
// purpose, as the offline reference the seam goldens are checked against.
import type { FadeLaw } from "./backend";
import { FadeLaw as FadeLawCode } from "./wire.generated";

/** The law's weight at phase `p` (0..1, clamped): the share of `to - from` a fade under it has covered. */
export function fadeLawWeight(law: FadeLaw, p: number): number {
  const q = p <= 0 ? 0 : p >= 1 ? 1 : p;
  switch (law) {
    case "sCurve":
      return q * q * (3 - 2 * q);
    case "equalPowerIn":
      return Math.sin((q * Math.PI) / 2);
    case "equalPowerOut":
      return 1 - Math.cos((q * Math.PI) / 2);
    default:
      return q;
  }
}

/** The law's code in the wire's shape word (bits 0-2); an unknown name is linear. */
export function fadeLawCode(law: FadeLaw | undefined): number {
  switch (law) {
    case "sCurve":
      return FadeLawCode.SCurve;
    case "equalPowerIn":
      return FadeLawCode.EqualPowerIn;
    case "equalPowerOut":
      return FadeLawCode.EqualPowerOut;
    default:
      return FadeLawCode.Linear;
  }
}

/** The law a shape word's code names (bits 0-2); an unknown code is linear. */
export function fadeLawOfCode(code: number): FadeLaw {
  switch (code & 7) {
    case FadeLawCode.SCurve:
      return "sCurve";
    case FadeLawCode.EqualPowerIn:
      return "equalPowerIn";
    case FadeLawCode.EqualPowerOut:
      return "equalPowerOut";
    default:
      return "linear";
  }
}

/** A transition's fade curve as authored (`equalPower` is a pair of laws, one per side). */
export type FadeCurve = "linear" | "sCurve" | "equalPower";

/** The law of the incoming side's fade for `curve`. */
export const fadeInLaw = (curve: FadeCurve): FadeLaw => (curve === "equalPower" ? "equalPowerIn" : curve);

/** The law of the outgoing side's fade for `curve`. */
export const fadeOutLaw = (curve: FadeCurve): FadeLaw => (curve === "equalPower" ? "equalPowerOut" : curve);
