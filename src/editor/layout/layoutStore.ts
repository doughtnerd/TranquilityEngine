// A dock layout as shared state for one host (ADR 0174, 0327): the scene editor's panels, or one Audio Studio screen.
// Each host has its own store key and its own panel catalog and default layout, and its layout is remembered per user
// between sessions. It's a per-viewer convenience, so browser storage is fine; anything unreadable falls back to the
// default layout. Nothing is written until the layout changes, so a page that only loads a store (the Studio loads
// the editor's through the editor SDK) never overwrites what its own app saved.
import { effect, signal, type Signal } from "@preact/signals";
import type { PanelCatalog } from "./catalog";
import { activatePanel, addPanel, defaultLayout, parseLayout, type Layout, type PanelId } from "./model";
import { forgetInstances } from "./instanceState";

export interface LayoutStoreOptions {
  /** The browser storage key it is remembered under (`myco.editor.layout`, `myco.studio.layout.mixer`). */
  readonly key: string;
  /** Keys it was saved under before, read when `key` holds nothing (the engine's former name, ADR 0037). */
  readonly legacyKeys?: readonly string[];
  /** The panels the host can show now. Read on every operation, so a catalog that grows (plugins) is followed. */
  catalog(): PanelCatalog;
  /** The host's first layout (default: `defaultLayout`, each panel in the dock its catalog entry names). */
  defaults?(catalog: PanelCatalog): Layout;
}

export interface LayoutStore {
  readonly key: string;
  /** The layout now; set it to change the layout (it is remembered). */
  readonly layout: Signal<Layout>;
  catalog(): PanelCatalog;
  /** The host's default layout for its catalog now. */
  defaults(): Layout;
  /** Read the saved layout again (as it was when the store was made), against the catalog now. */
  reload(): void;
  /** Show a panel: an instance id, or a type (its first instance, or a new one when none is open). */
  show(panel: PanelId): void;
  /** Open a new instance of each of `types` (in `group` when given), the last one showing. */
  add(types: readonly PanelId[], group?: string): void;
  /** Back to the default layout. */
  reset(): void;
}

function readStorage(keys: readonly string[]): string | null {
  try {
    for (const key of keys) {
      const value = globalThis.localStorage?.getItem(key);
      if (value !== null && value !== undefined) return value;
    }
  } catch {
    // Storage blocked (private window, previews): nothing saved.
  }
  return null;
}

export function createLayoutStore(options: LayoutStoreOptions): LayoutStore {
  const { key } = options;
  const catalog = () => options.catalog();
  const defaults = () => (options.defaults ? options.defaults(catalog()) : defaultLayout(catalog()));
  /** The saved layout as it was when the store was made, before anything here wrote over it. */
  const saved = readStorage([key, ...(options.legacyKeys ?? [])]);
  const load = (): Layout => {
    try {
      return (saved && parseLayout(JSON.parse(saved), catalog())) || defaults();
    } catch {
      return defaults();
    }
  };
  const layout = signal<Layout>(load());
  const loaded = layout.peek();
  effect(() => {
    const value = layout.value;
    if (value === loaded) return; // unchanged since it was read: nothing to remember
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // Storage blocked: the layout just isn't remembered.
    }
  });
  // An instance's view state goes when it leaves this layout (closed, or another layout applied; ADR 0174). Only this
  // store's own instances: another host's layouts on the page keep theirs.
  let held = new Set(Object.keys(loaded.instances));
  effect(() => {
    const now = new Set(Object.keys(layout.value.instances));
    forgetInstances([...held].filter((id) => !now.has(id)));
    held = now;
  });
  return {
    key,
    layout,
    catalog,
    defaults,
    reload: () => (layout.value = load()),
    show: (panel) => (layout.value = activatePanel(layout.value, panel, catalog())),
    add(types, group) {
      let next = layout.value;
      for (const type of types) next = addPanel(next, type, catalog(), group).layout;
      layout.value = next;
    },
    reset: () => (layout.value = defaults()),
  };
}
