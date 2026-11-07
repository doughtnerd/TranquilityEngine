// Whether the lazily loaded dialogs are open (ADR 0083). The signals live apart from the dialogs'
// modules, so the menus can open a dialog without loading its code first.
import { signal } from "@preact/signals";

/** The Build / Export dialog is open (ADR 0041). */
export const exportOpen = signal(false);

/** Whether the Settings dialog is open. */
export const settingsOpen = signal(false);
