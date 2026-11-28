import { errorStatus } from "../messages";
import { signal, type Signal } from "@preact/signals";
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { Panel, usePanelValue } from "./panel/Panel";
import { useEffect, useRef, useState } from "preact/hooks";
import { addAssets, whyNotAddAssets } from "../addAssets";
import { fileName, folderOf } from "../assetBrowser";
import {
  assetCommandLabel,
  assetCreateItems,
  assetKeyCommand,
  assetPluginItems,
  assetShortcut,
  listedEntries,
  makeFolder,
  runAsset,
  shownFolder,
  targetFolder,
  slicesOf,
  whyNotAsset,
  type AssetCommandId,
  type AssetMenuItem,
  type AssetTarget,
} from "../assetActions";
import { entryKind, entryName, entryPath, fileEntries, folderEntry, isFolderEntry, isSliceEntry, splitSliceEntry } from "../assetEntry";
import { canAddToScene, hasSlices, kindLabel, type AssetKind } from "../assetKindLookup";
import { assetDrag, startAssetDrag } from "../assetDrag";
import { isDragDistance, startPointerDrag, type ClientPoint } from "../pointerDrag";
import { assetClipboard, renameAsset, splitExtension } from "../assetOps";
import {
  arrowSelection,
  assetAnchor,
  assetCursor,
  boxSelection,
  clickSelection,
  AssetBrowserView,
  defaultAssetBrowser,
  lastAssetBrowser,
  parentFolder,
  renamingAsset,
  selectedAssets,
  type Modifiers,
} from "../assetSelection";
import { previewAssets, select, selectAssets } from "../inspectorTarget";
import { installOsDrop } from "../osDrop";
import { osDrag } from "../osDropController";
import { newScript, scriptFolderFor } from "../newScript";
import { assetTileSize, assetView } from "../preferences";
import { joinPath, type EditorProject } from "../projects";
import { currentProject, docVersion, openScene, sceneCamera, scriptsVersion, selection, status } from "../state";
import { TileThumbnail } from "./AssetPreview";
import { PanelMenu } from "./PanelMenu";
import type { MenuEntry } from "../menuBar";
import { RenameField } from "./RenameField";
import { TreeView, type TreeRow } from "./TreeView";
import { studioAssetItems } from "../studioLaunch";
import "./assets.css";
import "./assetSlices.css";
import { EmptyState } from "./EmptyState";

/** A context menu item: a label, a shortcut, why it's unavailable, a submenu (the menu bar's shape). */
type MenuItem = MenuEntry;
/** The open context menu, and the Assets panel that opened it (only that copy draws it). */
const menu = signal<{ x: number; y: number; items: MenuItem[]; owner: AssetsView } | null>(null);

/**
 * One Assets panel's view state (ADR 0174): its browsing (folder, Back/Forward, search, the images whose
 * slices it lists, ADR 0040), and grid or list. Each copy has its own; the selection is the editor's. A new
 * copy starts at the project root, in the view mode last chosen.
 */
class AssetsView {
  readonly browser = new AssetBrowserView();
  /** Grid or list; choosing one also sets the preference new copies start from. */
  readonly mode: Signal<"grid" | "list"> = signal(assetView.peek());
  /** The selection box while dragging on empty space, in client pixels. */
  readonly box = signal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Folders closed in the folder tree (they start open), by path; "" is the project's root. */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  setMode(mode: "grid" | "list"): void {
    this.mode.value = mode;
    assetView.value = mode;
  }
}

const AssetsViewContext = createContext<AssetsView | null>(null);
const fallbackView = new AssetsView();
const useAssetsView = (): AssetsView => useContext(AssetsViewContext) ?? fallbackView;

/** The Assets panels drawn now, so the last-used one falls back to another when it goes. */
const mountedBrowsers = new Set<AssetBrowserView>();

/** Make `browser` the last-used Assets panel's: where the module's `openFolder` (imports, reveals) acts. */
function useAsLast(browser: AssetBrowserView): void {
  if (lastAssetBrowser.peek() !== browser) lastAssetBrowser.value = browser;
}

