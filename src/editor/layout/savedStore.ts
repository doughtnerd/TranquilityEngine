// Saved layouts (ADR 0174), the stateful part: the layout files in the open project's `.layouts/`
// folder and in per-user storage, which one the working layout came from, and the operations the
// Layouts menu and Manage Layouts run. The file format and version tree are in `saved.ts`.
//
// A layout saved to both places is mirrored: every write from here writes the same file to both, so
// the two only differ after an outside change (a teammate's commit pulled in); the newer copy wins.
import { computed, effect, signal } from "@preact/signals";
import type { StorageBackend } from "../../engine/platform/Storage";
import type { FileSystem } from "../../engine/platform/FileSystem";
import { persisted } from "../preferences";
import { joinPath, type EditorProject } from "../projects";
import { currentProject, status } from "../state";
import { errorStatus } from "../messages";
import { defaultLayout, openTypes, removePanelTypes, type Layout, type PanelId } from "./model";
import {
  LAYOUTS_FOLDER,
  addVersion,
  fileNameFor,
  isLayoutFileName,
  layoutFileText,
  layoutOf,
  matchesHead,
  mergeSaved,
  newLayoutFile,
  parseLayoutFile,
  restoreVersion,
  scopesOf,
  type LayoutFile,
  type LayoutScope,
  type SavedLayout,
} from "./saved";
import { layout } from "./store";
import { panelsOfPlugin } from "../sdk/panelOwners";
import { captureWindowBounds } from "./detached";

/** Where layout files are read and written; tests pass in-memory versions. */
export interface LayoutPlatform {
  /** The platform's file system (Tauri), for projects whose own isn't writable; null in browsers. */
  fs: FileSystem | null;
  userStorage: StorageBackend;
}

const USER_PREFIX = "layouts/";

let platformSource: () => Promise<LayoutPlatform> = async () => {
  const { defaultHistoryPlatform } = await import("../historyPersistence");
  return defaultHistoryPlatform();
};

/** Use another platform (tests). */
export function setLayoutPlatform(source: () => Promise<LayoutPlatform>): void {
  platformSource = source;
}

/** User layouts, by file name. */
export const userLayouts = signal<ReadonlyMap<string, LayoutFile>>(new Map());
/** The open project's layouts, by file name. */
export const projectLayouts = signal<ReadonlyMap<string, LayoutFile>>(new Map());
/** Every saved layout, once per file name, by name. */
export const savedLayouts = computed<SavedLayout[]>(() => mergeSaved(userLayouts.value, projectLayouts.value));

/** The saved layout the working layout came from (its file name), or null for Default. */
export const activeLayoutFile = persisted<string | null>("myco.editor.activeLayout", null);

/** The active saved layout, if it still exists. */
export const activeSaved = computed(() => savedLayouts.value.find((s) => s.file === activeLayoutFile.value) ?? null);

/** True when the working layout differs from the active layout's current version (panels moved, added or closed; sizes don't count). */
export const layoutModified = computed(() => {
  const active = activeSaved.value;
  return active ? !matchesHead(active.newest, layout.value) : false;
});

/** Why the project can't hold layouts now, or null when it can. */
export function whyNoProjectLayouts(project: EditorProject | null = currentProject.peek()): string | null {
  if (!project) return "no project is open";
  if (!project.canSave || !project.root) return "this project is read-only; open a project folder to save layouts in it";
  return null;
}

async function projectFs(project: EditorProject): Promise<FileSystem | null> {
  if (project.fileSystem?.canWrite) return project.fileSystem;
  return (await platformSource()).fs;
}

async function readProjectLayouts(project: EditorProject | null): Promise<Map<string, LayoutFile>> {
  const out = new Map<string, LayoutFile>();
  if (!project?.root) return out;
  const fs = project.fileSystem ?? (await platformSource()).fs;
  if (!fs) return out;
  const folder = joinPath(project.root, LAYOUTS_FOLDER);
  try {
    if (!(await fs.exists(folder))) return out;
    for (const entry of await fs.list(folder)) {
      if (entry.isDirectory || !isLayoutFileName(entry.name)) continue;
      const file = parseLayoutFile(await fs.readText(joinPath(folder, entry.name)).catch(() => null));
      if (file) out.set(entry.name, file);
    }
  } catch {
    // An unreadable folder holds no layouts.
  }
  return out;
}

async function readUserLayouts(): Promise<Map<string, LayoutFile>> {
  const out = new Map<string, LayoutFile>();
  try {
    const storage = (await platformSource()).userStorage;
    for (const key of await storage.list("settings")) {
      if (!key.startsWith(USER_PREFIX)) continue;
      const name = key.slice(USER_PREFIX.length);
      if (!isLayoutFileName(name)) continue;
      const file = parseLayoutFile(await storage.load("settings", key));
      if (file) out.set(name, file);
    }
  } catch {
    // Storage blocked: no user layouts.
  }
  return out;
}

