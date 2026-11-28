// Whether the lazily loaded dialogs are open (ADR 0083). The signals live apart from the dialogs'
// modules, so the menus can open a dialog without loading its code first.
import { signal } from "@preact/signals";

/** The Build / Export dialog is open (ADR 0041). */
export const exportOpen = signal(false);

/** Whether the Settings dialog is open. */
export const settingsOpen = signal(false);

/**
 * The Input dialog (ADR 0433): null when closed, else the file it shows (an `*.actions.json` or `*.input.json` path),
 * or "" for whatever it showed last. Opened from File › Input, or by opening an action set or context file.
 */
export const inputDialog = signal<string | null>(null);

/** Open the Input dialog on `path` (an action set or context file), or on what it showed last. */
export function openInputDialog(path = ""): void {
  inputDialog.value = path;
}
