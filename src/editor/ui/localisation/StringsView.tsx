// The Localisation panel's Strings tab (ADR 0356 §9): a table list, search and filters, and the grid — key, reference
// text, a cell per language (its text with a status chip: translated, needs review, missing, over length, check
// failed), notes, max length and a status column. Cells edit in place (Enter or leaving the cell commits, Escape
// reverts); check errors show under the cell. A read-only table (the Studio's while it runs, a read-only project)
// says why. A view: rows and edits come from `stringsModel.ts` through the panel.
import { useState } from "preact/hooks";
import type { EffectiveStatus } from "../../../engine/localisation/strings/translation";
import { Chip, type ChipTone } from "../Chip";
import { EmptyState } from "../EmptyState";
import { useDraftText } from "../draftText";
import type { StringCell, StringRow, StringsFilterKind, StringsQuery } from "./stringsModel";
import "./localisation.css";

export interface StringsTable {
  readonly path: string;
  /** Why it can't be edited now, or null. */
  readonly readOnly: string | null;
  readonly editInStudio: boolean;
  readonly keys: number;
}

export interface StringsLanguage {
  readonly code: string;
  readonly name: string;
  readonly direction: "ltr" | "rtl";
}

export interface StringsViewProps {
  readonly tables: readonly StringsTable[];
  readonly reference: StringsLanguage;
  readonly languages: readonly StringsLanguage[];
  /** The rows the query keeps. */
  readonly rows: readonly StringRow[];
  /** Every row's count, before the query. */
  readonly total: number;
  readonly query: StringsQuery;
  onQuery(query: StringsQuery): void;
  onAddKey(table: string, key: string): void;
  onRenameKey(table: string, key: string, next: string): void;
  onDuplicateKey(table: string, key: string): void;
  onDeleteKey(table: string, key: string): void;
  onReferenceText(table: string, key: string, text: string): void;
  onNotes(table: string, key: string, notes: string): void;
  onMaxLength(table: string, key: string, max: number | null): void;
  onTranslation(table: string, key: string, language: string, text: string): void;
  onReviewed(table: string, key: string, language: string, reviewed: boolean): void;
  onCreateTable?(): void;
  onEditInStudio?(table: string): void;
}

const STATUS: Readonly<Record<EffectiveStatus, { label: string; tone: ChipTone }>> = {
  translated: { label: "translated", tone: "success" },
  needsReview: { label: "needs review", tone: "warning" },
  missing: { label: "missing", tone: "neutral" },
};

const FILTERS: readonly { value: StringsFilterKind; label: string }[] = [
  { value: "all", label: "All keys" },
  { value: "missing", label: "Missing" },
  { value: "needsReview", label: "Needs review" },
  { value: "overLength", label: "Over length" },
  { value: "problems", label: "Check failed" },
];

/** A cell's text box: commits on Enter or blur, reverts on Escape; multi-line text keeps its line breaks (Shift+Enter). */
function CellInput(props: { value: string; label: string; dir?: "ltr" | "rtl"; placeholder?: string; disabled?: boolean; class?: string; onCommit(v: string): void }) {
  const { input } = useDraftText(props.value, (draft) => draft !== props.value && props.onCommit(draft));
  return <input type="text" class={`loc-cell-input${props.class ? ` ${props.class}` : ""}`} aria-label={props.label} dir={props.dir} placeholder={props.placeholder} disabled={props.disabled} {...input} />;
}

function Problems(props: { cell: StringCell }) {
  const errors = props.cell.problems.filter((p) => p.severity === "error");
  const warnings = props.cell.problems.filter((p) => p.severity === "warning");
  if (errors.length === 0 && warnings.length === 0 && !props.cell.overLength) return null;
  return (
    <ul class="loc-cell-problems">
      {errors.map((p, i) => (
        <li key={`e${i}`} class="error" role="alert">
          {p.message}
        </li>
      ))}
      {warnings.map((p, i) => (
        <li key={`w${i}`} class="warning">
          {p.message}
        </li>
      ))}
      {props.cell.overLength && <li class="warning">{props.cell.length} characters, over the limit</li>}
    </ul>
  );
}

function TranslationCell(props: { row: StringRow; cell: StringCell; language: StringsLanguage; readOnly: boolean; p: StringsViewProps }) {
  const { row, cell, language, p } = props;
  const s = STATUS[cell.status];
  const failed = cell.problems.some((x) => x.severity === "error");
  return (
    <td class={`loc-cell status-${cell.status}${failed ? " failed" : ""}`} data-language={language.code}>
      <CellInput value={cell.text} label={`${row.key} in ${language.code}`} dir={language.direction} placeholder="missing" disabled={props.readOnly} onCommit={(v) => p.onTranslation(row.table, row.key, language.code, v)} />
      <span class="loc-cell-chips">
        <Chip tone={failed ? "danger" : s.tone} title={failed ? "The translation fails the message checks: the runtime skips it for the next language" : undefined}>
          {failed ? "check failed" : s.label}
        </Chip>
        {cell.overLength && <Chip tone="danger">over length</Chip>}
        {cell.status !== "missing" && !props.readOnly && (
          <button
            type="button"
            class="link-button loc-review"
            aria-label={cell.status === "needsReview" ? `Mark ${row.key} in ${language.code} as reviewed` : `Mark ${row.key} in ${language.code} as needing review`}
            onClick={() => p.onReviewed(row.table, row.key, language.code, cell.status === "needsReview")}
          >
            {cell.status === "needsReview" ? "Reviewed" : "Review"}
          </button>
        )}
      </span>
      <Problems cell={cell} />
    </td>
  );
}

