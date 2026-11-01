import { useEffect, useRef, useState } from "preact/hooks";
import { Color, GameObject } from "../../engine";
import { listComponents, type ComponentInfo, type FieldValue } from "../../engine/editor";
import { RenameNode, RevertOverrides, SetActive, SetField, isFieldOverride, pathKey, type NodePath } from "../document";
import { editorFor, parseNumber, toSceneJSON, type FieldEditor } from "../fieldValues";
import { deleteSelected } from "../deleteSelection";
import { applyOverrides, createPrefab, findInner, isOverridden } from "../prefabs";
import { currentProject, docVersion, editingCollider, openScene, selectedPath, selection, status, type OpenScene } from "../state";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The selected node's components with their declared fields and live values (ADR 0022, 0026).
 * Every edit is a command on the open document, so it can be undone. On a prefab instance, or a
 * node inside one, edits become overrides: overridden fields are marked and can be reverted, and
 * the instance's overrides can be applied to the prefab file.
 */
export function Inspector() {
  docVersion.value; // re-render when the document changes
  const scene = openScene.value;
  const path = selectedPath();
  if (!scene || !path || !scene.doc.has(path[0])) return <p class="empty">Nothing selected</p>;
  const inner = path.length > 1 ? findInner(scene.doc, path) : null;
  if (path.length > 1 && !inner) return <p class="empty">Nothing selected</p>;

  const id = path[0];
  const entry = scene.doc.node(id);
  const node = scene.sync.nodeFor(path);
  const components = node ? listComponents(node) : [];
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
        <ComponentCard key={`${key}/${c.type}#${c.index}`} scene={scene} path={path} info={c} />
      ))}
    </div>
  );
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
            status.value = { kind: "error", text: message(err) };
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
            status.value = { kind: "error", text: message(err) };
          }
        }}
      >
        Create Prefab
      </button>
    </div>
  );
}

const COLLIDERS = new Set(["engine.BoxCollider2D", "engine.CircleCollider2D"]);

function ComponentCard(props: { scene: OpenScene; path: NodePath; info: ComponentInfo }) {
  const { info, path } = props;
  const title = info.type.replace(/^(engine|game|editor)\./, "");
  const key = pathKey(path);
  const e = editingCollider.value;
  const editing = !!e && e.key === key && e.type === info.type && e.index === info.index;
  return (
    <section class="component">
      <h3>
        <input type="checkbox" checked={info.enabled} disabled aria-label={`${title} enabled`} />
        {title}
        {info.kind === "data" && <span class="badge">data</span>}
        {COLLIDERS.has(info.type) && (
          <button
            class={`edit-collider${editing ? " active" : ""}`}
            aria-pressed={editing}
            title={editing ? "Stop editing the collider (handles hide, the transform gizmo returns)" : "Show handles in the viewport to resize this collider and move its center"}
            onClick={() => (editingCollider.value = editing ? null : { key, type: info.type as "engine.BoxCollider2D", index: info.index })}
          >
            Edit Collider
          </button>
        )}
      </h3>
      {info.fields.length === 0 ? (
        <p class="empty">No fields</p>
      ) : (
        <div class="fields">
          {info.fields.map((f) => (
            <FieldRow key={f.name} {...props} field={f} />
          ))}
        </div>
      )}
    </section>
  );
}

