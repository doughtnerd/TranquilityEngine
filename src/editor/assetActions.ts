// The Assets panel's commands (ADR 0241): Open, Rename, Duplicate, Copy, Cut, Paste and Delete, the
// New… items and plugins' asset actions (ADR 0146). Each command says why it isn't available (one
// rule, the check its operation makes), runs, and selects what it made. The panel's context menu,
// its keys and the menu bar's Edit items only map gestures onto these. Also what a copy of the panel
// lists, so the menu bar can act on the last-used panel's selection.
import { listedFiles, searchEntries } from "./assetBrowser";
import { fileName, folderOf, parentFolder } from "./projectPath";
import { deleteAssets, whyNotDeletable } from "./assetDelete";
import { entryPath, fileEntries, folderEntry, isFolderEntry, isSliceEntry, sliceEntry, splitSliceEntry, type AssetEntry } from "./assetEntry";
import { readImportSettings } from "./assetImport";
import { kindCreators, openAsset } from "./assetKindHost";
import { assetKind, hasSlices, kindOpens } from "./assetKindLookup";
import { assetClipboard, duplicateAssets, newFolder, pasteAssets, whyNotMovable, whyNotPaste } from "./assetOps";
import { lastAssetBrowser, openFolder, renamingAsset, selectedAssets, type AssetBrowserView } from "./assetSelection";
import { selectAssets } from "./inspectorTarget";
import { categorise, OTHER_CATEGORY, type CategorisedEntry } from "./menuCategories";
import { newScript } from "./newScript";
import type { EditorProject } from "./projects";
import { assetActions, type AssetActionTarget } from "./sdk/contributions";
import { currentProject, status } from "./state";
import { whyNotEdit } from "./editGate";

/** What a command acts on: the entries right-clicked, or the panel's selection (`panelTarget`). */
export interface AssetTarget {
  readonly project: EditorProject;
  readonly entries: readonly AssetEntry[];
  /** With no single folder in `entries`, the folder Paste and Create act in (the folder tree's root row: ""); the folder showing when absent. */
  readonly folder?: string;
}

export type AssetCommandId = "open" | "rename" | "duplicate" | "copy" | "cut" | "paste" | "delete";

/** An item the panel's menu shows that isn't one of the commands: New… and plugins' actions. */
export interface AssetMenuItem {
  readonly label: string;
  /** Why it's unavailable, or null. */
  readonly whyNot: string | null;
  readonly run: () => void;
}

/** Why the project's files can't be written now (the edit gate, ADR 0247: a read-only project), or null. */
const whyReadOnly = (project: EditorProject, toDo: string) => whyNotEdit({ kind: "project-files", project }, toDo);

// ---- What the panel lists ----

/** The slices of a file whose kind has slices (an image), from its sidecar (ADR 0040, 0149). */
export const slicesOf = (project: EditorProject, image: string) => (hasSlices(assetKind(image)) ? readImportSettings(project, image).settings.sprites : []);

/** The folder a copy of the panel shows: its folder, or the root when that folder is gone (deleted, moved). */
export function shownFolder(project: EditorProject, browser: AssetBrowserView = lastAssetBrowser.value): string {
  const folder = browser.folder.value;
  return folder === "" || project.folders.includes(folder) ? folder : "";
}

/**
 * What a copy of the panel lists: the folder's subfolders then its files (an expanded image's slices
 * after it), or the search results.
 */
export function listedEntries(project: EditorProject, browser: AssetBrowserView = lastAssetBrowser.value): AssetEntry[] {
  // Sidecars (`*.meta.json`) travel with their files and aren't listed (ADR 0040).
  const files = [...listedFiles(project.files), ...project.scripts.keys()];
  const query = browser.query.value;
  if (query.trim()) return searchEntries(files.sort(), query, (image) => slicesOf(project, image).map((s) => s.name));
  const folder = shownFolder(project, browser);
  const expanded = browser.expandedImages.value;
  const byName = (a: string, b: string) => fileName(a).localeCompare(fileName(b));
  const subfolders = project.folders.filter((f) => parentFolder(f) === folder).sort(byName);
  const here = files.filter((f) => folderOf(f) === folder).sort(byName);
  const withSlices = here.flatMap((f) => (expanded.has(f) ? [f, ...slicesOf(project, f).map((s) => sliceEntry(f, s.name))] : [f]));
  return [...subfolders.map(folderEntry), ...withSlices];
}

