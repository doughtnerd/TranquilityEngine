/**
 * GPU instancing for MeshRenderers (ADR 0108). Each renderer mesh is a *drawable* in a batch keyed by
 * its geometry, the material it draws and its shadow settings:
 *
 * - `auto` (the default): a Babylon `InstancedMesh` of a hidden source mesh shared by the batch. Babylon
 *   draws a source's visible instances in one call; each instance keeps its own culling, picking and
 *   bounds. A lone renderer is an instance too, so the shader variant (`INSTANCES`) doesn't change when
 *   a second copy appears.
 * - `thin`: a slot in one thin-instance matrix buffer per batch, culled and drawn as one mesh. No
 *   per-renderer Babylon object at all: for many small things that rarely move.
 * - `off`: a mesh of its own (the material needs per-mesh state).
 *
 * Batches are made on first use. A batch whose last drawable goes is disposed at once, or, when the drawable was
 * given back with `retain` (a level no view drew for a while, ADR 0446 §3), kept a few seconds first, so a moving
 * camera doesn't make and dispose Babylon meshes.
 *
 * **Per-pass thin sources (ADR 0446 §3).** With levels applied per view, a thin batch draws through one source mesh
 * per pass: each view, the shadow casters, each cascade of a cascaded shadow map, each probe capture. They share
 * the batch's vertex buffers (`meshOf`, §1), each with its own `Geometry`, index buffer and matrix buffer holding
 * only what that pass draws (`beginPasses`, `add`, `endPasses`; cascades fill on demand through `expandCascade`).
 * The batch's own source then draws nothing (it keeps its slots for when levels stop being applied).
 *
 * **Fade batches (ADR 0446 §4).** A key with `fade` names a batch of its own whose sources compile the crossfade
 * variant (`lodFade.ts`): fading instances draw there, so steady ones never pay for a shader `discard`. Each drawable
 * carries a fade value (`setFade`), as an instanced buffer (auto) or a second thin-instance buffer beside each pass's
 * matrices (thin). `reserve` makes a fade batch ahead of its first fade and keeps it while reserved.
 */
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { Plane } from "@babylonjs/core/Maths/math.plane.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import "@babylonjs/core/Meshes/instancedMesh.js"; // Mesh.createInstance
import "@babylonjs/core/Meshes/thinInstanceMesh.js"; // Mesh.thinInstance*
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { MaterialInstancing } from "../../scene/material";
import type { ModelMesh } from "../../scene/models";
import { meshBounds, transformAabb } from "../visibility/bounds";
import { addLodFade, LOD_FADE_ATTRIBUTE, markFadeSource } from "./lodFade";
import { meshOf, modelSubMeshes } from "./materials";
import { aabbInPlanes, type CascadeExpander } from "./shadowCulling";

/** What a drawable is drawn with: the batch it joins. */
export interface DrawKey {
  src: ModelMesh;
  material: BabylonMaterial;
  receiveShadows: boolean;
  /** Thin batches cast shadows as one mesh, so casting is part of their key. */
  castShadows: boolean;
  mode: MaterialInstancing;
  applyFog: boolean;
  /** A fade batch (ADR 0446 §4): its sources draw the crossfade variant. Absent: steady. Not for `off`. */
  fade?: boolean;
}

/** One renderer mesh in a batch. */
export interface Drawable {
  readonly mode: MaterialInstancing;
  /** The renderer's own Babylon mesh (its `InstancedMesh`, or a whole mesh for `off`); null in a thin batch. */
  readonly mesh: AbstractMesh | null;
  /** The mesh Babylon draws the batch with (the instances' hidden source, or the thin-instance mesh). */
  readonly source: Mesh;
  readonly key: string;
  /** What it was acquired for: `sameDraw` compares a frame's wanted key with it without building a string. */
  readonly draw: DrawKey;
  /** The world matrix, column-major as Babylon keeps it; written into the batch when it changed. */
  setMatrix(m: Matrix): void;
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  /** In a fade batch: its fade value (ADR 0446 §4 sign convention); ignored elsewhere. */
  setFade(value: number): void;
}

