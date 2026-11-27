// The editor's built-in panels (ADR 0182), registered through the same `PanelContribution` plugins use, as
// the core asset kinds are (ADR 0143): everything the editor knows about a panel type (its title, view,
// place in the default layout, whether it can be closed, copied or detached) is in its entry here, and
// every question about a panel type is answered from the panel registry. They are Core, not a plugin:
// they can't be turned off and appear in no manifest. `corePanels.ts` registers them at start-up, before
// the plugins and the layout store; tests that need them call `useBuiltinPanels()` (`testing.ts`).
//
// Adding a built-in panel: one entry here, with `dock` (its default layout dock) or `beside` (the tab
// it follows), or `onDemand` to keep it out of the default layout and the idle preload.
//
// Every view loads the first time it shows (ADR 0083), the Scene view's too: its viewport and game view
// are elements the session owns (`viewportElements`), so the engine starts without the panel.
import { panels, type PanelContribution } from "../sdk/contributions";
import { Panel } from "./panel/Panel";
import { extensionsOf, lazyExtension, PanelExtensions } from "./panelExtensions";

/** Every built-in panel, in the order they register (the Window menu's and the default layout's order). */
const BUILTIN_PANELS: readonly PanelContribution[] = [
  // The one viewport and WebGL context: one copy, always open, in the main window's middle.
  { id: "scene", title: "Scene", view: () => import("./ScenePanel").then((m) => m.ScenePanel), dock: "fill", single: true, closable: false, detachable: false },
  { id: "hierarchy", title: "Hierarchy", view: () => import("./Hierarchy").then((m) => m.Hierarchy), dock: "left" },
  { id: "inspector", title: "Inspector", view: () => import("./Inspector").then((m) => m.Inspector), dock: "right" },
  { id: "assets", title: "Assets", view: () => import("./Assets").then((m) => m.AssetsPanel), dock: "bottom" },
  { id: "history", title: "History", view: () => import("./HistoryPanel").then((m) => m.HistoryPanel), dock: "right" },
  { id: "code", title: "Code", view: () => import("./CodePanel").then((m) => m.CodePanel), dock: "bottom", beside: "assets" },
  {
    id: "worlds",
    title: "Worlds",
    // With the plugins' extensions under it (the navigation counters), loaded with it.
    view: () =>
      Promise.all([import("./WorldsPanel"), ...extensionsOf("worlds").map((e) => lazyExtension(e).preload())]).then(([{ WorldsPanel }]) => () => (
        <Panel>
          <WorldsPanel />
          <PanelExtensions panel="worlds" />
        </Panel>
      )),
    dock: "right",
    beside: "history",
  },
  { id: "network", title: "Network", view: () => import("./NetworkPanel").then((m) => m.NetworkPanel), dock: "right", beside: "worlds" },
  { id: "project", title: "Project", view: () => import("./ProjectSettingsPanel").then((m) => m.ProjectSettingsPanel), dock: "right", beside: "worlds" },
  // String tables, reports and translator exchange (ADR 0356 §9): opened from the Window menu, Project Settings > Languages or a table.
  { id: "localisation", title: "Localisation", view: () => import("./localisation/LocalisationPanel").then((m) => m.LocalisationPanel), beside: "assets", onDemand: true },
  // The live input debugger (ADR 0336, 0337): opened from the Window menu, beside the Network panel.
  { id: "inputDebugger", title: "Input Debugger", view: () => import("./InputDebuggerPanel").then((m) => m.InputDebuggerPanel), beside: "network", onDemand: true },
  // A `*.input.json` opened from the Assets panel (ADR 0233: the kind's `panel`).
];

/** Register the built-in panels. Returns a function that removes them again (for tests). */
export function registerBuiltinPanels(): () => void {
  const undo = BUILTIN_PANELS.map((p) => panels.register(p));
  return () => undo.forEach((u) => u());
}
