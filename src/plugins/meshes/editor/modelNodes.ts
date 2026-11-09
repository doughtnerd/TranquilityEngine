// What adding a model to a scene makes (ADR 0044, 0118): the Meshes plugin's `addToScene` policy for
// the `model` asset kind. Moved from the shell's asset browser (ADR 0147).
import { composeMatrix, localPoseFromMatrix } from "../../../engine/render/gizmoMath";
import { modelTreeIfLoaded, type NodePose } from "../../../engine/scene/models";
import { editor, type NodeEntry, type SceneDocument } from "../../../editor/sdk";

type Vec3 = readonly [number, number, number];
const { fileName } = editor.assets;
const { idBase, uniqueId } = editor.scene;

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
 */
export function modelNodeEntries(doc: SceneDocument, modelPath: string, position: Vec3 = [0, 0, 0]): NodeEntry[] {
  const name = fileName(modelPath).replace(/\.[^.]+$/, "");
  const id = uniqueId(doc, idBase(modelPath));
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  const tree = modelTreeIfLoaded(modelPath);
  const meshes = tree?.meshes ?? [];
  const extras = (tree?.nodes ?? []).filter((n) => n.light || n.camera);
  if (meshes.length <= 1 && !extras.length) {
    return [{ id, name: title, components: [{ type: "engine.Transform", data: { position: [...position] } }, { type: "engine.MeshRenderer", data: { mesh: `asset:${modelPath}` } }] }];
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
  const taken = new Set([id]);
  const childId = (label: string) => {
    let child = uniqueId(doc, `${id}-${idBase(`${label}.x`)}`);
    for (let n = 2; taken.has(child); n++) child = uniqueId(doc, `${id}-${idBase(`${label}.x`)}-${n}`);
    taken.add(child);
    return child;
  };
  const entries: NodeEntry[] = [{ id, name: title, components: [{ type: "engine.Transform", data: { position: [...position] } }] }];
  /** Each kept node's model-space matrix (null: the model's origin), to give children their local pose. */
  const matrices = new Map<string, Float64Array | null>([[id, null]]);
  const byKey = new Map<string, NodeEntry>();
  const keyOf = (segments: readonly string[]) => segments.join("/");
  const transformData = (parent: string, pose: NodePose | undefined, own: string): Record<string, unknown> => {
    const matrix = pose ? composeMatrix(vec(pose.position), quat(pose.rotation), vec(pose.scale)) : null;
    matrices.set(own, matrix);
    if (!matrix) return {};
    const local = localPoseFromMatrix(matrices.get(parent) ?? null, matrix);
    const data: Record<string, unknown> = {};
    if (local.position.some((v) => v !== 0)) data.position = local.position;
    if (local.rotation.some((v) => v !== 0)) data.rotation = local.rotation;
    if (local.scale.some((v) => v !== 1)) data.scale = local.scale;
    return data;
  };
  const group = (segments: readonly string[], fullPath: readonly string[]): string => {
    if (!segments.length) return id;
    const key = keyOf(segments);
    const have = byKey.get(key);
    if (have) return have.id;
    const parent = group(segments.slice(0, -1), fullPath.slice(0, -1));
    const label = segments[segments.length - 1];
    const own = childId(label);
    // A mesh's own node may be made here, before its mesh comes (it's the parent of the nodes under it); the mesh fills it in.
    const pose = nodePivots ? groupPoses.get(keyOf(fullPath)) : undefined;
    const entry: NodeEntry = { id: own, name: label, parent, components: [{ type: "engine.Transform", data: transformData(parent, pose, own) }] };
    byKey.set(key, entry);
    entries.push(entry);
    return entry.id;
  };
  for (const mesh of meshes) {
    const full = [...mesh.path, mesh.name];
    const segments = full.slice(shared);
    const renderer = { type: "engine.MeshRenderer", data: { mesh: `asset:${modelPath}#${mesh.name}` } };
    const existing = byKey.get(keyOf(segments));
    if (existing && !existing.components!.some((c) => c.type === "engine.MeshRenderer")) {
      existing.components!.push(renderer);
      continue;
    }
    const parent = group(segments.slice(0, -1), full.slice(0, -1));
    const own = childId(mesh.name);
    const entry: NodeEntry = { id: own, name: mesh.name, parent, components: [{ type: "engine.Transform", data: transformData(parent, nodePivots ? mesh.pose : undefined, own) }, renderer] };
    if (!existing) byKey.set(keyOf(segments), entry);
    entries.push(entry);
  }
  for (const node of extras) {
    const full = [...node.path, node.name];
    const parent = group(full.slice(shared, -1), full.slice(0, -1));
    const own = childId(node.name);
    const components: NonNullable<NodeEntry["components"]> = [{ type: "engine.Transform", data: transformData(parent, node.pose, own) }];
    if (node.light) {
      const l = node.light;
      const hex = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
      const data: Record<string, unknown> = { type: l.type, color: `#${hex(l.color[0])}${hex(l.color[1])}${hex(l.color[2])}`, intensity: l.intensity };
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
    entries.push({ id: own, name: node.name, parent, components });
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
