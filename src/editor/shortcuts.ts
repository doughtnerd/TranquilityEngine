// Editor keyboard shortcuts. Text fields keep their own keys (and undo), so shortcuts skip them.
import { activeHistory, redo, stepBack, stepForward, undo } from "./activeHistory";
import { deleteSelected } from "./deleteSelection";
import { expectPaste, takePaste } from "./clipboard";
import { copySelection, cutSelection, duplicateSelection, pasteClipboardText } from "./hierarchyActions";
import { closeScene, save, togglePlaying } from "./session";
import { stepFrame, togglePause } from "./playDebug";
import { openScene, pickTool, snapping, type Tool } from "./state";
import { HISTORY_SHORTCUTS, shortcutFor, type Shortcut } from "./shortcutKeys";

import { isEditable } from "./editable";
import { insideKeyOwner } from "./graph/keyOwner";
import { dialogOpenAnywhere } from "./windows/editorWindows";
export { isEditable };

export type { Shortcut };

/** Node clipboard shortcuts: the Assets panel and text fields keep their own Ctrl/Cmd+C/X/V/D. */
const CLIPBOARD_SHORTCUTS: readonly Shortcut[] = ["copy", "cut", "paste", "paste-child", "duplicate"];

/**
 * Ctrl/Cmd + C/X/V/D copy, cut, paste and duplicate the selected nodes (+ Shift + V pastes as a child);
 * Delete or Backspace deletes the selected node; Ctrl/Cmd + P plays or stops; Ctrl/Cmd + Shift + P pauses or resumes the game and F10 or Ctrl/Cmd + Alt + P steps it one frame; Ctrl/Cmd + S saves; Ctrl/Cmd + W closes the scene tab; Ctrl/Cmd + Z undoes and Ctrl/Cmd + Shift + Z or Ctrl + Y redoes in the active history (the focused editor's, else the scene's); Ctrl/Cmd + Alt + Z / + Shift step back / forward through history in creation order; Q/W/E/R pick the select, move,
 * rotate and scale tools; holding Ctrl/Cmd snaps gizmo drags. Returns a function that removes
 * the listeners. Installed in every editor window, detached panel windows included (main.tsx, with
 * `forEachEditorWindow`, ADR 0174): a key typed in a child reaches only that child's listeners, so
 * nothing runs twice.
 */
export function installShortcuts(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") snapping.value = true;
    const action = shortcutFor(e);
    // The Code panel's editor has its own keys (Ctrl/Cmd+S saves the script, Ctrl/Cmd+Z undoes typing), and a
    // graph editor (any root marked as owning the keys, `graph/keyOwner.ts`) its own delete, duplicate, clipboard
    // and tool keys (ADR 0046); only Play and Save pass through, and there undo and redo too (the active history is
    // the graph's document).
    if (action !== "play" && (e.target as Element | null)?.closest?.(".monaco-editor")) return;
    if (action !== "play" && action !== "save" && !(action && HISTORY_SHORTCUTS.includes(action)) && insideKeyOwner(e.target)) return;
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
      if (active && !dialogOpenAnywhere()) void closeScene(active);
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
      if (dialogOpenAnywhere()) return; // a dialog is open
      e.preventDefault();
      void deleteSelected();
      return;
    }
    if (CLIPBOARD_SHORTCUTS.includes(action)) {
      if ((e.target as Element | null)?.closest?.(".asset-browser, .dialog") || dialogOpenAnywhere()) return;
      if (action === "paste" || action === "paste-child") {
        // Not prevented: the browser's `paste` event carries the system clipboard's text (ADR 0226).
        const asChild = action === "paste-child";
        expectPaste((text) => void pasteClipboardText(text, asChild));
        return;
      }
      e.preventDefault(); // Ctrl+D would bookmark the page
      if (action === "copy") copySelection();
      else if (action === "cut") cutSelection();
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
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") snapping.value = false;
  };
  const onBlur = () => (snapping.value = false);
  // A paste the keys above are waiting for, or one from the Edit menu of the browser or the desktop window: nodes,
  // where the node shortcuts would act (text fields, the Assets panel, dialogs and the graph panels paste their own).
  const onPaste = (e: Event) => {
    const at = e.target as Element | null;
    if (isEditable(at) || insideKeyOwner(at) || at?.closest?.(".monaco-editor, .asset-browser, .dialog") || dialogOpenAnywhere()) return;
    takePaste(e as ClipboardEvent, (text) => void pasteClipboardText(text));
  };
  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);
  target.addEventListener("paste", onPaste);
  return () => {
    target.removeEventListener("paste", onPaste);
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("keyup", onKeyUp);
    target.removeEventListener("blur", onBlur);
  };
}
