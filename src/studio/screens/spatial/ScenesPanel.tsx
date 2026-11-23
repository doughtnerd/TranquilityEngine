// The Scenes panel (ADR 0347 test scenes in folders; the prototype's scene tree, B.3): the project's test scenes under the
// folders their `folder` fields name, a search, a split New button (+ makes a blank scene; the chevron opens Blank scene,
// From current test scene, From open game scene…, From take…, New folder, each with a line saying what it makes),
// Collapse all, and per row a menu with Rename (F2), Duplicate, Move to…, Move to top level and Delete (Del; an undo
// toast brings it back). A scene row shows its icon, name and what it holds; a folder row its icon, name, how many
// scenes are in it and, on hover, a trash. Double-click renames. Folder edits change the scenes' `folder` fields; files
// go through the asset operations.
import { useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Icon } from "../../components/Icon";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { TreeView, renameRow, type TreeRow } from "../../../editor/ui/TreeView";
import { NEW_SCENE_MENU, type NewSceneKind } from "./newScene";
import { deleteSceneFolder, moveSceneFolder, newSceneFolder, normFolder, renameSceneFolder, sceneFolders, sceneMoveItem, sceneName, sceneTree, searchScenes, type FolderChange, type SceneEntry, type SceneNode } from "./sceneTree";

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

/** How many scenes are in folder `path`, its subfolders included. */
const scenesIn = (entries: readonly SceneEntry[], path: string) => entries.filter((e) => normFolder(e.folder) === path || normFolder(e.folder).startsWith(`${path}/`)).length;

