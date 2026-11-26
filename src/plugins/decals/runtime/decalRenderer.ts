/**
 * Decal drawing (ADR 0395), renderer-neutral: `DecalProjector`s and pooled 3D decals become instances of decal
 * batches (one per look and order) through the renderer core's `DecalHost`; `Decal2D`s and pooled 2D decals become
 * layered quads through its `QuadBatchHost` (one batch per texture and draw order, or one per decal that clips itself
 * to a sprite). The renderer knows boxes and quads; this module knows decals. No Babylon here (ADR 0075): it's
 * unit-tested against fake hosts.
 */
import type { Component } from "../../../engine/core/Component";
import { Mat4 } from "../../../engine/core/math";
import type { World } from "../../../engine/core/World";
import { SpriteRenderer } from "../../../engine/render/components";
import type { DecalBatch, DecalHost, DecalLook } from "../../../engine/render/decals";
import type { QuadBatch, QuadBatchHost, QuadMask } from "../../../engine/render/quadBatches";
import { sortingOrder } from "../../../engine/render/sortOrder";
import { spriteFrame, type SpriteFrame } from "../../../engine/render/spriteFrame";
import { Assets } from "../../../engine/scene/Assets";
import type { GameObject } from "../../../engine/scene/GameObject";
import { splitSpriteRef } from "../../../engine/scene/importSettings";
import { Decal2D, DecalProjector } from "./components";
import { decalPoolOf, type PooledDecal } from "./Decals";

/** What the decal drawing borrows from the renderer. */
export interface DecalsHost {
  readonly decals: DecalHost;
  readonly quads: QuadBatchHost;
  /** The project's pixels per unit (a sprite's default scale). */
  pixelsPerUnit(): number;
}

/** @internal A placed decal drawn now (ADR 0276): a projector's box (column-major unit-cube-to-world), or a 2D decal's quad batch and draw order. */
export type DrawnDecal =
  | { readonly component: DecalProjector; readonly kind: "box"; readonly matrix: Float32Array }
  | { readonly component: Decal2D; readonly kind: "quads"; readonly batch: QuadBatch; readonly order: number };

interface Instances {
  look: DecalLook;
  order: number;
  count: number;
  matrices: number[];
  colors: number[];
  uvs: number[];
  angles: number[];
}

interface Quads {
  texture: string;
  sortingLayer: string;
  orderInLayer: number;
  /** Its draw order (`sortingOrder`), for picking. */
  order: number;
  /** Its 2D material asset (ADR 0399: "" the default, Sprite Lit). */
  material: string;
  mask: QuadMask | null;
  positions: number[];
  uvs: number[];
  colors: number[];
  /** The Decal2D Components it holds (for `drawn`). */
  owners: Decal2D[];
}

