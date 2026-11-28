/**
 * LOD selection (ADR 0446 §2–3): for one view, each group's level from its screen-relative height, the frustum test,
 * shadow casters' levels and hysteresis. Pure TypeScript over flat arrays, no backend imports, no allocation per call
 * (`spikes/lod-select/`: about 0.23 ms a view for 10,000 groups with cached world spheres). Not public API.
 *
 * Screen-relative height h is the group's size as a share of the view's height: size / (2·d·tan(fovY / 2)) in
 * perspective (d the distance from the view to the group's sphere centre), size / (2·orthoHalfHeight) in
 * orthographic, then times the tier's `lodBias`. Level i draws while h ≥ heights[i]; below the last height the group is
 * LOD-culled.
 *
 * **Crossfade (ADR 0446 §4).** In a persistent view, a group whose `fadeDuration` is above 0 (its `fade` is
 * `"crossfade"`) fades from its old level to its new one over that many seconds while the tier's `lodCrossfade` is on:
 * both levels draw, each discarding a complementary dither pattern. A fade reversed midway runs back from its progress;
 * a change to a third level fades from whichever of the two showed more. Other views, and groups with no duration, snap.
 * Shadow casters switch at the fade's midpoint.
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
  /** Seconds a level change crossfades over per group; 0 (or absent) snaps (`LODGroup.fade` `"none"`). */
  readonly fadeDuration?: Float32Array;
}

/** The quality tier's fields selection reads. */
export interface SelectionTier {
  readonly lodBias: number;
  readonly lodFirstLevel: number;
  /** How far LOD-culled groups keep casting shadows at their coarsest level, in world units. */
  readonly shadowDistance: number;
  /** Whether level changes may crossfade (ADR 0446 §5); absent: off. */
  readonly lodCrossfade?: boolean;
}

/** What selection writes, per group. */
export interface SelectionOut {
  /** The level to draw, or `LOD_CULLED`. Written for off-screen groups too (their shadows still draw). */
  readonly levels: Uint8Array;
  /** The level shadow casters draw, or `LOD_CULLED` (ADR 0446 §3). */
  readonly casterLevels: Uint8Array;
  /** 1 when the group's sphere is outside the view's frustum. */
  readonly hidden: Uint8Array;
  /**
   * The crossfade value of the level in `levels` (the incoming one), 0 while steady: during a fade it is
   * `fadeIn(t)`, never 0, and the outgoing level in `fadeFrom` draws with `fadeOut(t)` (ADR 0446 §4).
   */
  readonly fade: Float32Array;
  /** During a fade, the outgoing level (or `LOD_CULLED` when fading in from culled); `LOD_CULLED` while steady. */
  readonly fadeFrom?: Uint8Array;
}

/**
 * An incoming level's fade value at progress t (0–1): the complement of the outgoing one, encoded negative. At t = 0 it
 * is a tiny negative, as -0 isn't < 0 and would draw the incoming level whole (ADR 0446 §4, `spikes/lod-crossfade/`).
 * The shader keeps the pixels whose 4×4 Bayer rank is below round(16·|f|).
 */
export function fadeIn(t: number): number {
  return -Math.max(t, FADE_EPSILON);
}

/** An outgoing (or steady) level's fade value at progress t: the shader keeps the pixels whose rank is at least round(16·f). */
export function fadeOut(t: number): number {
  return Math.max(t, 0);
}

/** The outgoing level's value for an incoming value `f` from `fadeIn` (the same progress, positive). */
export function outgoingOf(f: number): number {
  return fadeOut(-f);
}

/** The magnitude of an incoming fade value at t = 0: far below the shader's 1/32 rounding step. */
const FADE_EPSILON = 1e-6;

/** A level change needs h to cross the threshold by this share (ADR 0446 §3). */
export const HYSTERESIS = 0.04;
/** In `SelectionState`: no level chosen yet; in a fade's `from`: not fading. */
const NONE = 254;

/** One persistent view's crossfades, by group. */
interface FadeState {
  /** The level last drawn (the incoming one during a fade), or `NONE`. */
  level: Uint8Array;
  /** The outgoing level during a fade, else `NONE`. */
  from: Uint8Array;
  /** The fade's progress, 0–1. */
  t: Float32Array;
  /** The time the view was last selected at (seconds), or NaN. */
  time: number;
}

/**
 * The level each group last had per persistent view, for hysteresis (ADR 0446 §3). Group indices must be stable across
 * frames; `forget` a group's index before giving it to another group.
 */
