// The 2D bone editor's rules (ADR 0371 "2D bones", 0373 "2D tools"; T56): edits of a slice's skin (`skin.bones`, `skin.mesh`,
// `skin.weights`, `engine/animation/sprites/sidecar.ts`), pure and each one a single refused-or-next result (ADR 0307, 0313),
// so the Sprite Editor puts each on its history as one step. Everything is in the slice's pixel frame (x right from the
// rect's left edge, y up from its bottom edge): a root bone's `position` is in that frame, a child's in its parent's frame
// (along the parent's x axis is "along the bone"), `rotation` is degrees counter-clockwise relative to the parent.
//
// **Auto-weights have two modes** (the format stores only the resulting weights):
// - `distance` (default; the engine's `autoWeights`): inverse square of the distance to each bone's segment, the four
//   largest kept and normalised: every vertex gets a smooth blend and the nearest bone dominates. Unity 2D Animation's
//   "distance" and Blender's automatic fallback.
// - `envelope`: each bone has a reach (`ENVELOPE_RADIUS_RATIO` × its length, at least `ENVELOPE_MIN_RADIUS` px, since the format
//   has no radius field) and a vertex takes `(1 − distance / reach)²` of every bone whose reach holds it, so a vertex far
//   from a bone is untouched by it and joints blend only where reaches overlap (Spine/Blender envelopes). A vertex outside
//   every reach takes its nearest bone alone, so every vertex always has weights.
// Either way a vertex's weights are at most four bones summing to 1, which every edit here keeps (`normalisedPairs`).
//
// **Painting** applies a brush stroke: vertices within `radius` of the centre take `strength × (1 − distance / radius)` of the
// stroke. `add` moves that fraction toward the chosen bone (the others scale down to make room), `subtract` takes it away
// (the others scale up), and `smooth` blends the vertex toward the average of its neighbours' weights. Every touched vertex
// is normalised after, and a vertex never loses its last influence.
import { refuse, accept, type EditResult } from "../../../../editor/sdk";
import { affineApply, affineInvert, type Affine2 } from "../../../../engine/animation/sprites/affine2d";
import { autoWeights } from "../../../../engine/animation/sprites/autoWeights";
import type { Pixels } from "../../../../engine/animation/sprites/islands";
import { normalisedPairs, SPRITE_2D_LIMITS, type Bone2D, type SliceSkin, type SpriteMesh } from "../../../../engine/animation/sprites/sidecar";
import { boneBinds, PIXEL_FRAME } from "../../../../engine/animation/sprites/skeleton2d";
import { outlineMesh, rectMesh } from "../../../../engine/animation/sprites/spriteMesh";
import { segmentDistance, type Point2 } from "../../../../engine/animation/sprites/triangulate";

/** A skin with no bones, mesh or weights. */
export const EMPTY_SKIN: SliceSkin = Object.freeze({ bones: [], mesh: null, weights: null });

/** How a bone's reach in the `envelope` mode is made (see the file comment). */
export const ENVELOPE_RADIUS_RATIO = 0.6;
/** The smallest reach, pixels. */
export const ENVELOPE_MIN_RADIUS = 4;

/** How automatic weights are made. */
export type AutoWeightMode = "distance" | "envelope";

/** A slice's rect as `[x, y, width, height]` in image pixels from the image's top-left corner (the sidecar's). */
export type SliceRect = readonly [number, number, number, number];

/** An image-pixel point (y down from the image's top) as a slice-frame point (y up from the slice's bottom). */
export const toSlicePoint = (rect: SliceRect, x: number, y: number): [number, number] => [x - rect[0], rect[3] - (y - rect[1])];
/** A slice-frame point as an image-pixel point. */
export const toImagePoint = (rect: SliceRect, x: number, y: number): [number, number] => [x + rect[0], rect[1] + rect[3] - y];