/** Read every layout file again (the project was opened, or the window came back into focus after an outside change). */
export async function refreshSavedLayouts(project: EditorProject | null = currentProject.peek()): Promise<void> {
  const started = writes;
  const [user, proj] = await Promise.all([readUserLayouts(), readProjectLayouts(project)]);
  if (project !== currentProject.peek()) return; // another project opened meanwhile
  if (writes !== started) return void refreshSavedLayouts(project); // a write landed while reading: read again
  userLayouts.value = user;
  projectLayouts.value = proj;
}

/** Bumped by every write, so a read that started before one doesn't overwrite its result. */
let writes = 0;

async function writeUser(name: string, file: LayoutFile | null): Promise<void> {
  writes++;
  const storage = (await platformSource()).userStorage;
  if (file) await storage.save("settings", USER_PREFIX + name, layoutFileText(file));
  else await storage.delete("settings", USER_PREFIX + name);
  const next = new Map(userLayouts.peek());
  if (file) next.set(name, file);
  else next.delete(name);
  userLayouts.value = next;
}

async function writeProject(name: string, file: LayoutFile | null): Promise<void> {
  writes++;
  const project = currentProject.peek();
  const why = whyNoProjectLayouts(project);
  if (why) throw new Error(`Can't save the layout in the project: ${why}.`);
  const fs = await projectFs(project!);
  if (!fs) throw new Error("Can't save the layout in the project: its folder isn't writable.");
  const folder = joinPath(project!.root!, LAYOUTS_FOLDER);
  const path = joinPath(folder, name);
  if (file) {
    if (!(await fs.exists(folder))) await fs.mkdir(folder);
    await fs.writeText(path, layoutFileText(file));
  } else if (await fs.exists(path)) {
    await fs.remove(path);
  }
  const next = new Map(projectLayouts.peek());
  if (file) next.set(name, file);
  else next.delete(name);
  projectLayouts.value = next;
}

/** Write `file` under `name` to each of `scopes`; with `removeOthers`, also remove it from the places left out. */
async function writeTo(name: string, file: LayoutFile, scopes: readonly LayoutScope[], removeOthers = false): Promise<void> {
  const current = savedLayouts.peek().find((s) => s.file === name);
  const all: LayoutScope[] = ["user", "project"];
  for (const scope of all) {
    if (scopes.includes(scope)) await (scope === "user" ? writeUser(name, file) : writeProject(name, file));
    else if (removeOthers && current && scopesOf(current).includes(scope)) await (scope === "user" ? writeUser(name, null) : writeProject(name, null));
  }
}

/** The scopes a layout can be written to now (a project layout in a read-only project can't). */
function writableScopes(saved: SavedLayout): LayoutScope[] {
  return scopesOf(saved).filter((s) => s === "user" || !whyNoProjectLayouts());
}

const report = (what: string) => (err: unknown) => void (status.value = errorStatus(`Couldn't ${what}`, err));

/** Show the Default layout. */
export function applyDefaultLayout(): void {
  layout.value = defaultLayout();
  activeLayoutFile.value = null;
}

/** Show a saved layout (its current version, or version `seq`) and make it the active one. */
export function applySavedLayout(file: string, seq?: number): boolean {
  const saved = savedLayouts.peek().find((s) => s.file === file);
  const next = saved ? layoutOf(saved.newest, seq) : null;
  if (!saved || !next) {
    status.value = { kind: "info", text: saved ? `The layout “${saved.name}” couldn't be read.` : "That layout no longer exists." };
    return false;
  }
  layout.value = next;
  activeLayoutFile.value = file;
  return true;
}

/** Why Save Layout (over the active layout) isn't possible, or null. */
export function whyNoSave(): string | null {
  const active = activeSaved.value;
  if (!active) return "the Default layout can't be changed; use Save Layout As…";
  if (writableScopes(active).length === 0) return whyNoProjectLayouts() ?? "this layout can't be written";
  return null;
}

/** Save the working layout over the active one, as a new version (in every place it's kept that can be written). */
export async function saveLayout(label = "Saved"): Promise<void> {
  const active = activeSaved.peek();
  if (!active || whyNoSave()) return;
  captureWindowBounds(); // detached windows are saved where they are now
  const next = addVersion(active.newest, layout.peek(), Date.now(), label);
  try {
    await writeTo(active.file, next, writableScopes(active));
    status.value = { kind: "info", text: `Saved the layout “${active.name}”.` };
  } catch (err) {
    report(`save the layout “${active.name}”`)(err);
  }
}

/** Save the working layout as a new layout called `name`, in `scopes`; it becomes the active one. Returns its file name. */
export async function saveLayoutAs(name: string, scopes: readonly LayoutScope[]): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed || scopes.length === 0) return null;
  const file = fileNameFor(trimmed, new Set(savedLayouts.peek().map((s) => s.file)));
  captureWindowBounds();
  try {
    await writeTo(file, newLayoutFile(trimmed, layout.peek()), scopes);
    activeLayoutFile.value = file;
    status.value = { kind: "info", text: `Saved the layout “${trimmed}”.` };
    return file;
  } catch (err) {
    report(`save the layout “${trimmed}”`)(err);
    return null;
  }
}

