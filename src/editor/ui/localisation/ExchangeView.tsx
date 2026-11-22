// The Localisation panel's Exchange tab (ADR 0342 §8): Export (format, tables, languages, only what needs work) and
// Import (pick CSV, XLIFF or PO files, see what would change and what is skipped and why, then apply: one undo step per
// translation file). A view: the export files, the preview and the writes come from `exchangeModel.ts` through the panel.
import type { ImportPreview } from "../../../engine/localisation/exchange/importPreview";
import { SegmentedControl } from "../SegmentedControl";
import { EXCHANGE_FORMATS, previewSummary, SKIP_REASONS, type ExchangeFormat } from "./exchangeModel";
import "./localisation.css";

export interface ExportChoice {
  readonly format: ExchangeFormat;
  /** Chosen tables (empty: all). */
  readonly tables: readonly string[];
  /** Chosen target languages (empty: all). */
  readonly languages: readonly string[];
  readonly onlyNeedsWork: boolean;
}

export interface ExchangeViewProps {
  readonly tables: readonly string[];
  /** Target languages (every language but the reference), with names. */
  readonly languages: readonly { readonly code: string; readonly name: string }[];
  readonly choice: ExportChoice;
  onChoice(choice: ExportChoice): void;
  onExport(): void;
  /** The import being previewed, or null. */
  readonly preview: ImportPreview | null;
  /** The files it was read from. */
  readonly importing: readonly string[];
  /** Tables the import can't write now (read-only), so their changes are left out. */
  readonly blocked: readonly string[];
  onPickFiles(files: readonly { readonly name: string; readonly text: string }[]): void;
  onApply(): void;
  onCancel(): void;
  /** False on a read-only project. */
  readonly canImport: boolean;
}

const toggle = (list: readonly string[], item: string, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

async function readFiles(input: HTMLInputElement): Promise<{ name: string; text: string }[]> {
  const files = [...(input.files ?? [])];
  input.value = "";
  return Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
}

export function ExchangeView(p: ExchangeViewProps) {
  const c = p.choice;
  const summary = p.preview ? previewSummary(p.preview) : null;
  return (
    <div class="loc-exchange">
      <section class="loc-exchange-section" aria-label="Export">
        <h4>Export for translators</h4>
        <SegmentedControl label="Format" size="small" value={c.format} options={EXCHANGE_FORMATS} onChange={(format) => p.onChoice({ ...c, format })} />
        <fieldset class="loc-choices">
          <legend>Languages</legend>
          {p.languages.length === 0 && <span class="loc-none">Only the reference language is listed.</span>}
          {p.languages.map((l) => (
            <label key={l.code}>
              <input type="checkbox" checked={c.languages.includes(l.code)} onChange={(e) => p.onChoice({ ...c, languages: toggle(c.languages, l.code, (e.currentTarget as HTMLInputElement).checked) })} />
              {l.name} ({l.code})
            </label>
          ))}
          <span class="loc-hint">{c.languages.length === 0 ? "None ticked: every language." : ""}</span>
        </fieldset>
        <fieldset class="loc-choices">
          <legend>Tables</legend>
          {p.tables.map((t) => (
            <label key={t}>
              <input type="checkbox" checked={c.tables.includes(t)} onChange={(e) => p.onChoice({ ...c, tables: toggle(c.tables, t, (e.currentTarget as HTMLInputElement).checked) })} />
              {t}
            </label>
          ))}
          <span class="loc-hint">{c.tables.length === 0 ? "None ticked: every table." : ""}</span>
        </fieldset>
        <label class="loc-inline">
          <input type="checkbox" checked={c.onlyNeedsWork} onChange={(e) => p.onChoice({ ...c, onlyNeedsWork: (e.currentTarget as HTMLInputElement).checked })} />
          Only missing and needs review
        </label>
        <button type="button" class="primary" disabled={p.tables.length === 0 || p.languages.length === 0} onClick={p.onExport}>
          Export
        </button>
      </section>

      <section class="loc-exchange-section" aria-label="Import">
        <h4>Import translations</h4>
        {!p.preview ? (
          <label class={`loc-file${p.canImport ? "" : " disabled"}`}>
            <input
              type="file"
              multiple
              accept=".csv,.xlf,.xliff,.po"
              aria-label="Pick translation files"
              disabled={!p.canImport}
              onChange={(e) => void readFiles(e.currentTarget as HTMLInputElement).then((files) => files.length && p.onPickFiles(files))}
            />
            <span>Pick CSV, XLIFF or PO files… nothing is written until you apply.</span>
          </label>
        ) : (
          <div class="loc-preview" aria-label="Import preview">
            <p>
              From {p.importing.join(", ")}: <strong>{summary!.added}</strong> new, <strong>{summary!.changed}</strong> changed, <strong>{summary!.statusOnly}</strong> status only, {summary!.unchanged} unchanged.
              {summary!.stale > 0 && ` ${summary!.stale} made from older reference text are imported as needing review.`}
            </p>
            {p.preview.changes.length > 0 && (
              <table class="loc-grid compact" aria-label="Changes">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Language</th>
                    <th>Before</th>
                    <th>After</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {p.preview.changes.slice(0, 300).map((ch) => (
                    <tr key={`${ch.table}|${ch.language}|${ch.key}`} class={p.blocked.includes(ch.table) ? "blocked" : undefined}>
                      <td class="mono">{ch.key}</td>
                      <td>{ch.language}</td>
                      <td>{ch.before?.text ?? <em>missing</em>}</td>
                      <td>{ch.after.text}</td>
                      <td>{ch.stale ? "needs review (older reference)" : ch.after.status === "needsReview" ? "needs review" : "translated"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {p.preview.skipped.length > 0 && (
              <details class="loc-skipped" open>
                <summary>
                  {p.preview.skipped.length} skipped: {Object.entries(summary!.skipped).map(([reason, n]) => `${n} ${SKIP_REASONS[reason as keyof typeof SKIP_REASONS]}`).join(", ")}
                </summary>
                <ul>
                  {p.preview.skipped.slice(0, 300).map((s, i) => (
                    <li key={i}>{s.message}</li>
                  ))}
                </ul>
              </details>
            )}
            {p.preview.problems.length > 0 && (
              <ul class="loc-cell-problems">
                {p.preview.problems.map((m, i) => (
                  <li key={i} class="warning">
                    {m}
                  </li>
                ))}
              </ul>
            )}
            {p.blocked.length > 0 && <p class="kit-note">Changes to {p.blocked.join(", ")} are left out: the Audio Studio has the project open, and those tables are its.</p>}
            <div class="loc-inline">
              <button type="button" class="primary" disabled={p.preview.changes.every((ch) => p.blocked.includes(ch.table))} onClick={p.onApply}>
                Apply {p.preview.changes.filter((ch) => !p.blocked.includes(ch.table)).length} changes
              </button>
              <button type="button" onClick={p.onCancel}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