/** True while a drag would drop on the folder `path`. */
const dropTarget = (path: string) => {
  if (osDrag.value?.folder === path) return true;
  const t = assetDrag.value?.target;
  return t?.kind === "folder" && t.folder === path;
};

/** A kind's label, from the asset kind module (ADR 0143). */
const labelOf = (kind: AssetKind | "folder"): string => kindLabel(kind);
const toggleKey = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

/** A command as a menu item: its label, key and rule (assetActions.ts, ADR 0241). */
function commandItem(id: AssetCommandId, target: AssetTarget): MenuItem {
  return { label: assetCommandLabel(id, target), shortcut: assetShortcut(id), disabled: whyNotAsset(id, target), run: () => void runAsset(id, target) };
}

const toMenuItem = (i: AssetMenuItem): MenuItem => ({ label: i.label, disabled: i.whyNot, run: i.run });
const toMenuItems = (items: readonly AssetMenuItem[]): MenuItem[] => items.map(toMenuItem);
const SEP: MenuItem = { label: "", separator: true };

/** The Create submenu (ADR 0383): Folder, Scene and Script…, then a submenu per category of asset kinds. */
function createSubmenu(target: AssetTarget): MenuItem {
  const submenu = assetCreateItems(target).map((e): MenuItem => (e.type === "separator" ? SEP : e.type === "item" ? toMenuItem(e.item) : { label: e.label, submenu: toMenuItems(e.items) }));
  return { label: "Create", submenu };
}

/**
 * The menu for `entries` (empty: the background of `folder`, by default the folder showing): Create, Paste and Show in File Manager; for a
 * selection, Create (in a folder), Open and plugins' actions, the clipboard, Rename, Duplicate and Delete, then Show
 * in File Manager. The layout is here; what each item does and when is assetActions.ts's.
 */
