// Editor keyboard shortcuts. Text fields keep their own keys (and undo), so shortcuts skip them.
import { deleteSelected } from "./deleteSelection";
import { copySelection, cutSelection, duplicateSelection, pasteClipboard } from "./hierarchyActions";
import { save, togglePlaying } from "./session";
import { stepFrame, togglePause } from "./playDebug";
import { openScene, pickTool, snapping, type Tool } from "./state";

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button", "color", "range"].includes(el.type);
}

export type Shortcut = "undo" | "redo" | "back" | "forward" | "save" | "play" | "pause" | "step" | "delete" | "copy" | "cut" | "paste" | "paste-child" | "duplicate" | `tool:${Tool}`;

/** Node clipboard shortcuts: the Assets panel and text fields keep their own Ctrl/Cmd+C/X/V/D. */
const CLIPBOARD_SHORTCUTS: readonly Shortcut[] = ["copy", "cut", "paste", "paste-child", "duplicate"];

const TOOL_KEYS: Record<string, Tool> = { q: "select", w: "move", e: "rotate", r: "scale" };

/** What a keydown means to the editor, if anything. Exported for tests. */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey"> & { altKey?: boolean; code?: string }): Shortcut | null {
  const key = e.key.toLowerCase();
  // Ctrl/Cmd + Alt (+ Shift) + Z: step through history in creation order (Vim's g- / g+). Checked
  // before plain Ctrl + Z, and by key code too, since Alt changes `key` on some layouts.
  if ((e.ctrlKey || e.metaKey) && e.altKey && (key === "z" || e.code === "KeyZ")) return e.shiftKey ? "forward" : "back";
  // Play mode debugging: Ctrl/Cmd + Shift + P pauses or resumes, F10 or Ctrl/Cmd + Alt + P steps one frame.
  if (key === "f10" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return "step";
  if ((e.ctrlKey || e.metaKey) && (key === "p" || e.code === "KeyP")) {
    if (e.altKey && !e.shiftKey) return "step";
    if (e.shiftKey && !e.altKey) return "pause";
  }
  if (e.ctrlKey || e.metaKey) {
    if (key === "z") return e.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
    if (key === "s") return "save";
    if (key === "p") return "play";
    if (e.altKey) return null;
    if (key === "c" && !e.shiftKey) return "copy";
    if (key === "x" && !e.shiftKey) return "cut";
    if (key === "v") return e.shiftKey ? "paste-child" : "paste";
    if (key === "d" && !e.shiftKey) return "duplicate";
    return null;
  }
  if (!e.shiftKey && !e.altKey && (key === "delete" || key === "backspace")) return "delete";
  if (!e.shiftKey && !e.altKey && TOOL_KEYS[key]) return `tool:${TOOL_KEYS[key]}`;
  return null;
}

/**
 * Ctrl/Cmd + C/X/V/D copy, cut, paste and duplicate the selected nodes (+ Shift + V pastes as a child);
 * Delete or Backspace deletes the selected node; Ctrl/Cmd + P plays or stops; Ctrl/Cmd + Shift + P pauses or resumes the game and F10 or Ctrl/Cmd + Alt + P steps it one frame; Ctrl/Cmd + S saves; Ctrl/Cmd + Z undoes; Ctrl/Cmd + Shift + Z or Ctrl + Y redoes; Ctrl/Cmd + Alt + Z / + Shift step back / forward through history in creation order; Q/W/E/R pick the select, move,
 * rotate and scale tools; holding Ctrl/Cmd snaps gizmo drags. Returns a function that removes
 * the listeners.
 */
export function installShortcuts(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") snapping.value = true;
    const action = shortcutFor(e);
    // The Code panel's editor has its own keys (Ctrl/Cmd+S saves the script, Ctrl/Cmd+Z undoes typing); only Play passes through.
    if (action !== "play" && (e.target as Element | null)?.closest?.(".monaco-editor")) return;
    if (action === "play") {
      e.preventDefault(); // not the browser's print dialog
      togglePlaying();
      return;
    }
    if (action === "pause" || action === "step") {
      e.preventDefault(); // not the browser's print dialog or menu bar
      if (action === "pause") togglePause();
      else stepFrame();
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
    if (CLIPBOARD_SHORTCUTS.includes(action)) {
      if ((e.target as Element | null)?.closest?.(".asset-browser, .dialog") || document.querySelector(".dialog")) return;
      e.preventDefault(); // Ctrl+D would bookmark the page
      if (action === "copy") copySelection();
      else if (action === "cut") cutSelection();
      else if (action === "paste" || action === "paste-child") pasteClipboard(action === "paste-child");
      else duplicateSelection();
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
