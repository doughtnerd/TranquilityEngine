import { errorStatus } from "../messages";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { addAssetToScene, assetKind, canAddToScene, prepareAssets, fileName, folderOf, isSliceEntry, listedFiles, opensInCodePanel, searchEntries, sliceEntry, splitSliceEntry, type AssetKind } from "../assetBrowser";
import { inspectSelectedAsset, openSpriteEditor, readImportSettings } from "../assetImport";
import { assetDrag, startAssetDrag } from "../assetDrag";
import { deleteAssets, entryPath, isFolderEntry, whyNotDeletableAsset, whyNotDeletableFolder } from "../assetDelete";
import { assetClipboard, duplicateAssets, newFolder, pasteAssets, renameAsset, splitExtension } from "../assetOps";
import {
  assetAnchor,
  assetCursor,
  assetQuery,
  boxSelection,
  canGoBack,
  canGoForward,
  clickSelection,
  folderPath,
  goBack,
  goForward,
  historyVersion,
  moveCursor,
  openFolder,
  parentFolder,
  renamingAsset,
  select,
  selectedAssets,
  type Modifiers,
} from "../assetSelection";
import { openScript } from "../code/codeState";
import { installOsDrop, osDragFolder, osDragOver } from "../osDrop";
import { newScript, scriptFolderFor } from "../newScript";
import { createScene } from "../newScene";
import { createMaterial, createShader } from "../materialAssets";
import { createUIDocument } from "../uiDocumentEdits";
import { createFormation } from "../formationAssets";
import { createTileset, createTilesetFromSlices, hasSlices } from "../tilesetAssets";
import { createParticleEffect, openParticleGraphAsset } from "../particleAssets";
import { createSky, openSkyAsset } from "../skyAssets";
import { createShaderGraph, createShaderSubGraph, openShaderGraphAsset } from "../shaderGraphAssets";
import { assetTileSize, assetView } from "../preferences";
import { joinPath, type EditorProject } from "../projects";
import { switchScene } from "../session";
import { currentProject, docVersion, openScene, playState, sceneCamera, scriptsVersion, selection, status } from "../state";
import { TileThumbnail } from "./AssetPreview";
import "./assets.css";
import "./assetSlices.css";

const KIND_LABELS: Record<AssetKind | "folder", string> = {
  folder: "Folder",
  scene: "Scene",
  prefab: "Prefab",
  image: "Image",
  sprite: "Sprite",
  environment: "Environment",
  sky: "Sky",
  cubemap: "Cubemap",
  audio: "Audio",
  model: "Model",
  material: "Material",
  shadergraph: "Shader Graph",
  shadersubgraph: "Sub Graph",
  particles: "Particle Effect",
  formation: "Formation",
  tileset: "Tileset",
  json: "JSON",
  script: "Script",
  javascript: "JS",
  typescript: "TS Module",
  text: "Text",
  uidocument: "UI Document",
  stylesheet: "Stylesheet",
  xml: "XML",
  other: "File",
};

/** The open context menu: where, and its items. */
interface MenuItem {
  label: string;
  shortcut?: string;
  /** Why it's unavailable, or null/false/undefined when it is. */
  disabled?: string | false | null;
  run?: () => void;
  separator?: boolean;
}
const menu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);

/** Images whose slices are listed under them (ADR 0040). */
const expandedImages = signal<ReadonlySet<string>>(new Set());

/** The slices of an image, from its sidecar (ADR 0040). */
const slicesOf = (project: EditorProject, image: string) => (assetKind(image) === "image" ? readImportSettings(project, image).settings.sprites : []);

/** Entries that are files or folders: slices are listed, but they aren't files to rename, move, copy or delete. */
const fileEntries = (entries: readonly string[]) => entries.filter((e) => !isSliceEntry(e));

/** The selection box while dragging on empty space, in client pixels. */
const box = signal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

/** True while a drag would drop on the folder `path`. */
const dropTarget = (path: string) => {
  if (osDragFolder.value === path) return true;
  const t = assetDrag.value?.target;
  return t?.kind === "folder" && t.folder === path;
};

