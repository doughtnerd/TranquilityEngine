// Code-first playback (ADR 0372; T17): `Animator.play` on a layer of the implicit graph, `crossfade`, `stop`,
// `layerWeight`, `state` and `onFinished`. Plays become commands the gather stage hands to the core
// (`playback/plays.ts`); their promises resolve from the core's state-change records in `animation.Apply`
// (`stages/apply/playback.ts`). On an Animator with a graph, slot plays (with sections), `stop`, `layerWeight` and
// `state` go to the graph runtime (`graph/runtime.ts`, T32).
//
// Layers of the implicit graph are named by index (0–3) or as a numeric string; "Base" names layer 0. A crossfade's
// `mask` (`*.mask.json`) is resolved to the Skeleton's bones (`graph/masks.ts`) and set on its layer (1–3) with
// `SET_LAYER` before the play, in call order; the layer keeps it for later plays until another crossfade names one.
//
// A play or crossfade with `at` (musical timing, T72) is checked here at once (layer, graph, slot) and then held by
// `music.ts` until its music boundary, which queues it then (a crossfade's mask with it) and sends it in that frame.
import type { Animator } from "../components/Animator";
import type { AnimationPlayResult, AnimatorCrossfadeOptions, AnimatorLayer, AnimatorMusicTiming, AnimatorPlayOptions, AnimatorStateInfo, AnimatorStopOptions } from "../types";
import { MAX_LAYERS } from "../wasm/wire/core";
import { flushGraphQueue, graphMeta, graphState, latestSlotPlay, layerWeightIndex, queueLayerWeight, queueSlotPlay, queueSlotStop } from "./graph/runtime";
import { animatorRuntime, clipEntry } from "./instances";
import { forgetHeldPlay, holdPlay, latestHeldPlay, wantsMusic } from "./music";
import { flushQueue, layerState, queueLayerMask, queuePlay, queueStop, stoppedPlay } from "./playback/plays";
import { normalizeAssetPath } from "../../../../engine/scene/assetPath";

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** The implicit graph's layer index for `layer`, or -1 (with a warning) when it names none. */
function layerIndex(animator: Animator, layer: AnimatorLayer | undefined): number {
  if (layer === undefined || layer === "Base") return 0;
  const n = typeof layer === "number" ? layer : /^\d+$/.test(layer) ? Number(layer) : Number.NaN;
  if (Number.isInteger(n) && n >= 0 && n < MAX_LAYERS) return n;
  warnOnce(`layer:${String(layer)}`, `[myco] ${animator.node.name}: an Animator without a graph has layers 0 to ${MAX_LAYERS - 1} ("Base" is 0), not "${String(layer)}".`);
  return -1;
}