export function ScenesPanel(props: ScenesPanelProps) {
  const { entries, actions, extra } = props;
  const ro = !props.writable;
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [folder, setFolder] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | { at: Element; key: "new" } | null>(null);
  const [moving, setMoving] = useState<{ path: string; folder: boolean } | null>(null);
  const chevron = useRef<HTMLButtonElement>(null);

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
  const moveFolderTo = (path: string, to: string) => {
    const r = moveSceneFolder(entries, path, to);
    if ("refused" in r) return actions.refuse("Move folder", r.refused);
    props.setExtra(extra.map((f) => (f === path ? r.to : f.startsWith(`${path}/`) ? r.to + f.slice(path.length) : f)));
    actions.setFolders(r.changes, "Organise test scenes");
  };

  const sceneRow = (n: { path: string; name: string; folder: string }, label = n.name, meta?: string): TreeRow => ({
    key: sceneKey(n.path),
    label,
    expandable: false,
    open: false,
    selected: props.openPath === n.path,
    className: "sp-scene-row",
    title: `${n.folder ? `${n.folder.split("/").join(" › ")} › ` : ""}${n.name}${ro ? "" : " · F2 to rename"}`,
    icon: <Icon name="scene" size={14} class="sp-scene-icon" />,
    trailing: meta ? <span class="sp-row-meta">{meta}</span> : undefined,
    setOpen: () => {},
    select: () => {
      setFolder(n.folder);
      actions.open(n.path);
    },
    activate: ro ? undefined : () => renameRow(TREE, sceneKey(n.path)),
    menu: (x, y) => setMenu({ x, y, key: sceneKey(n.path) }),
    rename: ro ? null : { value: n.name, label: "Scene name", commit: (v) => v.trim() && v.trim() !== n.name && actions.rename(n.path, v.trim()) },
    remove: ro ? undefined : () => actions.remove([n.path]),
  });
  const row = (n: SceneNode): TreeRow => {
    if (n.kind === "scene") return sceneRow(n, n.name, entryOf(n.path)?.note);
    const open = !closed.has(n.path);
    return {
      key: folderKey(n.path),
      label: n.name,
      expandable: true,
      open,
      className: "sp-folder-row",
      selected: folder === n.path && !entries.some((e) => e.path === props.openPath && e.folder === n.path),
      children: n.children.map(row),
      icon: <Icon name="folder" size={14} class="sp-folder-icon" />,
      trailing: (
        <>
          {!ro && (
            <button
              type="button"
              class="sp-row-trash"
              aria-label={`Delete folder ${n.name}`}
              title="Delete folder (what’s inside moves up a level)"
              onClick={(e) => {
                e.stopPropagation();
                removeFolder(n.path);
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          )}
          <span class="sp-row-count">{scenesIn(entries, n.path)}</span>
        </>
      ),
      setOpen: (o) => {
        const s = new Set(closed);
        if (o) s.delete(n.path);
        else s.add(n.path);
        setClosed(s);
      },
      select: () => {
        setFolder(n.path);
        const s = new Set(closed);
        if (open) s.add(n.path);
        else s.delete(n.path);
        setClosed(s);
      },
      activate: ro ? undefined : () => renameRow(TREE, folderKey(n.path)),
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

  const current = props.openPath ? sceneName(props.openPath) : null;
  const newEntries = (inFolder: string): MenuEntry[] => [
    ...NEW_SCENE_MENU.map((m) => ({
      id: m.id,
      label: m.label,
      detail: m.id === "current" && current ? `Copy of ${current}` : m.detail,
      disabled: ro || (m.id === "current" && !props.hasOpen),
      run: () => actions.newScene(m.id, inFolder),
    })),
    SEPARATOR,
    { id: "folder", label: "New folder", detail: "Inside the selected folder, or at the top level", disabled: ro, run: () => newFolder(inFolder) },
  ];
  const entriesFor = (key: string): MenuEntry[] => {
    if (key === "new") return newEntries(folder);
    if (key.startsWith("folder:")) {
      const path = key.slice(7);
      return [
        { id: "rename", label: "Rename", hint: "F2", disabled: ro, run: () => renameRow(TREE, key) },
        { id: "move", label: "Move to…", disabled: ro, run: () => setMoving({ path, folder: true }) },
        { id: "top", label: "Move to top level", disabled: ro || !path.includes("/"), run: () => moveFolderTo(path, "") },
        SEPARATOR,
        { id: "newScene", label: "New scene here", disabled: ro, run: () => actions.newScene("blank", path) },
        { id: "folder", label: "New folder here", disabled: ro, run: () => newFolder(path) },
        SEPARATOR,
        { id: "delete", label: "Delete folder", hint: "Del", danger: true, disabled: ro, title: "What’s inside moves up a level", run: () => removeFolder(path) },
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
      { id: "delete", label: "Delete scene", hint: "Del", danger: true, disabled: ro, title: "The message that follows can bring it back", run: () => actions.remove([path]) },
    ];
  };

  const matches = query.trim() ? searchScenes(entries, query) : null;
  const folders = sceneFolders(entries, extra);
  return (
    <div class="sp-scenes">
      <div class="sp-scenes-tools">
        <input type="search" class="sp-search" placeholder="Search scenes" aria-label="Search scenes" title="Search test scenes by name; results show each scene’s folder" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <span class="sp-split" role="group" aria-label="New test scene">
          <button type="button" disabled={ro} aria-label="New blank test scene" title={folder ? `New blank test scene in ${folder}` : "New blank test scene"} onClick={() => actions.newScene("blank", folder)}>
            <Icon name="plus" size={14} />
          </button>
          <button ref={chevron} type="button" disabled={ro} aria-haspopup="menu" aria-expanded={menu?.key === "new"} aria-label="More ways to create a test scene or folder" title="More: scene from current, game scene or take, or a new folder" onClick={() => chevron.current && setMenu({ at: chevron.current, key: "new" })}>
            <Icon name="chevronDown" size={12} />
          </button>
        </span>
        <button type="button" class="sp-cib" aria-label="Collapse all" title="Collapse all test scene folders" disabled={folders.length === 0} onClick={() => setClosed(new Set(folders))}>
          <Icon name="collapseAll" size={14} />
        </button>
      </div>
      {entries.length === 0 && extra.length === 0 ? (
        <span title="A test scene places emitters, a listener, obstacles and zones to hear how spatial settings sound, through the engine's own audio.">
          <EmptyState compact title="No test scenes yet" icon={<Icon name="spatial" size={28} />} action={{ label: "New test scene", disabled: ro, run: () => actions.newScene("blank", "") }} />
        </span>
      ) : matches ? (
        matches.length === 0 ? (
          <p class="sp-nomatch">No matches</p>
        ) : (
          <TreeView tree={TREE} label="Matching scenes" class="tree sp-scene-tree" indent={12} rows={matches.map((m) => {
            const e = entryOf(m.path);
            return sceneRow({ path: m.path, name: sceneName(m.path), folder: e?.folder ?? "" }, sceneName(m.path), e?.folder ? e.folder.split("/").join(" › ") : e?.note);
          })} />
        )
      ) : (
        <TreeView tree={TREE} label="Test scenes" class="tree sp-scene-tree" indent={12} rows={sceneTree(entries, extra).map(row)} />
      )}
      {menu && <ContextMenu entries={entriesFor(menu.key)} at={"at" in menu ? menu.at : { x: menu.x, y: menu.y }} label={menu.key === "new" ? "New test scene" : menu.key.startsWith("folder:") ? "Folder menu" : "Scene menu"} onClose={() => setMenu(null)} />}
      {moving && (
        <MoveToDialog
          items={[moving.folder ? { path: moving.path, folder: true } : sceneMoveItem(entryOf(moving.path) ?? { path: moving.path, folder: "" })]}
          folders={folders}
          noun={moving.folder ? "folder" : "test scene"}
          rootName="Top level"
          onMove={(to) => {
            setMoving(null);
            if (moving.folder) moveFolderTo(moving.path, to);
            else {
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
