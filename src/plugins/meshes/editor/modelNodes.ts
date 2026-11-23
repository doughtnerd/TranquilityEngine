// What adding a model to a scene makes (ADR 0044, 0118): the Meshes plugin's `addToScene` policy for
// the `model` asset kind. Moved from the shell's asset browser (ADR 0147).
import { Color } from "../../../engine/core/math";
import { composeMatrix, localPoseFromMatrix } from "../../../engine/render/gizmoMath";
import { loadModel, meshesIfLoaded, modelTreeIfLoaded, type ModelData, type NodePose } from "../../../engine/scene/models";
import type { NodeEntry, NodeTemplate } from "../../../editor/sdk";
import type { ContributionPoint } from "../../runtimeContext";

type Vec3 = readonly [number, number, number];

/**
 * A model's node (ADR 0044): a Transform at `position` and a MeshRenderer drawing the whole
 * model; for a model of several meshes (or with lights or cameras, ADR 0118), an empty node with
 * the file's node tree under it instead (each mesh's node draws `#mesh`), so parts can be hidden,
 * given their own material or a collider. The root comes first. Until the model has loaded (see
 * `prepareAssets`), it's one node drawing the whole model.
 *
 * Poses (ADR 0118): with the model's `pivots` import setting at "model", meshes and group nodes sit
 * at their parent's origin (meshes are in model space); at "node", every node gets its own pose from
 * the file (and `#mesh` is in its node's space). Lights and cameras always get their pose. A
 * camera's Camera component arrives turned off, so a dropped model never takes over the view.
 *
 * Templates (ADR 0246): the node insertion names the root after the file and mints every id; a part's parent is
 * its index in the list.
 */
export function modelNodeTemplates(modelPath: string, position: Vec3 = [0, 0, 0]): NodeTemplate[] {
  const entries = baseTemplates(modelPath, position);
  const model = loaded.get(modelPath);
  // Augments read the model `prepareModelNodes` loaded, while it is still the one drawn (not replaced by a reimport).
  if (!model || meshesIfLoaded(modelPath) !== model.meshes) return entries;
  return augments.reduce((list, a) => a.augment(modelPath, list, model), entries);
}

// ------------------------------------------------------------------------------------------------ augments (ADR 0373)

/**
 * What another plugin's editor half adds to a dropped model's node templates (ADR 0373: the Animation plugin gives a
 * skinned model a Skeleton, SkinnedMeshRenderers and an Animator). Augments run in registration order on the templates
 * `modelNodeTemplates` built, all within the drop's one undo step.
 */
export interface ModelNodeAugment {
  readonly id: string;
  /** Load what `augment` reads besides the model, while the drop prepares (never rejects). */
  prepare?(path: string): Promise<void>;
  /** The templates to add for the model at `path` (`templates[0]` the root), given the loaded model. Return a new list or `templates` itself. */
  augment(path: string, templates: NodeTemplate[], model: ModelData): NodeTemplate[];
}

const augments: ModelNodeAugment[] = [];
/** Each model the drop prepared, by path: what augments read (the model cache answers only meshes synchronously). */
const loaded = new Map<string, ModelData>();

/**
 * The contribution point for model-drop augments (ADR 0137's owner-exported point), contributed to through
 * `EditorPluginContext.contribute`, so deactivating the contributing plugin removes its augment.
 */
export const modelNodeAugments: ContributionPoint<ModelNodeAugment> = {
  id: "myco.meshes.modelNodes",
  register(value) {
    augments.push(value);
    return () => {
      const at = augments.indexOf(value);
      if (at >= 0) augments.splice(at, 1);
    };
  },
};

/** The model kind's `addToScene.prepare`: load the model (and what augments read) before `modelNodeTemplates` runs. Never rejects. */
export async function prepareModelNodes(path: string): Promise<void> {
  const [model] = await Promise.all([loadModel(path).catch(() => null), ...augments.map((a) => a.prepare?.(path).catch(() => undefined))]);
  if (model) loaded.set(path, model);
  else loaded.delete(path);
}

