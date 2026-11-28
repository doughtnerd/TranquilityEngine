/**
 * LOD selection (ADR 0446 §2–3): for one view, each group's level from its screen-relative height, the frustum test,
 * shadow casters' levels and hysteresis. Pure TypeScript over flat arrays, no backend imports, no allocation per call
 * (`spikes/lod-select/`: about 0.23 ms a view for 10,000 groups with cached world spheres). Not public API.
 *
 * Screen-relative height h is the group's size as a share of the view's height: size / (2·d·tan(fovY / 2)) in
 * perspective (d the distance from the view to the group's sphere centre), size / (2·orthoHalfHeight) in
 * orthographic, then times the tier's `lodBias`. Level i draws while h ≥ heights[i]; below the last height the group is
 * LOD-culled.
 */
import { LOD_CULLED, type ViewKey, type VisibilityView } from "./types";

/** The groups selection reads, as flat arrays indexed by group (`count` used). */
export interface SelectionGroups {
  readonly count: number;
  /** World bounding sphere per group: x, y, z, radius. */
  readonly sphere: Float32Array;
  /** World size per group, the measure h is taken of. */
  readonly size: Float32Array;
  /** Every group's transition heights, descending, one per level: group g's are `heightCount[g]` values from `heightStart[g]`. */
  readonly heights: Float32Array;
  readonly heightStart: Uint32Array;
  /** At least 1 per group; at most 253. */
  readonly heightCount: Uint8Array;
  /** -1 chooses; n ≥ 0 always draws level n (`LODGroup.forceLevel`). */
  readonly forceLevel: Int16Array;
}

/** The quality tier's fields selection reads. */
export interface SelectionTier {
  readonly lodBias: number;
  readonly lodFirstLevel: number;
  /** How far LOD-culled groups keep casting shadows at their coarsest level, in world units. */
  readonly shadowDistance: number;
}

/** What selection writes, per group. */
export interface SelectionOut {
  /** The level to draw, or `LOD_CULLED`. Written for off-screen groups too (their shadows still draw). */
  readonly levels: Uint8Array;
  /** The level shadow casters draw, or `LOD_CULLED` (ADR 0446 §3). */
  readonly casterLevels: Uint8Array;
  /** 1 when the group's sphere is outside the view's frustum. */
  readonly hidden: Uint8Array;
  /** The crossfade value (0 steady); crossfade is a later task, so selection writes 0. */
  readonly fade: Float32Array;
}

/** A level change needs h to cross the threshold by this share (ADR 0446 §3). */
export const HYSTERESIS = 0.04;
/** In `SelectionState`: no level chosen yet. */
const NONE = 254;

/**
 * The level each group last had per persistent view, for hysteresis (ADR 0446 §3). Group indices must be stable across
 * frames; `forget` a group's index before giving it to another group.
 */
export class SelectionState {
  private readonly views = new Map<ViewKey, Uint8Array>();

  /** The previous levels for `key`, sized for at least `count` groups (new entries: none). */
  levelsFor(key: ViewKey, count: number): Uint8Array {
    let a = this.views.get(key);
    if (!a || a.length < count) {
      const grown = new Uint8Array(Math.max(count, a ? a.length * 2 : 16)).fill(NONE);
      if (a) grown.set(a);
      this.views.set(key, (a = grown));
    }
    return a;
  }

  /** Clear group `index`'s history in every view. */
  forget(index: number): void {
    for (const a of this.views.values()) if (index < a.length) a[index] = NONE;
  }

  /** Drop a view's history. */
  dropView(key: ViewKey): void {
    this.views.delete(key);
  }
}

/** The first level index whose height × `scale` h reaches, or `n` (culled). */
function pick(h: number, heights: Float32Array, start: number, n: number, scale: number): number {
  for (let i = 0; i < n; i++) if (h >= heights[start + i] * scale) return i;
  return n;
}

/**
 * Choose every group's level for `view` (ADR 0446 §3) into `out`, by group index. Hysteresis is kept in `state` when the
 * view is persistent; other views (probe faces, thumbnails) choose from h alone and leave `state` untouched.
 */
