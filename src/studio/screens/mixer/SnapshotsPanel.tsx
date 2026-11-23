// The Snapshots panel (ADR 0344; the prototype's snapshot tree): the base mix, then the snapshots by folder (folders
// first, then snapshots, alphabetically), a search by name and trigger text (results show their folder), a split
// + (New snapshot in the selected folder; ▾ New folder), Collapse all, and per row a menu with Edit trigger…, Rename
// (F2), Duplicate, Move to…, Move to top level, Undo and Delete snapshot (Del; an undo toast brings it back). Drag a
// snapshot or a folder onto a folder, or onto "⤒ Top level", to move it. A folder row shows its count and a hover
// trash. Folders are part of `audio.json` (empty ones too), so every folder edit is an undo step with its own label.
// Picking a snapshot makes it the mix you edit ("EDITING"): faders then edit its offsets and effect parameters its
// overrides. A dot says whether it is active with the test values; its trigger summary sits at the right.
import { useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { TreeView, renameRow, type TreeRow } from "../../../editor/ui/TreeView";
import type { Snapshot } from "../../../engine/audio/project/types";
import { Icon } from "../../components/Icon";
import { labelOn } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";
import { MixFrame, undoEntry } from "./mixerViewParts";
import { startHolds, triggerSummary, triggerText } from "./snapshotBlend";
import { deleteFolder, duplicateSnapshot, renameSnapshot, followFolder, moveFolder, moveSnapshot, renameFolder, searchSnapshots, snapshotFolders, snapshotTree, type SnapshotNode } from "./snapshotTree";
import { openTriggerDialog } from "./TriggerDialog";

const TREE = "mixer-snapshots";
const BASE_KEY = "\u0000base";
const folderKey = (path: string) => `folder:${path}`;
const snapKey = (name: string) => `snap:${name}`;
const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** What is being dragged (a snapshot by name, or a folder by path) and the folder it's over ("" = the top level). */
type SnapDrag = { kind: "snapshot" | "folder"; id: string; over: string | null; started: boolean } | null;

/** The snapshot glyph: a dashed frame with three fader caps (the prototype's 14×13 mark). */
const Glyph = () => (
  <svg class="mx-snap-glyph" width="14" height="13" viewBox="0 0 14 13" aria-hidden="true">
    <path d="M1 4V1h3M10 1h3v3M13 9v3h-3M4 12H1V9" fill="none" stroke="currentColor" stroke-width="1.2" />
    <path d="M4.5 4v5M7 3v7M9.5 5v3" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" />
  </svg>
);

export function SnapshotsPanel(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const editing = session.editing.value;
  const values = session.testValues.value;
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [folder, setFolder] = useState<string>("");
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [moving, setMoving] = useState<{ path: string; folder: boolean; name: string } | null>(null);
  const [drag, setDrag] = useState<SnapDrag>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const ro = session.readOnly;

  const snapOf = (name: string): Snapshot | undefined => p.snapshots.find((s) => s.name === name);
  const pick = (name: string | null, inFolder: string) => {
    setFolder(inFolder);
    session.editSnapshot(name);
  };
  const remove = (name: string) => session.removeSnapshot(name);
  /** Folder `from` is now `to`: the selected folder and the folded ones follow it. */
  const followSelection = (from: string, to: string) => {
    setFolder((f) => followFolder(f, from, to));
    setClosed((c) => new Set([...c].map((f) => followFolder(f, from, to))));
  };
  const removeFolder = (path: string) => {
    if (session.commit(deleteFolder(session.project.peek(), path), labelOn("Delete folder", leaf(path)))) followSelection(path, parentOf(path));
  };
  const moveFolderTo = (path: string, into: string) => {
    const r = moveFolder(session.project.peek(), path, into);
    if ("refused" in r) return session.refuse("Move folder", r.refused);
    if (session.commit({ next: r.next.project }, labelOn("Move folder", leaf(path)))) followSelection(path, r.next.path);
  };
  const moveSnapTo = (name: string, into: string) => session.commit(moveSnapshot(session.project.peek(), name, into), labelOn("Move snapshot", name));
  const newSnap = (inFolder: string) => {
    const name = session.newSnapshot(inFolder);
    if (name) {
      setQuery("");
      // The folder it lands in (and those above it) open, so the rename shows.
      if (inFolder) setClosed((c) => new Set([...c].filter((f) => inFolder !== f && !inFolder.startsWith(`${f}/`))));
      queueMicrotask(() => renameRow(TREE, snapKey(name)));
    }
  };
  const newFolder = (parent: string) => {
    const path = session.newFolder(parent);
    if (path === null) return;
    setQuery("");
    setFolder(path);
    queueMicrotask(() => renameRow(TREE, folderKey(path)));
  };

  /** A press on a row: past 4 px it becomes a drag onto folders or the top level. */
  const startDrag = (kind: "snapshot" | "folder", id: string) => (e: PointerEvent) => {
    if (ro || e.button !== 0 || e.pointerType === "touch") return;
    const x0 = e.clientX, y0 = e.clientY;
    let state: NonNullable<SnapDrag> = { kind, id, over: null, started: false };
    const target = (ev: PointerEvent): string | null => {
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-snap-folder], [data-snap-top]");
      if (!el) return null;
      return el.dataset.snapTop !== undefined ? "" : (el.dataset.snapFolder ?? null);
    };
    const move = (ev: PointerEvent) => {
      if (!state.started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      state = { ...state, started: true, over: target(ev) };
      setDrag(state);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrag(null);
      if (!state.started || ev.type === "pointercancel") return;
      const into = target(ev);
      if (into === null) return;
      if (kind === "snapshot") {
        if (snapOf(id)?.folder !== into) moveSnapTo(id, into);
      } else if (into !== id && parentOf(id) !== into) moveFolderTo(id, into);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  /** Whether the current drag may drop into folder `path`. */
  const canDrop = (path: string): boolean => {
    if (!drag?.started) return false;
    if (drag.kind === "snapshot") return snapOf(drag.id)?.folder !== path;
    return path !== drag.id && !path.startsWith(`${drag.id}/`) && parentOf(drag.id) !== path;
  };

  const snapRow = (s: { name: string; folder: string }, meta?: string): TreeRow => {
    const snap = snapOf(s.name)!;
    const on = startHolds(snap.start, p.parameters, values);
    const isEditing = editing === s.name;
    return {
      key: snapKey(s.name),
      label: s.name,
      expandable: false,
      open: false,
      selected: isEditing,
      className: "mx-snap-row",
      dragging: drag?.started && drag.kind === "snapshot" && drag.id === s.name,
      title: `${s.folder ? `${s.folder.split("/").join(" › ")} › ` : ""}${s.name} · ${triggerText(snap.start, p.parameters)} · drag onto a folder to move it · F2 to rename`,
      icon: (
        <>
          <Glyph />
          <span class={`mx-dot${on ? " on" : ""}`} role="img" aria-label={on ? "Active: its trigger is true right now" : "Not active: its trigger isn't true right now"} title={on ? "Active: its trigger is true right now" : "Not active: its trigger isn't true right now"} />
        </>
      ),
      trailing: (
        <>
          {isEditing && <span class="mx-editing" title="The mix you are editing">Editing</span>}
          <span class="mx-snap-meta">{meta ?? triggerSummary(snap.start, p.parameters)}</span>
        </>
      ),
      setOpen: () => {},
      select: () => pick(s.name, s.folder),
      activate: () => openTriggerDialog(session, s.name),
      menu: (x, y) => { pick(s.name, s.folder); setMenu({ x, y, key: snapKey(s.name) }); },
      drag: startDrag("snapshot", s.name),
      rename: ro ? null : {
        value: s.name,
        label: "Snapshot name",
        commit: (v) => {
          if (v === s.name) return;
          const wasEditing = session.editing.peek() === s.name;
          if (session.commit(renameSnapshot(session.project.peek(), s.name, v), labelOn("Rename snapshot", s.name)) && wasEditing) session.editing.value = v;
        },
      },
      remove: ro ? undefined : () => remove(s.name),
    };
  };
  const row = (n: SnapshotNode): TreeRow => {
    if (n.kind === "snapshot") return snapRow(n);
    const open = !closed.has(n.path);
    return {
      key: folderKey(n.path),
      label: n.name,
      expandable: true,
      open,
      selected: folder === n.path && editing === null,
      className: "mx-folder-row",
      attrs: { "data-snap-folder": n.path },
      drop: canDrop(n.path) && drag?.over === n.path ? "into" : null,
      dragging: drag?.started && drag.kind === "folder" && drag.id === n.path,
      title: `${n.path.split("/").join(" › ")} · double-click to rename · drop snapshots here`,
      icon: <Icon name="folder" size={14} />,
      trailing: (
        <>
          {!ro && (
            <button class="mx-fdel" aria-label={`Delete folder ${n.name}`} title="Delete folder (what's inside moves up a level)" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); removeFolder(n.path); }}>
              <Icon name="trash" size={12} />
            </button>
          )}
          <span class="mx-snap-count">{n.count}</span>
        </>
      ),
      children: n.children.map(row),
      setOpen: (o) => { const s = new Set(closed); if (o) s.delete(n.path); else s.add(n.path); setClosed(s); },
      select: () => { setFolder(n.path); },
      menu: (x, y) => { setFolder(n.path); setMenu({ x, y, key: folderKey(n.path) }); },
      drag: startDrag("folder", n.path),
      rename: ro ? null : {
        value: n.name,
        label: "Folder name",
        commit: (v) => {
          if (v.trim() === n.name) return;
          // The rename is an edit of the file (empty folders are in it too), so the folder never comes back under its
          // old name, and the selection follows so + New files into the renamed folder.
          const r = renameFolder(session.project.peek(), n.path, v);
          if ("refused" in r) return session.refuse("Rename folder", r.refused);
          if (session.commit({ next: r.next.project }, labelOn("Rename folder", n.name))) followSelection(n.path, r.next.path);
        },
      },
      remove: ro ? undefined : () => removeFolder(n.path),
    };
  };
  const base: TreeRow = {
    key: BASE_KEY,
    label: "Base mix",
    expandable: false,
    open: false,
    selected: editing === null,
    className: "mx-snap-row",
    title: "The mix without a snapshot: faders edit the saved levels",
    icon: (
      <>
        <Glyph />
        <span class="mx-dot on" aria-hidden="true" />
      </>
    ),
    trailing: (
      <>
        {editing === null && <span class="mx-editing" title="The mix you are editing">Editing</span>}
        <span class="mx-snap-meta">Always on</span>
      </>
    ),
    setOpen: () => {},
    select: () => pick(null, ""),
  };

  const entries = (key: string): MenuEntry[] => {
    if (key.startsWith("folder:")) {
      const path = key.slice(7);
      return [
        { id: "new", label: "New snapshot here", disabled: ro, run: () => newSnap(path) },
        { id: "folder", label: "New folder", disabled: ro, run: () => newFolder(path) },
        { id: "rename", label: "Rename", hint: "F2", disabled: ro, run: () => renameRow(TREE, key) },
        { id: "move", label: "Move to…", disabled: ro, run: () => setMoving({ path, folder: true, name: path }) },
        { id: "top", label: "Move to top level", disabled: ro || !path.includes("/"), run: () => moveFolderTo(path, "") },
        SEPARATOR,
        undoEntry(),
        SEPARATOR,
        { id: "delete", label: "Delete folder", hint: "Del", danger: true, disabled: ro, title: "What's in it moves up a level", run: () => removeFolder(path) },
      ];
    }
    const name = key.slice(5);
    const s = snapOf(name);
    if (!s) return [];
    const path = s.folder ? `${s.folder}/${name}` : name;
    return [
      { id: "trigger", label: "Edit trigger…", disabled: ro, run: () => openTriggerDialog(session, name) },
      { id: "rename", label: "Rename", hint: "F2", disabled: ro, run: () => renameRow(TREE, key) },
      { id: "duplicate", label: "Duplicate", disabled: ro, run: () => { const r = duplicateSnapshot(session.project.peek(), name); if ("refused" in r) session.refuse("Duplicate snapshot", r.refused); else if (session.commit({ next: r.next.project }, labelOn("Duplicate snapshot", name))) session.editSnapshot(r.next.name); } },
      { id: "move", label: "Move to…", disabled: ro, run: () => setMoving({ path, folder: false, name }) },
      { id: "top", label: "Move to top level", disabled: ro || s.folder === "", run: () => moveSnapTo(name, "") },
      SEPARATOR,
      undoEntry(),
      SEPARATOR,
      { id: "delete", label: "Delete snapshot", hint: "Del", danger: true, disabled: ro, run: () => remove(name) },
    ];
  };

  const matches = query.trim() ? searchSnapshots(p.snapshots, query, p.parameters) : null;
  const tree = snapshotTree(p, p.parameters);
  const folders = snapshotFolders(p);
  return (
    <MixFrame session={session} class="mx-snapshots" label="Snapshots">
      <div class="mx-snap-tools">
        <input type="search" placeholder="Search snapshots" aria-label="Search snapshots" title="Search snapshots by name or trigger; results show each snapshot's folder" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <span class="mx-split">
          <button class="mx-split-main" aria-label="New snapshot" disabled={ro} title={folder ? `New snapshot (in ${folder})` : "New snapshot (in the selected folder)"} onClick={() => newSnap(folder)}><Icon name="plus" size={14} /></button>
          <button ref={chevron} class="mx-split-more" aria-label="More: New snapshot, New folder" title="More: New snapshot, New folder" aria-haspopup="menu" aria-expanded={addMenu} disabled={ro} onClick={() => setAddMenu(!addMenu)}><Icon name="chevronDown" size={11} /></button>
        </span>
        <button class="kit-icon-button mx-cib" aria-label="Collapse all" title="Collapse all snapshot folders" onClick={() => setClosed(new Set(folders))}><Icon name="collapse" size={14} /></button>
      </div>
      {addMenu && chevron.current && (
        <ContextMenu
          entries={[
            { id: "snap", label: "New snapshot", note: "in the selected folder", run: () => newSnap(folder) },
            SEPARATOR,
            { id: "folder", label: "New folder", note: folder ? `inside ${leaf(folder)}` : "at the top level", run: () => newFolder(folder) },
          ]}
          at={chevron.current}
          label="New"
          onClose={() => setAddMenu(false)}
        />
      )}
      {matches ? (
        matches.length === 0 ? <p class="mx-note">No matches</p> : <TreeView tree={TREE} label="Matching snapshots" rows={matches.map((m) => snapRow({ name: m.name, folder: m.folder }, m.folder ? `${m.folder.split("/").join(" › ")} · ${triggerSummary(snapOf(m.name)!.start, p.parameters)}` : undefined))} />
      ) : (
        <TreeView tree={TREE} label="Snapshots" rows={[base, ...tree.map(row)]} />
      )}
      {drag?.started && (
        <div class={`mx-top-zone${drag.over === "" && canDrop("") ? " drop" : ""}`} data-snap-top="" aria-hidden="true">⤒ Top level</div>
      )}
      {p.snapshots.length === 0 && folders.length === 0 && !matches && (
        <EmptyState compact icon={<Icon name="snapshot" size={28} />} title="No snapshots yet" body="A snapshot is a named mix the game blends to: a pause menu, underwater, a cutscene." action={{ label: "New snapshot", disabled: ro, run: () => newSnap("") }} />
      )}
      {menu && <ContextMenu entries={entries(menu.key)} at={{ x: menu.x, y: menu.y }} label="Snapshot menu" onClose={() => setMenu(null)} />}
      {moving && (
        <MoveToDialog
          items={[{ path: moving.path, folder: moving.folder }]}
          folders={folders}
          noun={moving.folder ? "folder" : "snapshot"}
          rootName="Snapshots"
          onMove={(to) => {
            setMoving(null);
            if (moving.folder) moveFolderTo(moving.path, to);
            else moveSnapTo(moving.name, to);
          }}
          onCancel={() => setMoving(null)}
        />
      )}
    </MixFrame>
  );
}
