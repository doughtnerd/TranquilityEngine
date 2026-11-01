// Deleting the selected node from the open scene, asking first when other nodes reference it
// (unless the user chose not to be asked again).
import { pathKey } from "./document";
import { deleteNode, describeReference, referencesInto, whyNotDeletable } from "./hierarchyEdit";
import { askBeforeClearingReferences } from "./preferences";
import { openScene, playState, selection, status } from "./state";
import { confirmInEditor } from "./ui/ConfirmDialog";

/** Delete the selected node (and its children). Returns true if it was deleted. */
export async function deleteSelected(): Promise<boolean> {
  const scene = openScene.value, key = selection.value;
  if (!scene || !key || playState.value !== "edit") return false;
  const reason = whyNotDeletable(scene.doc, key);
  if (reason) {
    status.value = { kind: "info", text: `Can't delete that: ${reason}.` };
    return false;
  }
  const name = scene.doc.node(key).name ?? key;
  const refs = referencesInto(scene.doc, key);
  const labels = refs.map((r) => describeReference(scene.doc, r));
  if (refs.length > 0 && askBeforeClearingReferences.value) {
    const answer = await confirmInEditor({
      title: `Delete ${name}?`,
      message: `${refs.length === 1 ? "This reference" : `These ${refs.length} references`} to it will be set to None. Undo restores them.`,
      items: labels,
      confirmLabel: "Delete",
      optionLabel: "Don't ask again",
    });
    if (!answer.ok) return false;
    if (answer.option) askBeforeClearingReferences.value = false;
  }
  // The scene may have changed while the dialog was open.
  if (openScene.value !== scene || !scene.doc.has(key)) return false;
  deleteNode(scene, key);
  if (selection.value === key || selection.value?.startsWith(`${pathKey([key])}/`)) selection.value = null;
  status.value =
    refs.length === 0
      ? { kind: "info", text: `Deleted ${name}.` }
      : {
          kind: "info",
          text: `Deleted ${name} and set ${refs.length === 1 ? "1 reference" : `${refs.length} references`} to None: ${labels.join("; ")}.`,
          ...(askBeforeClearingReferences.value
            ? {}
            : {
                action: {
                  label: "Ask before clearing references",
                  run: () => (askBeforeClearingReferences.value = true),
                  done: "You'll be asked before deleting a node clears references to it.",
                },
              }),
        };
  return true;
}