const indexOf = (skin: SliceSkin, name: string): number => skin.bones.findIndex((b) => b.name === name);
const angleOf = (m: Affine2): number => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
const norm = (degrees: number): number => {
  let d = degrees % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return Math.abs(d) < 1e-9 ? 0 : d;
};
const round = (v: number): number => Math.round(v * 1e6) / 1e6;

/** A bone's pose in the slice frame: head, tip and the angle of its axis (degrees). */
export interface BonePose {
  readonly name: string;
  readonly head: readonly [number, number];
  readonly tip: readonly [number, number];
  readonly angle: number;
}

/** Every bone's pose in the slice frame, in declared order. */
export function bonePoses(skin: SliceSkin): BonePose[] {
  const binds = boneBinds(skin.bones, PIXEL_FRAME);
  return skin.bones.map((b, i) => ({ name: b.name, head: affineApply(binds[i]!, 0, 0), tip: affineApply(binds[i]!, b.length, 0), angle: angleOf(binds[i]!) }));
}

/** The names of bone `name`'s children, in declared order. */
export const childrenOf = (skin: SliceSkin, name: string | null): string[] => skin.bones.filter((b) => b.parent === name).map((b) => b.name);

/** The names of every bone below `name` (children, their children…). */
export function descendantsOf(skin: SliceSkin, name: string): string[] {
  const out: string[] = [];
  for (const c of childrenOf(skin, name)) out.push(c, ...descendantsOf(skin, c));
  return out;
}

/** Bones with the local pose that puts bone `name`'s head at `head` with axis angle `angle` (world), under `parent`. */
function localPose(bones: readonly Bone2D[], parent: string | null, head: readonly [number, number], angle: number): Pick<Bone2D, "position" | "rotation"> {
  if (parent === null) return { position: [round(head[0]), round(head[1])], rotation: round(norm(angle)) };
  const binds = boneBinds(bones, PIXEL_FRAME);
  const p = bones.findIndex((b) => b.name === parent);
  const inverse = affineInvert(binds[p]!);
  const [x, y] = affineApply(inverse, head[0], head[1]);
  return { position: [round(x), round(y)], rotation: round(norm(angle - angleOf(binds[p]!))) };
}

const replaceBone = (skin: SliceSkin, index: number, bone: Bone2D): SliceSkin => ({ ...skin, bones: skin.bones.map((b, i) => (i === index ? bone : b)) });

const finite = (...v: number[]): boolean => v.every(Number.isFinite);

/** Why `name` can't name a bone among `taken`, or null. */
export function whyNotBoneName(name: string, taken: readonly string[]): string | null {
  if (name.trim() === "") return "a bone needs a name";
  if (taken.includes(name)) return `there's already a bone named "${name}"`;
  return null;
}

/** A bone name `bone_<n>` no bone of `skin` has. */
export function newBoneName(skin: SliceSkin): string {
  const taken = new Set(skin.bones.map((b) => b.name));
  for (let n = skin.bones.length + 1; ; n++) if (!taken.has(`bone_${n}`)) return `bone_${n}`;
}

/** Where a new bone is: its head and tip in the slice frame, its parent (null: a root) and, optionally, its name. */
export interface NewBone {
  readonly head: readonly [number, number];
  readonly tip: readonly [number, number];
  readonly parent: string | null;
  readonly name?: string;
}

/**
 * The skin with a new bone from `head` to `tip` (its length is their distance, its axis points at the tip) under `parent`.
 * Refused for a parent that isn't a bone, a bad or taken name, a bone shorter than a pixel, or past the bone limit. Existing
 * weights stay (the new bone has none); run auto-weights to give it some.
 */