const quadIndexCache = new Map<number, Uint32Array>();
function quadIndices(quads: number): Uint32Array {
  let idx = quadIndexCache.get(quads);
  if (idx) return idx;
  idx = new Uint32Array(quads * 6);
  for (let q = 0; q < quads; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  if (quadIndexCache.size > 256) quadIndexCache.clear();
  quadIndexCache.set(quads, idx);
  return idx;
}

const box = new Float64Array(16);
const tmp = new Float64Array(16);
const inv = new Float64Array(16);

/** @internal */
export class DecalRenderer {
  private readonly boxes = new Map<string, DecalBatch>();
  private readonly quads = new Map<string, QuadBatch>();
  private drawnNow: DrawnDecal[] = [];
  private ready = true;
  private counts = { projectors: 0, decals2D: 0, pooled: 0, batches: 0 };

  constructor(private readonly host: DecalsHost) {}

  /** Draw the World's decals as seen from `eye` (the main view camera's world position, for distance fades), or without fades when null. */
  sync(world: World, eye: readonly [number, number, number] | null): void {
    this.ready = true;
    this.drawnNow = [];
    const instances = new Map<string, Instances>();
    const quads = new Map<string, Quads>();
    const pool = decalPoolOf(world, false);
    let projectors = 0, decals2D = 0;

    // --- 3D -----------------------------------------------------------------------------------------
    for (const p of world._componentsOfType(DecalProjector)) {
      if (!p.isActiveAndEnabled || !p.node.transform) continue;
      const e = p.node.entity, m = world.worldMatrix(e);
      const sx = p.size.x, sy = p.size.y, sz = p.size.z;
      Mat4.compose(tmp, 0, [p.pivot.x, p.pivot.y, p.pivot.z], 0, [0, 0, 0, 1], 0, [sx, sy, sz], 0);
      Mat4.multiply(box, 0, m as unknown as Float64Array, e * 16, tmp, 0);
      const fade = distanceFade(box, eye, p.drawDistance, p.fadeRange);
      const alpha = p.color.a * clamp01(p.opacity) * fade;
      this.drawnNow.push({ component: p, kind: "box", matrix: Float32Array.from(box) });
      projectors++;
      if (alpha <= 0) continue;
      addInstance(instances, { material: p.material, texture: p.texture, blend: p.blend }, p.order, box, p.color, alpha, [p.uvScale.x, p.uvScale.y, p.uvOffset.x, p.uvOffset.y], [Math.cos(p.angleFade.x), Math.cos(p.angleFade.y)]);
    }
    for (const d of pool?.decals3D ?? []) {
      if (!d.alive) continue;
      if (!placeOf(world, d, box)) continue;
      const alpha = d.color.a * clamp01(d.opacity) * d.fade();
      if (alpha <= 0) continue;
      addInstance(instances, { material: d.look.material, texture: d.look.texture, blend: d.look.blend }, d.look.order, box, d.color, alpha, d.uv, d.angles);
    }

    // --- 2D -----------------------------------------------------------------------------------------
    for (const c of world._componentsOfType(Decal2D)) {
      if (!c.isActiveAndEnabled || !c.node.transform) continue;
      const e = c.node.entity, m = world.worldMatrix(e);
      const receiver = c.clip === "parentSprite" ? c.node.parent : null;
      const placed = this.addQuad(world, quads, `c${e}`, c.sprite, c.sortingLayer, c.orderInLayer, m, e * 16, c.size ? [c.size.x, c.size.y] : null, c.color, clamp01(c.opacity), receiver, c.material);
      if (placed) {
        placed.owners.push(c);
        decals2D++;
      }
    }
    for (const d of pool?.decals2D ?? []) {
      if (!d.alive) continue;
      Mat4.copy(box, 0, d.matrix, 0);
      this.addQuad(world, quads, null, d.look.sprite, d.look.sortingLayer, d.look.orderInLayer, box, 0, d.size2D, d.color, clamp01(d.opacity) * d.fade(), d.clip);
    }

    // --- hand the batches over ----------------------------------------------------------------------
    const usedBoxes = new Set<string>();
    for (const [key, inst] of instances) {
      usedBoxes.add(key);
      let batch = this.boxes.get(key);
      if (!batch) this.boxes.set(key, (batch = this.host.decals.createBatch(key, inst.look)));
      batch.setOrder(inst.order);
      batch.setInstances(inst.count, new Float32Array(inst.matrices), new Float32Array(inst.colors), new Float32Array(inst.uvs), new Float32Array(inst.angles));
      batch.setVisible(true);
      if (!batch.loaded()) this.ready = false;
    }
    for (const [key, batch] of this.boxes) {
      if (usedBoxes.has(key)) continue;
      batch.dispose();
      this.boxes.delete(key);
    }
    const usedQuads = new Set<string>();
    for (const [key, q] of quads) {
      usedQuads.add(key);
      let batch = this.quads.get(key);
      if (!batch) this.quads.set(key, (batch = this.host.quads.createBatch(`decal2d:${key}`)));
      batch.setOrder(q.sortingLayer, q.orderInLayer);
      batch.setMaterial(q.material);
      batch.setTriangles(q.texture, new Float32Array(q.positions), new Float32Array(q.uvs), quadIndices(q.positions.length / 12), new Float32Array(q.colors));
      batch.setTint("#ffffff", 1);
      batch.setMask(q.mask);
      batch.setMatrix(IDENTITY);
      batch.setVisible(true);
      for (const owner of q.owners) this.drawnNow.push({ component: owner, kind: "quads", batch, order: q.order });
    }
    for (const [key, batch] of this.quads) {
      if (usedQuads.has(key)) continue;
      batch.dispose();
      this.quads.delete(key);
    }
    this.counts = { projectors, decals2D, pooled: pool?.count ?? 0, batches: instances.size + quads.size };
  }

  /**
   * Add a 2D decal's quad (its pivot frame `m` at `mo`, column-major) to the batch it belongs to: its own (`own` key, a
   * placed Decal2D), else the one for its texture, draw order and receiver. Null while its texture loads.
   */
  private addQuad(
    world: World,
    quads: Map<string, Quads>,
    own: string | null,
    sprite: string,
    layer: string,
    orderInLayer: number,
    m: ArrayLike<number>,
    mo: number,
    size: readonly [number, number] | null,
    color: { r: number; g: number; b: number; a: number },
    opacity: number,
    receiver: GameObject | null,
    material = "",
  ): Quads | null {
    const { path: image, slice } = splitSpriteRef(sprite);
    let frame: SpriteFrame | null = null;
    if (image) {
      const px = this.host.quads.textureSize(image, () => {});
      if (!px) {
        this.ready = false;
        return null;
      }
      frame = spriteFrame(Assets.importSettings(image), slice, px[0], px[1], { component: 0, project: this.host.pixelsPerUnit() }, size ? { x: size[0], y: size[1] } : null);
    }
    const [w, h] = frame?.size ?? size ?? [1, 1];
    const [pvx, pvy] = frame?.pivot ?? [0.5, 0.5];
    const [u0, v0, u1, v1] = frame?.uv ?? [0, 0, 1, 1];
    const order = sortingOrder(world.settings.render.sortingLayers, layer, orderInLayer); // the batch warns about an unknown layer
    const mask = receiver ? this.maskOf(receiver, m[mo + 14]!) : null;
    if (receiver && mask === undefined) return null; // the receiver's texture is loading
    // A placed Decal2D draws in a batch of its own (picked and framed by itself); spawned ones share by texture, order and receiver.
    const key = own ?? (mask && receiver ? `${image}|${order}|r${receiver.entity}` : `${image}|${order}`) + (material ? `|${material}` : "");
    let q = quads.get(key);
    if (!q) quads.set(key, (q = { texture: image, sortingLayer: layer, orderInLayer, order, material, mask: mask ?? null, positions: [], uvs: [], colors: [], owners: [] }));
    const corners: [number, number, number, number][] = [
      [-pvx * w, -pvy * h, u0, v0],
      [(1 - pvx) * w, -pvy * h, u1, v0],
      [(1 - pvx) * w, (1 - pvy) * h, u1, v1],
      [-pvx * w, (1 - pvy) * h, u0, v1],
    ];
    const a = color.a * opacity;
    for (const [x, y, u, v] of corners) {
      q.positions.push(m[mo]! * x + m[mo + 4]! * y + m[mo + 12]!, m[mo + 1]! * x + m[mo + 5]! * y + m[mo + 13]!, m[mo + 2]! * x + m[mo + 6]! * y + m[mo + 14]!);
      q.uvs.push(u, v);
      q.colors.push(color.r, color.g, color.b, a);
    }
    return q;
  }

  /**
   * The mask a receiver node's sprite gives (ADR 0395): its texture, and the map from world XY (at height `z`) to its
   * UV, through the node's inverse world matrix and the sprite's size, pivot, flips and slice. Null when the node has
   * no sprite (the decal draws unclipped); undefined while the sprite's texture loads.
   */
  private maskOf(node: GameObject, z: number): QuadMask | null | undefined {
    const s = node.getComponent(SpriteRenderer);
    if (!s || !s.isActiveAndEnabled || !s.sprite || !node.transform) return null;
    const { path: image, slice } = splitSpriteRef(s.sprite);
    if (!image) return null;
    const px = this.host.quads.textureSize(image, () => {});
    if (!px) {
      this.ready = false;
      return undefined;
    }
    const frame = spriteFrame(Assets.importSettings(image), slice, px[0], px[1], { component: s.pixelsPerUnit, project: this.host.pixelsPerUnit() }, s.size);
    const world = node.world, e = node.entity;
    if (!Mat4.invert(inv, 0, world.worldMatrix(e) as unknown as Float64Array, e * 16)) return null;
    const W = (s.flipX ? -1 : 1) * frame.size[0], H = (s.flipY ? -1 : 1) * frame.size[1];
    const [u0, v0, u1, v1] = frame.uv ?? [0, 0, 1, 1];
    const du = u1 - u0, dv = v1 - v0;
    const cx = inv[8]! * z + inv[12]!, cy = inv[9]! * z + inv[13]!;
    return {
      texture: image,
      uv: [(du * inv[0]!) / W, (du * inv[4]!) / W, du * (cx / W + frame.pivot[0]) + u0, (dv * inv[1]!) / H, (dv * inv[5]!) / H, dv * (cy / H + frame.pivot[1]) + v0],
    };
  }

  drawn(): readonly DrawnDecal[] {
    return this.drawnNow;
  }

  loaded(): boolean {
    return this.ready;
  }

  diagnostics(): { projectors: number; decals2D: number; pooled: number; batches: number } {
    return this.counts;
  }

  /** A placed decal went: nothing is kept per Component (batches are per look), so the next sync drops it. */
  release(_c: Component): void {}

  dispose(): void {
    for (const b of this.boxes.values()) b.dispose();
    for (const b of this.quads.values()) b.dispose();
    this.boxes.clear();
    this.quads.clear();
    this.drawnNow = [];
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** A pooled decal's box (or pivot frame) in world space into `out`: through its parent's world matrix when it has one. False when the parent is gone. */
function placeOf(world: World, d: PooledDecal, out: Float64Array): boolean {
  if (!d.parent) {
    Mat4.copy(out, 0, d.matrix, 0);
    return true;
  }
  if (!d.parent.isValid || !d.parent.transform) return false;
  const e = d.parent.entity;
  Mat4.multiply(out, 0, world.worldMatrix(e) as unknown as Float64Array, e * 16, d.matrix, 0);
  return true;
}

/** How much a box shows from `eye`: 1 near, fading over `range` metres before `far`, 0 beyond. 1 without an eye. */
function distanceFade(m: Float64Array, eye: readonly [number, number, number] | null, far: number, range: number): number {
  if (!eye) return 1;
  const d = Math.hypot(m[12]! - eye[0], m[13]! - eye[1], m[14]! - eye[2]);
  if (d >= far) return 0;
  return range > 0 ? Math.min(1, (far - d) / range) : 1;
}

function addInstance(
  map: Map<string, Instances>,
  look: DecalLook,
  order: number,
  m: Float64Array,
  color: { r: number; g: number; b: number },
  alpha: number,
  uv: readonly number[],
  angles: readonly number[],
): void {
  const key = `${look.material}|${look.texture}|${look.blend}|${order}`;
  let inst = map.get(key);
  if (!inst) map.set(key, (inst = { look, order, count: 0, matrices: [], colors: [], uvs: [], angles: [] }));
  for (let i = 0; i < 16; i++) inst.matrices.push(m[i]!);
  inst.colors.push(color.r, color.g, color.b, alpha);
  inst.uvs.push(uv[0]!, uv[1]!, uv[2]!, uv[3]!);
  inst.angles.push(angles[0]!, angles[1]!);
  inst.count++;
}
