import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { computed, signal, type Signal } from "@preact/signals";
import { Panel, usePanelValue } from "./panel/Panel";
import { pathKey, type SceneDocument } from "../document";
import { deleteSelected } from "../deleteSelection";
import { renameNode } from "../nodeEdits";
import { assetDrag } from "../assetDrag";
import { filterHierarchy } from "../hierarchyFilter";
import { nodeDrag, startNodeDrag } from "../nodeDrag";
import { isHidden, isLocked, nodeFlags, setHidden, setLocked } from "../nodeVisibility";
import { instanceInnerNodes, type InnerNode } from "../prefabs";
import { openPrefabFrom } from "../prefabTabs";
import { ancestorKeys, combineSelection, rangeBetween } from "../selectionModel";
import { inspectorTarget, select, selectBone, selectUIElement, showSceneSettings } from "../inspectorTarget";
import { skeletonBones, type SkeletonBoneRow, type SkeletonBonesContribution } from "../sdk/contributions";
import { docVersion, isSelected, openScene, selectedKeys, selectedUIElement, type OpenScene } from "../state";
import { HIERARCHY_TREE, HierarchyMenu, openCreateMenu, openHierarchyMenu, openUIViewElementMenu, uiTreeKey } from "./HierarchyMenu";
import { resolveUIViewElement, selectedUIViewRef, uiViewVersion, viewRowAncestry, viewRows, watchUIViews, whyViewOnly, type UIViewRow, type UIViewRows } from "../uiViews";
import { renameUIViewElement, whyNotEditViewElement } from "../uiViewEdits";

import { whyNotEdit } from "../editGate";
import { startUIViewElementDrag, uiDropDescription, uiElementDrag } from "../uiElementDrag";
import "./hierarchy.css";
import { liveInspecting } from "../runtimeInspect";
import { RuntimeHierarchy, WorldPicker } from "./RuntimeHierarchy";
import { TreeView, renameRow, type TreeRow, type TreeSelect } from "./TreeView";

/**
 * One Hierarchy panel's view state (ADR 0174): each copy of the panel has its own, so expanding a row or
 * searching in one doesn't change another. The default: every scene node expanded, prefab instances'
 * inner nodes and UI views' element rows closed (they can hold hundreds of rows), no search.
 */
class HierarchyView {
  /** Collapsed scene nodes, by path key. */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** Prefab instances showing their inner nodes, by path key (instances start collapsed). */
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** UI document element rows the user opened (they start closed: a document can have hundreds). */
  readonly uiExpanded = signal<ReadonlySet<string>>(new Set());
  /** Bone rows the user opened (ADR 0373: they start closed, a rig has dozens). */
  readonly boneExpanded = signal<ReadonlySet<string>>(new Set());
  /** The search box text: words match names, `t:Type` component types (`hierarchyFilter.ts`). */
  readonly query = signal("");
  /** Where a Shift+click range starts: the last row clicked without Shift. */
  anchor: string | null = null;
  /** Which rows match the search and which show (null: no search, every row shows). */
  readonly filter = computed(() => {
    docVersion.value;
    const scene = openScene.value, query = this.query.value;
    return scene && query.trim() ? filterHierarchy(scene.doc, query) : null;
  });
  /** False for rows the search hides. */
  shown(key: string): boolean {
    return this.filter.value?.visible.has(key) ?? true;
  }
}

const HierarchyViewContext = createContext<HierarchyView | null>(null);
/** Outside a Hierarchy (never in practice): a shared view, so components still render. */
const fallbackView = new HierarchyView();
const useView = (): HierarchyView => useContext(HierarchyViewContext) ?? fallbackView;

/** Put `key` in the set or take it out. */
function setMember(set: Signal<ReadonlySet<string>>, key: string, member: boolean): void {
  if (set.value.has(key) === member) return;
  const next = new Set(set.value);
  if (member) next.add(key);
  else next.delete(key);
  set.value = next;
}

