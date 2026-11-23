// The Scene view's keys (the prototype's viewport keys, S:1525-1546), as one table the screen registers in the Studio's
// keymap for the Scene panel (`data-keyscope="spatial-scene"`): copy, paste and duplicate the selection, delete it,
// pan with the arrows (Shift: further), zoom with + and −, 0 to frame the scene again, Esc to step back (end path
// editing, then Select, then clear the selection). Undo and Redo are the Studio's own (the scene document's history).
// Space-drag pans with the pointer and isn't a binding.
//
// Pure: no DOM, no signals.
import type { ViewKey } from "./viewTransform";

export type SceneAction =
  | { readonly kind: "copy" }
  | { readonly kind: "paste" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "delete" }
  | { readonly kind: "view"; readonly key: ViewKey; readonly big: boolean }
  | { readonly kind: "reset" }
  | { readonly kind: "escape" };

export interface SceneKey {
  readonly id: string;
  readonly keys: readonly string[];
  readonly label: string;
  readonly action: SceneAction;
}

const view = (key: ViewKey, big = false): SceneAction => ({ kind: "view", key, big });

/** Every key of the Scene panel. */
export const SCENE_KEYS: readonly SceneKey[] = [
  { id: "spatial.copy", keys: ["Mod+C"], label: "Copy the selection", action: { kind: "copy" } },
  { id: "spatial.paste", keys: ["Mod+V"], label: "Paste (3 m along)", action: { kind: "paste" } },
  { id: "spatial.duplicate", keys: ["Mod+D"], label: "Duplicate the selection", action: { kind: "duplicate" } },
  { id: "spatial.delete", keys: ["Delete", "Backspace"], label: "Delete the selection", action: { kind: "delete" } },
  { id: "spatial.panLeft", keys: ["ArrowLeft"], label: "Pan left", action: view("panLeft") },
  { id: "spatial.panRight", keys: ["ArrowRight"], label: "Pan right", action: view("panRight") },
  { id: "spatial.panUp", keys: ["ArrowUp"], label: "Pan up", action: view("panUp") },
  { id: "spatial.panDown", keys: ["ArrowDown"], label: "Pan down", action: view("panDown") },
  { id: "spatial.panLeftBig", keys: ["Shift+ArrowLeft"], label: "Pan left further", action: view("panLeft", true) },
  { id: "spatial.panRightBig", keys: ["Shift+ArrowRight"], label: "Pan right further", action: view("panRight", true) },
  { id: "spatial.panUpBig", keys: ["Shift+ArrowUp"], label: "Pan up further", action: view("panUp", true) },
  { id: "spatial.panDownBig", keys: ["Shift+ArrowDown"], label: "Pan down further", action: view("panDown", true) },
  { id: "spatial.zoomIn", keys: ["+", "="], label: "Zoom in", action: view("zoomIn") },
  { id: "spatial.zoomOut", keys: ["-"], label: "Zoom out", action: view("zoomOut") },
  { id: "spatial.reset", keys: ["0"], label: "Frame the scene", action: { kind: "reset" } },
  { id: "spatial.escape", keys: ["Escape"], label: "End path editing, back to Select, clear the selection", action: { kind: "escape" } },
];
