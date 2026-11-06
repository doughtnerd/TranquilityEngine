import type { ComponentChildren } from "preact";
import { computed, signal } from "@preact/signals";
import { pathKey, type SceneDocument } from "../document";
import { assetDrag } from "../assetDrag";
import { filterHierarchy } from "../hierarchyFilter";
import { nodeDrag, startNodeDrag } from "../nodeDrag";
import { isHidden, isLocked, nodeFlags, setHidden, setLocked } from "../nodeVisibility";
import { innerNodes, type InnerNode } from "../prefabs";
import { ancestorKeys, combineSelection, rangeBetween } from "../selectionModel";
import { docVersion, isSelected, openScene, select, selectedKeys, selectedUIElement } from "../state";
import { documentRows, rowAncestry, selectUIElement, selectedUIRef, uiBuildVersion, watchUIDocumentBuilds, type UIDocumentRows, type UIElementRow } from "../uiDocuments";
import { HierarchyMenu, openCreateMenu, openHierarchyMenu } from "./HierarchyMenu";
import "./hierarchy.css";
import { liveInspecting } from "../runtimeInspect";
import { RuntimeHierarchy, WorldPicker } from "./RuntimeHierarchy";

/** Collapsed scene nodes, by path key. */
const collapsed = signal<ReadonlySet<string>>(new Set());
/** Prefab instances showing their inner nodes, by path key (instances start collapsed). */
const expanded = signal<ReadonlySet<string>>(new Set());

/** The Hierarchy's search box text: words match names, `t:Type` component types (`hierarchyFilter.ts`). */
export const hierarchyQuery = signal("");

/** Which rows match the search and which show (null: no search, every row shows). */
const activeFilter = computed(() => {
  docVersion.value;
  const scene = openScene.value, query = hierarchyQuery.value;
  return scene && query.trim() ? filterHierarchy(scene.doc, query) : null;
});

/** False for rows the search hides. */
const shown = (key: string) => activeFilter.value?.visible.has(key) ?? true;

function toggle(set: typeof collapsed, key: string): void {
  const next = new Set(set.value);
  if (!next.delete(key)) next.add(key);
  set.value = next;
}

/** True if a selected node is strictly inside the node at `key` (so its ancestors open up). */
const selectionInside = (key: string) => selectedKeys.value.some((k) => k.startsWith(`${key}/`)) || uiSelectionUnder(key);

/** True if the selected UI element (ADR 0077) is in a document on the node at `key` or below it. */
function uiSelectionUnder(key: string): boolean {
  const ref = selectedUIRef(), scene = openScene.value;
  if (!ref || !scene) return false;
  return ref.host === key || ref.host.startsWith(`${key}/`) || ancestorKeys(scene.doc, ref.host).includes(key);
}

/** UI document element rows the user opened (they start closed: a document can have hundreds). */
const uiExpanded = signal<ReadonlySet<string>>(new Set());

/** The UI documents on the node at `key`, with their element trees (none while searching: the search is over scene nodes). */
function uiDocumentsAt(key: string): UIDocumentRows[] {
  uiBuildVersion.value; // re-read when a document builds or hot-reloads
  const scene = openScene.value;
  if (!scene || activeFilter.value) return [];
  return documentRows(scene.sync, key).filter((d) => d.root);
}

/** Where a Shift+click range starts: the last row clicked without Shift. */
let anchor: string | null = null;

/** A row click: select it alone, Ctrl/Cmd toggles it, Shift selects the visible rows from the anchor (Ctrl+Shift adds them). */
function clickRow(e: MouseEvent, key: string): void {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.shiftKey) {
    const tree = (e.currentTarget as HTMLElement).closest(".tree");
    const order = [...(tree?.querySelectorAll<HTMLElement>(".row[data-key]") ?? [])].map((el) => el.dataset.key!);
    const range = rangeBetween(order, anchor ?? key, key);
    select(ctrl ? combineSelection(selectedKeys.peek(), range, "add") : range, key);
    return;
  }
  anchor = key;
  select(ctrl ? combineSelection(selectedKeys.peek(), [key], "toggle") : [key], key);
}

/** Right-click on a row: select it (unless it's part of the selection already) and open its menu. */
function rowMenu(e: MouseEvent, key: string): void {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedKeys.peek().includes(key)) {
    anchor = key;
    select([key], key);
  }
  openHierarchyMenu(e.clientX, e.clientY, key);
}

/**
 * The open scene's node tree, read from the document (ADR 0026). Prefab instances expand to the
 * nodes inside them, read from their prefab files; those are selectable and edit as overrides.
 * The header has the scene's name, a Create ("+") menu and a search box; rows and empty space
 * have a right-click menu; each row has editor-only hide and lock toggles.
 */