/** The open project and the last-used panel's selection among what it lists, or null with no project. */
export function panelTarget(): AssetTarget | null {
  const project = currentProject.value;
  if (!project) return null;
  const listed = listedEntries(project);
  return { project, entries: selectedAssets.value.filter((e) => listed.includes(e)) };
}

// ---- The commands ----

const SHORTCUTS: Record<AssetCommandId, string> = { open: "Enter", rename: "F2", duplicate: "Ctrl+D", copy: "Ctrl+C", cut: "Ctrl+X", paste: "Ctrl+V", delete: "Del" };
const LABELS: Record<AssetCommandId, string> = { open: "Open", rename: "Rename", duplicate: "Duplicate", copy: "Copy", cut: "Cut", paste: "Paste", delete: "Delete" };

/** The key a command's menu item shows. */
export const assetShortcut = (id: AssetCommandId) => SHORTCUTS[id];

/** A command's menu label: Open is "Sprite Editor…" for an image with slices, or for slices. */
export function assetCommandLabel(id: AssetCommandId, target: AssetTarget): string {
  if (id !== "open") return LABELS[id];
  const { entries } = target;
  const sliceable = (entries.length > 0 && entries.every(isSliceEntry)) || (entries.length === 1 && !isFolderEntry(entries[0]) && hasSlices(assetKind(entries[0])));
  return sliceable ? "Sprite Editor…" : "Open";
}

/** The command a key press in the panel asks for, or null. Agrees with `assetShortcut` (tested). */
export function assetKeyCommand(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): AssetCommandId | null {
  const key = (e.key ?? "").toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (e.altKey) return null;
    return key === "c" ? "copy" : key === "x" ? "cut" : key === "v" ? "paste" : key === "d" ? "duplicate" : null;
  }
  if (e.altKey) return null;
  if ((key === "delete" || key === "backspace") && !e.shiftKey) return "delete";
  if (key === "f2") return "rename";
  if (key === "enter") return "open";
  return null;
}

/** The folder a paste or New… goes to: a single selected folder, else the target's folder, else the folder showing. */
export function targetFolder(target: AssetTarget): string {
  const files = fileEntries(target.entries);
  if (files.length === 1 && isFolderEntry(files[0])) return entryPath(files[0]);
  return target.folder !== undefined && (target.folder === "" || target.project.folders.includes(target.folder)) ? target.folder : shownFolder(target.project);
}

/** Why the file commands have nothing to act on, or null. */
function whyNoFiles(entries: readonly AssetEntry[]): string | null {
  if (fileEntries(entries).length > 0) return null;
  return entries.length > 0 ? "slices aren't files; select their image" : "select something first";
}

/** True if opening `entry` does something: a folder shows, a file opens as its kind says (ADR 0143, 0233). */
const opens = (entry: AssetEntry) => isFolderEntry(entry) || kindOpens(entry);

/**
 * Why command `id` can't run on `target` now, or null if it can. The one rule for the menu, the
 * keys and the menu bar, and the check its operation makes: Delete is `whyNotDeletable`
 * (`deleteAssets`), Rename and Cut `whyNotMovable` (`moveAssets`), Paste `whyNotPaste`
 * (`pasteAssets`). Every open scene tab is protected.
 */
export function whyNotAsset(id: AssetCommandId, target: AssetTarget): string | null {
  const { project, entries } = target;
  const files = fileEntries(entries);
  switch (id) {
    case "open":
      if (entries.length === 0) return "select something first";
      if (entries.every(isSliceEntry)) return null; // their image opens
      if (entries.length > 1) return "open one at a time";
      return opens(entries[0]) ? null : "this kind of file doesn't open";
    case "copy":
      return whyNoFiles(entries);
    case "cut":
      return whyNoFiles(entries) ?? whyNotMovable(project, files);
    case "rename":
      return whyNoFiles(entries) ?? (files.length > 1 ? "rename one at a time" : whyNotMovable(project, files));
    case "duplicate":
      return whyNoFiles(entries) ?? whyReadOnly(project, "duplicate files");
    case "paste":
      return whyNotPaste(project, targetFolder(target));
    case "delete":
      return whyNoFiles(entries) ?? whyNotDeletable(project, files);
  }
}

/** Select what an operation made, if anything. True if it made something. */
function selectMade(made: readonly string[]): boolean {
  if (made.length > 0) selectAssets([...made]);
  return made.length > 0;
}

