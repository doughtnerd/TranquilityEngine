// The editor's menu bar as data: File, Edit, Create, Window, Layouts and Help. Pure (no DOM, no signals), so
// the rules for which items are enabled, and what they say, are unit-tested; MenuBar.tsx reads the
// live state into a `MenuState`, wires the `MenuActions`, and draws the result.
import { panelTitle, type PanelCatalog, type PanelId } from "./layout/catalog";
import { nodeCreateTree } from "./createMenuTree";

export interface MenuEntry {
  label: string;
  /** Shown on the right, e.g. "Ctrl+S". */
  shortcut?: string;
  run?: () => void;
  /** Why the item is unavailable (its tooltip); null/false/undefined when it is available. */
  disabled?: string | false | null;
  /** Present on checkable items (Window's panels). */
  checked?: boolean;
  submenu?: readonly MenuEntry[];
  separator?: boolean;
  /** Tooltip for an enabled item. */
  title?: string;
}

export interface Menu {
  id: "file" | "edit" | "create" | "window" | "layouts" | "help";
  label: string;
  items: readonly MenuEntry[];
}

export const SEPARATOR: MenuEntry = { label: "", separator: true };

/** What Edit's Undo and Redo show about the active history. */
export interface HistoryInfo {
  undoLabel: string | null;
  redoLabel: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

/** Why each of Edit's clipboard items can't act on the Assets panel's selection, or null when it can. */
export interface AssetClipboardReasons {
  cut: string | null;
  copy: string | null;
  paste: string | null;
  duplicate: string | null;
  delete: string | null;
}

/** What the menus depend on, read from the editor's state. */
export interface MenuState {
  project: { name: string; canSave: boolean; hasRoot: boolean } | null;
  scene: { path: string; dirty: boolean } | null;
  /** The active history Undo and Redo act on (ADR 0145): the focused editor's, else the scene's; null with neither. */
  history: HistoryInfo | null;
  /** Why the open scene can't be edited now (the edit gate, ADR 0247: no scene, play mode), or null. */
  sceneEditBlocked: string | null;
  canOpenFolders: boolean;
  isDesktop: boolean;
  /** Recent projects other than the open one, newest first. */
  recent: readonly { id: string; name: string; path: string }[];
  /** Every panel type the editor can show (ADR 0182), for Window's items. */
  panels: PanelCatalog;
  visiblePanels: ReadonlySet<PanelId>;
  /** Why pasting isn't possible now, or null. */
  pasteBlocked: string | null;
  /** The selection includes nodes inside a prefab instance, which are edited in the prefab. */
  selectionInPrefab: boolean;
  /** Any node is selected. */
  hasSelection: boolean;
  /**
   * What Edit's clipboard items act on: the Assets panel's files when it had the focus before the
   * menu opened (as Ctrl+C/X/V/D/Delete do there), with why each command can't act on its selection
   * (the Assets command module's rule, ADR 0241); null: the Hierarchy's nodes.
   */
  assets: AssetClipboardReasons | null;
  /** The Hierarchy's Create items for the open scene (parent and position logic included). */
  createItems: readonly MenuEntry[];
  /** The Layouts menu's state (ADR 0174). */
  layouts: LayoutsMenuState;
}

/** What the Layouts menu shows (ADR 0174). */
export interface LayoutsMenuState {
  /** The saved layouts, by name: file name, display name, where it's kept ("User", "Project", "User + Project"). */
  saved: readonly { file: string; name: string; scope: string }[];
  /** The active layout's file name, or null for Default. */
  active: string | null;
  /** The working layout differs from the active layout's current version. */
  modified: boolean;
  /** Why Save Layout can't save over the active layout, or null. */
  saveBlocked: string | null;
}

export interface MenuActions {
  newProject(): void;
  openProject(): void;
  openRecent(id: string): void;
  save(): void;
  newScene(): void;
  reloadScripts(): void;
  exportBuild(): void;
  showPanel(panel: PanelId): void;
  /** Open the Add Panel dialog (ADR 0174). */
  addPanel(): void;
  resetLayout(): void;
  /** Open the Audio Studio on the open project (ADR 0341): its window on the desktop, a tab in the browser. */
  openAudioStudio(): void;
  applyLayout(file: string | null): void;
  saveLayout(): void;
  saveLayoutAs(): void;
  manageLayouts(): void;
  closeProject(): void;
  exit(): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  duplicate(): void;
  remove(): void;
  openSettings(): void;
  openDocs(): void;
  openLog(): void;
  openAbout(): void;
}

export const DOCS_URL = "https://github.com/doughtnerd/TranquilityEngine/wiki";

const NO_SCENE = "open a scene first";
export const NO_PROJECT = "open a project first";
const READ_ONLY = "this project is read-only; open a project folder to save";
const NO_FOLDER_ACCESS = "this browser can't open project folders; use the desktop editor or a Chromium browser";

/** The Undo item's text: "Undo <what>", or just "Undo" when there's nothing to undo. */
export function undoLabel(history: HistoryInfo | null): string {
  return history?.canUndo && history.undoLabel ? `Undo ${history.undoLabel}` : "Undo";
}
export function redoLabel(history: HistoryInfo | null): string {
  return history?.canRedo && history.redoLabel ? `Redo ${history.redoLabel}` : "Redo";
}

/** The whole menu bar for the current state. */
export function buildMenus(s: MenuState, a: MenuActions): Menu[] {
  return [fileMenu(s, a), editMenu(s, a), createMenu(s), windowMenu(s, a), layoutsMenu(s, a), helpMenu(a)];
}

function fileMenu(s: MenuState, a: MenuActions): Menu {
  const folders = s.canOpenFolders ? null : NO_FOLDER_ACCESS;
  const saveReason = !s.project ? NO_PROJECT : !s.project.canSave ? READ_ONLY : !s.scene ? NO_SCENE : !s.scene.dirty ? "no unsaved changes" : null;
  const recent: MenuEntry[] = s.recent.map((r) => ({ label: r.name, title: r.path, run: () => a.openRecent(r.id) }));
  const items: MenuEntry[] = [
    { label: "New Project…", disabled: folders, run: a.newProject, title: "Create a project folder from a template" },
    { label: "Open Project…", disabled: folders, run: a.openProject, title: "Open a project folder" },
    { label: "Open Recent", disabled: folders ?? (recent.length === 0 ? "no recent projects" : null), submenu: recent },
    SEPARATOR,
    { label: "Save", shortcut: "Ctrl+S", disabled: saveReason, run: a.save, title: s.scene ? `Save ${s.scene.path}` : undefined },
    { label: "New Scene", disabled: !s.project ? NO_PROJECT : !s.project.canSave ? "this project is read-only" : null, run: a.newScene, title: "Create a scene with a camera and open it" },
  ];
  if (s.project?.hasRoot) items.push({ label: "Reload Scripts", run: a.reloadScripts, title: "Read the scripts under scripts/ again and reload them (ADR 0030)" });
  items.push(
    SEPARATOR,
    { label: "Build and Export…", disabled: s.project ? null : NO_PROJECT, run: a.exportBuild, title: "Make a playable web build or desktop app of the project (ADR 0041)" },
    { label: "Project Settings", disabled: s.project ? null : NO_PROJECT, run: () => a.showPanel("project"), title: "Show the Project panel: project.json's settings" },
    SEPARATOR,
    { label: "Close Project", disabled: s.project ? null : NO_PROJECT, run: a.closeProject, title: "Close the project and go back to the start screen" },
  );
  if (s.isDesktop) items.push({ label: "Exit", run: a.exit, title: "Close the editor" });
  return { id: "file", label: "File", items };
}

const NOTHING_SELECTED = "nothing selected";

function editMenu(s: MenuState, a: MenuActions): Menu {
  const items: MenuEntry[] = [
    { label: undoLabel(s.history), shortcut: "Ctrl+Z", disabled: !s.history ? NO_SCENE : s.history.canUndo ? null : "nothing to undo", run: a.undo },
    { label: redoLabel(s.history), shortcut: "Ctrl+Shift+Z", disabled: !s.history ? NO_SCENE : s.history.canRedo ? null : "nothing to redo", run: a.redo },
    SEPARATOR,
    ...clipboardItems(s, a),
    SEPARATOR,
    { label: "Settings…", run: a.openSettings, title: "Editor settings" },
  ];
  return { id: "edit", label: "Edit", items };
}

/** Cut, Copy, Paste, Duplicate and Delete, for the Hierarchy's nodes or the Assets panel's files. */
function clipboardItems(s: MenuState, a: MenuActions): MenuEntry[] {
  if (s.assets) {
    const why = s.assets;
    const keys: [string, string, string | null, () => void][] = [
      ["Cut", "Ctrl+X", why.cut, a.cut],
      ["Copy", "Ctrl+C", why.copy, a.copy],
      ["Paste", "Ctrl+V", why.paste, a.paste],
      ["Duplicate", "Ctrl+D", why.duplicate, a.duplicate],
      ["Delete", "Del", why.delete, a.remove],
    ];
    return keys.map(([label, shortcut, disabled, run]) => ({ label, shortcut, disabled, run, title: `${label} the selected assets` }));
  }
  const editing = s.sceneEditBlocked;
  const selected = s.hasSelection ? null : NOTHING_SELECTED;
  const inner = s.selectionInPrefab ? "nodes inside a prefab are edited in the prefab" : null;
  return [
    { label: "Cut", shortcut: "Ctrl+X", disabled: editing ?? selected ?? inner, run: a.cut },
    { label: "Copy", shortcut: "Ctrl+C", disabled: (!s.scene ? NO_SCENE : null) ?? selected ?? inner, run: a.copy },
    { label: "Paste", shortcut: "Ctrl+V", disabled: editing ?? s.pasteBlocked, run: a.paste },
    { label: "Duplicate", shortcut: "Ctrl+D", disabled: editing ?? selected ?? inner, run: a.duplicate },
    { label: "Delete", shortcut: "Del", disabled: editing ?? selected ?? (s.selectionInPrefab ? "nodes inside a prefab are removed in the prefab" : null), run: a.remove },
  ];
}

function createMenu(s: MenuState): Menu {
  if (!s.scene) {
    // The Hierarchy's Create tree (ADR 0383), every item and submenu unavailable.
    const off = (e: MenuEntry): MenuEntry => (e.separator ? e : { label: e.label, disabled: NO_SCENE });
    return { id: "create", label: "Create", items: nodeCreateTree((_, label) => ({ label })).map(off) };
  }
  return { id: "create", label: "Create", items: s.createItems };
}

/**
 * One item per panel type, ticked when one is showing: picking it shows the panel, adding it back when it was
 * closed (ADR 0174). Then Add Panel… (any panels, a second copy included) and Reset Layout, then the Audio Studio,
 * its own app (ADR 0341).
 */
function windowMenu(s: MenuState, a: MenuActions): Menu {
  const panels: MenuEntry[] = [...s.panels.keys()].map((p) => {
    const title = panelTitle(s.panels, p);
    return { label: title, checked: s.visiblePanels.has(p), run: () => a.showPanel(p), title: `Show the ${title} panel (adding it if it's closed)` };
  });

  return {
    id: "window",
    label: "Window",
    items: [
      ...panels,
      SEPARATOR,
      { label: "Add Panel…", run: a.addPanel, title: "Choose panels to add, a second copy of one included" },
      { label: "Reset Layout", run: a.resetLayout, title: "Put the panels back where they started (the Default layout)" },
      SEPARATOR,
      {
        label: "Audio Studio",
        run: a.openAudioStudio,
        title: s.project?.hasRoot ? `Open ${s.project.name} in the Audio Studio, the app for the project's sounds, music and mix` : "Open the Audio Studio, the app for a project's sounds, music and mix",
      },
    ],
  };
}

/** Default and the saved layouts (ticked: the one showing, "●" when changed since), then saving and managing them (ADR 0174). */
function layoutsMenu(s: MenuState, a: MenuActions): Menu {
  const l = s.layouts;
  const mark = (active: boolean) => (active && l.modified ? " ●" : "");
  return {
    id: "layouts",
    label: "Layouts",
    items: [
      { label: `Default${mark(l.active === null)}`, checked: l.active === null, run: () => a.applyLayout(null), title: l.active === null && l.modified ? "The built-in layout (changed since: pick it to put it back)" : "The built-in layout" },
      ...l.saved.map((x) => ({
        label: `${x.name}${mark(l.active === x.file)}`,
        shortcut: x.scope,
        checked: l.active === x.file,
        run: () => a.applyLayout(x.file),
        title: `${x.file} · ${x.scope}${l.active === x.file && l.modified ? " · changed since it was saved" : ""}`,
      })),
      SEPARATOR,
      { label: "Save Layout", disabled: l.saveBlocked, run: a.saveLayout, title: "Save the panels as they are over the current layout (a new version: older ones stay in Manage Layouts)" },
      { label: "Save Layout As…", run: a.saveLayoutAs, title: "Save the panels as they are as a new layout, for you, the project or both" },
      { label: "Manage Layouts…", disabled: l.saved.length === 0 ? "no saved layouts yet" : null, run: a.manageLayouts, title: "Rename, move or delete layouts, and restore earlier versions" },
    ],
  };
}

function helpMenu(a: MenuActions): Menu {
  return {
    id: "help",
    label: "Help",
    items: [
      { label: "Documentation", run: a.openDocs, title: "Open the wiki in your browser" },
      { label: "Log", run: a.openLog, title: "Open the message log" },
      SEPARATOR,
      { label: "About Myco Engine", run: a.openAbout },
    ],
  };
}
