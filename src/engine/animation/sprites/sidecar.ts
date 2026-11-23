/**
 * Sprites and 2D (ADR 0371, amending 0040): an image sidecar's `flipbooks` and a slice's `skin`.
 *
 * ```jsonc
 * "flipbooks": {                       // each compiles to a clip `image.png#Flip/<name>`
 *   "run": { "slices": ["run_0", "run_1", "run_2"], "fps": 12, "loop": true }   // fps default 12, loop default true
 * },
 * "sprites": [{ "name": "torso", "rect": [0, 0, 64, 96], "pivot": [0.5, 0],
 *   "skin": {
 *     "bones": [{ "name": "hip", "position": [32, 10], "rotation": 90, "length": 40 },   // root: slice pixels
 *               { "name": "chest", "parent": "hip", "position": [40, 0], "length": 30 }],  // child: parent's frame
 *     "mesh": { "vertices": [0, 0, 64, 0, 64, 96, 0, 96], "triangles": [0, 1, 2, 0, 2, 3] },
 *     "weights": [[0, 1], [0, 1], [1, 1], [0, 0.5, 1, 0.5]]    // per vertex: bone index, weight pairs (≤ 4)
 *   } }]
 * ```
 *
 * - **Units:** pixels in the slice's own frame: x right from the slice rect's left edge, y up from its bottom edge.
 *   A root bone's `position` is in that frame; a child's is in its parent's frame (along the parent's x axis is
 *   "along the bone"). `rotation` is degrees counter-clockwise, relative to the parent. `length` is pixels.
 * - **Sharing a skeleton:** each slice lists the bones its weights use (indices into its own `bones`), with their
 *   bind pose in its own frame. A `Skeleton2D` names one slice whose bones are the skeleton; the other slices' bones
 *   bind to it by name (a cut-out character).
 * - `mesh` absent: the runtime draws the slice rectangle as a grid; `weights` absent: computed from bone distance
 *   (`autoWeights.ts`). The editor's tools (0373) write both.
 *
 * The parse is lenient (one problem line, defaults, nothing throws; ADR 0306) and its limits are `SPRITE_2D_LIMITS`,
 * declared once. Pure. Internal: not public API.
 */
import { compact, isFiniteNumber, LenientReader, limited, type JsonRecord } from "../shared";

/** @internal Limits of the flipbook and skin sections, declared once (ADR 0306). */
export const SPRITE_2D_LIMITS = Object.freeze({ flipbooks: 256, framesPerFlipbook: 1024, maxFps: 240, bones: 128, vertices: 4096, triangles: 8192, influences: 4 });

/** @internal The default flipbook rate, frames per second. */
export const DEFAULT_FLIPBOOK_FPS = 12;

/** @internal One flipbook: slices shown in turn at `fps`. */
export interface SpriteFlipbook {
  readonly slices: readonly string[];
  readonly fps: number;
  readonly loop: boolean;
}

/** @internal One 2D bone, in its slice's pixel frame (see the module comment). */
export interface Bone2D {
  readonly name: string;
  /** The parent bone's name, or null for a root. */
  readonly parent: string | null;
  readonly position: readonly [number, number];
  /** Degrees counter-clockwise, relative to the parent. */
  readonly rotation: number;
  /** Pixels along the bone's x axis. */
  readonly length: number;
}

/** @internal A slice's mesh: x, y per vertex (slice pixels) and three vertex indices per triangle. */
export interface SpriteMesh {
  readonly vertices: readonly number[];
  readonly triangles: readonly number[];
}

/** @internal A slice's 2D skin. */
export interface SliceSkin {
  readonly bones: readonly Bone2D[];
  readonly mesh: SpriteMesh | null;
  /** Per vertex of `mesh`: `[bone, weight, bone, weight…]` (at most 4 pairs, weights summing to 1); null: automatic. */
  readonly weights: readonly (readonly number[])[] | null;
}

