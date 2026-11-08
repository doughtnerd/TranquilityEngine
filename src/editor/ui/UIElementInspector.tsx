import { useEffect, useState } from "preact/hooks";
import { Color } from "../../engine";
import type { UIDocumentElement } from "../../engine/ui/UIDocument";
import { openScript } from "../code/codeState";
import { currentProject, openScene, playState } from "../state";
import { editorTextFiles } from "../textFiles";
import { attributeText, movableAttributes, moveUIElementToClass, renameUIElement, setUIElementClasses, setUIElementField, suggestedClassName, whyNotEditableUI } from "../uiDocumentEdits";
import { describeOrigin, fieldSources, markupLocation, originBadge, resolveUIElement, selectedUIRef, uiBuildVersion, type FieldOrigin, type FieldSourceRow, type UIElementRef } from "../uiDocuments";
import "./ui-element-inspector.css";

/** The file an origin points into, to open in the Code panel. */
function fileOf(origin: FieldOrigin): string | null {
  if (origin.kind === "inherited") return fileOf(origin.origin);
  return origin.kind === "default" ? null : origin.file;
}

/**
 * A selected UI document element (ADR 0077 §4): what it is, where it's written, and its component's
 * fields with where each value comes from (its attribute, a stylesheet rule, inherited, the text
 * content, a binding, or the default). Editing a field writes an attribute on the element in its
 * markup file (the text content for a Text's text, a button's label or an input field's value),
 * overriding rules and inheritance; ✕ removes the attribute. The id and classes edit in place, and
 * Move to class moves the attributes into a stylesheet rule. Every edit is one undo step.
 */
export function UIElementInspector() {
  uiBuildVersion.value; // follow rebuilds (hot reload)
  currentProject.value;
  playState.value;
  const scene = openScene.value, ref = selectedUIRef();
  const el = scene && ref ? resolveUIElement(scene.sync, ref) : null;
  if (!el || !ref) return <p class="empty">{editorTextFiles.busy ? "Updating…" : "The selected UI element is gone (its document changed)."}</p>;
  const where = markupLocation(el);
  const rows = fieldSources(el);
  const type = el.component.constructor.name;
  const readOnly = whyNotEditableUI();
  return (
    <div class="inspector-body ui-element-inspector">
      <div class="node-header">
        <span class="node-name ui-element-name">{where.synthetic ? "Label" : `<${el.tag}>`}</span>
      </div>
      <p class="ui-element-note">
        {readOnly
          ? `From a UI document: built from the markup file, not saved in the scene. Can't edit it here: ${readOnly}.`
          : where.synthetic
            ? "A button's text content. Its text edits the button's label; style it on the button or in a stylesheet."
            : "From a UI document: edits are written to its markup file (Ctrl+Z undoes them)."}
      </p>
      <dl class="node-meta">
        <dt>File</dt>
        <dd>
          <button class="link-button" title={`Open ${where.file} in the Code panel`} onClick={() => openScript(where.file)}>
            {where.file}:{where.line}
          </button>
          {where.from && <span class="ui-element-from"> (used from another document)</span>}
        </dd>
        {!where.synthetic && (
          <>
            <dt>Id</dt>
            <dd>
              {readOnly ? el.id ?? "" : <DraftInput label="Id" value={el.id ?? ""} placeholder="none" onCommit={(v) => renameUIElement(ref, v)} />}
            </dd>
            <dt>Class</dt>
            <dd>
              {readOnly ? el.classList.values().join(" ") : <DraftInput label="Class" value={el.classList.values().join(" ")} placeholder="none" onCommit={(v) => setUIElementClasses(ref, v)} />}
            </dd>
          </>
        )}
        <dt>Document</dt>
        <dd>{el.document._markupPath ?? el.document.document}</dd>
      </dl>
      {!readOnly && !where.synthetic && <MoveToClass key={ref.path} el={el} uiRef={ref} />}
      <section class="component">
        <h3>{type}</h3>
        <div class="fields ui-element-fields">
          {rows.map((r) => (
            <FieldSourceView key={r.field} row={r} el={el} uiRef={ref} editable={!readOnly && (!where.synthetic || r.field === "text")} />
          ))}
        </div>
      </section>
    </div>
  );
}