export function addBone(skin: SliceSkin, bone: NewBone): EditResult<SliceSkin> {
  if (!finite(...bone.head, ...bone.tip)) return refuse("the bone's ends must be numbers");
  if (skin.bones.length >= SPRITE_2D_LIMITS.bones) return refuse(`a skin has at most ${SPRITE_2D_LIMITS.bones} bones`);
  if (bone.parent !== null && indexOf(skin, bone.parent) < 0) return refuse(`there's no bone named "${bone.parent}" to be its parent`);
  const name = bone.name ?? newBoneName(skin);
  const why = whyNotBoneName(name, skin.bones.map((b) => b.name));
  if (why) return refuse(why);
  const dx = bone.tip[0] - bone.head[0], dy = bone.tip[1] - bone.head[1];
  const length = Math.hypot(dx, dy);
  if (length < 1) return refuse("a bone needs a length of at least 1 pixel: drag from its start to its end");
  const pose = localPose(skin.bones, bone.parent, bone.head, (Math.atan2(dy, dx) * 180) / Math.PI);
  return accept({ ...skin, bones: [...skin.bones, { name, parent: bone.parent, ...pose, length: round(length) }] });
}

/** Bone `name` with its head moved to `head` (slice frame). Its axis keeps its direction and its children move with it. */
export function moveBone(skin: SliceSkin, name: string, head: readonly [number, number]): EditResult<SliceSkin> {
  const i = indexOf(skin, name);
  if (i < 0) return refuse(`there's no bone named "${name}"`);
  if (!finite(...head)) return refuse("the position must be numbers");
  const pose = bonePoses(skin)[i]!;
  return accept(replaceBone(skin, i, { ...skin.bones[i]!, ...localPose(skin.bones, skin.bones[i]!.parent, head, pose.angle) }));
}

/** Bone `name` turned and resized so its tip is at `tip` (slice frame), its head staying. Refused when the tip is within a pixel of the head. */
export function setBoneTip(skin: SliceSkin, name: string, tip: readonly [number, number]): EditResult<SliceSkin> {
  const i = indexOf(skin, name);
  if (i < 0) return refuse(`there's no bone named "${name}"`);
  if (!finite(...tip)) return refuse("the position must be numbers");
  const pose = bonePoses(skin)[i]!;
  const dx = tip[0] - pose.head[0], dy = tip[1] - pose.head[1];
  const length = Math.hypot(dx, dy);
  if (length < 1) return refuse("a bone needs a length of at least 1 pixel");
  const local = localPose(skin.bones, skin.bones[i]!.parent, pose.head, (Math.atan2(dy, dx) * 180) / Math.PI);
  return accept(replaceBone(skin, i, { ...skin.bones[i]!, rotation: local.rotation, length: round(length) }));
}

/**
 * Bone `name` under `parent` (null: a root), keeping where it is on the sprite (its head and direction), so its children
 * stay put too. Refused for itself, one of its own descendants (a cycle) or a name that isn't a bone.
 */
export function reparentBone(skin: SliceSkin, name: string, parent: string | null): EditResult<SliceSkin> {
  const i = indexOf(skin, name);
  if (i < 0) return refuse(`there's no bone named "${name}"`);
  if (skin.bones[i]!.parent === parent) return accept(skin);
  if (parent !== null) {
    if (indexOf(skin, parent) < 0) return refuse(`there's no bone named "${parent}" to be its parent`);
    if (parent === name) return refuse("a bone can't be its own parent");
    if (descendantsOf(skin, name).includes(parent)) return refuse(`"${parent}" is below "${name}": that would make a cycle`);
  }
  const pose = bonePoses(skin)[i]!;
  return accept(replaceBone(skin, i, { ...skin.bones[i]!, parent, ...localPose(skin.bones, parent, pose.head, pose.angle) }));
}

/** Bone `name` renamed `to`; its children follow. Refused for a bad or taken name. */
export function renameBone(skin: SliceSkin, name: string, to: string): EditResult<SliceSkin> {
  if (indexOf(skin, name) < 0) return refuse(`there's no bone named "${name}"`);
  if (to === name) return accept(skin);
  const why = whyNotBoneName(to, skin.bones.map((b) => b.name));
  if (why) return refuse(why);
  return accept({ ...skin, bones: skin.bones.map((b) => ({ ...b, name: b.name === name ? to : b.name, parent: b.parent === name ? to : b.parent })) });
}