/** True if a selected node is strictly inside the node at `key` (so its ancestors open up). */
const selectionInside = (key: string) =>
  selectedKeys.value.some((k) => k.startsWith(`${key}/`) || (k.includes("/") && !!openScene.value && ancestorKeys(openScene.value.doc, k).includes(key))) || uiSelectionUnder(key) || boneSelectionUnder(key);

/** True if the selected bone (ADR 0373) is on the node at `key` or below it. */
function boneSelectionUnder(key: string): boolean {
  const t = inspectorTarget.value, scene = openScene.value;
  if (t.kind !== "bone" || !scene) return false;
  const host = pathKey(t.path);
  return host === key || host.startsWith(`${key}/`) || ancestorKeys(scene.doc, host).includes(key);
}

/** True if the selected UI element (a view's, ADR 0419 wave C) is on the node at `key` or below it. */
function uiSelectionUnder(key: string): boolean {
  const ref = selectedUIViewRef(), scene = openScene.value;
  if (!ref || !scene) return false;
  return ref.host === key || ref.host.startsWith(`${key}/`) || ancestorKeys(scene.doc, ref.host).includes(key);
}

/** The views on the node at `key`, with the elements each rendered (ADR 0419 wave C; none while searching: the search is over scene nodes). */
function uiViewsAt(view: HierarchyView, key: string): UIViewRows[] {
  uiViewVersion.value; // re-read when a view renders again or hot-reloads
  const scene = openScene.value;
  if (!scene || view.filter.value) return [];
  return viewRows(scene.sync, key).filter((v) => v.rows.length > 0);
}

/** A row click: select it alone, Ctrl/Cmd toggles it, Shift selects the visible rows from the anchor (Ctrl+Shift adds them). */

/** A row picked by a click or an arrow key: it alone, Ctrl/Cmd toggles it, Shift selects the visible scene rows from the anchor (Ctrl+Shift adds them). */
function selectRow(view: HierarchyView, key: string, how: TreeSelect): void {
  if (how.range) {
    const order = how.visible.filter((k) => !k.startsWith(uiTreeKey("")) && !k.startsWith(BONE_ROW));
    const range = rangeBetween(order, view.anchor ?? key, key);
    select(how.toggle ? combineSelection(selectedKeys.peek(), range, "add") : range, key);
    return;
  }
  view.anchor = key;
  select(how.toggle ? combineSelection(selectedKeys.peek(), [key], "toggle") : [key], key);
}

/**
 * The open scene's node tree, read from the document (ADR 0026). Prefab instances expand to the
 * nodes inside them, read from their prefab files; those are selectable and edit as overrides.
 * The header has the scene's name, a Create ("+") menu and a search box; rows and empty space
 * have a right-click menu; each row has editor-only hide and lock toggles. Rows are drawn by the tree view
 * (ADR 0278): arrow keys move, F2 renames, Delete deletes.
 */
export function Hierarchy() {
  const view = usePanelValue("hierarchy.view", () => new HierarchyView());
  docVersion.value; // re-render when the document changes
  watchUIViews();
  if (liveInspecting())
    return (
      <Panel>
        <RuntimeHierarchy />
      </Panel>
    ); // a live World of the running game
  const scene = openScene.value;
  if (!scene)
    return (
      <Panel>
        <p class="empty">No scene open</p>
      </Panel>
    );
  const filter = view.filter.value;
  return (
    <Panel>
      <HierarchyViewContext.Provider value={view}>
        <div
          class="hierarchy-view"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest("input")) return;
            e.preventDefault();
            openHierarchyMenu(e.clientX, e.clientY, null, view);
          }}
        >
          <WorldPicker />
          <div class="hierarchy-header">
            <div
              class={`scene-name${dropMode(null) === "root" ? " drop-into" : ""}`}
              title={`${scene.path}: click for the scene's settings`}
              role="button"
              tabIndex={0}
              onClick={showSceneSettings}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  showSceneSettings();
                }
              }}
            >
              {scene.path.split("/").pop()}
              {scene.stack.dirty && " •"}
            </div>
            <button class="hierarchy-add" aria-label="Create node" title="Create a node" onClick={(e) => openCreateMenu(e.currentTarget as HTMLElement, view)}>
              +
            </button>
          </div>
          <HierarchySearch />
          <TreeView tree={HIERARCHY_TREE} label="Scene nodes" rows={sceneRows(view, scene)} owner={view} multiselectable striped />
          {filter && filter.matches.size === 0 && <p class="empty hierarchy-no-match">No nodes match “{view.query.value.trim()}”</p>}
          <HierarchyMenu owner={view} />
          <UIElementDragGhost />
        </div>
      </HierarchyViewContext.Provider>
    </Panel>
  );
}

