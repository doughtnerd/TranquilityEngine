// The editor's panel layout as shared state, remembered per user between sessions under `myco.editor.layout`
// (a layout store, `layoutStore.ts`; the Audio Studio has one per screen, ADR 0327). The layout model's rules get
// the editor's panel catalog: the panel registry, where the built-in panels and plugins' are registered (ADR 0182).
import { signal } from "@preact/signals";
import type { PanelId } from "./model";
import { createLayoutStore } from "./layoutStore";
import { registeredPanels } from "./registeredPanels";

/** The editor's layout store. */
export const editorLayoutStore = createLayoutStore({
  key: "myco.editor.layout",
  legacyKeys: ["tranquility.editor.layout"], // the former name's (ADR 0037)
  catalog: registeredPanels,
});

export const layout = editorLayoutStore.layout;

/**
 * Read the saved layout again, now that plugins have registered their panels (ADR 0134). A plugin
 * module that imports this store (to show its panel) loads it before the plugin is activated, when
 * its panels are still unknown and would be dropped; `editorBoot.ts` calls this right after
 * activating the plugins, before the editor renders. Boot only: it reads the layout saved before this
 * session, so calling it later would undo the session's panel moves (opening a project checks the live
 * layout instead, `applyProjectPlugins`).
 */
export function reloadLayout(): void {
  editorLayoutStore.reload();
}

/** Show a panel: an instance id, or a type (its first instance, or a new one when none is open). */
export function showPanel(panel: PanelId): void {
  editorLayoutStore.show(panel);
}

/** Open a new instance of each of `types` (in `group` when given), the last one showing (ADR 0174). */
export function addPanels(types: readonly PanelId[], group?: string): void {
  editorLayoutStore.add(types, group);
}

/** The Add Panel dialog's request: open (with the group to add to, and the detached window it's in, if any) or null. */
export const addPanelRequest = signal<{ group?: string; window?: string } | null>(null);

/** Open the Add Panel dialog, adding to `group` (a header menu's) or to each panel's usual place; shown in the detached window `window` when given. */
export function requestAddPanel(group?: string, window?: string): void {
  addPanelRequest.value = { group, window };
}

export function resetLayout(): void {
  editorLayoutStore.reset();
}
