// The Snapshots panel (ADR 0344; the prototype's snapshot tree): the base mix, then the snapshots by folder, a search
// by name and trigger text, + New snapshot (in the selected folder), New folder, Collapse all, and per row a menu with
// Edit trigger…, Rename (F2), Duplicate, Move to…, Move to top level and Delete (Del; an undo toast brings it back).
// Picking a snapshot makes it the mix you edit ("Editing"): faders then edit its offsets and effect parameters its
// overrides. A dot says whether it is on with the test values.
import { useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { TreeView, renameRow, type TreeRow } from "../../../editor/ui/TreeView";
import type { Snapshot } from "../../../engine/audio/project/types";
import { Icon } from "../../components/Icon";
import { labelOn } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";
import { MixFrame } from "./mixerViewParts";
import { startHolds } from "./snapshotBlend";
import { deleteFolder, duplicateSnapshot, moveFolder, moveSnapshot, newFolderPath, renameFolder, renameSnapshot, searchSnapshots, snapshotFolders, snapshotTree, type SnapshotNode } from "./snapshotTree";
import { openTriggerDialog } from "./TriggerDialog";

const TREE = "mixer-snapshots";
const BASE_KEY = "\u0000base";
const folderKey = (path: string) => `folder:${path}`;
const snapKey = (name: string) => `snap:${name}`;

export function SnapshotsPanel(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const editing = session.editing.value;
  const values = session.testValues.value;
  const extra = session.extraFolders.value;
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [folder, setFolder] = useState<string>("");
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [moving, setMoving] = useState<{ path: string; folder: boolean; name: string } | null>(null);
  const ro = session.readOnly;

  const snapOf = (name: string): Snapshot | undefined => p.snapshots.find((s) => s.name === name);
  const pick = (name: string | null, inFolder: string) => {
    setFolder(inFolder);
    session.editSnapshot(name);
  };
  const remove = (name: string) => session.removeSnapshot(name);
  const removeFolder = (path: string) => {
    session.extraFolders.value = session.extraFolders.peek().filter((f) => f !== path && !f.startsWith(`${path}/`));
    session.commit(deleteFolder(session.project.peek(), path), "Snapshot folders");
  };
  const newSnap = (inFolder: string) => {
    const name = session.newSnapshot(inFolder);
    if (name) {
      setQuery("");
      queueMicrotask(() => renameRow(TREE, snapKey(name)));
    }
  };
  const newFolder = (parent: string) => {
    const path = newFolderPath(session.project.peek(), parent, session.extraFolders.peek());
    session.extraFolders.value = [...session.extraFolders.peek(), path];
    setFolder(path);
    queueMicrotask(() => renameRow(TREE, folderKey(path)));
  };

  const snapRow = (s: { name: string; folder: string }, label = s.name): TreeRow => {
    const snap = snapOf(s.name)!;
    const on = startHolds(snap.start, p.parameters, values);
    return {
      key: snapKey(s.name),
      label,
      expandable: false,
      open: false,
      selected: editing === s.name,
      title: snap.start.kind === "base" ? "Base mix: always on" : undefined,
      icon: <span class={`mx-dot${on ? " on" : ""}`} role="img" aria-label={on ? "on with the test values" : "off with the test values"} />,
      trailing: editing === s.name ? <span class="mx-tag">Editing</span> : snap.start.kind === "base" ? <span class="mx-tag quiet">Base</span> : undefined,
      setOpen: () => {},
      select: () => pick(s.name, s.folder),
      activate: () => openTriggerDialog(session, s.name),
      menu: (x, y) => { pick(s.name, s.folder); setMenu({ x, y, key: snapKey(s.name) }); },
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
      children: n.children.map(row),
      setOpen: (o) => { const s = new Set(closed); if (o) s.delete(n.path); else s.add(n.path); setClosed(s); },
      select: () => setFolder(n.path),
      menu: (x, y) => { setFolder(n.path); setMenu({ x, y, key: folderKey(n.path) }); },
      rename: ro ? null : {
        value: n.name,
        label: "Folder name",
        commit: (v) => {
          if (v === n.name) return;
          const isExtra = session.extraFolders.peek().includes(n.path);
          const parent = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
          const to = parent ? `${parent}/${v.trim()}` : v.trim();
          if (isExtra && !p.snapshots.some((s) => s.folder === n.path || s.folder.startsWith(`${n.path}/`))) {
            if (v.trim() === "" || v.includes("/")) return session.refuse("Rename folder", "a folder name can't be empty or hold a /");
            session.extraFolders.value = session.extraFolders.peek().map((f) => (f === n.path ? to : f));
            return;
          }
          session.commit(renameFolder(session.project.peek(), n.path, v, session.extraFolders.peek()), "Snapshot folders");
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
    title: "The mix without a snapshot: faders edit the saved levels",
    icon: <span class="mx-dot on" aria-hidden="true" />,
    trailing: editing === null ? <span class="mx-tag">Editing</span> : undefined,
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
      { id: "top", label: "Move to top level", disabled: ro || s.folder === "", run: () => session.commit(moveSnapshot(session.project.peek(), name, ""), labelOn("Move snapshot", name)) },
      SEPARATOR,
      { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: ro, run: () => remove(name) },
    ];
  };

  const matches = query.trim() ? searchSnapshots(p.snapshots, query) : null;
  const tree = snapshotTree(p.snapshots, extra);
  return (
    <MixFrame session={session} class="mx-snapshots" label="Snapshots">
      <div class="mx-snap-tools">
        <input type="search" placeholder="Search snapshots" aria-label="Search snapshots" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <button class="mx-tool" disabled={ro} title={folder ? `New snapshot in ${folder}` : "New snapshot"} onClick={() => newSnap(folder)}><Icon name="plus" /> New</button>
        <button class="mx-tool" disabled={ro} title="New folder" onClick={() => newFolder(folder)}><Icon name="folderPlus" /> Folder</button>
        <button class="mx-tool" title="Collapse all" onClick={() => setClosed(new Set(snapshotFolders(p.snapshots, extra)))}>Collapse</button>
      </div>
      {matches ? (
        matches.length === 0 ? <p class="mx-note">No snapshot matches “{query.trim()}”.</p> : <TreeView tree={TREE} label="Matching snapshots" rows={matches.map((m) => snapRow({ name: m.name, folder: snapOf(m.name)!.folder }, m.path))} />
      ) : (
        <TreeView tree={TREE} label="Snapshots" rows={[base, ...tree.map(row)]} />
      )}
      {p.snapshots.length === 0 && !matches && (
        <EmptyState compact icon={<Icon name="snapshot" size={28} />} title="No snapshots yet" body="A snapshot is a named mix the game blends to: a pause menu, underwater, a cutscene." action={{ label: "New snapshot", disabled: ro, run: () => newSnap("") }} />
      )}
      {menu && <ContextMenu entries={entries(menu.key)} at={{ x: menu.x, y: menu.y }} label="Snapshot menu" onClose={() => setMenu(null)} />}
      {moving && (
        <MoveToDialog
          items={[{ path: moving.path, folder: moving.folder }]}
          folders={snapshotFolders(p.snapshots, extra)}
          noun={moving.folder ? "folder" : "snapshot"}
          rootName="Snapshots"
          onMove={(to) => {
            setMoving(null);
            if (moving.folder) session.commit(moveFolder(session.project.peek(), moving.path, to), "Move snapshot");
            else {
              session.commit(moveSnapshot(session.project.peek(), moving.name, to), labelOn("Move snapshot", moving.name));
              session.extraFolders.value = session.extraFolders.peek().filter((f) => f !== to);
            }
          }}
          onCancel={() => setMoving(null)}
        />
      )}
    </MixFrame>
  );
}