/**
 * The skin without bone `name`: its children go to its parent, keeping where they are on the sprite; its weights are dropped
 * and the vertices left with none take automatic ones (distance) from the bones that remain.
 */
export function removeBone(skin: SliceSkin, name: string): EditResult<SliceSkin> {
  const i = indexOf(skin, name);
  if (i < 0) return refuse(`there's no bone named "${name}"`);
  const grandparent = skin.bones[i]!.parent;
  const poses = bonePoses(skin);
  // Children first keep their world pose under the grandparent (each is placed against the bones that are staying).
  let bones: Bone2D[] = skin.bones.filter((_, k) => k !== i);
  for (const c of childrenOf(skin, name)) {
    const pose = poses[indexOf(skin, c)]!;
    const k = bones.findIndex((b) => b.name === c);
    bones = bones.map((b, at) => (at === k ? { ...b, parent: grandparent, ...localPose(bones, grandparent, pose.head, pose.angle) } : b));
  }
  let weights: (readonly number[])[] | null = null;
  if (skin.mesh && skin.weights && bones.length > 0) {
    const fallback = autoWeights(skin.mesh.vertices, bones);
    weights = skin.weights.map((w, v) => {
      const kept: [number, number][] = [];
      for (let p = 0; p + 1 < w.length; p += 2) if (w[p] !== i) kept.push([w[p]! > i ? w[p]! - 1 : w[p]!, w[p + 1]!]);
      const pairs = normalisedPairs(kept);
      return pairs.length ? pairs : (fallback[v] ?? []);
    });
  }
  return accept({ bones, mesh: skin.mesh, weights });
}

/** The skin with a mesh of its own, its weights made anew by distance from the bones (none without bones). Refused past the mesh limits. */
export function setMesh(skin: SliceSkin, mesh: SpriteMesh): EditResult<SliceSkin> {
  if (mesh.vertices.length / 2 > SPRITE_2D_LIMITS.vertices) return refuse(`a mesh has at most ${SPRITE_2D_LIMITS.vertices} vertices: raise the spacing`);
  if (mesh.triangles.length / 3 > SPRITE_2D_LIMITS.triangles) return refuse(`a mesh has at most ${SPRITE_2D_LIMITS.triangles} triangles: raise the spacing`);
  return accept({ ...skin, mesh, weights: skin.bones.length > 0 ? autoWeights(mesh.vertices, skin.bones) : null });
}

/** The mesh of a slice: its opaque outline with interior points `spacing` pixels apart (`pixels` is the image's), or its rectangle without pixels. */
export function makeMesh(slice: { readonly rect: SliceRect }, pixels: Pixels | null, spacing?: number): SpriteMesh {
  const [x, y, w, h] = slice.rect;
  return pixels ? outlineMesh(pixels, [x, y, w, h], { spacing }) : rectMesh(w, h, spacing);
}

/** Vertex `index` of the mesh moved to `point` (slice frame). Its weights stay. */
export function moveVertex(skin: SliceSkin, index: number, point: readonly [number, number]): EditResult<SliceSkin> {
  if (!skin.mesh) return refuse("the slice has no mesh: generate one first");
  if (!Number.isInteger(index) || index < 0 || index >= skin.mesh.vertices.length / 2) return refuse(`there's no vertex ${index}`);
  if (!finite(...point)) return refuse("the position must be numbers");
  const vertices = [...skin.mesh.vertices];
  vertices[index * 2] = round(point[0]);
  vertices[index * 2 + 1] = round(point[1]);
  return accept({ ...skin, mesh: { ...skin.mesh, vertices } });
}

