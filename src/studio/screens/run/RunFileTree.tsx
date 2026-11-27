// The folder tree of the Takes and Captures panels (spec §2.16, §4.5.2, §4.6.2; the prototype's takes and captures file
// systems, shared frame §8-§11): one component for both. The toolbar has the search (results flatten to a list with each
// file's folders in its meta), the split add button (+ opens a file into the selected folder; its caret's menu also has
// New folder) and Collapse all. Rows are the bare name and the duration; folders show how many files they hold and a
// trash on hover. Right-click menus: Rename (F2), Duplicate, Move to…, Move to top level, Delete (Del) on files; Rename,
// New folder, Move to…, Move to top level and Delete folder (its contents move up) on folders. Drag a file or folder onto
// a folder, or onto the "Top level" strip shown while dragging, to move it (touch has Move to… instead). A view over
// props: the file actions are the Studio asset library's tree actions (`library/studioLibrary.ts`, ADR 0433).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FileTreeActions } from "../../library/studioLibrary";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { TreeView, renameRow, type TreeRow } from "../../../editor/ui/TreeView";
import { Icon, type IconName } from "../../components/Icon";
import "./runFileTree.css";
import { captureTitle, captureTree, folderTrail, recordingExtension, rowMeta, searchCaptures, treeFolders, type CaptureNode } from "./captureTree";

/** What the tree shows, and the file actions it calls. */
export interface RunFileTreeProps extends FileTreeActions {
  /** The tree's id (rename by key goes through it). */
  readonly tree: string;
  /** "take" or "capture": the words of the menus and tooltips. */
  readonly noun: string;
  /** The tree's accessible name ("Takes"). */
  readonly label: string;
  /** The files the tree lists (other project files are left out by the tree's own test). */
  readonly files: readonly string[];
  /** The folders it shows (empty ones too). */
  readonly folders: readonly string[];
  /** The folders Move to… offers (default: `folders`). */
  readonly moveFolders?: readonly string[];
  /** The project's name, for Move to…'s top level. */
  readonly rootName?: string;
  readonly openPath: string | null;
  /** Files can be written (a folder project). */
  readonly writable: boolean;
  /** The file input's `accept`. */
  readonly accept: string;
  /** The empty state's sentence. */
  readonly emptyBody: string;
  readonly fileIcon: (path: string) => IconName;
  /** A file's duration, seconds, once known (null while it is read, or for none). */
  readonly duration?: (path: string) => number | null;
  /** The folder new files and folders go into changed (null: the top level, or the screen's own folder for files). */
  onFolder?(folder: string | null): void;
  onOpen(path: string): void;
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const fileKey = (p: string) => `file:${p}`;
const folderKey = (p: string) => `folder:${p}`;

/** How many files a folder holds, at any depth. */
function countFiles(n: CaptureNode): number {
  return n.kind === "file" ? 1 : n.children.reduce((s, c) => s + countFiles(c), 0);
}

export function RunFileTree(props: RunFileTreeProps) {
  const { noun } = props;
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [folderSel, setFolderSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number } | Element; entries: MenuEntry[]; label: string } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const tree = useMemo(() => captureTree(props.files, props.folders), [props.files, props.folders]);
  const isFolder = (p: string) => props.folders.includes(p) || !!props.moveFolders?.includes(p);
  // The folder new things go into: the folder picked, else the open file's folder.
  const target = folderSel ?? (props.openPath && props.files.includes(props.openPath) ? folderOf(props.openPath) || null : null);
  useEffect(() => props.onFolder?.(target), [target]);
  const readOnly = !props.writable;
  const title = (p: string) => (isFolder(p) ? nameOf(p) : captureTitle(p));

  const pick = () => input.current?.click();
  const addFolder = async (parent: string) => {
    const made = await props.onNewFolder(parent);
    if (!made) return;
    setClosed((c) => new Set([...c].filter((f) => f !== parent)));
    setFolderSel(made);
    setTimeout(() => renameRow(props.tree, folderKey(made)), 0);
  };

