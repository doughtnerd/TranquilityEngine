import { physics3DOf } from "./systems3d";
import { Component } from "../../../engine/core/Component";
import { Vector3 } from "../../../engine/core/math";
import { PlainObject, component, field } from "../../../engine/core/registry";
import { GameObject } from "../../../engine/scene/GameObject";
import type { Dim3 } from "./backend";
import type { JointState } from "./core/state";
import { RigidBody } from "./RigidBody";
import { attachedBody } from "./attachedBody";

import { Mat4 } from "../../../engine/core/math";
import { isDistanceJoint, type JointKind, type JointLimits, type JointMotor, type JointSpring } from "../../../engine/physics/types";
export type { JointKind, JointLimits, JointMotor, JointSpring };

type V3 = [number, number, number];

/**
 * @internal What a 3D joint is, from its own fields, backend-neutral (ADR 0305): the 3D physics world builds the
 * joint from it and the joint gizmo draws it. `axis` is in the node's local space (a hinge's or slider's axis, a
 * ball's twist axis); limits are null while off (degrees for a hinge, units for a slider); a null length is the
 * anchors' distance when the joint is made.
 */
export type JointFields3D =
  | { readonly kind: "fixed" }
  | { readonly kind: "hinge" | "slider"; readonly axis: V3; readonly limits: JointLimits | null }
  | { readonly kind: "ball"; readonly axis: V3 }
  | { readonly kind: "rope"; readonly length: number | null }
  | { readonly kind: "spring"; readonly length: number | null; readonly stiffness: number; readonly damping: number };

/** @internal A joint's two anchors in world space; `connected` null is the same point as `anchor`. */
export interface JointAnchors3D {
  readonly anchor: V3;
  readonly connected: V3 | null;
}

/** A point in `node`'s local space, in world space (its world matrix). */
function worldPoint(node: GameObject, p: { x: number; y: number; z: number }): V3 {
  if (!node.transform) return [p.x, p.y, p.z];
  return Mat4.transformPoint(node.world.worldMatrix(node.entity), node.entity * 16, p.x, p.y, p.z) as V3;
}

/**
 * Base class for 3D joints (ADR 0005, 0092). A joint links the RigidBody on its node (or the nearest
 * one above it) to `connectedBody`, a node with a RigidBody, or to the world when that's empty.
 * `anchor` is the joint's point in this node's local space; with `autoConfigureConnectedAnchor` the
 * other body's anchor is wherever that point is when the joint is made, otherwise `connectedAnchor`
 * in the connected node's local space (world space when connected to the world). Joints rest in the
 * pose the bodies are in when the joint is made.
 */
export abstract class Joint extends Component {
  /** The other body's node; empty joins the body to the world. */
  @field(GameObject) connectedBody: GameObject | null = null;
  @field(Vector3) anchor = new Vector3(0, 0, 0);
  @field(Boolean) autoConfigureConnectedAnchor = true;
  @field(Vector3) connectedAnchor = new Vector3(0, 0, 0);
  /** Let the two bodies' colliders collide with each other. */
  @field(Boolean) enableCollision = false;
  /**
   * The force (newtons) that breaks the joint; 0, the default, never breaks it. When it breaks,
   * `onJointBreak(joint, force, torque)` runs on the node's behaviors and the joint is destroyed.
   */
  @field(Number) breakForce = 0;
  /** The torque (newton-metres) that breaks the joint; 0 never breaks it. */
  @field(Number) breakTorque = 0;

  /** @internal */ _state: JointState<Dim3, RigidBody> | null = null;
  /** @internal Broken: never rebuilt. */ _broken = false;

  /** The body this joint moves: the nearest active RigidBody on this node or above it. */
  get body(): RigidBody | null {
    return attachedBody(this.node, RigidBody);
  }

  /** The connected node's body (its own RigidBody or the nearest above it), or null for the world. */
  get connectedRigidbody(): RigidBody | null {
    return attachedBody(this.connectedBody?.isValid ? this.connectedBody : null, RigidBody);
  }

  /** What kind of joint this is. */
  get jointKind(): JointKind {
    return this._jointFields().kind;
  }

  /** @internal What the joint is, from its own fields (ADR 0305). */
  abstract _jointFields(): JointFields3D;

  /**
   * @internal The joint's anchors in world space now, through the nodes' world matrices (ADR 0305): `anchor` in
   * this node's space; the connected anchor is `connectedAnchor` in the connected node's space (world space with
   * none) or, with `autoConfigureConnectedAnchor`, the same point, except that a rope or spring measures from the
   * connected body's origin.
   */
  _worldAnchors(): JointAnchors3D {
    const anchor = worldPoint(this.node, this.anchor);
    const other = this.connectedBody?.isValid ? this.connectedBody : null;
    const ca = this.connectedAnchor;
    let connected: V3 | null = null;
    if (!this.autoConfigureConnectedAnchor) connected = other ? worldPoint(other, ca) : [ca.x, ca.y, ca.z];
    else if (other && isDistanceJoint(this.jointKind)) connected = worldPoint(this.connectedRigidbody?.node ?? other, { x: 0, y: 0, z: 0 });
    return { anchor, connected };
  }

