// Dropping a skinned model (ADR 0373 "Drop behaviour"; T18): the Animation plugin's augment of the Meshes plugin's model
// node templates (`modelNodeAugments`). When the model's meshes carry a skin (D105: `ModelMesh.skin`, filled by the
// importer, T14), the root gets a `Skeleton` naming the model's skeleton (`model#Skeleton`) and an `Animator` playing
// the model's first clip on start (D94 `defaultClip`, `model#Anim/<name>`), and each skinned mesh's `MeshRenderer`
// becomes a `SkinnedMeshRenderer` (its Skeleton: the nearest ancestor's, the root). A model without skins is untouched.
// The templates are added by the drop's node insertion, so the whole drop stays one undo step.
import type { ComponentEntry, NodeTemplate } from "../../../../editor/sdk";
import type { SkinnedModelFields } from "../../../../engine/render/skinning/skinData";
import type { ModelData, ModelMesh } from "../../../../engine/scene/models";
import type { ModelNodeAugment } from "../../../meshes/editor/modelNodes";

/**
 * @internal What the importer (T14) adds to a loaded model for its clips: their names, in file order, each a sub-asset
 * `model.glb#Anim/<name>`. Absent until T14: a dropped skinned model then gets an Animator with no default clip.
 */
export interface ModelClipFields {
  readonly clips?: readonly string[];
}

/** The model's sub-asset references (ADR 0371): its skeleton and its clips. */
const skeletonRefOf = (path: string): string => `asset:${path}#Skeleton`;
const clipRefOf = (path: string, clip: string): string => `asset:${path}#Anim/${clip}`;
/** One mesh of a model pinned to model space (ADR 0118 `#model`): skinned draws live in the skeleton's model space (D104). */
const meshRefOf = (path: string, mesh: string): string => `asset:${path}#${mesh}#model`;

const hasSkin = (mesh: ModelMesh): boolean => !!(mesh as ModelMesh & SkinnedModelFields).skin;

/** The skinned mesh a MeshRenderer of the model draws, or null: `asset:<path>` (a one-mesh model) or `asset:<path>#<mesh>`. */
function skinnedMeshOf(ref: unknown, path: string, model: ModelData, skinned: ReadonlySet<ModelMesh>): ModelMesh | null {
  if (typeof ref !== "string") return null;
  const whole = `asset:${path}`;
  if (ref === whole) return model.meshes.length === 1 && skinned.has(model.meshes[0]!) ? model.meshes[0]! : null;
  if (!ref.startsWith(`${whole}#`)) return null;
  const name = ref.slice(whole.length + 1).replace(/#model$/, "");
  return [...skinned].find((m) => m.name === name) ?? null;
}

/** A MeshRenderer entry as the SkinnedMeshRenderer drawing the same mesh, keeping the fields both have. */
function asSkinned(renderer: ComponentEntry, ref: string): ComponentEntry {
  const data: Record<string, unknown> = { mesh: ref };
  for (const field of ["material", "materials", "castShadows", "receiveShadows"]) {
    if (renderer.data && field in renderer.data) data[field] = renderer.data[field];
  }
  return { ...(renderer.enabled === false ? { enabled: false } : {}), type: "engine.SkinnedMeshRenderer", data };
}

/**
 * The templates for the model at `path`, augmented for its skins (unchanged, the same list, when no mesh has one). Pure:
 * reads only `model`.
 */
export function augmentSkinnedModel(path: string, templates: NodeTemplate[], model: ModelData & ModelClipFields): NodeTemplate[] {
  const skinned = new Set(model.meshes.filter(hasSkin));
  if (skinned.size === 0 || templates.length === 0) return templates;
  const out = templates.map((t): NodeTemplate => {
    const components = t.components?.map((c) => {
      if (c.type !== "engine.MeshRenderer") return c;
      const mesh = skinnedMeshOf(c.data?.mesh, path, model, skinned);
      if (!mesh) return c;
      return asSkinned(c, model.meshes.length === 1 && c.data?.mesh === `asset:${path}` ? `asset:${path}` : meshRefOf(path, mesh.name));
    });
    return components ? { ...t, components } : t;
  });
  const root = out[0]!;
  const has = (type: string) => root.components?.some((c) => c.type === type) ?? false;
  const added: ComponentEntry[] = [];
  if (!has("engine.Skeleton")) added.push({ type: "engine.Skeleton", data: { skeleton: skeletonRefOf(path) } });
  if (!has("engine.Animator")) {
    const first = model.clips?.find((c) => typeof c === "string" && c !== "");
    added.push({ type: "engine.Animator", data: first ? { defaultClip: clipRefOf(path, first) } : {} });
  }
  out[0] = { ...root, components: [...(root.components ?? []), ...added] };
  return out;
}

/** @internal The augment the scene seam contributes to `modelNodeAugments`. */
export const skinnedModelAugment: ModelNodeAugment = {
  id: "myco.animation.skinnedModels",
  augment: augmentSkinnedModel,
};
