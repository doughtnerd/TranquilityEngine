import { Component } from "../core/Component";
import { Vector3 } from "../core/math";
import { PlainObject, component, field } from "../core/registry";
import { GameObject } from "../scene/GameObject";
import type { JointHandleState3D } from "./Physics3DWorld";
import { RigidBody } from "./RigidBody";

/** A joint's range of movement: degrees for hinges, units for sliders. */
export interface JointLimits {
  min: number;
  max: number;
}

/** Drives a hinge or slider at `targetVelocity` (degrees or units per second) with at most `force`. */
export interface JointMotor {
  targetVelocity: number;
  force: number;
}

/** Pulls a hinge or slider towards `targetPosition` (degrees or units) with stiffness `spring` and damping `damper`. */
export interface JointSpring {
  spring: number;
  damper: number;
  targetPosition: number;
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

  /** @internal */ _state: JointHandleState3D | null = null;

  /** The body this joint moves: the nearest active RigidBody on this node or above it. */
  get body(): RigidBody | null {
    for (let n: GameObject | null = this.node; n; n = n.parent) {
      const rb = n.getBehavior(RigidBody);
      if (rb && rb.isActiveAndEnabled) return rb;
    }
    return null;
  }

  /** The connected node's body (its own RigidBody or the nearest above it), or null for the world. */
  get connectedRigidbody(): RigidBody | null {
    for (let n: GameObject | null = this.connectedBody?.isValid ? this.connectedBody : null; n; n = n.parent) {
      const rb = n.getBehavior(RigidBody);
      if (rb && rb.isActiveAndEnabled) return rb;
    }
    return null;
  }

  /** @internal Fields that need the joint rebuilt when they change. */
  abstract _jointSignature(): string;
  /** @internal Fields applied to a live joint (limits, motor, spring). */
  _settingsSignature(): string {
    return "";
  }

  override _onDetach(): void {
    this.world.physics3D?.releaseJoint(this);
  }
}

/** Holds two bodies together as if welded. */
@component("engine.FixedJoint")
export class FixedJoint extends Joint {
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
}

/** Lets the body turn around `axis` through the anchor, like a door; limits and targets in degrees. */
@component("engine.HingeJoint")
export class HingeJoint extends AxisJoint {
  override _jointSignature(): string {
    return `hinge:${this.axis.x},${this.axis.y},${this.axis.z}|${this.useLimits}`;
  }
}

/** Lets the body slide along `axis` without turning, like a drawer; limits and targets in units. */
@component("engine.SliderJoint")
export class SliderJoint extends AxisJoint {
  override _jointSignature(): string {
    return `slider:${this.axis.x},${this.axis.y},${this.axis.z}|${this.useLimits}`;
  }
}

/** Keeps the anchors together but lets the body turn freely around them, like a shoulder. */
@component("engine.BallJoint")
export class BallJoint extends Joint {
  override _jointSignature(): string {
    return "ball";
  }
}

/** Keeps the anchors at most `maxDistance` apart, slack when closer, like a rope. */
@component("engine.RopeJoint")
export class RopeJoint extends Joint {
  /** Use the anchors' distance when the joint is made as `maxDistance`. */
  @field(Boolean) autoConfigureDistance = true;
  @field(Number) maxDistance = 1;

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

  override _jointSignature(): string {
    return `spring:${this.autoConfigureDistance}|${this.autoConfigureDistance ? "" : this.restLength}|${this.spring}|${this.damper}`;
  }
}
