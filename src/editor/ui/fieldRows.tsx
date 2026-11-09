// Field rows and value widgets for both Inspectors (ADR 0158): the edited document's and a live
// World's. A row renders one component field of a `FieldTarget` (`../fieldTarget.ts`), which decides
// where a commit goes. One switch over ADR 0042's field kinds picks the widget.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Color, GameObject, Quaternion } from "../../engine";
import { ASSET_FIELD_KINDS, AssetRef, getComponentClass, getFields, isListType, listComponentIds, type AssetFieldKind, type FieldChoice } from "../../engine/core/registry";
import type { ComponentInfo, FieldValue } from "../../engine/editor";
import { listedFiles } from "../assetBrowser";
import { assetKindsOf, assetListId, assetsForKinds } from "../assetFieldKinds";
import { eulerAnglesOf, withAxis } from "../fieldEdits";
import { fieldChoicesFor, listedChoices, loadFieldChoices } from "../fieldChoices";
import type { NodeRefs, FieldTarget } from "../fieldTarget";
import { choicesFor, defaultItem, editorFor, itemEditorFor, itemField, parseNumber, type FieldEditor } from "../fieldValues";
import type { FieldChoicesContribution } from "../sdk/contributions";
import { currentProject, docVersion, scriptsVersion, status } from "../state";
import "./inspector-fields.css";

/** Shown for values that differ between the selected nodes. */
export const MIXED = "—";

/** `orderInLayer` → "Order In Layer". */
export function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

const formatNumber = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

const isNumeric = (e: FieldEditor) => e === "number" || e === "integer";

/** A component's fields as rows. `readOnly` fields show their value as JSON (fields another editor owns, shown live). */
export function FieldRows(props: { target: FieldTarget; fields: readonly FieldValue[]; readOnly?: (field: FieldValue) => boolean }) {
  const { target, fields, readOnly } = props;
  if (fields.length === 0) return <p class="empty">No fields</p>;
  return (
    <div class="fields">
      {fields.map((f) => (
        <FieldRow key={f.name} target={target} field={f} readOnly={readOnly?.(f)} />
      ))}
    </div>
  );
}

/**
 * One field: its label (dragging a number's label scrubs it), a revert button when it's a prefab
 * override, and its widget. Values that differ between the target's nodes show as mixed; a commit
 * writes every node. A plugin's choices (ADR 0152) turn the field into a dropdown.
 */
export function FieldRow(props: { target: FieldTarget; field: FieldValue; readOnly?: boolean }) {
  const { target, field } = props;
  const editor = props.readOnly ? "unknown" : editorFor(field);
  const { values, mixed, overridden } = target.state(field);
  const contributed = props.readOnly ? undefined : fieldChoicesFor(target.info.type, field.name);
  const loaded = useContributedChoices(contributed, target.info);
  const choices = contributed ? listedChoices(contributed, loaded, field.value, mixed) : undefined;

  const report = (reason: string | null) => {
    if (reason) status.value = { kind: "error", text: `Can't set ${field.name}: ${reason}.` };
  };
  const commit = (value: unknown) => report(target.set(field, value));
  const commitAxis = (axis: number, n: number) => report(target.setAxis(field, axis, n));

  if (choices === null) return null; // nothing to choose and nothing set
  return (
    <>
      <div class={`label-cell${overridden ? " overridden" : ""}`}>
        <ScrubLabel name={field.name} value={isNumeric(editor) && !mixed ? Number(field.value) : null} drag={target.drag} onScrub={commit} />
        {overridden && (
          <button class="revert" title={`Overridden in this scene. Revert ${field.name} to the prefab's value`} aria-label={`Revert ${field.name}`} onClick={() => target.revert(field)}>
            ↺
          </button>
        )}
      </div>
      <div class="value">
        {choices !== undefined ? (
          <ChoiceInput choices={choices} value={field.value} mixed={mixed} label={field.name} onCommit={commit} />
        ) : (
          <FieldEditorView editor={editor} field={field} values={values} mixed={mixed} nodes={target.nodes} onCommit={commit} onCommitAxis={commitAxis} />
        )}
      </div>
    </>
  );
}