/** @internal A name a flipbook may have: what a slice name allows (no `#`, `/`, `\` or quotes, not blank). */
export function whyNotFlipbookName(name: string): string | null {
  if (name.trim() === "") return "a name can't be empty";
  if (/[#/\\"']/.test(name)) return "a name can't contain # / \\ or quotes";
  return null;
}

/** @internal An image sidecar's `flipbooks` (absent or bad: none). */
export function parseFlipbooks(raw: unknown, where: string, problems: string[]): Record<string, SpriteFlipbook> {
  const out: Record<string, SpriteFlipbook> = {};
  if (raw === undefined || raw === null) return out;
  const r = new LenientReader(problems);
  const o = r.record(raw, where);
  if (!o) return out;
  const entries = Object.entries(o);
  if (entries.length > SPRITE_2D_LIMITS.flipbooks) r.problem(where, `at most ${SPRITE_2D_LIMITS.flipbooks} flipbooks; the rest are dropped.`);
  for (const [name, value] of entries.slice(0, SPRITE_2D_LIMITS.flipbooks)) {
    const at = `${where}.${name}`;
    const why = whyNotFlipbookName(name);
    if (why) {
      r.problem(at, `${why}; skipped.`);
      continue;
    }
    const f = r.record(value, at);
    if (!f) continue;
    const slices: string[] = [];
    limited(r, f.slices, `${at}.slices`, SPRITE_2D_LIMITS.framesPerFlipbook, "frames").forEach((s, i) => {
      if (typeof s === "string" && s !== "") slices.push(s);
      else r.problem(`${at}.slices[${i}]`, "must be a slice name; dropped.");
    });
    let fps = DEFAULT_FLIPBOOK_FPS;
    if (f.fps !== undefined) {
      if (isFiniteNumber(f.fps) && f.fps > 0 && f.fps <= SPRITE_2D_LIMITS.maxFps) fps = f.fps;
      else r.problem(`${at}.fps`, `must be above 0 and at most ${SPRITE_2D_LIMITS.maxFps}; using ${DEFAULT_FLIPBOOK_FPS}.`);
    }
    out[name] = { slices, fps, loop: r.bool(f.loop, `${at}.loop`, true) };
  }
  return out;
}

/** @internal The `flipbooks` JSON to write, or undefined for none. */
export function flipbooksToJson(flipbooks: Readonly<Record<string, SpriteFlipbook>> | null | undefined): JsonRecord | undefined {
  const entries = Object.entries(flipbooks ?? {});
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([name, f]) => [name, compact({ slices: [...f.slices], fps: f.fps === DEFAULT_FLIPBOOK_FPS ? undefined : f.fps, loop: f.loop ? undefined : false })]));
}

/** Parent names in order with no cycle: a bone whose parent is unknown, itself, or makes a cycle becomes a root. */
function resolveParents(r: LenientReader, bones: Bone2D[], where: string): Bone2D[] {
  const byName = new Map(bones.map((b) => [b.name, b]));
  return bones.map((b, i) => {
    if (b.parent === null) return b;
    let fixed: Bone2D | null = null;
    if (!byName.has(b.parent) || b.parent === b.name) {
      r.problem(`${where}[${i}].parent`, `no bone named "${b.parent}"; it's a root.`);
      fixed = { ...b, parent: null };
    } else {
      const seen = new Set([b.name]);
      for (let p: string | null = b.parent; p !== null && !fixed; p = byName.get(p)?.parent ?? null) {
        if (seen.has(p)) {
          r.problem(`${where}[${i}].parent`, "makes a cycle; it's a root.");
          fixed = { ...b, parent: null };
        }
        seen.add(p);
      }
    }
    if (!fixed) return b;
    byName.set(b.name, fixed); // later bones see the cycle broken
    return fixed;
  });
}

/** @internal A slice's `skin` (null when absent or not an object). */
export function parseSliceSkin(raw: unknown, where: string, problems: string[]): SliceSkin | null {
  if (raw === undefined || raw === null) return null;
  const r = new LenientReader(problems);
  const o = r.record(raw, where);
  if (!o) return null;
  const bones: Bone2D[] = [];
  const names = new Set<string>();
  limited(r, o.bones, `${where}.bones`, SPRITE_2D_LIMITS.bones, "bones").forEach((b, i) => {
    const at = `${where}.bones[${i}]`;
    const rec = r.record(b, at);
    if (!rec) return;
    const name = r.str(rec.name, `${at}.name`, "");
    if (name === "" || names.has(name)) {
      r.problem(at, name === "" ? "a bone needs a name; skipped." : `there's already a bone named "${name}"; skipped.`);
      return;
    }
    names.add(name);
    const position = Array.isArray(rec.position) && rec.position.length === 2 && rec.position.every(isFiniteNumber) ? ([rec.position[0] + 0, rec.position[1] + 0] as [number, number]) : null;
    if (rec.position !== undefined && !position) r.problem(`${at}.position`, "must be [x, y] pixels; using [0, 0].");
    bones.push({
      name,
      parent: r.strOrNull(rec.parent, `${at}.parent`, null) || null,
      position: position ?? [0, 0],
      rotation: r.num(rec.rotation, `${at}.rotation`, 0),
      length: r.num(rec.length, `${at}.length`, 0, 0),
    });
  });
  const resolved = resolveParents(r, bones, `${where}.bones`);
  const mesh = parseMesh(r, o.mesh, `${where}.mesh`);
  const weights = mesh ? parseWeights(r, o.weights, `${where}.weights`, mesh.vertices.length / 2, resolved.length) : null;
  if (!mesh && o.weights !== undefined) r.problem(`${where}.weights`, "weights need a mesh; ignored.");
  return { bones: resolved, mesh, weights };
}