function menuItems(project: EditorProject, entries: readonly string[], folder?: string): MenuItem[] {
  const target: AssetTarget = { project, entries, folder };
  const fs = project.fileSystem;
  const reveal = (path: string) => () => void fs!.reveal!(joinPath(project.root!, path)).catch((err) => (status.value = errorStatus(`Couldn't show ${path}`, err)));
  if (entries.length === 0) {
    return [createSubmenu(target), SEP, commandItem("paste", target), ...(fs?.reveal && project.root ? [SEP, { label: "Show in File Manager", run: reveal(targetFolder(target)) }] : [])];
  }
  const plugins = toMenuItems([...studioAssetItems(target), ...assetPluginItems(target)]); // Open in Audio Studio first (ADR 0341)
  if (entries.every(isSliceEntry)) return [commandItem("open", target), ...plugins];
  const files = fileEntries(entries);
  const single = files.length === 1 ? files[0] : null;
  const opens = [...(single !== null && whyNotAsset("open", target) === null ? [commandItem("open", target)] : []), ...plugins];
  return [
    ...(single !== null && isFolderEntry(single) ? [createSubmenu(target), SEP] : []),
    ...(opens.length > 0 ? [...opens, SEP] : []),
    commandItem("cut", target),
    commandItem("copy", target),
    commandItem("paste", target),
    SEP,
    commandItem("rename", target),
    commandItem("duplicate", target),
    commandItem("delete", target),
    ...(single !== null && fs?.reveal && project.root ? [SEP, { label: "Show in File Manager", run: reveal(entryPath(single)) }] : []),
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
  const view = usePanelValue("assets.view", () => new AssetsView());
  const browser = view.browser;
  useEffect(() => installOsDrop(), []); // files dragged in from the OS (ADR 0085)
  useEffect(() => {
    // The first Assets panel drawn (or one drawn while none is) becomes the last used.
    mountedBrowsers.add(browser);
    if (!mountedBrowsers.has(lastAssetBrowser.peek())) useAsLast(browser);
    return () => {
      mountedBrowsers.delete(browser);
      if (lastAssetBrowser.peek() === browser) lastAssetBrowser.value = [...mountedBrowsers][0] ?? defaultAssetBrowser;
    };
  }, [browser]);
  docVersion.value; // the project's file list can change after saves
  scriptsVersion.value; // and its scripts after a reload
  browser.historyVersion.value;
  const project = currentProject.value;
  if (!project)
    return (
      <Panel>
        <EmptyState compact title="No project open" />
      </Panel>
    );
  // A folder that's gone (deleted, moved) shows the root instead.
  const folder = shownFolder(project, browser);
  const query = browser.query.value;
  const searching = query.trim() !== "";
  const entries = listedEntries(project, browser);
  const selected = selectedAssets.value.filter((e) => entries.includes(e));
  const mode = view.mode.value;
  return (
    <Panel>
      <AssetsViewContext.Provider value={view}>
        <div
          class={`asset-browser${osDrag.value ? (osDrag.value.refused ? " os-drop refused" : " os-drop") : ""}`}
          onPointerDownCapture={() => useAsLast(browser)}
          onFocusCapture={() => useAsLast(browser)}
          onDragEnterCapture={() => useAsLast(browser)}
        >
          <nav class="asset-tree">
            <TreeView tree={FOLDER_TREE} label="Folders" class="folder-tree" rows={[folderRow(view, project, "", project.name, searching ? null : folder)]} indent={12} />
          </nav>
          <div class="asset-main">
            <div class="asset-bar">
              <div class="asset-nav" role="group" aria-label="Navigation">
                <button aria-label="Back" title="Back (Alt+←)" disabled={!browser.canGoBack()} onClick={browser.goBack}>
                  ←
                </button>
                <button aria-label="Forward" title="Forward (Alt+→)" disabled={!browser.canGoForward()} onClick={browser.goForward}>
                  →
                </button>
                <button aria-label="Up" title="Up a folder (Alt+↑)" disabled={folder === "" || searching} onClick={() => browser.openFolder(parentFolder(folder) ?? "")}>
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
                onInput={(e) => (browser.query.value = (e.currentTarget as HTMLInputElement).value)}
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
              {mode === "grid" && (
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
                <button aria-pressed={mode === "grid"} class={mode === "grid" ? "active" : ""} onClick={() => view.setMode("grid")}>
                  Grid
                </button>
                <button aria-pressed={mode === "list"} class={mode === "list" ? "active" : ""} onClick={() => view.setMode("list")}>
                  List
                </button>
              </div>
            </div>
            <AssetItems project={project} entries={entries} selected={selected} searching={searching} />
          </div>
          <ContextMenu />
        </div>
      </AssetsViewContext.Provider>
    </Panel>
  );
}

function Breadcrumbs(props: { project: EditorProject; folder: string; searching: string | null }) {
  const { project, folder, searching } = props;
  if (searching !== null) return <span class="asset-crumb">Results for “{searching}”</span>;
  const parts = folder === "" ? [] : folder.split("/");
  const { openFolder } = useAssetsView().browser;
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

/** The tree name the folder tree's rows are renamed under (`renameRow`, ADR 0278); keys are folder paths. */
const FOLDER_TREE = "folders";

/**
 * A folder's row in the folder tree (the tree view's folder adapter, ADR 0278): clicking or an arrow key shows it,
 * F2 renames it, Delete deletes it (asking first, as the Delete command does), the menu is the folder's. A folder
 * holding the one showing stays open.
 */
function folderRow(view: AssetsView, project: EditorProject, path: string, label: string, current: string | null): TreeRow {
  const children = project.folders.filter((f) => parentFolder(f) === path).sort((a, b) => fileName(a).localeCompare(fileName(b)));
  const open = !view.collapsed.value.has(path) || (current !== null && path !== current && (path === "" || current.startsWith(`${path}/`)));
  const entry = path === "" ? null : folderEntry(path);
  const target: AssetTarget | null = entry ? { project, entries: [entry] } : null;
  return {
    key: path,
    label,
    expandable: children.length > 0,
    open,
    children: open ? children.map((f) => folderRow(view, project, f, fileName(f), current)) : undefined,
    selected: current === path,
    className: `asset-folder${dropTarget(path) ? " drop-target" : ""}`,
    attrs: { "data-drop-folder": path },
    setOpen: (on) => {
      if (view.collapsed.value.has(path) !== on) return;
      const next = new Set(view.collapsed.value);
      if (on) next.delete(path);
      else next.add(path);
      view.collapsed.value = next;
    },
    select: () => view.browser.openFolder(path),
    menu: (x, y) => {
      menu.value = { x, y, items: menuItems(project, entry ? [entry] : [], path), owner: view }; // the root row's menu acts in the root
    },
    rename:
      entry && target && !whyNotAsset("rename", target)
        ? {
            value: label,
            label: `New name for ${label}`,
            commit: (value) => {
              if (value === label) return;
              void renameAsset(entry, value).then((ok) => {
                const parent = parentFolder(path);
                if (ok) view.browser.openFolder(parent ? `${parent}/${value}` : value);
              });
            },
          }
        : null,
    remove: target ? () => void runAsset("delete", target) : undefined,
  };
}

/** Delete the selection (asking first); disabled, with the reason, when it can't be (the Delete command's rule, ADR 0241). */
function DeleteButton(props: { project: EditorProject; selected: readonly string[] }) {
  const target: AssetTarget = { project: props.project, entries: props.selected };
  const reason = whyNotAsset("delete", target);
  const selected = fileEntries(props.selected);
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
  const assetsView = useAssetsView();
  const { browser, box } = assetsView;
  const view = assetsView.mode.value;

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
      if (e.key === "ArrowLeft") browser.goBack();
      else if (e.key === "ArrowRight") browser.goForward();
      else if (browser.folder.value !== "") browser.openFolder(parentFolder(browser.folder.value) ?? "");
      return;
    }
    const moved = arrowSelection(entries, assetCursor.value, assetAnchor.value, e.key, columns(), e.shiftKey);
    if (moved) {
      handled();
      selectAssets(moved.selected, moved.focus, moved.anchor);
      list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(moved.focus)}"]`)?.focus();
      return;
    }
    if (toggleKey(e) && !e.altKey && (e.key ?? "").toLowerCase() === "a") return (handled(), selectAssets(entries, assetCursor.value));
    // A mapped key is the panel's even when its command refuses (it says why), so a refused Delete never
    // reaches the editor's delete-node shortcut (ADR 0241).
    const command = assetKeyCommand(e);
    if (command) return (handled(), void runAsset(command, { project, entries: listed }));
    if (e.key === "Escape" && listed.length > 0) return (handled(), selectAssets([]));
  };

  /** Press on empty space: drag a selection box (Shift adds, Ctrl/Cmd toggles); a click clears the selection. */
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".asset-item")) return;
    const el = list.current!;
    el.focus();
    const before = selectedAssets.value.filter((x) => entries.includes(x));
    const mods: Modifiers = { shift: e.shiftKey, toggle: toggleKey(e) };
    const x0 = e.clientX, y0 = e.clientY;
    startPointerDrag(e, {
      move: (m) => {
        const r = { left: Math.min(x0, m.clientX), right: Math.max(x0, m.clientX), top: Math.min(y0, m.clientY), bottom: Math.max(y0, m.clientY) };
        box.value = { x0, y0, x1: m.clientX, y1: m.clientY };
        const hits = [...el.querySelectorAll<HTMLElement>(".asset-item")]
          .filter((item) => {
            const b = item.getBoundingClientRect();
            return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
          })
          .map((item) => item.dataset.entry!);
        previewAssets(boxSelection(before, hits, mods)); // the Inspector follows once the box is let go
      },
      end: (how) => {
        box.value = null;
        if (how === "cancel") previewAssets(before);
        else if (how === "drop") selectAssets(selectedAssets.peek());
        else if (!mods.shift && !mods.toggle) selectAssets([]); // a click on empty space
      },
    });
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
          selectAssets([]);
          menu.value = { x: e.clientX, y: e.clientY, items: menuItems(project, []), owner: assetsView };
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
        {entries.length === 0 && <li role="presentation"><EmptyState compact title={searching ? "No matching assets" : "This folder is empty"} /></li>}
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
  const assetsView = useAssetsView();
  const { expandedImages } = assetsView.browser;
  const expanded = expandedImages.value.has(path);
  const open = openScene.value?.path === entry;
  const cut = !!assetClipboard.value?.cut && assetClipboard.value.entries.includes(entry);
  const addable = !isFolderEntry(entry) && canAddToScene(entry);
  const whyNotAdd = addable ? whyNotAddAssets([entry]) : null;
  const canAdd = addable && whyNotAdd === null;
  const press = useRef<ClientPoint | null>(null);
  const list = assetsView.mode.value === "list";
  const opens = whyNotAsset("open", { project, entries: [entry] }) === null;
  return (
    <li
      class={`asset-item asset-tile kind-${kind}${selected ? " selected" : ""}${open ? " open" : ""}${cut ? " cut" : ""}${isFolderEntry(entry) && dropTarget(path) ? " drop-target" : ""}`}
      role="option"
      aria-selected={selected}
      data-entry={entry}
      {...(isFolderEntry(entry) ? { "data-drop-folder": path } : {})}
      title={`${path}${opens ? " (double-click to open)" : ""}${addable ? "; drag into the viewport or hierarchy to add" : ""}`}
      tabIndex={selected || (assetCursor.value === entry) ? 0 : -1}
      onPointerDown={(e) => {
        press.current = { clientX: e.clientX, clientY: e.clientY };
        const sel = selectedAssets.value.filter((x) => entries.includes(x));
        if (e.button === 2) {
          if (!sel.includes(entry)) selectAssets([entry]);
          return;
        }
        if (e.button !== 0 || renamingAsset.value === entry) return;
        // A plain press on an unselected item selects it alone, so dragging it drags just it.
        if (!e.shiftKey && !toggleKey(e) && !sel.includes(entry)) selectAssets([entry]);
        if (e.shiftKey || toggleKey(e)) return;
        startAssetDrag(e, selectedAssets.value.filter((x) => entries.includes(x)));
      }}
      onClick={(e) => {
        const start = press.current;
        if (start && isDragDistance(start, e)) return; // a drag, not a click
        const sel = selectedAssets.value.filter((x) => entries.includes(x));
        const mods = { shift: e.shiftKey, toggle: toggleKey(e) };
        const next = clickSelection(entries, sel, assetAnchor.value, entry, mods);
        // Selecting one asset with an inspector shows it, in place of the selected node (ADR 0040, 0242).
        selectAssets(next.selected, entry, next.anchor);
      }}
      onDblClick={() => opens && void runAsset("open", { project, entries: [entry] })}
      onContextMenu={(e) => {
        e.preventDefault();
        const sel = selectedAssets.value.filter((x) => entries.includes(x));
        menu.value = { x: e.clientX, y: e.clientY, items: menuItems(project, sel.includes(entry) ? sel : [entry]), owner: assetsView };
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

/** Renaming a tile in place (the editor's one rename field, ADR 0278): the name is selected without its extension, as file managers do. */
function RenameInput(props: { entry: string }) {
  const { entry } = props;
  const name = entryName(entry);
  return (
    <RenameField
      class="asset-rename"
      label={`New name for ${name}`}
      value={name}
      selectTo={isFolderEntry(entry) ? name.length : splitExtension(name)[0].length}
      onCommit={(value) => {
        renamingAsset.value = null;
        if (value === name) return;
        void renameAsset(entry, value).then((ok) => {
          if (!ok) return;
          const to = `${folderOf(entryPath(entry)) ? `${folderOf(entryPath(entry))}/` : ""}${value}${isFolderEntry(entry) ? "/" : ""}`;
          selectAssets([to]);
        });
      }}
      onCancel={() => (renamingAsset.value = null)}
    />
  );
}

/** The open context menu, drawn by the Assets panel that opened it, in that panel's window (ADR 0174). */
function ContextMenu() {
  const owner = useAssetsView();
  const m = menu.value?.owner === owner ? menu.value : null;
  return <PanelMenu menu={m} label="Assets menu" onClose={() => (menu.value = null)} />;
}

/** The tile's +: add the asset under the selected node at the scene camera's focus (`addAssets`, ADR 0149). */
async function addToScene(path: string): Promise<void> {
  const focus = sceneCamera.peek()?.focusPoint;
  const { ids, message } = await addAssets([path], { kind: "selection", selected: selection.peek(), position: focus ? [focus.x, focus.y, focus.z] : [0, 0, 0] });
  if (ids[0]) select([ids[0]]);
  status.value = message;
}
