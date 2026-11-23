/**
 * The ragdoll contribution point (ADR 0375, 0370 "anim-physics", 0372 "physical animation"). Ragdolls live in their own
 * plugin, `myco.ragdoll`, which depends on this one and on physics; the animation plugin keeps only the drive-target
 * computation, the pose snapshot source and the physical-pose graph input. The ragdoll plugin reaches them by
 * contributing a client here from its runtime half (`context.contribute(PHYSICAL_ANIMATION, client)`, as backends join
 * `PHYSICS_BACKENDS`, ADR 0137): the animation plugin connects it to its source, and deactivating the ragdoll plugin
 * (which deactivating animation or physics does first) disconnects it.
 *
 * The ragdoll's fixed-step systems run between `animation.FixedEvaluate` and the physics push: they read `drives`, write
 * the joints' drive targets, and after the physics step hand the simulated bodies back with `setPhysicalPose`.
 *
 * Internal to first-party plugins: `myco` doesn't export it. Engine types only (ADR 0010). Per-bone arrays are indexed
 * by the skeleton's bone order (parents first).
 */
import type { ContributionPoint } from "../../runtimeContext";
import type { Quaternion, Vector3 } from "../../../engine/core/math";
import type { Animator } from "./components/Animator";
import { registerPhysicalClient } from "./features/physical";

/** @internal One bone of a ragdoll description (D73: drive strengths scale by global × bone × multiplier). */
export interface RagdollBoneDescription {
  /** The bone has a rigid body (bones without one follow their parent body). */
  readonly body: boolean;
  /** The joint frame: the body's frame relative to the bone's. */
  readonly jointFrame: Quaternion;
  /** Swing cone half-angles about the joint's Y and Z, degrees in [0, 180] (ADR 0375's elliptical swing). */
  readonly swing: { readonly y: number; readonly z: number };
  /** Twist range about the joint's X, degrees in [-180, 180]. */
  readonly twist: { readonly min: number; readonly max: number };
  /** Drive stiffness, damping and maximum force (≥ 0; the builder's defaults are 400, 40 and 1000). */
  readonly stiffness: number;
  readonly damping: number;
  readonly maxForce: number;
  /** Muscle strength multiplier (≥ 0, default 1). */
  readonly strength: number;
  /** Pin weight, 0–1 (default 1 on root bodies, 0 elsewhere). */
  readonly pin: number;
}

/** @internal A ragdoll for one skeleton: one entry per bone, in the skeleton's order. */
export interface RagdollDescription {
  readonly bones: readonly RagdollBoneDescription[];
  /** The bone whose facing picks the get-up (default: the first root body). */
  readonly pelvis?: number;
  /** The pelvis's local axis out of the belly. */
  readonly front: "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
}

/** @internal A ragdoll instance's controls, changed any fixed step. */
export interface RagdollControl {
  /** Global muscle strength, scaling every drive (default 1). */
  readonly strength?: number;
  /** Global pin weight, 0–1 (default 1). */
  readonly pin?: number;
  /** The graph state to get up from lying on the back, or null. */
  readonly getupFromBack?: string | null;
  /** The graph state to get up from lying on the front, or null. */
  readonly getupFromFront?: string | null;
}

/** @internal One bone's drive target this fixed step (D73: relative to the parent body, model space, +Y up). */
export interface RagdollDriveTarget {
  /** The bone has a body (false: ignore the rest). */
  readonly body: boolean;
  /** A root body: `targetRotation` is in model space and the body is pinned by `pin`. */
  readonly root: boolean;
  /** The bone of the parent body, or -1. */
  readonly parentBody: number;
  /** Target rotation relative to the parent body's frame (a root body's: model space). */
  readonly targetRotation: Quaternion;
  /** Target angular velocity in rad/s, in the parent body's frame; null when only one pose was known. */
  readonly angularVelocity: Vector3 | null;
  /** Scaled drive stiffness, damping and maximum force. */
  readonly stiffness: number;
  readonly damping: number;
  readonly maxForce: number;
  /** Pin weight, 0–1. */
  readonly pin: number;
  /** The animated body pose in model space: where a body spawns, and the pin's target. */
  readonly animatedPosition: Vector3;
  readonly animatedRotation: Quaternion;
}

/** @internal An instance's drive targets for this fixed step. */
export interface RagdollDrives {
  /** One entry per bone. */
  readonly bones: readonly RagdollDriveTarget[];
  /** Which way the pelvis faces, when known. */
  readonly facing: "unknown" | "up" | "down";
  /** The get-up state the facing picks (from `RagdollControl`), or null. */
  readonly getup: string | null;
}

/** @internal One bone's simulated body after the physics step (model space). */
export interface RagdollBodyPose {
  /** The plugin simulated this body this step (false: the bone keeps its animated pose). */
  readonly simulated: boolean;
  readonly position: Vector3;
  readonly rotation: Quaternion;
  /** This bone's strength multiplier this step (default 1). */
  readonly multiplier?: number;
}

/** @internal What the animation plugin offers a connected ragdoll plugin. Methods take the Animator that owns the instance. */
export interface PhysicalAnimationSource {
  /** Give an Animator's instance a ragdoll; false when its skeleton doesn't match or every physics row is taken. */
  attach(animator: Animator, ragdoll: RagdollDescription): boolean;
  /** Take the ragdoll off an Animator's instance. */
  detach(animator: Animator): void;
  /** Change an instance's controls. */
  control(animator: Animator, control: RagdollControl): void;
  /** The drive targets `animation.FixedEvaluate` computed this fixed step, or null when it wrote none. */
  drives(animator: Animator): RagdollDrives | null;
  /** After the physics step: the simulated bodies, one per bone, into the graph's physical-pose input. */
  setPhysicalPose(animator: Animator, bodies: readonly RagdollBodyPose[]): void;
  /** Get-up: freeze the physical pose of graph node `physicalNode` into pose-snapshot node `snapshotNode`; false if refused. */
  captureSnapshot(animator: Animator, physicalNode: string, snapshotNode: string): boolean;
}

/** @internal A ragdoll plugin's side of the connection. */
export interface PhysicalAnimationClient {
  /** Unique, e.g. `myco.ragdoll`. */
  readonly id: string;
  /** Called when the client is contributed: keep `source` until `disconnect`. */
  connect(source: PhysicalAnimationSource): void;
  /** Called when the client's plugin or the animation plugin deactivates: stop using the source. */
  disconnect(): void;
}

/** @internal The point a ragdoll plugin contributes its client to (one client at a time per id). */
export const PHYSICAL_ANIMATION: ContributionPoint<PhysicalAnimationClient> = { id: "myco.animation.physical", register: registerPhysicalClient };