function parseMesh(r: LenientReader, raw: unknown, where: string): SpriteMesh | null {
  const o = r.record(raw, where);
  if (!o) return null;
  const v = o.vertices, t = o.triangles;
  if (!Array.isArray(v) || v.length < 6 || v.length % 2 !== 0 || !v.every(isFiniteNumber)) {
    r.problem(`${where}.vertices`, "must be x, y pairs (at least 3 vertices); the mesh is ignored.");
    return null;
  }
  const count = v.length / 2;
  if (count > SPRITE_2D_LIMITS.vertices) {
    r.problem(`${where}.vertices`, `at most ${SPRITE_2D_LIMITS.vertices} vertices; the mesh is ignored.`);
    return null;
  }
  if (!Array.isArray(t) || t.length < 3 || t.length % 3 !== 0 || !t.every((i) => Number.isInteger(i) && i >= 0 && i < count)) {
    r.problem(`${where}.triangles`, "must be vertex index triples; the mesh is ignored.");
    return null;
  }
  if (t.length / 3 > SPRITE_2D_LIMITS.triangles) {
    r.problem(`${where}.triangles`, `at most ${SPRITE_2D_LIMITS.triangles} triangles; the mesh is ignored.`);
    return null;
  }
  return { vertices: v.map((x: number) => x + 0), triangles: [...(t as number[])] };
}

function parseWeights(r: LenientReader, raw: unknown, where: string, vertices: number, bones: number): (readonly number[])[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length !== vertices) {
    r.problem(where, `must list ${vertices} vertices' weights; computed from bone distance instead.`);
    return null;
  }
  let bad = false;
  const out = raw.map((w) => {
    if (!Array.isArray(w) || w.length % 2 !== 0) {
      bad = true;
      return [];
    }
    const pairs: [number, number][] = [];
    for (let i = 0; i < w.length; i += 2) {
      const b = w[i], x = w[i + 1];
      if (!Number.isInteger(b) || b < 0 || b >= bones || !isFiniteNumber(x) || x < 0) bad = true;
      else if (x > 0) pairs.push([b, x]);
    }
    return normalisedPairs(pairs);
  });
  if (bad) r.problem(where, "has entries that aren't [bone, weight…] pairs of a known bone and a weight ≥ 0; those are dropped.");
  return out;
}

/** @internal `[bone, weight]` pairs as a weights entry: the 4 largest (merged per bone), summing to 1, largest first. */
export function normalisedPairs(pairs: readonly (readonly [number, number])[]): number[] {
  const merged = new Map<number, number>();
  for (const [b, w] of pairs) merged.set(b, (merged.get(b) ?? 0) + w);
  const top = [...merged].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, SPRITE_2D_LIMITS.influences);
  const sum = top.reduce((s, [, w]) => s + w, 0);
  return sum > 0 ? top.flatMap(([b, w]) => [b, w / sum]) : [];
}

/** @internal A skin's JSON (bones keep only non-default members). */
export function sliceSkinToJson(skin: SliceSkin): JsonRecord {
  return compact({
    bones: skin.bones.map((b) => compact({ name: b.name, parent: b.parent ?? undefined, position: [...b.position], rotation: b.rotation || undefined, length: b.length || undefined })),
    mesh: skin.mesh ? { vertices: [...skin.mesh.vertices], triangles: [...skin.mesh.triangles] } : undefined,
    weights: skin.weights ? skin.weights.map((w) => [...w]) : undefined,
  });
}
