// The scene editor's dock host (ADR 0174, 0327): its layout store, the Add Panel dialog and detached windows.
import type { DockHost } from "./dockHost";
import { detachToWindow, windowTitle } from "./detached";
import { editorLayoutStore, requestAddPanel } from "./store";

export const editorDockHost: DockHost = {
  store: editorLayoutStore,
  requestAddPanel,
  windows: { detach: detachToWindow, title: windowTitle },
};