/** A pass a thin batch draws in (ADR 0446 §3): a view's key, `CASTERS_PASS`, a probe capture's key. */
export type PassKey = string;

/** The pass shadow casters draw in: every shadow map's, before cascades compact it. */
export const CASTERS_PASS: PassKey = "casters";

/** Seconds an empty batch given back with `retain` is kept before it's disposed. */
export const BATCH_RETAIN_SECONDS = 3;
/** Frames a batch keeps an instance given back with `retain` for another renderer to take before disposing it. */
export const FREE_FRAMES = 30;
/** Seconds a pass's source is kept after it last drew. */
const PASS_RETAIN_SECONDS = 3;

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object): number => {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return id;
};

/** Whether two keys name the same batch (as `drawKey` would, without allocating). */
export const sameDraw = (a: DrawKey, b: DrawKey): boolean =>
  a.mode === b.mode && a.src.data === b.src.data && a.material === b.material && a.receiveShadows === b.receiveShadows && a.applyFog === b.applyFog && (a.mode !== "thin" || a.castShadows === b.castShadows) && !a.fade === !b.fade;

/** A drawable's batch key. */
export const drawKey = (k: DrawKey): string => `${k.mode}|${idOf(k.src.data)}|${k.material.uniqueId}|${k.receiveShadows ? 1 : 0}|${k.mode === "thin" && k.castShadows ? 1 : 0}|${k.applyFog ? 1 : 0}${k.fade ? "|fade" : ""}`;

interface InstanceBatch {
  kind: "auto";
  key: string;
  source: Mesh;
  /**
   * Instances given back with `retain`, disabled, for the next `acquire` in this batch to take (the most recent first),
   * each with the frame it was given back in (`freedAt`): a level switch moves an instance from one renderer to
   * another instead of disposing one and making another. Ones unused for `FREE_FRAMES` are disposed by `flush`.
   */
  free: AbstractMesh[];
  freedAt: number[];
  members: number;
  /** `reserve` calls not yet undone: a reserved batch isn't disposed while empty. */
  reserved: number;
  /** When its last drawable went with `retain` (seconds), or -1 while it has drawables. */
  emptySince: number;
}

/** One pass's source mesh of a thin batch. */
interface ThinPass {
  readonly source: Mesh;
  buffer: Float32Array;
  /** Its fade values, one per instance, in a fade batch (ADR 0446 §4); else null. */
  fades: Float32Array | null;
  /** What it draws this frame. */
  readonly list: ThinDrawable[];
  /** Instances uploaded. */
  count: number;
  /** When it last drew (seconds). */
  used: number;
  /** Filled on demand (a cascade), not by `endPasses`. */
  readonly deferred: boolean;
}

interface ThinBatch {
  kind: "thin";
  key: string;
  draw: DrawKey;
  source: Mesh;
  members: number;
  reserved: number;
  emptySince: number;
  /** Enabled slots, packed at the front of `buffer` in this order. */
  slots: ThinDrawable[];
  buffer: Float32Array;
  dirty: boolean;
  castShadows: boolean;
  /** Its per-pass sources (ADR 0446 §3). */
  passes: Map<PassKey, ThinPass>;
}

