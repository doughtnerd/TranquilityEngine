// Skinned sprites (ADR 0370 "2D bones", 0371; T21): a SpriteRenderer whose slice has a `skin`, on a node with a
// `Skeleton2D` or below one, is drawn deformed: its mesh through the `mycoSkin` kernel (`render/skinning/skinRuns.ts`)
// and the result on the quad-batch path (`render/quadBatches.ts` `setTriangles`), renderer-neutral. The sprites feature
// skips such sprites (`render/spriteClaims.ts`, `claimsSkinnedSprite`).
//
// - **Geometry:** the skin's `mesh` (else the slice's rectangle as a grid, `rectMesh`) in the slice's units (pixels over
//   pixels per unit, the pivot at the origin), z = 0; UVs from the slice's rect in the texture. Weights are the skin's,
//   else automatic by bone distance (`autoWeights`).
// - **Shared skeleton:** the Skeleton2D names the slice whose bones are the skeleton. A drawn slice's bones bind to the
//   skeleton's by name: palette entry `j` is `S[k] × B[k] × Bslice[j]⁻¹`, where `S` are the skeleton's skinning matrices
//   this frame (identity before the first pose), `B[k]` its bind pose and `Bslice[j]` the slice's own bind of that bone
//   (so a slice sits where its bones are on the skeleton, a cut-out character). A bone the skeleton lacks stays at the
//   slice's own frame, with one warning.
// - **Placement:** like 3D skinned meshes, the draw sits in the skeleton's model space, placed by the Skeleton2D node's
//   world matrix; the sprite node's own transform, `size`, `pixelsPerUnit`, `flipX` and `flipY` don't apply.
// - **Executor:** the kernel's JavaScript executor (`JsSkinRuns`): 2D meshes are small and the quad batch takes vertex
//   arrays, so the CPU output goes straight into the batch. A pose that didn't change skins nothing.
import { affineFromRows, affineInvert, affineMultiply, affineToRows, AFFINE_IDENTITY, type Affine2 } from "../../../../../engine/animation/sprites/affine2d";
import { autoWeights } from "../../../../../engine/animation/sprites/autoWeights";
import { boneBinds, skeleton2D, toUnits } from "../../../../../engine/animation/sprites/skeleton2d";
import { rectMesh } from "../../../../../engine/animation/sprites/spriteMesh";
import type { World } from "../../../../../engine/core/World";
import { SpriteRenderer } from "../../../../../engine/render/components";
import type { QuadBatch, QuadBatchHost } from "../../../../../engine/render/quadBatches";
import type { SkinGeometry } from "../../../../../engine/render/skinning/skinData";
import { PALETTE_FLOATS } from "../../../../../engine/render/skinning/skinKernel";
import { JsSkinRuns, type SkinPalette, type SkinRun, type SkinRuns } from "../../../../../engine/render/skinning/skinRuns";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import { Skeleton2D } from "../../components/Skeleton2D";
import { skinningMatrices, skinningVersion } from "../../skeletonInstances";
import { sliceSkin, type SliceSkinSource } from "./skins";

/** @internal Where a skeleton node's skinning matrices come from (row-major 3×4 per bone, D10) and a version that changes with them. */
export interface Skin2DMatrixSource {
  matrices(world: World, skeleton: GameObject): Float32Array | null;
  version(world: World, skeleton: GameObject): number;
}

/** @internal The skeleton instances' matrices (`skeletonInstances.ts`). */
export const SKELETON_2D_MATRICES: Skin2DMatrixSource = { matrices: skinningMatrices, version: skinningVersion };

/** @internal The Skeleton2D deforming `r` (on its node or the nearest above it) and its slice's skin, or null when `r` draws as a plain sprite. */
export function skinnedSpriteOf(r: SpriteRenderer): { skeleton: Skeleton2D; skin: SliceSkinSource } | null {
  if (!r.sprite) return null;
  const skeleton = r.node.getComponentInParent(Skeleton2D);
  if (!skeleton) return null;
  const skin = sliceSkin(r.sprite, r.node.world.settings.render.pixelsPerUnit);
  return skin ? { skeleton, skin } : null;
}

/** @internal The sprite claim (`render/spriteClaims.ts`): a skinned slice under a Skeleton2D. */
export const claimsSkinnedSprite = (r: SpriteRenderer): boolean => skinnedSpriteOf(r) !== null;

interface Entry {
  /** What the geometry was built from: the sprite, the skeleton's slice and node, both skins and the texture size. */
  key: string;
  batch: QuadBatch;
  run: SkinRun<Float32Array> | null;
  palette: SkinPalette | null;
  skeletonNode: GameObject | null;
  texture: string;
  /** Per slice bone: its skeleton bone index (-1: none) and `B[k] × Bslice[j]⁻¹`. */
  rebind: { bone: number; m: Affine2 }[];
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** The matrices' version last skinned with (null: never). */
  skinned: number | null;
  /** The texture's size was asked for and hasn't loaded: rebuild once it has. */
  waiting: boolean;
  visible: boolean;
  /**
   * ADR 0415: the slice outline tied to the mesh, per point its nearest rest vertex and its offset from it (units), so the
   * outline follows the bones for 2D shadow casters; null without an outline.
   */
  outline: { vertex: number; dx: number; dy: number }[][] | null;
}

