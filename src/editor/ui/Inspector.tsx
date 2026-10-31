import { useEffect, useRef, useState } from "preact/hooks";
import { Color, GameObject } from "../../engine";
import { listComponents, type ComponentInfo, type FieldValue } from "../../engine/editor";
import { RenameNode, SetActive, SetField } from "../document";
import { editorFor, parseNumber, toSceneJSON, type FieldEditor } from "../fieldValues";
import { docVersion, openScene, selection, type OpenScene } from "../state";

/**
 * The selected node's components with their declared fields and live values (ADR 0022, 0026).
 * Every edit is a command on the open document, so it can be undone.
 */
export function Inspector() {
  docVersion.value; // re-render when the document changes
  const scene = openScene.value;
  const id = selection.value;
  if (!scene || !id || !scene.doc.has(id)) return <p class="empty">Nothing selected</p>;

  const entry = scene.doc.node(id);
  const node = scene.sync.nodeFor(id);
  const components = node ? listComponents(node) : [];
  return (
    <div class="inspector-body">
      <div class="node-header">
        <input
          type="checkbox"
          checked={entry.active !== false}
          aria-label="Active"
          onChange={(e) => scene.stack.execute(new SetActive(id, (e.currentTarget as HTMLInputElement).checked))}
        />
        <TextInput
          class="node-name"
          value={entry.name ?? id}
          label="Name"
          onCommit={(name) => name !== (entry.name ?? id) && scene.stack.execute(new RenameNode(id, name))}
        />
      </div>
      <dl class="node-meta">
        <dt>Id</dt>
        <dd>{id}</dd>
        {entry.prefab && (
          <>
            <dt>Prefab</dt>
            <dd>{entry.prefab}</dd>
          </>
        )}
      </dl>
      {components.map((c) => (
        <ComponentCard key={`${id}/${c.type}#${c.index}`} scene={scene} nodeId={id} info={c} />
      ))}
    </div>
  );
}

function ComponentCard(props: { scene: OpenScene; nodeId: string; info: ComponentInfo }) {
  const { info } = props;
  const title = info.type.replace(/^(engine|game|editor)\./, "");
  return (
    <section class="component">
      <h3>
        <input type="checkbox" checked={info.enabled} disabled aria-label={`${title} enabled`} />
        {title}
        {info.kind === "data" && <span class="badge">data</span>}
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

function FieldRow(props: { scene: OpenScene; nodeId: string; info: ComponentInfo; field: FieldValue }) {
  const { scene, nodeId, info, field } = props;
  const editor = editorFor(field);

  /** Write a new value through a SetField command (an override on prefab instances). */
  const commit = (value: unknown) => {
    const json = toSceneJSON(editor, value, {
      field: field.name,
      previous: scene.doc.fieldValue(nodeId, info.type, field.name, info.index),
      nodeId: (n) => scene.sync.nodeIdOf(n),
    });
    scene.stack.execute(new SetField(nodeId, info.type, field.name, json, { index: info.index }));
  };

  return (
    <>
      <ScrubLabel name={field.name} scene={scene} value={isNumeric(editor) ? Number(field.value) : null} onScrub={commit} />
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
