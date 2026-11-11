// The occlusion pass on main (ADR 0162; api-and-models §3.2 "Occlusion state", architecture §3.2). Runs for both
// backends, after zones and before selection, over a `SpatialVoiceView` (never the core's voice table); it hands each
// voice's smoothed result back through `view.setOcclusion(i, gain, lpHz)` (the core folds the gain into the dry gain and
// selection's `occGain`, and the cutoff into `voiceFx`; the Babylon fallback applies the gain only, §8).
//
// D2a fills this file (with `occlusionMath.ts` for smoothing, wet folding and lateral rays): candidates are spatial
// voices with occlusion on and `audibility0` above `MIN_AUDIBILITY`, in the listener's World only (R14); a ray count per
// frame (`budgetMs / rayCost`, the cost an EMA over batches of ≥ 16 rays); a tier of the top 16 by `audibility0` recast
// every frame with at most half the rays, a round-robin cursor for the rest; `raycastInto` (D0) from the listener to the
// source, d − 0.1 m, excluding the source's subtree and the listener's node; materials through D2b's `OccluderCache`;
// one-pole smoothing (τ `occlusion.smoothingMs` or the material's attack/release, cutoff in log2), a voice's first result
// at once; overruns halve the next count. No physics service: no rays, gains 1, one note (`occlusionNoPhysics`).
//
// K4 (the skeleton): no rays; every voice stays open (gain 1, no cutoff), so nothing is handed back.
import type { AudioSettings } from "../../../../engine/audio/settings";
import type { AudioOcclusionDebug } from "../backend";
import { LP_TOP } from "../wire.generated";
import type { ListenerFrame, SpatialVoiceView } from "./spatial";

/** @internal §3.2: the candidate tier recast every frame. */
export const OCCLUSION_TIER = 16;
/** @internal §3.2: rays end this far short of the source, metres (a source inside its own collider still sees the wall). */
export const OCCLUSION_RAY_SHORTEN = 0.1;
/** @internal §3.2: the ray cost assumed until measured, microseconds. */
export const OCCLUSION_DEFAULT_RAY_COST_US = 3.5;

/** @internal The occlusion pass's counters for `Audio.debug()` (§1.6, C24). */
export interface OcclusionCounters {
  occlusionRays: number;
  occlusionUsedMs: number;
  occlusionOverruns: number;
  occlusionSources: number;
  occlusionNoPhysics: number;
  oldestOcclusionAgeFrames: number;
}

/** @internal The occlusion pass over one backend's voices (constructed by the backend, run by the audio system). */
export class OcclusionPass {
  readonly counters: OcclusionCounters = { occlusionRays: 0, occlusionUsedMs: 0, occlusionOverruns: 0, occlusionSources: 0, occlusionNoPhysics: 0, oldestOcclusionAgeFrames: 0 };
  /** Per slot: the smoothed dry gain last handed back (1 open). */
  readonly gain: Float32Array;
  /** Per slot: the smoothed cutoff last handed back, Hz (`LP_TOP` and above: none). */
  readonly cutoff: Float32Array;
  /** Per slot: frames since the voice's last ray. */
  readonly age: Uint16Array;

  constructor(readonly capacity: number) {
    this.gain = new Float32Array(capacity).fill(1);
    this.cutoff = new Float32Array(capacity).fill(LP_TOP);
    this.age = new Uint16Array(capacity);
  }

  /**
   * The frame step (D2a): rank, cast this frame's ray count, smooth, and hand each changed result back through
   * `view.setOcclusion`. K4: nothing (every voice is open).
   */
  run(frame: ListenerFrame, view: SpatialVoiceView, settings: Pick<AudioSettings, "occlusion">): void {
    void frame;
    void view;
    void settings;
  }

  /** Slot `i` was freed: its result and age go (the next voice there starts open, its first result at once). */
  forget(i: number): void {
    if (i < 0 || i >= this.capacity) return;
    this.gain[i] = 1;
    this.cutoff[i] = LP_TOP;
    this.age[i] = 0;
  }

  /** `AudioDebugInfo.occlusion` (§1.6). K4: inert, with the note D2a replaces. */
  debug(): AudioOcclusionDebug {
    return { enabled: false, note: "", budgetRays: 0, rays: 0, rayCostUs: OCCLUSION_DEFAULT_RAY_COST_US, oldestAgeFrames: 0 };
  }
}
