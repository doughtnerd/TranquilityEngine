/**
 * Automatic 2D skin weights by bone distance (ADR 0371 "2D bones": "weights are painted or computed automatically by
 * bone distance"). Each bone is the segment from its origin along its x axis for its `length` (a point when the length
 * is 0), at the bind pose. A vertex's weight for a bone falls off with the inverse square of its distance to that
 * segment (Blender's envelope-free "automatic weights" fallback and Unity 2D's distance mode); the 4 largest are kept
 * and normalised. A vertex on a bone takes it alone.
 *
 * Vertices and bones are in slice pixels (`sidecar.ts`). Pure. Internal: not public API.
 */
import { affineApply } from "./affine2d";
import { normalisedPairs, type Bone2D } from "./sidecar";
import { boneBinds, PIXEL_FRAME } from "./skeleton2d";
import { segmentDistance, type Point2 } from "./triangulate";

/** @internal Distances below this (pixels) count as on the bone. */
const ON_BONE = 1e-3;

/** @internal Per vertex (`vertices`: x, y pairs), `[bone, weight…]` pairs into `bones`: at most 4, summing to 1, largest first. Empty without bones. */
export function autoWeights(vertices: readonly number[], bones: readonly Bone2D[]): number[][] {
  const binds = boneBinds(bones, PIXEL_FRAME);
  const segments = bones.map((b, i): [Point2, Point2] => [affineApply(binds[i]!, 0, 0), affineApply(binds[i]!, b.length, 0)]);
  const out: number[][] = [];
  for (let v = 0; v + 1 < vertices.length; v += 2) {
    if (!bones.length) {
      out.push([]);
      continue;
    }
    const p: Point2 = [vertices[v]!, vertices[v + 1]!];
    const d = segments.map(([a, b]) => segmentDistance(p, a, b));
    const on = d.findIndex((x) => x < ON_BONE);
    out.push(on >= 0 ? [on, 1] : normalisedPairs(d.map((x, i): [number, number] => [i, 1 / (x * x)])));
  }
  return out;
}
