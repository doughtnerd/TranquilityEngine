import { errorStatus } from "../messages";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { Color, GameObject } from "../../engine";
import { listComponents, type ComponentInfo, type FieldValue } from "../../engine/editor";
import { RenameNode, RevertOverrides, SetActive, SetField, isFieldOverride, pathKey, type NodePath } from "../document";
import { editorFor, parseNumber, toSceneJSON, type FieldEditor } from "../fieldValues";
import {
  inFileOrder,
  moveComponent,
  removeComponentFrom,
  removeMissingComponent,
  setComponentEnabled,
  whyNotRemovable,
  whyNotRemovableMissing,
  whyNotReorderable,
  whyNotToggleable,
} from "../componentEdits";
import { deleteSelected } from "../deleteSelection";
import { AddComponentMenu } from "./AddComponentMenu";
import { openScript, scriptFor } from "../code/codeState";
import { applyOverrides, createPrefab, findInner, isOverridden } from "../prefabs";
import { currentProject, docVersion, editingCollider, openScene, scriptsVersion, selectedKeys, selection, status, type OpenScene } from "../state";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The selected node's components with their declared fields and live values (ADR 0022, 0026).
 * Every edit is a command on the open document, so it can be undone. On a prefab instance, or a
 * node inside one, edits become overrides: overridden fields are marked and can be reverted, and
 * the instance's overrides can be applied to the prefab file. With several nodes selected it
 * shows the components they all have; fields that differ show a dash, and an edit sets every
 * selected node in one undo step.
 */
export function Inspector() {
  docVersion.value; // re-render when the document changes
  const scene = openScene.value;
  if (!scene) return <p class="empty">Nothing selected</p>;
  // Selected nodes that still exist (an undo may have removed some).
  const paths = selectedKeys.value
    .map((k) => k.split("/") as NodePath)
    .filter((p) => scene.doc.has(p[0]) && (p.length === 1 || findInner(scene.doc, p)));
  if (paths.length === 0) return <p class="empty">Nothing selected</p>;
  if (paths.length > 1) return <MultiInspector scene={scene} paths={paths} />;
  const path = paths[0];
  const inner = path.length > 1 ? findInner(scene.doc, path) : null;

  const id = path[0];
  const entry = scene.doc.node(id);
  const node = scene.sync.nodeFor(path);
  const components = node ? inFileOrder(scene.doc, id, listComponents(node)) : [];
  const key = pathKey(path);
  return (
    <div class="inspector-body">
      <div class="node-header">
        <input
          type="checkbox"
          checked={inner ? (node?.active ?? true) : entry.active !== false}
          disabled={!!inner}
          aria-label="Active"
          onChange={(e) => scene.stack.execute(new SetActive(id, (e.currentTarget as HTMLInputElement).checked))}
        />
        {inner ? (
          <span class="node-name inner-name" title="Nodes inside a prefab are renamed in the prefab">
            {inner.name}
          </span>
        ) : (
          <TextInput
            class="node-name"
            value={entry.name ?? id}
            label="Name"
            onCommit={(name) => name !== (entry.name ?? id) && scene.stack.execute(new RenameNode(id, name))}
          />
        )}
        {!inner && (
          <button class="delete-node" title="Delete this node and its children (Delete)" aria-label="Delete node" onClick={() => void deleteSelected()}>
            Delete
          </button>
        )}
      </div>
      <dl class="node-meta">
        <dt>Id</dt>
        <dd>{key}</dd>
        {entry.prefab && (
          <>
            <dt>{inner ? "Inside" : "Prefab"}</dt>
            <dd>{entry.prefab}</dd>
          </>
        )}
      </dl>
      {entry.prefab && !inner && <PrefabActions scene={scene} id={id} />}
      {!entry.prefab && <CreatePrefabButton scene={scene} id={id} />}
      {components.map((c) => (
        <ComponentCard key={`${key}/${c.type}#${c.index}`} scene={scene} paths={[path]} infos={[c]} siblings={components} />
      ))}
      <MissingComponents scene={scene} path={path} />
      {node && <AddComponentMenu scene={scene} targets={[{ path, node }]} />}
    </div>
  );
}

