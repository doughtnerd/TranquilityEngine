// The Inspector's pieces for a selected UI element's fields (ADR 0077 §4, ADR 0423 wave C): each field with its editor
// and a badge saying where its value comes from (opening that file in the Code panel at the line), a text box that
// commits on Enter or blur, and Move to class. `UIViewElementInspector.tsx` puts them together for Svelte UI.
import { useEffect, useRef, useState } from "preact/hooks";
import { useDraftText } from "./draftText";
import { Color } from "../../engine";
import { hexWithAlpha } from "../colorMath";
import { openScript } from "../code/codeBuffers";
import { describeOrigin, originBadge, type FieldOrigin, type FieldSourceRow } from "../uiFieldSources";

/** The file and line an origin points into, to open in the Code panel there. */
function placeOf(origin: FieldOrigin): { file: string; line: number } | null {
  if (origin.kind === "inherited" || origin.kind === "animated") return placeOf(origin.origin);
  return origin.kind === "default" ? null : { file: origin.file, line: origin.line };
}

/** "Move to class": a class name (its id, or its tag, to start with) and the button that moves the attributes. */
export function MoveToClass(props: { count: number; suggested: string; onMove: (name: string) => boolean; target: string }) {
  const [name, setName] = useState<string | null>(null);
  const count = props.count;
  // The name box takes the focus once, when it opens (an inline ref callback would run, and steal it back, on every render).
  const box = useRef<HTMLInputElement>(null);
  const editing = name !== null;
  useEffect(() => {
    if (editing) box.current?.focus();
  }, [editing]);
  if (name === null) {
    return (
      <div class="ui-move-class">
        <button
          class="ui-move-class-open"
          disabled={count === 0}
          title={count === 0 ? "No attributes to move (id, class and expressions stay)" : `Move ${count === 1 ? "its attribute" : `its ${count} attributes`} into a class rule in ${props.target}`}
          onClick={() => setName(props.suggested)}
        >
          Move to class…
        </button>
      </div>
    );
  }
  const go = () => {
    if (props.onMove(name)) setName(null);
  };
  return (
    <div class="ui-move-class">
      <span class="ui-move-class-dot">.</span>
      <input
        type="text"
        aria-label="Class name"
        value={name}
        ref={box}
        onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") go();
          if (e.key === "Escape") setName(null);
        }}
      />
      <button class="ui-move-class-go" onClick={go}>
        Move
      </button>
      <button class="ui-move-class-cancel" onClick={() => setName(null)}>
        Cancel
      </button>
    </div>
  );
}

/** A text box that commits on Enter or blur and reverts on Escape. */
export function DraftInput(props: { value: string; label: string; placeholder?: string; class?: string; onCommit: (v: string) => void }) {
  const { input } = useDraftText(props.value, (draft) => draft !== props.value && props.onCommit(draft));
  return <input type="text" class={props.class} aria-label={props.label} placeholder={props.placeholder} {...input} />;
}

const choicesOf = (row: FieldSourceRow): string[] | null => {
  const c = row.info.options?.choices;
  return Array.isArray(c) ? c.map((x) => (typeof x === "object" && x !== null ? String((x as { value: unknown }).value) : String(x))) : null;
};

