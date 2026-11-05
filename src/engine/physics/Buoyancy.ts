/**
 * Buoyancy (ADR 0072): floats a node on the World's water by sampling the water surface at a few
 * local points. Physics mode pushes the node's 3D RigidBody up at each submerged point; kinematic
 * mode places the node on the waves directly. Runs in a fixed-step system after scripts and before
 * the 3D physics push, and needs no renderer, so servers float objects the same as clients.
 */
import { Component } from "../core/Component";
import { Quaternion, Vector2, Vector3 } from "../core/math";
import { component, field } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import { firstSurface, sampleSurface, waterTime } from "../render/water/WaterSurface";
import { RigidBody } from "./RigidBody";

export type BuoyancyMode = "physics" | "kinematic";

/**
 * Floats its node on the World's first enabled WaterSurface.
 *
 * - `physics`: each submerged point pushes the node's RigidBody up with a force of
 *   depth × `strength` × mass × g / point count (at `strength` 1 the body floats with its points
 *   1 unit deep on average; 2 floats it at half that), at the point, so waves pitch and roll it;
 *   while submerged, `drag` and `angularDrag` slow it in proportion to `submerged`.
 * - `kinematic`: sets the node's height to the mean water height at its points, and its pitch and
 *   roll to the plane fitted through them, eased by `follow` (for scripted ships and props).
 */
@component("engine.Buoyancy")
export class Buoyancy extends Component {
  @field(String, { choices: ["physics", "kinematic"] }) mode: BuoyancyMode = "physics";
  /** Local sample points. Empty: the four corners of `size`. */
  @field([Vector3]) points: Vector3[] = [];
  /** Width (x) and length (z) whose corners are the sample points when `points` is empty. */
  @field(Vector2) size = new Vector2(1, 1);
  /** Physics: lift per unit of depth, relative to the body's weight. */
  @field(Number) strength = 1;
  /** Physics: linear drag per second while submerged. */
  @field(Number) drag = 1;
  /** Physics: angular drag per second while submerged. */
  @field(Number) angularDrag = 1;
  /** Kinematic: how quickly the node follows the waves, per second (0 snaps to them). */
  @field(Number) follow = 8;

  /** @internal */ _submerged = 0;
  private warnedBody = false;

  /** The fraction of sample points under water at the last fixed step, 0–1. Read-only. */
  get submerged(): number {
    return this._submerged;
  }

  /** The local sample points in use: `points`, or the corners of `size`. */
  samplePoints(): Vector3[] {
    if (this.points.length) return this.points.map((p) => new Vector3(p.x, p.y, p.z));
    const hx = this.size.x / 2, hz = this.size.y / 2;
    return [new Vector3(-hx, 0, -hz), new Vector3(hx, 0, -hz), new Vector3(hx, 0, hz), new Vector3(-hx, 0, hz)];
  }

  /** @internal One fixed step: `time` is the water clock, `dt` the step. */
  _step(world: World, time: number, dt: number): void {
    const water = firstSurface(world);
    const node = this.node;
    if (!water || !node.transform) {
      this._submerged = 0;
      return;
    }
    if (this.mode === "kinematic") this.stepKinematic(world, water, time, dt);
    else this.stepPhysics(world, water, time, dt);
  }

  private stepPhysics(world: World, water: Parameters<typeof sampleSurface>[0], time: number, dt: number): void {
    const body = this.node.getComponent(RigidBody);
    const e = this.node.entity;
    const m = world.worldMatrix(e), o = e * 16;
    const points = this.samplePoints();
    // The body's centre of mass is its node's origin (ADR 0045: colliders on bodies have no density).
    const cx = m[o + 12], cy = m[o + 13], cz = m[o + 14];
    const g = gravity(world);
    const mass = body ? Math.max(body.mass, 1e-4) : 1;
    let under = 0;
    let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
    for (const p of points) {
      const wx = m[o] * p.x + m[o + 4] * p.y + m[o + 8] * p.z + cx;
      const wy = m[o + 1] * p.x + m[o + 5] * p.y + m[o + 9] * p.z + cy;
      const wz = m[o + 2] * p.x + m[o + 6] * p.y + m[o + 10] * p.z + cz;
      const depth = sampleSurface(water, wx, wz, time).height - wy;
      if (depth <= 0) continue;
      under++;
      const lift = (depth * this.strength * mass * g) / points.length;
      fy += lift;
      // torque = r × F with F = (0, lift, 0)
      const rx = wx - cx, rz = wz - cz;
      tx += -rz * lift;
      tz += rx * lift;
    }
    this._submerged = points.length ? under / points.length : 0;
    if (!body || body.bodyType !== "dynamic") {
      if (!body && !this.warnedBody) {
        this.warnedBody = true;
        console.warn(`[myco] ${this.node.name}: Buoyancy in physics mode needs a RigidBody on the node; use mode "kinematic" to float without one.`);
      }
      return;
    }
    if (fy) body.addForce({ x: fx, y: fy, z: fz });
    if (tx || ty || tz) body.addTorque({ x: tx, y: ty, z: tz });
    if (this._submerged > 0 && dt > 0) {
      const lin = Math.max(0, 1 - Math.max(0, this.drag) * this._submerged * dt);
      const ang = Math.max(0, 1 - Math.max(0, this.angularDrag) * this._submerged * dt);
      if (lin < 1) {
        const v = body.velocity;
        body.velocity = { x: v.x * lin, y: v.y * lin, z: v.z * lin };
      }
      if (ang < 1) {
        const w = body.angularVelocity;
        body.angularVelocity = { x: w.x * ang, y: w.y * ang, z: w.z * ang };
      }
    }
  }