const kindOf = (entry: string): AssetKind | "folder" => (isFolderEntry(entry) ? "folder" : assetKind(entry));
const nameOf = (entry: string) => (isSliceEntry(entry) ? splitSliceEntry(entry).slice : fileName(entryPath(entry)));
const toggleKey = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

/** What the panel lists: the folder's subfolders then its files, or the search results. */
function listedEntries(project: EditorProject, folder: string, query: string): string[] {
  // Sidecars (`*.meta.json`) travel with their files and aren't listed (ADR 0040).
  const files = [...listedFiles(project.files), ...project.scripts.keys()];
  if (query.trim()) return searchEntries(files.sort(), query, (image) => slicesOf(project, image).map((s) => s.name));
  const subfolders = project.folders.filter((f) => parentFolder(f) === folder).sort((a, b) => fileName(a).localeCompare(fileName(b)));
  const here = files.filter((f) => folderOf(f) === folder).sort((a, b) => fileName(a).localeCompare(fileName(b)));
  // An expanded image's slices follow it.
  const withSlices = here.flatMap((f) => (expandedImages.value.has(f) ? [f, ...slicesOf(project, f).map((s) => sliceEntry(f, s.name))] : [f]));
  return [...subfolders.map((f) => `${f}/`), ...withSlices];
}

/** Open an entry: a folder shows, scenes and prefabs open in the scene view, code files in the Code panel. */
function openEntry(entry: string): void {
  if (isFolderEntry(entry)) return openFolder(entryPath(entry));
  if (isSliceEntry(entry)) return openSpriteEditor(splitSliceEntry(entry).image);
  const kind = assetKind(entry);
  if (kind === "image") return openSpriteEditor(entry);
  if (kind === "shadergraph" || kind === "shadersubgraph") return openShaderGraphAsset(entry);
  if (kind === "particles") return openParticleGraphAsset(entry);
  if (kind === "sky") return openSkyAsset(entry);
  if (opensInCodePanel(kind)) openScript(entry);
  else if (kind === "scene" || kind === "prefab") void switchScene(entry);
}

const opens = (entry: string) => isFolderEntry(entry) || opensInCodePanel(assetKind(entry)) || ["scene", "prefab", "image", "sprite", "shadergraph", "shadersubgraph", "particles", "sky"].includes(assetKind(entry));

/** Why `entries` can't be changed (renamed, moved, deleted), or null. */
function whyNotEditable(project: EditorProject, entries: readonly string[]): string | null {
  const open = openScene.value?.path ?? null;
  for (const e of entries) {
    const reason = isFolderEntry(e) ? whyNotDeletableFolder(project, entryPath(e), open) : whyNotDeletableAsset(project, e, open);
    if (reason) return reason;
  }
  return entries.length === 0 ? "select something first" : null;
}

/** The folder a paste goes to: a single selected folder, else the folder showing. */
const pasteFolder = (entries: readonly string[]) => (entries.length === 1 && isFolderEntry(entries[0]) ? entryPath(entries[0]) : folderPath.value);

function startRename(entry: string): void {
  select([entry]);
  renamingAsset.value = entry;
}

async function makeFolder(parent: string): Promise<void> {
  const path = await newFolder(parent);
  if (path === null) return;
  if (parent !== folderPath.value) openFolder(parent);
  startRename(`${path}/`);
}