  const fileMenu = (path: string): MenuEntry[] =>
    tidyEntries([
      { id: "open", label: "Open", run: () => props.onOpen(path) },
      SEPARATOR,
      { id: "rename", label: "Rename", hint: "F2", disabled: readOnly, run: () => renameRow(props.tree, fileKey(path)) },
      { id: "duplicate", label: "Duplicate", disabled: readOnly, title: `A copy of this ${noun} beside it`, run: () => props.onDuplicate(path) },
      { id: "move", label: "Move to…", disabled: readOnly, run: () => setMoving(path) },
      { id: "top", label: "Move to top level", disabled: readOnly || folderOf(path) === "", run: () => props.onMove([path], "") },
      SEPARATOR,
      { id: "delete", label: `Delete ${noun}`, hint: "Del", danger: true, disabled: readOnly, title: "Moves it to the project's trash; Undo on the toast brings it back", run: () => props.onDelete(path) },
    ]);
  const folderMenu = (folder: string): MenuEntry[] =>
    tidyEntries([
      { id: "rename", label: "Rename", hint: "F2", disabled: readOnly, run: () => renameRow(props.tree, folderKey(folder)) },
      { id: "new", label: "New folder", disabled: readOnly, title: "Inside this folder", run: () => void addFolder(folder) },
      { id: "move", label: "Move to…", disabled: readOnly, run: () => setMoving(folder) },
      { id: "top", label: "Move to top level", disabled: readOnly || folderOf(folder) === "", run: () => props.onMove([folder], "") },
      SEPARATOR,
      { id: "delete", label: "Delete folder", hint: "Del", danger: true, disabled: readOnly, title: "What's inside moves up a level", run: () => props.onDeleteFolder(folder) },
    ]);
  const addMenu = (): MenuEntry[] => [
    { id: "open", label: `Open ${noun} file…`, disabled: readOnly, note: target ? `into ${nameOf(target)}` : undefined, title: "Into the selected folder", run: pick },
    SEPARATOR,
    { id: "folder", label: "New folder", disabled: readOnly, note: target ? `in ${nameOf(target)}` : "top level", title: "Inside the selected folder, or at the top level", run: () => void addFolder(target ?? "") },
  ];

