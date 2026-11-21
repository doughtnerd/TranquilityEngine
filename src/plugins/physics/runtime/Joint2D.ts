import { physics2DOf } from "./systems2d";
import { Component } from "../../../engine/core/Component";
import { Vector2 } from "../../../engine/core/math";
import { PlainObject, component, field } from "../../../engine/core/registry";
import { GameObject } from "../../../engine/scene/GameObject";
import { isDistanceJoint, type JointKind, type JointLimits, type JointMotor, type JointSpring } from "../../../engine/physics/types";
import { frame2DOf, frameToWorld } from "../../../engine/scene/frame2d";
import type { Dim2 } from "./backend";
import type { JointState } from "./core/state";
import { RigidBody2D } from "./RigidBody2D";
import { attachedBody } from "./attachedBody";

/**
 * @internal What a 2D joint is, from its own fields, backend-neutral (ADR 0305): the 2D physics world builds the
 * joint from it and the joint gizmo draws it. Limits are null while off (degrees for a hinge, units for a slider);
 * a slider's axis is in its node's local space; a null length is the anchors' distance when the joint is made.
 */
export type JointFields2D =
  | { readonly kind: "fixed" }
  | { readonly kind: "hinge"; readonly limits: JointLimits | null }
  | { readonly kind: "slider"; readonly axis: readonly [number, number]; readonly limits: JointLimits | null }
  | { readonly kind: "rope"; readonly length: number | null }
  | { readonly kind: "spring"; readonly length: number | null; readonly stiffness: number; readonly damping: number };

/** @internal A joint's two anchors in world space, on its node's z plane; `connected` null is the same point as `anchor`. */
export interface JointAnchors2D {
  readonly anchor: [number, number, number];
  readonly connected: [number, number, number] | null;
}

/**
 * Base class for 2D joints (ADR 0005, 0092), like the 3D ones: a joint links the RigidBody2D on its
 * node (or the nearest one above it) to `connectedBody`, a node with a RigidBody2D, or to the world.
 * `anchor` is the joint's point in this node's local space; with `autoConfigureConnectedAnchor` the
 * other body's anchor is wherever that point is when the joint is made, otherwise `connectedAnchor`
 * in the connected node's local space (world space when connected to the world). Joints rest in the
 * pose the bodies are in when the joint is made.
 */
export abstract class Joint2D extends Component {
  /** The other body's node; empty joins the body to the world. */
  @field(GameObject) connectedBody: GameObject | null = null;
  @field(Vector2) anchor = new Vector2(0, 0);
  @field(Boolean) autoConfigureConnectedAnchor = true;
  @field(Vector2) connectedAnchor = new Vector2(0, 0);
  /** Let the two bodies' colliders collide with each other. */
  @field(Boolean) enableCollision = false;
  /** The force (newtons) that breaks the joint; 0 never breaks it. See Joint.breakForce. */
  @field(Number) breakForce = 0;
  /** The torque (newton-metres) that breaks the joint; 0 never breaks it. */
  @field(Number) breakTorque = 0;

  /** @internal */ _state: JointState<Dim2, RigidBody2D> | null = null;
  /** @internal Broken: never rebuilt. */ _broken = false;

  /** The body this joint moves: the nearest active RigidBody on this node or above it. */
  get body(): RigidBody2D | null {
    return attachedBody(this.node, RigidBody2D);
  }

  /** The connected node's body (its own RigidBody or the nearest above it), or null for the world. */
  get connectedRigidbody(): RigidBody2D | null {
    return attachedBody(this.connectedBody?.isValid ? this.connectedBody : null, RigidBody2D);
  }

  /** What kind of joint this is. */
  get jointKind(): JointKind {
    return this._jointFields().kind;
  }

  /** @internal What the joint is, from its own fields (ADR 0305). */
  abstract _jointFields(): JointFields2D;

