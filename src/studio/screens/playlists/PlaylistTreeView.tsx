// The Playlists panel's view (the prototype's tree, ADR 0349 kit): the project's playlists by folder in the editor's
// `TreeView`, embedded playlists nested under their parent and linked ones dashed with a link mark, type badges, the
// output-override marker, search (matches with their paths), folder rows with counts, context menus, Move to…, a
// multi-select bar, and drag to move or nest (before / into / after, checked by `treeDrop.ts` while dragging). The empty
// state offers New playlist, New folder and, with no samples yet, Samples. A view over props; the panel wires actions.
import { useMemo, useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { TreeView, renameRow, type TreeRow } from "../../../editor/ui/TreeView";
import { Icon } from "../../components/Icon";
import { TypeBadge } from "../../components/TypeBadge";
import { findNode, folderKey, searchTree, type PlaylistNode } from "./playlistTree";
import { dropZone, type DragSource, type DropPlan, type DropTarget, type DropZone } from "./treeDrop";
import { COLLAPSE_GLYPH, Glyph } from "./glyphs";
import { EmptyState } from "../../../editor/ui/EmptyState";

export interface TreeActions {
  open(node: PlaylistNode): void;
  newPlaylist(folder: string): void;
  /** New playlist inside the open one (an embedded Queue), when it holds entries. */
  newPlaylistInside(): void;
  newSequence(folder: string): void;
  /** A new folder under `parent`; its path once made, or null. The tree then starts it in rename mode. */
  newFolder(parent: string): Promise<string | null> | void;
  renameFile(path: string, name: string): void;
  renameFolder(path: string, name: string): void;
  duplicate(nodes: readonly PlaylistNode[]): void;
  /** Delete… (a file or an embedded entry asks with its choices; a linked entry just leaves its parent). */
  remove(node: PlaylistNode): void;
  removeMany(nodes: readonly PlaylistNode[]): void;
  deleteFolder(path: string): void;
  unlink(node: PlaylistNode): void;
  makeShared(node: PlaylistNode): void;
  moveTo(paths: readonly string[], folder: string): void;
  /** What a drop would do (drawn while dragging) and doing it. */
  planDrop(source: DragSource, target: DropTarget, zone: DropZone): DropPlan;
  drop(plan: DropPlan, source: PlaylistNode | { kind: "folder"; path: string; name: string }, target: DropTarget): void;
  /** Go to Samples to import some. */
  openSamples(): void;
}

export interface PlaylistTreeViewProps {
  readonly nodes: readonly PlaylistNode[];
  readonly folders: readonly string[];
  /** The open playlist's row key. */
  readonly openKey: string | null;
  readonly writable: boolean;
  readonly hasSamples: boolean;
  /** The open playlist's name when it can hold a new playlist (offered as "New playlist in …"). */
  readonly nestInto?: string | null;
  readonly actions: TreeActions;
}

const TREE = "playlists-tree";

/**
 * Start renaming the folder at `path` in the Playlists tree, its name selected (J6.1: a new folder starts in rename
 * mode, as a new playlist does). The row shows the field as soon as it's drawn.
 */
export function renameFolderRow(path: string): void {
  renameRow(TREE, folderKey(path));
}

const sourceOf = (n: PlaylistNode): DragSource =>
  n.kind === "folder" ? { kind: "folder", path: n.path } : n.kind === "file" ? { kind: "file", path: n.path } : { kind: "entry", file: n.file, parent: n.indices.slice(0, -1), index: n.indices[n.indices.length - 1]!, link: n.link };
const targetOf = (n: PlaylistNode): DropTarget =>
  n.kind === "folder" ? { kind: "folder", path: n.path } : n.kind === "file" ? { kind: "file", path: n.path } : { kind: "entry", file: n.file, parent: n.indices.slice(0, -1), index: n.indices[n.indices.length - 1]!, link: n.link };

/** Every expandable row's key (Collapse all). */
function allKeys(nodes: readonly PlaylistNode[]): string[] {
  const out: string[] = [];
  const walk = (n: PlaylistNode) => {
    if (n.kind === "folder" || n.children.length) out.push(n.key);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

interface DragState {
  readonly key: string;
  readonly over: string | null;
  readonly zone: DropZone;
  readonly plan: DropPlan | null;
}

export function PlaylistTreeView(props: PlaylistTreeViewProps) {
  const { nodes, actions, writable } = props;
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<Element | null>(null);
  const [moving, setMoving] = useState<readonly PlaylistNode[] | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const any = useMemo(() => nodes.some(function has(n: PlaylistNode): boolean { return n.kind !== "folder" || n.children.some(has); }), [nodes]);
  const selectedFolder = (() => {
    const n = selection.length === 1 ? findNode(nodes, selection[0]!) : null;
    return n?.kind === "folder" ? n.path : n?.kind === "file" ? (n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "") : "";
  })();
  const selectedNodes = selection.map((k) => findNode(nodes, k)).filter((n): n is PlaylistNode => !!n);

  const startDrag = (n: PlaylistNode, e: PointerEvent) => {
    if (!writable || e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let started = false;
    const doc = (e.currentTarget as HTMLElement | null)?.ownerDocument ?? document;
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      started = true;
      const el = doc.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-pl-key]");
      const overKey = el?.dataset.plKey ?? null;
      if (!overKey || overKey === n.key) return setDrag({ key: n.key, over: null, zone: "into", plan: null });
      if (overKey === "root") return setDrag({ key: n.key, over: "root", zone: "into", plan: actions.planDrop(sourceOf(n), { kind: "root" }, "into") });
      const over = findNode(nodes, overKey);
      if (!over) return;
      const rect = el!.getBoundingClientRect();
      const zone = dropZone((ev.clientY - rect.top) / Math.max(1, rect.height), { folder: over.kind === "folder" });
      setDrag({ key: n.key, over: overKey, zone, plan: actions.planDrop(sourceOf(n), targetOf(over), zone) });
    };
    const up = (ev: PointerEvent) => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", up);
      const d = dragRef.current;
      setDrag(null);
      if (ev.type === "pointercancel" || !started || !d || !d.over || !d.plan) return;
      const target = d.over === "root" ? ({ kind: "root" } as const) : targetOf(findNode(nodes, d.over)!);
      actions.drop(d.plan, n.kind === "folder" ? { kind: "folder", path: n.path, name: n.name } : n, target);
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
  };

  const pick = (key: string, toggle: boolean) => setSelection(toggle ? (selection.includes(key) ? selection.filter((k) => k !== key) : [...selection, key]) : [key]);

  const row = (n: PlaylistNode, label?: string, meta?: string): TreeRow => {
    const isDrop = drag?.over === n.key;
    const common = {
      key: n.key,
      selected: selection.includes(n.key) || n.key === props.openKey,
      attrs: { "data-pl-key": n.key },
      dragging: drag?.key === n.key,
      drop: isDrop && drag?.plan && drag.plan.kind !== "refused" ? drag.zone : null,
      menu: (x: number, y: number) => {
        if (!selection.includes(n.key)) setSelection([n.key]);
        setMenu({ key: n.key, x, y });
      },
      drag: (e: PointerEvent) => startDrag(n, e),
    };
    if (n.kind === "folder") {
      return {
        ...common,
        label: label ?? n.name,
        expandable: true,
        open: !closed.has(n.key),
        className: "pl-folder-row",
        icon: <Icon name="folder" class="pl-folder-icon" size={14} />,
        trailing: <span class="pl-count">{n.count}</span>,
        children: n.children.map((c) => row(c)),
        setOpen: (open) => toggleOpen(n.key, open),
        select: (how) => pick(n.key, how.toggle),
        rename: writable ? { value: n.name, label: "Folder name", commit: (v) => v.trim() && v !== n.name && actions.renameFolder(n.path, v.trim()) } : null,
        ...(writable ? { remove: () => actions.deleteFolder(n.path) } : {}),
      };
    }
    const linked = n.kind === "entry" && n.link !== null;
    const title =
      n.kind === "file"
        ? `${n.path}${n.linkedBy.length ? ` · linked in ${n.linkedBy.map((p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.playlist\.json$/i, "")).join(", ")}` : ""}${n.unreadable ? " · can't be read" : ""}`
        : linked
          ? `Linked: ${n.link} (edits to it change every link)`
          : "Embedded: belongs to its parent";
    return {
      ...common,
      label: label ?? n.name,
      title,
      expandable: n.children.length > 0,
      open: !closed.has(n.key),
      className: `pl-row${linked ? " pl-linked" : ""}${n.kind === "entry" && !linked ? " pl-embedded" : ""}`,
      icon: <TypeBadge playlist={n.type} axes={n.axes} />,
      trailing: (
        <span class="pl-row-trail">
          {meta && <span class="pl-row-meta">{meta}</span>}
          {linked && <span class="pl-link-mark" title="Linked copy"><Icon name="link" size={12} label="Linked copy" /></span>}
          {n.kind === "file" && n.linkedBy.length > 0 && <span class="pl-link-mark pl-original" title={`Linked in ${n.linkedBy.length} playlist${n.linkedBy.length === 1 ? "" : "s"}`} ><Icon name="link" size={12} label="Linked elsewhere" /></span>}
          {n.output && <span class="pl-out-mark" title={`Overridden: plays into ${n.output} (its own output, not its parent's)`} aria-label={`Plays into ${n.output}`}>→ {n.output}</span>}
        </span>
      ),
      children: n.children.map((c) => row(c)),
      setOpen: (open) => toggleOpen(n.key, open),
      select: (how) => {
        pick(n.key, how.toggle);
        if (!how.toggle && !how.range) actions.open(n);
      },
      activate: () => actions.open(n),
      rename: writable && n.kind === "file" ? { value: n.name, label: "Playlist name", commit: (v) => v.trim() && v !== n.name && actions.renameFile(n.path, v.trim()) } : null,
      ...(writable ? { remove: () => actions.remove(n) } : {}),
    };
  };
  /** New folder: its parents open and the search clears, so its row (in rename mode) shows. */
  const makeFolder = (parent: string) => {
    void Promise.resolve(actions.newFolder(parent)).then((path) => {
      if (!path) return;
      setQuery("");
      setClosed((c) => new Set([...c].filter((k) => !(k.startsWith("f:") && (path === k.slice(2) || path.startsWith(`${k.slice(2)}/`))))));
      renameFolderRow(path);
    });
  };
  const toggleOpen = (key: string, open: boolean) => {
    const next = new Set(closed);
    if (open) next.delete(key);
    else next.add(key);
    setClosed(next);
  };

  const entriesFor = (n: PlaylistNode): MenuEntry[] => {
    if (selection.length > 1 && selection.includes(n.key)) {
      const files = selectedNodes.filter((x) => x.kind !== "entry");
      return [
        { kind: "group", label: `${selection.length} selected` },
        { id: "move", label: "Move to…", disabled: !writable || selectedNodes.some((x) => x.kind === "entry"), run: () => setMoving(selectedNodes) },
        { id: "top", label: "Move to top level", disabled: !writable || selectedNodes.some((x) => x.kind === "entry") || files.every((x) => !(x as { path: string }).path.includes("/")), run: () => actions.moveTo(files.map((x) => (x as { path: string }).path), "") },
        { id: "dup", label: `Duplicate ${selection.length}`, hint: "Ctrl+D", disabled: !writable, run: () => actions.duplicate(selectedNodes) },
        SEPARATOR,
        { id: "del", label: `Delete ${selection.length}…`, hint: "Del", danger: true, disabled: !writable, run: () => actions.removeMany(selectedNodes) },
        { id: "clear", label: "Clear selection", hint: "Esc", run: () => setSelection([]) },
      ];
    }
    if (n.kind === "folder") {
      return [
        { kind: "group", label: n.name },
        { id: "rename", label: "Rename", hint: "F2", disabled: !writable, run: () => renameRow(TREE, n.key) },
        { id: "folder", label: "New folder inside", disabled: !writable, run: () => makeFolder(n.path) },
        { id: "new", label: "New playlist here", disabled: !writable, run: () => actions.newPlaylist(n.path) },
        { id: "newsq", label: "New sequence here", disabled: !writable, run: () => actions.newSequence(n.path) },
        SEPARATOR,
        { id: "move", label: "Move to…", disabled: !writable, run: () => setMoving([n]) },
        { id: "top", label: "Move to top level", disabled: !writable || !n.path.includes("/"), run: () => actions.moveTo([n.path], "") },
        SEPARATOR,
        { id: "del", label: "Delete folder…", hint: "Del", title: "Delete folder (what's inside moves up a level)", danger: true, disabled: !writable, run: () => actions.deleteFolder(n.path) },
      ];
    }
    const linked = n.kind === "entry" && n.link !== null;
    return tidyEntries([
      { kind: "group", label: n.name },
      { id: "open", label: "Open", hint: "Enter", run: () => actions.open(n) },
      SEPARATOR,
      n.kind === "file" && { id: "rename", label: "Rename", hint: "F2", disabled: !writable, run: () => renameRow(TREE, n.key) },
      { id: "dup", label: "Duplicate", hint: "Ctrl+D", disabled: !writable, run: () => actions.duplicate([n]) },
      linked && { id: "unlink", label: "Unlink (make a separate copy)", title: "Turn this linked copy into its own playlist inside its parent: later edits change only this one", disabled: !writable, run: () => actions.unlink(n) },
      n.kind === "entry" && !linked && { id: "share", label: "Make shared", title: "Move it to a file of its own and link it here, so other playlists can use it", disabled: !writable, run: () => actions.makeShared(n) },
      SEPARATOR,
      n.kind === "file" && { id: "move", label: "Move to…", disabled: !writable, run: () => setMoving([n]) },
      n.kind === "file" && { id: "top", label: "Move to top level", disabled: !writable || !n.path.includes("/"), run: () => actions.moveTo([n.path], "") },
      SEPARATOR,
      linked
        ? { id: "remove", label: "Remove link from its parent", title: "Removes only this linked copy; the original stays", hint: "Del", danger: true, disabled: !writable, run: () => actions.remove(n) }
        : { id: "del", label: "Delete…", hint: "Del", danger: true, disabled: !writable, run: () => actions.remove(n) },
    ]);
  };

  const hits = query.trim() ? searchTree(nodes, query) : null;
  const menuNode = menu ? findNode(nodes, menu.key) : null;

  return (
    <div class="pl-tree" data-keyscope="playlists-tree">
      <div class="pl-tree-tools">
        <input type="search" class="pl-search" placeholder="Search playlists" aria-label="Search playlists" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <span class="pl-adsp" role="group" aria-label="New">
          <button type="button" class="pl-adb" disabled={!writable} title={writable ? (props.nestInto ? `New playlist inside ${props.nestInto}` : "New playlist") : "This project is read-only"} aria-label="New playlist"
            onClick={() => (props.nestInto ? actions.newPlaylistInside() : actions.newPlaylist(selectedFolder))}>
            <Icon name="plus" size={13} />
          </button>
          <button type="button" class="pl-adb more" disabled={!writable} title="New playlist, sequence or folder" aria-label="More new items" aria-haspopup="menu" aria-expanded={!!addMenu} onClick={(e) => setAddMenu(e.currentTarget as Element)}>
            <Icon name="chevronDown" size={10} />
          </button>
        </span>
        <button type="button" class="pl-ib" aria-label="Collapse all" title="Collapse all folders and playlists" onClick={() => setClosed(new Set(allKeys(nodes)))}>
          <Glyph paths={COLLAPSE_GLYPH} size={14} />
        </button>
      </div>
      {drag && (
        <div class={`pl-top-drop${drag.over === "root" ? " over" : ""}`} data-pl-key="root">
          <Icon name="chevronUp" size={14} /> Top level
        </div>
      )}
      {drag?.plan?.kind === "refused" && <p class="pl-drop-why" role="status">{drag.plan.reason}</p>}
      {!any && !hits ? (
        <EmptyState compact title="No playlists or folders yet. Use + to make a playlist; New folder is in its ▾ menu." />
      ) : hits ? (
        hits.length === 0 ? (
          <p class="pl-note">No playlist matches “{query.trim()}”.</p>
        ) : (
          <TreeView tree={TREE} label="Matching playlists" multiselectable rows={hits.map((h) => ({ ...row(h.node, h.node.kind === "folder" ? undefined : h.node.name, h.where), children: undefined, expandable: false }))} />
        )
      ) : (
        <TreeView tree={TREE} label="Playlists" multiselectable rows={nodes.map((n) => row(n))} />
      )}
      {selection.length > 1 && (
        <div class="pl-msbar" role="toolbar" aria-label="Selected playlists">
          <b>{selection.length} selected</b>
          <button type="button" class="pl-small" disabled={!writable || selectedNodes.some((x) => x.kind === "entry")} onClick={() => setMoving(selectedNodes)}>Move to…</button>
          <span class="pl-flex" />
          <button type="button" class="pl-ib" aria-label="Duplicate" title="Duplicate (Ctrl+D)" disabled={!writable} onClick={() => actions.duplicate(selectedNodes)}><Icon name="copy" size={13} /></button>
          <button type="button" class="pl-ib" aria-label="Delete…" title="Delete… (Del)" disabled={!writable} onClick={() => actions.removeMany(selectedNodes)}><Icon name="trash" size={13} /></button>
          <button type="button" class="pl-ib" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={() => setSelection([])}><Icon name="close" size={13} /></button>
        </div>
      )}
      {menu && menuNode && <ContextMenu entries={entriesFor(menuNode)} at={{ x: menu.x, y: menu.y }} label="Playlist menu" onClose={() => setMenu(null)} />}
      {addMenu && (
        <ContextMenu
          at={addMenu}
          label="New"
          onClose={() => setAddMenu(null)}
          entries={[
            { id: "pl", label: "New playlist", note: selectedFolder ? `in ${selectedFolder}` : "at the top level", title: "A playlist in the selected folder, or at the top level", run: () => actions.newPlaylist(selectedFolder) },
            ...(props.nestInto ? [{ id: "in", label: `New playlist in ${props.nestInto}`, note: "nested", title: "A playlist inside the open playlist", run: () => actions.newPlaylistInside() }] : []),
            { id: "sq", label: "New sequence", note: selectedFolder ? `in ${selectedFolder}` : "at the top level", title: "A timeline of tracks and clips", run: () => actions.newSequence(selectedFolder) },
            SEPARATOR,
            { id: "f", label: "New folder", note: selectedFolder ? `in ${selectedFolder}` : "at the top level", title: "Inside the selected folder, or at the top level", run: () => makeFolder(selectedFolder) },
          ]}
        />
      )}
      {moving && (
        <MoveToDialog
          items={moving.map((n) => ({ path: n.kind === "entry" ? n.file : n.path, folder: n.kind === "folder" }))}
          folders={props.folders}
          noun="playlist"
          onMove={(folder) => {
            actions.moveTo(moving.map((n) => (n.kind === "entry" ? n.file : n.path)), folder);
            setMoving(null);
          }}
          onCancel={() => setMoving(null)}
        />
      )}
    </div>
  );
}