class ThinDrawable implements Drawable {
  readonly mode = "thin" as const;
  readonly mesh = null;
  index = -1;
  readonly matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  /** Its world AABB, for per-cascade compaction. */
  readonly box = new Float32Array(6);
  /** Its fade value in a fade batch (written into each pass's fade buffer). */
  fade = 0;
  constructor(
    readonly key: string,
    readonly draw: DrawKey,
    readonly batch: ThinBatch,
  ) {
    transformAabb(meshBounds(draw.src), this.matrix, 0, this.box);
  }
  get source(): Mesh {
    return this.batch.source;
  }
  get enabled(): boolean {
    return this.index >= 0;
  }
  setFade(value: number): void {
    this.fade = value;
  }
  setMatrix(m: Matrix): void {
    m.copyToArray(this.matrix);
    transformAabb(meshBounds(this.draw.src), this.matrix, 0, this.box);
    if (this.index >= 0) {
      this.batch.buffer.set(this.matrix, this.index * 16);
      this.batch.dirty = true;
    }
  }
  setEnabled(on: boolean): void {
    const b = this.batch;
    if (on === this.index >= 0) return;
    if (on) {
      if ((b.slots.length + 1) * 16 > b.buffer.length) {
        const grown = new Float32Array(Math.max(16 * 16, b.buffer.length * 2));
        grown.set(b.buffer);
        b.buffer = grown;
        b.source.thinInstanceSetBuffer("matrix", b.buffer, 16, false);
      }
      this.index = b.slots.length;
      b.slots.push(this);
      b.buffer.set(this.matrix, this.index * 16);
    } else {
      // Swap-remove: the last slot moves into this one.
      const last = b.slots.pop()!;
      if (last !== this) {
        last.index = this.index;
        b.slots[this.index] = last;
        b.buffer.set(last.matrix, this.index * 16);
      }
      this.index = -1;
    }
    b.dirty = true;
  }
}

class MeshDrawable implements Drawable {
  private on = true;
  constructor(
    readonly mode: "auto" | "off",
    readonly key: string,
    readonly draw: DrawKey,
    readonly mesh: AbstractMesh,
    readonly source: Mesh,
    private readonly matrix = new Matrix(),
  ) {
    if (draw.fade && mode === "auto") mesh.instancedBuffers[LOD_FADE_ATTRIBUTE] = 0;
  }
  get enabled(): boolean {
    return this.on;
  }
  setFade(value: number): void {
    if (this.draw.fade && this.mode === "auto") this.mesh.instancedBuffers[LOD_FADE_ATTRIBUTE] = value;
  }
  setMatrix(m: Matrix): void {
    // Babylon keeps the matrix it's given: each drawable keeps one, refilled when the node moves.
    this.matrix.copyFrom(m);
    this.mesh.freezeWorldMatrix(this.matrix);
  }
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.mesh.setEnabled(on);
  }
}

const IDENTITY = Matrix.Identity();

export class MeshBatches implements CascadeExpander {
  private readonly batches = new Map<string, InstanceBatch | ThinBatch>();
  /** Every Babylon mesh made here (sources, instances, `off` meshes, pass sources): what per-view lists place themselves. */
  private readonly made = new WeakSet<AbstractMesh>();
  /** Each pass source's batch, and each casters pass source's (for `expandCascade`). */
  private readonly passOwner = new WeakMap<AbstractMesh, ThinBatch>();
  private readonly casterOwner = new WeakMap<AbstractMesh, ThinBatch>();
  private now = 0;
  /** `flush` calls so far: what free instances' ages count in. */
  private frames = 0;
  private passMode = false;

  constructor(private readonly scene: Scene) {}

  /** The time in seconds (the feature's frame clock): retention is measured against it. */
  setTime(now: number): void {
    this.now = now;
  }

  /**
   * Whether thin batches draw through per-pass sources (levels applied per view, ADR 0446 §3). Turning it off
   * disposes every pass source, so the batches' own sources draw again for every view and shadow map.
   */
  setPassMode(on: boolean): void {
    if (on === this.passMode) return;
    this.passMode = on;
    for (const b of this.batches.values()) {
      if (b.kind !== "thin") continue;
      b.dirty = true;
      if (!on) this.disposePasses(b);
    }
  }

  /** Whether a Babylon mesh is one made here (drawables, batch and pass sources). */
  owns(mesh: AbstractMesh): boolean {
    return this.made.has(mesh);
  }

  /** The batch key of a mesh made here for a batch (its source, or a pass source), or null. */
  keyOf(mesh: AbstractMesh): string | null {
    const pass = this.passOwner.get(mesh);
    if (pass) return pass.key;
    for (const b of this.batches.values()) if (b.source === mesh) return b.key;
    return null;
  }