export function Hierarchy() {
  docVersion.value; // re-render when the document changes
  watchUIDocumentBuilds();
  if (liveInspecting()) return <RuntimeHierarchy />; // a live World of the running game
  const scene = openScene.value;
  if (!scene) return <p class="empty">No scene open</p>;
  const filter = activeFilter.value;
  return (
    <div
      class="hierarchy-view"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input")) return;
        e.preventDefault();
        openHierarchyMenu(e.clientX, e.clientY, null);
      }}
    >
      <WorldPicker />
      <div class="hierarchy-header">
        <div class={`scene-name${dropMode(null) === "root" ? " drop-into" : ""}`} title={scene.path}>
          {scene.path.split("/").pop()}
          {scene.stack.dirty && " •"}
        </div>
        <button class="hierarchy-add" aria-label="Create node" title="Create a node" onClick={(e) => openCreateMenu(e.currentTarget as HTMLElement)}>
          +
        </button>
      </div>
      <HierarchySearch />
      <ul class="tree" role="tree" aria-label="Scene nodes">
        {scene.doc.roots().map((id) => (
          <TreeNode key={id} doc={scene.doc} id={id} depth={0} />
        ))}
      </ul>
      {filter && filter.matches.size === 0 && <p class="empty hierarchy-no-match">No nodes match “{hierarchyQuery.value.trim()}”</p>}
      <HierarchyMenu />
    </div>
  );
}

