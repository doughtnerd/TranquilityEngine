// Renaming a physics or sorting layer from the Project panel, and the scenes that name it (ADR 0116).
// Shared by the panel (sorting layers) and the Physics plugin's section (physics layers).
import { errorStatus } from "./messages";
import { layerUsers, renameLayerReferences, type LayerKind, type LayerRename } from "./layerRename";
import { layersOf, renameLayer, renameSortingLayer, sortingLayersOf, type SettingsDraft } from "./projectSettingsModel";
import type { EditorProject } from "./projects";
import { docVersion, status } from "./state";
import { confirmInEditor } from "./ui/ConfirmDialog";

/** What a rename edits: the project, the panel's undo-step `set`, and `refresh` to put a field back to the old name. */
export interface LayerRenameContext {
  readonly project: EditorProject;
  set(label: string, next: SettingsDraft): void;
  refresh(): void;
}

export async function updateLayerReferences(project: EditorProject, renames: readonly LayerRename[]): Promise<void> {
  try {
    const done = await renameLayerReferences(project, renames);
    if (done.length > 0) {
      docVersion.value++;
      status.value = { kind: "info", text: `Updated layer references in ${done.length} file${done.length === 1 ? "" : "s"}.` };
    }
  } catch (err) {
    status.value = errorStatus("Couldn't update the scenes that use the renamed layer", err);
  }
}

/**
 * Rename a physics or sorting layer, and the colliders or sprites that name it (ADR 0116). With
 * references to update, ask first. The rename is one undo step of the panel; undoing it also
 * restores the old name in the scenes (the panel's `jump`).
 */
export async function renameLayerEdit(ctx: LayerRenameContext, kind: LayerKind, draft: SettingsDraft, index: number, name: string): Promise<void> {
  const names = kind === "physics" ? layersOf(draft) : sortingLayersOf(draft);
  const from = names[index];
  const next = kind === "physics" ? renameLayer(draft, index, name) : renameSortingLayer(draft, index, name);
  const label = kind === "physics" ? `Rename physics layer to ${name}` : `Rename sorting layer to ${name}`;
  const valid = from !== undefined && name !== "" && name !== from && !names.includes(name);
  const users = valid && ctx.project.canSave ? layerUsers(ctx.project, kind, from) : [];
  if (users.length > 0) {
    const answer = await confirmInEditor({
      title: `Rename ${kind} layer`,
      message: `Rename the ${kind} layer "${from}" to "${name}"? ${users.length === 1 ? "A scene or prefab names it" : `${users.length} scenes and prefabs name it`}; they will be updated.`,
      items: users.slice(0, 8).map((u) => u.replace(/ \(unsaved\)$/, "")).concat(users.length > 8 ? [`and ${users.length - 8} more`] : []),
      confirmLabel: "Rename and update",
      danger: false,
    });
    if (!answer.ok) {
      ctx.refresh(); // put the field back to the old name
      return;
    }
  }
  ctx.set(label, next);
  if (users.length > 0) await updateLayerReferences(ctx.project, [{ kind, from, to: name }]);
}
