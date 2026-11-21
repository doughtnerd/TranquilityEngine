/**
 * MeshRenderer drawing for the Babylon backend (ADR 0108, 0130; the Meshes plugin registers it, ADR 0140): one `BabylonFeature` that mirrors the
 * World's MeshRenderers into Babylon meshes, batched for GPU instancing. It takes what it shares with
 * the renderer (the material library, the probe lookup, the reflection counter) as `BabylonMeshHost`.
 */
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import type { MaterialInstancing } from "../../scene/material";
import { drawnVariant, materialSlots, meshesIfLoaded, type MaterialSlot, type ModelMesh } from "../../scene/models";
import { MeshRenderer } from "../components";
import type { DrawnMaterial } from "../RenderSurface";
import { PICK_ORDER, type BabylonFeature, type DrawnDescription, type DrawnNode, type FeatureSyncContext } from "./feature";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import { matrixChanged } from "../changeDetection";
import { MeshBatches, sameDraw, type DrawKey, type Drawable } from "./meshBatches";
import type { ProbeHit } from "./probes";

/** @internal What the mesh feature takes from the renderer. */
export interface BabylonMeshHost {
  /** Babylon scene (right-handed, +Y up). */
  readonly scene: Scene;
  /**
   * Materials and textures (ADR 0127), shared with the renderer; its `editorPicking` option decides
   * whether thin batches draw as instances (ADR 0108, 0129 `drawPolicy`).
   */
  readonly materials: Pick<BabylonMaterialLibrary, "beginSync" | "endSync" | "release" | "meshMaterials" | "probeCopy" | "isGraph" | "fogless" | "instancing">;
  /** Reflection probes (ADR 0054): whether any exist, and the one a world position lies in. */
  readonly probes: { readonly any: boolean; lookup(x: number, y: number, z: number): ProbeHit | null };
  /** A mesh drew with a probe's reflection this frame (the renderer counts them for diagnostics). Optional. */
  reflected?(): void;
}


interface MeshEntry {
  /** The renderer's own Babylon meshes (instances, or whole meshes with instancing off); none in a thin batch. */
  meshes: AbstractMesh[];
  /** One per model mesh: where it draws (ADR 0108). */
  drawables: Drawable[];
  /** Drawables that haven't had a matrix yet. */
  pending: boolean[];
  sources: readonly ModelMesh[] | null;
  material: BabylonMaterial | null;
  /** Its meshes' material slots (ADR 0089). */
  slotList: MaterialSlot[];
  /** The world matrix its meshes were last frozen with (null: freeze next sync). */
  matrix: Float32Array | null;
}

const tmpMatrix = new Matrix();
/** The batch a renderer mesh wants this frame, refilled per mesh (ADR 0108). */
const wantedKey: DrawKey = { src: null as unknown as ModelMesh, material: null as unknown as BabylonMaterial, receiveShadows: true, castShadows: true, mode: "auto", applyFog: true };

/** A Babylon material in the engine's material terms (diagnostics, ADR 0128). */
function drawnMaterial(m: BabylonMaterial): DrawnMaterial {
  if (m instanceof PBRMaterial) return { unlit: m.unlit, clearcoat: m.clearCoat.isEnabled ? m.clearCoat.intensity : 0, transmission: m.subSurface.isRefractionEnabled ? m.subSurface.refractionIntensity : 0 };
  const lit = m as { unlit?: boolean; disableLighting?: boolean };
  return { unlit: !!(lit.unlit ?? lit.disableLighting), clearcoat: 0, transmission: 0 };
}

/** @internal Draws every MeshRenderer, batched for GPU instancing (ADR 0108). */
export class BabylonMeshes implements BabylonFeature {
  private readonly meshRenderers = new Map<MeshRenderer, MeshEntry>();
  /** MeshRenderer meshes batched for GPU instancing (ADR 0108). */
  private readonly batches: MeshBatches;

  constructor(private readonly host: BabylonMeshHost) {
    this.batches = new MeshBatches(host.scene);
  }

  /** Every MeshRenderer, then the script Material instances no renderer drew any more (ADR 0107). */
  sync(world: World, _ctx?: FeatureSyncContext): void {
    this.host.materials.beginSync();
    for (const m of world._componentsOfType(MeshRenderer)) this.syncMesh(world, m);
    this.host.materials.endSync();
    this.batches.flush();
  }

  release(c: Component): void {
    if (!(c instanceof MeshRenderer)) return;
    const e = this.meshRenderers.get(c);
    if (e) {
      for (const d of e.drawables) this.batches.release(d);
      this.meshRenderers.delete(c);
    }
    this.host.materials.release(c);
  }

  dispose(): void {
    this.batches.dispose();
    this.meshRenderers.clear();
  }

  /** ADR 0276: appends the meshes that cast shadows: enabled renderers' with castShadows, and thin batches' sources. */
  casters(out: AbstractMesh[]): void {
    for (const [r, e] of this.meshRenderers) if (r.castShadows && r.isActiveAndEnabled) out.push(...e.meshes);
    for (const m of this.batches.thinCasters()) out.push(m);
  }

