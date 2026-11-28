// The Animation plugin's runtime half (ADR 0133, 0135, 0370–0372): its Components, buffers, built-in systems and
// feature registrations, over the engine's Rust/WebAssembly core (`wasm/`, loaded lazily by the core feature). `myco`
// exports its public parts (`./public.ts`); the ragdoll plugin imports `PHYSICAL_ANIMATION` from here. Runtime code:
// never imports from `src/editor/` or the plugin's `editor/` folder.
//
// `activate()` is written once: Components, systems (predicted root motion only with physics, ADR 0374), then every
// feature's registration seam (`features/<feature>/register.ts`) in a fixed order, so each build task fills only its
// own seam.
import type { RuntimePlugin, RuntimePluginContext } from "../../runtimeContext";
import { animationManifest } from "../manifest";
import { Animator } from "./components/Animator";
import { BoneAttachment } from "./components/BoneAttachment";
import { Skeleton } from "./components/Skeleton";
import { Skeleton2D } from "./components/Skeleton2D";
import { SkinnedMeshRenderer } from "./components/SkinnedMeshRenderer";
import { TimelineDirector } from "./components/TimelineDirector";
import { registerAttachments } from "./features/attachments/register";
import { registerBones } from "./features/bones/register";
import { registerCore } from "./features/core/register";
import { registerDebug } from "./features/debug/register";
import { registerEvents } from "./features/events/register";
import { registerGraph } from "./features/graph/register";
import { registerIK } from "./features/ik/register";
import { registerMatching } from "./features/matching/register";
import { registerMusic } from "./features/music/register";
import { registerNetwork } from "./features/network/register";
import { registerNodes } from "./features/nodes/register";
import { registerPhysical } from "./features/physical/register";
import { registerPlayback } from "./features/playback/register";
import { registerProfiler } from "./features/profiler/register";
import { registerProperties } from "./features/properties/register";
import { registerRetarget } from "./features/retarget/register";
import { registerSkinning } from "./features/skinning/register";
import { registerSprites2D } from "./features/sprites2d/register";
import { registerTimeline } from "./features/timeline/register";
import { registerTweens } from "./features/tweens/register";
import { registerWarp } from "./features/warp/register";
import type { AnimationIntegrations, FeatureRegistration } from "./registration";
import { ANIMATION_SYSTEMS, PREDICTED_ROOT_MOTION_SYSTEM } from "./systems";

export * from "./public";
export type * from "./types";

// First-party plugins only (the ragdoll plugin, ADR 0375): not exported from `myco`.
export { PHYSICAL_ANIMATION, type PhysicalAnimationClient, type PhysicalAnimationSource, type RagdollBodyPose, type RagdollBoneDescription, type RagdollControl, type RagdollDescription, type RagdollDrives, type RagdollDriveTarget, type RagdollRig } from "./ragdoll";

// First-party plugins only (the ragdoll builder, T55): authoring reads; not exported from `myco`.
export { boneWorldMatrixOf, defaultRagdollDescription, loadSkeletonBytes, readSkeletonInfo, type SkeletonInfo } from "./authoring";

/** The feature seams, in registration order: the core first (its World service), then what plays through it. */
const FEATURES: readonly FeatureRegistration[] = [
  registerCore, // T13t: the AnimationCore World service (lazy wasm load)
  registerSkinning, // T16: the skinning render feature
  registerPlayback, // T17
  registerAttachments, // T17: the post-propagation hook
  registerProperties, // T20t
  registerEvents, // T20t
  registerSprites2D, // T21
  registerTweens, // T22t
  registerTimeline, // T22t
  registerGraph, // T32
  registerBones, // T32
  registerNetwork, // T33
  registerIK, // T40t
  registerWarp, // T40t
  registerRetarget, // T41t
  registerMatching, // T42t
  registerPhysical, // T44
  registerNodes, // T45t
  registerMusic, // T72 (audio only)
  registerProfiler, // T34
  registerDebug, // T60
];

export const animationRuntimePlugin: RuntimePlugin = {
  manifest: animationManifest,
  activate(context: RuntimePluginContext) {
    const on: AnimationIntegrations = { physics: context.plugins.isActive("myco.physics"), audio: context.plugins.isActive("myco.audio") };
    context.registerComponents([Skeleton, SkinnedMeshRenderer, Skeleton2D, Animator, BoneAttachment, TimelineDirector]);
    context.registerEngineSystems(on.physics ? [...ANIMATION_SYSTEMS, PREDICTED_ROOT_MOTION_SYSTEM] : ANIMATION_SYSTEMS);
    for (const register of FEATURES) register(context, on);
  },
};
