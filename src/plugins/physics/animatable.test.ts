// ADR 0371: physics fields whose change rebuilds a backend body, collider or joint are not animatable.
import { describe, expect, it } from "vitest";
import {
  BallJoint, BoxCollider, BoxCollider2D, CapsuleCollider, CircleCollider2D, HingeJoint, HingeJoint2D, MeshCollider, RigidBody, RigidBody2D, RopeJoint,
  RopeJoint2D, SliderJoint, SliderJoint2D, SphereCollider, SpringJoint, SpringJoint2D, TilemapCollider2D,
} from "../../myco";
import { isFieldAnimatable } from "../../engine/core/registry";
import type { ComponentClass } from "../../engine/core/registry";

const OPT_OUTS: [string, ComponentClass, string[]][] = [
  ["RigidBody", RigidBody, ["bodyType"]],
  ["RigidBody2D", RigidBody2D, ["bodyType"]],
  ["CapsuleCollider", CapsuleCollider, ["direction"]],
  ["MeshCollider", MeshCollider, ["mesh", "convex"]],
  ["TilemapCollider2D", TilemapCollider2D, ["mode"]],
  ["HingeJoint", HingeJoint, ["anchor", "connectedAnchor", "autoConfigureConnectedAnchor", "enableCollision", "axis", "useLimits"]],
  ["SliderJoint", SliderJoint, ["axis", "useLimits"]],
  ["BallJoint", BallJoint, ["axis", "useLimits"]],
  ["RopeJoint", RopeJoint, ["autoConfigureDistance", "maxDistance"]],
  ["SpringJoint", SpringJoint, ["autoConfigureDistance", "restLength", "spring", "damper"]],
  ["HingeJoint2D", HingeJoint2D, ["anchor", "connectedAnchor", "autoConfigureConnectedAnchor", "enableCollision", "useLimits"]],
  ["SliderJoint2D", SliderJoint2D, ["axis", "useLimits"]],
  ["RopeJoint2D", RopeJoint2D, ["autoConfigureDistance", "maxDistance"]],
  ["SpringJoint2D", SpringJoint2D, ["autoConfigureDistance", "restLength", "spring", "damper"]],
];

describe("built-in physics opt-outs", () => {
  for (const [name, cls, fields] of OPT_OUTS) {
    it.each(fields)(`${name}.%s is not animatable`, (f) => {
      expect(isFieldAnimatable(cls, f)).toBe(false);
    });
  }

  it("keeps the fields a rebuild-free change can drive", () => {
    expect(isFieldAnimatable(RigidBody, "mass")).toBe(true);
    expect(isFieldAnimatable(RigidBody, "collisionDetection")).toBe(true);
    expect(isFieldAnimatable(RigidBody2D, "gravityScale")).toBe(true);
    expect(isFieldAnimatable(BoxCollider, "size")).toBe(true);
    expect(isFieldAnimatable(BoxCollider, "isTrigger")).toBe(true);
    expect(isFieldAnimatable(SphereCollider, "radius")).toBe(true);
    expect(isFieldAnimatable(CapsuleCollider, "height")).toBe(true);
    expect(isFieldAnimatable(BoxCollider2D, "size")).toBe(true);
    expect(isFieldAnimatable(CircleCollider2D, "radius")).toBe(true);
    expect(isFieldAnimatable(HingeJoint, "breakForce")).toBe(true);
    expect(isFieldAnimatable(BallJoint, "swingLimit")).toBe(true);
    expect(isFieldAnimatable(HingeJoint, "useMotor")).toBe(true);
  });

  it("leaves joint limits, motor and spring objects to their type default (T43 opens spring.targetPosition)", () => {
    expect(isFieldAnimatable(HingeJoint, "limits")).toBe(false);
    expect(isFieldAnimatable(HingeJoint, "spring")).toBe(false);
  });
});
