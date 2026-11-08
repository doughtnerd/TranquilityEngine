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
 * Inside a phase, features run in registration order, except where a feature's `after` names another
 * feature of its phase that must sync first (ADR 0135).
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
  /**
   * Features of the same phase that sync before this one (ADR 0135): `["sky"]` for the lights, since the
   * sky may drive the sun. Names of absent features, or of other phases, are ignored.
   */
  after?: readonly string[];
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

/**
 * Spec indices in run order: by phase, then, inside a phase, registration order adjusted by the `after`
 * constraints (ADR 0135): a stable topological sort, where each step runs the earliest-registered
 * feature whose constraints are met. Throws on a cycle.
 */
export function byPhase(specs: readonly RenderFeatureSpec[]): number[] {
  const out: number[] = [];
  for (const phase of SYNC_PHASES) {
    const members = specs.map((s, i) => ({ s, i })).filter((e) => e.s.phase === phase);
    const names = new Set(members.map((e) => e.s.name));
    const placed = new Set<string>();
    const left = [...members];
    while (left.length > 0) {
      const at = left.findIndex((e) => (e.s.after ?? []).every((n) => !names.has(n) || placed.has(n) || n === e.s.name));
      if (at < 0) throw new Error(`Render features ${left.map((e) => `"${e.s.name}"`).join(", ")} order after each other in a cycle (phase "${phase}").`);
      const [next] = left.splice(at, 1);
      placed.add(next!.s.name);
      out.push(next!.i);
    }
  }
  return out;
}

/**
 * @internal A render feature a plugin contributes (ADR 0135, first-party only): its spec (with its
 * `after` constraints) and a loader for the factory that builds it from the backend's shared host
 * services. The loader is a dynamic import, so the feature's code stays out of the main chunk; a
 * renderer loads an eager feature's factory before it starts, a lazy one's on first need.
 */
export interface RenderFeatureRegistration<Host = never, Feature = unknown> {
  readonly spec: RenderFeatureSpec;
  load(): Promise<(host: Host) => Feature>;
}

const registered: RenderFeatureRegistration[] = [];

/** @internal Register a render feature for renderers created from now on. Returns a function that removes it. */
export function _registerRenderFeature<H, F>(registration: RenderFeatureRegistration<H, F>): () => void {
  const r = registration as unknown as RenderFeatureRegistration;
  if (registered.some((e) => e.spec.name === r.spec.name)) throw new Error(`Render feature "${r.spec.name}" is already registered.`);
  registered.push(r);
  return () => {
    const at = registered.indexOf(r);
    if (at >= 0) registered.splice(at, 1);
  };
}

/** @internal The registered render features, in registration order. */
export function _registeredRenderFeatures(): readonly RenderFeatureRegistration[] {
  return registered;
}