/** "Move to class": a class name (its id, or its tag, to start with) and the button that moves the attributes. */
function MoveToClass(props: { el: UIDocumentElement; uiRef: UIElementRef }) {
  const [name, setName] = useState<string | null>(null);
  const count = movableAttributes(props.el).length;
  if (name === null) {
    return (
      <div class="ui-move-class">
        <button
          class="ui-move-class-open"
          disabled={count === 0}
          title={count === 0 ? "No attributes to move (id, class and bindings stay)" : `Move ${count === 1 ? "its attribute" : `its ${count} attributes`} into a class rule in the stylesheet`}
          onClick={() => setName(suggestedClassName(props.el))}
        >
          Move to class…
        </button>
      </div>
    );
  }
  const go = () => {
    if (moveUIElementToClass(props.uiRef, name)) setName(null);
  };
  return (
    <div class="ui-move-class">
      <span class="ui-move-class-dot">.</span>
      <input
        type="text"
        aria-label="Class name"
        value={name}
        ref={(input) => input?.focus()}
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
function DraftInput(props: { value: string; label: string; placeholder?: string; class?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  return (
    <input
      type="text"
      class={props.class}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={() => draft !== props.value && props.onCommit(draft)}
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

/** What the field's editor starts with: the attribute as written, the text content, or the current value. */
function writtenText(row: FieldSourceRow, el: UIDocumentElement): string {
  const o = row.origin;
  if (o.kind === "attribute" || o.kind === "binding") return o.attribute.value;
  if (o.kind === "content") return (el._synthetic ? el.parent?._markup.text : el._markup.text) ?? "";
  return attributeText(row.value);
}

const choicesOf = (row: FieldSourceRow): string[] | null => {
  const c = row.info.options?.choices;
  return Array.isArray(c) ? c.map((x) => (typeof x === "object" && x !== null ? String((x as { value: unknown }).value) : String(x))) : null;
};

/** A field's editor: a checkbox, a dropdown of its choices, a colour, or text in attribute syntax. */
function FieldEditor(props: { row: FieldSourceRow; el: UIDocumentElement; uiRef: UIElementRef }) {
  const { row, el, uiRef } = props;
  const label = row.property;
  const raw = writtenText(row, el);
  const commit = (v: string) => v !== raw && setUIElementField(uiRef, row.field, v);
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
    const alpha = c && c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, "0") : "";
    return (
      <span class="ui-color-edit">
        <input type="color" aria-label={`${label} colour`} value={c ? c.toHex() : "#000000"} onChange={(e) => commit(`${(e.currentTarget as HTMLInputElement).value}${alpha}`)} />
        <DraftInput label={label} class="ui-field-text" value={raw} onCommit={commit} />
      </span>
    );
  }
  return <DraftInput label={label} class="ui-field-text" value={raw} onCommit={commit} />;
}

function FieldSourceView(props: { row: FieldSourceRow; el: UIDocumentElement; uiRef: UIElementRef; editable: boolean }) {
  const { row, el, uiRef, editable } = props;
  const file = fileOf(row.origin);
  const describe = describeOrigin(row.origin);
  const own = row.origin.kind === "attribute" || row.origin.kind === "binding";
  return (
    <>
      <div class={`label-cell origin-${row.origin.kind}`} data-field={row.field}>
        <label title={row.property}>{row.property}</label>
      </div>
      <div class="value ui-field-value">
        {editable ? (
          <span class="ui-field-edit">
            <FieldEditor row={row} el={el} uiRef={uiRef} />
            {own && (
              <button class="ui-field-reset" aria-label={`Reset ${row.property}`} title={`Remove the ${row.property} attribute: the stylesheet, inheritance or the default sets it again`} onClick={() => setUIElementField(uiRef, row.field, null)}>
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
          <button class={`ui-origin origin-${row.origin.kind}`} title={`${describe}\nClick to open ${file} in the Code panel`} data-origin={row.origin.kind} onClick={() => openScript(file)}>
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
    case "binding":
      return `${origin.file.split("/").pop()}:${origin.line}`;
    case "default":
      return "";
  }
}
