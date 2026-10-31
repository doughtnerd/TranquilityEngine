// Confirmation dialogs and the unsaved-changes guard. Native dialogs under Tauri (the dialog
// plugin), the browser's own otherwise.
import { isTauri } from "../engine/platform/FileSystem";
import { openScene } from "./state";

export async function confirmDialog(message: string, okLabel = "OK"): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title: "TranquilityEngine Editor", kind: "warning", okLabel, cancelLabel: "Cancel" });
  }
  return window.confirm(message);
}

/** True if there are no unsaved changes, or the user agrees to discard them. */
export async function confirmDiscard(): Promise<boolean> {
  const scene = openScene.value;
  if (!scene?.stack.dirty) return true;
  return confirmDialog(`Discard unsaved changes to ${scene.path}?`, "Discard");
}

/** Ask before closing the window (or tab) with unsaved changes. Returns a function that removes the guard. */
export function installCloseGuard(): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (openScene.value?.stack.dirty) e.preventDefault();
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
