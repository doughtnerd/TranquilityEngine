// Skinned mesh sync (ADR 0370 "Rendering"; T16): mirrors the World's SkinnedMeshRenderers into a renderer's skinned draws
// (`SkinnedDraws`, renderer-neutral; Babylon's is `engine/render/babylon/skinnedMeshes.ts`), once a frame before it renders.
//
// - Each renderer gets one draw per model mesh its `mesh` names, made once the model has loaded and remade when it changes.
// - Each skeleton (the `skeleton` node, else the nearest ancestor with a `Skeleton`) gets one palette, shared by its draws:
//   its skinning matrices are uploaded once a frame, only when `version` changed since the last upload (or a draw needs
//   more joints). No pose yet (or no skeleton): identities, the bind pose.
// - A draw dispatches the kernel only when its palette was uploaded since it last skinned, its morph weights changed, or it
//   is new: an idle character costs nothing on the GPU. Inactive renderers are hidden and skip both (catching up when shown).
// - Bounds follow `boundsMode`: `bones` unites the used joints' transformed (morphed) rest boxes when the draw dispatches
//   (`skinBounds.ts`), `fixed` takes `boundsCenter`/`boundsSize` around the renderer's node.
// - Draws sit in the skeleton's model space, placed by the skeleton node's world matrix (glTF: a skinned mesh's own node
//   transform is ignored; joints place it).
import { Mat4 } from "../../../../../engine/core/math";
import type { World } from "../../../../../engine/core/World";
import { meshesIfLoaded, type ModelMesh } from "../../../../../engine/scene/models";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import { morphedBox, morphReach, restBox, skinnedBox, transformBox, type Box6 } from "../../../../../engine/render/skinning/skinBounds";
import { jointsNeeded, skinnedSourceOf, usedJoints, type SkinnedMeshSource } from "../../../../../engine/render/skinning/skinData";
import { paletteFor } from "../../../../../engine/render/skinning/skinKernel";
import type { SkinPalette } from "../../../../../engine/render/skinning/skinRuns";
import type { SkinnedDraw, SkinnedDraws } from "../../../../../engine/render/skinning/skinnedDraws";
import { Skeleton } from "../../components/Skeleton";
import { SkinnedMeshRenderer } from "../../components/SkinnedMeshRenderer";
import { skinningMatrices, skinningVersion } from "../../skeletonInstances";

/** @internal Where a skeleton's skinning matrices come from (row-major 3×4, 12 floats a bone, model × inverse bind). */
export interface SkinningMatrixSource {
  matrices(world: World, skeleton: GameObject): Float32Array | null;
  /** Changes whenever `matrices` does. */
  version(world: World, skeleton: GameObject): number;
}

/** @internal The model meshes a renderer draws skinned, or null while its model loads. */
export type SkinnedMeshResolver = (renderer: SkinnedMeshRenderer) => readonly SkinnedMeshSource[] | null;

/** @internal The skeleton instances' matrices (T17's `skeletonInstances.ts`). */
export const SKELETON_MATRICES: SkinningMatrixSource = { matrices: skinningMatrices, version: skinningVersion };

const sources = new WeakMap<ModelMesh, SkinnedMeshSource>();

/** @internal A renderer's model meshes (`meshesIfLoaded`) with the skin fields their importer filled. */
export const modelSkinnedMeshes: SkinnedMeshResolver = (r) => {
  const meshes = meshesIfLoaded(r.mesh);
  if (!meshes) return null;
  return meshes.map((m) => {
    let s = sources.get(m);
    if (!s) sources.set(m, (s = skinnedSourceOf(m)));
    return s;
  });
};

interface PaletteUse {
  readonly palette: SkinPalette;
  readonly key: object;
  readonly skeleton: GameObject | null;
  users: number;
  /** The version last uploaded (null: never). */
  version: number | null;
  /** Joints the last upload covered. */
  joints: number;
  /** The palette last uploaded (bounds read it). */
  data: Float32Array | null;
  uploadedAt: number;
  /** Joints this frame's visible draws read; reset each frame. */
  want: number;
  seenAt: number;
}