/** The model's own templates (its node tree), before augments. */
function baseTemplates(modelPath: string, position: Vec3): NodeTemplate[] {
  const tree = modelTreeIfLoaded(modelPath);
  const meshes = tree?.meshes ?? [];
  const extras = (tree?.nodes ?? []).filter((n) => n.light || n.camera);
  if (meshes.length <= 1 && !extras.length) {
    return [{ components: [{ type: "engine.Transform", data: { position: [...position] } }, { type: "engine.MeshRenderer", data: { mesh: `asset:${modelPath}` } }] }];
  }
  const nodePivots = tree!.pivots === "node";
  // The file's node tree (ADR 0088), less the levels every node shares. A mesh's node is the parent of the nodes under it.
  const allPaths = [...meshes.map((m) => m.path), ...extras.map((n) => n.path)];
  let shared = allPaths[0].length;
  for (const path of allPaths) {
    let i = 0;
    while (i < shared && i < path.length && path[i] === allPaths[0][i]) i++;
    shared = i;
  }
  const groupPoses = new Map((tree?.nodes ?? []).filter((n) => !n.light && !n.camera).map((n) => [[...n.path, n.name].join("/"), n.pose]));
  const entries: NodeTemplate[] = [{ components: [{ type: "engine.Transform", data: { position: [...position] } }] }];
  /** Each kept node's model-space matrix (null: the model's origin), by index, to give children their local pose. */
  const matrices = new Map<number, Float64Array | null>([[0, null]]);
  /** The index of each group's or mesh's template, by its path. */
  const byKey = new Map<string, number>();
  const keyOf = (segments: readonly string[]) => segments.join("/");
  const transformData = (parent: number, pose: NodePose | undefined, own: number): Record<string, unknown> => {
    const matrix = pose ? composeMatrix(vec(pose.position), quat(pose.rotation), vec(pose.scale)) : null;
    matrices.set(own, matrix);
    if (!matrix) return {};
    const local = localPoseFromMatrix(matrices.get(parent) ?? null, matrix);
    const data: Record<string, unknown> = {};
    if (local.position.some((v) => v !== 0)) data.position = local.position;
    if (local.rotation[3] !== 1) data.rotation = local.rotation;
    if (local.scale.some((v) => v !== 1)) data.scale = local.scale;
    return data;
  };
  const group = (segments: readonly string[], fullPath: readonly string[]): number => {
    if (!segments.length) return 0;
    const key = keyOf(segments);
    const have = byKey.get(key);
    if (have !== undefined) return have;
    const parent = group(segments.slice(0, -1), fullPath.slice(0, -1));
    const label = segments[segments.length - 1];
    const own = entries.length;
    // A mesh's own node may be made here, before its mesh comes (it's the parent of the nodes under it); the mesh fills it in.
    const pose = nodePivots ? groupPoses.get(keyOf(fullPath)) : undefined;
    entries.push({ name: label, parent, components: [{ type: "engine.Transform", data: transformData(parent, pose, own) }] });
    byKey.set(key, own);
    return own;
  };
  for (const mesh of meshes) {
    const full = [...mesh.path, mesh.name];
    const segments = full.slice(shared);
    const renderer = { type: "engine.MeshRenderer", data: { mesh: `asset:${modelPath}#${mesh.name}` } };
    const at = byKey.get(keyOf(segments));
    const existing = at === undefined ? undefined : entries[at];
    if (existing && !existing.components!.some((c) => c.type === "engine.MeshRenderer")) {
      existing.components!.push(renderer);
      continue;
    }
    const parent = group(segments.slice(0, -1), full.slice(0, -1));
    const own = entries.length;
    entries.push({ name: mesh.name, parent, components: [{ type: "engine.Transform", data: transformData(parent, nodePivots ? mesh.pose : undefined, own) }, renderer] });
    if (!existing) byKey.set(keyOf(segments), own);
  }
  for (const node of extras) {
    const full = [...node.path, node.name];
    const parent = group(full.slice(shared, -1), full.slice(0, -1));
    const own = entries.length;
    const components: NonNullable<NodeEntry["components"]> = [{ type: "engine.Transform", data: transformData(parent, node.pose, own) }];
    if (node.light) {
      const l = node.light;
      const data: Record<string, unknown> = { type: l.type, color: new Color(l.color[0], l.color[1], l.color[2]).toHex(), intensity: l.intensity };
      if (l.type !== "directional") data.range = l.range;
      if (l.type === "spot") {
        data.spotAngle = Math.round(l.spotAngle * 1e4) / 1e4;
        data.spotSoftness = Math.round(l.spotSoftness * 1e4) / 1e4;
      }
      components.push({ type: "engine.Light", data });
    }
    if (node.camera) {
      const c = node.camera;
      const data: Record<string, unknown> = { projection: c.projection, near: c.near, far: c.far };
      if (c.projection === "perspective") data.fieldOfView = Math.round(c.fieldOfView * 1e4) / 1e4;
      else data.orthographicSize = c.orthographicSize;
      components.push({ type: "engine.Camera", enabled: false, data });
    }
    entries.push({ name: node.name, parent, components });
  }
  return entries;
}

/**
 * The note after adding a model (ADR 0118, 0149; the `model` kind's `addToScene.note`): its cameras
 * arrive with the Camera component turned off, so say so and how to look through one. Null when it has none.
 */
export function disabledCamerasNote(entries: readonly NodeEntry[]): string | null {
  const cameras = entries.filter((e) => e.components?.some((c) => c.type === "engine.Camera" && c.enabled === false)).length;
  if (!cameras) return null;
  return `its ${cameras === 1 ? "camera was" : `${cameras} cameras were`} added with the Camera component turned off, so it doesn't take over the view; enable it to look through it.`;
}

const vec =(v: readonly number[]) => ({ x: v[0], y: v[1], z: v[2] });
const quat = (q: readonly number[]) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
