import { describe, expect, it, vi } from "vitest";
import { PANELS } from "./layout/model";
import { buildMenus, NO_SCENE, NOTHING_SELECTED, READ_ONLY, STOP_PLAYING, redoLabel, undoLabel, type Menu, type MenuActions, type MenuEntry, type MenuState } from "./menuBar";

const noop = () => {};
const actions = (): MenuActions => {
  const fns: Record<string, unknown> = {};
  return new Proxy(fns, { get: (t, name: string) => (t[name] ??= vi.fn()) }) as unknown as MenuActions;
};

const scene = { path: "main.scene.json", dirty: false };
const history = { undoLabel: null, redoLabel: null, canUndo: false, canRedo: false };
/** With a scene open, the scene's history is the active one unless the test says otherwise. */
const state = (over: Partial<MenuState> = {}): MenuState => ({
  project: null,
  scene: null,
  history: over.scene ? history : null,
  playing: false,
  canOpenFolders: true,
  isDesktop: false,
  recent: [],
  visiblePanels: new Set(PANELS),
  pasteBlocked: null,
  selectionInPrefab: false,
  hasSelection: true,
  assets: null,
  createItems: [{ label: "Empty", run: noop }],
  ...over,
});
const project = { name: "Game", canSave: true, hasRoot: true };

const menu = (menus: Menu[], id: string) => menus.find((m) => m.id === id)!;
const item = (menus: Menu[], id: string, label: string): MenuEntry => menu(menus, id).items.find((i) => i.label === label)!;

