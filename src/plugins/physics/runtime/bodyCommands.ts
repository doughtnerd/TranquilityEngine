/**
 * What scripts ask of a rigid body, in either dimension (ADR 0283): velocity and angular velocity set or read,
 * forces, torques and impulses added. One module for RigidBody2D and RigidBody: with a backend body the command
 * goes to it; before the body exists (the frame a node is made, or before the backend loads) it waits here,
 * and the sync core takes it at the body's next push. Vectors are plain number arrays: 2 or 3 linear axes,
 * 1 or 3 angular axes; angles in degrees, as scripts see them.
 */
import { DEG2RAD, RAD2DEG } from "../../../engine/core/math";
import type { ForceMode } from "../../../engine/physics/types";
import type { BackendBody, DimensionTypes } from "./backend";

/** The mass a body simulates with (a mass of 0 or less would divide by zero). */
export const bodyMass = (mass: number): number => Math.max(mass, 1e-4);

/** A body's inertia around each rotation axis: box-ish, since colliders on bodies have no density. */
export const bodyInertia = (mass: number): number => bodyMass(mass) / 6;

/** How a dimension's vectors convert to and from number arrays. */
export interface BodyAxes<D extends DimensionTypes> {
  vec(a: readonly number[]): D["vec"];
  ang(a: readonly number[]): D["ang"];
  fromVec(v: D["vec"]): number[];
  fromAng(w: D["ang"]): number[];
  readonly linear: number;
  readonly angular: number;
}

/** What the sync core applies at a body's push: the waiting velocities (radians for angular), and this step's force and torque. */
export interface TakenCommands {
  readonly velocity: number[] | null;
  readonly angularVelocity: number[] | null;
  readonly force: number[];
  readonly torque: number[];
}

/** @internal A rigid body's commands. */
export class BodyCommands<D extends DimensionTypes> {
  private pendingVelocity: number[] | null = null;
  /** Degrees per second. */
  private pendingAngularVelocity: number[] | null = null;
  private readonly force: number[];
  private readonly torque: number[];

  constructor(private readonly axes: BodyAxes<D>) {
    this.force = new Array<number>(axes.linear).fill(0);
    this.torque = new Array<number>(axes.angular).fill(0);
  }

  /** The body's linear velocity, the one waiting for it, or null when neither. */
  velocity(body: BackendBody<D> | null | undefined): number[] | null {
    return body ? this.axes.fromVec(body.linearVelocity()) : this.pendingVelocity;
  }

  setVelocity(body: BackendBody<D> | null | undefined, v: readonly number[]): void {
    if (body) body.setLinearVelocity(this.axes.vec(v));
    else this.pendingVelocity = [...v];
  }

  /** The body's angular velocity in degrees per second, the one waiting for it, or zero. */
  angularVelocity(body: BackendBody<D> | null | undefined): number[] {
    if (body) return this.axes.fromAng(body.angularVelocity()).map((w) => w * RAD2DEG);
    return this.pendingAngularVelocity ? [...this.pendingAngularVelocity] : new Array<number>(this.axes.angular).fill(0);
  }

  setAngularVelocity(body: BackendBody<D> | null | undefined, degPerSec: readonly number[]): void {
    if (body) body.setAngularVelocity(this.axes.ang(degPerSec.map((w) => w * DEG2RAD)));
    else this.pendingAngularVelocity = [...degPerSec];
  }

  /**
   * A force for the next fixed step (`"force"`), or an instant change in momentum (`"impulse"`): before the body
   * exists, an impulse changes the waiting velocity by impulse / mass.
   */
  addForce(body: BackendBody<D> | null | undefined, force: readonly number[], mode: ForceMode, mass: number): void {
    if (mode === "force") {
      for (let i = 0; i < this.force.length; i++) this.force[i] += force[i] ?? 0;
    } else if (body) {
      body.applyImpulse(this.axes.vec(force));
    } else {
      const m = mass > 0 ? mass : 1;
      const v = this.pendingVelocity ?? new Array<number>(this.axes.linear).fill(0);
      this.pendingVelocity = v.map((x, i) => x + (force[i] ?? 0) / m);
    }
  }

  /**
   * A torque for the next fixed step, or an angular impulse: before the body exists, an impulse changes the waiting
   * angular velocity by impulse / inertia (none around a frozen rotation axis), as it would the body's.
   */
  addTorque(body: BackendBody<D> | null | undefined, torque: readonly number[], mode: ForceMode, mass: number, frozen: readonly boolean[]): void {
    if (mode === "force") {
      for (let i = 0; i < this.torque.length; i++) this.torque[i] += torque[i] ?? 0;
    } else if (body) {
      body.applyTorqueImpulse(this.axes.ang(torque));
    } else {
      const inertia = bodyInertia(mass);
      const w = this.pendingAngularVelocity ?? new Array<number>(this.axes.angular).fill(0);
      this.pendingAngularVelocity = w.map((x, i) => (frozen[i] ? x : x + ((torque[i] ?? 0) / inertia) * RAD2DEG));
    }
  }

  /** @internal The sync core's: what to apply at this push, cleared as it's taken. */
  take(): TakenCommands {
    const taken = {
      velocity: this.pendingVelocity,
      angularVelocity: this.pendingAngularVelocity ? this.pendingAngularVelocity.map((w) => w * DEG2RAD) : null,
      force: [...this.force],
      torque: [...this.torque],
    };
    this.pendingVelocity = this.pendingAngularVelocity = null;
    this.force.fill(0);
    this.torque.fill(0);
    return taken;
  }
}
