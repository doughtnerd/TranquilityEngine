// The Assets panel's commands (ADR 0157): Open, Rename, Duplicate, Copy, Cut, Paste and Delete, the
// New… items and plugins' asset actions (ADR 0146). Each command says why it isn't available (one
// rule, the check its operation makes), runs, and selects what it made. The panel's context menu,
// its keys and the menu bar's Edit items only map gestures onto these. Also what the panel lists,
// so the menu bar can act on the panel's selection.
import { fileName, folderOf, listedFiles, searchEntries } from "./assetBrowser";
import { whyNotDeletable, deleteAssets } from "./assetDelete";
import { entryPath, fileEntries, folderEntry, isFolderEntry, isSliceEntry, sliceEntry, splitSliceEntry, type AssetEntry } from "./assetEntry";
import { readImportSettings } from "./assetImport";
import { assetKind, hasSlices, kindCreators, kindOpens, openAsset } from "./assetKindLookup";
import { assetClipboard, duplicateAssets, newFolder, pasteAssets, whyNotMovable, whyNotPaste } from "./assetOps";
import { assetQuery, folderPath, openFolder, parentFolder, renamingAsset, select, selectedAssets } from "./assetSelection";
import { signal } from "@preact/signals";
import { newScript } from "./newScript";
import type { EditorProject } from "./projects";
import { assetActions, type AssetActionTarget } from "./sdk/contributions";
import { currentProject, status } from "./state";

/** What a command acts on: the entries right-clicked, or the panel's selection (`panelTarget`). */
export interface AssetTarget {
  readonly project: EditorProject;
  readonly entries: readonly AssetEntry[];
}

export type AssetCommandId = "open" | "rename" | "duplicate" | "copy" | "cut" | "paste" | "delete";

/** An item the panel's menu shows that isn't one of the commands: New… and plugins' actions. */
export interface AssetMenuItem {
  readonly label: string;
  /** Why it's unavailable, or null. */
  readonly whyNot: string | null;
  readonly run: () => void;
}

// ---- What the panel lists ----

/** Images whose slices are listed under them (ADR 0040). */
export const expandedImages = signal<ReadonlySet<string>>(new Set());

/** The slices of a file whose kind has slices (an image), from its sidecar (ADR 0040, 0149). */
export const slicesOf = (project: EditorProject, image: string) => (hasSlices(assetKind(image)) ? readImportSettings(project, image).settings.sprites : []);

/** The folder showing: `folderPath`, or the root when that folder is gone (deleted, moved). */
export const shownFolder = (project: EditorProject) => (folderPath.value === "" || project.folders.includes(folderPath.value) ? folderPath.value : "");

/** What the panel lists: the folder's subfolders then its files (an expanded image's slices after it), or the search results. */
export function listedEntries(project: EditorProject, folder: string, query: string): AssetEntry[] {
  // Sidecars (`*.meta.json`) travel with their files and aren't listed (ADR 0040).
  const files = [...listedFiles(project.files), ...project.scripts.keys()];
  if (query.trim()) return searchEntries(files.sort(), query, (image) => slicesOf(project, image).map((s) => s.name));
  const byName = (a: string, b: string) => fileName(a).localeCompare(fileName(b));
  const subfolders = project.folders.filter((f) => parentFolder(f) === folder).sort(byName);
  const here = files.filter((f) => folderOf(f) === folder).sort(byName);
  const withSlices = here.flatMap((f) => (expandedImages.value.has(f) ? [f, ...slicesOf(project, f).map((s) => sliceEntry(f, s.name))] : [f]));
  return [...subfolders.map(folderEntry), ...withSlices];
}

/** The open project and the panel's selection among what it lists, or null with no project. */
export function panelTarget(): AssetTarget | null {
  const project = currentProject.value;
  if (!project) return null;
  const listed = listedEntries(project, shownFolder(project), assetQuery.value);
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

/** The folder a paste or New… goes to: a single selected folder, else the folder showing. */
function targetFolder(entries: readonly AssetEntry[]): string {
  const files = fileEntries(entries);
  return files.length === 1 && isFolderEntry(files[0]) ? entryPath(files[0]) : folderPath.value;
}

/** Why the file commands have nothing to act on, or null. */
function whyNoFiles(entries: readonly AssetEntry[]): string | null {
  if (fileEntries(entries).length > 0) return null;
  return entries.length > 0 ? "slices aren't files; select their image" : "select something first";
}

/** True if opening `entry` does something: a folder shows, a file opens as its kind says (ADR 0143). */
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
      return whyNoFiles(entries) ?? (project.canSave ? null : "this project is read-only");
    case "paste":
      return whyNotPaste(project, targetFolder(entries));
    case "delete":
      return whyNoFiles(entries) ?? whyNotDeletable(project, files);
  }
}

/** Select what an operation made, if anything. True if it made something. */
function selectMade(made: readonly string[]): boolean {
  if (made.length > 0) select([...made]);
  return made.length > 0;
}

/** Start renaming `entry` in place (the panel shows a text field; Enter renames). */
function startRename(entry: AssetEntry): void {
  select([entry]);
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
      return selectMade(await pasteAssets(targetFolder(target.entries)));
    case "delete":
      return deleteAssets(files);
  }
}

// ---- New… and plugins' actions ----

/** Make "New Folder" in `parent`, show `parent`, and start renaming the new folder. */
export async function makeFolder(parent: string): Promise<void> {
  const path = await newFolder(parent);
  if (path === null) return;
  if (parent !== folderPath.value) openFolder(parent);
  startRename(folderEntry(path));
}

/** The menu's New… items for `target` (empty: the folder showing; a folder: in it): New Folder, each kind's `create` (ADR 0149), New Script…. */
export function assetCreateItems(target: AssetTarget): AssetMenuItem[] {
  const { project } = target;
  const whyNot = project.canSave ? null : "this project is read-only";
  const folder = targetFolder(target.entries);
  return [
    { label: "New Folder", whyNot, run: () => void makeFolder(folder) },
    // Every file entry is a registered kind's `create`, core kinds' (scenes, render textures) first (ADR 0149).
    ...kindCreators().map((c) => ({ label: c.label, whyNot, run: () => void c.create(folder).then((made) => made && select([made])) })),
    ...(project.root !== null ? [{ label: "New Script…", whyNot, run: () => void newScript({ assetFolder: folder }) }] : []),
  ];
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
  const readOnly = project.canSave ? null : "this project is read-only";
  return assetActions
    .list()
    .filter((a) => a.appliesTo(project, targets))
    .map((a) => ({ label: a.label, whyNot: a.writes ? readOnly : null, run: () => void a.run(project, targets).then(selectMade) }));
}
