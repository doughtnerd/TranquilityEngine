// The Dialogue screen's Lines tab (ADR 0340 §9, 0343 §1, §6): every line table's rows — Key, Speaker, Text in the
// preview language (written to the string table), and a status cell per language (recorded, fallback, missing, with
// mismatch ⚠, script changed ✎ and reading-speed flags) — with the table filter, search, column filters, and Add,
// Duplicate and Delete. Inline edits commit on Enter or blur, each one undo step. A view over props.
import { useEffect, useState } from "preact/hooks";
import { SelectBox } from "../../../editor/ui/PanelFields";
import type { LanguageDef } from "../../../engine/localisation/languages";
import { cellLabel } from "./lineStatus";
import { filterFromId, filterId, type LineRowView, type LinesQuery } from "./linesModel";

export interface LinesViewProps {
  readonly rows: readonly LineRowView[];
  /** Every row's count before filtering, and the filter choices with counts. */
  readonly total: number;
  readonly filters: readonly { readonly filter: LinesQuery["filter"]; readonly label: string; readonly count: number }[];
  readonly tables: readonly string[];
  /** Each table's speaker names, offered in the Speaker column. */
  readonly speakers?: Readonly<Record<string, readonly string[]>>;
  readonly languages: readonly LanguageDef[];
  readonly preview: string;
  readonly query: LinesQuery;
  readonly selected: string | null;
  readonly readOnly?: boolean;
  onQuery(q: LinesQuery): void;
  onSelect(key: string): void;
  onAdd(): void;
  onDuplicate(key: string): void;
  onDelete(key: string): void;
  onRename(key: string, to: string): void;
  onSpeaker(key: string, speaker: string): void;
  onText(key: string, text: string): void;
  onBatchImport?(): void;
}

/** A text field that commits on Enter or blur and puts the value back on Escape. */
export function InlineText(props: { value: string; label: string; disabled?: boolean; placeholder?: string; class?: string; list?: string; onCommit(v: string): void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => {
    if (text !== props.value) props.onCommit(text);
  };
  return (
    <input
      type="text"
      class={props.class}
      aria-label={props.label}
      value={text}
      list={props.list}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(props.value);
      }}
    />
  );
}

const stem = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.lines\.json$/i, "");

export function LinesView(props: LinesViewProps) {
  const q = props.query;
  const selected = props.rows.find((r) => r.key === props.selected) ?? null;
  return (
    <div class="dl-lines">
      <div class="dl-toolbar">
        <SelectBox label="Line table" value={q.table ?? ""} options={[{ value: "", label: "Every table" }, ...props.tables.map((t) => ({ value: t, label: stem(t) }))]} onValue={(v) => props.onQuery({ ...q, table: v || null })} />
        <input type="search" aria-label="Search lines" placeholder="Search key, speaker, text, tag" value={q.search} onInput={(e) => props.onQuery({ ...q, search: (e.currentTarget as HTMLInputElement).value })} />
        <SelectBox label="Show" value={filterId(q.filter)} options={props.filters.map((f) => ({ value: filterId(f.filter), label: `${f.label} (${f.count})` }))} onValue={(v) => props.onQuery({ ...q, filter: filterFromId(v) })} />
        <button disabled={props.readOnly || props.tables.length === 0} title={props.tables.length === 0 ? "Create a line table first (*.lines.json)" : "Add a line after the selected one"} onClick={props.onAdd}>Add line</button>
        <button disabled={props.readOnly || !selected} onClick={() => selected && props.onDuplicate(selected.key)}>Duplicate</button>
        <button disabled={props.readOnly || !selected} onClick={() => selected && props.onDelete(selected.key)}>Delete</button>
        {props.onBatchImport && <button disabled={props.readOnly} onClick={props.onBatchImport}>Batch import…</button>}
      </div>
      <table class="dl-table" aria-label="Lines">
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Speaker</th>
            <th scope="col">Text ({props.preview})</th>
            {props.languages.map((l) => <th key={l.code} scope="col" class="dl-cell" title={`${l.name}${l.ship ? "" : " (not shipped)"}`}>{l.code}</th>)}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 && (
            <tr><td colSpan={3 + props.languages.length} class="dl-muted">{props.total === 0 ? "No lines yet: add a line, or import a script or a delivery." : "No line matches the search and filter."}</td></tr>
          )}
          {props.rows.map((r) => (
            <tr key={`${r.ref.doc.path}#${r.key}`} class={r.key === props.selected ? "selected" : undefined} aria-selected={r.key === props.selected} onClick={() => props.onSelect(r.key)}>
              <td class="dl-key"><InlineText value={r.key} label={`Key of ${r.key}`} disabled={props.readOnly} onCommit={(v) => props.onRename(r.key, v.trim())} /></td>
              <td><InlineText value={r.speaker ?? ""} label={`Speaker of ${r.key}`} list={`dl-speakers-${stem(r.ref.doc.path)}`} disabled={props.readOnly} onCommit={(v) => props.onSpeaker(r.key, v)} /></td>
              <td class="dl-text">
                {r.subtitled ? (
                  <>
                    <InlineText value={r.textFrom ? "" : r.text ?? ""} placeholder={r.textFrom ? r.text ?? "" : "No subtitle yet"} label={`Text of ${r.key}`} disabled={props.readOnly} onCommit={(v) => props.onText(r.key, v)} />
                    {r.textFrom && <span class="dl-from" title={`Not translated into ${props.preview}: shown in ${r.textFrom}`}>{r.textFrom}</span>}
                  </>
                ) : (
                  <span class="dl-muted" title="textKey: null — breaths and efforts have no subtitle">never subtitled</span>
                )}
              </td>
              {r.cells.map((c) => {
                const l = cellLabel(c);
                return <td key={c.code} class={`dl-cell ${l.tone}`} title={l.title} aria-label={`${r.key} in ${c.code}: ${l.title.split("\n").join("; ")}`}>{l.text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {props.tables.map((t) => (
        <datalist key={t} id={`dl-speakers-${stem(t)}`}>
          {(props.speakers?.[t] ?? []).map((s) => <option key={s} value={s} />)}
        </datalist>
      ))}
    </div>
  );
}