  /** @internal Fields that need the joint rebuilt when they change. */
  abstract _jointSignature(): string;
  /** @internal Fields applied to a live joint (limits, motor, spring). */
  _settingsSignature(): string {
    return "";
  }

  override _onDetach(): void {
    physics3DOf(this._world)?.releaseJoint(this);
  }
}

/** Holds two bodies together as if welded. */
@component("engine.FixedJoint")
export class FixedJoint extends Joint {
  override _jointFields(): JointFields3D {
    return { kind: "fixed" };
  }

  override _jointSignature(): string {
    return "fixed";
  }
}

/** Shared by hinges and sliders: one axis of movement, with optional limits, a motor or a spring. */
export abstract class AxisJoint extends Joint {
  /** The axis it turns around (hinge) or slides along (slider), in this node's local space. */
  @field(Vector3) axis = new Vector3(1, 0, 0);
  @field(Boolean) useLimits = false;
  @field(PlainObject) limits: JointLimits = { min: 0, max: 0 };
  @field(Boolean) useMotor = false;
  @field(PlainObject) motor: JointMotor = { targetVelocity: 0, force: 10 };
  /** Ignored while `useMotor` is on. */
  @field(Boolean) useSpring = false;
  @field(PlainObject) spring: JointSpring = { spring: 10, damper: 1, targetPosition: 0 };

  override _settingsSignature(): string {
    const l = this.limits, m = this.motor, s = this.spring;
    return [l?.min, l?.max, this.useMotor, m?.targetVelocity, m?.force, this.useSpring, s?.spring, s?.damper, s?.targetPosition].join("|");
  }

  /** @internal The axis and the limits (while on, else null). */
  protected _axisFields(): { axis: V3; limits: JointLimits | null } {
    return { axis: [this.axis.x, this.axis.y, this.axis.z], limits: this.useLimits && this.limits ? { min: this.limits.min, max: this.limits.max } : null };
  }
}

/** Lets the body turn around `axis` through the anchor, like a door; limits and targets in degrees. */
@component("engine.HingeJoint")
export class HingeJoint extends AxisJoint {
  override _jointFields(): JointFields3D {
    return { kind: "hinge", ...this._axisFields() };
  }

  override _jointSignature(): string {
    return `hinge:${this.axis.x},${this.axis.y},${this.axis.z}|${this.useLimits}`;
  }
}

/** Lets the body slide along `axis` without turning, like a drawer; limits and targets in units. */
@component("engine.SliderJoint")
export class SliderJoint extends AxisJoint {
  override _jointFields(): JointFields3D {
    return { kind: "slider", ...this._axisFields() };
  }

  override _jointSignature(): string {
    return `slider:${this.axis.x},${this.axis.y},${this.axis.z}|${this.useLimits}`;
  }
}

/**
 * Keeps the anchors together but lets the body turn around them, like a shoulder. With `useLimits`,
 * it twists around `axis` only between `twistLimits` (degrees) and swings off it at most
 * `swingLimit` degrees around each of the two axes across it (a four-sided limit, not a round cone).
 */
@component("engine.BallJoint")
export class BallJoint extends Joint {
  /** The twist axis, in this node's local space. */
  @field(Vector3) axis = new Vector3(1, 0, 0);
  @field(Boolean) useLimits = false;
  @field(PlainObject) twistLimits: JointLimits = { min: -45, max: 45 };
  @field(Number) swingLimit = 45;

  override _jointFields(): JointFields3D {
    return { kind: "ball", axis: [this.axis.x, this.axis.y, this.axis.z] };
  }

  override _jointSignature(): string {
    return `ball:${this.axis.x},${this.axis.y},${this.axis.z}|${this.useLimits}`;
  }

  override _settingsSignature(): string {
    return [this.twistLimits?.min, this.twistLimits?.max, this.swingLimit].join("|");
  }
}

/** Keeps the anchors at most `maxDistance` apart, slack when closer, like a rope. */
@component("engine.RopeJoint")
export class RopeJoint extends Joint {
  /** Use the anchors' distance when the joint is made as `maxDistance`. */
  @field(Boolean) autoConfigureDistance = true;
  @field(Number) maxDistance = 1;

  override _jointFields(): JointFields3D {
    return { kind: "rope", length: this.autoConfigureDistance ? null : Math.max(this.maxDistance, 0) };
  }

  override _jointSignature(): string {
    return `rope:${this.autoConfigureDistance}|${this.autoConfigureDistance ? "" : this.maxDistance}`;
  }
}

/** Pulls the anchors towards `restLength` apart with stiffness `spring` and damping `damper`. */
@component("engine.SpringJoint")
export class SpringJoint extends Joint {
  /** Use the anchors' distance when the joint is made as `restLength`. */
  @field(Boolean) autoConfigureDistance = true;
  @field(Number) restLength = 1;
  @field(Number) spring = 10;
  @field(Number) damper = 0.2;

  override _jointFields(): JointFields3D {
    return { kind: "spring", length: this.autoConfigureDistance ? null : Math.max(this.restLength, 0), stiffness: this.spring, damping: this.damper };
  }

  override _jointSignature(): string {
    return `spring:${this.autoConfigureDistance}|${this.autoConfigureDistance ? "" : this.restLength}|${this.spring}|${this.damper}`;
  }
}
