// Confirmation dialogs and the unsaved-changes guard. Native dialogs under Tauri (the dialog
// plugin), the browser's own otherwise. Unsaved changes are the open scenes' and the Code panel's
// buffers' (ADR 0308); asset documents write their edits themselves, so they hold none.
import { isTauri } from "../engine/platform/FileSystem";
import { dirtyScripts } from "./code/codeBuffers";
import { openScene, openScenes } from "./state";

/** Files with unsaved changes: open scenes (every tab, and the active one), then the Code panel's buffers. */
function unsavedFiles(): string[] {
  const all = new Set(openScenes.value);
  if (openScene.value) all.add(openScene.value);
  return [...[...all].filter((s) => s.stack.dirty).map((s) => s.path), ...dirtyScripts.value];
}

async function confirmDialog(message: string, okLabel = "OK"): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title: "Myco Engine Editor", kind: "warning", okLabel, cancelLabel: "Cancel" });
  }
  return window.confirm(message);
}

/** True if there are no unsaved changes, or the user agrees to discard them. */
export async function confirmDiscard(): Promise<boolean> {
  const unsaved = unsavedFiles();
  if (unsaved.length === 0) return true;
  return confirmDialog(`Discard unsaved changes to ${unsaved.join(", ")}?`, "Discard");
}

/** Ask before closing the window (or tab) with unsaved changes. Returns a function that removes the guard. */
export function installCloseGuard(): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (unsavedFiles().length > 0) e.preventDefault();
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  let unlisten: (() => void) | null = null;
  if (isTauri()) {
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      unlisten = await getCurrentWindow().onCloseRequested(async (e) => {
        if (!(await confirmDiscard())) e.preventDefault();
      });
    });
  }
  return () => {
    window.removeEventListener("beforeunload", onBeforeUnload);
    unlisten?.();
  };
}