/** The menu for `entries` (empty: the folder showing's background). */
function menuItems(project: EditorProject, entries: readonly string[]): MenuItem[] {
  const readOnly = project.canSave ? null : "this project is read-only";
  const fs = project.fileSystem;
  const reveal = (path: string) => () => void fs!.reveal!(joinPath(project.root!, path)).catch((err) => (status.value = errorStatus(`Couldn't show ${path}`, err)));
  const clip = assetClipboard.value;
  const paste: MenuItem = {
    label: "Paste",
    shortcut: "Ctrl+V",
    disabled: readOnly ?? (clip ? null : "nothing copied"),
    run: () => void pasteAssets(pasteFolder(entries)).then((made) => made.length > 0 && select(made)),
  };
  const newItems: MenuItem[] = [
    { label: "New Folder", disabled: readOnly, run: () => void makeFolder(pasteFolder(entries)) },
    { label: "New Scene", disabled: readOnly, run: () => void createScene(pasteFolder(entries)) },
    { label: "New UI Document", disabled: readOnly, run: () => void createUIDocument(pasteFolder(entries)).then((made) => made && select([made])) },
    { label: "New Material", disabled: readOnly, run: () => void createMaterial(pasteFolder(entries)).then((made) => made && select([made])) },
    { label: "New Shader", disabled: readOnly, run: () => void createShader(pasteFolder(entries)).then((made) => made && select([made])) },
    { label: "New Shader Graph", disabled: readOnly, run: () => void createShaderGraph(pasteFolder(entries)).then((made) => made && select([made])) },
    { label: "New Particle Effect", disabled: readOnly, run: () => void createParticleEffect(pasteFolder(entries)).then((made) => made && select([made])) },
    // The menu has no submenus, so New Sky makes the default preset; the Sky panel switches presets.
    { label: "New Sky", disabled: readOnly, run: () => void createSky(pasteFolder(entries)).then((made) => made && select([made])) },
    { label: "New Shader Sub Graph", disabled: readOnly, run: () => void createShaderSubGraph(pasteFolder(entries)).then((made) => made && select([made])) },
    // Create › Navigation › Formation (Foxfire's NavFormation asset, ADR 0065).
    { label: "New Navigation Formation", disabled: readOnly, run: () => void createFormation(pasteFolder(entries)).then((made) => made && select([made])) },
    { label: "New Tileset", disabled: readOnly, run: () => void createTileset(pasteFolder(entries)).then((made) => made && select([made])) },
    ...(project.root !== null ? [{ label: "New Script…", disabled: readOnly, run: () => void newScript({ assetFolder: pasteFolder(entries) }) }] : []),
  ];
  if (entries.length === 0) {
    return [
      ...newItems,
      { label: "", separator: true },
      paste,
      ...(fs?.reveal && project.root ? [{ label: "Show in File Manager", run: reveal(folderPath.value) }] : []),
    ];
  }
  if (entries.every(isSliceEntry)) {
    const image = splitSliceEntry(entries[0]).image;
    return [
      { label: "Sprite Editor…", shortcut: "Enter", run: () => openSpriteEditor(image) },
      { label: "Create Tileset from Slices", disabled: readOnly, run: () => void createTilesetFromSlices(folderOf(image), image).then((made) => made && select([made])) },
    ];
  }
  entries = fileEntries(entries);
  const editable = whyNotEditable(project, entries);
  const sliceable = entries.length === 1 && assetKind(entries[0]) === "image";
  const tileable = sliceable && hasSlices(project, entries[0]);
  return [
    ...(entries.length === 1 && opens(entries[0]) ? [{ label: sliceable ? "Sprite Editor…" : "Open", shortcut: "Enter", run: () => openEntry(entries[0]) }] : []),
    ...(tileable ? [{ label: "Create Tileset from Slices", disabled: readOnly, run: () => void createTilesetFromSlices(folderOf(entries[0]), entries[0]).then((made) => made && select([made])) }] : []),
    { label: "Rename", shortcut: "F2", disabled: entries.length > 1 ? "rename one at a time" : editable, run: () => startRename(entries[0]) },
    { label: "Duplicate", shortcut: "Ctrl+D", disabled: readOnly, run: () => void duplicateAssets(entries).then((made) => made.length > 0 && select(made)) },
    { label: "", separator: true },
    { label: "Copy", shortcut: "Ctrl+C", run: () => (assetClipboard.value = { entries: [...entries], cut: false }) },
    { label: "Cut", shortcut: "Ctrl+X", disabled: editable, run: () => (assetClipboard.value = { entries: [...entries], cut: true }) },
    paste,
    { label: "", separator: true },
    { label: "Delete", shortcut: "Del", disabled: editable, run: () => void deleteAssets(entries) },
    ...(entries.length === 1 && isFolderEntry(entries[0]) ? [{ label: "", separator: true }, ...newItems] : []),
    ...(entries.length === 1 && fs?.reveal && project.root ? [{ label: "", separator: true }, { label: "Show in File Manager", run: reveal(entryPath(entries[0])) }] : []),
  ];
}

