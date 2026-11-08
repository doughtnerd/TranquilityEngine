/**
 * Render features (ADR 0130): which Components each feature of a renderer owns, when it syncs, and
 * whether it loads lazily. Renderer-neutral (ADR 0010): a backend registers its features with these
 * specs and runs them with `byPhase` and `ownerOf`, so the ordering rules live here once, as data.
 */
import type { Component } from "../core/Component";
import type { World } from "../core/World";

/**
 * When a feature syncs each frame, in this order. Between phases the renderer does its own steps:
 * - after `content`: it syncs cameras and collects shadow casters (from what content drew);
 * - after `effects`: it works out whether the content has loaded and which meshes probes capture;
 * - after `overlay`: it syncs the editor tools.
 * Inside a phase, features run in registration order.
 */
export const SYNC_PHASES = ["content", "lighting", "effects", "capture", "surfaces", "overlay"] as const;

/** @internal One of `SYNC_PHASES`. */
export type SyncPhase = (typeof SYNC_PHASES)[number];

/** @internal A Component class a feature owns. */
export type ComponentClass = abstract new () => Component;

/** @internal What a renderer knows about one of its features before it has loaded (ADR 0130). */
export interface RenderFeatureSpec {
  /** For logs and diagnostics. */
  name: string;
  phase: SyncPhase;
  /** The Component types it draws. A lazy feature is needed once the World has one (unless `needed` says otherwise). */
  types: readonly ComponentClass[];
  /** Whether it owns `c` (gets its `release`). Default: `c` is an instance of one of `types`. */
  owns?(c: Component): boolean;
  /** Loaded on first need (ADR 0083: games without it never download it). */
  lazy: boolean;
  /** Lazy only: whether the World needs it now. Default: the World has a Component of one of `types`. */
  needed?(world: World): boolean;
  /** Lazy only: while it's loading, a World's first frame stays on the clear colour (ADR 0120). */
  holdsFirstFrame?: boolean;
}

/** Whether `spec` owns `c`. */
export function specOwns(spec: RenderFeatureSpec, c: Component): boolean {
  return spec.owns ? spec.owns(c) : spec.types.some((t) => c instanceof t);
}

/** Whether a lazy `spec` is needed by `world` now. */
export function specNeeded(spec: RenderFeatureSpec, world: World): boolean {
  if (spec.needed) return spec.needed(world);
  return spec.types.some((t) => world._componentsOfType(t).length > 0);
}

/** The index of the first spec that owns `c` (so overlaps are decided by registration order), or -1. */
export function ownerOf(specs: readonly RenderFeatureSpec[], c: Component): number {
  return specs.findIndex((s) => specOwns(s, c));
}

/** Spec indices in run order: by phase, then registration order inside a phase. */
export function byPhase(specs: readonly RenderFeatureSpec[]): number[] {
  return specs.map((s, i) => ({ p: SYNC_PHASES.indexOf(s.phase), i })).sort((a, b) => a.p - b.p || a.i - b.i).map((e) => e.i);
}
