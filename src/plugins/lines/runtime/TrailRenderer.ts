/**
 * A trail behind a moving node (ADR 0382), like Unity's `TrailRenderer`: projectile streaks, sword swipes, skid marks.
 *
 * The history is game state, not drawing: the `lines.Trails` system (`trails.ts`) samples the node's world position
 * once a frame, after scripts' late update, ages the points by the World's scaled time and drops those older than
 * `lifetime` (Unity's `time`). So `positionCount` and `getPosition` read the same in a headless World as in the game. Points are in world
 * space; the newest is the head.
 */
import { Vector3, type Vec3Input } from "../../../engine/core/math";
import { component, field } from "../../../engine/core/registry";
import { RibbonRenderer } from "./RibbonRenderer";

/** At most this many points a trail keeps (a warning once if `lifetime` and the node's speed need more). */
export const MAX_TRAIL_POINTS = 1024;

@component("engine.TrailRenderer")
export class TrailRenderer extends RibbonRenderer {
  /** Unity's `time` (Component's `time` is the World clock, so the name is taken). */
  @field(Number, { description: "Seconds a point of the trail lives (Unity's time)." })
  lifetime = 1;
  @field(Number, { description: "A new point once the node has moved this far (world units) from the last one." })
  minVertexDistance = 0.1;
  @field(Boolean, { description: "Off: no new points; the trail ages out." })
  emitting = true;
  @field(Boolean, { description: "Destroys the node once its trail has aged out and nothing new was added (the node stood still, or stopped emitting), as Unity does." })
  autodestruct = false;

  /** @internal Fixed points, oldest first: x, y, z per point. */
  _points: number[] = [];
  /** @internal Each fixed point's age in seconds, oldest first. */
  _ages: number[] = [];
  /** @internal The live head (the node's position now) while emitting, or null. */
  _head: [number, number, number] | null = null;
  /** @internal Whether it has had a point since it last emptied (for `autodestruct`). */
  _hadPoints = false;

  /** How many points the trail has now, the live head included. */
  get positionCount(): number {
    return this._ages.length + (this._head ? 1 : 0);
  }

  /** Point `index` in world space, 0 the oldest (the last is the live head while emitting), written into `out` (or a new Vector3). */
  getPosition(index: number, out = new Vector3()): Vector3 {
    const n = this._ages.length;
    if (index >= 0 && index < n) return out.set(this._points[index * 3]!, this._points[index * 3 + 1]!, this._points[index * 3 + 2]!);
    if (index === n && this._head) return out.set(this._head[0], this._head[1], this._head[2]);
    return out.set(0, 0, 0);
  }

  /** The age in seconds of point `index` (0 the oldest; the live head is 0). */
  getAge(index: number): number {
    return this._ages[index] ?? 0;
  }

  /** Add a point (world space) now, as if the node had passed it: it ages like any other. */
  addPosition(point: Vec3Input): void {
    const p = Vector3.from(point);
    this._points.push(p.x, p.y, p.z);
    this._ages.push(0);
    this._hadPoints = true;
    this._trim();
  }

  /** Remove every point: after a teleport, a respawn or a network snap, so the trail doesn't streak across the jump. */
  clear(): void {
    this._points.length = 0;
    this._ages.length = 0;
    this._head = null;
  }

  /** @internal Drop the oldest points past `MAX_TRAIL_POINTS`; true when it dropped some. */
  _trim(): boolean {
    const extra = this._ages.length - MAX_TRAIL_POINTS;
    if (extra <= 0) return false;
    this._ages.splice(0, extra);
    this._points.splice(0, extra * 3);
    return true;
  }
}
