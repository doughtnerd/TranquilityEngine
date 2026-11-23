// The skinning render feature for the Babylon backend (ADR 0370 "Rendering", 0135; T16): `SkinningSync` over
// `BabylonSkinnedMeshes`. Loaded on demand (`register.ts` names it only in a dynamic import), so Babylon stays out of
// `myco` and games without SkinnedMeshRenderers never download it. Skinned meshes cast shadows through `casters` and are
// picked, framed and outlined through `drawn` like MeshRenderers' (ADR 0276).
import type { Component } from "../../../../../engine/core/Component";
import type { World } from "../../../../../engine/core/World";
import { PICK_ORDER, type BabylonFeature, type BabylonFeatureFactory, type DrawnDescription, type DrawnNode } from "../../../../../engine/render/babylon/feature";
import { BabylonSkinnedMeshes, type BabylonSkinnedMesh } from "../../../../../engine/render/babylon/skinnedMeshes";
import { SkinnedMeshRenderer } from "../../components/SkinnedMeshRenderer";
import { SkinningSync } from "./sync";

type Casters = Parameters<NonNullable<BabylonFeature["casters"]>>[0];

/** The feature: the sync, plus the hooks the renderer asks (casters, drawn, loaded, describe). */
class SkinningFeature implements BabylonFeature {
  constructor(private readonly skinning: SkinningSync<BabylonSkinnedMesh>) {}

  sync(world: World): void {
    this.skinning.sync(world);
  }

  release(c: Component): void {
    if (c instanceof SkinnedMeshRenderer) this.skinning.release(c);
  }

  casters(out: Casters): void {
    for (const r of this.skinning.renderers()) if (r.visible && r.renderer.castShadows) out.push(...r.meshes);
  }

  *drawn(): Iterable<DrawnNode> {
    for (const r of this.skinning.renderers()) if (r.visible) yield { component: r.renderer, shape: { kind: "meshes", meshes: r.meshes }, order: PICK_ORDER.depthTested };
  }

  describe(drawn: object): DrawnDescription | null {
    for (const r of this.skinning.renderers()) if (r.meshes.includes(drawn as BabylonSkinnedMesh)) return { node: r.renderer.node, what: `"${r.renderer.node.name}" (skinned)` };
    return null;
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