/** A field's editor: a checkbox, a dropdown of its choices, a colour, or text in attribute syntax. */
function FieldEditor(props: { row: FieldSourceRow; raw: string; onCommit: (raw: string | null) => unknown }) {
  const { row, raw } = props;
  const label = row.property;
  const commit = (v: string) => v !== raw && props.onCommit(v);
  if (row.info.type === Boolean) {
    return <input type="checkbox" aria-label={label} checked={row.value === true} onChange={(e) => commit(String((e.currentTarget as HTMLInputElement).checked))} />;
  }
  const choices = choicesOf(row);
  if (choices) {
    const current = String(row.value ?? "");
    return (
      <select class="choice-input" aria-label={label} value={current} onChange={(e) => commit((e.currentTarget as HTMLSelectElement).value)}>
        {!choices.includes(current) && <option value={current}>{current || "(none)"}</option>}
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  }
  if (row.info.type === Color) {
    const c = row.value instanceof Color ? row.value : null;
    return (
      <span class="ui-color-edit">
        <input type="color" aria-label={`${label} colour`} value={c ? c.toHex() : "#000000"} onChange={(e) => commit(hexWithAlpha((e.currentTarget as HTMLInputElement).value, c ? c.a : 1))} />
        <DraftInput label={label} class="ui-field-text" value={raw} onCommit={commit} />
      </span>
    );
  }
  return <DraftInput label={label} class="ui-field-text" value={raw} onCommit={commit} />;
}

/**
 * One field: its editor (or its current value when it can't be edited here), and a badge saying where its value comes
 * from; clicking the badge opens that file in the Code panel at the line. `raw` is what the editor starts with;
 * `onCommit` gets what was typed, or null for ✕ (shown when the element's own attribute sets it).
 */
export function FieldSourceView(props: { row: FieldSourceRow; raw: string; onCommit: (raw: string | null) => unknown; editable: boolean }) {
  const { row, editable } = props;
  const place = placeOf(row.origin);
  const file = place?.file ?? null;
  const describe = describeOrigin(row.origin);
  const own = row.origin.kind === "attribute";
  return (
    <>
      <div class={`label-cell origin-${row.origin.kind}`} data-field={row.field}>
        <label title={row.property}>{row.property}</label>
      </div>
      <div class="value ui-field-value">
        {editable ? (
          <span class="ui-field-edit">
            <FieldEditor row={row} raw={props.raw} onCommit={props.onCommit} />
            {own && (
              <button class="ui-field-reset" aria-label={`Reset ${row.property}`} title={`Remove the ${row.property} attribute: the stylesheet, inheritance or the default sets it again`} onClick={() => props.onCommit(null)}>
                ✕
              </button>
            )}
          </span>
        ) : (
          <span class="ui-field-current">
            {row.value instanceof Color && <span class="swatch" style={{ background: `rgba(${row.value.r * 255}, ${row.value.g * 255}, ${row.value.b * 255}, ${row.value.a})` }} />}
            {row.display}
          </span>
        )}
        {file ? (
          <button class={`ui-origin origin-${row.origin.kind}`} title={`${describe}\nClick to open ${file} in the Code panel`} data-origin={row.origin.kind} onClick={() => openScript(file, { line: place!.line, column: 1 })}>
            <span class="ui-origin-kind">{originBadge(row.origin)}</span>
            <span class="ui-origin-detail">{shortOrigin(row.origin)}</span>
          </button>
        ) : (
          <span class={`ui-origin origin-${row.origin.kind}`} title={describe} data-origin={row.origin.kind}>
            <span class="ui-origin-kind">{originBadge(row.origin)}</span>
          </span>
        )}
      </div>
    </>
  );
}

/** The origin's detail in a few words: the selector, the attribute, the element it's inherited from. */
function shortOrigin(origin: FieldOrigin): string {
  switch (origin.kind) {
    case "attribute":
      return `${origin.file.split("/").pop()}:${origin.line}`;
    case "rule":
      return `${origin.selector}${origin.state ? ` (:${origin.state})` : ""} · ${origin.file.split("/").pop()}:${origin.line}`;
    case "inherited":
      return `from ${origin.fromLabel}`;
    case "content":
      return `${origin.file.split("/").pop()}:${origin.line}`;
    case "expression":
      return `${origin.source.length > 28 ? `${origin.source.slice(0, 27)}…` : origin.source} · ${origin.file.split("/").pop()}:${origin.line}`;
    case "default":
      return "";
    case "animated":
      return origin.via === "transition" ? origin.name : `@keyframes ${origin.name}`;
  }
}
