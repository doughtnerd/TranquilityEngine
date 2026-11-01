import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { pathKey, type SceneDocument } from "../document";
import { assetDrag } from "../assetDrag";
import { nodeDrag, startNodeDrag } from "../nodeDrag";
import { innerNodes, type InnerNode } from "../prefabs";
import { docVersion, openScene, selection } from "../state";

/** Collapsed scene nodes, by path key. */
const collapsed = signal<ReadonlySet<string>>(new Set());
/** Prefab instances showing their inner nodes, by path key (instances start collapsed). */
const expanded = signal<ReadonlySet<string>>(new Set());

function toggle(set: typeof collapsed, key: string): void {
  const next = new Set(set.value);
  if (!next.delete(key)) next.add(key);
  set.value = next;
}

/** True if the selection is strictly inside the node at `key` (so its ancestors open up). */
const selectionInside = (key: string) => selection.value?.startsWith(`${key}/`) ?? false;

/**
 * The open scene's node tree, read from the document (ADR 0026). Prefab instances expand to the
 * nodes inside them, read from their prefab files; those are selectable and edit as overrides.
 */
export function Hierarchy() {
  docVersion.value; // re-render when the document changes
  const scene = openScene.value;
  if (!scene) return <p class="empty">No scene open</p>;
  return (
    <div>
      <div class={`scene-name${dropMode(null) === "root" ? " drop-into" : ""}`} title={scene.path}>
        {scene.path.split("/").pop()}
        {scene.stack.dirty && " •"}
      </div>
      <ul class="tree" role="tree" aria-label="Scene nodes">
        {scene.doc.roots().map((id) => (
          <TreeNode key={id} doc={scene.doc} id={id} depth={0} />
        ))}
      </ul>
    </div>
  );
}

function TreeNode(props: { doc: SceneDocument; id: string; depth: number }) {
  const { doc, id, depth } = props;
  // Components that read signals skip re-rendering when their props are unchanged, so read the
  // document version here too or renames and reorders wouldn't show.
  docVersion.value;
  const node = doc.node(id);
  if (node.prefab) return <InstanceNode doc={doc} id={id} depth={depth} />;
  const children = doc.children(id);
  const open = !collapsed.value.has(id) || selectionInside(id);
  return (
    <Row
      rowKey={id}
      name={node.name ?? id}
      depth={depth}
      inactive={node.active === false}
      expandable={children.length > 0}
      open={open}
      onToggle={() => toggle(collapsed, id)}
    >
      {children.map((child) => (
        <TreeNode key={child} doc={doc} id={child} depth={depth + 1} />
      ))}
    </Row>
  );
}

function InstanceNode(props: { doc: SceneDocument; id: string; depth: number }) {
  const { doc, id, depth } = props;
  docVersion.value;
  const node = doc.node(id);
  const inner = innerNodes(node.prefab!, [id]);
  const open = expanded.value.has(id) || selectionInside(id);
  const overrides = node.overrides?.length ?? 0;
  return (
    <Row
      rowKey={id}
      name={node.name ?? id}
      depth={depth}
      inactive={node.active === false}
      expandable={inner.length > 0}
      open={open}
      onToggle={() => toggle(expanded, id)}
      badge={{ text: prefabName(node.prefab!), title: `${node.prefab}${overrides ? ` · ${overrides} override${overrides === 1 ? "" : "s"}` : ""}`, modified: overrides > 0 }}
    >
      {inner.map((n) => (
        <InnerTreeNode key={pathKey(n.path)} node={n} depth={depth + 1} />
      ))}
    </Row>
  );
}

function InnerTreeNode(props: { node: InnerNode; depth: number }) {
  const { node, depth } = props;
  docVersion.value;
  const key = pathKey(node.path);
  const set = node.prefab ? expanded : collapsed;
  const open = (node.prefab ? expanded.value.has(key) : !collapsed.value.has(key)) || selectionInside(key);
  return (
    <Row
      rowKey={key}
      name={node.name}
      depth={depth}
      inner
      expandable={node.children.length > 0}
      open={open}
      onToggle={() => toggle(set, key)}
      badge={node.prefab ? { text: prefabName(node.prefab), title: node.prefab, modified: false } : undefined}
    >
      {node.children.map((c) => (
        <InnerTreeNode key={pathKey(c.path)} node={c} depth={depth + 1} />
      ))}
    </Row>
  );
}

const prefabName = (path: string) => path.split("/").pop()!.replace(/\.(prefab|scene)\.json$/, "");

/** How a dragged asset would land relative to the row `key` (null: the scene itself), if it's the target. */
function dropMode(key: string | null): "into" | "before" | "after" | "root" | null {
  const t = assetDrag.value?.target ?? nodeDrag.value?.target;
  if (!t || t.kind !== "hierarchy") return null;
  return t.row === key ? t.mode : null;
}

function Row(props: {
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
  const { rowKey, depth, expandable, open, badge } = props;
  const selected = selection.value === rowKey;
  const drop = dropMode(rowKey);
  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={expandable ? open : undefined}>
      <div
        class={`row${selected ? " selected" : ""}${props.inactive ? " inactive" : ""}${props.inner ? " inner" : ""}${drop ? ` drop-${drop}` : ""}${nodeDrag.value?.key === rowKey ? " dragging" : ""}`}
        data-key={rowKey}
        onPointerDown={(e) => startNodeDrag(e, rowKey)}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        title={props.inner ? "Inside a prefab instance: edits become overrides" : undefined}
        onClick={() => (selection.value = rowKey)}
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
      </div>
      {expandable && open && <ul role="group">{props.children}</ul>}
    </li>
  );
}