/**
 * The project's files (ADR 0022) as a file browser: a folder tree, a path bar with Back, Forward
 * and Up, and the folder's subfolders and files as a grid of tiles (image thumbnails, adjustable
 * size) or a list with kind and size. Click, Ctrl/Cmd+click, Shift+click, a box dragged on empty
 * space and the arrow keys select; double-click or Enter opens. Files and folders can be renamed
 * (F2), dragged onto folders to move them, duplicated (Ctrl+D), copied or cut and pasted
 * (Ctrl+C/X/V) and deleted (Delete), several at once; a right-click menu has the same. Dragging
 * assets into the viewport or hierarchy adds them to the scene, and a tile's + adds one.
 */
export function AssetsPanel() {
  useEffect(() => installOsDrop(), []); // files dragged in from the OS (ADR 0085)
  docVersion.value; // the project's file list can change after saves
  scriptsVersion.value; // and its scripts after a reload
  historyVersion.value;
  const project = currentProject.value;
  if (!project) return <p class="empty">No project open</p>;
  // A folder that's gone (deleted, moved) shows the root instead.
  const folder = folderPath.value === "" || project.folders.includes(folderPath.value) ? folderPath.value : "";
  const query = assetQuery.value;
  const searching = query.trim() !== "";
  const entries = listedEntries(project, folder, query);
  const selected = selectedAssets.value.filter((e) => entries.includes(e));
  return (
    <div class={`asset-browser${osDragOver.value ? " os-drop" : ""}`}>
      <nav class="asset-tree" aria-label="Folders">
        <ul role="tree">
          <FolderItem project={project} folders={project.folders} path="" label={project.name} depth={0} current={searching ? null : folder} />
        </ul>
      </nav>
      <div class="asset-main">
        <div class="asset-bar">
          <div class="asset-nav" role="group" aria-label="Navigation">
            <button aria-label="Back" title="Back (Alt+←)" disabled={!canGoBack()} onClick={goBack}>
              ←
            </button>
            <button aria-label="Forward" title="Forward (Alt+→)" disabled={!canGoForward()} onClick={goForward}>
              →
            </button>
            <button aria-label="Up" title="Up a folder (Alt+↑)" disabled={folder === "" || searching} onClick={() => openFolder(parentFolder(folder) ?? "")}>
              ↑
            </button>
          </div>
          <Breadcrumbs project={project} folder={folder} searching={searching ? query.trim() : null} />
          <input
            type="search"
            class="asset-search"
            placeholder="Search assets"
            aria-label="Search assets"
            value={query}
            onInput={(e) => (assetQuery.value = (e.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <div class="asset-bar asset-actions">
          {project.root !== null && (
            <>
              <button disabled={!project.canSave} title="Make a folder here" onClick={() => void makeFolder(folder)}>
                New Folder
              </button>
              <button
                class="new-script-button"
                disabled={!project.canSave}
                title={project.canSave ? `Write a new script in ${scriptFolderFor(folder)}/ (ADR 0030)` : "This project is read-only."}
                onClick={() => void newScript({ assetFolder: folder })}
              >
                New Script
              </button>
              <DeleteButton project={project} selected={selected} />
            </>
          )}
          <span class="asset-spacer" />
          {assetView.value === "grid" && (
            <input
              type="range"
              class="asset-size"
              aria-label="Tile size"
              title="Tile size"
              min={40}
              max={128}
              step={4}
              value={assetTileSize.value}
              onInput={(e) => (assetTileSize.value = Number((e.currentTarget as HTMLInputElement).value))}
            />
          )}
          <div class="asset-view-toggle" role="group" aria-label="View">
            <button aria-pressed={assetView.value === "grid"} class={assetView.value === "grid" ? "active" : ""} onClick={() => (assetView.value = "grid")}>
              Grid
            </button>
            <button aria-pressed={assetView.value === "list"} class={assetView.value === "list" ? "active" : ""} onClick={() => (assetView.value = "list")}>
              List
            </button>
          </div>
        </div>
        <AssetItems project={project} entries={entries} selected={selected} searching={searching} />
      </div>
      <ContextMenu />
    </div>
  );
}

function Breadcrumbs(props: { project: EditorProject; folder: string; searching: string | null }) {
  const { project, folder, searching } = props;
  if (searching !== null) return <span class="asset-crumb">Results for “{searching}”</span>;
  const parts = folder === "" ? [] : folder.split("/");
  return (
    <nav class="asset-crumb" aria-label="Folder path">
      <button class={`crumb${dropTarget("") ? " drop-target" : ""}`} data-drop-folder="" onClick={() => openFolder("")}>
        {project.name}
      </button>
      {parts.map((part, i) => {
        const path = parts.slice(0, i + 1).join("/");
        return (
          <span key={path}>
            <span class="crumb-sep">/</span>
            <button class={`crumb${dropTarget(path) ? " drop-target" : ""}`} data-drop-folder={path} aria-current={i === parts.length - 1 ? "page" : undefined} onClick={() => openFolder(path)}>
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function FolderItem(props: { project: EditorProject; folders: readonly string[]; path: string; label: string; depth: number; current: string | null }) {
  // `folders` is passed (rather than read from the project) so the tree re-renders when they change.
  const { project, folders, path, label, depth, current } = props;
  const children = folders.filter((f) => parentFolder(f) === path).sort((a, b) => fileName(a).localeCompare(fileName(b)));
  const isCurrent = current === path;
  return (
    <li role="treeitem" aria-selected={isCurrent}>
      <button
        class={`asset-folder${isCurrent ? " current" : ""}${dropTarget(path) ? " drop-target" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        data-drop-folder={path}
        onClick={() => openFolder(path)}
        onContextMenu={(e) => {
          e.preventDefault();
          const items = path === "" ? menuItems(project, []) : menuItems(project, [`${path}/`]);
          menu.value = { x: e.clientX, y: e.clientY, items };
        }}
      >
        {label}
      </button>
      {children.length > 0 && (
        <ul role="group">
          {children.map((f) => (
            <FolderItem key={f} project={project} folders={folders} path={f} label={fileName(f)} depth={depth + 1} current={current} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Delete the selection (asking first); disabled, with the reason, when it can't be. */
function DeleteButton(props: { project: EditorProject; selected: readonly string[] }) {
  const { project } = props;
  const selected = fileEntries(props.selected);
  const reason = whyNotEditable(project, selected);
  const what = selected.length === 1 ? entryPath(selected[0]) : `${selected.length} items`;
  return (
    <button class="delete-asset-button" disabled={reason !== null} title={reason ? `Can't delete: ${reason}` : `Delete ${what} from disk (Delete)`} onClick={() => void deleteAssets(selected)}>
      Delete
    </button>
  );
}

/** The grid or list of entries, with selection by click, box and keyboard. */
function AssetItems(props: { project: EditorProject; entries: string[]; selected: string[]; searching: boolean }) {
  const { project, entries, selected, searching } = props;
  const list = useRef<HTMLUListElement>(null);
  const view = assetView.value;

  /** Columns in the grid, from the tiles' positions (1 in the list view). */
  const columns = () => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>(".asset-item") ?? [])];
    if (view === "list" || items.length === 0) return 1;
    const top = items[0].offsetTop;
    return Math.max(1, items.filter((el) => el.offsetTop === top).length);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const listed = selectedAssets.value.filter((x) => entries.includes(x));
    const sel = fileEntries(listed);
    const handled = () => {
      e.preventDefault();
      e.stopPropagation(); // not the editor's shortcuts (Delete would delete the scene's selection)
    };
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp")) {
      handled();
      if (e.key === "ArrowLeft") goBack();
      else if (e.key === "ArrowRight") goForward();
      else if (folderPath.value !== "") openFolder(parentFolder(folderPath.value) ?? "");
      return;
    }
    const next = moveCursor(entries, assetCursor.value, e.key, columns());
    if (next !== null) {
      handled();
      if (e.shiftKey && assetAnchor.value) select(clickSelection(entries, sel, assetAnchor.value, next, { shift: true, toggle: false }).selected, next, assetAnchor.value);
      else select([next]);
      inspectSelectedAsset();
      list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(next)}"]`)?.focus();
      return;
    }
    const key = (e.key ?? "").toLowerCase();
    if (toggleKey(e) && !e.altKey) {
      if (key === "a") return (handled(), select(entries, assetCursor.value));
      if (key === "c" && sel.length > 0) return (handled(), (assetClipboard.value = { entries: sel, cut: false }));
      if (key === "x" && sel.length > 0 && !whyNotEditable(project, sel)) return (handled(), (assetClipboard.value = { entries: sel, cut: true }));
      if (key === "v" && assetClipboard.value && project.canSave) return (handled(), void pasteAssets(pasteFolder(sel)).then((made) => made.length > 0 && select(made)));
      if (key === "d" && sel.length > 0 && project.canSave) return (handled(), void duplicateAssets(sel).then((made) => made.length > 0 && select(made)));
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !e.shiftKey && sel.length > 0) return (handled(), void deleteAssets(sel));
    if (e.key === "F2" && sel.length === 1 && !whyNotEditable(project, sel)) return (handled(), startRename(sel[0]));
    if (e.key === "Enter" && listed.length === 1) return (handled(), openEntry(listed[0]));
    if (e.key === "Escape" && listed.length > 0) return (handled(), select([]));
  };

  /** Press on empty space: drag a selection box (Shift adds, Ctrl/Cmd toggles); a click clears the selection. */
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".asset-item")) return;
    const el = list.current!;
    el.focus();
    const before = selectedAssets.value.filter((x) => entries.includes(x));
    const mods: Modifiers = { shift: e.shiftKey, toggle: toggleKey(e) };
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    const move = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
      moved = true;
      const r = { left: Math.min(x0, m.clientX), right: Math.max(x0, m.clientX), top: Math.min(y0, m.clientY), bottom: Math.max(y0, m.clientY) };
      box.value = { x0, y0, x1: m.clientX, y1: m.clientY };
      const hits = [...el.querySelectorAll<HTMLElement>(".asset-item")]
        .filter((item) => {
          const b = item.getBoundingClientRect();
          return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
        })
        .map((item) => item.dataset.entry!);
      select(boxSelection(before, hits, mods));
    };
    const finish = (keep: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      box.value = null;
      if (!keep) select(before);
      else if (!moved && !mods.shift && !mods.toggle) select([]);
    };
    const up = () => finish(true);
    const key = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
  };

  const b = box.value;
  const host = list.current?.getBoundingClientRect();
  return (
    <div class="asset-items-wrap">
      <ul
        ref={list}
        class={`asset-items asset-${view}`}
        style={{ "--tile": `${assetTileSize.value}px` }}
        role="listbox"
        aria-label="Assets"
        aria-multiselectable="true"
        tabIndex={entries.length === 0 ? 0 : -1}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".asset-item")) return;
          e.preventDefault();
          select([]);
          menu.value = { x: e.clientX, y: e.clientY, items: menuItems(project, []) };
        }}
      >
        {view === "list" && entries.length > 0 && (
          <li class="asset-list-head" aria-hidden="true">
            <span />
            <span>Name</span>
            <span>Kind</span>
            <span>Size</span>
          </li>
        )}
        {entries.map((entry) => (
          <AssetItem key={entry} project={project} entry={entry} entries={entries} selected={selected.includes(entry)} showFolder={searching} />
        ))}
        {entries.length === 0 && <li class="empty">{searching ? "No matching assets" : "This folder is empty"}</li>}
      </ul>
      {b && host && (
        <div
          class="asset-box"
          style={{
            left: `${Math.min(b.x0, b.x1) - host.left}px`,
            top: `${Math.min(b.y0, b.y1) - host.top}px`,
            width: `${Math.abs(b.x1 - b.x0)}px`,
            height: `${Math.abs(b.y1 - b.y0)}px`,
          }}
        />
      )}
    </div>
  );
}