/** Several nodes: their names, a shared active toggle, Delete, and the components they all have. */
function MultiInspector(props: { scene: OpenScene; paths: NodePath[] }) {
  const { scene, paths } = props;
  const nodes = paths.map((p) => scene.sync.nodeFor(p));
  const lists = nodes.map((n) => (n ? listComponents(n) : []));
  // Components every node has, matched by type and index, in the active (last) node's order.
  const shared = lists[lists.length - 1].filter((c) => lists.every((l) => l.some((o) => o.type === c.type && o.index === c.index)));
  const names = paths.map((p, i) => nodes[i]?.name ?? p[p.length - 1]);
  const anyInner = paths.some((p) => p.length > 1);
  const actives = paths.map((p, i) => (p.length > 1 ? (nodes[i]?.active ?? true) : scene.doc.node(p[0]).active !== false));
  const allActive = actives.every(Boolean);
  const key = paths.map(pathKey).join("|");
  return (
    <div class="inspector-body">
      <div class="node-header">
        <input
          type="checkbox"
          checked={allActive}
          indeterminate={!allActive && actives.some(Boolean)}
          disabled={anyInner}
          aria-label="Active"
          title={anyInner ? "Nodes inside a prefab are activated in the prefab" : undefined}
          onChange={(e) => {
            const on = (e.currentTarget as HTMLInputElement).checked;
            inGroup(scene, `${on ? "Activate" : "Deactivate"} ${paths.length} nodes`, () => {
              for (const p of paths) scene.stack.execute(new SetActive(p[0], on));
            });
          }}
        />
        <span class="node-name multi-name">{paths.length} nodes selected</span>
        {!anyInner && (
          <button class="delete-node" title="Delete these nodes and their children (Delete)" aria-label="Delete nodes" onClick={() => void deleteSelected()}>
            Delete
          </button>
        )}
      </div>
      <p class="multi-names" title={names.join(", ")}>
        {names.join(", ")}
      </p>
      {shared.length === 0 && <p class="empty">No components in common</p>}
      {shared.map((c) => (
        <ComponentCard
          key={`${key}/${c.type}#${c.index}`}
          scene={scene}
          paths={paths}
          infos={lists.map((l) => l.find((o) => o.type === c.type && o.index === c.index)!)}
        />
      ))}
      <AddComponentMenu scene={scene} targets={paths.flatMap((path, i) => (nodes[i] ? [{ path, node: nodes[i]! }] : []))} />
    </div>
  );
}

/**
 * Components whose type isn't registered (their script was deleted, renamed or didn't load, ADR
 * 0030). The scene keeps their data; each card says so and can remove the component.
 */
function MissingComponents(props: { scene: OpenScene; path: NodePath }) {
  docVersion.value; // a script reload rebuilds the scene without changing these props
  const { scene, path } = props;
  const missing = scene.sync.missingComponents(path);
  if (missing.length === 0) return null;
  const seen = new Map<string, number>();
  return (
    <>
      {missing.map((entry) => {
        const k = seen.get(entry.type) ?? 0;
        seen.set(entry.type, k + 1);
        const count = missing.filter((m) => m.type === entry.type).length;
        const reason = whyNotRemovableMissing(scene.doc, path, entry.type, k, count);
        const name = entry.type.replace(/^[^.]*\./, "");
        return (
          <section key={`${entry.type}#${k}`} class="component missing">
            <h3>
              <span class="missing-mark" aria-hidden="true">⚠</span>
              {name}
              <span class="badge">missing script</span>
              <button
                class="remove-component"
                aria-label={`Remove ${name}`}
                title={reason ? `Can't remove: ${reason}` : `Remove ${name} from this node`}
                disabled={reason !== null}
                onClick={() => removeMissingComponent(scene, path, entry.type, k, count)}
              >
                ✕
              </button>
            </h3>
            <p class="missing-note">
              No script registers <code>{entry.type}</code>: it was deleted or renamed, or it didn't load. Its data stays in the scene, and it comes back
              when the script does.
            </p>
          </section>
        );
      })}
    </>
  );
}

