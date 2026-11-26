// The Localisation panel's Report tab (ADR 0356 §7–§9): per-language progress, then each list — missing translations,
// keys defined nowhere, unused keys, unkeyed text in Svelte UI (with Dismiss), keys in two tables and, once run, the
// text fit check's overflows. Each row opens its file (at its line). A view: the report comes from `reportModel.ts`
// through the panel.
import { EmptyState } from "../EmptyState";
import type { LocalisationReport } from "./reportModel";
import "./localisation.css";

export interface ReportViewProps {
  readonly report: LocalisationReport;
  /** The fit check is running. */
  readonly fitting?: boolean;
  /** The fit check has been run (its section is in the report). */
  readonly fitted?: boolean;
  onRunFit?(): void;
  onOpen(path: string, line?: number): void;
  onDismiss?(id: string): void;
}

export function ReportView(p: ReportViewProps) {
  const r = p.report;
  return (
    <div class="loc-report">
      <section class="loc-progress" aria-label="Translation progress">
        {r.languages.length === 0 ? (
          <p class="loc-none">Only the reference language ships: add languages in Project Settings &gt; Languages.</p>
        ) : (
          <table class="loc-grid compact">
            <thead>
              <tr>
                <th>Language</th>
                <th>Translated</th>
                <th>Needs review</th>
                <th>Missing</th>
                <th>Done</th>
              </tr>
            </thead>
            <tbody>
              {r.languages.map((l) => (
                <tr key={l.language} data-language={l.language}>
                  <td>{l.language}</td>
                  <td>{l.translated}</td>
                  <td>{l.needsReview}</td>
                  <td>{l.missing}</td>
                  <td>
                    <meter min={0} max={1} value={l.done} aria-label={`${l.language} translated`} /> {Math.round(l.done * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {p.onRunFit && (
        <div class="loc-report-actions">
          <button type="button" onClick={p.onRunFit} disabled={p.fitting} title="Lay out the keyed text the open scene's views render with a fixed size, in each language and the pseudo-language, and list text that overflows">
            {p.fitting ? "Checking fit…" : p.fitted ? "Check text fit again" : "Check text fit"}
          </button>
        </div>
      )}
      {r.issues === 0 && <EmptyState compact title="Nothing to fix" body={p.fitted ? "Every key the game uses is translated, defined and fits." : "Every key the game uses is translated and defined."} />}
      {r.sections.map((s) => (
        <section key={s.id} class="loc-report-section" aria-label={s.title} data-section={s.id}>
          <h4>
            {s.title} <span class="loc-count">{s.rows.length}</span>
          </h4>
          <p class="loc-hint">{s.hint}</p>
          {s.rows.length > 0 && (
            <ul class="loc-report-rows">
              {s.rows.slice(0, 200).map((row) => (
                <li key={row.id}>
                  <button type="button" class="link-button mono" title={`Open ${row.path}${row.line ? ` at line ${row.line}` : ""}`} onClick={() => p.onOpen(row.path, row.line)}>
                    {row.key}
                  </button>
                  <span class="loc-report-detail">{row.detail}</span>
                  {row.dismiss && p.onDismiss && (
                    <button type="button" class="link-button" aria-label={`Dismiss "${row.key}"`} title="Leave it out of this list (kept in .myco/localisation-ignore.json)" onClick={() => p.onDismiss!(row.dismiss!)}>
                      Dismiss
                    </button>
                  )}
                </li>
              ))}
              {s.rows.length > 200 && <li class="loc-none">…and {s.rows.length - 200} more</li>}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
