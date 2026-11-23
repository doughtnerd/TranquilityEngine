// What a dock layout draws and edits (ADR 0174, 0341): the host's layout store, plus what the host offers beyond
// moving, resizing and closing panels. The scene editor's host (`editorDockHost.ts`) has the Add Panel dialog and
// detached windows; an Audio Studio screen's host has an "Add <panel>" menu and Reset layout. `DockLayout` takes its
// host as a prop or from `DockHostContext`, and defaults to the editor's.
import { createContext } from "preact";
import type { LayoutStore } from "./layoutStore";
import type { Layout, LayoutWindow, PanelInstanceId } from "./model";

export interface DockHost {
  /** The layout and its catalog. */
  readonly store: Pick<LayoutStore, "layout" | "catalog">;
  /** The header menu's "Add Panel…": open the host's dialog for `group` (in detached window `window`, if any). Without it the menu lists "Add <panel>" for each panel type not open. */
  requestAddPanel?(group?: string, window?: string): void;
  /** Detached windows (ADR 0174); without them the header menu has no Detach or Move to. */
  readonly windows?: {
    detach(panel: PanelInstanceId, from?: Window): void;
    /** A window's title, as the Move to items name it. */
    title(layout: Layout, win: LayoutWindow): string;
  };
  /** The header menu's "Reset layout" (the host's default layout); without it the menu has none. */
  reset?(): void;
}

/** The host a `DockLayout` without a `host` prop draws; none: the editor's. */
export const DockHostContext = createContext<DockHost | null>(null);