/** Run `body` as one undo step. */
function inGroup(scene: OpenScene, label: string, body: () => void): void {
  scene.stack.beginGroup(label);
  try {
    body();
  } finally {
    scene.stack.endGroup();
  }
}

/** Apply or revert all of an instance's overrides. */
function PrefabActions(props: { scene: OpenScene; id: string }) {
  docVersion.value; // its props don't change when overrides do, so read the document version
  const { scene, id } = props;
  const project = currentProject.value;
  const count = scene.doc.node(id).overrides?.length ?? 0;
  const canApply = count > 0 && !!project?.canSave;
  const applyTitle = !project?.canSave
    ? "This project is read-only. Open a project folder to apply overrides."
    : "Write this instance's overrides into the prefab file (updates every instance)";
  return (
    <div class="prefab-actions">
      <span class="override-count">{count === 0 ? "No overrides" : `${count} override${count === 1 ? "" : "s"}`}</span>
      <button
        disabled={!canApply}
        title={applyTitle}
        onClick={async () => {
          try {
            const n = await applyOverrides(scene, project!, id);
            const prefab = scene.doc.node(id).prefab;
            status.value = { kind: "info", text: `Applied ${n} override${n === 1 ? "" : "s"} to ${prefab}. Undo restores them here; the prefab file keeps the change.` };
          } catch (err) {
            status.value = errorStatus(null, err);
          }
        }}
      >
        Apply
      </button>
      <button
        disabled={count === 0}
        title="Remove all overrides: back to the prefab's values"
        onClick={() => scene.stack.execute(new RevertOverrides(id, "Revert all overrides"))}
      >
        Revert All
      </button>
    </div>
  );
}

function CreatePrefabButton(props: { scene: OpenScene; id: string }) {
  docVersion.value;
  const { scene, id } = props;
  const project = currentProject.value;
  const title = project?.canSave
    ? "Save this node and its children as a prefab file, and make this node an instance of it"
    : "This project is read-only. Open a project folder to create prefabs.";
  return (
    <div class="prefab-actions">
      <button
        disabled={!project?.canSave}
        title={title}
        onClick={async () => {
          try {
            const path = await createPrefab(scene, project!, id);
            selection.value = id;
            status.value = { kind: "info", text: `Created ${path}. Undo turns the node back; the file stays on disk.` };
          } catch (err) {
            status.value = errorStatus(null, err);
          }
        }}
      >
        Create Prefab
      </button>
    </div>
  );
}

const COLLIDERS = new Set(["engine.BoxCollider2D", "engine.CircleCollider2D"]);

/** One component, shared by every node in `paths` (`infos` holds each node's copy, in the same order). */
/** Where a dragged component would land: next to the component `type`#`index`, before or after it. */
const componentDrop = signal<{ type: string; index: number; after: boolean } | null>(null);

/**
 * Drag a component by its grip to reorder it among the node's scripts and engine components
 * (data components and Transform stay put). A line shows where it will land.
 */
function startReorder(e: PointerEvent, scene: OpenScene, path: NodePath, info: ComponentInfo, siblings: readonly ComponentInfo[]): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture(e.pointerId);
  const self = grip.closest(".component");
  const move = (m: PointerEvent) => {
    const cards = [...document.querySelectorAll<HTMLElement>(".inspector-body .component[data-reorder]")];
    let best: { card: HTMLElement; after: boolean; distance: number } | null = null;
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      const distance = m.clientY < r.top ? r.top - m.clientY : m.clientY > r.bottom ? m.clientY - r.bottom : 0;
      if (!best || distance < best.distance) best = { card, after: m.clientY > r.top + r.height / 2, distance };
    }
    componentDrop.value = best && best.card !== self ? { type: best.card.dataset.type!, index: Number(best.card.dataset.index), after: best.after } : null;
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    const drop = componentDrop.value;
    componentDrop.value = null;
    const anchor = drop && siblings.find((c) => c.type === drop.type && c.index === drop.index);
    const node = scene.sync.nodeFor(path);
    if (anchor && node) moveComponent(scene, path, node, info, anchor, drop.after);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}

