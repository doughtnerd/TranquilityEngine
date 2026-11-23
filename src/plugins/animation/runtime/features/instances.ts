// Per-instance runtime state of Animators, Skeletons and BoneAttachments (ADR 0370; T13t gives Animators their core
// instance, T17 the rest): what their lifecycle does. Empty until then, so the components attach, activate and detach
// as plain data.
import type { Animator } from "../components/Animator";
import type { BoneAttachment } from "../components/BoneAttachment";
import type { Skeleton } from "../components/Skeleton";
import type { LifecycleHooks } from "../lifecycle";

/** @internal An Animator's lifecycle (T13t, T17: create its core instance on activation, release it on detach; plays resolve `stopped`). */
export const animatorHooks: LifecycleHooks<Animator> = {};

/** @internal A Skeleton's lifecycle (T17: load its skeleton asset into the core's arena while used). */
export const skeletonHooks: LifecycleHooks<Skeleton> = {};

/** @internal A BoneAttachment's lifecycle (T17: join and leave the post-propagation follow list). */
export const boneAttachmentHooks: LifecycleHooks<BoneAttachment> = {};
