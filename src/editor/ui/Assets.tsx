import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { addAssets, whyNotAddAssets } from "../addAssets";
import {
  assetCommandLabel,
  assetCreateItems,
  assetKeyCommand,
  assetPluginItems,
  assetShortcut,
  expandedImages,
  listedEntries,
  makeFolder,
  runAsset,
  shownFolder,
  slicesOf,
  whyNotAsset,
  type AssetCommandId,
  type AssetMenuItem,
  type AssetTarget,
} from "../assetActions";
import { fileName, folderOf } from "../assetBrowser";
import { entryFolder, entryKind, entryName, entryPath, fileEntries, folderEntry, isFolderEntry, isSliceEntry, splitSliceEntry } from "../assetEntry";
import { canAddToScene, hasSlices, kindLabel, type AssetKind } from "../assetKindLookup";
import { inspectSelectedAsset } from "../assetImport";
import { assetDrag, startAssetDrag } from "../assetDrag";
import { assetClipboard, renameAsset, splitExtension } from "../assetOps";
import {
  arrowSelection,
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
  openFolder,
  parentFolder,
  renamingAsset,
  select,
  selectedAssets,
  type Modifiers,
} from "../assetSelection";
import { errorStatus } from "../messages";
import { installOsDrop, osDragFolder, osDragOver } from "../osDrop";
import { newScript, scriptFolderFor } from "../newScript";
import { assetTileSize, assetView } from "../preferences";
import { joinPath, type EditorProject } from "../projects";
import { currentProject, docVersion, openScene, sceneCamera, scriptsVersion, selection, status } from "../state";
import { TileThumbnail } from "./AssetPreview";
import "./assets.css";
import "./assetSlices.css";

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

/** The selection box while dragging on empty space, in client pixels. */
const box = signal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

/** True while a drag would drop on the folder `path`. */
const dropTarget = (path: string) => {
  if (osDragFolder.value === path) return true;
  const t = assetDrag.value?.target;
  return t?.kind === "folder" && t.folder === path;
};

/** A kind's label, from the asset kind module (ADR 0143). */
const labelOf = (kind: AssetKind | "folder"): string => kindLabel(kind);
const toggleKey = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

/** True if double-clicking `entry` opens it (a folder shows, a file opens as its kind says). */
const opens = (project: EditorProject, entry: string) => whyNotAsset("open", { project, entries: [entry] }) === null;

/** Open `entry` if it opens (a double-click does nothing on a file that doesn't). */
function openEntry(project: EditorProject, entry: string): void {
  const target = { project, entries: [entry] };
  if (!whyNotAsset("open", target)) void runAsset("open", target);
}

/** A command as a menu item: its label, key and reason come from the command module (ADR 0157). */
const commandItem = (id: AssetCommandId, target: AssetTarget): MenuItem => ({
  label: assetCommandLabel(id, target),
  shortcut: assetShortcut(id),
  disabled: whyNotAsset(id, target),
  run: () => void runAsset(id, target),
});
const toMenu = (items: readonly AssetMenuItem[]): MenuItem[] => items.map((i) => ({ label: i.label, disabled: i.whyNot, run: i.run }));
const SEP: MenuItem = { label: "", separator: true };