  /**
   * A drawable for one renderer mesh in the batch `key` describes (made on first use). Starts enabled, at `matrix`
   * (the identity when not given).
   */
  acquire(k: DrawKey, name: string, matrix?: Matrix): Drawable {
    const key = drawKey(k);
    if (k.mode === "off") {
      const mesh = this.makeSource({ ...k, fade: false }, `mesh:${name}`);
      const d = new MeshDrawable("off", key, { ...k, fade: false }, mesh, mesh);
      if (matrix) d.setMatrix(matrix);
      return d;
    }
    const batch = this.batchFor(k, key);
    batch.members++;
    batch.emptySince = -1;
    if (batch.kind === "thin") {
      const d = new ThinDrawable(key, { ...k }, batch);
      if (matrix) d.setMatrix(matrix);
      d.setEnabled(true);
      return d;
    }
    const reused = batch.kind === "auto" ? batch.free.pop() : undefined;
    let instance: AbstractMesh;
    if (reused) {
      (batch as InstanceBatch).freedAt.pop();
      reused.name = `mesh:${name}`;
      reused.setEnabled(true);
      instance = reused;
    } else {
      instance = batch.source.createInstance(`mesh:${name}`);
      this.made.add(instance);
    }
    const d = new MeshDrawable("auto", key, { ...k }, instance, batch.source);
    // A taken instance still stands where its last renderer did.
    if (matrix || reused) d.setMatrix(matrix ?? IDENTITY);
    return d;
  }

  /**
   * Make the batch `k` names now, before anything draws in it, and keep it while reserved (ADR 0446 §3: fade batches
   * exist before a first fade, so it doesn't make Babylon meshes). Undo with `unreserve`; `off` keys have no batch.
   */
  reserve(k: DrawKey): void {
    if (k.mode === "off") return;
    const b = this.batchFor(k, drawKey(k));
    b.reserved++;
    b.emptySince = -1;
  }

  /** Undo one `reserve` of `k`: an empty batch is then kept `BATCH_RETAIN_SECONDS` before it goes. */
  unreserve(k: DrawKey): void {
    const b = k.mode === "off" ? undefined : this.batches.get(drawKey(k));
    if (!b || b.reserved <= 0) return;
    if (--b.reserved === 0 && b.members === 0) b.emptySince = this.now;
  }

  /** The batch for `key`, made empty on first use. */
  private batchFor(k: DrawKey, key: string): InstanceBatch | ThinBatch {
    let batch = this.batches.get(key);
    if (!batch) {
      const source = this.makeSource(k, `batch:${k.src.name}`);
      if (k.mode === "thin") {
        source.freezeWorldMatrix(IDENTITY.clone());
        source.alwaysSelectAsActiveMesh = false;
        const buffer = new Float32Array(16 * 16);
        source.thinInstanceSetBuffer("matrix", buffer, 16, false);
        source.thinInstanceCount = 0;
        source.setEnabled(false);
        batch = { kind: "thin", key, draw: { ...k }, source, members: 0, reserved: 0, emptySince: -1, slots: [], buffer, dirty: true, castShadows: k.castShadows, passes: new Map() };
      } else {
        source.isVisible = false; // only its instances draw
        source.isPickable = false;
        if (k.fade) markFadeSource(source);
        batch = { kind: "auto", key, source, free: [], freedAt: [], members: 0, reserved: 0, emptySince: -1 };
      }
      this.batches.set(key, batch);
    }
    return batch;
  }

  /**
   * Give a drawable back. Its batch goes with its last drawable: at once, or with `retain` after
   * `BATCH_RETAIN_SECONDS` (checked by `flush`), unless a drawable joins it again first.
   */
  release(d: Drawable, retain = false): void {
    if (d.mode === "off") {
      d.source.dispose();
      return;
    }
    const batch = this.batches.get(d.key);
    if (d instanceof ThinDrawable) d.setEnabled(false);
    else if (d.mesh) {
      if (retain && batch?.kind === "auto" && !d.mesh.isDisposed()) {
        // Kept for the batch's next drawable (a level switch elsewhere), disabled meanwhile.
        d.setEnabled(false);
        batch.free.push(d.mesh);
        batch.freedAt.push(this.frames);
      } else d.mesh.dispose();
    }
    if (!batch) return;
    if (--batch.members > 0) return;
    if (retain || batch.reserved > 0) {
      batch.emptySince = this.now;
      return;
    }
    this.disposeBatch(batch);
  }