function HierarchySearch() {
  return (
    <input
      type="search"
      class="hierarchy-search"
      placeholder="Search (t:Type for components)"
      aria-label="Search nodes"
      value={hierarchyQuery.value}
      onInput={(e) => (hierarchyQuery.value = (e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (hierarchyQuery.value) hierarchyQuery.value = "";
        else (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
}

function TreeNode(props: { doc: SceneDocument; id: string; depth: number }) {
  const { doc, id, depth } = props;
  // Components that read signals skip re-rendering when their props are unchanged, so read the
  // document version here too or renames and reorders wouldn't show.
  docVersion.value;
  if (!shown(id)) return null;
  const node = doc.node(id);
  if (node.prefab) return <InstanceNode doc={doc} id={id} depth={depth} />;
  const children = doc.children(id);
  const ui = uiDocumentsAt(id);
  const open = !collapsed.value.has(id) || selectionInside(id) || (!!activeFilter.value && children.some(shown));
  return (
    <Row
      doc={doc}
      rowKey={id}
      name={node.name ?? id}
      depth={depth}
      inactive={node.active === false}
      expandable={children.length > 0 || ui.length > 0}
      open={open}
      onToggle={() => toggle(collapsed, id)}
    >
      {children.map((child) => (
        <TreeNode key={child} doc={doc} id={child} depth={depth + 1} />
      ))}
      <UIDocumentElements documents={ui} depth={depth + 1} />
    </Row>
  );
}

function InstanceNode(props: { doc: SceneDocument; id: string; depth: number }) {
  const { doc, id, depth } = props;
  docVersion.value;
  const node = doc.node(id);
  const inner = innerNodes(node.prefab!, [id]);
  const ui = uiDocumentsAt(id);
  const open = expanded.value.has(id) || selectionInside(id) || (!!activeFilter.value && inner.some((n) => shown(pathKey(n.path))));
  const overrides = node.overrides?.length ?? 0;
  return (
    <Row
      doc={doc}
      rowKey={id}
      name={node.name ?? id}
      depth={depth}
      inactive={node.active === false}
      expandable={inner.length > 0 || ui.length > 0}
      open={open}
      onToggle={() => toggle(expanded, id)}
      badge={{ text: prefabName(node.prefab!), title: `${node.prefab}${overrides ? ` · ${overrides} override${overrides === 1 ? "" : "s"}` : ""}`, modified: overrides > 0 }}
    >
      {inner.map((n) => (
        <InnerTreeNode key={pathKey(n.path)} doc={doc} node={n} depth={depth + 1} />
      ))}
      <UIDocumentElements documents={ui} depth={depth + 1} />
    </Row>
  );
}

function InnerTreeNode(props: { doc: SceneDocument; node: InnerNode; depth: number }) {
  const { doc, node, depth } = props;
  docVersion.value;
  const key = pathKey(node.path);
  if (!shown(key)) return null;
  const set = node.prefab ? expanded : collapsed;
  const ui = uiDocumentsAt(key);
  const open =
    (node.prefab ? expanded.value.has(key) : !collapsed.value.has(key)) || selectionInside(key) || (!!activeFilter.value && node.children.some((c) => shown(pathKey(c.path))));
  return (
    <Row
      doc={doc}
      rowKey={key}
      name={node.name}
      depth={depth}
      inner
      expandable={node.children.length > 0 || ui.length > 0}
      open={open}
      onToggle={() => toggle(set, key)}
      badge={node.prefab ? { text: prefabName(node.prefab), title: node.prefab, modified: false } : undefined}
    >
      {node.children.map((c) => (
        <InnerTreeNode key={pathKey(c.path)} doc={doc} node={c} depth={depth + 1} />
      ))}
      <UIDocumentElements documents={ui} depth={depth + 1} />
    </Row>
  );
}

/**
 * A node's UI documents' elements (ADR 0077), under its own children: built from the markup file,
 * not saved in the scene, so they're marked as the file's and are read-only for now (no rename,
 * delete, drag or menu). Clicking one selects the element.
 */
function UIDocumentElements(props: { documents: readonly UIDocumentRows[]; depth: number }) {
  selectedUIElement.value;
  uiExpanded.value;
  if (props.documents.length === 0) return null;
  const selectedKey = selectedUIElement.value;
  const opened = selectedKey ? new Set(rowAncestry(props.documents, selectedKey) ?? []) : new Set<string>();
  return (
    <>
      {props.documents.map((d) => d.root && <UIElementTreeRow key={d.root.key} row={d.root} depth={props.depth} file={d.file ?? d.root.file} opened={opened} />)}
    </>
  );
}

function UIElementTreeRow(props: { row: UIElementRow; depth: number; file: string; opened: ReadonlySet<string> }) {
  const { row, depth, opened } = props;
  const selected = selectedUIElement.value === row.key;
  const expandable = row.children.length > 0;
  const open = uiExpanded.value.has(row.key) || opened.has(row.key);
  const where = row.file === props.file ? row.file : `${row.file} (used by ${props.file})`;
  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={expandable ? open : undefined}>
      <div
        class={`row ui-element${selected ? " selected" : ""}`}
        data-ui-key={row.key}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        title={`${row.synthetic ? "A button's text content" : `<${row.tag}>`} from ${where}. Built from the file, not saved in the scene; read-only here for now.`}
        onClick={(e) => {
          e.stopPropagation();
          selectUIElement(row.ref);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          selectUIElement(row.ref);
        }}
      >
        <span
          class={`caret${expandable ? "" : " leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (expandable) toggle(uiExpanded, row.key);
          }}
        >
          {expandable ? (open ? "▾" : "▸") : ""}
        </span>
        <span class="ui-element-icon" aria-hidden="true">
          ◇
        </span>
        <span class="name">{row.label}</span>
      </div>
      {expandable && open && (
        <ul role="group">
          {row.children.map((c) => (
            <UIElementTreeRow key={c.key} row={c} depth={depth + 1} file={props.file} opened={opened} />
          ))}
        </ul>
      )}
    </li>
  );
}

const prefabName = (path: string) => path.split("/").pop()!.replace(/\.(prefab|scene)\.json$/, "");

/** How a dragged asset would land relative to the row `key` (null: the scene itself), if it's the target. */
function dropMode(key: string | null): "into" | "before" | "after" | "root" | null {
  const t = assetDrag.value?.target ?? nodeDrag.value?.target;
  if (!t || t.kind !== "hierarchy") return null;
  return t.row === key ? t.mode : null;
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

function Row(props: {
  doc: SceneDocument;
  rowKey: string;
  name: string;
  depth: number;
  inactive?: boolean;
  inner?: boolean;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  badge?: { text: string; title: string; modified: boolean };
  children?: ComponentChildren;
}) {
  const { doc, rowKey, depth, expandable, open, badge } = props;
  const selected = isSelected(rowKey);
  const drop = dropMode(rowKey);
  const filter = activeFilter.value;
  const context = !!filter && !filter.matches.has(rowKey); // shown only as an ancestor of a match
  const hidden = isHidden(doc, rowKey), locked = isLocked(doc, rowKey);
  const classes = [
    "row",
    selected && "selected",
    props.inactive && "inactive",
    props.inner && "inner",
    drop && `drop-${drop}`,
    nodeDrag.value?.keys.includes(rowKey) && "dragging",
    context && "filter-context",
    hidden && "scene-hidden",
    locked && "scene-locked",
  ].filter(Boolean);
  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={expandable ? open : undefined}>
      <div
        class={classes.join(" ")}
        data-key={rowKey}
        onPointerDown={(e) => startNodeDrag(e, rowKey)}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        title={props.inner ? "Inside a prefab instance: edits become overrides" : undefined}
        onClick={(e) => clickRow(e, rowKey)}
        onContextMenu={(e) => rowMenu(e, rowKey)}
      >
        <span
          class={`caret${expandable ? "" : " leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (expandable) props.onToggle();
          }}
        >
          {expandable ? (open ? "▾" : "▸") : ""}
        </span>
        <span class="name">{props.name}</span>
        {badge && (
          <span class={`badge${badge.modified ? " modified" : ""}`} title={badge.title}>
            {badge.text}
            {badge.modified && " •"}
          </span>
        )}
        <RowFlags doc={doc} rowKey={rowKey} name={props.name} />
      </div>
      {expandable && open && <ul role="group">{props.children}</ul>}
    </li>
  );
}