function FieldRow(props: { scene: OpenScene; path: NodePath; info: ComponentInfo; field: FieldValue }) {
  const { scene, path, info, field } = props;
  const editor = editorFor(field);
  const [id, ...target] = path;
  const instance = scene.doc.isPrefabInstance(id);
  const overridden = isOverridden(scene.doc, path, info.type, field.name, info.index);

  /** Write a new value through a SetField command (an override on prefab instances and nodes inside them). */
  const commit = (value: unknown) => {
    const previous = instance
      ? scene.doc.overrideValue(id, target, info.type, field.name, info.index)
      : scene.doc.fieldValue(id, info.type, field.name, info.index);
    const json = toSceneJSON(editor, value, { field: field.name, previous, nodeId: (n) => scene.sync.nodeIdOf(n) });
    scene.stack.execute(new SetField(id, info.type, field.name, json, { index: info.index, target }));
  };
  const revert = () =>
    scene.stack.execute(new RevertOverrides(id, `Revert ${field.name}`, (o) => isFieldOverride(o, target, info.type, field.name, info.index)));

  return (
    <>
      <div class={`label-cell${overridden ? " overridden" : ""}`}>
        <ScrubLabel name={field.name} scene={scene} value={isNumeric(editor) ? Number(field.value) : null} onScrub={commit} />
        {overridden && (
          <button class="revert" title={`Overridden in this scene. Revert ${field.name} to the prefab's value`} aria-label={`Revert ${field.name}`} onClick={revert}>
            ↺
          </button>
        )}
      </div>
      <div class="value">
        <FieldEditorView editor={editor} field={field} scene={scene} onCommit={commit} />
      </div>
    </>
  );
}

const isNumeric = (e: FieldEditor) => e === "number" || e === "integer";

function FieldEditorView(props: { editor: FieldEditor; field: FieldValue; scene: OpenScene; onCommit: (value: unknown) => void }) {
  const { editor, field, scene, onCommit } = props;
  const v = field.value;
  switch (editor) {
    case "number":
    case "integer":
      return <NumberInput value={Number(v)} integer={editor === "integer"} label={field.name} onCommit={onCommit} />;
    case "boolean":
      return <input type="checkbox" checked={Boolean(v)} aria-label={field.name} onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).checked)} />;
    case "string":
    case "asset":
      return <TextInput value={String(v ?? "")} label={field.name} onCommit={onCommit} />;
    case "color":
      return <ColorInput value={v instanceof Color ? v : Color.white} label={field.name} onCommit={onCommit} />;
    case "vector2":
    case "vector3":
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
      return <VectorInput value={(v as { toArray(): number[] }).toArray()} label={field.name} onCommit={onCommit} />;
    case "node":
      return <NodeRefInput value={v instanceof GameObject ? scene.sync.nodeIdOf(v) : null} scene={scene} label={field.name} onCommit={onCommit} />;
    case "object":
      return <ObjectInput value={(v ?? {}) as Record<string, unknown>} onCommit={onCommit} />;
    default:
      return <span>{JSON.stringify(v)}</span>;
  }
}

// --- inputs -------------------------------------------------------------------------------------

/** Text that commits on Enter or blur and reverts on Escape. */
function TextInput(props: { value: string; label: string; class?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => draft !== props.value && props.onCommit(draft);
  return (
    <input
      type="text"
      class={props.class}
      aria-label={props.label}
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

/** A number that commits on Enter or blur. Accepts simple arithmetic (`2*3`); invalid text reverts. */
function NumberInput(props: { value: number; integer?: boolean; label: string; onCommit: (v: number) => void }) {
  const shown = formatNumber(props.value);
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

function VectorInput(props: { value: number[]; label: string; onCommit: (v: number[]) => void }) {
  const axes = ["x", "y", "z", "w"];
  return (
    <span class="vec">
      {props.value.map((x, i) => (
        <label key={i} class="axis">
          <em>{axes[i]}</em>
          <NumberInput
            value={x}
            label={`${props.label} ${axes[i]}`}
            onCommit={(n) => props.onCommit(props.value.map((old, j) => (j === i ? n : old)))}
          />
        </label>
      ))}
    </span>
  );
}

function ColorInput(props: { value: Color; label: string; onCommit: (v: Color) => void }) {
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
      <span class="hex">{c.toHex()}</span>
      {c.a < 1 && <span class="alpha">α {formatNumber(c.a)}</span>}
    </span>
  );
}

/** Pick another node of the open scene, or None. */
function NodeRefInput(props: { value: string | null; scene: OpenScene; label: string; onCommit: (id: string | null) => void }) {
  const { doc } = props.scene;
  return (
    <select
      aria-label={props.label}
      value={props.value ?? ""}
      onChange={(e) => {
        const id = (e.currentTarget as HTMLSelectElement).value;
        props.onCommit(id === "" ? null : id);
      }}
    >
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
