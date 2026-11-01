// Editor keyboard shortcuts. Text fields keep their own keys (and undo), so shortcuts skip them.
import { deleteSelected } from "./deleteSelection";
import { save, togglePlaying } from "./session";
import { openScene, pickTool, snapping, type Tool } from "./state";

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button", "color", "range"].includes(el.type);
}

export type Shortcut = "undo" | "redo" | "back" | "forward" | "save" | "play" | "delete" | `tool:${Tool}`;

const TOOL_KEYS: Record<string, Tool> = { q: "select", w: "move", e: "rotate", r: "scale" };

/** What a keydown means to the editor, if anything. Exported for tests. */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey"> & { altKey?: boolean; code?: string }): Shortcut | null {
  const key = e.key.toLowerCase();
  // Ctrl/Cmd + Alt (+ Shift) + Z: step through history in creation order (Vim's g- / g+). Checked
  // before plain Ctrl + Z, and by key code too, since Alt changes `key` on some layouts.
  if ((e.ctrlKey || e.metaKey) && e.altKey && (key === "z" || e.code === "KeyZ")) return e.shiftKey ? "forward" : "back";
  if (e.ctrlKey || e.metaKey) {
    if (key === "z") return e.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
    if (key === "s") return "save";
    if (key === "p") return "play";
    return null;
  }
  if (!e.shiftKey && !e.altKey && (key === "delete" || key === "backspace")) return "delete";
  if (!e.shiftKey && !e.altKey && TOOL_KEYS[key]) return `tool:${TOOL_KEYS[key]}`;
  return null;
}

/**
 * Delete or Backspace deletes the selected node; Ctrl/Cmd + P plays or stops; Ctrl/Cmd + S saves; Ctrl/Cmd + Z undoes; Ctrl/Cmd + Shift + Z or Ctrl + Y redoes; Ctrl/Cmd + Alt + Z / + Shift step back / forward through history in creation order; Q/W/E/R pick the select, move,
 * rotate and scale tools; holding Ctrl/Cmd snaps gizmo drags. Returns a function that removes
 * the listeners.
 */
export function installShortcuts(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") snapping.value = true;
    const action = shortcutFor(e);
    if (action === "play") {
      e.preventDefault(); // not the browser's print dialog
      togglePlaying();
      return;
    }
    if (action === "save") {
      // Works while typing too: blurring the field commits its edit before the save.
      e.preventDefault();
      if (isEditable(e.target)) (e.target as HTMLElement).blur();
      void save();
      return;
    }
    if (!action || isEditable(e.target)) return;
    if (action === "delete") {
      if (document.querySelector(".dialog")) return; // a dialog is open
      e.preventDefault();
      void deleteSelected();
      return;
    }
    if (action.startsWith("tool:")) {
      pickTool(action.slice(5) as Tool);
      return;
    }
    const stack = openScene.value?.stack;
    if (!stack) return;
    e.preventDefault();
    if (action === "undo") stack.undo();
    else if (action === "redo") stack.redo();
    else if (action === "back") stack.back();
    else if (action === "forward") stack.forward();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") snapping.value = false;
  };
  const onBlur = () => (snapping.value = false);
  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("keyup", onKeyUp);
    target.removeEventListener("blur", onBlur);
  };
}
