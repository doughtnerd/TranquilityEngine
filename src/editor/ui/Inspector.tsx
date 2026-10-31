import { Color, GameObject } from "../../engine";
import { listComponents, type ComponentInfo, type FieldValue } from "../../engine/editor";
import { docVersion, openScene, selection } from "../state";

/**
 * The selected node's components and their declared fields with live values (ADR 0022, 0026).
 * Read-only for now; editing arrives with field commands in a later increment.
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
        <input type="checkbox" checked={entry.active !== false} disabled aria-label="Active" />
        <span class="node-name">{entry.name ?? id}</span>
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
        <ComponentCard key={`${c.type}#${c.index}`} info={c} />
      ))}
    </div>
  );
}

function ComponentCard(props: { info: ComponentInfo }) {
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
            <FieldRow key={f.name} field={f} />
          ))}
        </div>
      )}
    </section>
  );
}

function FieldRow(props: { field: FieldValue }) {
  const { field } = props;
  return (
    <>
      <label title={field.name}>{humanize(field.name)}</label>
      <div class="value">
        <FieldDisplay value={field.value} />
      </div>
    </>
  );
}

function FieldDisplay(props: { value: unknown }) {
  const v = props.value;
  if (v === null || v === undefined) return <span class="none">None</span>;
  if (typeof v === "boolean") return <input type="checkbox" checked={v} disabled />;
  if (typeof v === "number") return <span class="num">{formatNumber(v)}</span>;
  if (typeof v === "string") return v === "" ? <span class="none">""</span> : <span>{v}</span>;
  if (v instanceof Color) {
    return (
      <span class="color">
        <span class="swatch" style={{ background: v.toCss() }} />
        {v.toHex()}
      </span>
    );
  }
  if (v instanceof GameObject) return <span class="ref">{v.name}</span>;
  if (Array.isArray(v)) return <span class="num">{v.map((x) => (typeof x === "number" ? formatNumber(x) : String(x))).join(", ")}</span>;
  const obj = v as { toArray?: () => number[] };
  if (typeof obj.toArray === "function") {
    const axes = ["x", "y", "z", "w"];
    return (
      <span class="vec">
        {obj.toArray().map((x, i) => (
          <span key={i}>
            <em>{axes[i]}</em> {formatNumber(x)}
          </span>
        ))}
      </span>
    );
  }
  if (Object.getPrototypeOf(v) === Object.prototype) {
    return (
      <div class="nested">
        {Object.entries(v as Record<string, unknown>).map(([key, value]) => (
          <div key={key} class="nested-row">
            <span class="nested-key">{humanize(key)}</span>
            <FieldDisplay value={value} />
          </div>
        ))}
      </div>
    );
  }
  return <span>{JSON.stringify(v)}</span>;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

/** `orderInLayer` → "Order In Layer". */
function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
