import { signal } from "@preact/signals";
import type { SceneDocument } from "../document";
import { docVersion, openScene, selection } from "../state";

/** Collapsed document node ids. */
const collapsed = signal<ReadonlySet<string>>(new Set());

function toggle(id: string): void {
  const next = new Set(collapsed.value);
  if (!next.delete(id)) next.add(id);
  collapsed.value = next;
}

/** The open scene's node tree, read from the document (ADR 0026). Click a node to select it. */
export function Hierarchy() {
  docVersion.value; // re-render when the document changes
  const scene = openScene.value;
  if (!scene) return <p class="empty">No scene open</p>;
  return (
    <div>
      <div class="scene-name" title={scene.path}>
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
  const children = doc.children(id);
  const isCollapsed = collapsed.value.has(id);
  const selected = selection.value === id;
  const prefab = node.prefab ? node.prefab.split("/").pop()?.replace(/\.prefab\.json$/, "") : null;
  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={children.length ? !isCollapsed : undefined}>
      <div
        class={`row${selected ? " selected" : ""}${node.active === false ? " inactive" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => (selection.value = id)}
      >
        <span
          class={`caret${children.length ? "" : " leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (children.length) toggle(id);
          }}
        >
          {children.length ? (isCollapsed ? "▸" : "▾") : ""}
        </span>
        <span class="name">{node.name ?? id}</span>
        {prefab && <span class="badge" title={node.prefab}>{prefab}</span>}
      </div>
      {children.length > 0 && !isCollapsed && (
        <ul role="group">
          {children.map((child) => (
            <TreeNode key={child} doc={doc} id={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
