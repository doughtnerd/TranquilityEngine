// The skinning render feature for the Babylon backend (ADR 0370 "Rendering", 0135; T16): `SkinningSync` over
// `BabylonSkinnedMeshes`. Loaded on demand (`register.ts` names it only in a dynamic import), so Babylon stays out of
// `myco` and games without SkinnedMeshRenderers never download it. Skinned meshes cast shadows through `casters` and are
// picked, framed and outlined through `drawn` like MeshRenderers' (ADR 0276).
//
// Levels per view (ADR 0459 §6, as the Meshes feature does, §3): while the World runs the visibility stage the renderer
// calls `prepareViews` with every view's result, and each view draws, for each renderer, the level the result gives
// (each model mesh draws min(level, its last level)), as meshes that share the draw's skinned vertex buffer and
// skeleton. Hidden and LOD-culled renderers are left out of that view's list; casters follow the main view's
// `casterLevels`. Without the stage the feature draws level 0 as it always did.
import type { Component } from "../../../../../engine/core/Component";
import type { World } from "../../../../../engine/core/World";
import { PICK_ORDER, type BabylonFeature, type BabylonFeatureFactory, type DrawnDescription, type DrawnNode, type FeatureView, type ViewDrawing } from "../../../../../engine/render/babylon/feature";
import { BabylonSkinnedMeshes, type BabylonSkinnedMesh } from "../../../../../engine/render/babylon/skinnedMeshes";
import { visibilityService } from "../../../../../engine/render/visibility/service";
import { LOD_CULLED, type VisibilityResult } from "../../../../../engine/render/visibility/types";
import { SkinnedMeshRenderer } from "../../components/SkinnedMeshRenderer";
import { SkinningSync } from "./sync";

/** A drawn Babylon mesh, as the feature interface names it (Babylon is imported only inside the backend, ADR 0075). */
type AbstractMesh = Parameters<NonNullable<BabylonFeature["casters"]>>[0][number];

type Casters = Parameters<NonNullable<BabylonFeature["casters"]>>[0];

/** The feature: the sync, plus the hooks the renderer asks (casters, drawn, loaded, describe, prepareViews). */
class SkinningFeature implements BabylonFeature {
  private world: World | null = null;
  /** Syncs so far, and the sync count when `prepareViews` last ran. */
  private syncs = 0;
  private preparedAt = -1;
  /** What each view drew at the last `prepareViews`, and the casters. */
  private readonly viewLists: AbstractMesh[][] = [];
  private readonly casterMeshes: BabylonSkinnedMesh[] = [];
  /** The first view's meshes per renderer (picking, framing, outlines). */
  private readonly shown = new Map<SkinnedMeshRenderer, BabylonSkinnedMesh[]>();
  private readonly drawing: ViewDrawing;

  constructor(private readonly skinning: SkinningSync<BabylonSkinnedMesh>) {
    this.drawing = {
      owns: (mesh) => this.skinning.owns(mesh as BabylonSkinnedMesh),
      meshes: (i, out) => {
        const list = this.viewLists[i];
        if (list) for (const m of list) out.push(m);
      },
      cascades: null,
    };
  }

  /** Whether `prepareViews` ran since the latest sync (levels are per view this frame). */
  private get prepared(): boolean {
    return this.preparedAt === this.syncs;
  }

  sync(world: World): void {
    this.world = world;
    // A frame that didn't prepare views after one that did: back to level 0 alone.
    if (this.preparedAt >= 0 && this.preparedAt !== this.syncs) {
      for (const { renderer } of this.skinning.renderers()) for (const d of this.skinning.levelDraws(renderer)) d.show(null);
      this.preparedAt = -1;
    }
    this.syncs++;
    this.skinning.sync(world);
    this.shown.clear();
  }

  /**
   * ADR 0459 §3, §6: each view's meshes from its visibility result and the casters from `casters`' `casterLevels`.
   * Null (every view lists the scene's meshes, level 0 as always) when the World runs no visibility stage.
   */
  prepareViews(views: readonly FeatureView[], casters: VisibilityResult | null): ViewDrawing | null {
    const service = this.world ? visibilityService(this.world) : null;
    if (!service || !views.some((v) => v.result)) return null;
    this.preparedAt = this.syncs;
    const lists = this.viewLists;
    lists.length = views.length;
    for (let k = 0; k < views.length; k++) (lists[k] ??= []).length = 0;
    const casterMeshes = this.casterMeshes;
    casterMeshes.length = 0;
    this.shown.clear();
    for (const { renderer: r, visible } of this.skinning.renderers()) {
      const draws = this.skinning.levelDraws(r);
      const masks = draws.map(() => 0);
      if (visible) {
        const slot = service.slotOf(r);
        for (let k = 0; k < views.length; k++) {
          const result = views[k].result;
          let level = 0;
          if (result && slot >= 0 && slot < result.levels.length) {
            if (result.hidden[slot]) continue;
            level = result.levels[slot];
            if (level === LOD_CULLED) continue;
          }
          draws.forEach((d, i) => {
            const mesh = d.mesh(level);
            masks[i] |= 1 << Math.min(level, d.levels - 1);
            lists[k].push(mesh);
            if (k === 0) {
              let own = this.shown.get(r);
              if (!own) this.shown.set(r, (own = []));
              own.push(mesh);
            }
          });
        }
        // Casters: the main view's caster levels (LOD-culled groups cast at their coarsest level within the tier's
        // shadow distance; hidden ones still cast); a renderer without a slot casts level 0, as its views draw it.
        let casterLevel = r.castShadows ? 0 : LOD_CULLED;
        if (casters && slot >= 0 && slot < casters.casterLevels.length) casterLevel = casters.casterLevels[slot];
        if (casterLevel !== LOD_CULLED)
          draws.forEach((d, i) => {
            casterMeshes.push(d.mesh(casterLevel));
            masks[i] |= 1 << Math.min(casterLevel, d.levels - 1);
          });
      }
      // Every mesh a pass draws stays enabled (a cull task drops disabled meshes); the rest are disabled.
      draws.forEach((d, i) => d.show(masks[i]));
    }
    return this.drawing;
  }

  release(c: Component): void {
    if (c instanceof SkinnedMeshRenderer) this.skinning.release(c);
  }

  casters(out: Casters): void {
    if (this.prepared) {
      for (const m of this.casterMeshes) out.push(m);
      return;
    }
    for (const r of this.skinning.renderers()) if (r.visible && r.renderer.castShadows) out.push(...r.meshes);
  }

  *drawn(): Iterable<DrawnNode> {
    if (this.prepared) {
      for (const [renderer, meshes] of this.shown) yield { component: renderer, shape: { kind: "meshes", meshes }, order: PICK_ORDER.depthTested };
      return;
    }
    for (const r of this.skinning.renderers()) if (r.visible) yield { component: r.renderer, shape: { kind: "meshes", meshes: r.meshes }, order: PICK_ORDER.depthTested };
  }

  describe(drawn: object): DrawnDescription | null {
    const r = this.skinning.rendererOf(drawn as BabylonSkinnedMesh);
    return r ? { node: r.node, what: `"${r.node.name}" (skinned)` } : null;
  }

  loaded(): boolean {
    return this.skinning.loaded();
  }

  dispose(): void {
    this.skinning.dispose();
  }
}

/** @internal Builds the feature from the renderer's shared services: matrices from the skeleton instances, meshes from the models. */
export const createSkinningFeature: BabylonFeatureFactory = (host) => new SkinningFeature(new SkinningSync(new BabylonSkinnedMeshes({ scene: host.scene, materials: host.materials })));