/**
 * @internal What a skinned draw adds when it draws its model mesh's LOD levels (ADR 0459 §6): the levels share its
 * skinned vertex buffer, so one dispatch skins them all. A backend without it draws level 0 only.
 */
export interface SkinnedLevels<M> {
  /** Levels the model mesh has (1 without LODs). */
  readonly levelCount: number;
  /** The mesh drawing `level` (0 is `mesh`); made on first ask. */
  levelMesh(level: number): M;
  /** Per-view drawing: exactly the levels whose bit is set are enabled (while the draw is on); null: level 0 only. */
  showLevels(mask: number | null): void;
}

/** @internal One model mesh of a renderer, as the per-view choices see it. */
export interface LevelDraw<M> {
  /** Levels it has. */
  readonly levels: number;
  /** The mesh that draws `level` (clamped to its last level, ADR 0459 §2). */
  mesh(level: number): M;
  /** Enable exactly the levels in `mask` (bit i = level i), or only level 0 with null. */
  show(mask: number | null): void;
}

interface DrawState<M> {
  readonly draw: SkinnedDraw<M> & Partial<SkinnedLevels<M>>;
  readonly level: LevelDraw<M>;
  /** Every mesh it has drawn as (level 0, and the levels asked for since). */
  readonly all: M[];
  readonly joints: readonly number[];
  readonly needed: number;
  readonly rest: Box6;
  readonly reach: Float32Array;
  /** Dispatch at the next visible sync whatever changed (new, or its palette was swapped). */
  dirty: boolean;
  /** The palette upload (its frame) it last skinned with: a draw hidden through an upload catches up when shown. */
  skinnedWith: number;
}

interface Entry<M> {
  sources: readonly SkinnedMeshSource[] | null;
  draws: DrawState<M>[];
  palette: PaletteUse | null;
  weights: number[];
  placed: Float32Array | null;
  visible: boolean;
}

const sameSources = (a: readonly SkinnedMeshSource[] | null, b: readonly SkinnedMeshSource[] | null): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((s, i) => s.model === b[i].model));

const sameWeights = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((w, i) => w === b[i]);

const scratch = new Float32Array(48);

/** @internal Mirrors SkinnedMeshRenderers into `draws` (a renderer's skinned-mesh backend). */
export class SkinningSync<M> {
  private readonly entries = new Map<SkinnedMeshRenderer, Entry<M>>();
  private readonly palettes = new Map<object, PaletteUse>();
  private frame = 0;
  /** The meshes of every draw (level 0, and levels made since): what a per-view drawing owns. */
  private readonly owned = new Set<M>();

  constructor(
    private readonly draws: SkinnedDraws<M>,
    private readonly matrices: SkinningMatrixSource = SKELETON_MATRICES,
    private readonly resolve: SkinnedMeshResolver = modelSkinnedMeshes,
  ) {}

  /** Once a frame, before the renderer draws: every SkinnedMeshRenderer of `world`. */
  sync(world: World): void {
    const frame = ++this.frame;
    for (const p of this.palettes.values()) p.want = 0;
    const renderers = world._componentsOfType(SkinnedMeshRenderer);
    for (const r of renderers) this.prepare(r, frame);
    for (const p of this.palettes.values()) if (p.seenAt === frame) this.upload(world, p, frame);
    let dispatched = false;
    for (const r of renderers) {
      const e = this.entries.get(r);
      if (e?.visible && this.update(world, r, e)) dispatched = true;
    }
    if (dispatched) this.draws.endDispatches();
  }

  /** A SkinnedMeshRenderer went: its draws and its share of the palette go. */
  release(r: SkinnedMeshRenderer): void {
    const e = this.entries.get(r);
    if (!e) return;
    this.disposeDraws(e);
    this.releasePalette(e);
    this.entries.delete(r);
  }

  /** Each renderer with its meshes, and whether it shows now. */
  *renderers(): Iterable<{ renderer: SkinnedMeshRenderer; meshes: M[]; visible: boolean }> {
    for (const [renderer, e] of this.entries) yield { renderer, meshes: e.draws.map((d) => d.draw.mesh), visible: e.visible && e.draws.length > 0 };
  }