describe("menu bar", () => {
  it("Edit's clipboard items need a selection (Paste aside), and none work while playing", () => {
    const none = buildMenus(state({ project, scene, hasSelection: false }), actions());
    for (const l of ["Cut", "Copy", "Duplicate", "Delete"]) expect(item(none, "edit", l).disabled, l).toBe(NOTHING_SELECTED);
    expect(item(none, "edit", "Paste").disabled).toBeNull();
    const playing = buildMenus(state({ project, scene, playing: true }), actions());
    for (const l of ["Cut", "Paste", "Duplicate", "Delete"]) expect(item(playing, "edit", l).disabled, l).toBe(STOP_PLAYING);
  });

  it("with the Assets panel focused, Edit's clipboard items act on assets, with the Assets commands' reasons", () => {
    const a = actions();
    const assets = { cut: null, copy: null, paste: "nothing copied", duplicate: null, delete: "it's open in another scene tab; close that tab first" };
    const m = buildMenus(state({ project, scene, hasSelection: false, assets }), a);
    for (const l of ["Cut", "Copy", "Duplicate"]) expect(item(m, "edit", l).disabled, l).toBeFalsy();
    expect(item(m, "edit", "Paste").disabled).toBe("nothing copied");
    expect(item(m, "edit", "Delete").disabled).toMatch(/another scene tab/);
    item(m, "edit", "Copy").run!();
    expect(a.copy).toHaveBeenCalled();
  });

  it("has the five menus", () => {
    expect(buildMenus(state(), actions()).map((m) => m.label)).toEqual(["File", "Edit", "Create", "Window", "Help"]);
  });

  it("with no project: only opening and creating projects, and the editor's own commands, are available", () => {
    const m = buildMenus(state(), actions());
    expect(item(m, "file", "New Project…").disabled).toBeFalsy();
    expect(item(m, "file", "Open Project…").disabled).toBeFalsy();
    for (const l of ["Save", "New Scene", "Build and Export…", "Project Settings", "Close Project"]) expect(item(m, "file", l).disabled, l).toBeTruthy();
    expect(menu(m, "file").items.some((i) => i.label === "Reload Scripts")).toBe(false);
    expect(item(m, "edit", "Settings…").disabled).toBeFalsy();
    expect(item(m, "window", "Reset Layout").disabled).toBeFalsy();
  });

  it("a browser that can't open folders disables New and Open with a reason", () => {
    const m = buildMenus(state({ canOpenFolders: false }), actions());
    expect(item(m, "file", "New Project…").disabled).toMatch(/can't open project folders/);
    expect(item(m, "file", "Open Recent").disabled).toBeTruthy();
  });

  it("Save needs a writable project and an unsaved scene", () => {
    expect(item(buildMenus(state({ project: { ...project, canSave: false }, scene: { ...scene, dirty: true } }), actions()), "file", "Save").disabled).toBe(READ_ONLY);
    expect(item(buildMenus(state({ project }), actions()), "file", "Save").disabled).toBe(NO_SCENE);
    expect(item(buildMenus(state({ project, scene }), actions()), "file", "Save").disabled).toBe("no unsaved changes");
    const save = item(buildMenus(state({ project, scene: { ...scene, dirty: true } }), actions()), "file", "Save");
    expect(save.disabled).toBeNull();
    expect(save.shortcut).toBe("Ctrl+S");
  });

  it("read-only projects can't make scenes; Reload Scripts shows only for folder projects", () => {
    const m = buildMenus(state({ project: { name: "Sample", canSave: false, hasRoot: false } }), actions());
    expect(item(m, "file", "New Scene").disabled).toBeTruthy();
    expect(menu(m, "file").items.some((i) => i.label === "Reload Scripts")).toBe(false);
    expect(menu(buildMenus(state({ project }), actions()), "file").items.some((i) => i.label === "Reload Scripts")).toBe(true);
  });

  it("Exit is desktop-only", () => {
    expect(menu(buildMenus(state(), actions()), "file").items.some((i) => i.label === "Exit")).toBe(false);
    expect(menu(buildMenus(state({ isDesktop: true }), actions()), "file").items.some((i) => i.label === "Exit")).toBe(true);
  });

  it("Open Recent lists the recent projects", () => {
    const a = actions();
    const m = buildMenus(state({ recent: [{ id: "r1", name: "Old Game", path: "/g" }] }), a);
    const recent = item(m, "file", "Open Recent");
    expect(recent.disabled).toBeFalsy();
    expect(recent.submenu!.map((i) => i.label)).toEqual(["Old Game"]);
    recent.submenu![0].run!();
    expect(a.openRecent).toHaveBeenCalledWith("r1");
  });

  it("Undo and Redo say what they do", () => {
    expect(undoLabel(null)).toBe("Undo");
    expect(undoLabel({ ...history, canUndo: true, undoLabel: "Set position" })).toBe("Undo Set position");
    expect(redoLabel({ ...history, canRedo: true, redoLabel: "Add node" })).toBe("Redo Add node");
    const m = buildMenus(state({ project, scene, history: { ...history, canUndo: true, undoLabel: "Add node" } }), actions());
    expect(item(m, "edit", "Undo Add node").disabled).toBeNull();
    expect(item(m, "edit", "Redo").disabled).toBe("nothing to redo");
  });

  it("Undo and Redo follow the active history, even with no scene open (a focused asset editor)", () => {
    const m = buildMenus(state({ project, history: { ...history, canRedo: true, redoLabel: "Edit" } }), actions());
    expect(item(m, "edit", "Undo").disabled).toBe("nothing to undo");
    expect(item(m, "edit", "Redo Edit").disabled).toBeNull();
  });

  it("editing commands need a scene, and not while playing", () => {
    const none = buildMenus(state(), actions());
    for (const l of ["Undo", "Redo", "Cut", "Copy", "Paste", "Duplicate", "Delete"]) expect(item(none, "edit", l).disabled, l).toBe(NO_SCENE);
    const playing = buildMenus(state({ project, scene, playing: true }), actions());
    for (const l of ["Cut", "Duplicate", "Delete"]) expect(item(playing, "edit", l).disabled, l).toMatch(/stop playing/);
    expect(item(playing, "edit", "Copy").disabled).toBeFalsy();
  });

  it("Paste follows the clipboard", () => {
    const m = buildMenus(state({ project, scene, pasteBlocked: "nothing copied" }), actions());
    expect(item(m, "edit", "Paste").disabled).toBe("nothing copied");
  });

  it("Create is disabled without a scene, and is the Hierarchy's list with one", () => {
    const none = menu(buildMenus(state(), actions()), "create");
    expect(none.items.length).toBeGreaterThan(5);
    expect(none.items.every((i) => i.disabled === NO_SCENE)).toBe(true);
    const open = menu(buildMenus(state({ project, scene }), actions()), "create");
    expect(open.items.map((i) => i.label)).toEqual(["Empty"]);
  });

  it("Window has a checked item per panel, then Reset Layout", () => {
    const visible = new Set(PANELS.filter((p) => p !== "history"));
    const w = menu(buildMenus(state({ visiblePanels: visible }), actions()), "window");
    const panels = w.items.filter((i) => i.checked !== undefined);
    expect(panels).toHaveLength(PANELS.length);
    expect(panels.find((i) => i.label === "History")!.checked).toBe(false);
    expect(panels.find((i) => i.label === "Hierarchy")!.checked).toBe(true);
    expect(w.items.at(-1)!.label).toBe("Reset Layout");
  });

  it("Project Settings shows the project panel", () => {
    const a = actions();
    item(buildMenus(state({ project }), a), "file", "Project Settings").run!();
    expect(a.showPanel).toHaveBeenCalledWith("project");
  });
});
