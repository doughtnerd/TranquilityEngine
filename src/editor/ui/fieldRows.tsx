// Field rows and value widgets for both Inspectors (ADR 0243): the edited document's and a live World's.
// A row renders one component field of a `FieldTarget` (`../fieldTarget.ts`), which decides where a
// commit goes. The widget for each field kind (`../fields/kinds.ts`, ADR 0273) is registered here by kind,
// rotations through their codec component (ADR 0165). So live editing reaches every field kind the
// document's Inspector edits.
import type { VNode } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Color, GameObject, Quaternion } from "../../engine";
import { ASSET_FIELD_KINDS, AssetRef, getComponentClass, getFields, isListType, listComponentIds, type AssetFieldKind, type FieldChoice } from "../../engine/core/registry";
import type { ComponentInfo, FieldValue } from "../../engine/editor";
import { listedFiles } from "../assetBrowser";
import { assetKindsOf, assetListId, assetsForKinds } from "../assetFieldKinds";
import { rotationViewOf } from "../fieldEdits";
import { fieldChoicesFor, listedChoices, loadFieldChoices } from "../fieldChoices";
import type { FieldDrag, FieldTarget, NodeRefs } from "../fieldTarget";
import { choicesFor, fieldTitle, itemField } from "../fieldValues";
import { FIELD_KINDS, fieldKind, type FieldKind, type FieldKindName } from "../fields/kinds";
import { MIXED, NumberInput, formatNumber } from "../fields/NumberInput";
import { RotationField } from "../fields/RotationField";
import type { FieldChoicesContribution } from "../sdk/contributions";
import { currentProject, docVersion, scriptsVersion, status } from "../state";
import { useDraftText } from "./draftText";
import "./inspector-fields.css";

/** A component's fields as rows. `readOnly` fields show their value as JSON. */
export function FieldRows(props: { target: FieldTarget; fields: readonly FieldValue[]; readOnly?: (field: FieldValue) => boolean }) {
  const { target, fields, readOnly } = props;
  return (
    <div class="fields">
      {fields.map((f) => (
        <FieldRow key={f.name} target={target} field={f} readOnly={readOnly?.(f)} />
      ))}
    </div>
  );
}

/**
 * One field of a target's component: its label (dragging a number's label scrubs it), a revert button
 * when it's a prefab override, and its widget. Values that differ between the target's nodes show as
 * mixed; a commit writes every node (one undo step for several in the document). A plugin's choices
 * (ADR 0152) turn the field into a dropdown. A refused write says why in the status bar.
 */
