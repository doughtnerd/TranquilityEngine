// Point editing for polygons drawn over an image or in a view (ADR 0437, moved from the Lights 2D plugin's gizmo model,
// ADR 0414): the handles an editable outline has (one per point and one mid-way along each edge), which handle a
// pointer is over, and what a press on one does (drag a point, insert one mid-edge and drag it, or remove one with
// Ctrl/⌘). Pure and unit-free: callers work in whatever space they draw in. Shared through the editor SDK by the
// Lights 2D plugin's Outline tool and scene-view gizmo and the Tilemaps plugin's tile collision editor.

export type V2 = [number, number];

/** What a press on an outline's handle does (see `pressPoints`). */
export type PointPress = { drag: number; points: V2[] } | { removed: V2[] } | { refused: string };

/** Handles for an editable outline: `p:i` at each point, and `insert:i` mid-way along the edge after it (closed: back to the first). */
export function pointHandles(points: readonly V2[], closed: boolean): Record<string, V2> {
  const out: Record<string, V2> = {};
  points.forEach((p, i) => (out[`p:${i}`] = [p[0], p[1]]));
  const edges = closed ? points.length : points.length - 1;
  for (let i = 0; i < edges && points.length >= 2; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    out[`insert:${i}`] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return out;
}

/** The point index a `p:i` handle names, or null for any other handle. */
export const pointIndex = (handle: string): number | null => {
  const m = /^p:(\d+)$/.exec(handle);
  return m ? Number(m[1]) : null;
};

/**
 * The handle of `handles` that `p` is over: the nearest within `radius`, a point (`p:i`) before an insert handle
 * (`insert:i`) when both are in reach, so a short edge's points stay draggable. Null when none is in reach.
 */
export function hitHandle(handles: Readonly<Record<string, V2>>, p: V2, radius: number): string | null {
  let best: string | null = null, bestD = Infinity, bestPoint = false;
  for (const [id, h] of Object.entries(handles)) {
    const d = Math.hypot(h[0] - p[0], h[1] - p[1]);
    if (d > radius) continue;
    const isPoint = id.startsWith("p:");
    if ((isPoint && !bestPoint) || (isPoint === bestPoint && d < bestD)) {
      best = id;
      bestD = d;
      bestPoint = isPoint;
    }
  }
  return best;
}

/** True when `p` is inside the closed polygon `points` (even-odd rule). */
export function insidePolygon(points: readonly V2[], p: V2): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * What a press on an outline's handle does: drag a point (`drag` is its index in `points`), insert one mid-edge and
 * drag it (`points` holds the new outline), remove one with Ctrl (never below `min` points), or nothing (null) for an
 * unknown handle. `points` isn't changed.
 */
export function pressPoints(points: readonly V2[], handle: string, ctrl: boolean, min = 3): PointPress | null {
  const copy = points.map((p): V2 => [p[0], p[1]]);
  const i = pointIndex(handle);
  if (i !== null && copy[i]) {
    if (!ctrl) return { drag: i, points: copy };
    if (copy.length <= min) return { refused: `An outline needs at least ${min} points.` };
    return { removed: copy.filter((_, k) => k !== i) };
  }
  const m = /^insert:(\d+)$/.exec(handle);
  if (m) {
    const at = Number(m[1]);
    const a = copy[at], b = copy[(at + 1) % copy.length];
    if (!a || !b) return null;
    copy.splice(at + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    return { drag: at + 1, points: copy };
  }
  return null;
}
