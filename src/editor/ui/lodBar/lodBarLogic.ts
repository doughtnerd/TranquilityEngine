// The LODGroup inspector's LOD bar as pure functions (ADR 0446 §2, §7): where each level's segment sits from the
// transition heights, what a drag does to them, and how the automatic heights are made explicit.
//
// The bar's axis is the screen-relative height h: 100% on the left (the group fills the view), 0% on the right. A group's
// `levels` are descending heights, one per level: level i draws while h ≥ levels[i], and below the last value the group is
// culled (a last value of 0 never culls). So level 0 spans [levels[0], 1], level i spans [levels[i], levels[i-1]) and the
// culled segment spans [0, levels[last]).

/** The most levels a group has (`LODGroup.levels`, ADR 0446 §2). */
export const MAX_LEVELS = 8;
/** The closest two dividers can get, as a height. */
export const MIN_GAP = 0.001;

/** One segment of the bar. */
export interface BarSegment {
  /** The level it draws, or -1 for the culled segment. */
  readonly level: number;
  /** The height it starts at (its left edge; 1 for LOD0). */
  readonly from: number;
  /** The height it ends at (its right edge; the next divider, 0 for the culled segment). */
  readonly to: number;
  /** Left edge and width as fractions of the bar. */
  readonly left: number;
  readonly width: number;
}

/** A draggable divider: the height where `level` stops drawing. */
export interface BarDivider {
  /** Index into `levels`: the divider after level `index` (the last one is the cull height). */
  readonly index: number;
  readonly height: number;
  /** Its position as a fraction of the bar. */
  readonly left: number;
}

export interface BarLayout {
  readonly segments: readonly BarSegment[];
  readonly dividers: readonly BarDivider[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 10000) / 10000;

/** A height as a position on the bar, 0 (left, h = 1) to 1 (right, h = 0). */
export const heightToFraction = (h: number): number => 1 - clamp(h, 0, 1);

/** A position on the bar as a height. */
export const fractionToHeight = (f: number): number => 1 - clamp(f, 0, 1);

/**
 * The bar for transition heights: a segment per level, then a culled one unless the last height is 0. Heights above 1
 * show at the left edge. A segment whose heights coincide has no width.
 */
export function layoutBar(heights: readonly number[]): BarLayout {
  const segments: BarSegment[] = [];
  const dividers: BarDivider[] = [];
  let from = 1;
  heights.forEach((h, i) => {
    const edge = Math.min(from, clamp(h, 0, 1));
    segments.push({ level: i, from, to: edge, left: heightToFraction(from), width: from - edge });
    dividers.push({ index: i, height: h, left: heightToFraction(h) });
    from = edge;
  });
  if (heights.length > 0 && from > 0) segments.push({ level: -1, from, to: 0, left: heightToFraction(from), width: from });
  return { segments, dividers };
}

/**
 * The heights after dragging divider `index` to `height`: kept between its neighbours (the divider before it and after
 * it, or 1 and 0 at the ends) so the list stays descending, rounded to four decimals. Dragging the last divider to the
 * far right gives 0, which never culls.
 */
export function dragDivider(heights: readonly number[], index: number, height: number): number[] {
  if (index < 0 || index >= heights.length || !Number.isFinite(height)) return [...heights];
  const upper = index > 0 ? heights[index - 1] - MIN_GAP : 1;
  const lower = index < heights.length - 1 ? heights[index + 1] + MIN_GAP : 0;
  const next = [...heights];
  next[index] = round(clamp(height, Math.min(lower, upper), upper));
  return next;
}

/**
 * The heights a drag starts from: the group's `levels`, or, when they are empty (automatic), the automatic heights, so
 * the first drag turns them explicit. Null when there's nothing to drag (no levels generated: automatic gives `[0]`, a
 * single level).
 */
export function heightsToEdit(levels: readonly number[], automatic: readonly number[]): number[] | null {
  const heights = levels.length > 0 ? levels : automatic;
  return heights.length > 1 ? [...heights] : null;
}

/** Triangles in a level, summed over a group's meshes; a mesh with fewer levels counts its last. */
export interface MeshTriangles {
  /** Triangles per level of one mesh, LOD0 first (a single entry when it has no levels). */
  readonly levels: readonly number[];
}

export function levelTriangles(meshes: readonly MeshTriangles[], level: number): number {
  let n = 0;
  for (const m of meshes) if (m.levels.length) n += m.levels[Math.min(level, m.levels.length - 1)];
  return n;
}

/** A height as the percentage the bar labels show: "14.9%". */
export function percentLabel(h: number): string {
  const p = h * 100;
  return `${p >= 10 ? Math.round(p * 10) / 10 : Math.round(p * 100) / 100}%`;
}

/** A segment's text: "LOD1", its transition height and its triangle count; the culled segment is just "Culled". */
export function segmentLabel(segment: BarSegment, heights: readonly number[], triangles: number | null): { name: string; height: string; triangles: string } {
  if (segment.level < 0) return { name: "Culled", height: `< ${percentLabel(heights[heights.length - 1] ?? 0)}`, triangles: "" };
  return {
    name: `LOD${segment.level}`,
    height: `≥ ${percentLabel(heights[segment.level])}`,
    triangles: triangles === null ? "" : `${triangles.toLocaleString("en-US")} tris`,
  };
}

/** The colour token of a level's segment (`--lod0`…`--lod7`; the culled segment's is `--lod-culled`). */
export const segmentColor = (level: number): string => (level < 0 ? "var(--lod-culled)" : `var(--lod${Math.min(level, MAX_LEVELS - 1)})`);
