// The editor's panel layout as shared state, remembered per user between sessions. It's a
// per-viewer convenience, so browser storage is fine; anything unreadable falls back to the
// default layout.
import { effect, signal } from "@preact/signals";
import { activatePanel, defaultLayout, parseLayout, type Layout, type PanelId } from "./model";

const STORAGE_KEY = "myco.editor.layout";

function load(): Layout {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? globalThis.localStorage?.getItem("tranquility.editor.layout"); // the former name's (ADR 0037)
    return (raw && parseLayout(JSON.parse(raw))) || defaultLayout();
  } catch {
    return defaultLayout();
  }
}

export const layout = signal<Layout>(load());

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