const formatSize = (bytes: number | undefined) =>
  bytes === undefined ? "—" : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function AssetItem(props: { project: EditorProject; entry: string; entries: string[]; selected: boolean; showFolder: boolean }) {
  const { project, entry, entries, selected, showFolder } = props;
  const kind = kindOf(entry);
  const path = entryPath(entry);
  const slice = isSliceEntry(entry) ? splitSliceEntry(entry) : null;
  const url = isFolderEntry(entry) ? undefined : project.assets.get(slice ? slice.image : path);
  const sliceRect = slice ? slicesOf(project, slice.image).find((s) => s.name === slice.slice)?.rect : undefined;
  const sliceCount = kind === "image" ? slicesOf(project, path).length : 0;
  const expanded = expandedImages.value.has(path);
  const open = openScene.value?.path === entry;
  const cut = !!assetClipboard.value?.cut && assetClipboard.value.entries.includes(entry);
  const addable = !isFolderEntry(entry) && canAddToScene(entry);
  const canAdd = addable && !!openScene.value && playState.value === "edit" && openScene.value.path !== entry;
  const press = useRef<{ x: number; y: number } | null>(null);
  const list = assetView.value === "list";
  return (
    <li
      class={`asset-item asset-tile kind-${kind}${selected ? " selected" : ""}${open ? " open" : ""}${cut ? " cut" : ""}${isFolderEntry(entry) && dropTarget(path) ? " drop-target" : ""}`}
      role="option"
      aria-selected={selected}
      data-entry={entry}
      {...(isFolderEntry(entry) ? { "data-drop-folder": path } : {})}
      title={`${path}${opens(entry) ? " (double-click to open)" : ""}${addable ? "; drag into the viewport or hierarchy to add" : ""}`}
      tabIndex={selected || (assetCursor.value === entry) ? 0 : -1}
      onPointerDown={(e) => {
        press.current = { x: e.clientX, y: e.clientY };
        const sel = selectedAssets.value.filter((x) => entries.includes(x));
        if (e.button === 2) {
          if (!sel.includes(entry)) select([entry]);
          return;
        }
        if (e.button !== 0 || renamingAsset.value === entry) return;
        // A plain press on an unselected item selects it alone, so dragging it drags just it.
        if (!e.shiftKey && !toggleKey(e) && !sel.includes(entry)) select([entry]);
        if (e.shiftKey || toggleKey(e)) return;
        startAssetDrag(e, selectedAssets.value.filter((x) => entries.includes(x)));
      }}
      onClick={(e) => {
        const start = press.current;
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 5) return; // a drag, not a click
        const sel = selectedAssets.value.filter((x) => entries.includes(x));
        const mods = { shift: e.shiftKey, toggle: toggleKey(e) };
        const next = clickSelection(entries, sel, assetAnchor.value, entry, mods);
        select(next.selected, entry, next.anchor);
        // Selecting one asset with an inspector shows it, in place of the selected node (ADR 0040).
        inspectSelectedAsset();
      }}
      onDblClick={() => openEntry(entry)}
      onContextMenu={(e) => {
        e.preventDefault();
        const sel = selectedAssets.value.filter((x) => entries.includes(x));
        menu.value = { x: e.clientX, y: e.clientY, items: menuItems(project, sel.includes(entry) ? sel : [entry]) };
      }}
    >
      <div class="asset-thumb">
        {kind === "image" && typeof url === "string" ? (
          <img src={url} alt="" draggable={false} />
        ) : slice && sliceRect && typeof url === "string" ? (
          <SliceThumb url={url} rect={sliceRect} />
        ) : (
          <TileThumbnail path={path} kind={kind} label={KIND_LABELS[kind]} name={nameOf(entry)} />
        )}
      </div>
      {sliceCount > 0 && (
        <button
          class={`asset-expand${expanded ? " expanded" : ""}`}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} the slices of ${nameOf(entry)}`}
          title={`${sliceCount} slice${sliceCount === 1 ? "" : "s"}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const next = new Set(expandedImages.value);
            if (expanded) next.delete(path);
            else next.add(path);
            expandedImages.value = next;
          }}
        >
          {expanded ? "▾" : "▸"} {sliceCount}
        </button>
      )}
      {renamingAsset.value === entry ? <RenameInput entry={entry} /> : <span class="asset-name">{nameOf(entry)}</span>}
      {list && <span class="asset-col-kind">{KIND_LABELS[kind]}</span>}
      {list && <span class="asset-col-size">{isFolderEntry(entry) ? "" : formatSize(project.sizeOf(path))}</span>}
      {showFolder && !list && <span class="asset-folder-hint">{folderOf(path) || "/"}</span>}
      {addable && (
        <button
          class="asset-add"
          disabled={!canAdd}
          title={canAdd ? `Add ${nameOf(entry)} to the scene` : "Open a scene (and stop playing) to add assets"}
          aria-label={`Add ${nameOf(entry)} to the scene`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void addToScene(entry);
          }}
        >
          +
        </button>
      )}
    </li>
  );
}