  private stepKinematic(world: World, water: Parameters<typeof sampleSurface>[0], time: number, dt: number): void {
    const t = this.node.transform!;
    const e = this.node.entity;
    const m = world.worldMatrix(e), o = e * 16;
    const px = m[o + 12], py = m[o + 13], pz = m[o + 14];
    // Heading: the node's local X axis projected onto the ground.
    const yaw = Math.atan2(-m[o + 2], m[o]);
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const sx = Math.hypot(m[o], m[o + 1], m[o + 2]) || 1;
    const sz = Math.hypot(m[o + 8], m[o + 9], m[o + 10]) || 1;
    const points = this.samplePoints();
    // Points in the heading frame (u along local X, v along local Z), ignoring the current tilt so the result doesn't feed back.
    let n = 0, su = 0, sv = 0, sh = 0, suu = 0, svv = 0, suv = 0, suh = 0, svh = 0;
    for (const p of points) {
      const u = p.x * sx, v = p.z * sz;
      // Rotation about Y by yaw: local x → (cos, 0, -sin), local z → (sin, 0, cos).
      const wx = px + u * cos + v * sin;
      const wz = pz - u * sin + v * cos;
      const h = sampleSurface(water, wx, wz, time).height;
      n++; su += u; sv += v; sh += h; suu += u * u; svv += v * v; suv += u * v; suh += u * h; svh += v * h;
    }
    if (!n) return;
    const meanH = sh / n;
    this._submerged = 1;
    // Least-squares plane h = a + b·u + c·v (centred, so a = mean).
    const mu = su / n, mv = sv / n;
    const cuu = suu / n - mu * mu, cvv = svv / n - mv * mv, cuv = suv / n - mu * mv;
    const cuh = suh / n - mu * meanH, cvh = svh / n - mv * meanH;
    const det = cuu * cvv - cuv * cuv;
    let b = 0, c = 0;
    if (Math.abs(det) > 1e-9) {
      b = (cuh * cvv - cvh * cuv) / det;
      c = (cvh * cuu - cuh * cuv) / det;
    } else if (cuu > 1e-9) b = cuh / cuu;
    else if (cvv > 1e-9) c = cvh / cvv;
    // The plane's normal in the heading frame, and the tilt that takes up to it.
    const nl = Math.hypot(b, 1, c);
    const nx = -b / nl, ny = 1 / nl, nz = -c / nl;
    const tilt = fromAxisAngle(nz, 0, -nx, Math.acos(Math.min(1, ny)));
    const heading = fromAxisAngle(0, 1, 0, yaw);
    const target = heading.multiply(tilt).normalize();
    const k = this.follow > 0 ? 1 - Math.exp(-this.follow * dt) : 1;
    t.worldPosition = new Vector3(px, py + (meanH - py) * k, pz);
    t.worldRotation = nlerp(t.worldRotation, target, k);
  }
}

function fromAxisAngle(x: number, y: number, z: number, angle: number): Quaternion {
  const len = Math.hypot(x, y, z);
  if (len < 1e-12 || Math.abs(angle) < 1e-12) return new Quaternion(0, 0, 0, 1);
  const s = Math.sin(angle / 2) / len;
  return new Quaternion(x * s, y * s, z * s, Math.cos(angle / 2));
}

/** Normalized lerp along the shorter arc. */
function nlerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  return new Quaternion(a.x + (b.x * sign - a.x) * t, a.y + (b.y * sign - a.y) * t, a.z + (b.z * sign - a.z) * t, a.w + (b.w * sign - a.w) * t).normalize();
}

/** The downward pull of gravity: the 3D physics world's, else the project's. */
function gravity(world: World): number {
  const g = world.physics3D?.gravity;
  if (g) return Math.hypot(g.x, g.y, g.z);
  const s = world.settings.physics.gravity as readonly number[];
  return Math.hypot(s[0] ?? 0, s[1] ?? -9.81, s[2] ?? 0);
}

// After scripts' fixedUpdate (so a script's waveScale or force this step counts) and before the 3D push.
defineBuiltinSystem({
  name: "engine.Buoyancy",
  phase: "fixedUpdate",
  after: ["engine.FixedUpdateScripts"],
  before: ["engine.Physics3DPush"],
  run: (world, dt) => {
    const floats = world._componentsOfType(Buoyancy);
    if (!floats.length) return;
    const time = waterTime(world);
    for (const b of floats) if (b.isActiveAndEnabled) b._step(world, time, dt);
  },
});
