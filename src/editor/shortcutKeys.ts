// What a key press means, as the editor and the Audio Studio read it (ADR 0145, 0341): one pure classification of a
// keydown into a shortcut, shared by the editor's shortcuts (shortcuts.ts) and the Studio's keys (studio/shell/
// installKeys.ts), so Undo, Redo and stepping through history answer the same keys in both apps. A leaf: no DOM, no
// signals, nothing but types imported.
import type { Tool } from "./state";

export type Shortcut = "undo" | "redo" | "back" | "forward" | "save" | "play" | "pause" | "step" | "delete" | "copy" | "cut" | "paste" | "paste-child" | "duplicate" | "close-tab" | `tool:${Tool}`;

/** Undo, redo and stepping through history: they act on the active history (ADR 0145), whichever editor has the focus. */
export const HISTORY_SHORTCUTS: readonly Shortcut[] = ["undo", "redo", "back", "forward"];

/** The parts of a keydown the classification reads. */
export type ShortcutKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey"> & { altKey?: boolean; code?: string };

const TOOL_KEYS: Record<string, Tool> = { q: "select", w: "move", e: "rotate", r: "scale" };

/** What a keydown means, if anything (whether the app acts on it there is the app's call). */
export function shortcutFor(e: ShortcutKey): Shortcut | null {
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
