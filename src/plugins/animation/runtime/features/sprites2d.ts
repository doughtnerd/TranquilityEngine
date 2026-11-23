// 2D bones (ADR 0371; T21): what a Skeleton2D's lifecycle does (load the bones from the image sidecar's `skin`; several
// slices share one skeleton). Empty until T21.
import type { Skeleton2D } from "../components/Skeleton2D";
import type { LifecycleHooks } from "../lifecycle";

/** @internal A Skeleton2D's lifecycle (T21). */
export const skeleton2DHooks: LifecycleHooks<Skeleton2D> = {};
