/**
 * Internal (ADR 0330, 0331; ABI 4.8): how an effect-parameter automation (`fx:<id>:<param>`) becomes a curve the audio
 * core evaluates. The core takes a catalogue parameter by its index in the type's parameters (the order it reads them
 * in), and evaluates a frequency parameter (the catalogue's `log` scale) on a curve of its log2, taking 2^value, so it
 * interpolates in log scale as the mixer and the Studio draw it. One place for the bus chains (`runtimeView.ts`) and the
 * instance submixes (the playlist runtime), so the two can't drift apart.
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve, CurveKey } from "../../core/curve";
import { effectSpec, isEffectType } from "../effects/catalogue";

/** The most parameters an effect carries on the core's wire (bus chains' `p[7]`; a submix has 8). */
export const CORE_FX_PARAMS = 7;

/** Where the core finds catalogue parameter `param` of effect type `type`: its index and whether it is log scale; null when the type has no such parameter (or none the core carries). */
export function fxParamSlot(type: string, param: string): { index: number; log: boolean } | null {
  if (!isEffectType(type)) return null;
  const params = effectSpec(type).params;
  const index = params.findIndex((p) => p.name === param);
  if (index < 0 || index >= CORE_FX_PARAMS) return null;
  return { index, log: params[index]!.scale === "log" };
}

/** The smallest value a log2 curve takes (a frequency key at 0 Hz or below would be -∞). */
const MIN_LOG_VALUE = 1e-3;

const log2 = (v: number): number => Math.log2(Math.max(MIN_LOG_VALUE, v));

/**
 * `curve` with every value as its log2 (keys at or below 0 read as 0.001), for a log-scale parameter: the core takes
 * 2^value. A Bézier key's handles keep their shape: each handle's offset is re-measured in log2 from its key.
 */
export function log2Curve(curve: Curve): CurveKey[] {
  return curve.map((k): CurveKey => {
    const y = log2(k[1]);
    if (k.length < 3) return [k[0], y];
    if (k[2] !== "bezier") return [k[0], y, k[2]] as CurveKey;
    const h = k[3];
    const at = (dy: number) => log2(k[1] + dy) - y;
    return [k[0], y, "bezier", { ...h, in: [h.in[0], at(h.in[1])], out: [h.out[0], at(h.out[1])] }];
  });
}
