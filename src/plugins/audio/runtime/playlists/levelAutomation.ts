/**
 * Automation lanes as voice controls (ADR 0329 `Automation`): one mapping for sequence clips and tracks (`sequence.ts`)
 * and a playlist's own instance-level lanes (`PlaylistBody.automation`, applied in `bodyCtx`).
 *
 * Targets: `volume`, `pitch`, `enabled` (a step on the gain), `pan` (ABI 4.4), and an effect parameter where the
 * playlist effects adapter (`effects.ts`) maps it onto a voice control: a low-pass or high-pass `cutoff` (ABI 4.4) or a
 * gain effect's `gain`. Every other effect parameter waits for instance submix automation and is skipped with one
 * warning each.
 *
 * Parameter-keyed lanes become automation bindings on the context (`curves.ts`, so the core follows the parameter);
 * time-keyed lanes are returned for the caller to place in time (a sequence shifts them to each voice's clip or sequence
 * time; an instance anchors them at its start). Placed in time they are `TimeCurve`s: gain, pitch and low-pass run on
 * main, pan and high-pass become core bindings on the voice's time when the voice starts (`coreTimeBindings`).
 */
import type { Curve, CurveKey } from "../../../../engine/core/curve";
import type { Automation, VoiceCurve } from "../../../../engine/audio/playlist/types";
import type { Effect } from "../../../../engine/audio/effects/types";
import { effectParamValue } from "../../../../engine/audio/effects/catalogue";
import { warnOnce } from "../core/handle";
import { curveParts, type TimeCurve } from "./curves";
import type { Ctx, NodeHost } from "./liveNode";
import { QuantLane } from "./quantizedLanes";

/** A time-keyed lane, mapped onto a voice control, still to be placed in time. */
export interface TimeAuto {
  target: TimeCurve["target"];
  curve: Curve;
  input: "clipTime" | "sequenceTime" | "voiceTime";
}

/** The gain an `enabled` lane gives when off, dB. */
const STEP_OFF_DB = -120;

/**
 * `list` as voice controls below `ctx`: returns the context with the parameter-keyed lanes' bindings added, and pushes
 * the time-keyed lanes onto `time`. `effects` is the chain `fx:` targets name (the lanes' owner's own).
 */
export function automationParts(host: NodeHost, list: readonly Automation[], effects: readonly Effect[], ctx: Ctx, time: TimeAuto[], where: string): Ctx {
  for (const a of list) {
    if (a.bypass || a.curve.length === 0) continue;
    let target: TimeCurve["target"] | null = null;
    let curve: Curve = a.curve;
    if (a.target === "volume") target = "gain";
    else if (a.target === "pitch") target = "pitch";
    else if (a.target === "enabled") { target = "gain"; curve = a.curve.map((k) => [k[0], k[1] >= 0.5 ? 0 : STEP_OFF_DB, "step"] as CurveKey); }
    else if (a.target === "pan") target = "pan";
    else {
      const [, id, param] = a.target.split(":");
      const fx = effects.find((e) => e.id === id);
      if (fx?.type === "lowpass" && param === "cutoff") target = "lowpass";
      else if (fx?.type === "highpass" && param === "cutoff") target = "highpass";
      else if (fx?.type === "gain" && param === "gain") target = "gain";
      else {
        warnOnce(`playlist:auto-fx:${fx?.type ?? id}:${param}`, `[myco] ${where}: automation of "${a.target}" needs instance submixes (ADR 0331)${fx ? "" : " and names no effect of its level"}; skipped. Low-pass and high-pass cutoff and gain apply.`);
        continue;
      }
      if (target === "gain" && fx) {
        // The curve is the effect's gain; the effect's static gain is already in the level, so automate the difference.
        const base = effectParamValue(fx, "gain") ?? 0;
        curve = a.curve.map((k) => [k[0], k[1] - base, ...k.slice(2)] as unknown as CurveKey);
      }
    }
    if (typeof a.input === "string") {
      if (a.quantize !== undefined) warnOnce(`playlist:quantize-time:${where}:${a.id}`, `[myco] ${where}: automation "${a.id}" is keyed on ${a.input}; quantize applies to parameter-keyed lanes and is ignored.`);
      time.push({ target, curve, input: a.input });
      continue;
    }
    if (a.quantize !== undefined) {
      // ADR 0336: a quantised lane moves on the musical clock: the voices' own gain ramp, or a stepped voice-time binding
      // for pitch, pan and the filters (`quantizedLanes.ts`).
      ctx = { ...ctx, quantized: [...(ctx.quantized ?? []), new QuantLane(a.input.parameter, curve, a.quantize, where, target)] };
      continue;
    }
    const vc: VoiceCurve = { input: a.input, curve, bypass: false };
    const parts = curveParts({ [target]: vc }, ctx, (n) => host.paramRef(n), (c) => host.curveId(c), where);
    ctx = { ...ctx, bindings: parts.bindings };
  }
  return ctx;
}
