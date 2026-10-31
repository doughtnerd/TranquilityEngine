// Editor keyboard shortcuts. Text fields keep their own undo, so shortcuts skip them.
import { openScene } from "./state";

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button", "color", "range"].includes(el.type);
}

/** What a keydown means to the editor, if anything. Exported for tests. */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey">): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y") return "redo";
  return null;
}

/** Ctrl/Cmd + Z undoes; Ctrl/Cmd + Shift + Z or Ctrl + Y redoes. Returns a function that removes the listener. */
export function installShortcuts(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const action = shortcutFor(e);
    const stack = openScene.value?.stack;
    if (!action || !stack || isEditable(e.target)) return;
    e.preventDefault();
    if (action === "undo") stack.undo();
    else stack.redo();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