/** The menu for `entries` (empty: the folder showing's background). Its layout; the commands' rules are the command module's. */
function menuItems(project: EditorProject, entries: readonly string[]): MenuItem[] {
  const target: AssetTarget = { project, entries };
  const fs = project.fileSystem;
  const reveal = (path: string) => () => void fs!.reveal!(joinPath(project.root!, path)).catch((err) => (status.value = errorStatus(`Couldn't show ${path}`, err)));
  const newItems = toMenu(assetCreateItems(target));
  if (entries.length === 0) {
    return [...newItems, SEP, commandItem("paste", target), ...(fs?.reveal && project.root ? [{ label: "Show in File Manager", run: reveal(folderPath.value) }] : [])];
  }
  // Open (or Sprite Editor…) when it applies, then plugins' actions (ADR 0146).
  const head = [...(whyNotAsset("open", target) ? [] : [commandItem("open", target)]), ...toMenu(assetPluginItems(target))];
  if (entries.every(isSliceEntry)) return head;
  const files = fileEntries(entries);
  const single = files.length === 1 ? files[0] : null;
  return [
    ...head,
    commandItem("rename", target),
    commandItem("duplicate", target),
    SEP,
    commandItem("copy", target),
    commandItem("cut", target),
    commandItem("paste", target),
    SEP,
    commandItem("delete", target),
    ...(single && isFolderEntry(single) ? [SEP, ...newItems] : []),
    ...(single && fs?.reveal && project.root ? [SEP, { label: "Show in File Manager", run: reveal(entryPath(single)) }] : []),
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
  const folder = shownFolder(project);
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
          const items = path === "" ? menuItems(project, []) : menuItems(project, [folderEntry(path)]);
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
  const target: AssetTarget = { project: props.project, entries: props.selected };
  const selected = fileEntries(props.selected);
  const reason = whyNotAsset("delete", target);
  const what = selected.length === 1 ? entryPath(selected[0]) : `${selected.length} items`;
  return (
    <button class="delete-asset-button" disabled={reason !== null} title={reason ? `Can't delete: ${reason}` : `Delete ${what} from disk (Delete)`} onClick={() => void runAsset("delete", target)}>
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
    const moved = arrowSelection(entries, assetCursor.value, assetAnchor.value, e.key, columns(), e.shiftKey);
    if (moved) {
      handled();
      select(moved.selected, moved.focus, moved.anchor);
      inspectSelectedAsset();
      list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(moved.focus)}"]`)?.focus();
      return;
    }
    // A command's key always stays in the panel (a refused Delete mustn't delete the scene's selected node); a refusal says why.
    const command = assetKeyCommand(e);
    if (command === "open" && (e.target as HTMLElement).closest("button")) return; // Enter presses a tile's own button (+, slices)
    if (command) return (handled(), void runAsset(command, { project, entries: listed }));
    if (toggleKey(e) && !e.altKey && (e.key ?? "").toLowerCase() === "a") return (handled(), select(entries, assetCursor.value));
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
  const kind = entryKind(entry);
  const path = entryPath(entry);
  const slice = isSliceEntry(entry) ? splitSliceEntry(entry) : null;
  const url = isFolderEntry(entry) ? undefined : project.assets.get(slice ? slice.image : path);
  const sliceRect = slice ? slicesOf(project, slice.image).find((s) => s.name === slice.slice)?.rect : undefined;
  const sliceCount = hasSlices(kind) ? slicesOf(project, path).length : 0;
  const expanded = expandedImages.value.has(path);
  const open = openScene.value?.path === entry;
  const cut = !!assetClipboard.value?.cut && assetClipboard.value.entries.includes(entry);
  const addable = !isFolderEntry(entry) && canAddToScene(entry);
  const whyNotAdd = addable ? whyNotAddAssets([entry]) : null;
  const canAdd = addable && whyNotAdd === null;
  const press = useRef<{ x: number; y: number } | null>(null);
  const list = assetView.value === "list";
  return (
    <li
      class={`asset-item asset-tile kind-${kind}${selected ? " selected" : ""}${open ? " open" : ""}${cut ? " cut" : ""}${isFolderEntry(entry) && dropTarget(path) ? " drop-target" : ""}`}
      role="option"
      aria-selected={selected}
      data-entry={entry}
      {...(isFolderEntry(entry) ? { "data-drop-folder": path } : {})}
      title={`${path}${opens(project, entry) ? " (double-click to open)" : ""}${addable ? "; drag into the viewport or hierarchy to add" : ""}`}
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
      onDblClick={() => openEntry(project, entry)}
      onContextMenu={(e) => {
        e.preventDefault();
        const sel = selectedAssets.value.filter((x) => entries.includes(x));
        menu.value = { x: e.clientX, y: e.clientY, items: menuItems(project, sel.includes(entry) ? sel : [entry]) };
      }}
    >
      <div class="asset-thumb">
        {hasSlices(kind) && typeof url === "string" ? (
          <img src={url} alt="" draggable={false} />
        ) : slice && sliceRect && typeof url === "string" ? (
          <SliceThumb url={url} rect={sliceRect} />
        ) : (
          <TileThumbnail path={path} kind={kind} label={labelOf(kind)} name={entryName(entry)} />
        )}
      </div>
      {sliceCount > 0 && (
        <button
          class={`asset-expand${expanded ? " expanded" : ""}`}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} the slices of ${entryName(entry)}`}
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
      {renamingAsset.value === entry ? <RenameInput entry={entry} /> : <span class="asset-name">{entryName(entry)}</span>}
      {list && <span class="asset-col-kind">{labelOf(kind)}</span>}
      {list && <span class="asset-col-size">{isFolderEntry(entry) ? "" : formatSize(project.sizeOf(path))}</span>}
      {showFolder && !list && <span class="asset-folder-hint">{folderOf(path) || "/"}</span>}
      {addable && (
        <button
          class="asset-add"
          disabled={!canAdd}
          title={canAdd ? `Add ${entryName(entry)} to the scene` : `Can't add ${entryName(entry)}: ${whyNotAdd}`}
          aria-label={`Add ${entryName(entry)} to the scene`}
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
  // An SVG viewBox on the slice's rectangle scales just that part to the thumbnail. When the thumbnail's shape differs
  // from the slice's, "meet" letterboxes, and the letterbox would show the image around the viewBox (the neighbouring
  // slices), so a nested <svg> the size of the slice clips the image to it (an inner svg clips to its own viewport).
  const box = `${rect[0]} ${rect[1]} ${rect[2]} ${rect[3]}`;
  return (
    <svg class="asset-slice-thumb" viewBox={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <svg x={rect[0]} y={rect[1]} width={rect[2]} height={rect[3]} viewBox={box} overflow="hidden">
        <image href={url} width={size[0]} height={size[1]} style={{ imageRendering: "pixelated" }} />
      </svg>
    </svg>
  );
}

/** Renaming in place: Enter or leaving the field renames, Escape cancels. */
function RenameInput(props: { entry: string }) {
  const { entry } = props;
  const input = useRef<HTMLInputElement>(null);
  const name = entryName(entry);
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
      const path = entryFolder(entry) ? `${entryFolder(entry)}/${value}` : value;
      select([isFolderEntry(entry) ? folderEntry(path) : path]);
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

/** The tile's +: add the asset under the selected node at the scene camera's focus (`addAssets`, ADR 0149). */
async function addToScene(path: string): Promise<void> {
  const focus = sceneCamera.peek()?.focusPoint;
  const { ids, message } = await addAssets([path], { kind: "selection", selected: selection.peek(), position: focus ? [focus.x, focus.y, focus.z] : [0, 0, 0] });
  if (ids[0]) selection.value = ids[0];
  status.value = message;
}