/** Start renaming `entry` in place (the panel shows a text field; Enter renames). */
function startRename(entry: AssetEntry): void {
  selectAssets([entry]);
  renamingAsset.value = entry;
}

/**
 * Run command `id` on `target`: when `whyNotAsset` refuses, says why in the status bar; otherwise
 * does it and selects what it made (Duplicate, Paste) or what it acts on (Rename). Resolves to true
 * if it ran (for Delete, if the files were deleted).
 */
export async function runAsset(id: AssetCommandId, target: AssetTarget): Promise<boolean> {
  const reason = whyNotAsset(id, target);
  const files = fileEntries(target.entries);
  if (reason) {
    const what = id === "paste" ? " here" : id === "open" || files.length === 0 ? "" : files.length === 1 ? ` ${fileName(entryPath(files[0]))}` : ` ${files.length} items`;
    status.value = { kind: "info", text: `Can't ${LABELS[id].toLowerCase()}${what}: ${reason}.` };
    return false;
  }
  switch (id) {
    case "open": {
      const entry = target.entries[0];
      if (isFolderEntry(entry)) openFolder(entryPath(entry));
      else openAsset(entry); // a slice opens its image
      return true;
    }
    case "rename":
      startRename(files[0]);
      return true;
    case "copy":
    case "cut":
      assetClipboard.value = { entries: [...files], cut: id === "cut" };
      return true;
    case "duplicate":
      return selectMade(await duplicateAssets(files));
    case "paste":
      return selectMade(await pasteAssets(targetFolder(target)));
    case "delete":
      return deleteAssets(files);
  }
}

// ---- New… and plugins' actions ----

/** Make "New Folder" in `parent`, show `parent`, and start renaming the new folder. */
export async function makeFolder(parent: string): Promise<void> {
  const path = await newFolder(parent);
  if (path === null) return;
  if (parent !== lastAssetBrowser.peek().folder.peek()) openFolder(parent);
  startRename(folderEntry(path));
}

/** A Create item, with the submenu it goes in (ADR 0383). */
export interface AssetCreateItem extends AssetMenuItem {
  readonly category?: string;
}

/**
 * The menu's Create submenu for `target` (no entries: the folder showing; a folder: in it), arranged in categories
 * (ADR 0383): Folder, Scene and Script… at the top, then each kind's New… entry (which the asset kind host creates,
 * ADR 0233) under the category its `create` names, labelled without "New ", sorted; one naming none goes in Other.
 * What's made is selected.
 */
export function assetCreateItems(target: AssetTarget): CategorisedEntry<AssetCreateItem>[] {
  const { project } = target;
  const whyNot = whyReadOnly(project, "add files");
  const folder = targetFolder(target);
  return categorise<AssetCreateItem>([
    { label: "Folder", whyNot, run: () => void makeFolder(folder) },
    // Every file entry is a registered kind's `create`; a scene is the one the top level keeps.
    ...kindCreators().map((c) => ({
      label: c.label.replace(/^New /, ""),
      category: c.kind === "scene" ? undefined : c.category || OTHER_CATEGORY,
      whyNot,
      run: () => void c.create(folder).then((made) => made && selectAssets([made])),
    })),
    ...(project.root !== null ? [{ label: "Script…", whyNot, run: () => void newScript({ assetFolder: folder }) }] : []),
  ]);
}

/** The targets plugins' actions get: the selected slices, when only slices are selected; otherwise the selected files and folders. */
function actionTargets(entries: readonly AssetEntry[]): AssetActionTarget[] {
  if (entries.length > 0 && entries.every(isSliceEntry)) return entries.map((e) => ({ path: splitSliceEntry(e).image, slice: splitSliceEntry(e).slice }));
  return fileEntries(entries).map((path) => ({ path }));
}

/** Plugins' actions that apply to `target` (ADR 0146: Create Tileset from Slices); one that writes is unavailable read-only. What it makes is selected. */
export function assetPluginItems(target: AssetTarget): AssetMenuItem[] {
  const { project } = target;
  const targets = actionTargets(target.entries);
  if (targets.length === 0) return [];
  const readOnly = whyReadOnly(project, "change its files");
  return assetActions
    .list()
    .filter((a) => a.appliesTo(project, targets))
    .map((a) => ({ label: a.label, whyNot: a.writes ? readOnly : null, run: () => void a.run(project, targets).then(selectMade) }));
}
