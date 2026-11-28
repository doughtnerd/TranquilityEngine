// The Inspector section under an `LODGroup` (ADR 0446 §7, ADR 0131): the LOD bar. Dragging a divider writes `levels`
// as one undo step (ADR 0026, through the field edits every Inspector field uses); the first drag of an automatic group
// writes the automatic heights out, and "Reset to automatic" writes `[]` again.
import { useEffect, useState } from "preact/hooks";
import { LODGroup } from "../../../engine/render/components";
import { automaticHeights, type MeshLevelErrors } from "../../../engine/render/visibility/select";
import { lodMemberTypes } from "../../../engine/render/visibility/lodMember";
import type { ModelMesh } from "../../../engine/scene/models";
import type { GameObject } from "../../../engine/scene/GameObject";
import { whyNotEdit } from "../../editGate";
import { setField } from "../../fieldEdits";
import { LodBar } from "./LodBar";
import { heightsToEdit, levelTriangles, MAX_LEVELS, type MeshTriangles } from "./lodBarLogic";
import { sectionField, type InspectorSectionProps } from "../inspectorSections";

/** The LOD0 model meshes of every renderer the group controls: its node's subtree, stopping at a nested LODGroup. Null while a model loads. */
function groupMeshes(root: GameObject): ModelMesh[] | null {
  const meshes: ModelMesh[] = [];
  let loading = false;
  const visit = (node: GameObject, top: boolean) => {
    // An undo can destroy the node between the section's polls: a dead node has no members.
    if (!node.isValid) return;
    if (!top && node.getBehavior(LODGroup)) return;
    for (const type of lodMemberTypes()) {
      const member = node.getBehavior(type as unknown as new () => InstanceType<typeof LODGroup>) as unknown as { lodMeshes(): readonly ModelMesh[] | null } | null;
      if (!member) continue;
      const m = member.lodMeshes();
      if (m) meshes.push(...m);
      else loading = true;
    }
    for (const child of node.children) visit(child, false);
  };
  if (!root.isValid) return null;
  visit(root, true);
  return loading && meshes.length === 0 ? null : meshes;
}

const trianglesOf = (m: ModelMesh): MeshTriangles => ({ levels: m.lods ? m.lods.levels.map((l) => l.triangles) : [m.data.indices.length / 3] });

export function LodGroupSection({ scene, paths, info }: InspectorSectionProps) {
  const node = scene.sync.nodeFor(paths[0]);
  const [meshes, setMeshes] = useState<ModelMesh[] | null>(() => (node ? groupMeshes(node) : null));
  // The members' models load after the scene does: look again until they have.
  useEffect(() => {
    if (!node) return;
    const look = () => setMeshes(groupMeshes(node));
    look();
    const timer = setInterval(look, 750);
    return () => clearInterval(timer);
  }, [node]);

  const levelsField = info.fields.find((f) => f.name === "levels");
  const levels = (sectionField(info, "levels") as number[] | undefined) ?? [];
  const forceLevel = Number(sectionField(info, "forceLevel") ?? -1);
  const withLods = (meshes ?? []).filter((m) => m.lods);
  const automatic = automaticHeights(withLods.map((m) => m.lods as MeshLevelErrors));
  const heights = levels.length > 0 ? levels : automatic;
  const triangles = heights.map((_, i) => (meshes === null ? null : levelTriangles((meshes ?? []).map(trianglesOf), i)));
  const readOnly = whyNotEdit({ kind: "scene", scene });
  const write = (value: number[]) => {
    if (levelsField) setField(scene, paths, info, levelsField, value.slice(0, MAX_LEVELS));
  };
  return (
    <LodBar
      heights={heights}
      automatic={levels.length === 0}
      triangles={triangles}
      forceLevel={Number.isFinite(forceLevel) ? forceLevel : -1}
      readOnly={readOnly}
      editable={heightsToEdit(levels, automatic) !== null}
      onCommit={write}
      onReset={() => write([])}
    />
  );
}