function FieldRow(props: { target: FieldTarget; field: FieldValue; readOnly?: boolean }) {
  const { target, field } = props;
  const info = target.info;
  const kind = props.readOnly ? FIELD_KINDS.unknown : fieldKind(field);
  const { values, mixed, overridden } = target.state(field);
  // Choices a plugin supplies for this field (ADR 0152), e.g. a MeshRenderer's material variants.
  const contributed = props.readOnly ? undefined : fieldChoicesFor(info.type, field.name);
  const loaded = useContributedChoices(contributed, info);
  const choices = contributed ? listedChoices(contributed, loaded, field.value, mixed) : undefined;

  const report = (reason: string | null) => {
    if (reason) status.value = { kind: "error", text: `Can't set ${field.name}: ${reason}.` };
  };
  const commit = (value: unknown) => report(target.set(field, value));
  const commitAxis = (axis: number, n: number) => report(target.setAxis(field, axis, n));
  const commitEach = (next: readonly unknown[]) => report(target.setEach(field, next));
  const revert = () => target.revert(field);

  if (choices === null) return null; // nothing to choose and nothing set
  return (
    <>
      <div class={`label-cell${overridden ? " overridden" : ""}`}>
        <ScrubLabel name={field.name} title={fieldTitle(field)} drag={(label) => target.drag(field, label)} value={isNumeric(kind) && !mixed ? Number(field.value) : null} onScrub={commit} />
        {overridden && (
          <button class="revert" title={`Overridden in this scene. Revert ${field.name} to the prefab's value`} aria-label={`Revert ${field.name}`} onClick={revert}>
            ↺
          </button>
        )}
      </div>
      <div class="value">
        {choices !== undefined ? (
          <ChoiceInput choices={choices} value={field.value} mixed={mixed} label={field.name} onCommit={commit} />
        ) : (
          <FieldWidget
            kind={kind}
            field={field}
            values={values}
            mixed={mixed}
            nodes={target.nodes}
            rowKey={`${info.type}.${field.name}`}
            onCommit={commit}
            onCommitAxis={commitAxis}
            onCommitEach={commitEach}
          />
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

const isNumeric = (kind: FieldKind) => kind.name === "number" || kind.name === "integer";

/** What a field kind's widget is given. */
interface WidgetProps {
  kind: FieldKind;
  field: FieldValue;
  /** Each selected node's value; `field.value` is the active node's. */
  values: readonly unknown[];
  mixed: boolean;
  /** The nodes reference fields can point to (the document's, or a live World's). */
  nodes: NodeRefs;
  /** Names the row for per-row view choices (a rotation's toggle). */
  rowKey?: string;
  onCommit: (value: unknown) => void;
  onCommitAxis: (axis: number, value: number) => void;
  /** Each node's new value, in `values` order. */
  onCommitEach: (next: readonly unknown[]) => void;
}

/** The widget for a field of `props.kind`. */
function FieldWidget(props: WidgetProps) {
  const Widget = WIDGETS[props.kind.name];
  return <Widget {...props} />;
}

const numberWidget = ({ kind, field, mixed, onCommit }: WidgetProps) => (
  <NumberInput value={mixed ? null : Number(field.value)} integer={kind.name === "integer"} label={field.name} onCommit={onCommit} />
);

/** A vector: per axis; unset (Auto, e.g. a sprite's size from its texture) offers Set; set on some nodes only, a dash. */
function vectorWidget({ kind, field, values, onCommit, onCommitAxis }: WidgetProps) {
  if (values.some((x) => !kind.isUnset(x)) && values.some((x) => kind.isUnset(x))) return <span class="none">{MIXED} (some Auto)</span>;
  if (kind.isUnset(field.value)) {
    return (
      <span class="unset">
        <span class="none">Auto</span>
        <button title={`Set ${field.name} explicitly`} onClick={() => onCommit(kind.explicit!())}>
          Set
        </button>
      </span>
    );
  }
  return <VectorInput value={sharedAxes(values.map((x) => kind.axes!.read(x, "radians")))} label={field.name} onCommitAxis={onCommitAxis} />;
}

/** The widget for each field kind (ADR 0273). */
const WIDGETS: Readonly<Record<FieldKindName, (props: WidgetProps) => VNode | null>> = {
  number: numberWidget,
  integer: numberWidget,
  boolean: ({ field, mixed, onCommit }) => (
    <input type="checkbox" checked={!mixed && Boolean(field.value)} indeterminate={mixed} aria-label={field.name} onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).checked)} />
  ),
  string: ({ field, mixed, onCommit }) => <TextInput value={mixed ? "" : String(field.value ?? "")} placeholder={mixed ? MIXED : undefined} label={field.name} onCommit={onCommit} />,
  asset: ({ field, mixed, onCommit }) => (
    <TextInput value={mixed ? "" : String(field.value ?? "")} placeholder={mixed ? MIXED : undefined} label={field.name} list={assetListId(assetKindsOf(field))} onCommit={onCommit} />
  ),
  color: ({ field, mixed, onCommit }) => <ColorInput value={field.value instanceof Color ? field.value : Color.white} mixed={mixed} label={field.name} onCommit={onCommit} />,
  vector2: vectorWidget,
  vector3: vectorWidget,
  node: ({ field, mixed, nodes, onCommit }) => <NodeRefInput value={nodes.keyOf(field.value)} mixed={mixed} nodes={nodes} label={field.name} onCommit={onCommit} />,
  object: ({ field, mixed, onCommit }) =>
    mixed ? <span class="none">{MIXED} (differs)</span> : <ObjectInput value={(field.value ?? {}) as Record<string, unknown>} onCommit={onCommit} />,
  choice: ({ field, mixed, onCommit }) => <ChoiceInput choices={choicesFor(field, currentProject.value?.settings) ?? []} value={field.value} mixed={mixed} label={field.name} onCommit={onCommit} />,
  // A codec component (ADR 0165): Euler radians or degrees, or x, y, z, w, as the field or Settings say.
  quaternion: ({ field, values, rowKey, onCommitEach }) =>
    field.value === null || field.value === undefined ? (
      <span class="none">None</span>
    ) : (
      <RotationField values={values.map((x) => (x instanceof Quaternion ? x : null))} view={rotationViewOf(field)} label={field.name} toggleKey={rowKey} onCommit={onCommitEach} />
    ),
  list: ({ kind, field, mixed, nodes, rowKey, onCommit }) => <ListInput kind={kind} field={field} mixed={mixed} nodes={nodes} rowKey={rowKey} onCommit={onCommit} />,
  unknown: ({ field }) => <span class="none field-json">{safeJSON(field.value)}</span>,
};

// --- inputs -------------------------------------------------------------------------------------

/** Each axis shared by every vector's axes in `arrays`, or null where they differ. */
function sharedAxes(arrays: readonly number[][]): (number | null)[] {
  return arrays[0].map((n, i) => (arrays.every((a) => a[i] === n) ? n : null));
}

/** A value with no widget (a field another editor owns, or a type the Inspector doesn't edit), as JSON. */
function safeJSON(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * The asset suggestions asset fields offer as you type (ADR 0043, 0044): one `<datalist>` per asset
 * kind a field can declare (ADR 0131), one per combination of kinds a registered component declares,
 * and every file for fields that declare none.
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

/** Text that commits on Enter or blur and reverts on Escape. */
export function TextInput(props: { value: string; label: string; class?: string; placeholder?: string; list?: string; onCommit: (v: string) => void }) {
  const { input } = useDraftText(props.value, (draft) => draft !== props.value && props.onCommit(draft));
  return <input type="text" class={props.class} aria-label={props.label} placeholder={props.placeholder} list={props.list} {...input} />;
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

/** Pick a node the target offers (`nodes`: the open scene's, or a live World's, indented by depth), or None. */
function NodeRefInput(props: { value: string | null; mixed?: boolean; nodes: NodeRefs; label: string; onCommit: (key: string | null) => void }) {
  const { nodes, value } = props;
  const choices = nodes.choices();
  const MIXED_VALUE = "\u0000mixed";
  const missing = !props.mixed && value !== null && !choices.some((c) => c.key === value);
  return (
    <select
      aria-label={props.label}
      value={props.mixed ? MIXED_VALUE : (value ?? "")}
      onChange={(e) => {
        const key = (e.currentTarget as HTMLSelectElement).value;
        if (key !== MIXED_VALUE && !(missing && key === value)) props.onCommit(key === "" ? null : key);
      }}
    >
      {props.mixed && (
        <option value={MIXED_VALUE} disabled>
          {MIXED}
        </option>
      )}
      <option value="">None</option>
      {missing && (
        <option value={value!} disabled>
          ({nodes.missing})
        </option>
      )}
      {choices.map((c) => (
        <option key={c.key} value={c.key}>
          {"\u00a0\u00a0".repeat(c.depth)}
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
            <span>{JSON.stringify(v)}</span>
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
function ListInput(props: { kind: FieldKind; field: FieldValue; mixed: boolean; nodes: NodeRefs; rowKey?: string; onCommit: (items: unknown[]) => void }) {
  const { field, mixed, nodes } = props;
  const items = Array.isArray(field.value) ? (field.value as unknown[]) : [];
  const item = props.kind.item!;
  const choices = item.name === "choice" ? choicesFor(field, currentProject.value?.settings) : null;
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
    const copy = items.length === 0 ? item.blank(choices) : copyItem(last);
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
      {items.map((value, i) => {
        const f = itemField(field, i, value);
        return (
          <div key={i} class="list-item">
            <span class="list-index">{i}</span>
            <div class="list-value">
              <FieldWidget
                kind={item}
                field={f}
                values={[value]}
                mixed={false}
                nodes={nodes}
                rowKey={props.rowKey === undefined ? undefined : `${props.rowKey}[${i}]`}
                onCommit={(v) => replace(i, v)}
                onCommitAxis={(axis, n) => item.axes && replace(i, item.axes.write(value, axis, n, rotationViewOf(f)))}
                onCommitEach={(next) => replace(i, next[0])}
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
  if (item instanceof Quaternion) return item.clone();
  if (item instanceof Color) return item.clone();
  if ("toArray" in item) return (item as { toArray(): number[] }).toArray();
  return structuredClone(item);
}

/**
 * A field label. For numbers, dragging it left/right scrubs the value; the whole drag is one step (`drag`,
 * the target's: one undo step in the document). Shift drags 10× faster, Alt 10× slower.
 */
function ScrubLabel(props: { name: string; title?: string; drag: (label: string) => FieldDrag; value: number | null; onScrub: (value: number) => void }) {
  const drag = useRef<{ x: number; start: number; total: number; step: FieldDrag; stopKeys: () => void } | null>(null);
  const { value, onScrub } = props;
  /** End the drag: keep what it did, or (Escape) put the value back. */
  const finish = (keep: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.stopKeys();
    if (keep) d.step.end();
    else d.step.cancel();
  };
  useEffect(() => () => finish(true), []);
  return (
    <label
      title={props.title ?? props.name}
      class={value !== null ? "scrub" : undefined}
      onPointerDown={(e) => {
        if (value === null || e.button !== 0) return;
        const label = e.currentTarget as HTMLElement;
        label.setPointerCapture(e.pointerId);
        // Escape during the drag puts the value back, as it does for a scene-view drag (ADR 0231).
        const view = label.ownerDocument.defaultView ?? window;
        const onKey = (k: KeyboardEvent) => {
          if (k.key !== "Escape") return;
          k.preventDefault();
          k.stopImmediatePropagation();
          finish(false);
        };
        view.addEventListener("keydown", onKey, true);
        finish(true);
        drag.current = { x: e.clientX, start: value, total: 0, step: props.drag(`Drag ${props.name}`), stopKeys: () => view.removeEventListener("keydown", onKey, true) };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d?.step.open) return;
        const dx = e.clientX - d.x;
        if (dx === 0) return;
        d.x = e.clientX;
        d.total += dx * 0.05 * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
        onScrub(Math.round((d.start + d.total) * 1000) / 1000);
      }}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(true)}
    >
      {humanize(props.name)}
    </label>
  );
}

/** `orderInLayer` → "Order In Layer". */
export function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