/** Rename a layout; its file name follows. */
export async function renameLayout(file: string, name: string): Promise<void> {
  const saved = savedLayouts.peek().find((s) => s.file === file);
  const trimmed = name.trim();
  if (!saved || !trimmed || trimmed === saved.name) return;
  const taken = new Set(savedLayouts.peek().map((s) => s.file).filter((f) => f !== file));
  const to = fileNameFor(trimmed, taken);
  const scopes = writableScopes(saved);
  try {
    const renamed = { ...saved.newest, name: trimmed };
    if (to === file) await writeTo(file, renamed, scopes);
    else {
      await writeTo(to, renamed, scopes);
      for (const scope of scopes) await (scope === "user" ? writeUser(file, null) : writeProject(file, null));
      if (activeLayoutFile.peek() === file) activeLayoutFile.value = to;
    }
  } catch (err) {
    report(`rename the layout “${saved.name}”`)(err);
  }
}

/** Keep a layout in exactly `scopes` (at least one). */
export async function setLayoutScopes(file: string, scopes: readonly LayoutScope[]): Promise<void> {
  const saved = savedLayouts.peek().find((s) => s.file === file);
  if (!saved || scopes.length === 0) return;
  try {
    await writeTo(file, saved.newest, scopes, true);
  } catch (err) {
    report(`move the layout “${saved.name}”`)(err);
  }
}

/** Delete a layout from every place it's kept (that can be written). */
export async function deleteLayout(file: string): Promise<void> {
  const saved = savedLayouts.peek().find((s) => s.file === file);
  if (!saved) return;
  try {
    for (const scope of writableScopes(saved)) await (scope === "user" ? writeUser(file, null) : writeProject(file, null));
    if (activeLayoutFile.peek() === file && !savedLayouts.peek().some((s) => s.file === file)) activeLayoutFile.value = null;
  } catch (err) {
    report(`delete the layout “${saved.name}”`)(err);
  }
}

/** Make version `seq` the layout's current one, and show it. */
export async function restoreLayoutVersion(file: string, seq: number): Promise<void> {
  const saved = savedLayouts.peek().find((s) => s.file === file);
  if (!saved) return;
  try {
    await writeTo(file, restoreVersion(saved.newest, seq), writableScopes(saved));
    applySavedLayout(file);
  } catch (err) {
    report(`restore the layout “${saved.name}”`)(err);
  }
}

// --- plugin panels ------------------------------------------------------------------------------

/** A layout holding some of a set of panel types: the working layout (`file` null) or a saved one. */
export interface LayoutWithPanels {
  file: string | null;
  name: string;
  types: PanelId[];
  /** False for a project layout in a read-only project (it can't be changed). */
  writable: boolean;
}

/**
 * The panel types the given plugins provide: those they registered this session, and those layouts (the working one
 * and every saved one) remember as theirs, for a plugin that was never on this session.
 */
export function pluginPanelTypes(plugins: readonly string[]): PanelId[] {
  const types = new Set<PanelId>(plugins.flatMap((p) => panelsOfPlugin(p)));
  const remembered = (l: Layout | null) => {
    if (!l) return;
    for (const [type, info] of Object.entries(l.panelInfo)) if (info?.plugin && plugins.includes(info.plugin)) types.add(type);
  };
  remembered(layout.peek());
  for (const s of savedLayouts.peek()) remembered(layoutOf(s.newest));
  return [...types];
}

/** The layouts (the working one first) whose current version holds panels of `types`. */
export function layoutsWithPanels(types: readonly PanelId[]): LayoutWithPanels[] {
  const out: LayoutWithPanels[] = [];
  const hits = (l: Layout | null) => (l ? [...new Set(openTypes(l).filter((t) => types.includes(t)))] : []);
  const working = hits(layout.peek());
  if (working.length > 0) out.push({ file: null, name: "Current layout", types: working, writable: true });
  for (const s of savedLayouts.peek()) {
    const t = hits(layoutOf(s.newest));
    if (t.length > 0) out.push({ file: s.file, name: s.name, types: t, writable: writableScopes(s).length > 0 });
  }
  return out;
}

/** Close the panels of `types` in the working layout, and save each saved layout holding them as a new version without them (`label`). */
export async function removePanelsFromLayouts(types: readonly PanelId[], label: string): Promise<void> {
  layout.value = removePanelTypes(layout.peek(), types);
  for (const s of savedLayouts.peek()) {
    const head = layoutOf(s.newest);
    if (!head || writableScopes(s).length === 0) continue;
    const without = removePanelTypes(head, types);
    if (without === head) continue;
    try {
      await writeTo(s.file, addVersion(s.newest, without, Date.now(), label), writableScopes(s));
    } catch (err) {
      report(`update the layout “${s.name}”`)(err);
    }
  }
}

// Read the layouts whenever a project opens or closes, and when the window comes back into focus (an outside change: a pull).
effect(() => {
  const project = currentProject.value;
  void refreshSavedLayouts(project);
});
if (typeof window !== "undefined") window.addEventListener("focus", () => void refreshSavedLayouts());
