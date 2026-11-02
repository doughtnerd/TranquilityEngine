// Small per-user editor preferences, remembered in browser storage (a per-viewer convenience;
// anything unreadable falls back to the default).
import { effect, signal, type Signal } from "@preact/signals";

function persisted<T>(key: string, fallback: T): Signal<T> {
  let initial = fallback;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw !== null && raw !== undefined) initial = JSON.parse(raw) as T;
  } catch {
    // unreadable: keep the default
  }
  const s = signal<T>(initial);
  effect(() => {
    const value = s.value;
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // storage blocked: the preference just isn't remembered
    }
  });
  return s;
}

/** Ask before deleting an asset or script file from the project (it can't be undone). */
export const askBeforeDeletingAssets = persisted("tranquility.editor.askBeforeDeletingAssets", true);

/** Ask before deleting a node that other nodes reference (their fields are set to None). */
export const askBeforeClearingReferences = persisted("tranquility.editor.askBeforeClearingReferences", true);

/**
 * Where edit history files go (ADR 0027): the project folder (`.tranquility/history/`, the
 * default) or per-user storage outside the project. Read-only projects always use per-user storage.
 */
export const historyLocation = persisted<"project" | "user">("tranquility.editor.historyLocation", "project");