export function selectLevels(view: VisibilityView, groups: SelectionGroups, tier: SelectionTier, state: SelectionState, out: SelectionOut): void {
  const { count, sphere, size, heights, heightStart, heightCount, forceLevel } = groups;
  const planes = view.planes;
  const [px, py, pz] = view.position;
  const perspective = view.projection === "perspective";
  const bias = tier.lodBias;
  // h = size × k / d in perspective, size × k in orthographic.
  const k = perspective ? bias / (2 * Math.tan(view.fovY / 2)) : bias / (2 * Math.max(view.orthoHalfHeight, 1e-9));
  const firstLevel = tier.lodFirstLevel;
  const shadowDistance = tier.shadowDistance;
  const prev = view.persistent ? state.levelsFor(view.key, count) : null;
  const down = 1 - HYSTERESIS, up = 1 + HYSTERESIS;
  for (let g = 0; g < count; g++) {
    const s = g * 4;
    const x = sphere[s], y = sphere[s + 1], z = sphere[s + 2], r = sphere[s + 3];
    let outside = 0;
    for (let p = 0; p < 24; p += 4) {
      if (planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3] < -r) {
        outside = 1;
        break;
      }
    }
    out.hidden[g] = outside;
    out.fade[g] = 0;
    const d = Math.hypot(x - px, y - py, z - pz);
    const h = perspective ? (size[g] * k) / Math.max(d, 1e-9) : size[g] * k;
    const start = heightStart[g], n = heightCount[g];
    let index: number;
    if (prev) {
      const was = prev[g];
      if (was === NONE) index = pick(h, heights, start, n, 1);
      else {
        const p = Math.min(was === LOD_CULLED ? n : was, n);
        const coarser = pick(h, heights, start, n, down), finer = pick(h, heights, start, n, up);
        index = p < coarser ? coarser : p > finer ? finer : p;
      }
      prev[g] = index >= n ? LOD_CULLED : index;
    } else index = pick(h, heights, start, n, 1);
    let level: number;
    const forced = forceLevel[g];
    if (forced >= 0) level = Math.min(forced, LOD_CULLED - 1);
    else if (index >= n) level = LOD_CULLED;
    else level = Math.max(index, Math.min(firstLevel, n - 1));
    out.levels[g] = level;
    if (level !== LOD_CULLED) out.casterLevels[g] = level;
    else out.casterLevels[g] = d - r <= shadowDistance ? n - 1 : LOD_CULLED;
  }
}

/** Automatic heights' last value: culled below 1 % of the view's height (ADR 0446 §2). */
export const AUTOMATIC_CULL_HEIGHT = 0.01;
/** The reference view height automatic heights are measured at. */
const REFERENCE_HEIGHT_PX = 1080;
/** An automatic height for a level with no error (it may draw at any size). */
const NO_ERROR_HEIGHT = 1e6;

/** One mesh's generated levels, as automatic heights read them (`ModelLods`). */
export interface MeshLevelErrors {
  /** Level 0's error is 0. */
  readonly levels: readonly { readonly error: number }[];
  readonly pixelError: number;
}

/**
 * Transition heights derived from members' measured errors (ADR 0446 §2), for a group whose `levels` is empty. A level
 * is good enough while its error covers under `pixelError` pixels at 1080p: the group leaves level i for i + 1 once
 * h < pixelError / (1080 × error of i + 1). Every member must be good enough, so each height is the smallest over the
 * members (one past its last level, a member draws its last). The last value is 0.01. With no member levels: `[0]`,
 * LOD0 and never culled.
 */
export function automaticHeights(meshes: readonly MeshLevelErrors[]): number[] {
  let n = 0;
  for (const m of meshes) n = Math.max(n, m.levels.length);
  if (n <= 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    let hgt = NO_ERROR_HEIGHT;
    for (const m of meshes) {
      const last = m.levels.length - 1;
      if (last < 1) continue;
      const error = m.levels[Math.min(i + 1, last)].error;
      if (error > 0) hgt = Math.min(hgt, m.pixelError / (REFERENCE_HEIGHT_PX * error));
    }
    out.push(i > 0 ? Math.min(hgt, out[i - 1]) : hgt);
  }
  out.push(Math.min(AUTOMATIC_CULL_HEIGHT, out[n - 2]));
  return out;
}
