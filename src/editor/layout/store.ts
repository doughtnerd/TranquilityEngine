// The editor's panel layout as shared state, remembered per user between sessions. It's a
// per-viewer convenience, so browser storage is fine; anything unreadable falls back to the
// default layout.
import { effect, signal } from "@preact/signals";
import { activatePanel, addPanel, defaultLayout, parseLayout, type Layout, type PanelId } from "./model";
import { retainInstances } from "./instanceState";

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

// An instance's view state goes when it leaves the layout (closed, or another layout applied; ADR 0174).
effect(() => retainInstances(Object.keys(layout.value.instances)));

/** Show a panel: an instance id, or a type (its first instance, or a new one when none is open). */
export function showPanel(panel: PanelId): void {
  layout.value = activatePanel(layout.value, panel);
}

/** Open a new instance of each of `types` (in `group` when given), the last one showing (ADR 0174). */
export function addPanels(types: readonly PanelId[], group?: string): void {
  let next = layout.value;
  for (const type of types) next = addPanel(next, type, group).layout;
  layout.value = next;
}

/** The Add Panel dialog's request: open (with the group to add to, and the detached window it's in, if any) or null. */
export const addPanelRequest = signal<{ group?: string; window?: string } | null>(null);

/** Open the Add Panel dialog, adding to `group` (a header menu's) or to each panel's usual place; shown in the detached window `window` when given. */
export function requestAddPanel(group?: string, window?: string): void {
  addPanelRequest.value = { group, window };
}

export function resetLayout(): void {
  layout.value = defaultLayout();
}