/** Natural sizes of images by URL, for slice thumbnails. */
const imageSizes = new Map<string, [number, number]>();

/** A slice's part of its image, scaled to fit the thumbnail (ADR 0040). */
function SliceThumb(props: { url: string; rect: readonly [number, number, number, number] }) {
  const { url, rect } = props;
  const [size, setSize] = useState(imageSizes.get(url) ?? null);
  useEffect(() => {
    if (size) return;
    const img = new Image();
    img.onload = () => {
      imageSizes.set(url, [img.naturalWidth, img.naturalHeight]);
      setSize([img.naturalWidth, img.naturalHeight]);
    };
    img.src = url;
  }, [url]);
  if (!size) return null;
  // An SVG viewBox on the slice's rectangle scales just that part to the thumbnail.
  return (
    <svg class="asset-slice-thumb" viewBox={`${rect[0]} ${rect[1]} ${rect[2]} ${rect[3]}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <image href={url} width={size[0]} height={size[1]} style={{ imageRendering: "pixelated" }} />
    </svg>
  );
}

/** Renaming in place: Enter or leaving the field renames, Escape cancels. */
function RenameInput(props: { entry: string }) {
  const { entry } = props;
  const input = useRef<HTMLInputElement>(null);
  const name = nameOf(entry);
  useEffect(() => {
    const el = input.current!;
    el.focus();
    // Select the name without its extension, as file managers do.
    el.setSelectionRange(0, isFolderEntry(entry) ? name.length : splitExtension(name)[0].length);
  }, [entry]);
  let done = false;
  const finish = (apply: boolean) => {
    if (done) return;
    done = true;
    const value = input.current!.value;
    renamingAsset.value = null;
    if (!apply || value === name) return;
    void renameAsset(entry, value).then((ok) => {
      if (!ok) return;
      const to = `${folderOf(entryPath(entry)) ? `${folderOf(entryPath(entry))}/` : ""}${value}${isFolderEntry(entry) ? "/" : ""}`;
      select([to]);
    });
  };
  return (
    <input
      ref={input}
      class="asset-rename"
      aria-label={`New name for ${name}`}
      defaultValue={name}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

function ContextMenu() {
  const m = menu.value;
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && el.current?.contains(e.target as Node)) return;
      menu.value = null;
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    el.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [m]);
  if (!m) return null;
  // Keep it on screen.
  const x = Math.min(m.x, window.innerWidth - 220), y = Math.min(m.y, window.innerHeight - m.items.length * 26 - 10);
  return (
    <div ref={el} class="context-menu" role="menu" style={{ left: `${Math.max(0, x)}px`, top: `${Math.max(0, y)}px` }}>
      {m.items.map((item, i) =>
        item.separator ? (
          <div key={i} class="context-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={!!item.disabled}
            title={item.disabled || undefined}
            onClick={() => {
              menu.value = null;
              item.run?.();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span class="context-key">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

async function addToScene(path: string): Promise<void> {
  if (!openScene.value) return;
  await prepareAssets([path]); // a model's meshes
  const scene = openScene.value;
  if (!scene) return;
  try {
    const focus = sceneCamera.value?.focusPoint;
    const id = addAssetToScene(scene, path, selection.value, focus ? [focus.x, focus.y, focus.z] : [0, 0, 0]);
    selection.value = id;
    status.value = { kind: "info", text: `Added ${fileName(path)} to ${fileName(scene.path)}` };
  } catch (err) {
    status.value = errorStatus(`Couldn't add ${fileName(path)}`, err);
  }
}
