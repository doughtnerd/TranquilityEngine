// Editor keyboard shortcuts. Text fields keep their own keys (and undo), so shortcuts skip them.
import { activeHistory, redo, stepBack, stepForward, trackHistoryFocus, undo } from "./activeHistory";
import { deleteSelected } from "./deleteSelection";
import { copySelection, cutSelection, duplicateSelection, pasteClipboard } from "./hierarchyActions";
import { closeScene, save, togglePlaying } from "./session";
import { stepFrame, togglePause } from "./playDebug";
import { openScene, pickTool, snapping, type Tool } from "./state";

import { isEditable } from "./editable";
export { isEditable };

export type Shortcut = "undo" | "redo" | "back" | "forward" | "save" | "play" | "pause" | "step" | "delete" | "copy" | "cut" | "paste" | "paste-child" | "duplicate" | "close-tab" | `tool:${Tool}`;

/** Undo, redo and stepping through history: they act on the active history (ADR 0143), whichever editor has the focus. */
const HISTORY_SHORTCUTS: readonly Shortcut[] = ["undo", "redo", "back", "forward"];

/** Node clipboard shortcuts: the Assets panel and text fields keep their own Ctrl/Cmd+C/X/V/D. */
const CLIPBOARD_SHORTCUTS: readonly Shortcut[] = ["copy", "cut", "paste", "paste-child", "duplicate"];

const TOOL_KEYS: Record<string, Tool> = { q: "select", w: "move", e: "rotate", r: "scale" };

/** What a keydown means to the editor, if anything. Exported for tests. */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey"> & { altKey?: boolean; code?: string }): Shortcut | null {
  const key = (e.key ?? "").toLowerCase(); // Chromium's autofill sends key events with no key
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
    if (key === "w" && !e.shiftKey && !e.altKey) return "close-tab";
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
 * Delete or Backspace deletes the selected node; Ctrl/Cmd + P plays or stops; Ctrl/Cmd + Shift + P pauses or resumes the game and F10 or Ctrl/Cmd + Alt + P steps it one frame; Ctrl/Cmd + S saves; Ctrl/Cmd + W closes the scene tab; Ctrl/Cmd + Z undoes and Ctrl/Cmd + Shift + Z or Ctrl + Y redoes in the active history (the focused editor's, else the scene's); Ctrl/Cmd + Alt + Z / + Shift step back / forward through history in creation order; Q/W/E/R pick the select, move,
 * rotate and scale tools; holding Ctrl/Cmd snaps gizmo drags. Returns a function that removes
 * the listeners.
 */
export function installShortcuts(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") snapping.value = true;
    const action = shortcutFor(e);
    // The Code panel's editor has its own keys (Ctrl/Cmd+S saves the script, Ctrl/Cmd+Z undoes typing), and the
    // Shader Graph panel its own delete, duplicate and clipboard (ADR 0046); only Play and Save pass through, and
    // there undo and redo too (the active history is the graph's document).
    if (action !== "play" && (e.target as Element | null)?.closest?.(".monaco-editor")) return;
    if (action !== "play" && action !== "save" && !(action && HISTORY_SHORTCUTS.includes(action)) && (e.target as Element | null)?.closest?.(".shader-graph")) return;
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
    if (action === "close-tab") {
      e.preventDefault(); // not the browser's close-tab
      const active = openScene.value;
      if (active && !document.querySelector(".dialog")) void closeScene(active);
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
    // Text fields kept their own undo above (isEditable); everything else undoes the active history.
    if (!HISTORY_SHORTCUTS.includes(action) || !activeHistory.peek()) return;
    e.preventDefault();
    if (action === "undo") undo();
    else if (action === "redo") redo();
    else if (action === "back") stepBack();
    else stepForward();
  };
  trackHistoryFocus();
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