export function StringsView(p: StringsViewProps) {
  const [adding, setAdding] = useState("");
  const q = p.query;
  const readOnlyOf = (path: string) => p.tables.find((t) => t.path === path)?.readOnly ?? null;
  /** Where a new key goes: the chosen table, else the first one that can be edited. */
  const addTable = q.table !== null ? (readOnlyOf(q.table) === null ? q.table : null) : (p.tables.find((t) => t.readOnly === null)?.path ?? null);
  if (p.tables.length === 0) {
    return (
      <EmptyState
        title="No string tables yet"
        body="A string table holds keys with their text in the reference language; translations sit beside it, one file per language. UI documents bind keys with t:text, scripts with Locale.t."
        action={p.onCreateTable ? { label: "New string table", run: p.onCreateTable } : undefined}
      />
    );
  }
  const selected = q.table ? p.tables.find((t) => t.path === q.table) : undefined;
  const add = () => {
    if (!addTable || adding.trim() === "") return;
    p.onAddKey(addTable, adding.trim());
    setAdding("");
  };
  return (
    <div class="loc-strings">
      <div class="loc-toolbar" role="search">
        <select aria-label="Table" value={q.table ?? ""} onChange={(e) => p.onQuery({ ...q, table: (e.currentTarget as HTMLSelectElement).value || null })}>
          <option value="">All tables</option>
          {p.tables.map((t) => (
            <option key={t.path} value={t.path}>
              {t.path} ({t.keys}){t.readOnly ? " · read-only" : ""}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Search strings" placeholder="Search keys, text, notes" value={q.search} onInput={(e) => p.onQuery({ ...q, search: (e.currentTarget as HTMLInputElement).value })} />
        <select aria-label="Filter" value={q.filter} onChange={(e) => p.onQuery({ ...q, filter: (e.currentTarget as HTMLSelectElement).value as StringsFilterKind })}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        {q.filter !== "all" && (
          <select aria-label="Filter language" value={q.language ?? ""} onChange={(e) => p.onQuery({ ...q, language: (e.currentTarget as HTMLSelectElement).value || null })}>
            <option value="">in any language</option>
            {[p.reference, ...p.languages].map((l) => (
              <option key={l.code} value={l.code}>
                in {l.name} ({l.code})
              </option>
            ))}
          </select>
        )}
        <span class="loc-count" aria-live="polite">
          {p.rows.length === p.total ? `${p.total} keys` : `${p.rows.length} of ${p.total} keys`}
        </span>
      </div>
      {selected?.readOnly && (
        <p class="kit-note loc-readonly" role="note">
          {selected.readOnly}
          {selected.editInStudio && p.onEditInStudio && (
            <button type="button" class="link-button" onClick={() => p.onEditInStudio!(selected.path)}>
              Edit in the Studio
            </button>
          )}
        </p>
      )}
      <div class="loc-grid-wrap">
        <table class="loc-grid" aria-label="Strings">
          <thead>
            <tr>
              <th>Key</th>
              <th>
                {p.reference.name} ({p.reference.code})
              </th>
              {p.languages.map((l) => (
                <th key={l.code}>
                  {l.name} ({l.code})
                </th>
              ))}
              <th>Status</th>
              <th>Notes</th>
              <th title="Characters any language may take">Max</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {p.rows.map((row) => {
              const ro = readOnlyOf(row.table) !== null;
              return (
                <tr key={`${row.table}|${row.key}`} data-key={row.key} class={`worst-${row.worst}`}>
                  <td class="loc-key">
                    <CellInput value={row.key} label={`Key ${row.key}`} disabled={ro} class="mono" onCommit={(v) => p.onRenameKey(row.table, row.key, v)} />
                    {q.table === null && <span class="loc-table-name">{row.table.split("/").pop()}</span>}
                  </td>
                  <td class={`loc-cell${row.reference.problems.some((x) => x.severity === "error") ? " failed" : ""}`} data-language={p.reference.code}>
                    <CellInput value={row.reference.text} label={`${row.key} reference text`} dir={p.reference.direction} disabled={ro} onCommit={(v) => p.onReferenceText(row.table, row.key, v)} />
                    <Problems cell={row.reference} />
                  </td>
                  {row.cells.map((cell, i) => (
                    <TranslationCell key={cell.language} row={row} cell={cell} language={p.languages[i]} readOnly={ro} p={p} />
                  ))}
                  <td class={`loc-status worst-${row.worst}`}>{row.summary}</td>
                  <td>
                    <CellInput value={row.entry.notes ?? ""} label={`${row.key} notes`} placeholder="For translators" disabled={ro} onCommit={(v) => p.onNotes(row.table, row.key, v)} />
                  </td>
                  <td>
                    <CellInput
                      value={row.entry.maxLength === undefined ? "" : String(row.entry.maxLength)}
                      label={`${row.key} max length`}
                      class="loc-max"
                      disabled={ro}
                      onCommit={(v) => p.onMaxLength(row.table, row.key, v.trim() === "" ? null : Number(v))}
                    />
                  </td>
                  <td class="loc-actions">
                    <button type="button" class="kit-icon-button" aria-label={`Duplicate ${row.key}`} disabled={ro} onClick={() => p.onDuplicateKey(row.table, row.key)}>
                      ⧉
                    </button>
                    <button type="button" class="kit-icon-button" aria-label={`Delete ${row.key}`} disabled={ro} onClick={() => p.onDeleteKey(row.table, row.key)}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {p.rows.length === 0 && <p class="loc-none">No keys match.</p>}
      </div>
      <div class="loc-add">
        <input type="text" class="mono" aria-label="New key" placeholder={addTable ? `New key in ${addTable.split("/").pop()}` : "No table can be edited now"} disabled={!addTable} value={adding} onInput={(e) => setAdding((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button type="button" disabled={!addTable || adding.trim() === ""} onClick={add}>
          + Key
        </button>
      </div>
    </div>
  );
}
