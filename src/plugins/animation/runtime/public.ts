// The Animation plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { Animator } from "./components/Animator";
export { BoneAttachment } from "./components/BoneAttachment";
export { Skeleton } from "./components/Skeleton";
export { Skeleton2D } from "./components/Skeleton2D";
export { SkinnedMeshRenderer } from "./components/SkinnedMeshRenderer";
export { TimelineDirector } from "./components/TimelineDirector";
export { Tweens } from "./components/Tweens";
export { AnimationEvents, AnimatorStateChanges, RootMotion, type AnimationEvent, type AnimationEventPhase, type AnimatorStateChange, type RootMotionRecord } from "./buffers";
export { tween, sequence, parallel, animatorParams } from "./api";
export type { AnimatorUpdateMode, AnimatorCullingMode, AnimatorRootMotion, AnimatorLodMetric, BoneAttachmentFollow, TimelineWrapMode, SkinnedBoundsMode, AnimatorLayer, AnimatorParameterValue, AnimationPlayEndReason, AnimationPlayResult, AnimatorMusicTiming, AnimatorPlayOptions, AnimatorCrossfadeOptions, AnimatorStopOptions, AnimatorRequestOptions, AnimatorTravelOptions, AnimatorTravelResult, AnimatorJumpOptions, AnimatorStateInfo, AnimatorIKOptions, AnimatorIKTarget, AnimatorWarpTarget, AnimatorBone, AnimatorParams, TweenEase, TweenEndReason, TweenResult, TweenTarget, TweenValue, TweenField, TweenOptions, Tween } from "./types";