  /**
   * @internal The joint's anchors in world space now, through the nodes' 2D frames (ADR 0301, 0305): `anchor` in
   * this node's space; the connected anchor is `connectedAnchor` in the connected node's space (world space with
   * none) or, with `autoConfigureConnectedAnchor`, the same point, except that a rope or spring measures from the
   * connected body's origin.
   */
  _worldAnchors(): JointAnchors2D {
    const anchor = frameToWorld(frame2DOf(this.node), [this.anchor.x, this.anchor.y]);
    const other = this.connectedBody?.isValid ? this.connectedBody : null;
    const ca = this.connectedAnchor;
    let connected: [number, number, number] | null = null;
    if (!this.autoConfigureConnectedAnchor) connected = other ? frameToWorld(frame2DOf(other), [ca.x, ca.y]) : [ca.x, ca.y, anchor[2]];
    else if (other && isDistanceJoint(this.jointKind)) connected = [...frame2DOf(this.connectedRigidbody?.node ?? other).position];
    return { anchor, connected };
  }

  /** @internal Fields that need the joint rebuilt when they change. */
  abstract _jointSignature(): string;
  /** @internal Fields applied to a live joint (limits, motor, spring). */
  _settingsSignature(): string {
    return "";
  }

  override _onDetach(): void {
    physics2DOf(this._world)?.releaseJoint(this);
  }
}

/** Holds two bodies together as if welded. */
@component("engine.FixedJoint2D")
export class FixedJoint2D extends Joint2D {
  override _jointFields(): JointFields2D {
    return { kind: "fixed" };
  }

  override _jointSignature(): string {
    return "fixed";
  }
}

/** Shared by hinges and sliders: one axis of movement, with optional limits, a motor or a spring. */
export abstract class AxisJoint2D extends Joint2D {
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

  /** @internal The limits while on, else null. */
  protected _limitsIfOn(): JointLimits | null {
    return this.useLimits && this.limits ? { min: this.limits.min, max: this.limits.max } : null;
  }
}

/** Lets the body turn around the anchor, like a wheel on an axle; limits and targets in degrees (counterclockwise). */
@component("engine.HingeJoint2D")
export class HingeJoint2D extends AxisJoint2D {
  override _jointFields(): JointFields2D {
    return { kind: "hinge", limits: this._limitsIfOn() };
  }

  override _jointSignature(): string {
    return `hinge|${this.useLimits}`;
  }
}

/** Lets the body slide along `axis` without turning; limits and targets in units. */
@component("engine.SliderJoint2D")
export class SliderJoint2D extends AxisJoint2D {
  /** The direction it slides along, in this node's local space. */
  @field(Vector2) axis = new Vector2(1, 0);

  override _jointFields(): JointFields2D {
    return { kind: "slider", axis: [this.axis.x, this.axis.y], limits: this._limitsIfOn() };
  }

  override _jointSignature(): string {
    return `slider:${this.axis.x},${this.axis.y}|${this.useLimits}`;
  }
}

/** Keeps the anchors at most `maxDistance` apart, slack when closer, like a rope. */
@component("engine.RopeJoint2D")
export class RopeJoint2D extends Joint2D {
  /** Use the anchors' distance when the joint is made as `maxDistance`. */
  @field(Boolean) autoConfigureDistance = true;
  @field(Number) maxDistance = 1;

  override _jointFields(): JointFields2D {
    return { kind: "rope", length: this.autoConfigureDistance ? null : Math.max(this.maxDistance, 0) };
  }

  override _jointSignature(): string {
    return `rope:${this.autoConfigureDistance}|${this.autoConfigureDistance ? "" : this.maxDistance}`;
  }
}

/** Pulls the anchors towards `restLength` apart with stiffness `spring` and damping `damper`. */
@component("engine.SpringJoint2D")
export class SpringJoint2D extends Joint2D {
  /** Use the anchors' distance when the joint is made as `restLength`. */
  @field(Boolean) autoConfigureDistance = true;
  @field(Number) restLength = 1;
  @field(Number) spring = 10;
  @field(Number) damper = 0.2;

  override _jointFields(): JointFields2D {
    return { kind: "spring", length: this.autoConfigureDistance ? null : Math.max(this.restLength, 0), stiffness: this.spring, damping: this.damper };
  }

  override _jointSignature(): string {
    return `spring:${this.autoConfigureDistance}|${this.autoConfigureDistance ? "" : this.restLength}|${this.spring}|${this.damper}`;
  }
}