  /** A renderer's model meshes with their levels (empty until its model has loaded). */
  levelDraws(r: SkinnedMeshRenderer): readonly LevelDraw<M>[] {
    return this.entries.get(r)?.draws.map((d) => d.level) ?? [];
  }

  /** The renderer drawing `mesh` at any level, or null. */
  rendererOf(mesh: M): SkinnedMeshRenderer | null {
    for (const [r, e] of this.entries) if (e.draws.some((d) => d.all.includes(mesh))) return r;
    return null;
  }

  /** Whether `mesh` is one of the meshes any renderer draws (level 0 or a level made since). */
  owns(mesh: M): boolean {
    return this.owned.has(mesh);
  }

  /** Whether every renderer's model has loaded. */
  loaded(): boolean {
    for (const [r, e] of this.entries) if (r.mesh && e.sources === null) return false;
    return true;
  }

  dispose(): void {
    for (const r of [...this.entries.keys()]) this.release(r);
    for (const p of this.palettes.values()) p.palette.dispose();
    this.palettes.clear();
    this.draws.dispose();
  }

  // --- steps -----------------------------------------------------------------------------------------------

  /** Draws, palette, visibility, shadows and materials of one renderer. */
  private prepare(r: SkinnedMeshRenderer, frame: number): void {
    let e = this.entries.get(r);
    if (!e) this.entries.set(r, (e = { sources: null, draws: [], palette: null, weights: [], placed: null, visible: false }));
    if (e.draws.some((d) => d.draw.lost)) {
      this.disposeDraws(e);
      e.sources = null;
    }
    const sources = this.resolve(r);
    if (!sameSources(sources, e.sources)) {
      this.disposeDraws(e);
      e.sources = sources;
      e.weights = [];
      e.draws = (sources ?? []).map((s) => this.createDraw(s, `${r.node.name}:${s.model.name}`));
    }
    const skeleton = this.skeletonOf(r);
    const key = skeleton ?? r;
    if (!e.palette || e.palette.key !== key) {
      this.releasePalette(e);
      e.palette = this.acquirePalette(key, skeleton);
    }
    const p = e.palette;
    e.visible = r.isActiveAndEnabled;
    for (const d of e.draws) {
      d.draw.setPalette(p.palette);
      d.draw.setEnabled(e.visible);
      d.draw.setShadows(r.castShadows, r.receiveShadows);
      d.draw.setMaterials({ mesh: r.mesh, material: r.material, materials: r.materials });
    }
    if (!e.visible || !e.draws.length) return;
    p.seenAt = frame;
    for (const d of e.draws) p.want = Math.max(p.want, d.needed);
  }

  /** Upload a palette when its skeleton's matrices changed, or its draws read more joints than it holds. */
  private upload(world: World, p: PaletteUse, frame: number): void {
    const version = p.skeleton ? this.matrices.version(world, p.skeleton) : 0;
    if (p.version === version && p.want <= p.joints) return;
    const m = p.skeleton ? this.matrices.matrices(world, p.skeleton) : null;
    const joints = Math.max(p.want, m ? Math.floor(m.length / 12) : 0, 1);
    const data = paletteFor(m, joints);
    p.palette.upload(data);
    p.version = version;
    p.joints = joints;
    p.data = data;
    p.uploadedAt = frame;
  }

  /** Dispatch, place and bound a visible renderer's draws. Returns whether any dispatched. */
  private update(world: World, r: SkinnedMeshRenderer, e: Entry<M>): boolean {
    const p = e.palette!;
    const weights = r.morphWeights;
    const weightsChanged = !sameWeights(e.weights, weights);
    if (weightsChanged) e.weights = [...weights];
    let dispatched = false;
    for (const d of e.draws) {
      if (weightsChanged) d.draw.setMorphWeights(e.weights);
      if (!(d.skinnedWith !== p.uploadedAt || weightsChanged || d.dirty)) continue;
      d.draw.dispatch();
      d.dirty = false;
      d.skinnedWith = p.uploadedAt;
      dispatched = true;
      if (r.boundsMode !== "fixed") d.draw.setBounds(skinnedBox(morphedBox(d.rest, d.reach, e.weights), p.data!, d.joints));
    }
    // Placement: the skeleton node's world matrix (else the renderer's own).
    const placeNode = p.skeleton ?? r.node;
    const wm = world.worldMatrix(placeNode.entity);
    const o = placeNode.entity * 16;
    let moved = !e.placed;
    if (e.placed) for (let k = 0; k < 16 && !moved; k++) moved = e.placed[k] !== wm[o + k];
    if (moved) {
      e.placed ??= new Float32Array(16);
      e.placed.set(wm.subarray(o, o + 16));
      for (const d of e.draws) d.draw.setWorldMatrix(e.placed, 0);
    }
    if (r.boundsMode === "fixed") {
      const box = this.fixedBox(world, r, p.skeleton);
      for (const d of e.draws) d.draw.setBounds(box);
    }
    return dispatched;
  }