const finite = (v: number | undefined, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

interface ImplicitPlay {
  readonly layer: AnimatorLayer | undefined;
  readonly fade: number;
  readonly speed: number | undefined;
  readonly loop: boolean | undefined;
  readonly normalizedTime: number | undefined;
  /** Queued just before the play, on its layer (a crossfade's mask). */
  readonly before?: (layer: number) => void;
}

function startPlay(animator: Animator, clip: string, p: ImplicitPlay, timing: AnimatorMusicTiming, what: string): Promise<AnimationPlayResult> {
  const rt = animatorRuntime(animator);
  if (!rt) return stoppedPlay();
  if (animator.graph) {
    warnOnce(`graph:${animator.node.name}`, `[myco] ${animator.node.name}: Animator has a graph, so play() needs a slot ({ slot: "…" }); the play was refused.`);
    return stoppedPlay();
  }
  const l = layerIndex(animator, p.layer);
  if (l < 0 || !clip) return stoppedPlay();
  const spec = { layer: l, fade: finite(p.fade, 0), speed: finite(p.speed, 1), startNormalized: finite(p.normalizedTime, 0), loop: p.loop };
  if (!wantsMusic(animator, what, timing)) {
    forgetHeldPlay(animator);
    p.before?.(l);
    return queuePlay(rt, clip, spec).promise;
  }
  const entry = clipEntry(rt, clip); // loads while the play waits, so it's ready on the boundary
  return holdPlay(
    animator,
    what,
    timing,
    spec.speed,
    { clip: entry, start: { normalized: spec.startNormalized }, speed: spec.speed },
    (shift) => {
      p.before?.(l);
      return queuePlay(rt, clip, { ...spec, startShift: shift }).promise;
    },
    flushQueue,
  );
}

/** @internal `Animator.play`. */
export function play(animator: Animator, clip: string, options: AnimatorPlayOptions): Promise<AnimationPlayResult> {
  if (options.slot !== undefined) {
    const slot = {
      slot: options.slot,
      fade: Math.max(0, finite(options.fade, 0)),
      speed: finite(options.speed, 1),
      loop: options.loop ?? false,
      section: options.section,
      normalizedTime: finite(options.normalizedTime, 0),
    };
    const rt = animatorRuntime(animator);
    if (!rt || !clip || !wantsMusic(animator, "play", options)) {
      forgetHeldPlay(animator);
      return queueSlotPlay(animator, clip, slot);
    }
    const entry = clipEntry(rt, normalizeAssetPath(clip)); // loads while the play waits
    const start = slot.section === undefined ? { normalized: slot.normalizedTime } : { section: slot.section };
    return holdPlay(
      animator,
      "play",
      options,
      slot.speed,
      { clip: entry, start, speed: slot.speed },
      (shift) => queueSlotPlay(animator, clip, { ...slot, startIn: slot.loop ? 0 : shift }),
      flushGraphQueue,
    );
  }
  if (options.section !== undefined) warnOnce("section", "[myco] Animator.play: sections are played in graph slots ({ slot }); the clip plays from its start.");
  return startPlay(animator, clip, { layer: options.layer, fade: options.fade ?? 0, speed: options.speed, loop: options.loop, normalizedTime: options.normalizedTime }, options, "play");
}

/** @internal `Animator.crossfade`. */
export function crossfade(animator: Animator, clip: string, duration: number, options: AnimatorCrossfadeOptions): Promise<AnimationPlayResult> {
  const rt = animatorRuntime(animator);
  const mask = options.mask;
  if (mask && rt && !animator.graph && clip && layerIndex(animator, options.layer) === 0) {
    warnOnce("mask0", `[myco] ${animator.node.name}: Animator.crossfade: the base layer (0) takes no mask; crossfade on layer 1 to ${MAX_LAYERS - 1} to mask. The clip fades in over the whole body.`);
  }
  const before = mask && rt ? (l: number) => (l > 0 ? queueLayerMask(rt, l, normalizeAssetPath(mask)) : undefined) : undefined;
  return startPlay(animator, clip, { layer: options.layer, fade: duration, speed: options.speed, loop: options.loop, normalizedTime: undefined, before }, options, "crossfade");
}

/** @internal `Animator.stop`. */
export function stop(animator: Animator, options: AnimatorStopOptions): void {
  const rt = animatorRuntime(animator);
  if (!rt) return;
  if (options.slot !== undefined || animator.graph) {
    queueSlotStop(animator, options.slot ?? null, Math.max(0, finite(options.fade, 0)));
    return;
  }
  let layers: number[];
  if (options.layer === undefined) layers = Array.from({ length: MAX_LAYERS }, (_, i) => i);
  else {
    const l = layerIndex(animator, options.layer);
    if (l < 0) return;
    layers = [l];
  }
  queueStop(rt, layers, finite(options.fade, 0));
}

/** @internal `Animator.layerWeight`. */
export function setLayerWeight(animator: Animator, layer: AnimatorLayer, weight: number): void {
  const rt = animatorRuntime(animator);
  if (!rt) return;
  if (animator.graph) {
    const meta = graphMeta(animator);
    const i = meta ? layerWeightIndex(meta, layer) : -1;
    if (i >= 0 && i < MAX_LAYERS) rt.layerWeights[i] = Math.min(1, Math.max(0, finite(weight, 0)));
    else queueLayerWeight(animator, layer, weight); // still loading, or no such layer (warned when it applies)
    return;
  }
  const l = layerIndex(animator, layer);
  if (l < 0) return;
  rt.layerWeights[l] = Math.min(1, Math.max(0, finite(weight, 0)));
}

/** @internal `Animator.state`. */
export function stateOf(animator: Animator, layer: AnimatorLayer): AnimatorStateInfo {
  if (animator.graph) return graphState(animator, layer);
  const rt = animatorRuntime(animator);
  const l = layerIndex(animator, layer);
  return layerState(rt ?? null, l);
}

/** @internal `Animator.onFinished`: the latest play's promise (a resolved `stopped` when nothing was played); a play waiting for its music boundary counts. */
export function finished(animator: Animator): Promise<AnimationPlayResult> {
  const held = latestHeldPlay(animator);
  if (held) return held;
  if (animator.graph) return latestSlotPlay(animator) ?? stoppedPlay();
  return animatorRuntime(animator)?.latest?.promise ?? stoppedPlay();
}
