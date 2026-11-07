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
 * Batches are made on first use and disposed when their last drawable goes.
 */
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import "@babylonjs/core/Meshes/instancedMesh.js"; // Mesh.createInstance
import "@babylonjs/core/Meshes/thinInstanceMesh.js"; // Mesh.thinInstance*
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { MaterialInstancing } from "../../scene/material";
import type { ModelMesh } from "../../scene/models";
import { meshOf, modelSubMeshes } from "./materials";

/** What a drawable is drawn with: the batch it joins. */
export interface DrawKey {
  src: ModelMesh;
  material: BabylonMaterial;
  receiveShadows: boolean;
  /** Thin batches cast shadows as one mesh, so casting is part of their key. */
  castShadows: boolean;
  mode: MaterialInstancing;
  applyFog: boolean;
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
}

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object): number => {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return id;
};

/** Whether two keys name the same batch (as `drawKey` would, without allocating). */
export const sameDraw = (a: DrawKey, b: DrawKey): boolean =>
  a.mode === b.mode && a.src.data === b.src.data && a.material === b.material && a.receiveShadows === b.receiveShadows && a.applyFog === b.applyFog && (a.mode !== "thin" || a.castShadows === b.castShadows);

/** A drawable's batch key. */
export const drawKey = (k: DrawKey): string => `${k.mode}|${idOf(k.src.data)}|${k.material.uniqueId}|${k.receiveShadows ? 1 : 0}|${k.mode === "thin" && k.castShadows ? 1 : 0}|${k.applyFog ? 1 : 0}`;

interface InstanceBatch {
  kind: "auto";
  source: Mesh;
  members: number;
}

interface ThinBatch {
  kind: "thin";
  source: Mesh;
  members: number;
  /** Enabled slots, packed at the front of `buffer` in this order. */
  slots: ThinDrawable[];
  buffer: Float32Array;
  dirty: boolean;
  castShadows: boolean;
}

class ThinDrawable implements Drawable {
  readonly mode = "thin" as const;
  readonly mesh = null;
  index = -1;
  readonly matrix = new Float32Array(16);
  constructor(
    readonly key: string,
    readonly draw: DrawKey,
    readonly batch: ThinBatch,
  ) {}
  get source(): Mesh {
    return this.batch.source;
  }
  get enabled(): boolean {
    return this.index >= 0;
  }
  setMatrix(m: Matrix): void {
    m.copyToArray(this.matrix);
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
  ) {}
  get enabled(): boolean {
    return this.on;
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

export class MeshBatches {
  private readonly batches = new Map<string, InstanceBatch | ThinBatch>();

  constructor(private readonly scene: Scene) {}

  /** A drawable for one renderer mesh in the batch `key` describes (made on first use). Starts enabled, at the identity. */
  acquire(k: DrawKey, name: string): Drawable {
    const key = drawKey(k);
    if (k.mode === "off") {
      const mesh = this.makeSource(k, `mesh:${name}`);
      return new MeshDrawable("off", key, { ...k }, mesh, mesh);
    }
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
        batch = { kind: "thin", source, members: 0, slots: [], buffer, dirty: true, castShadows: k.castShadows };
      } else {
        source.isVisible = false; // only its instances draw
        source.isPickable = false;
        batch = { kind: "auto", source, members: 0 };
      }
      this.batches.set(key, batch);
    }
    batch.members++;
    if (batch.kind === "thin") {
      const d = new ThinDrawable(key, { ...k }, batch);
      d.setEnabled(true);
      return d;
    }
    const instance = batch.source.createInstance(`mesh:${name}`);
    return new MeshDrawable("auto", key, { ...k }, instance, batch.source);
  }

  /** Give a drawable back; its batch goes with its last drawable. */
  release(d: Drawable): void {
    if (d.mode === "off") {
      d.source.dispose();
      return;
    }
    const batch = this.batches.get(d.key);
    if (d instanceof ThinDrawable) d.setEnabled(false);
    else d.mesh?.dispose();
    if (!batch) return;
    if (--batch.members > 0) return;
    batch.source.dispose();
    this.batches.delete(d.key);
  }

  /** After syncing: upload changed thin-instance buffers and refresh their bounds. */
  flush(): void {
    for (const b of this.batches.values()) {
      if (b.kind !== "thin" || !b.dirty) continue;
      b.dirty = false;
      const n = b.slots.length;
      b.source.setEnabled(n > 0);
      b.source.thinInstanceCount = n;
      if (n === 0) continue;
      b.source.thinInstanceBufferUpdated("matrix");
      b.source.thinInstanceRefreshBoundingInfo(false);
    }
  }

  /** Thin batches whose meshes cast shadows (the casters list takes their meshes). */
  *thinCasters(): Iterable<Mesh> {
    for (const b of this.batches.values()) if (b.kind === "thin" && b.castShadows && b.slots.length) yield b.source;
  }

  /** The batch sources Babylon draws (for diagnostics and the variant report). */
  sources(): Mesh[] {
    return [...this.batches.values()].map((b) => b.source);
  }

  /** Batches and how many drawables each has (benchmarks, tests). */
  stats(): { batches: number; instanced: number; thin: number; drawables: number } {
    let instanced = 0, thin = 0, drawables = 0;
    for (const b of this.batches.values()) {
      if (b.kind === "thin") thin++;
      else instanced++;
      drawables += b.members;
    }
    return { batches: this.batches.size, instanced, thin, drawables };
  }

  dispose(): void {
    for (const b of this.batches.values()) b.source.dispose();
    this.batches.clear();
  }

  private makeSource(k: DrawKey, name: string): Mesh {
    const mesh = meshOf(this.scene, name, k.src);
    mesh.material = k.material;
    if (k.material instanceof MultiMaterial) modelSubMeshes(k.src, mesh);
    mesh.receiveShadows = k.receiveShadows;
    mesh.applyFog = k.applyFog;
    return mesh;
  }
}