  /** Drag a row onto a folder row (or the top-level strip) to move it. */
  const startDrag = (path: string) => (e: PointerEvent) => {
    if (readOnly || e.button !== 0 || e.pointerType === "touch") return;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    let to: string | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      started = true;
      setDragging(path);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-drop-folder]");
      to = el ? el.dataset.dropFolder! : null;
      if (to !== null && (to === path || to.startsWith(`${path}/`) || folderOf(path) === to)) to = null;
      setDropOn(to);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragging(null);
      setDropOn(null);
      if (ev.type === "pointerup" && started && to !== null) props.onMove([path], to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const fileRow = (path: string, searching: boolean): TreeRow => {
    const d = props.duration?.(path) ?? null;
    const meta = rowMeta(path, d, searching);
    const trail = folderTrail(path);
    return {
      key: fileKey(path),
      label: captureTitle(path),
      expandable: false,
      open: false,
      selected: path === props.openPath,
      className: "rft-file",
      attrs: { [`data-${noun}`]: path },
      title: `${trail ? `${trail} › ` : ""}${captureTitle(path)}${readOnly ? "" : " · drag onto a folder to move it · F2 to rename"}`,
      icon: <Icon name={props.fileIcon(path)} size={14} class="rft-icon" />,
      trailing: meta ? <span class="rft-meta">{meta}</span> : undefined,
      dragging: dragging === path,
      setOpen: () => {},
      select: () => {
        setFolderSel(null);
        props.onOpen(path);
      },
      activate: () => (readOnly ? props.onOpen(path) : renameRow(props.tree, fileKey(path))),
      menu: (x, y) => setMenu({ at: { x, y }, entries: fileMenu(path), label: `${captureTitle(path)} menu` }),
      rename: readOnly
        ? null
        : {
            value: captureTitle(path),
            label: `${noun[0]!.toUpperCase()}${noun.slice(1)} name`,
            commit: (v) => {
              const name = v.trim();
              if (name && name !== captureTitle(path)) props.onRename(path, `${name}${recordingExtension(path)}`);
            },
          },
      ...(readOnly ? {} : { remove: () => props.onDelete(path), drag: startDrag(path) }),
    };
  };

  const folderRow = (n: Extract<CaptureNode, { kind: "folder" }>): TreeRow => {
    const count = countFiles(n);
    return {
      key: folderKey(n.path),
      label: n.name,
      expandable: true,
      open: !closed.has(n.path),
      selected: folderSel === n.path,
      className: "rft-folder",
      attrs: { "data-drop-folder": n.path },
      title: `${n.path.split("/").join(" › ")}${readOnly ? "" : ` · double-click to rename · drop ${noun}s here`}`,
      icon: <Icon name="folder" size={14} class="rft-icon" />,
      trailing: (
        <span class="rft-meta">
          {!readOnly && (
            <button
              type="button"
              class="rft-del"
              aria-label={`Delete folder ${n.name}`}
              title="Delete folder (what's inside moves up a level)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                props.onDeleteFolder(n.path);
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          )}
          {count > 0 && <span>{count}</span>}
        </span>
      ),
      drop: dropOn === n.path ? "into" : null,
      dragging: dragging === n.path,
      children: n.children.map((c) => (c.kind === "file" ? fileRow(c.path, false) : folderRow(c))),
      setOpen: (o) => setClosed((c) => (o ? new Set([...c].filter((x) => x !== n.path)) : new Set([...c, n.path]))),
      select: () => setFolderSel(n.path),
      menu: (x, y) => setMenu({ at: { x, y }, entries: folderMenu(n.path), label: `${n.name} folder menu` }),
      activate: () => !readOnly && renameRow(props.tree, folderKey(n.path)),
      rename: readOnly ? null : { value: n.name, label: "Folder name", commit: (v) => props.onRenameFolder(n.path, v) },
      ...(readOnly ? {} : { remove: () => props.onDeleteFolder(n.path), drag: startDrag(n.path) }),
    };
  };

  const found = query.trim() ? searchCaptures(props.files, query) : null;
  const rows = found ? found.map((p) => fileRow(p, true)) : tree.map((n) => (n.kind === "file" ? fileRow(n.path, false) : folderRow(n)));
  const any = props.files.length > 0 || props.folders.length > 0;
  const Noun = `${noun[0]!.toUpperCase()}${noun.slice(1)}`;

  return (
    <div class="rft">
      <div class="rft-bar">
        <input type="search" class="rft-search" placeholder={`Search ${noun}s`} aria-label={`Search ${noun}s`} title={`Search ${noun}s by name; results show each ${noun}'s folder`} value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <span class="rft-split" role="group" aria-label={`Add ${noun}s`}>
          <button type="button" class="rft-add" disabled={readOnly} aria-label={`Open ${noun} file…`} title={readOnly ? "This project is read-only" : `Open ${noun} file… (into the selected folder)`} onClick={pick}>
            <Icon name="plus" size={14} />
          </button>
          <button
            ref={caret}
            type="button"
            class="rft-caret"
            aria-label={`More ways to add ${noun}s`}
            title={`More: Open ${noun} file…, New folder`}
            aria-haspopup="menu"
            aria-expanded={menu?.label === `Add ${noun}s`}
            onClick={() => setMenu(menu?.label === `Add ${noun}s` ? null : { at: caret.current!, entries: addMenu(), label: `Add ${noun}s` })}
          >
            <Icon name="chevronDown" size={12} />
          </button>
        </span>
        <button type="button" class="rft-collapse" aria-label="Collapse all" title={`Collapse all ${noun} folders`} onClick={() => setClosed(new Set(treeFolders(tree)))}>
          <Icon name="collapseAll" size={14} />
        </button>
        <input
          ref={input}
          type="file"
          accept={props.accept}
          multiple
          hidden
          aria-label={`${Noun} files to open`}
          onChange={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            const files = [...(el.files ?? [])];
            el.value = "";
            if (files.length) props.onImport(files, target);
          }}
        />
      </div>
      {!any ? (
        <EmptyState compact title={`No ${noun}s yet`} body={props.emptyBody} />
      ) : found && found.length === 0 ? (
        <p class="rft-none" role="status">No matches</p>
      ) : (
        <>
          {dragging && (
            <div class={`rft-top${dropOn === "" ? " drop" : ""}`} data-drop-folder="">
              <Icon name="chevronUp" size={12} /> Top level
            </div>
          )}
          <TreeView tree={props.tree} label={found ? `Matching ${noun}s` : props.label} rows={rows} />
        </>
      )}
      {menu && <ContextMenu entries={menu.entries} at={menu.at} label={menu.label} onClose={() => setMenu(null)} />}
      {moving && (
        <MoveToDialog
          items={[{ path: moving, folder: isFolder(moving) }]}
          itemName={title(moving)}
          folders={props.moveFolders ?? props.folders}
          noun={isFolder(moving) ? "folder" : noun}
          rootName={props.rootName}
          onMove={(folder) => {
            props.onMove([moving], folder);
            setMoving(null);
          }}
          onCancel={() => setMoving(null)}
        />
      )}
    </div>
  );
}