/** A contributed field's loaded choices (ADR 0152), asked for again when what they depend on changes; empty until they load. */
function useContributedChoices(contribution: FieldChoicesContribution | undefined, info: ComponentInfo): readonly FieldChoice[] {
  const [loaded, setLoaded] = useState<readonly FieldChoice[]>([]);
  const key = contribution ? `${contribution.id}\u0000${contribution.key(info)}` : null;
  useEffect(() => {
    setLoaded([]);
    if (!contribution) return;
    let live = true;
    void loadFieldChoices(contribution, info).then((choices) => live && setLoaded(choices));
    return () => {
      live = false;
    };
  }, [key]); // `key` names everything the choices depend on
  return loaded;
}

/** The widget for one field kind (ADR 0042). */
function FieldEditorView(props: {
  editor: FieldEditor;
  field: FieldValue;
  /** Each node's value; `field.value` is the active node's. */
  values: readonly unknown[];
  mixed: boolean;
  nodes: NodeRefs;
  onCommit: (value: unknown) => void;
  onCommitAxis: (axis: number, value: number) => void;
}) {
  const { editor, field, values, mixed, nodes, onCommit } = props;
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
      return <TextInput value={mixed ? "" : String(v ?? "")} placeholder={mixed ? MIXED : undefined} label={field.name} onCommit={onCommit} />;
    case "asset":
      return <TextInput value={mixed ? "" : String(v ?? "")} placeholder={mixed ? MIXED : undefined} label={field.name} list={assetListId(assetKindsOf(field))} onCommit={onCommit} />;
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
      return <NodeRefInput value={nodes.keyOf(v)} mixed={mixed} nodes={nodes} label={field.name} onCommit={onCommit} />;
    case "object":
      return mixed ? <span class="none">{MIXED} (differs)</span> : <ObjectInput value={(v ?? {}) as Record<string, unknown>} onCommit={onCommit} />;
    case "choice":
      return <ChoiceInput choices={choicesFor(field, currentProject.value?.settings) ?? []} value={v} mixed={mixed} label={field.name} onCommit={onCommit} />;
    case "quaternion": {
      // Edited as Euler angles in degrees (ADR 0019).
      if (v === null || v === undefined) return <span class="none">None</span>;
      const axes = values.map((x) => (x instanceof Quaternion ? eulerAnglesOf(x) : [0, 0, 0]));
      return <VectorInput value={axes[0].map((n, i) => (axes.every((a) => a[i] === n) ? n : null))} label={field.name} onCommitAxis={props.onCommitAxis} />;
    }
    case "list":
      return <ListInput field={field} mixed={mixed} nodes={nodes} onCommit={onCommit} />;
    default:
      return <span class="none field-json">{safeJSON(v)}</span>;
  }
}

/** Each axis shared by every vector in `values`, or null where they differ. */
function axesOf(values: readonly unknown[]): (number | null)[] {
  const arrays = values.map((x) => (x as { toArray(): number[] }).toArray());
  return arrays[0].map((n, i) => (arrays.every((a) => a[i] === n) ? n : null));
}

