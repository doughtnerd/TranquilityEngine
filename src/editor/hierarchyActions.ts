// Hierarchy commands on the selection (ADR 0022): create, copy, cut, paste and duplicate nodes,
// for the shortcuts and the Hierarchy's menus. Each edit is one undo step and selects its result;
// problems go to the status bar, and whether the scene can be edited now is the edit gate's (ADR 0247). The clipboard is in memory, so it survives switching scenes and
// pastes into any of them; copies also go on the system clipboard as JSON, which a paste with a
// `paste` event reads back (ADR 0226), so nodes copied in another editor process paste here.
import { signal } from "@preact/signals";
import { clipboardForPaste, writeClipboard } from "./clipboard";
import { errorStatus } from "./messages";
import { kindAssetCreator, type NodeKind } from "./nodeKinds";
import { copyNodes, cutNodes, nodeClipboardFromText, nodeClipboardPayload, whyNotCopyable, type NodeClipboard } from "./nodeClipboard";
import { insertNodes, whyNotInsert, type InsertPlace } from "./nodeInsertion";
import { openScene, sceneCamera, selectedKeys, selection, status, viewMode } from "./state";
import { editableNow } from "./editGate";
import { select } from "./inspectorTarget";
import { duplicateUIElement } from "./uiDocumentEdits";
import { selectedUIRef } from "./uiDocuments";
import { selectedUIViewRef } from "./uiViews";
import { duplicateUIViewElement } from "./uiViewEdits";

/** The copied nodes, or null. */
export const nodeClipboard = signal<NodeClipboard | null>(null);

/** Put the clipboard on the system clipboard too (best effort: it may be unavailable). */
const toSystemClipboard = (clip: NodeClipboard) => writeClipboard(nodeClipboardPayload(clip));

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
  const scene = editableNow({ kind: "scene" }, "cut nodes");
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
  return whyNotPasteOf(nodeClipboard.value, key, asChild);
}

/** Where a paste relative to the row `key` goes: right after it, or into it with `asChild` (ADR 0246). */
const pastePlace = (key: string | null, asChild: boolean): InsertPlace => (asChild ? { kind: "into", key } : { kind: "after", key });

function whyNotPasteOf(clip: NodeClipboard | null, key: string | null, asChild: boolean): string | null {
  if (asChild && !key) return "select a node to paste into";
  return whyNotInsert(openScene.value, { kind: "copies", clipboard: clip }, pastePlace(key, asChild));
}

/**
 * Paste the clipboard after the active selected node (beside it), into it with `asChild`, or at
 * the end of the scene with nothing selected. Selects the pasted nodes.
 */
export function pasteClipboard(asChild = false): boolean {
  return pasteClipboardAt(selection.value, asChild);
}

/**
 * `pasteClipboard` for a paste with the system clipboard's `text` (a `paste` event's; null for
 * none): the nodes in it when it holds some this editor didn't write (copied in another editor
 * process since), which then become this editor's clipboard; else the clipboard in memory.
 */
export function pasteClipboardText(text: string | null, asChild = false): boolean {
  const clip = clipboardForPaste(text, nodeClipboard.peek(), nodeClipboardFromText);
  if (clip && clip !== nodeClipboard.peek()) nodeClipboard.value = clip;
  return pasteClipboardAt(selection.value, asChild);
}

/** `pasteClipboard` relative to the row `key` (null: the end of the scene) instead of the selection. */
export function pasteClipboardAt(key: string | null, asChild = false): boolean {
  const scene = editableNow({ kind: "scene" }, "paste nodes");
  if (!scene) return false;
  const reason = whyNotPasteOf(nodeClipboard.value, key, asChild);
  const made = reason ? null : insertNodes(scene, { kind: "copies", clipboard: nodeClipboard.value }, pastePlace(key, asChild));
  if (!made?.ok) {
    status.value = { kind: "info", text: `Can't paste: ${reason ?? (made && !made.ok ? made.reason : "nothing copied")}.` };
    return false;
  }
  select(made.keys);
  status.value = { kind: "info", text: `Pasted ${count(made.keys.length)}.` };
  return true;
}

/** Duplicate the selected nodes, each right after itself, and select the copies. */
export function duplicateSelection(): boolean {
  const ui = selectedUIRef();
  if (ui) return duplicateUIElement(ui); // a UI document's element (ADR 0077): in its markup file
  const viewEl = selectedUIViewRef();
  if (viewEl) return duplicateUIViewElement(viewEl); // an element a UIView rendered (ADR 0419 wave C): in its .svelte source
  const scene = editableNow({ kind: "scene" }, "duplicate nodes");
  if (!scene) return false;
  const keys = selectedKeys.value;
  const reason = whyNotCopyable(scene.doc, keys);
  if (reason) {
    status.value = { kind: "info", text: `Can't duplicate: ${reason}.` };
    return false;
  }
  const made = insertNodes(scene, { kind: "duplicate", keys });
  if (!made.ok) {
    status.value = { kind: "info", text: `Can't duplicate: ${made.reason}.` };
    return false;
  }
  select(made.keys);
  status.value = { kind: "info", text: `Duplicated ${count(made.keys.length)}.` };
  return true;
}

/** Where top-level nodes appear: the scene camera's focus point (on the sprite plane in 2D). */
function focusPosition(): [number, number, number] {
  const p = sceneCamera.value?.focusPoint;
  if (!p) return [0, 0, 0];
  return [p.x, p.y, viewMode.value === "2d" ? 0 : p.z];
}

/**
 * Create a node of `kind` at `place` (at the scene view's focus point when it lands at the top level) and select
 * it. A kind whose node uses a new asset (a Particle System's effect, a UI Document's markup; `kindAssetCreator`)
 * writes it first, then adds the node using it; a read-only project gets the node with none (the creator says why
 * in the status). `asset` given: the node uses it and nothing is written.
 */
export function createNodeAt(kind: NodeKind, place: InsertPlace, asset?: string): string | null {
  const scene = editableNow({ kind: "scene" }, "add nodes");
  if (!scene) return null;
  const writeFirst = asset === undefined ? kindAssetCreator(kind) : undefined;
  if (writeFirst) {
    void writeFirst().then((made) => {
      const note = status.peek();
      if (openScene.peek() !== scene) return;
      createNodeAt(kind, place, made ? `asset:${made}` : "");
      if (!made) status.value = note;
    });
    return null;
  }
  const made = insertNodes(scene, { kind: "new", node: kind, asset, position: focusPosition() }, place);
  if (!made.ok) {
    status.value = { kind: "info", text: `Can't create the node: ${made.reason}.` };
    return null;
  }
  select([...made.keys]);
  status.value = null;
  return made.keys[0]!;
}
