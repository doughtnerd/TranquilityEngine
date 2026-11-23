// What the animation components' engine lifecycle does (ADR 0007's internal hooks). Each component calls one hooks
// object, which the feature that owns the component's runtime state fills (`features/instances.ts` for Animators,
// Skeletons and BoneAttachments, `features/skinning.ts`, `features/sprites2d.ts`, `features/timeline.ts`), so a later
// task changes its feature file, never the component file. Every hook is optional and must not throw.

/** @internal Lifecycle hooks of one animation component class. */
export interface LifecycleHooks<C> {
  /** Once, when the component is added to a node. */
  attach?(component: C): void;
  /** Once, when the component is removed or its node destroyed. */
  detach?(component: C): void;
  /** Whenever the component becomes active and enabled. */
  activate?(component: C): void;
  /** Whenever the component stops being active and enabled. */
  deactivate?(component: C): void;
}
