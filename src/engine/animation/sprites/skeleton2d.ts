/**
 * The 2D skeleton model (ADR 0371 "2D bones", 0372 `Skeleton2D`): a slice's `skin.bones` (pixels in the slice's frame,
 * `sidecar.ts`) as bind transforms in the slice's **units** (pixels over pixels per unit, the slice's pivot at the
 * origin: the space a SpriteRenderer draws the slice in), and as an imported skeleton (`import/skeleton.ts`) the core
 * loads as `myco.skel@1` (`import/skeletonBinary.ts`): bones parents first, each rest pose a move in x and y and a turn
 * about z, z = 0, and its inverse bind matrix. Bone tracks then animate 2D bones as they do 3D ones.
 *
 * Pure. Internal: not public API.
 */
import type { SpriteSlice } from "../../scene/importSettings";
import { orderParentsFirst, type ImportedBone, type ImportedSkeleton } from "../import/skeleton";
import { encodeSkeleton } from "../import/skeletonBinary";
import { affineFromPose, affineInvert, affineMultiply, affineToRows, AFFINE_IDENTITY, type Affine2 } from "./affine2d";
import type { Bone2D } from "./sidecar";

/** @internal Where a slice's pixels sit in its units: the pivot in slice pixels and the pixels per unit. */
export interface SliceFrame {
  readonly pivot: readonly [number, number];
  readonly pixelsPerUnit: number;
}

/** @internal Slice pixels as they are (bone maths in pixels: auto weights). */
export const PIXEL_FRAME: SliceFrame = { pivot: [0, 0], pixelsPerUnit: 1 };

/** @internal A slice's frame: its pivot, and pixels per unit (`pixelsPerUnit` when > 0, else `fallback`). */
export function sliceFrame(slice: Pick<SpriteSlice, "rect" | "pivot">, pixelsPerUnit: number, fallback: number): SliceFrame {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : fallback > 0 ? fallback : 1;
  return { pivot: [slice.pivot[0] * slice.rect[2], slice.pivot[1] * slice.rect[3]], pixelsPerUnit: ppu };
}

/** @internal A point in slice pixels in the frame's units. */
export function toUnits(frame: SliceFrame, x: number, y: number): [number, number] {
  return [(x - frame.pivot[0]) / frame.pixelsPerUnit, (y - frame.pivot[1]) / frame.pixelsPerUnit];
}

/** @internal Each bone's local transform (to its parent, or to the slice's units for a root), in declared order. */
export function boneLocals(bones: readonly Bone2D[], frame: SliceFrame): Affine2[] {
  return bones.map((b) => {
    const [x, y] = b.parent === null ? toUnits(frame, b.position[0], b.position[1]) : [b.position[0] / frame.pixelsPerUnit, b.position[1] / frame.pixelsPerUnit];
    return affineFromPose(x, y, b.rotation);
  });
}

/** @internal Each bone's bind transform (bone space → slice units), in declared order. Parents are names (`sidecar.ts` breaks cycles). */
export function boneBinds(bones: readonly Bone2D[], frame: SliceFrame): Affine2[] {
  const locals = boneLocals(bones, frame);
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const binds: (Affine2 | undefined)[] = new Array(bones.length);
  const bind = (i: number, depth: number): Affine2 => {
    const known = binds[i];
    if (known) return known;
    const p = bones[i]!.parent === null ? undefined : index.get(bones[i]!.parent!);
    const parent = p === undefined || depth > bones.length ? AFFINE_IDENTITY : bind(p, depth + 1);
    return (binds[i] = affineMultiply(parent, locals[i]!));
  };
  return bones.map((_, i) => bind(i, 0));
}

/** @internal A 2D skeleton: the imported skeleton (parents first) and, per skeleton bone, its index in the declared list. */
export interface Skeleton2DModel {
  readonly skeleton: ImportedSkeleton;
  /** `order[skeletonIndex] = declaredIndex`. */
  readonly order: readonly number[];
  /** Bind transforms (bone → slice units) in skeleton order. */
  readonly binds: readonly Affine2[];
}

/** @internal `bones` as a skeleton in the frame's units. */
export function skeleton2D(bones: readonly Bone2D[], frame: SliceFrame): Skeleton2DModel {
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const parents = bones.map((b) => (b.parent === null ? -1 : (index.get(b.parent) ?? -1)));
  const { order, remap } = orderParentsFirst(parents);
  const locals = boneLocals(bones, frame);
  const declaredBinds = boneBinds(bones, frame);
  const inverseBinds = new Float32Array(order.length * 12);
  const out = order.map((old, i): ImportedBone => {
    const l = locals[old]!;
    const half = Math.atan2(l[1], l[0]) / 2;
    affineToRows(affineInvert(declaredBinds[old]!), inverseBinds, i * 12);
    const p = parents[old]!;
    return { name: bones[old]!.name, parent: p >= 0 && remap[p]! < i ? remap[p]! : -1, rest: { position: [l[4], l[5], 0], rotation: [0, 0, Math.sin(half), Math.cos(half)], scale: [1, 1, 1] } };
  });
  return { skeleton: { bones: out, inverseBinds, roles: out.map(() => null), profile: null }, order, binds: order.map((old) => declaredBinds[old]!) };
}

/** @internal `bones` as `myco.skel@1` bytes, in the frame's units. */
export function skeleton2DBytes(bones: readonly Bone2D[], frame: SliceFrame, name = ""): Uint8Array {
  return encodeSkeleton(skeleton2D(bones, frame).skeleton, name);
}