/** Per-vertex weights from the bones in the `envelope` mode (see the file comment). */
export function envelopeWeights(vertices: readonly number[], bones: readonly Bone2D[]): number[][] {
  const binds = boneBinds(bones, PIXEL_FRAME);
  const segments = bones.map((b, i): [Point2, Point2] => [affineApply(binds[i]!, 0, 0), affineApply(binds[i]!, b.length, 0)]);
  const reach = bones.map((b) => Math.max(b.length * ENVELOPE_RADIUS_RATIO, ENVELOPE_MIN_RADIUS));
  const out: number[][] = [];
  for (let v = 0; v + 1 < vertices.length; v += 2) {
    if (!bones.length) {
      out.push([]);
      continue;
    }
    const p: Point2 = [vertices[v]!, vertices[v + 1]!];
    const d = segments.map(([a, b]) => segmentDistance(p, a, b));
    const inside = d.map((x, i): [number, number] => [i, x < reach[i]! ? (1 - x / reach[i]!) ** 2 : 0]).filter(([, w]) => w > 0);
    if (inside.length) out.push(normalisedPairs(inside));
    else out.push([d.indexOf(Math.min(...d)), 1]);
  }
  return out;
}

/** The skin with automatic weights in `mode`. Refused without bones or a mesh (the reason says which). */
export function autoWeight(skin: SliceSkin, mode: AutoWeightMode = "distance"): EditResult<SliceSkin> {
  if (skin.bones.length === 0) return refuse("add a bone first");
  if (!skin.mesh) return refuse("the slice has no mesh: generate one first");
  return accept({ ...skin, weights: mode === "envelope" ? envelopeWeights(skin.mesh.vertices, skin.bones) : autoWeights(skin.mesh.vertices, skin.bones) });
}

/** How a brush stroke changes the weights of the vertices it touches. */
export type BrushMode = "add" | "subtract" | "smooth";

/** One brush stroke (or one step of a drag) in the slice frame. */
export interface BrushStroke {
  readonly center: readonly [number, number];
  /** Pixels; vertices farther than this are untouched. */
  readonly radius: number;
  /** 0 (exclusive) to 1: how much of the full effect a vertex under the centre takes. */
  readonly strength: number;
  /** The bone painted toward or away from (`add`, `subtract`); `smooth` ignores it. */
  readonly bone: string;
  readonly mode: BrushMode;
}

type Weights = Map<number, number>;
const toMap = (w: readonly number[]): Weights => {
  const m: Weights = new Map();
  for (let p = 0; p + 1 < w.length; p += 2) m.set(w[p]!, (m.get(w[p]!) ?? 0) + w[p + 1]!);
  return m;
};

/** `current` moved toward `target` bone's full weight by `amount` (0..1), the other bones scaled to fill the rest. */
function paintToward(current: Weights, bone: number, amount: number): Weights {
  const own = current.get(bone) ?? 0;
  const target = Math.min(1, own + amount);
  const others = [...current].filter(([b]) => b !== bone);
  const sum = others.reduce((s, [, w]) => s + w, 0);
  const out: Weights = new Map([[bone, target]]);
  for (const [b, w] of others) out.set(b, sum > 0 ? (w / sum) * (1 - target) : 0);
  return out;
}

/** `current` with `amount` taken off `bone`, the freed weight shared by the others in proportion; unchanged when `bone` is the only influence. */
function paintAway(current: Weights, bone: number, amount: number): Weights {
  const own = current.get(bone) ?? 0;
  const others = [...current].filter(([b, w]) => b !== bone && w > 0);
  if (own === 0 || others.length === 0) return current;
  const target = Math.max(0, own - amount);
  const sum = others.reduce((s, [, w]) => s + w, 0);
  const out: Weights = new Map([[bone, target]]);
  for (const [b, w] of others) out.set(b, (w / sum) * (1 - target));
  return out;
}

const pairsOf = (m: Weights): [number, number][] => [...m].filter(([, w]) => w > 1e-9);

/** Which vertices share a triangle edge with each vertex. */
function neighbours(mesh: SpriteMesh): Set<number>[] {
  const out = Array.from({ length: mesh.vertices.length / 2 }, () => new Set<number>());
  for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
    const [a, b, c] = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
    out[a]!.add(b).add(c);
    out[b]!.add(a).add(c);
    out[c]!.add(a).add(b);
  }
  return out;
}

