// Hierarchy commands on the selection (ADR 0022): create, copy, cut, paste and duplicate nodes,
// for the shortcuts and the Hierarchy's menus. Each edit is one undo step and selects its result;
// problems go to the status bar. The clipboard is in memory, so it survives switching scenes and
// pastes into any of them; copies also go on the system clipboard as JSON.
import { signal } from "@preact/signals";
import { errorStatus } from "./messages";
import { createNode, type NewNodeKind } from "./nodeCreate";
import {
  clipboardText,
  copyNodes,
  cutNodes,
  duplicateNodes,
  pasteNodes,
  pasteTarget,
  whyNotCopyable,
  whyNotPastable,
  type NodeClipboard,
  type PasteTarget,
} from "./nodeClipboard";
import { openScene, playState, sceneCamera, select, selectedKeys, selection, status, viewMode, type OpenScene } from "./state";

/** The copied nodes, or null. */
export const nodeClipboard = signal<NodeClipboard | null>(null);

/** The open scene if its structure can be edited now; otherwise says why in the status bar. */
function editableScene(what: string): OpenScene | null {
  const scene = openScene.value;
  if (!scene) return null;
  if (playState.value !== "edit") {
    status.value = { kind: "info", text: `Stop playing to ${what}.` };
    return null;
  }
  return scene;
}

/** Put the clipboard on the system clipboard too (best effort: it may be unavailable). */
function toSystemClipboard(clip: NodeClipboard): void {
  try {
    void globalThis.navigator?.clipboard?.writeText(clipboardText(clip)).catch(() => {});
  } catch {
    // no system clipboard: the editor's own still works
  }
}

const count = (n: number) => (n === 1 ? "1 node" : `${n} nodes`);

/** Copy the selected nodes (with their children). Returns true if anything was copied. */
export function copySelection(): boolean {
  const scene = openScene.value;
  if (!scene) return false;
  const keys = selectedKeys.value;
  const reason = whyNotCopyable(scene.doc, keys);
  if (reason) {
    status.value = { kind: "info", text: `Can't copy: ${reason}.` };
    return false;
  }
  const clip = copyNodes(scene.doc, keys);
  nodeClipboard.value = clip;
  toSystemClipboard(clip);
  status.value = { kind: "info", text: `Copied ${count(clip.subtrees.length)}.` };
  return true;
}

/** Cut the selected nodes: copy them, then delete them (one undo step). */
export function cutSelection(): boolean {
  const scene = editableScene("cut nodes");
  if (!scene) return false;
  const keys = selectedKeys.value;
  const reason = whyNotCopyable(scene.doc, keys);
  if (reason) {
    status.value = { kind: "info", text: `Can't cut: ${reason}.` };
    return false;
  }
  try {
    const clip = cutNodes(scene, keys);
    nodeClipboard.value = clip;
    toSystemClipboard(clip);
    select([]);
    status.value = { kind: "info", text: `Cut ${count(clip.subtrees.length)}.` };
    return true;
  } catch (err) {
    status.value = errorStatus("Couldn't cut", err);
    return false;
  }
}

/** Why pasting with the current selection (into it with `asChild`) isn't possible, or null. */
export function whyNotPasteHere(asChild = false): string | null {
  return whyNotPasteAt(selection.value, asChild);
}

/** Why pasting relative to the row `key` (into it with `asChild`) isn't possible, or null. */
export function whyNotPasteAt(key: string | null, asChild = false): string | null {
  const scene = openScene.value;
  if (!scene) return "no scene open";
  if (asChild && !key) return "select a node to paste into";
  return whyNotPastable(scene.doc, nodeClipboard.value, pasteTarget(scene.doc, key, asChild).parent);
}

/**
 * Paste the clipboard after the active selected node (beside it), into it with `asChild`, or at
 * the end of the scene with nothing selected. Selects the pasted nodes.
 */
export function pasteClipboard(asChild = false): boolean {
  return pasteClipboardAt(selection.value, asChild);
}

/** `pasteClipboard` relative to the row `key` (null: the end of the scene) instead of the selection. */
export function pasteClipboardAt(key: string | null, asChild = false): boolean {
  const scene = editableScene("paste nodes");
  const clip = nodeClipboard.value;
  if (!scene) return false;
  const reason = whyNotPasteAt(key, asChild);
  if (reason || !clip) {
    status.value = { kind: "info", text: `Can't paste: ${reason ?? "nothing copied"}.` };
    return false;
  }
  return pasteAt(scene, clip, pasteTarget(scene.doc, key, asChild));
}

function pasteAt(scene: OpenScene, clip: NodeClipboard, target: PasteTarget): boolean {
  try {
    const made = pasteNodes(scene, clip, target);
    select(made);
    status.value = { kind: "info", text: `Pasted ${count(made.length)}.` };
    return true;
  } catch (err) {
    status.value = errorStatus("Couldn't paste", err);
    return false;
  }
}

/** Duplicate the selected nodes, each right after itself, and select the copies. */
export function duplicateSelection(): boolean {
  const scene = editableScene("duplicate nodes");
  if (!scene) return false;
  const keys = selectedKeys.value;
  const reason = whyNotCopyable(scene.doc, keys);
  if (reason) {
    status.value = { kind: "info", text: `Can't duplicate: ${reason}.` };
    return false;
  }
  try {
    const made = duplicateNodes(scene, keys);
    select(made);
    status.value = { kind: "info", text: `Duplicated ${count(made.length)}.` };
    return true;
  } catch (err) {
    status.value = errorStatus("Couldn't duplicate", err);
    return false;
  }
}

/** Where top-level nodes appear: the scene camera's focus point (on the sprite plane in 2D). */
function focusPosition(): [number, number, number] {
  const p = sceneCamera.value?.focusPoint;
  if (!p) return [0, 0, 0];
  return [p.x, p.y, viewMode.value === "2d" ? 0 : p.z];
}

/**
 * Create a node of `kind` under `parent` (null: the top level, at the scene view's focus point)
 * at `index` among its children (undefined: last), and select it.
 */
export function createNodeIn(kind: NewNodeKind, parent: string | null, index?: number): string | null {
  const scene = editableScene("add nodes");
  if (!scene) return null;
  try {
    const id = createNode(scene, kind, { parent, index, position: parent === null ? focusPosition() : [0, 0, 0] });
    select([id]);
    status.value = null;
    return id;
  } catch (err) {
    status.value = errorStatus("Couldn't create the node", err);
    return null;
  }
}