const scratchPalette = (bones: number) => new Float32Array(Math.max(1, bones) * PALETTE_FLOATS);

/** @internal Draws a World's skinned sprites on quad batches. */
export class SkinnedSprites {
  private readonly entries = new Map<SpriteRenderer, Entry>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly host: QuadBatchHost,
    private readonly runs: SkinRuns<Float32Array> = new JsSkinRuns(),
    private readonly matrices: Skin2DMatrixSource = SKELETON_2D_MATRICES,
  ) {}

  /** Once a frame, before the renderer draws. */
  sync(world: World): void {
    const seen = new Set<SpriteRenderer>();
    for (const r of world._componentsOfType(SpriteRenderer)) {
      const found = skinnedSpriteOf(r);
      if (!found) continue;
      seen.add(r);
      this.syncOne(world, r, found.skeleton, found.skin);
    }
    for (const r of [...this.entries.keys()]) if (!seen.has(r) && r.node.world === world) this.release(r);
  }

  /** A SpriteRenderer went (or stopped being skinned): its batch goes. */
  release(r: SpriteRenderer): void {
    const e = this.entries.get(r);
    if (!e) return;
    this.disposeGeometry(e);
    e.batch.dispose();
    this.entries.delete(r);
  }

  /**
   * ADR 0415: `r`'s slice outline as its bones deform it now, in `r`'s node's local XY (for a ShadowCaster2D on that node),
   * or null when it isn't a skinned sprite drawn here or its slice has no outline.
   */
  deformedOutline(r: SpriteRenderer): [number, number][][] | null {
    const e = this.entries.get(r);
    const skel = e?.skeletonNode;
    if (!e?.outline || !e.run || !skel || e.skinned === null) return null;
    const world = r.node.world;
    const sm = world.worldMatrix(skel.entity), so = skel.entity * 16;
    const nm = world.worldMatrix(r.node.entity), no = r.node.entity * 16;
    // Node-local from world: the inverse of the node's 2D affine.
    const [a, b, c, d, tx, ty] = [nm[no]!, nm[no + 1]!, nm[no + 4]!, nm[no + 5]!, nm[no + 12]!, nm[no + 13]!];
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return null;
    return e.outline.map((poly) =>
      poly.map(({ vertex, dx, dy }): [number, number] => {
        const mx = e.positions[vertex * 3]! + dx, my = e.positions[vertex * 3 + 1]! + dy;
        const wx = sm[so]! * mx + sm[so + 4]! * my + sm[so + 12]!, wy = sm[so + 1]! * mx + sm[so + 5]! * my + sm[so + 13]!;
        const px = wx - tx, py = wy - ty;
        return [(d * px - c * py) / det, (-b * px + a * py) / det];
      }),
    );
  }

  /** What it drew: each visible skinned sprite with its batch (which reports its place, ADR 0445). */
  *drawn(): Iterable<{ renderer: SpriteRenderer; batches: readonly QuadBatch[] }> {
    for (const [renderer, e] of this.entries) if (e.visible && e.run) yield { renderer, batches: [e.batch] };
  }

  dispose(): void {
    for (const r of [...this.entries.keys()]) this.release(r);
  }

  // --- steps -----------------------------------------------------------------------------------------------

  private syncOne(world: World, r: SpriteRenderer, skeleton: Skeleton2D, skin: SliceSkinSource): void {
    let e = this.entries.get(r);
    if (!e) {
      e = { key: "", batch: this.host.createBatch(`skinned-sprite:${r.node.name}`), run: null, palette: null, skeletonNode: null, texture: "", rebind: [], positions: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0), skinned: null, waiting: false, visible: false, outline: null };
      this.entries.set(r, e);
    }
    const skelSkin = sliceSkin(skeleton.bones, world.settings.render.pixelsPerUnit);
    const size = this.host.textureSize(skin.imagePath, () => {
      const entry = this.entries.get(r);
      if (entry) entry.key = ""; // rebuild with the size next sync
    });
    const key = `${r.sprite}|${skeleton.bones}|${skeleton.node.entity}|${JSON.stringify(skin.slice)}|${skin.frame.pixelsPerUnit}|${skelSkin ? JSON.stringify(skelSkin.skin.bones) : ""}|${size?.join("x") ?? ""}`;
    if (key !== e.key) {
      e.key = key;
      this.build(e, r, skeleton, skin, skelSkin, size);
    }
    // In a y-sorted layer (ADR 0440) its sort point is the sprite node's world position, as a plain sprite's.
    const y = world.worldMatrix(r.node.entity)[r.node.entity * 16 + 13]!;
    e.batch.setOrder(r.sortingLayer, r.orderInLayer, { y });
    e.batch.setTint(r.color.toHex(), r.color.a);
    e.batch.setMaterial(r.material); // ADR 0399: a normal map then follows the bones (the host's tangents)
    e.visible = r.isActiveAndEnabled && !!e.run;
    e.batch.setVisible(e.visible);
    if (!e.run || !e.visible) return;
    const node = e.skeletonNode!;
    const version = this.matrices.version(world, node);
    if (e.skinned !== version) {
      this.skin(e, this.matrices.matrices(world, node));
      e.skinned = version;
    }
    e.batch.setMatrix(world.worldMatrix(node.entity), node.entity * 16);
  }

  /** The slice's geometry, run and rebind matrices (none until the texture's size is known). */
  private build(e: Entry, r: SpriteRenderer, skeleton: Skeleton2D, skin: SliceSkinSource, skelSkin: SliceSkinSource | null, size: readonly [number, number] | null): void {
    this.disposeGeometry(e);
    e.skeletonNode = skeleton.node;
    e.texture = skin.imagePath;
    if (!size) return;
    const [, , w, h] = skin.slice.rect;
    const mesh = skin.skin.mesh ?? rectMesh(w, h);
    const weights = skin.skin.weights ?? autoWeights(mesh.vertices, skin.skin.bones);
    const n = mesh.vertices.length / 2;
    const positions = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    const joints = new Uint16Array(n * 4);
    const ws = new Float32Array(n * 4);
    const [rx, ry] = skin.slice.rect;
    for (let v = 0; v < n; v++) {
      const px = mesh.vertices[v * 2]!, py = mesh.vertices[v * 2 + 1]!;
      const [x, y] = toUnits(skin.frame, px, py);
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      uvs[v * 2] = (rx + px) / size[0];
      uvs[v * 2 + 1] = 1 - (ry + h - py) / size[1];
      const pairs = weights[v] ?? [];
      for (let k = 0; k < 4 && k * 2 < pairs.length; k++) {
        joints[v * 4 + k] = pairs[k * 2]!;
        ws[v * 4 + k] = pairs[k * 2 + 1]!;
      }
    }
    // Bind each of the slice's bones to the skeleton's bone of that name.
    const sliceBinds = boneBinds(skin.skin.bones, skin.frame);
    const skelModel = skelSkin ? skeleton2D(skelSkin.skin.bones, skelSkin.frame) : null;
    const skelIndex = new Map(skelModel?.skeleton.bones.map((b, i) => [b.name, i]) ?? []);
    e.rebind = skin.skin.bones.map((b, j) => {
      const k = skelIndex.get(b.name);
      if (k === undefined) {
        this.warnOnce(`${r.node.name}|${b.name}`, `${r.node.name}: the bone "${b.name}" of "${r.sprite}" isn't in its Skeleton2D's skeleton ("${skeleton.bones}"); its vertices stay put.`);
        return { bone: -1, m: AFFINE_IDENTITY };
      }
      return { bone: k, m: affineMultiply(skelModel!.binds[k]!, affineInvert(sliceBinds[j]!)) };
    });
    // The outline follows its nearest vertex (ADR 0415): shadows from a deforming silhouette.
    e.outline = skin.slice.outline?.length
      ? skin.slice.outline.map((poly) =>
          poly.map(([px, py]) => {
            const [x, y] = toUnits(skin.frame, px, py);
            let best = 0, bestD = Infinity;
            for (let v = 0; v < n; v++) {
              const d = (positions[v * 3]! - x) ** 2 + (positions[v * 3 + 1]! - y) ** 2;
              if (d < bestD) [best, bestD] = [v, d];
            }
            return { vertex: best, dx: x - positions[best * 3]!, dy: y - positions[best * 3 + 1]! };
          }),
        )
      : null;
    const geometry: SkinGeometry = { positions, normals: null, tangents: null, skin: { influences: 4, joints, weights: ws }, morphTargets: [] };
    e.positions = new Float32Array(n * 3);
    e.uvs = uvs;
    e.indices = Uint32Array.from(mesh.triangles);
    e.run = this.runs.run(geometry);
    e.palette = this.runs.palette(`skinned sprite ${r.node.name}`);
    e.run.setPalette(e.palette);
    e.skinned = null;
  }

  /** Skins the slice with `matrices` (the skeleton's this frame, or null: the bind pose) and hands the batch the result. */
  private skin(e: Entry, matrices: Float32Array | null): void {
    const palette = scratchPalette(e.rebind.length);
    e.rebind.forEach(({ bone, m }, j) => {
      const s = matrices && bone >= 0 && (bone + 1) * PALETTE_FLOATS <= matrices.length ? affineFromRows(matrices, bone * PALETTE_FLOATS) : AFFINE_IDENTITY;
      affineToRows(affineMultiply(s, m), palette, j * PALETTE_FLOATS);
    });
    e.palette!.upload(palette);
    e.run!.dispatch();
    const out = e.run!.output;
    for (let v = 0; v < e.positions.length / 3; v++) {
      e.positions[v * 3] = out[v * 12]!;
      e.positions[v * 3 + 1] = out[v * 12 + 1]!;
      e.positions[v * 3 + 2] = 0;
    }
    e.batch.setTriangles(e.texture, e.positions, e.uvs, e.indices);
  }

  private disposeGeometry(e: Entry): void {
    e.run?.dispose();
    e.palette?.dispose();
    e.run = null;
    e.palette = null;
    e.skinned = null;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}
