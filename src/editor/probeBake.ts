// Baking a ReflectionProbe from the Inspector (ADR 0110): capture the probe in the editor's World,
// write the prefiltered `.env` next to the scene, then point the probe at it through an undoable edit.
import { ReflectionProbe } from "../engine";
import type { RenderSurface } from "../engine/render/RenderSurface";
import type { GameObject } from "../engine/scene/GameObject";
import { freePath } from "./assetOps";
import { SetField } from "./document";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { status, type OpenScene } from "./state";

export const REFLECTION_PROBE = "engine.ReflectionProbe";

const assetPathOf = (ref: unknown) => (typeof ref === "string" ? ref.replace(/^asset:/, "").replace(/^\.?\//, "") : "");

/** The scene file's name without its folder and `.scene.json`/`.prefab.json`. */
const sceneBase = (scenePath: string) => (scenePath.split("/").pop() ?? scenePath).replace(/\.(scene|prefab)\.json$/i, "").replace(/\.[^.]*$/, "");

/** A file-name-safe version of a node name. */
const safe = (s: string) => s.replace(/[\\/:*?"<>|#]+/g, "-").trim() || "probe";

/** Where a probe's bake goes: the file its `bakedMap` already names (overwritten), else a free `<scene folder>/probes/<scene>-<node>.env`. */
export function probeBakePath(project: EditorProject, scenePath: string, nodeName: string, bakedMap: unknown): string {
  const current = assetPathOf(bakedMap);
  if (current && /\.env$/i.test(current)) return current;
  const slash = scenePath.lastIndexOf("/");
  const folder = slash >= 0 ? `${scenePath.slice(0, slash)}/probes` : "probes";
  return freePath(project, folder, `${safe(sceneBase(scenePath))}-${safe(nodeName)}.env`);
}

export interface ProbeBakeDeps {
  project: EditorProject;
  scenePath: string;
  surface: Pick<RenderSurface, "bakeReflectionProbe">;
  node: GameObject;
  /** Called with the new field edits (the scene's undoable stack in the editor). */
  execute: (command: SetField) => void;
  hasNode: (id: string) => boolean;
  nodeId: string;
}

/** Bake, write, then set `bakedMap` and `refresh`. Returns the written path; throws if the bake or write fails (nothing is edited then). */
export async function bakeProbe(d: ProbeBakeDeps): Promise<string> {
  if (!d.project.canSave) throw new Error(`${d.project.name} is read-only: open a project folder to bake.`);
  const probe = d.node.getComponent(ReflectionProbe);
  if (!probe) throw new Error(`${d.node.name} has no ReflectionProbe.`);
  const path = probeBakePath(d.project, d.scenePath, d.node.name, probe.bakedMap);
  const bytes = await d.surface.bakeReflectionProbe(probe);
  await d.project.writeBinary(path, new Uint8Array(bytes));
  if (d.hasNode(d.nodeId)) {
    if (assetPathOf(probe.bakedMap) !== path) d.execute(new SetField(d.nodeId, REFLECTION_PROBE, "bakedMap", `asset:${path}`));
    if (probe.refresh !== "baked") d.execute(new SetField(d.nodeId, REFLECTION_PROBE, "refresh", "baked"));
  }
  return path;
}

/** The Inspector's Bake button: the live probe is the component on the editor World's node for the document node. */
export async function bakeOpenSceneProbe(scene: OpenScene, nodeId: string, project: EditorProject): Promise<void> {
  const node = scene.sync.nodeFor([nodeId]);
  if (!node) return;
  try {
    const surface = scene.sync.world.render;
    if (!surface) throw new Error("The editor has no renderer to capture with.");
    const path = await bakeProbe({
      project, scenePath: scene.path, surface, node, nodeId,
      execute: (c) => scene.stack.execute(c), hasNode: (id) => scene.doc.has(id),
    });
    status.value = { kind: "info", text: `Baked ${node.name}: ${path}.` };
  } catch (err) {
    status.value = errorStatus(`Couldn't bake ${node.name}`, err);
    throw err;
  }
}
