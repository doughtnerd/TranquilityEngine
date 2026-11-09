// The editor's menu bar as data: File, Edit, Create, Window and Help. Pure (no DOM, no signals), so
// the rules for which items are enabled, and what they say, are unit-tested; MenuBar.tsx reads the
// live state into a `MenuState`, wires the `MenuActions`, and draws the result.
import { allPanels, panelTitle, type PanelId } from "./layout/model";
import { NEW_NODE_KINDS } from "./nodeCreate";

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
  id: "file" | "edit" | "create" | "window" | "help";
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

/** What the menus depend on, read from the editor's state. */
export interface MenuState {
  project: { name: string; canSave: boolean; hasRoot: boolean } | null;
  scene: { path: string; dirty: boolean } | null;
  /** The active history Undo and Redo act on (ADR 0143): the focused editor's, else the scene's; null with neither. */
  history: HistoryInfo | null;
  /** The game is running (or starting): the scene can't be edited. */
  playing: boolean;
  canOpenFolders: boolean;
  isDesktop: boolean;
  /** Recent projects other than the open one, newest first. */
  recent: readonly { id: string; name: string; path: string }[];
  visiblePanels: ReadonlySet<PanelId>;
  /** Why pasting isn't possible now, or null. */
  pasteBlocked: string | null;
  /** The selection includes nodes inside a prefab instance, which are edited in the prefab. */
  selectionInPrefab: boolean;
  /** Any node is selected. */
  hasSelection: boolean;
  /**
   * What Edit's clipboard items act on: the Assets panel's files when it had the focus before the
   * menu opened (as Ctrl+C/X/V/D/Delete do there), otherwise the Hierarchy's nodes.
   */
  clipboard: "nodes" | "assets";
  /** The Hierarchy's Create items for the open scene (parent and position logic included). */
  createItems: readonly MenuEntry[];
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
  resetLayout(): void;
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

export const DOCS_URL = "https://github.com/doughtnerd/tranquilityengine/tree/master/docs/guide";

export const NO_SCENE = "open a scene first";
export const NO_PROJECT = "open a project first";
export const READ_ONLY = "this project is read-only; open a project folder to save";
export const STOP_PLAYING = "stop playing to edit the scene";
export const NO_FOLDER_ACCESS = "this browser can't open project folders; use the desktop editor or a Chromium browser";

/** The Undo item's text: "Undo <what>", or just "Undo" when there's nothing to undo. */
export function undoLabel(history: HistoryInfo | null): string {
  return history?.canUndo && history.undoLabel ? `Undo ${history.undoLabel}` : "Undo";
}
export function redoLabel(history: HistoryInfo | null): string {
  return history?.canRedo && history.redoLabel ? `Redo ${history.redoLabel}` : "Redo";
}

/** The whole menu bar for the current state. */
export function buildMenus(s: MenuState, a: MenuActions): Menu[] {
  return [fileMenu(s, a), editMenu(s, a), createMenu(s), windowMenu(s, a), helpMenu(a)];
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

export const NOTHING_SELECTED = "nothing selected";

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
  const keys: [string, string, () => void][] = [
    ["Cut", "Ctrl+X", a.cut],
    ["Copy", "Ctrl+C", a.copy],
    ["Paste", "Ctrl+V", a.paste],
    ["Duplicate", "Ctrl+D", a.duplicate],
    ["Delete", "Del", a.remove],
  ];
  // The Assets panel checks its own selection and project, as its shortcuts do.
  if (s.clipboard === "assets") return keys.map(([label, shortcut, run]) => ({ label, shortcut, run, title: `${label} the selected assets` }));
  const editing = !s.scene ? NO_SCENE : s.playing ? STOP_PLAYING : null;
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
    return { id: "create", label: "Create", items: NEW_NODE_KINDS.map((k) => ({ label: k.label, disabled: NO_SCENE })) };
  }
  return { id: "create", label: "Create", items: s.createItems };
}

function windowMenu(s: MenuState, a: MenuActions): Menu {
  const panels: MenuEntry[] = allPanels().map((p) => ({ label: panelTitle(p), checked: s.visiblePanels.has(p), run: () => a.showPanel(p), title: `Show the ${panelTitle(p)} panel` }));
  return { id: "window", label: "Window", items: [...panels, SEPARATOR, { label: "Reset Layout", run: a.resetLayout, title: "Put the panels back where they started" }] };
}

function helpMenu(a: MenuActions): Menu {
  return {
    id: "help",
    label: "Help",
    items: [
      { label: "Documentation", run: a.openDocs, title: "Open the guide in your browser" },
      { label: "Log", run: a.openLog, title: "Open the message log" },
      SEPARATOR,
      { label: "About Myco Engine", run: a.openAbout },
    ],
  };
}