  /** ADR 0276: whether every renderer's model has loaded (the material library's own loading is the renderer's to check). */
  loaded(): boolean {
    for (const m of this.meshRenderers.values()) if (m.sources === null) return false;
    return true;
  }

  /** The renderer that owns a drawn mesh or batch source (`describe`, for the variant report), or null. */
  private ownerOf(drawn: unknown): MeshRenderer | null {
    for (const [r, e] of this.meshRenderers) {
      if (e.meshes.includes(drawn as AbstractMesh) || e.drawables.some((d) => d.source === drawn)) return r;
    }
    return null;
  }

  /** ADR 0154: a drawn mesh's node, for the variant report. */
  describe(drawn: object): DrawnDescription | null {
    const owner = this.ownerOf(drawn);
    return owner ? { node: owner.node, what: `"${owner.node.name}"` } : null;
  }

  /**
   * ADR 0276: each renderer drawn now (an enabled drawable): its own meshes (none in a thin batch, which
   * draws instances of a shared source), depth-tested, with its drawn materials (the diagnostics, ADR 0128).
   */
  *drawn(): Iterable<DrawnNode> {
    for (const [component, e] of this.meshRenderers) {
      const shown = e.drawables.filter((d) => d.enabled);
      if (!shown.length) continue;
      yield { component, shape: { kind: "meshes", meshes: e.meshes }, order: PICK_ORDER.depthTested, materials: shown.map((d) => drawnMaterial(d.draw.material)) };
    }
  }

  private syncMesh(world: World, r: MeshRenderer): void {
    const { materials, probes } = this.host;
    let entry = this.meshRenderers.get(r);
    if (!entry) {
      entry = { meshes: [], drawables: [], pending: [], sources: null, material: null, slotList: [], matrix: null };
      this.meshRenderers.set(r, entry);
    }
    const sources = meshesIfLoaded(r.mesh); // null while the model loads
    const same = entry.sources !== null && sources !== null && entry.sources.length === sources.length && entry.sources.every((m, i) => m === sources[i]);
    const slots = same ? entry.slotList : sources ? materialSlots(sources) : [];
    const variant = sources?.length ? drawnVariant(r.mesh, r.variant) : undefined; // ADR 0118
    // Material slots, script Materials and overrides (ADR 0089, 0107, 0049), resolved by the library.
    const drawnBy = materials.meshMaterials(r, slots, variant);
    const material = drawnBy.material;
    if (!same) {
      for (const d of entry.drawables) this.batches.release(d);
      entry.drawables = [];
      entry.pending = [];
      entry.sources = sources;
      entry.slotList = slots;
      entry.matrix = null;
    }
    entry.material = material;
    const visible = r.isActiveAndEnabled;
    const e = r.node.entity;
    const world16 = world.worldMatrix(e);
    // Refill the drawables' matrices only when the node moved: freezing recomputes their bounds.
    const moved = visible && (sources?.length ?? 0) > 0 && matrixChanged(entry, world16, e * 16);
    const mode = this.instancingFor(r);
    let changed = !same;
    (sources ?? []).forEach((src, i) => {
      // One material, or a multi-material shared by every renderer with the same slot materials, so they batch (ADR 0108).
      const base = drawnBy.of(src);
      // A reflection probe (ADR 0054) for built-in materials; graph materials keep the scene's environment.
      const probe = visible && probes.any && base instanceof PBRMaterial && !materials.isGraph(base) ? probes.lookup(world16[e * 16 + 12], world16[e * 16 + 13], world16[e * 16 + 14]) : null;
      const drawn = probe ? materials.probeCopy(base as PBRMaterial, probe) : base;
      if (probe) this.host.reflected?.();
      // The batch it draws in (ADR 0108): same geometry, material and shadow settings draw instanced.
      const key = wantedKey;
      key.src = src;
      key.material = drawn;
      key.receiveShadows = r.receiveShadows;
      key.castShadows = r.castShadows;
      key.mode = mode;
      key.applyFog = !materials.fogless(base);
      let d = entry!.drawables[i];
      if (!d || !sameDraw(d.draw, key)) {
        if (d) this.batches.release(d);
        d = this.batches.acquire(key, `${r.node.name}:${src.name}`);
        entry!.drawables[i] = d;
        entry!.pending[i] = true;
        changed = true;
      }
      d.setEnabled(visible);
      if (visible && (moved || entry!.pending[i]) && entry!.matrix) {
        Matrix.FromArrayToRef(entry!.matrix as unknown as number[], 0, tmpMatrix);
        d.setMatrix(tmpMatrix);
        entry!.pending[i] = false;
      }
    });
    if (changed) entry.meshes = entry.drawables.flatMap((d) => (d.mesh ? [d.mesh] : []));
  }

  /** How a renderer's meshes batch (ADR 0108): its slot 0 material asset's `instancing`. */
  private instancingFor(r: MeshRenderer): MaterialInstancing {
    return this.host.materials.instancing(r.materials[0] || r.material);
  }
}