function HierarchySearch() {
  const { query } = useView();
  return (
    <input
      type="search"
      class="hierarchy-search"
      placeholder="Search (t:Type for components)"
      aria-label="Search nodes"
      value={query.value}
      onInput={(e) => (query.value = (e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (query.value) query.value = "";
        else (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
}


// --- the tree view's adapters (ADR 0278): scene nodes (prefab instances' inner nodes included) and UI elements ---

/** The open scene's top-level rows. */
function sceneRows(view: HierarchyView, scene: OpenScene): TreeRow[] {
  return scene.doc.roots().flatMap((id) => sceneNodeRow(view, scene, id) ?? []);
}

/** A scene node's row (a prefab instance's with its inner nodes), or null when the search hides it. */
function sceneNodeRow(view: HierarchyView, scene: OpenScene, id: string): TreeRow | null {
  if (!view.shown(id)) return null;
  const doc = scene.doc;
  const node = doc.node(id);
  const ui = uiViewsAt(view, id);
  if (node.prefab) {
    const inner = instanceInnerNodes(doc, id);
    const overrides = node.overrides?.length ?? 0;
    return nodeRow(view, scene, {
      key: id,
      name: node.name ?? id,
      inactive: node.active === false,
      expandable: inner.length > 0 || ui.length > 0,
      open: view.expanded.value.has(id) || selectionInside(id) || (!!view.filter.value && inner.some((n) => view.shown(pathKey(n.path)))),
      openSet: view.expanded,
      badge: { text: prefabName(node.prefab), title: `${node.prefab}${overrides ? ` · ${overrides} override${overrides === 1 ? "" : "s"}` : ""}`, modified: overrides > 0 },
      children: () => [...inner.flatMap((n) => innerNodeRow(view, scene, n) ?? []), ...uiElementRows(view, ui)],
    });
  }
  const children = doc.children(id);
  const bones = boneRows(view, scene, id);
  return nodeRow(view, scene, {
    key: id,
    name: node.name ?? id,
    inactive: node.active === false,
    expandable: children.length > 0 || ui.length > 0 || bones.length > 0,
    open: !view.collapsed.value.has(id) || selectionInside(id) || (!!view.filter.value && children.some((c) => view.shown(c))),
    collapseSet: view.collapsed,
    children: () => [...bones, ...children.flatMap((c) => sceneNodeRow(view, scene, c) ?? []), ...uiElementRows(view, ui)],
  });
}

/** A node inside a prefab instance: selectable, and its edits are overrides. */
function innerNodeRow(view: HierarchyView, scene: OpenScene, node: InnerNode): TreeRow | null {
  const key = pathKey(node.path);
  if (!view.shown(key)) return null;
  const ui = uiViewsAt(view, key);
  const bones = boneRows(view, scene, key);
  return nodeRow(view, scene, {
    key,
    name: node.name,
    inner: true,
    inactive: !node.active,
    expandable: node.children.length > 0 || ui.length > 0 || bones.length > 0,
    open: (node.prefab ? view.expanded.value.has(key) : !view.collapsed.value.has(key)) || selectionInside(key) || (!!view.filter.value && node.children.some((c) => view.shown(pathKey(c.path)))),
    ...(node.prefab ? { openSet: view.expanded } : { collapseSet: view.collapsed }),
    badge: node.prefab ? { text: prefabName(node.prefab), title: node.prefab, modified: false } : undefined,
    children: () => [...bones, ...node.children.flatMap((c) => innerNodeRow(view, scene, c) ?? []), ...uiElementRows(view, ui)],
  });
}

/** Where bone rows' tree keys start (ADR 0373): they aren't nodes, so selection ranges and drops skip them. */
const BONE_ROW = "bone:";

/**
 * The bone rows under the node at `key` (ADR 0373): read-only rows the plugins' `registerSkeletonBones` list from the
 * node's skeleton asset, each closed until opened (or until a bone under it is selected). None while searching.
 */
function boneRows(view: HierarchyView, scene: OpenScene, key: string): TreeRow[] {
  if (view.filter.value) return [];
  const path = key.split("/");
  return skeletonBones.list().flatMap((c) => c.bones(scene, path).map((b) => boneRow(view, scene, c, path, `${BONE_ROW}${c.id}:${key}`, b)));
}

function boneRow(view: HierarchyView, scene: OpenScene, provider: SkeletonBonesContribution, path: readonly string[], parentKey: string, bone: SkeletonBoneRow): TreeRow {
  const key = `${parentKey}>${bone.name}`;
  const t = inspectorTarget.value;
  const selectedHere = t.kind === "bone" && t.provider === provider.id && pathKey(t.path) === path.join("/") ? t.bone : null;
  const holdsSelected = (b: SkeletonBoneRow): boolean => b.children.some((c) => c.name === selectedHere || holdsSelected(c));
  const open = view.boneExpanded.value.has(key) || (selectedHere !== null && holdsSelected(bone));
  return {
    key,
    label: bone.name,
    expandable: bone.children.length > 0,
    open,
    children: open ? bone.children.map((c) => boneRow(view, scene, provider, path, key, c)) : undefined,
    selected: selectedHere === bone.name,
    className: "bone-row",
    attrs: { "data-bone": bone.name },
    title: `Bone ${bone.name} of the skeleton: read from the skeleton asset, not saved in the scene. Select it to see its pose and add a BoneAttachment.`,
    icon: (
      <span class="bone-row-icon" aria-hidden="true">
        ⟡
      </span>
    ),
    setOpen: (on) => setMember(view.boneExpanded, key, on),
    select: () => selectBone(scene, [...path], bone.name, provider.id),
  };
}

interface NodeRowSpec {
  readonly key: string;
  readonly name: string;
  readonly inner?: boolean;
  readonly inactive: boolean;
  readonly expandable: boolean;
  readonly open: boolean;
  /** Where its open state lives: rows that start open record being closed, ones that start closed being opened. */
  readonly collapseSet?: Signal<ReadonlySet<string>>;
  readonly openSet?: Signal<ReadonlySet<string>>;
  readonly badge?: { text: string; title: string; modified: boolean };
  readonly children: () => TreeRow[];
}

/** A scene node row's look and edits: select, the menu, rename (an undoable document edit, an override inside an instance), Delete and the node drag. */
function nodeRow(view: HierarchyView, scene: OpenScene, spec: NodeRowSpec): TreeRow {
  const { key, name, badge } = spec;
  const doc = scene.doc;
  const filter = view.filter.value;
  const drop = dropMode(key);
  const classes = [
    spec.inactive && "inactive",
    spec.inner && "inner",
    filter && !filter.matches.has(key) && "filter-context", // shown only as an ancestor of a match
    isHidden(doc, key) && "scene-hidden",
    isLocked(doc, key) && "scene-locked",
  ].filter(Boolean);
  return {
    key,
    label: name,
    expandable: spec.expandable,
    open: spec.open,
    children: spec.expandable && spec.open ? spec.children() : undefined,
    selected: isSelected(key),
    className: classes.join(" "),
    attrs: { "data-key": key },
    title: spec.inner ? "Inside a prefab instance: edits become overrides" : undefined,
    drop: drop === "root" ? null : drop,
    dragging: nodeDrag.value?.keys.includes(key) ?? false,
    trailing: (
      <>
        {badge && (
          <span
            class={`badge${badge.modified ? " modified" : ""}`}
            title={`${badge.title} · double-click to open the prefab`}
            onDblClick={(e) => {
              e.stopPropagation();
              void openPrefabFrom(key.split("/"));
            }}
          >
            {badge.text}
            {badge.modified && " •"}
          </span>
        )}
        <RowFlags doc={doc} rowKey={key} name={name} />
      </>
    ),
    setOpen: (open) => {
      if (spec.collapseSet) setMember(spec.collapseSet, key, !open);
      else if (spec.openSet) setMember(spec.openSet, key, open);
    },
    select: (how) => selectRow(view, key, how),
    menu: (x, y) => {
      if (!selectedKeys.peek().includes(key)) {
        view.anchor = key;
        select([key], key);
      }
      openHierarchyMenu(x, y, key, view);
    },
    rename: whyNotEdit({ kind: "scene", scene })
      ? null
      : {
          value: name,
          label: "Node name",
          commit: (value) => {
            if (value.trim() !== "" && openScene.peek() === scene) renameNode(scene, key.split("/"), value);
          },
        },
    remove: () => void deleteSelected(),
    drag: (e) => startNodeDrag(e, key),
  };
}

/** A node's views' rendered elements (ADR 0419 wave C), under its own children; none while searching. */
function uiElementRows(view: HierarchyView, views: readonly UIViewRows[]): TreeRow[] {
  if (views.length === 0) return [];
  const selectedKey = selectedUIElement.value;
  const opened = selectedKey ? new Set(viewRowAncestry(views, selectedKey) ?? []) : new Set<string>();
  return views.flatMap((v) => v.rows.map((r) => uiViewElementRow(view, r, v.file, opened)));
}

/**
 * An element a UIView rendered from a Svelte component (ADR 0419 wave C): rendered from the file, not saved in the
 * scene, so it's marked as the file's. Clicking selects it; the menu creates inside it,
 * renames (its id), duplicates and deletes; dragging reorders it within its file. `{#each}` rows, snippets and child
 * components' insides select, but are view-only (their rows say why).
 */
function uiViewElementRow(view: HierarchyView, row: UIViewRow, viewFile: string, opened: ReadonlySet<string>): TreeRow {
  const uiExpanded = view.uiExpanded;
  const open = uiExpanded.value.has(row.key) || opened.has(row.key);
  const key = uiTreeKey(row.key);
  const scene = openScene.peek();
  const viewOnly = scene ? whyViewOnly(scene.sync, row.ref) : null;
  const renamable = !!scene && !whyNotEditViewElement(scene, row.ref);
  const drop = uiElementDrag.value?.target?.row === row.key ? uiElementDrag.value.target.mode : null;
  const where = `${row.file}:${row.ref.line}${row.file === viewFile ? "" : ` (inside ${viewFile})`}`;
  return {
    key,
    label: row.label,
    expandable: row.children.length > 0,
    open,
    children: open ? row.children.map((c) => uiViewElementRow(view, c, viewFile, opened)) : undefined,
    selected: selectedUIElement.value === row.key,
    className: `ui-element ui-view-element${viewOnly ? " view-only" : ""}`,
    attrs: { "data-ui-key": row.key },
    title: `<${row.tag}> from ${where}. Rendered from the Svelte component, not saved in the scene; ${viewOnly ? `view-only: ${viewOnly}.` : "edits are written to the file."}`,
    icon: (
      <span class="ui-element-icon" aria-hidden="true">
        ◇
      </span>
    ),
    drop,
    dragging: uiElementDrag.value?.key === row.key,
    setOpen: (on) => setMember(uiExpanded, row.key, on),
    select: () => selectUIElement(row.ref),
    menu: (x, y) => {
      selectUIElement(row.ref);
      openUIViewElementMenu(x, y, row.ref, view);
    },
    activate: () => {
      if (renamable) renameRow(HIERARCHY_TREE, key, view);
    },
    rename: renamable
      ? (() => {
          const initial = (scene && resolveUIViewElement(scene.sync, row.ref)?.id) ?? "";
          return {
            value: initial,
            label: "Element id",
            placeholder: "id",
            commit: (value: string) => {
              if (value.trim() !== initial) renameUIViewElement(row.ref, value);
            },
          };
        })()
      : null,
    remove: () => void deleteSelected(),
    drag: viewOnly ? undefined : (e) => startUIViewElementDrag(e, row.ref, row.key, row.label),
  };
}

/** The label following a dragged UI element, saying what releasing will do (or why it can't). */
function UIElementDragGhost() {
  const drag = uiElementDrag.value;
  if (!drag) return null;
  return (
    <div class={`asset-drag-ghost${drag.target ? "" : " invalid"}`} style={{ left: `${drag.x + 14}px`, top: `${drag.y + 14}px` }} role="status">
      {uiDropDescription(drag)}
    </div>
  );
}

const prefabName = (path: string) => path.split("/").pop()!.replace(/\.(prefab|scene)\.json$/, "");

/** How a dragged asset would land relative to the row `key` (null: the scene itself), if it's the target. */
function dropMode(key: string | null): "into" | "before" | "after" | "root" | null {
  const asset = assetDrag.value?.target;
  const t = asset ? (asset.kind === "hierarchy" ? asset.drop : null) : nodeDrag.value?.target;
  return t && t.row === key ? t.mode : null;
}

/** The eye and lock toggles at the end of a row (editor-only, per user: `nodeVisibility.ts`). */
function RowFlags(props: { doc: SceneDocument; rowKey: string; name: string }) {
  const { doc, rowKey, name } = props;
  const flags = nodeFlags.value;
  const hiddenOwn = flags.hidden.has(rowKey), lockedOwn = flags.locked.has(rowKey);
  const hiddenInherited = !hiddenOwn && isHidden(doc, rowKey), lockedInherited = !lockedOwn && isLocked(doc, rowKey);
  const stop = (e: Event) => e.stopPropagation();
  return (
    <span class="row-flags" onPointerDown={stop} onDblClick={stop}>
      <button
        class={`row-flag eye${hiddenOwn ? " on" : ""}${hiddenInherited ? " inherited" : ""}`}
        aria-label={hiddenOwn ? `Show ${name}` : `Hide ${name}`}
        aria-pressed={hiddenOwn}
        title={hiddenInherited ? "Hidden in the Scene view with its parent" : hiddenOwn ? "Hidden in the Scene view (editor only). Click to show." : "Hide in the Scene view (editor only)"}
        onClick={(e) => {
          e.stopPropagation();
          setHidden(rowKey, !hiddenOwn);
        }}
      >
        {hiddenOwn || hiddenInherited ? "⊘" : "◉"}
      </button>
      <button
        class={`row-flag lock${lockedOwn ? " on" : ""}${lockedInherited ? " inherited" : ""}`}
        aria-label={lockedOwn ? `Unlock ${name}` : `Lock ${name}`}
        aria-pressed={lockedOwn}
        title={lockedInherited ? "Locked with its parent" : lockedOwn ? "Can't be picked in the Scene view. Click to unlock." : "Lock: stop picking it in the Scene view"}
        onClick={(e) => {
          e.stopPropagation();
          setLocked(rowKey, !lockedOwn);
        }}
      >
        {lockedOwn || lockedInherited ? "🔒" : "🔓"}
      </button>
    </span>
  );
}