  /** After syncing: dispose batches empty past their time, upload changed thin-instance buffers and refresh their bounds. */
  flush(): void {
    this.frames++;
    for (const b of this.batches.values()) {
      if (b.kind !== "auto" || !b.free.length) continue;
      // The oldest are at the front.
      let n = 0;
      while (n < b.free.length && this.frames - b.freedAt[n] > FREE_FRAMES) b.free[n++].dispose();
      if (n) {
        b.free.splice(0, n);
        b.freedAt.splice(0, n);
      }
    }
    for (const b of [...this.batches.values()]) {
      if (b.members === 0 && b.reserved === 0 && b.emptySince >= 0 && this.now - b.emptySince > BATCH_RETAIN_SECONDS) this.disposeBatch(b);
    }
    for (const b of this.batches.values()) {
      if (b.kind !== "thin" || !b.dirty) continue;
      b.dirty = false;
      const n = b.slots.length;
      // With per-pass sources the batch's own draws nothing; its slots are kept for when they stop.
      // A fade batch draws only through its pass sources, which carry the fade values.
      b.source.setEnabled(n > 0 && !this.passMode && !b.draw.fade);
      b.source.thinInstanceCount = n;
      if (n === 0) continue;
      b.source.thinInstanceBufferUpdated("matrix");
      b.source.thinInstanceRefreshBoundingInfo(false);
    }
  }

  /** Thin batches whose meshes cast shadows (the casters list takes their meshes), without per-pass sources. */
  *thinCasters(): Iterable<Mesh> {
    for (const b of this.batches.values()) if (b.kind === "thin" && b.castShadows && !b.draw.fade && b.slots.length) yield b.source;
  }

  // --- Per-pass thin sources (ADR 0446 §3) ----------------------------------------------------------------------

  /** Start a frame's passes: every pass draws nothing until `add` puts drawables in it. */
  beginPasses(): void {
    for (const b of this.batches.values()) if (b.kind === "thin") for (const p of b.passes.values()) p.list.length = 0;
  }

  /**
   * Draw `d` in pass `pass`: a thin drawable goes into its batch's source for the pass, a mesh drawable's own mesh
   * into `meshes` (what the caller lists for the pass).
   */
  add(d: Drawable, pass: PassKey, meshes: AbstractMesh[]): void {
    if (!(d instanceof ThinDrawable)) {
      if (d.mesh) meshes.push(d.mesh);
      return;
    }
    if (pass === CASTERS_PASS && !d.batch.castShadows) return;
    this.pass(d.batch, pass, false).list.push(d);
  }

  /** Upload every pass's instances; sources of passes that drew nothing for a while are disposed. */
  endPasses(): void {
    for (const b of this.batches.values()) {
      if (b.kind !== "thin") continue;
      for (const [key, p] of b.passes) {
        // A cascade's source is filled while its shadow map draws (`expand`), which marks it used.
        if (!p.deferred) {
          this.upload(p, p.list);
          if (p.count > 0) p.used = this.now;
        }
        if (this.now - p.used > PASS_RETAIN_SECONDS) {
          this.disposePass(p);
          b.passes.delete(key);
        }
      }
    }
  }

  /** Append the source meshes that draw something in `pass` (after `endPasses`). */
  passMeshes(pass: PassKey, out: AbstractMesh[]): void {
    for (const b of this.batches.values()) {
      if (b.kind !== "thin") continue;
      const p = b.passes.get(pass);
      if (p && p.count > 0) out.push(p.source);
    }
  }

