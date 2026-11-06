import { Color } from "../../engine";
import { openScript } from "../code/codeState";
import { openScene } from "../state";
import { describeOrigin, fieldSources, markupLocation, originBadge, resolveUIElement, selectedUIRef, uiBuildVersion, type FieldOrigin, type FieldSourceRow } from "../uiDocuments";
import "./ui-element-inspector.css";

/** The file an origin points into, to open in the Code panel. */
function fileOf(origin: FieldOrigin): string | null {
  if (origin.kind === "inherited") return fileOf(origin.origin);
  return origin.kind === "default" ? null : origin.file;
}

/**
 * A selected UI document element (ADR 0077 §4): what it is, where it's written, and its component's
 * fields with where each value comes from (its attribute, a stylesheet rule, inherited, the text
 * content, a binding, or the default). Read-only for now: editing writes back to the markup file in
 * part 2 of wave B.
 */
export function UIElementInspector() {
  uiBuildVersion.value; // follow rebuilds (hot reload)
  const scene = openScene.value, ref = selectedUIRef();
  const el = scene && ref ? resolveUIElement(scene.sync, ref) : null;
  if (!el) return <p class="empty">The selected UI element is gone (its document changed).</p>;
  const where = markupLocation(el);
  const rows = fieldSources(el);
  const type = el.component.constructor.name;
  const classes = el.classList.values();
  return (
    <div class="inspector-body ui-element-inspector">
      <div class="node-header">
        <span class="node-name ui-element-name">{where.synthetic ? "Label" : `<${el.tag}>`}</span>
      </div>
      <p class="ui-element-note">From a UI document: built from the markup file, not saved in the scene. Read-only here for now; edit the file in the Code panel (it reloads when saved).</p>
      <dl class="node-meta">
        <dt>File</dt>
        <dd>
          <button class="link-button" title={`Open ${where.file} in the Code panel`} onClick={() => openScript(where.file)}>
            {where.file}:{where.line}
          </button>
          {where.from && <span class="ui-element-from"> (used from another document)</span>}
        </dd>
        {el.id && (
          <>
            <dt>Id</dt>
            <dd>{el.id}</dd>
          </>
        )}
        {classes.length > 0 && (
          <>
            <dt>Class</dt>
            <dd>{classes.join(" ")}</dd>
          </>
        )}
        <dt>Document</dt>
        <dd>{el.document._markupPath ?? el.document.document}</dd>
      </dl>
      <section class="component">
        <h3>{type}</h3>
        <div class="fields ui-element-fields">
          {rows.map((r) => (
            <FieldSourceView key={r.field} row={r} />
          ))}
        </div>
      </section>
    </div>
  );
}

function FieldSourceView(props: { row: FieldSourceRow }) {
  const { row } = props;
  const file = fileOf(row.origin);
  const describe = describeOrigin(row.origin);
  return (
    <>
      <div class={`label-cell origin-${row.origin.kind}`} data-field={row.field}>
        <label title={row.property}>{row.property}</label>
      </div>
      <div class="value ui-field-value">
        <span class="ui-field-current">
          {row.value instanceof Color && <span class="swatch" style={{ background: `rgba(${row.value.r * 255}, ${row.value.g * 255}, ${row.value.b * 255}, ${row.value.a})` }} />}
          {row.display}
        </span>
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