  /** `boundsCenter`/`boundsSize` around the renderer's node, in the skeleton's model space. */
  private fixedBox(world: World, r: SkinnedMeshRenderer, skeleton: GameObject | null): Box6 {
    const c = r.boundsCenter;
    const s = r.boundsSize;
    const local: Box6 = [c.x - s.x / 2, c.y - s.y / 2, c.z - s.z / 2, c.x + s.x / 2, c.y + s.y / 2, c.z + s.z / 2];
    if (!skeleton || skeleton === r.node) return local;
    // scratch[0..16) = skeleton⁻¹, [16..32) = renderer world, [32..48) = skeleton⁻¹ × renderer.
    const wm = world.worldMatrix(skeleton.entity);
    if (!Mat4.invert(scratch, 0, wm, skeleton.entity * 16)) return local;
    const rm = world.worldMatrix(r.node.entity);
    scratch.set(rm.subarray(r.node.entity * 16, r.node.entity * 16 + 16), 16);
    Mat4.multiply(scratch, 32, scratch, 0, scratch, 16);
    return transformBox(local, scratch, 32);
  }

  // --- helpers ---------------------------------------------------------------------------------------------

  private createDraw(s: SkinnedMeshSource, name: string): DrawState<M> {
    const g = s.geometry;
    const draw: DrawState<M>["draw"] = this.draws.create(s, name);
    const all: M[] = [draw.mesh];
    this.owned.add(draw.mesh);
    const levels = draw.levelCount ?? 1;
    const level: LevelDraw<M> = {
      levels,
      mesh: (l) => {
        const m = draw.levelMesh && l > 0 ? draw.levelMesh(Math.min(l, levels - 1)) : draw.mesh;
        if (!all.includes(m)) {
          all.push(m);
          this.owned.add(m);
        }
        return m;
      },
      show: (mask) => draw.showLevels?.(mask),
    };
    return { draw, level, all, joints: usedJoints(g), needed: jointsNeeded(g), rest: restBox(g), reach: morphReach(g), dirty: true, skinnedWith: -1 };
  }

  private disposeDraws(e: Entry<M>): void {
    for (const d of e.draws) {
      for (const m of d.all) this.owned.delete(m);
      d.draw.dispose();
    }
    e.draws = [];
    e.placed = null;
  }

  /** The node whose Skeleton deforms `r`: its `skeleton` field, else the nearest ancestor (or itself) with one. */
  private skeletonOf(r: SkinnedMeshRenderer): GameObject | null {
    return r.skeleton ?? r.node.getComponentInParent(Skeleton)?.node ?? null;
  }

  private acquirePalette(key: object, skeleton: GameObject | null): PaletteUse {
    let p = this.palettes.get(key);
    if (!p) {
      p = { palette: this.draws.palette(skeleton ? `skeleton ${skeleton.name}` : "bind pose"), key, skeleton, users: 0, version: null, joints: 0, data: null, uploadedAt: -1, want: 0, seenAt: -1 };
      this.palettes.set(key, p);
    }
    p.users++;
    return p;
  }

  private releasePalette(e: Entry<M>): void {
    const p = e.palette;
    if (!p) return;
    e.palette = null;
    for (const d of e.draws) d.dirty = true; // a new palette: skin again
    if (--p.users > 0) return;
    p.palette.dispose();
    this.palettes.delete(p.key);
  }
}
