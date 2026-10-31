// Editor keyboard shortcuts. Text fields keep their own keys (and undo), so shortcuts skip them.
import { openScene, snapping, tool, type Tool } from "./state";

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button", "color", "range"].includes(el.type);
}

export type Shortcut = "undo" | "redo" | `tool:${Tool}`;

const TOOL_KEYS: Record<string, Tool> = { q: "select", w: "move", e: "rotate", r: "scale" };

/** What a keydown means to the editor, if anything. Exported for tests. */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey"> & { altKey?: boolean }): Shortcut | null {
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (key === "z") return e.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
    return null;
  }
  if (!e.shiftKey && !e.altKey && TOOL_KEYS[key]) return `tool:${TOOL_KEYS[key]}`;
  return null;
}

/**
 * Ctrl/Cmd + Z undoes; Ctrl/Cmd + Shift + Z or Ctrl + Y redoes; Q/W/E/R pick the select, move,
 * rotate and scale tools; holding Ctrl/Cmd snaps gizmo drags. Returns a function that removes
 * the listeners.
 */
export function installShortcuts(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") snapping.value = true;
    const action = shortcutFor(e);
    if (!action || isEditable(e.target)) return;
    if (action.startsWith("tool:")) {
      tool.value = action.slice(5) as Tool;
      return;
    }
    const stack = openScene.value?.stack;
    if (!stack) return;
    e.preventDefault();
    if (action === "undo") stack.undo();
    else stack.redo();
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