/**
 * One component, shared by every node in `paths` (`infos` holds each node's copy, in the same
 * order). `siblings` (a single node's whole list) makes it reorderable.
 */
function ComponentCard(props: { scene: OpenScene; paths: NodePath[]; infos: ComponentInfo[]; siblings?: readonly ComponentInfo[] }) {
  const { paths, infos } = props;
  const info = infos[infos.length - 1];
  const title = info.type.replace(/^(engine|game|editor)\./, "");
  const key = pathKey(paths[paths.length - 1]);
  const e = editingCollider.value;
  const editing = !!e && e.key === key && e.type === info.type && e.index === info.index;
  // Remove: from every node that allows it; disabled (with the first reason) when none does.
  const { scene } = props;
  const checks = paths.map((path, i) => {
    const node = scene.sync.nodeFor(path);
    if (!node) return { reason: "that node is gone" };
    const count = listComponents(node).filter((c) => c.type === infos[i].type).length;
    return { reason: whyNotRemovable(scene.doc, path, infos[i], count), target: { path, node, info: infos[i] } };
  });
  const removable = checks.flatMap((c) => (c.reason === null && c.target ? [c.target] : []));
  const notRemovable = removable.length === 0 ? checks[0].reason : null;
  // The project script that defines this component, if any (ADR 0030).
  scriptsVersion.value;
  const script = currentProject.value ? scriptFor(currentProject.value.scripts, info.type) : null;
  // Enabled: a checkbox across every node; mixed shows as indeterminate.
  const toggleable = checks.flatMap((c) =>
    c.target && whyNotToggleable(scene.doc, c.target.path, c.target.info, listComponents(c.target.node).filter((o) => o.type === info.type).length) === null ? [c.target] : [],
  );
  const allEnabled = infos.every((i) => i.enabled);
  // Reorder: a single node's components, among those that can move.
  const siblings = props.siblings?.filter((c) => whyNotReorderable(scene.doc, paths[0], c) === null) ?? [];
  const reorderable = paths.length === 1 && siblings.length > 1 && whyNotReorderable(scene.doc, paths[0], info) === null;
  const drop = componentDrop.value;
  const dropHere = drop && drop.type === info.type && drop.index === info.index ? (drop.after ? " drop-after" : " drop-before") : "";
  const step = (by: -1 | 1) => {
    const at = siblings.findIndex((c) => c.type === info.type && c.index === info.index);
    const anchor = siblings[at + by];
    const node = scene.sync.nodeFor(paths[0]);
    if (anchor && node) moveComponent(scene, paths[0], node, info, anchor, by > 0);
  };
  return (
    <section class={`component${dropHere}${allEnabled ? "" : " off"}`} {...(reorderable ? { "data-reorder": "", "data-type": info.type, "data-index": String(info.index) } : {})}>
      <h3>
        {reorderable && (
          <button
            class="reorder-grip"
            aria-label={`Reorder ${title}`}
            title="Drag to reorder (or focus and press Alt+↑ / Alt+↓)"
            onPointerDown={(e) => startReorder(e, scene, paths[0], info, siblings)}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
              e.preventDefault();
              step(e.key === "ArrowUp" ? -1 : 1);
            }}
          >
            ⠿
          </button>
        )}
        <input
          type="checkbox"
          checked={allEnabled}
          indeterminate={!allEnabled && infos.some((i) => i.enabled)}
          disabled={toggleable.length === 0}
          aria-label={`${title} enabled`}
          title={toggleable.length === 0 ? (info.kind === "behavior" ? undefined : `${title} is always on`) : allEnabled ? `Disable ${title}` : `Enable ${title}`}
          onChange={(e) => setComponentEnabled(scene, toggleable, (e.currentTarget as HTMLInputElement).checked)}
        />
        {title}
        {info.kind === "data" && <span class="badge">data</span>}
        {script && (
          <button class="open-script" title={`Open ${script} in the Code panel`} aria-label={`Open ${title} script`} onClick={() => openScript(script)}>
            {"{ }"}
          </button>
        )}
        {COLLIDERS.has(info.type) && paths.length === 1 && (
          <button
            class={`edit-collider${editing ? " active" : ""}`}
            aria-pressed={editing}
            title={editing ? "Stop editing the collider (handles hide, the transform gizmo returns)" : "Show handles in the viewport to resize this collider and move its center"}
            onClick={() => (editingCollider.value = editing ? null : { key, type: info.type as "engine.BoxCollider2D", index: info.index })}
          >
            Edit Collider
          </button>
        )}
        {info.type !== "engine.Transform" && (
          <button
            class="remove-component"
            aria-label={`Remove ${title}`}
            title={notRemovable ? `Can't remove: ${notRemovable}` : paths.length > 1 ? `Remove ${title} from ${removable.length} nodes` : `Remove ${title}`}
            disabled={removable.length === 0}
            onClick={() => {
              if (editing) editingCollider.value = null;
              removeComponentFrom(scene, removable);
            }}
          >
            ✕
          </button>
        )}
      </h3>
      {info.fields.length === 0 ? (
        <p class="empty">No fields</p>
      ) : (
        <div class="fields">
          {info.fields.map((f) => (
            <FieldRow key={f.name} {...props} info={info} values={infos.map((i) => i.fields.find((o) => o.name === f.name)?.value)} field={f} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One field of a component on every node in `paths`; `values` holds each node's value. Values
 * that differ show as mixed, and a commit writes every node (one undo step for several).
 */
function FieldRow(props: { scene: OpenScene; paths: NodePath[]; info: ComponentInfo; field: FieldValue; values: unknown[] }) {
  const { scene, paths, info, field, values } = props;
  const editor = editorFor(field);
  const overridden = paths.some((p) => isOverridden(scene.doc, p, info.type, field.name, info.index));
  const mixed = new Set(values.map((v) => valueKey(v, scene))).size > 1;

  /** Write each node's new value through a SetField command (an override on prefab instances and nodes inside them). */
  const commitEach = (valueFor: (i: number) => unknown) => {
    const write = () =>
      paths.forEach(([id, ...target], i) => {
        const previous = scene.doc.isPrefabInstance(id)
          ? scene.doc.overrideValue(id, target, info.type, field.name, info.index)
          : scene.doc.fieldValue(id, info.type, field.name, info.index);
        const json = toSceneJSON(editor, valueFor(i), { field: field.name, previous, nodeId: (n) => scene.sync.nodeIdOf(n) });
        scene.stack.execute(new SetField(id, info.type, field.name, json, { index: info.index, target }));
      });
    if (paths.length === 1) write();
    else inGroup(scene, `Set ${field.name} on ${paths.length} nodes`, write);
  };
  const commit = (value: unknown) => commitEach(() => value);
  /** Set one axis of a vector on every node, keeping each node's other axes. */
  const commitAxis = (axis: number, n: number) =>
    commitEach((i) => {
      const own = values[i] as { toArray(): number[] } | null | undefined;
      const base = own ? own.toArray() : editor === "vector2" ? [1, 1] : [0, 0, 0];
      return base.map((old, j) => (j === axis ? n : old));
    });
  const revert = () =>
    inGroup(scene, `Revert ${field.name}`, () => {
      for (const [id, ...target] of paths) {
        if (!scene.doc.isPrefabInstance(id)) continue;
        scene.stack.execute(new RevertOverrides(id, `Revert ${field.name}`, (o) => isFieldOverride(o, target, info.type, field.name, info.index)));
      }
    });

  return (
    <>
      <div class={`label-cell${overridden ? " overridden" : ""}`}>
        <ScrubLabel name={field.name} scene={scene} value={isNumeric(editor) && !mixed ? Number(field.value) : null} onScrub={commit} />
        {overridden && (
          <button class="revert" title={`Overridden in this scene. Revert ${field.name} to the prefab's value`} aria-label={`Revert ${field.name}`} onClick={revert}>
            ↺
          </button>
        )}
      </div>
      <div class="value">
        <FieldEditorView editor={editor} field={field} values={values} mixed={mixed} scene={scene} onCommit={commit} onCommitAxis={commitAxis} />
      </div>
    </>
  );
}

const isNumeric = (e: FieldEditor) => e === "number" || e === "integer";

/** A comparable form of a field value, to tell whether several nodes' values differ. */
function valueKey(v: unknown, scene: OpenScene): string {
  if (v instanceof Color) return `color:${v.toHex()}:${v.a}`;
  if (v instanceof GameObject) return `node:${scene.sync.nodeIdOf(v)}`;
  if (v && typeof v === "object" && "toArray" in v) return JSON.stringify((v as { toArray(): number[] }).toArray());
  return JSON.stringify(v ?? null);
}

/** Shown for values that differ between the selected nodes. */
const MIXED = "\u2014";

function FieldEditorView(props: {
  editor: FieldEditor;
  field: FieldValue;
  /** Each selected node's value; `field.value` is the active node's. */
  values: unknown[];
  mixed: boolean;
  scene: OpenScene;
  onCommit: (value: unknown) => void;
  onCommitAxis: (axis: number, value: number) => void;
}) {
  const { editor, field, values, mixed, scene, onCommit } = props;
  const v = field.value;
  switch (editor) {
    case "number":
    case "integer":
      return <NumberInput value={mixed ? null : Number(v)} integer={editor === "integer"} label={field.name} onCommit={onCommit} />;
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={!mixed && Boolean(v)}
          indeterminate={mixed}
          aria-label={field.name}
          onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).checked)}
        />
      );
    case "string":
    case "asset":
      return <TextInput value={mixed ? "" : String(v ?? "")} placeholder={mixed ? MIXED : undefined} label={field.name} onCommit={onCommit} />;
    case "color":
      return <ColorInput value={v instanceof Color ? v : Color.white} mixed={mixed} label={field.name} onCommit={onCommit} />;
    case "vector2":
    case "vector3":
      if (values.some((x) => x !== null && x !== undefined) && values.some((x) => x === null || x === undefined)) {
        // Set on some nodes, unset (automatic) on others.
        return <span class="none">{MIXED} (some Auto)</span>;
      }
      if (v === null || v === undefined) {
        // Unset (e.g. a sprite's size, which then comes from its texture): offer to set one.
        const zero = editor === "vector2" ? [1, 1] : [0, 0, 0];
        return (
          <span class="unset">
            <span class="none">Auto</span>
            <button title={`Set ${field.name} explicitly`} onClick={() => onCommit(zero)}>
              Set
            </button>
          </span>
        );
      }
      return <VectorInput value={axesOf(values)} label={field.name} onCommitAxis={props.onCommitAxis} />;
    case "node":
      return <NodeRefInput value={v instanceof GameObject ? scene.sync.nodeIdOf(v) : null} mixed={mixed} scene={scene} label={field.name} onCommit={onCommit} />;
    case "object":
      return mixed ? <span class="none">{MIXED} (differs)</span> : <ObjectInput value={(v ?? {}) as Record<string, unknown>} onCommit={onCommit} />;
    default:
      return <span>{JSON.stringify(v)}</span>;
  }
}

// --- inputs -------------------------------------------------------------------------------------

/** Each axis shared by every vector in `values`, or null where they differ. */
function axesOf(values: unknown[]): (number | null)[] {
  const arrays = values.map((x) => (x as { toArray(): number[] }).toArray());
  return arrays[0].map((n, i) => (arrays.every((a) => a[i] === n) ? n : null));
}

/** Text that commits on Enter or blur and reverts on Escape. */
function TextInput(props: { value: string; label: string; class?: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => draft !== props.value && props.onCommit(draft);
  return (
    <input
      type="text"
      class={props.class}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(props.value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * A number that commits on Enter or blur. Accepts simple arithmetic (`2*3`); invalid text reverts.
 * A null value (differs between the selected nodes) shows a dash until a number is typed.
 */
function NumberInput(props: { value: number | null; integer?: boolean; label: string; onCommit: (v: number) => void }) {
  const shown = props.value === null ? MIXED : formatNumber(props.value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const n = parseNumber(draft);
    if (n === null) return setDraft(shown);
    const value = props.integer ? Math.round(n) : n;
    if (value !== props.value) props.onCommit(value);
    else setDraft(shown);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      class="num-input"
      aria-label={props.label}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(shown);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** A vector edited per axis; a null axis differs between the selected nodes. */
function VectorInput(props: { value: (number | null)[]; label: string; onCommitAxis: (axis: number, v: number) => void }) {
  const axes = ["x", "y", "z", "w"];
  return (
    <span class="vec">
      {props.value.map((x, i) => (
        <label key={i} class="axis">
          <em>{axes[i]}</em>
          <NumberInput value={x} label={`${props.label} ${axes[i]}`} onCommit={(n) => props.onCommitAxis(i, n)} />
        </label>
      ))}
    </span>
  );
}

function ColorInput(props: { value: Color; mixed?: boolean; label: string; onCommit: (v: Color) => void }) {
  const c = props.value;
  return (
    <span class="color">
      <input
        type="color"
        aria-label={props.label}
        value={c.toHex()}
        onChange={(e) => {
          const next = Color.from((e.currentTarget as HTMLInputElement).value);
          next.a = c.a;
          props.onCommit(next);
        }}
      />
      <span class="hex">{props.mixed ? MIXED : c.toHex()}</span>
      {!props.mixed && c.a < 1 && <span class="alpha">α {formatNumber(c.a)}</span>}
    </span>
  );
}

/** Pick another node of the open scene, or None. */
function NodeRefInput(props: { value: string | null; mixed?: boolean; scene: OpenScene; label: string; onCommit: (id: string | null) => void }) {
  const { doc } = props.scene;
  const MIXED_VALUE = "\u0000mixed";
  return (
    <select
      aria-label={props.label}
      value={props.mixed ? MIXED_VALUE : (props.value ?? "")}
      onChange={(e) => {
        const id = (e.currentTarget as HTMLSelectElement).value;
        if (id !== MIXED_VALUE) props.onCommit(id === "" ? null : id);
      }}
    >
      {props.mixed && (
        <option value={MIXED_VALUE} disabled>
          {MIXED}
        </option>
      )}
      <option value="">None</option>
      {doc.nodes.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name ?? n.id}
        </option>
      ))}
    </select>
  );
}

/** A plain settings object: each key edited in place; the whole object is written back. */
function ObjectInput(props: { value: Record<string, unknown>; onCommit: (v: Record<string, unknown>) => void }) {
  const set = (key: string, next: unknown) => props.onCommit({ ...structuredClone(props.value), [key]: next });
  return (
    <div class="nested">
      {Object.entries(props.value).map(([key, v]) => (
        <div key={key} class="nested-row">
          <span class="nested-key">{humanize(key)}</span>
          {typeof v === "number" ? (
            <NumberInput value={v} label={key} onCommit={(n) => set(key, n)} />
          ) : typeof v === "boolean" ? (
            <input type="checkbox" checked={v} aria-label={key} onChange={(e) => set(key, (e.currentTarget as HTMLInputElement).checked)} />
          ) : typeof v === "string" ? (
            <TextInput value={v} label={key} onCommit={(s) => set(key, s)} />
          ) : v && typeof v === "object" && !Array.isArray(v) ? (
            <ObjectInput value={v as Record<string, unknown>} onCommit={(o) => set(key, o)} />
          ) : (
            <span>{JSON.stringify(v)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A field label. For numbers, dragging it left/right scrubs the value; the whole drag is one undo
 * step. Shift drags 10× faster, Alt 10× slower.
 */
function ScrubLabel(props: { name: string; scene: OpenScene; value: number | null; onScrub: (value: number) => void }) {
  const drag = useRef<{ x: number; start: number; total: number } | null>(null);
  const { value, onScrub, scene } = props;
  return (
    <label
      title={props.name}
      class={value !== null ? "scrub" : undefined}
      onPointerDown={(e) => {
        if (value === null || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: value, total: 0 };
        scene.stack.beginGroup(`Drag ${props.name}`);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (dx === 0) return;
        d.x = e.clientX;
        d.total += dx * 0.05 * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
        onScrub(Math.round((d.start + d.total) * 1000) / 1000);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        scene.stack.endGroup();
      }}
    >
      {humanize(props.name)}
    </label>
  );
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

/** `orderInLayer` → "Order In Layer". */
function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