function safeJSON(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// --- inputs -------------------------------------------------------------------------------------

/**
 * A text box's draft: the shown value until it gets focus, then what's typed until Enter or blur
 * (commit) or Escape (cancel). So a live value refreshing underneath doesn't overwrite typing.
 * `commit` gets the draft only when it was edited.
 */
function useDraft(shown: string, commit: (draft: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return {
    value: draft ?? shown,
    onFocus: () => setDraft(shown),
    onInput: (e: Event) => setDraft((e.currentTarget as HTMLInputElement).value),
    onBlur: () => {
      const d = cancelled.current ? null : draft;
      cancelled.current = false;
      setDraft(null);
      if (d !== null && d !== shown) commit(d);
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      if (e.key === "Escape") {
        cancelled.current = true;
        (e.currentTarget as HTMLInputElement).blur();
      }
    },
  };
}

/** Text that commits on Enter or blur and reverts on Escape. */
export function TextInput(props: { value: string; label: string; class?: string; placeholder?: string; list?: string; onCommit: (v: string) => void }) {
  const draft = useDraft(props.value, props.onCommit);
  return <input type="text" class={props.class} aria-label={props.label} placeholder={props.placeholder} list={props.list} {...draft} />;
}

/**
 * A number that commits on Enter or blur. Accepts simple arithmetic (`2*3`); invalid text reverts.
 * A null value (differs between the selected nodes) shows a dash until a number is typed.
 */
function NumberInput(props: { value: number | null; integer?: boolean; label: string; onCommit: (v: number) => void }) {
  const shown = props.value === null ? MIXED : formatNumber(props.value);
  const draft = useDraft(shown, (text) => {
    const n = parseNumber(text);
    if (n === null) return;
    const value = props.integer ? Math.round(n) : n;
    if (value !== props.value) props.onCommit(value);
  });
  return <input type="text" inputMode="decimal" class="num-input" aria-label={props.label} {...draft} />;
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

/** Pick a node the target offers, or None. A referenced node it doesn't offer shows as such. */
function NodeRefInput(props: { value: string | null; mixed?: boolean; nodes: NodeRefs; label: string; onCommit: (key: string | null) => void }) {
  const { nodes, value, mixed } = props;
  const choices = nodes.choices();
  const MIXED_VALUE = "\u0000mixed";
  const MISSING = "\u0000missing";
  const missing = !mixed && value !== null && !choices.some((c) => c.key === value);
  return (
    <select
      aria-label={props.label}
      value={mixed ? MIXED_VALUE : missing ? MISSING : (value ?? "")}
      onChange={(e) => {
        const key = (e.currentTarget as HTMLSelectElement).value;
        if (key !== MIXED_VALUE && key !== MISSING) props.onCommit(key === "" ? null : key);
      }}
    >
      {mixed && (
        <option value={MIXED_VALUE} disabled>
          {MIXED}
        </option>
      )}
      <option value="">None</option>
      {missing && (
        <option value={MISSING} disabled>
          ({nodes.missing})
        </option>
      )}
      {choices.map((c) => (
        <option key={c.key} value={c.key}>
          {"  ".repeat(c.depth)}
          {c.label}
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
            <span>{safeJSON(v)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A dropdown of a field's declared choices (ADR 0042). A value that isn't one of them (set by
 * hand in the file, or a layer that was renamed) shows as such until another is picked.
 */
function ChoiceInput(props: { choices: readonly FieldChoice[]; value: unknown; mixed?: boolean; label: string; onCommit: (v: string | number) => void }) {
  const { choices, value, mixed } = props;
  const at = choices.findIndex((c) => c.value === value);
  const MIXED_VALUE = "\u0000mixed";
  const OTHER = "\u0000other";
  return (
    <select
      class="choice-input"
      aria-label={props.label}
      value={mixed ? MIXED_VALUE : at >= 0 ? String(at) : OTHER}
      onChange={(e) => {
        const picked = (e.currentTarget as HTMLSelectElement).value;
        const choice = choices[Number(picked)];
        if (picked !== MIXED_VALUE && picked !== OTHER && choice) props.onCommit(choice.value);
      }}
    >
      {mixed && (
        <option value={MIXED_VALUE} disabled>
          {MIXED}
        </option>
      )}
      {!mixed && at < 0 && (
        <option value={OTHER} disabled>
          {value === undefined || value === null || value === "" ? "(none)" : `${String(value)} (not a choice)`}
        </option>
      )}
      {choices.map((c, i) => (
        <option key={i} value={String(i)}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A list field (ADR 0042): each item with the editor for its type, moved up or down or removed,
 * and an Add button that repeats the last item (or adds a blank one). The whole list is written
 * on every change, so on a prefab instance one override replaces the prefab's list. With several
 * nodes whose lists differ it shows the active node's list under a dash; an edit replaces every
 * node's list with the edited one.
 */
function ListInput(props: { field: FieldValue; mixed: boolean; nodes: NodeRefs; onCommit: (items: unknown[]) => void }) {
  const { field, mixed, nodes } = props;
  const items = Array.isArray(field.value) ? (field.value as unknown[]) : [];
  const editor = itemEditorFor(field);
  const choices = editor === "choice" ? choicesFor(field, currentProject.value?.settings) : null;
  const name = humanize(field.name);
  const write = (next: unknown[]) => props.onCommit(next);
  const replace = (i: number, v: unknown) => write(items.map((x, j) => (j === i ? v : x)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item);
    write(next);
  };
  const add = () => {
    const last = items[items.length - 1];
    const copy = items.length === 0 ? defaultItem(editor, choices) : copyItem(last);
    write([...items, copy]);
  };
  return (
    <div class="list-field" role="group" aria-label={`${name} list`}>
      <div class="list-head">
        <span class="list-count">
          {mixed ? `${MIXED} lists differ; edits replace every list` : `${items.length} item${items.length === 1 ? "" : "s"}`}
        </span>
        <button class="list-add" aria-label={`Add ${field.name} item`} title={`Add an item to ${name}`} onClick={add}>
          + Add
        </button>
      </div>
      {items.map((item, i) => {
        const f = itemField(field, i, item);
        return (
          <div key={i} class="list-item">
            <span class="list-index">{i}</span>
            <div class="list-value">
              <FieldEditorView
                editor={editor}
                field={f}
                values={[item]}
                mixed={false}
                nodes={nodes}
                onCommit={(v) => replace(i, v)}
                onCommitAxis={(axis, n) => replace(i, withAxis(item, editor, axis, n))}
              />
            </div>
            <span class="list-buttons">
              <button aria-label={`Move ${field.name} item ${i} up`} title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button aria-label={`Move ${field.name} item ${i} down`} title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button class="list-remove" aria-label={`Remove ${field.name} item ${i}`} title="Remove this item" onClick={() => write(items.filter((_, j) => j !== i))}>
                ✕
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A copy of a list item, for Add (vectors and colors are live objects; nodes are shared references). */
function copyItem(item: unknown): unknown {
  if (item instanceof GameObject || item === null || typeof item !== "object") return item;
  if (item instanceof Quaternion) return eulerAnglesOf(item);
  if (item instanceof Color) return item.clone();
  if ("toArray" in item) return (item as { toArray(): number[] }).toArray();
  return structuredClone(item);
}

/**
 * A field label. For numbers, dragging it left/right scrubs the value; the whole drag is one step
 * of the target (one undo step in the document). Shift drags 10× faster, Alt 10× slower.
 */
function ScrubLabel(props: { name: string; value: number | null; drag: (label: string) => () => void; onScrub: (value: number) => void }) {
  const drag = useRef<{ x: number; start: number; total: number; end: () => void } | null>(null);
  const { value, onScrub } = props;
  return (
    <label
      title={props.name}
      class={value !== null ? "scrub" : undefined}
      onPointerDown={(e) => {
        if (value === null || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: value, total: 0, end: props.drag(`Drag ${props.name}`) };
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
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        d.end();
      }}
    >
      {humanize(props.name)}
    </label>
  );
}

// --- asset suggestions ------------------------------------------------------------------------------

/**
 * The asset suggestions asset fields offer as you type (ADR 0043, 0044): one `<datalist>` per asset
 * kind a field can declare (ADR 0131), one per combination of kinds a registered component declares,
 * and every file for fields that declare none. Render it once in an Inspector that shows asset fields.
 */
export function AssetLists() {
  const version = docVersion.value; // files come and go
  const scripts = scriptsVersion.value; // script components come and go
  const project = currentProject.value;
  // Built when the project's files change, not on every Inspector render.
  return useMemo(() => {
    const files = listedFiles(project?.files ?? []);
    const options = (list: readonly string[]) => list.map((f) => <option key={f} value={f} />);
    const lists = new Map<string, readonly AssetFieldKind[]>(ASSET_FIELD_KINDS.map((k) => [assetListId([k]), [k]]));
    for (const kinds of declaredKindCombinations()) lists.set(assetListId(kinds), kinds);
    return (
      <>
        {[...lists].map(([id, kinds]) => (
          <datalist key={id} id={id}>
            {options(assetsForKinds(kinds, files))}
          </datalist>
        ))}
        <datalist id="asset-list-all">{options(files)}</datalist>
      </>
    );
  }, [project, version, scripts, project?.files]);
}

/** Each combination of several asset kinds a registered component's field declares (`{ kind: ["texture", "rendertexture"] }`), and each kind outside the engine's own (a plugin's, ADR 0143). */
function declaredKindCombinations(): AssetFieldKind[][] {
  const combos: AssetFieldKind[][] = [];
  for (const id of listComponentIds()) {
    const cls = getComponentClass(id);
    if (!cls) continue;
    for (const f of getFields(cls)) {
      const item = isListType(f.type) ? f.type[0] : f.type;
      if (item !== AssetRef) continue;
      const kinds = assetKindsOf({ name: f.name, type: f.type, value: undefined, options: f.options });
      if (kinds.length > 1 || (kinds.length === 1 && !(ASSET_FIELD_KINDS as readonly string[]).includes(kinds[0]))) combos.push(kinds);
    }
  }
  return combos;
}