export class SelectionState {
  private readonly views = new Map<ViewKey, Uint8Array>();
  private readonly fades = new Map<ViewKey, FadeState>();

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

  /** The crossfades for `key`, sized for at least `count` groups (new entries: none). */
  fadesFor(key: ViewKey, count: number): FadeState {
    let f = this.fades.get(key);
    if (!f || f.level.length < count) {
      const n = Math.max(count, f ? f.level.length * 2 : 16);
      const level = new Uint8Array(n).fill(NONE), from = new Uint8Array(n).fill(NONE), t = new Float32Array(n);
      if (f) {
        level.set(f.level);
        from.set(f.from);
        t.set(f.t);
      }
      this.fades.set(key, (f = { level, from, t, time: f?.time ?? NaN }));
    }
    return f;
  }

  /** Clear group `index`'s history (and any fade) in every view. */
  forget(index: number): void {
    for (const a of this.views.values()) if (index < a.length) a[index] = NONE;
    for (const f of this.fades.values()) {
      if (index >= f.level.length) continue;
      f.level[index] = NONE;
      f.from[index] = NONE;
      f.t[index] = 0;
    }
  }

  /** Drop a view's history. */
  dropView(key: ViewKey): void {
    this.views.delete(key);
    this.fades.delete(key);
  }
}

/** The first level index whose height × `scale` h reaches, or `n` (culled). */
function pick(h: number, heights: Float32Array, start: number, n: number, scale: number): number {
  for (let i = 0; i < n; i++) if (h >= heights[start + i] * scale) return i;
  return n;
}

/**
 * Choose every group's level for `view` (ADR 0446 §3) into `out`, by group index. Hysteresis and crossfades are kept in
 * `state` when the view is persistent; other views (probe faces, thumbnails) choose from h alone, snap, and leave `state`
 * untouched. `time` is the engine's clock in seconds: fades advance by the time since the view was last selected.
 */
export function selectLevels(view: VisibilityView, groups: SelectionGroups, tier: SelectionTier, state: SelectionState, out: SelectionOut, time = 0): void {
  const { count, sphere, size, heights, heightStart, heightCount, forceLevel, fadeDuration } = groups;
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
  const fades = view.persistent ? state.fadesFor(view.key, count) : null;
  let dt = 0;
  if (fades) {
    dt = Number.isNaN(fades.time) ? 0 : Math.max(0, time - fades.time);
    fades.time = time;
  }
  const crossfade = !!tier.lodCrossfade && !!fadeDuration;
  const fadeFrom = out.fadeFrom;
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
    // Casters draw the level shown more: the outgoing one until a fade's midpoint (ADR 0446 §3).
    let cast = level;
    let from: number = NONE;
    if (fades) {
      const duration = crossfade ? fadeDuration![g] : 0;
      from = stepFade(fades, g, level, duration > 0 ? dt / duration : -1);
      if (from !== NONE) {
        const t = fades.t[g];
        out.fade[g] = fadeIn(t);
        if (t < 0.5) cast = from;
      }
    }
    if (fadeFrom) fadeFrom[g] = from === NONE ? LOD_CULLED : from;
    if (cast !== LOD_CULLED) out.casterLevels[g] = cast;
    else out.casterLevels[g] = d - r <= shadowDistance ? n - 1 : LOD_CULLED;
  }
}

/**
 * Advance group `g`'s fade in one view by `step` (the share of its duration that passed; below 0 when it can't
 * crossfade, which snaps), towards `level`. Returns the outgoing level while it fades, else `NONE`.
 */
function stepFade(f: FadeState, g: number, level: number, step: number): number {
  const shown = f.level[g];
  f.level[g] = level;
  if (step < 0 || shown === NONE) {
    f.from[g] = NONE;
    f.t[g] = 0;
    return NONE;
  }
  let from = f.from[g];
  let t = f.t[g];
  if (from !== NONE) t += step;
  if (level !== shown) {
    if (from === NONE) {
      from = shown;
      t = 0;
    } else if (level === from && t < 1) {
      // Reversed: run back from where it is.
      from = shown;
      t = 1 - t;
    } else {
      // A third level: fade to it from the one that showed more.
      from = t < 0.5 ? from : shown;
      t = 0;
    }
  }
  if (from !== NONE && t >= 1) {
    from = NONE;
    t = 0;
  }
  f.from[g] = from;
  f.t[g] = t;
  return from;
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
