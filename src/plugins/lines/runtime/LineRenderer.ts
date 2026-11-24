/**
 * A line through points (ADR 0382), like Unity's `LineRenderer`: laser beams, aim guides, cables, paths. The points are
 * in world space by default (`useWorldSpace`, as in Unity) or in the node's space, so the line moves with it.
 */
import { Vector3, type Vec3Input } from "../../../engine/core/math";
import { component, field } from "../../../engine/core/registry";
import { RibbonRenderer } from "./RibbonRenderer";

@component("engine.LineRenderer")
export class LineRenderer extends RibbonRenderer {
  @field([Vector3], { description: "The points the line goes through, in order." })
  positions: Vector3[] = [new Vector3(0, 0, 0), new Vector3(0, 0, 1)];
  @field(Boolean, { description: "On: the points are in world space. Off: in the node's space, so the line moves, turns and scales with it." })
  useWorldSpace = true;
  @field(Boolean, { description: "Joins the last point back to the first." })
  loop = false;

  /** How many points the line has. */
  get positionCount(): number {
    return this.positions.length;
  }

  /** Replace the points (copied). */
  setPositions(points: readonly Vec3Input[]): void {
    this.positions = points.map((p) => Vector3.from(p));
  }

  /** Move point `index` (copied); an index past the end is ignored. */
  setPosition(index: number, point: Vec3Input): void {
    if (index < 0 || index >= this.positions.length) return;
    const next = this.positions.slice();
    next[index] = Vector3.from(point);
    this.positions = next;
  }

  /** Point `index` (a copy), or null past the end. */
  getPosition(index: number): Vector3 | null {
    const p = this.positions[index];
    return p ? p.clone() : null;
  }
}