/** The weights a vertex gets, as they are now: the skin's, or computed by distance when it has none (what the runtime draws). */
export function weightsOf(skin: SliceSkin): number[][] {
  if (skin.weights) return skin.weights.map((w) => [...w]);
  return skin.mesh ? autoWeights(skin.mesh.vertices, skin.bones) : [];
}

/** Why `stroke` can't be applied to `skin`, or null. */
export function whyNotPaint(skin: SliceSkin, stroke: BrushStroke): string | null {
  if (!skin.mesh) return "the slice has no mesh: generate one first";
  if (skin.bones.length === 0) return "add a bone first";
  if (stroke.mode !== "smooth" && indexOf(skin, stroke.bone) < 0) return `there's no bone named "${stroke.bone}" to paint`;
  if (!finite(stroke.radius, stroke.strength, ...stroke.center) || stroke.radius <= 0) return "the brush radius must be above 0";
  if (stroke.strength <= 0 || stroke.strength > 1) return "the brush strength must be above 0 and at most 1";
  return null;
}

/**
 * The skin after a brush stroke (see the file comment). Weights the skin doesn't have yet are made by distance first. Refused
 * for a stroke that breaks `whyNotPaint`, or one that touches no vertex ("the brush touches no vertices").
 */
export function paintWeights(skin: SliceSkin, stroke: BrushStroke): EditResult<SliceSkin> {
  const why = whyNotPaint(skin, stroke);
  if (why) return refuse(why);
  const mesh = skin.mesh!;
  const weights = weightsOf(skin);
  const bone = indexOf(skin, stroke.bone);
  const near = stroke.mode === "smooth" ? neighbours(mesh) : null;
  const next = weights.map((w) => w);
  let touched = 0;
  for (let v = 0; v < weights.length; v++) {
    const d = Math.hypot(mesh.vertices[v * 2]! - stroke.center[0], mesh.vertices[v * 2 + 1]! - stroke.center[1]);
    if (d > stroke.radius) continue;
    touched++;
    const amount = stroke.strength * (1 - d / stroke.radius);
    const current = toMap(weights[v]!);
    let painted: Weights;
    if (stroke.mode === "add") painted = paintToward(current, bone, amount);
    else if (stroke.mode === "subtract") painted = paintAway(current, bone, amount);
    else {
      const around = [...near![v]!];
      const average: Weights = new Map();
      for (const n of around) for (const [b, w] of toMap(weights[n]!)) average.set(b, (average.get(b) ?? 0) + w / around.length);
      painted = new Map();
      for (const b of new Set([...current.keys(), ...average.keys()])) painted.set(b, (1 - amount) * (current.get(b) ?? 0) + amount * (average.get(b) ?? 0));
      if (around.length === 0) painted = current;
    }
    const pairs = normalisedPairs(pairsOf(painted));
    next[v] = pairs.length ? pairs : weights[v]!;
  }
  if (touched === 0) return refuse("the brush touches no vertices");
  return accept({ ...skin, weights: next });
}

/** The first problem with a skin's shape, or null: weights as many as vertices, each at most four bones of the skin summing to 1. */
export function skinProblem(skin: SliceSkin): string | null {
  if (!skin.weights) return null;
  if (!skin.mesh) return "weights need a mesh";
  if (skin.weights.length !== skin.mesh.vertices.length / 2) return "there are not as many weights as vertices";
  for (const w of skin.weights) {
    if (w.length === 0 && skin.bones.length > 0) return "a vertex has no weights";
    if (w.length > SPRITE_2D_LIMITS.influences * 2) return `a vertex has more than ${SPRITE_2D_LIMITS.influences} bones`;
    let sum = 0;
    for (let p = 0; p + 1 < w.length; p += 2) {
      if (w[p]! >= skin.bones.length) return "a weight names a bone the skin lacks";
      sum += w[p + 1]!;
    }
    if (w.length > 0 && Math.abs(sum - 1) > 1e-6) return "a vertex's weights don't sum to 1";
  }
  return null;
}
