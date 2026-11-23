// The Scenes panel (ADR 0347 test scenes in folders; the prototype's scene tree, B.3): the project's test scenes under the
// folders their `folder` fields name, a search, New (Blank scene, From current test scene, From open game scene…, From
// take…, New folder), and per row a menu with Rename (F2), Duplicate, Move to…, Move to top level and Delete (Del; an
// undo toast brings it back). Folder edits change the scenes' `folder` fields; files go through the asset operations.
import { useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { TreeView, renameRow, type TreeRow } from "../../../editor/ui/TreeView";
import { NEW_SCENE_MENU, type NewSceneKind } from "./newScene";
import { deleteSceneFolder, moveSceneFolder, newSceneFolder, renameSceneFolder, sceneFolders, sceneTree, searchScenes, type FolderChange, type SceneEntry, type SceneNode } from "./sceneTree";

const TREE = "spatial-scenes";
const folderKey = (path: string) => `folder:${path}`;
const sceneKey = (path: string) => `scene:${path}`;

export interface ScenesActions {
  open(path: string): void;
  newScene(kind: NewSceneKind, folder: string): void;
  rename(path: string, name: string): void;
  duplicate(path: string): void;
  remove(paths: readonly string[]): void;
  /** Change scenes' folder fields (one step on each scene), labelled. */
  setFolders(changes: readonly FolderChange[], label: string): void;
  /** Refused folder edit: say why. */
  refuse(label: string, why: string): void;
}

export interface ScenesPanelProps {
  readonly entries: readonly SceneEntry[];
  readonly openPath: string | null;
  readonly writable: boolean;
  /** Whether a scene is open (From current test scene needs one). */
  readonly hasOpen: boolean;
  /** Folders made this session that hold no scene yet. */
  readonly extra: readonly string[];
  setExtra(folders: readonly string[]): void;
  readonly actions: ScenesActions;
}

export function ScenesPanel(props: ScenesPanelProps) {
  const { entries, actions, extra } = props;
  const ro = !props.writable;
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [folder, setFolder] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | { at: Element; key: "new" } | null>(null);
  const [moving, setMoving] = useState<{ path: string; folder: boolean } | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);

  const entryOf = (path: string) => entries.find((e) => e.path === path);
  const newFolder = (parent: string) => {
    const path = newSceneFolder(entries, parent, extra);
    props.setExtra([...extra, path]);
    setFolder(path);
    queueMicrotask(() => renameRow(TREE, folderKey(path)));
  };
  const removeFolder = (path: string) => {
    props.setExtra(extra.filter((f) => f !== path && !f.startsWith(`${path}/`)));
    actions.setFolders(deleteSceneFolder(entries, path), "Organise test scenes");
  };

  const sceneRow = (n: { path: string; name: string; folder: string }, label = n.name): TreeRow => ({
    key: sceneKey(n.path),
    label,
    expandable: false,
    open: false,
    selected: props.openPath === n.path,
    title: n.path,
    icon: <span class="sp-scene-icon" aria-hidden="true">◎</span>,
    setOpen: () => {},
    select: () => {
      setFolder(n.folder);
      actions.open(n.path);
    },
    menu: (x, y) => setMenu({ x, y, key: sceneKey(n.path) }),
    rename: ro ? null : { value: n.name, label: "Scene name", commit: (v) => v.trim() && v.trim() !== n.name && actions.rename(n.path, v.trim()) },
    remove: ro ? undefined : () => actions.remove([n.path]),
  });
  const row = (n: SceneNode): TreeRow => {
    if (n.kind === "scene") return sceneRow(n);
    const open = !closed.has(n.path);
    return {
      key: folderKey(n.path),
      label: n.name,
      expandable: true,
      open,
      selected: folder === n.path && !entries.some((e) => e.path === props.openPath && e.folder === n.path),
      children: n.children.map(row),
      setOpen: (o) => {
        const s = new Set(closed);
        if (o) s.delete(n.path);
        else s.add(n.path);
        setClosed(s);
      },
      select: () => setFolder(n.path),
      menu: (x, y) => {
        setFolder(n.path);
        setMenu({ x, y, key: folderKey(n.path) });
      },
      rename: ro ? null : {
        value: n.name,
        label: "Folder name",
        commit: (v) => {
          if (v === n.name) return;
          const r = renameSceneFolder(entries, n.path, v, extra);
          if ("refused" in r) return actions.refuse("Rename folder", r.refused);
          props.setExtra(extra.map((f) => (f === n.path ? r.to : f.startsWith(`${n.path}/`) ? r.to + f.slice(n.path.length) : f)));
          actions.setFolders(r.changes, "Organise test scenes");
        },
      },
      remove: ro ? undefined : () => removeFolder(n.path),
    };
  };

  const newEntries = (inFolder: string): MenuEntry[] => [
    ...NEW_SCENE_MENU.map((m) => ({ id: m.id, label: m.label, title: m.hint, disabled: ro || (m.id === "current" && !props.hasOpen), run: () => actions.newScene(m.id, inFolder) })),
    SEPARATOR,
    { id: "folder", label: "New folder", disabled: ro, run: () => newFolder(inFolder) },
  ];
  const entriesFor = (key: string): MenuEntry[] => {
    if (key === "new") return newEntries(folder);
    if (key.startsWith("folder:")) {
      const path = key.slice(7);
      return [
        ...newEntries(path).slice(0, 1).map((e) => ({ ...e, label: "New scene here" })),
        { id: "folder", label: "New folder", disabled: ro, run: () => newFolder(path) },
        { id: "rename", label: "Rename", hint: "F2", disabled: ro, run: () => renameRow(TREE, key) },
        { id: "move", label: "Move to…", disabled: ro, run: () => setMoving({ path, folder: true }) },
        SEPARATOR,
        { id: "delete", label: "Delete folder", hint: "Del", danger: true, disabled: ro, title: "The scenes in it move up a level", run: () => removeFolder(path) },
      ];
    }
    const path = key.slice(6);
    const e = entryOf(path);
    if (!e) return [];
    return [
      { id: "open", label: "Open", run: () => actions.open(path) },
      { id: "rename", label: "Rename", hint: "F2", disabled: ro, run: () => renameRow(TREE, key) },
      { id: "duplicate", label: "Duplicate", disabled: ro, run: () => actions.duplicate(path) },
      { id: "move", label: "Move to…", disabled: ro, run: () => setMoving({ path, folder: false }) },
      { id: "top", label: "Move to top level", disabled: ro || e.folder === "", run: () => actions.setFolders([{ path, folder: "" }], "Move test scene") },
      SEPARATOR,
      { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: ro, run: () => actions.remove([path]) },
    ];
  };

  const matches = query.trim() ? searchScenes(entries, query) : null;
  const folders = sceneFolders(entries, extra);
  return (
    <div class="sp-scenes">
      <div class="sp-scenes-tools">
        <input type="search" placeholder="Search scenes" aria-label="Search scenes" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <button ref={newButton} type="button" class="sp-small" disabled={ro} aria-haspopup="menu" title={folder ? `New test scene in ${folder}` : "New test scene"} onClick={() => newButton.current && setMenu({ at: newButton.current, key: "new" })}>
          + New
        </button>
        <button type="button" class="sp-small" title="Collapse all" onClick={() => setClosed(new Set(folders))}>Collapse</button>
      </div>
      {entries.length === 0 && extra.length === 0 ? (
        <EmptyState
          compact
          title="No test scenes yet"
          icon="◎"
          body="A test scene places sources, a listener, obstacles and zones to hear how spatial settings sound, through the engine's own audio."
          action={{ label: "New test scene", disabled: ro, run: () => actions.newScene("blank", "") }}
        />
      ) : matches ? (
        matches.length === 0 ? (
          <p class="sp-note">No scene matches “{query.trim()}”.</p>
        ) : (
          <TreeView tree={TREE} label="Matching scenes" rows={matches.map((m) => sceneRow({ path: m.path, name: m.label, folder: entryOf(m.path)?.folder ?? "" }, m.label))} />
        )
      ) : (
        <TreeView tree={TREE} label="Test scenes" rows={sceneTree(entries, extra).map(row)} />
      )}
      {menu && <ContextMenu entries={entriesFor(menu.key)} at={"at" in menu ? menu.at : { x: menu.x, y: menu.y }} label={menu.key === "new" ? "New test scene" : "Scene menu"} onClose={() => setMenu(null)} />}
      {moving && (
        <MoveToDialog
          items={[{ path: moving.folder ? moving.path : `${entryOf(moving.path)?.folder ? `${entryOf(moving.path)!.folder}/` : ""}${moving.path.slice(moving.path.lastIndexOf("/") + 1)}`, folder: moving.folder }]}
          folders={folders}
          noun={moving.folder ? "folder" : "test scene"}
          rootName="Test scenes"
          onMove={(to) => {
            setMoving(null);
            if (moving.folder) {
              const r = moveSceneFolder(entries, moving.path, to);
              if ("refused" in r) return actions.refuse("Move folder", r.refused);
              props.setExtra(extra.map((f) => (f === moving.path ? r.to : f.startsWith(`${moving.path}/`) ? r.to + f.slice(moving.path.length) : f)));
              actions.setFolders(r.changes, "Organise test scenes");
            } else {
              actions.setFolders([{ path: moving.path, folder: to }], "Move test scene");
              props.setExtra(extra.filter((f) => f !== to));
            }
          }}
          onCancel={() => setMoving(null)}
        />
      )}
    </div>
  );
}
