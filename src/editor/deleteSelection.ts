// Deleting the selected nodes from the open scene, asking first when other nodes reference them
// (unless the user chose not to be asked again).
import { deleteNodes, isInsidePrefab, describeReference, referencesInto, whyNotDeletable } from "./hierarchyEdit";
import { askBeforeClearingReferences } from "./preferences";
import { topmostKeys } from "./selectionModel";
import { removeInnerNode } from "./prefabs";
import { openScene, playState, selectedKeys, status } from "./state";
import { confirmInEditor } from "./ui/ConfirmDialog";
import { deleteUIElement } from "./uiDocumentEdits";
import { selectedUIRef } from "./uiDocuments";
import { select } from "./inspectorTarget";

/** Delete the selected nodes (and their children) as one undo step. Returns true if they were deleted. */
export async function deleteSelected(): Promise<boolean> {
  const ui = selectedUIRef();
  if (ui) return deleteUIElement(ui); // a UI document's element (ADR 0077): from its markup file
  const scene = openScene.value;
  if (!scene || selectedKeys.value.length === 0 || playState.value !== "edit") return false;
  const keys = topmostKeys(scene.doc, selectedKeys.value); // children go with their parents
  if (keys.length > 0 && keys.every(isInsidePrefab)) {
    // Nodes inside prefab instances go as `removeNode` overrides (ADR 0086).
    scene.stack.beginGroup(keys.length === 1 ? "Remove node" : `Remove ${keys.length} nodes`);
    try {
      for (const key of keys) removeInnerNode(scene, key.split("/"));
    } finally {
      scene.stack.endGroup();
    }
    select([]);
    status.value = { kind: "info", text: `Removed ${keys.length === 1 ? "the node" : `${keys.length} nodes`} from the prefab instance. Undo restores them.` };
    return true;
  }
  for (const key of keys) {
    const reason = whyNotDeletable(scene.doc, key);
    if (reason) {
      const what = keys.length === 1 ? "that" : key;
      status.value = { kind: "info", text: `Can't delete ${what}: ${reason}.` };
      return false;
    }
  }
  const name = keys.length === 1 ? (scene.doc.node(keys[0]).name ?? keys[0]) : `${keys.length} nodes`;
  const refs = referencesInto(scene.doc, keys);
  const labels = refs.map((r) => describeReference(scene.doc, r));
  if (refs.length > 0 && askBeforeClearingReferences.value) {
    const answer = await confirmInEditor({
      title: `Delete ${name}?`,
      message: `${refs.length === 1 ? "This reference" : `These ${refs.length} references`} to ${keys.length === 1 ? "it" : "them"} will be set to None. Undo restores them.`,
      items: labels,
      confirmLabel: "Delete",
      optionLabel: "Don't ask again",
    });
    if (!answer.ok) return false;
    if (answer.option) askBeforeClearingReferences.value = false;
  }
  // The scene may have changed while the dialog was open.
  if (openScene.value !== scene || !keys.every((k) => scene.doc.has(k))) return false;
  deleteNodes(scene, keys);
  select(selectedKeys.peek().filter((k) => scene.doc.has(k.split("/")[0])));
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
