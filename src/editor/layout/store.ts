// The editor's panel layout as shared state, remembered per user between sessions. It's a
// per-viewer convenience, so browser storage is fine; anything unreadable falls back to the
// default layout.
import { effect, signal } from "@preact/signals";
import { activatePanel, defaultLayout, parseLayout, type Layout, type PanelId } from "./model";

const STORAGE_KEY = "myco.editor.layout";

function readSaved(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? globalThis.localStorage?.getItem("tranquility.editor.layout") ?? null; // the former name's (ADR 0037)
  } catch {
    return null;
  }
}

/** The saved layout as it was when the editor started, before anything here wrote over it. */
const saved = readSaved();

function load(): Layout {
  try {
    return (saved && parseLayout(JSON.parse(saved))) || defaultLayout();
  } catch {
    return defaultLayout();
  }
}

export const layout = signal<Layout>(load());

/**
 * Read the saved layout again, now that plugins have registered their panels (ADR 0134). A plugin
 * module that imports this store (to show its panel) loads it before the plugin is activated, when
 * its panels are still unknown and would be dropped; `editorBoot.ts` calls this right after
 * activating the plugins, before the editor renders.
 */
export function reloadLayout(): void {
  layout.value = load();
}

effect(() => {
  const value = layout.value;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked (private window, previews): the layout just isn't remembered.
  }
});

/** Bring `panel` to the front of its tab group. */
export function showPanel(panel: PanelId): void {
  layout.value = activatePanel(layout.value, panel);
}

export function resetLayout(): void {
  layout.value = defaultLayout();
}