  /**
   * `CascadeExpander`: a thin batch's casters source becomes the source of cascade `layer` of caster list `list`,
   * holding only the casters whose world AABB reaches the cascade (`planes`); nothing when none does.
   */
  expand(mesh: AbstractMesh, list: number, layer: number, planes: readonly Plane[], out: AbstractMesh[]): boolean {
    const b = this.casterOwner.get(mesh);
    if (!b) return false;
    const casters = b.passes.get(CASTERS_PASS)?.list ?? [];
    const p = this.pass(b, `cascade:${list}:${layer}`, true);
    p.list.length = 0;
    for (const d of casters) if (aabbInPlanes(d.box, planes)) p.list.push(d);
    this.upload(p, p.list);
    p.used = this.now;
    if (p.count > 0) out.push(p.source);
    return true;
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      if (b.kind === "thin") this.disposePasses(b);
      b.source.dispose();
    }
    this.batches.clear();
  }

  private pass(b: ThinBatch, key: PassKey, deferred: boolean): ThinPass {
    let p = b.passes.get(key);
    if (p) return p;
    const source = this.makeSource(b.draw, `batch:${b.draw.src.name}:${key}`);
    source.freezeWorldMatrix(IDENTITY.clone());
    // Its instances are chosen for the pass already (frustum, level, cascade): no culling of the whole.
    source.alwaysSelectAsActiveMesh = true;
    source.isPickable = false;
    const buffer = new Float32Array(16 * 16);
    source.thinInstanceSetBuffer("matrix", buffer, 16, false);
    // A fade batch's pass sources draw the crossfade variant, each instance's value beside its matrix.
    const fades = b.draw.fade ? new Float32Array(16) : null;
    if (fades) markFadeSource(source, fades);
    source.thinInstanceCount = 0;
    source.setEnabled(false);
    p = { source, buffer, fades, list: [], count: 0, used: this.now, deferred };
    b.passes.set(key, p);
    this.passOwner.set(source, b);
    if (key === CASTERS_PASS) this.casterOwner.set(source, b);
    return p;
  }

  /** Write `list`'s matrices into a pass's buffer and upload them. */
  private upload(p: ThinPass, list: readonly ThinDrawable[]): void {
    const n = list.length;
    if (n === 0) {
      if (p.count !== 0) {
        p.count = 0;
        p.source.thinInstanceCount = 0;
        p.source.setEnabled(false);
      }
      return;
    }
    let grown = false;
    if (n * 16 > p.buffer.length) {
      let size = p.buffer.length;
      while (size < n * 16) size *= 2;
      p.buffer = new Float32Array(size);
      if (p.fades) p.fades = new Float32Array(size / 16);
      grown = true;
    }
    for (let i = 0; i < n; i++) p.buffer.set(list[i].matrix, i * 16);
    const fades = p.fades;
    if (fades) for (let i = 0; i < n; i++) fades[i] = list[i].fade;
    if (grown) {
      p.source.thinInstanceSetBuffer("matrix", p.buffer, 16, false);
      if (fades) p.source.thinInstanceSetBuffer(LOD_FADE_ATTRIBUTE, fades, 1, false);
    }
    p.source.thinInstanceCount = n;
    if (!grown) {
      p.source.thinInstanceBufferUpdated("matrix");
      if (fades) p.source.thinInstanceBufferUpdated(LOD_FADE_ATTRIBUTE);
    }
    if (p.count === 0) p.source.setEnabled(true);
    p.count = n;
  }

  private disposePass(p: ThinPass): void {
    p.source.dispose();
  }

  private disposePasses(b: ThinBatch): void {
    for (const p of b.passes.values()) this.disposePass(p);
    b.passes.clear();
  }

  private disposeBatch(b: InstanceBatch | ThinBatch): void {
    if (b.kind === "thin") this.disposePasses(b);
    b.source.dispose();
    this.batches.delete(b.key);
  }

  private makeSource(k: DrawKey, name: string): Mesh {
    const mesh = meshOf(this.scene, name, k.src);
    // The first fade batch drawing a material gives it the crossfade plugin (ADR 0446 §4).
    if (k.fade) addLodFade(k.material);
    mesh.material = k.material;
    if (k.material instanceof MultiMaterial) modelSubMeshes(k.src, mesh);
    mesh.receiveShadows = k.receiveShadows;
    mesh.applyFog = k.applyFog;
    this.made.add(mesh);
    return mesh;
  }
}
