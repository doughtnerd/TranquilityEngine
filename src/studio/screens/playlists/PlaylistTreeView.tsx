// The Playlists panel's view (the prototype's tree, ADR 0335 kit): the project's playlists by folder in the editor's
// `TreeView`, embedded playlists nested under their parent and linked ones dashed with a link mark, type badges, the
// output-override marker, search (matches with their paths), folder rows with counts, context menus, Move to…, a
// multi-select bar, and drag to move or nest (before / into / after, checked by `treeDrop.ts` while dragging). The empty
// state offers New playlist, New folder and, with no samples yet, Samples. A view over props; the panel wires actions.
import { useMemo, useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { TreeView, renameRow, type TreeRow } from "../../../editor/ui/TreeView";
import { TypeBadge } from "../../components/TypeBadge";
import { findNode, searchTree, type PlaylistNode } from "./playlistTree";
import { dropZone, type DragSource, type DropPlan, type DropTarget, type DropZone } from "./treeDrop";

export interface TreeActions {
  open(node: PlaylistNode): void;
  newPlaylist(folder: string): void;
  /** New playlist inside the open one (an embedded Queue), when it holds entries. */
  newPlaylistInside(): void;
  newSequence(folder: string): void;
  newFolder(parent: string): void;
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

const sourceOf = (n: PlaylistNode): DragSource =>
  n.kind === "folder" ? { kind: "folder", path: n.path } : n.kind === "file" ? { kind: "file", path: n.path } : { kind: "entry", file: n.file, parent: n.indices.slice(0, -1), index: n.indices[n.indices.length - 1]!, link: n.link };
const targetOf = (n: PlaylistNode): DropTarget =>
  n.kind === "folder" ? { kind: "folder", path: n.path } : n.kind === "file" ? { kind: "file", path: n.path } : { kind: "entry", file: n.file, parent: n.indices.slice(0, -1), index: n.indices[n.indices.length - 1]!, link: n.link };

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
    const up = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      const d = dragRef.current;
      setDrag(null);
      if (!started || !d || !d.over || !d.plan) return;
      const target = d.over === "root" ? ({ kind: "root" } as const) : targetOf(findNode(nodes, d.over)!);
      actions.drop(d.plan, n.kind === "folder" ? { kind: "folder", path: n.path, name: n.name } : n, target);
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
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
        icon: <span class="pl-folder-icon" aria-hidden="true">▸</span>,
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
          {linked && <span class="pl-link-mark" title="Linked copy" aria-label="Linked copy">⛓</span>}
          {n.kind === "file" && n.linkedBy.length > 0 && <span class="pl-link-mark pl-original" title={`Linked in ${n.linkedBy.length} playlist${n.linkedBy.length === 1 ? "" : "s"}`} aria-label="Linked elsewhere">⛓</span>}
          {n.output && <span class="pl-out-mark" title={`Plays on ${n.output} (its own output)`}>→ {n.output}</span>}
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
  const toggleOpen = (key: string, open: boolean) => {
    const next = new Set(closed);
    if (open) next.delete(key);
    else next.add(key);
    setClosed(next);
  };

  const entriesFor = (n: PlaylistNode): MenuEntry[] => {
    if (selection.length > 1 && selection.includes(n.key)) {
      return [
        { id: "dup", label: `Duplicate ${selection.length}`, disabled: !writable, run: () => actions.duplicate(selectedNodes) },
        { id: "move", label: "Move to…", disabled: !writable || selectedNodes.some((x) => x.kind === "entry"), run: () => setMoving(selectedNodes) },
        SEPARATOR,
        { id: "del", label: `Delete ${selection.length}…`, danger: true, disabled: !writable, run: () => actions.removeMany(selectedNodes) },
      ];
    }
    if (n.kind === "folder") {
      return [
        { id: "rename", label: "Rename", hint: "F2", disabled: !writable, run: () => renameRow(TREE, n.key) },
        { id: "folder", label: "New folder inside", disabled: !writable, run: () => actions.newFolder(n.path) },
        { id: "new", label: "New playlist here", disabled: !writable, run: () => actions.newPlaylist(n.path) },
        SEPARATOR,
        { id: "move", label: "Move to…", disabled: !writable, run: () => setMoving([n]) },
        { id: "top", label: "Move to top level", disabled: !writable || !n.path.includes("/"), run: () => actions.moveTo([n.path], "") },
        SEPARATOR,
        { id: "del", label: "Delete folder", hint: "Del", danger: true, disabled: !writable, run: () => actions.deleteFolder(n.path) },
      ];
    }
    const linked = n.kind === "entry" && n.link !== null;
    return tidyEntries([
      { id: "open", label: "Open", run: () => actions.open(n) },
      SEPARATOR,
      n.kind === "file" && { id: "rename", label: "Rename", hint: "F2", disabled: !writable, run: () => renameRow(TREE, n.key) },
      { id: "dup", label: "Duplicate", disabled: !writable, run: () => actions.duplicate([n]) },
      linked && { id: "unlink", label: "Unlink", title: "Make this an embedded copy: later edits change only this one", disabled: !writable, run: () => actions.unlink(n) },
      n.kind === "entry" && !linked && { id: "share", label: "Make shared", title: "Move it to a file of its own and link it here, so other playlists can use it", disabled: !writable, run: () => actions.makeShared(n) },
      SEPARATOR,
      n.kind === "file" && { id: "move", label: "Move to…", disabled: !writable, run: () => setMoving([n]) },
      n.kind === "file" && { id: "top", label: "Move to top level", disabled: !writable || !n.path.includes("/"), run: () => actions.moveTo([n.path], "") },
      SEPARATOR,
      linked
        ? { id: "remove", label: "Remove link", hint: "Del", danger: true, disabled: !writable, run: () => actions.remove(n) }
        : { id: "del", label: "Delete…", hint: "Del", danger: true, disabled: !writable, run: () => actions.remove(n) },
    ]);
  };

  const hits = query.trim() ? searchTree(nodes, query) : null;
  const menuNode = menu ? findNode(nodes, menu.key) : null;

  return (
    <div class="pl-tree" data-keyscope="playlists-tree">
      <div class="pl-tree-tools">
        <input type="search" class="pl-search" placeholder="Search playlists" aria-label="Search playlists" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <button type="button" class="pl-tool" disabled={!writable} title={writable ? "New playlist, sequence or folder" : "This project is read-only"} aria-label="New" onClick={(e) => setAddMenu(e.currentTarget as Element)}>
          +
        </button>
      </div>
      {drag && (
        <div class={`pl-top-drop${drag.over === "root" ? " over" : ""}`} data-pl-key="root">
          ⤒ Top level
        </div>
      )}
      {drag?.plan?.kind === "refused" && <p class="pl-drop-why" role="status">{drag.plan.reason}</p>}
      {!any && !hits ? (
        <EmptyState
          compact
          title="No playlists yet"
          body={<p>A playlist decides what plays when the game asks for a sound: one clip, a random pick, a switch, a blend or layers.</p>}
          action={{ label: "New playlist", disabled: !writable, run: () => actions.newPlaylist(selectedFolder) }}
        >
          <div class="pl-empty-actions">
            <button type="button" disabled={!writable} onClick={() => actions.newFolder(selectedFolder)}>New folder</button>
            {!props.hasSamples && <button type="button" onClick={actions.openSamples}>Import some in Samples</button>}
          </div>
        </EmptyState>
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
        <div class="pl-multibar" role="toolbar" aria-label="Selected playlists">
          <span>{selection.length} selected</span>
          <button type="button" disabled={!writable} onClick={() => actions.duplicate(selectedNodes)}>Duplicate</button>
          <button type="button" disabled={!writable || selectedNodes.some((x) => x.kind === "entry")} onClick={() => setMoving(selectedNodes)}>Move to…</button>
          <button type="button" class="pl-danger" disabled={!writable} onClick={() => actions.removeMany(selectedNodes)}>Delete…</button>
          <button type="button" aria-label="Clear the selection" onClick={() => setSelection([])}>×</button>
        </div>
      )}
      {menu && menuNode && <ContextMenu entries={entriesFor(menuNode)} at={{ x: menu.x, y: menu.y }} label="Playlist menu" onClose={() => setMenu(null)} />}
      {addMenu && (
        <ContextMenu
          at={addMenu}
          label="New"
          onClose={() => setAddMenu(null)}
          entries={[
            { id: "pl", label: "New playlist", run: () => actions.newPlaylist(selectedFolder) },
            ...(props.nestInto ? [{ id: "in", label: `New playlist in ${props.nestInto}`, run: () => actions.newPlaylistInside() }] : []),
            { id: "sq", label: "New sequence", run: () => actions.newSequence(selectedFolder) },
            { id: "f", label: "New folder", run: () => actions.newFolder(selectedFolder) },
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
