// The Dialogue screen's Report tab (ADR 0354 §8–§9): per language, recorded / heard from another language / missing
// counts and the keys, duration mismatches with both durations, script changes, reading-speed flags, files not
// normalised to the setting and duplicate keys; Export CSV of the report; and the script CSV (export, and import shown
// as a diff — added, changed, removed — before it is applied, one undo step per document). A view over props.
import { useState } from "preact/hooks";
import { Icon } from "../../components/Icon";
import { FileButton } from "./FileButton";
import type { DialogueReport } from "./reportModel";
import type { ScriptDiff } from "./scriptCsv";

export interface ReportViewProps {
  readonly report: DialogueReport;
  readonly readOnly?: boolean;
  /** A script CSV read and waiting for Apply, or null. */
  readonly pending: ScriptDiff | null;
  onExportReport(): void;
  onExportScript(): void;
  /** A script CSV's text, picked by the user. */
  onImportScript(text: string, name: string): void;
  onApplyScript(remove: boolean): void;
  onCancelScript(): void;
  /** Lines still holding 0354's retired `text` (0357 §1), and moving them into the string tables. */
  readonly oldText?: number;
  onMoveSubtitles?(): void;
}

function Keys(props: { label: string; keys: readonly string[] }) {
  if (props.keys.length === 0) return null;
  return (
    <details>
      <summary>{props.label} ({props.keys.length})</summary>
      <p class="dl-key dl-muted dl-wrap">{props.keys.join(", ")}</p>
    </details>
  );
}

export function ScriptDiffView(props: { diff: ScriptDiff; readOnly?: boolean; onApply(remove: boolean): void; onCancel(): void }) {
  const d = props.diff;
  const [remove, setRemove] = useState(false);
  const none = d.added.length + d.changed.length + d.removed.length === 0;
  return (
    <section class="dl-impact" aria-label="Script import">
      <h3>Script import</h3>
      {none ? <p class="dl-note">The CSV matches the project: nothing to change.</p> : (
        <div class="dl-scroll">
        <table class="dl-table" aria-label="Script changes">
          <thead><tr><th scope="col">Key</th><th scope="col">Change</th></tr></thead>
          <tbody>
            {d.added.map((a) => <tr key={`a${a.key}`}><th scope="row" class="dl-key">{a.key}</th><td><span class="dl-status added">added</span> to {a.table}</td></tr>)}
            {d.changed.map((c) => <tr key={`c${c.key}`}><th scope="row" class="dl-key">{c.key}</th><td><span class="dl-status changed">changed</span> {c.fields.map((f) => f.replace(/^text:/, "text ")).join(", ")}</td></tr>)}
            {d.removed.map((k) => <tr key={`r${k}`}><th scope="row" class="dl-key">{k}</th><td><span class="dl-status removed">not in the CSV</span></td></tr>)}
          </tbody>
        </table>
        </div>
      )}
      {d.problems.length > 0 && <ul class="dl-list dl-warn" aria-label="Skipped">{d.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {d.removed.length > 0 && (
        <label class="dl-row"><input type="checkbox" checked={remove} onChange={(e) => setRemove((e.currentTarget as HTMLInputElement).checked)} /> Delete the {d.removed.length} line{d.removed.length === 1 ? "" : "s"} not in the CSV</label>
      )}
      <div class="dl-row">
        <button class="primary" disabled={props.readOnly || (none && !remove)} onClick={() => props.onApply(remove)}>Apply</button>
        <button onClick={props.onCancel}>Cancel</button>
      </div>
    </section>
  );
}

export function ReportView(props: ReportViewProps) {
  const r = props.report;
  return (
    <div class="dl-report">
      <div class="dl-toolbar">
        <button onClick={props.onExportReport}><Icon name="export" /> Export report CSV</button>
        <button onClick={props.onExportScript} title="Keys, table, speaker, notes and one text column per language"><Icon name="export" /> Export script CSV</button>
        <FileButton icon="import" label="Import script CSV" accept=".csv,text/csv" disabled={props.readOnly} title="Shows what changes before anything is applied"
          onFiles={async ([file]) => { if (file) props.onImportScript(await file.text(), file.name); }}>Import script CSV…</FileButton>
      </div>
      {!!props.oldText && (
        <div class="dl-banner" role="note" aria-label="Subtitles in line tables">
          <span>{props.oldText} line{props.oldText === 1 ? " keeps its" : "s keep their"} subtitles in the line table, where they aren't shown (ADR 0357).</span>
          {props.onMoveSubtitles && <button disabled={props.readOnly} onClick={props.onMoveSubtitles}>Move subtitles to the string table</button>}
        </div>
      )}
      {props.pending && <ScriptDiffView diff={props.pending} readOnly={props.readOnly} onApply={props.onApplyScript} onCancel={props.onCancelScript} />}
      <div class="dl-scroll">
      <table class="dl-table" aria-label="Lines per language">
        <thead><tr><th scope="col">Language</th><th scope="col">Recorded</th><th scope="col">Fallback</th><th scope="col">Missing</th><th scope="col">Mismatch</th><th scope="col">Script changed</th><th scope="col">Reading speed</th></tr></thead>
        <tbody>
          {r.languages.map((l) => (
            <tr key={l.code}>
              <th scope="row">{l.name} ({l.code}){l.ship ? "" : " · not shipped"}</th>
              <td>{l.recorded} / {r.lines}</td>
              <td>{l.fallback}</td>
              <td class={l.missing ? "dl-danger" : undefined}>{l.missing}</td>
              <td class={l.mismatches.length ? "dl-warn" : undefined}>{l.mismatches.length}</td>
              <td class={l.scriptChanged.length ? "dl-warn" : undefined}>{l.scriptChanged.length}</td>
              <td class={l.readingSpeed.length ? "dl-warn" : undefined}>{l.readingSpeed.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {r.languages.map((l) => {
        const any = l.missingKeys.length + l.fallbackKeys.length + l.mismatches.length + l.scriptChanged.length + l.readingSpeed.length > 0;
        if (!any) return null;
        return (
          <section key={l.code} class="dl-section" aria-label={`Report for ${l.code}`}>
            <h3>{l.name} ({l.code})</h3>
            <Keys label="Missing" keys={l.missingKeys} />
            <Keys label="Heard from another language" keys={l.fallbackKeys.map((f) => `${f.key} (${f.from})`)} />
            <Keys label="Duration mismatch" keys={l.mismatches.map((m) => `${m.key} (${m.duration.toFixed(1)} s, reference ${m.reference.toFixed(1)} s)`)} />
            <Keys label="Script changed" keys={l.scriptChanged} />
            <Keys label="Reading speed" keys={l.readingSpeed.map((s) => `${s.key} (${s.cps} cps, max ${s.max})`)} />
          </section>
        );
      })}
      {r.loudness.length > 0 && (
        <details class="dl-section">
          <summary>{r.loudness.length} file{r.loudness.length === 1 ? "" : "s"} not normalised to the setting</summary>
          <ul class="dl-list">{r.loudness.map((f) => <li key={f.path}>{f.path}: {f.mode === "off" ? "not normalised" : `${f.target}`}</li>)}</ul>
        </details>
      )}
      {r.duplicates.length > 0 && (
        <ul class="dl-list dl-warn" aria-label="Duplicate keys">
          {r.duplicates.map((d) => <li key={d.key}>{d.key} is defined in {d.paths.join(" and ")}: the first wins at runtime.</li>)}
        </ul>
      )}
    </div>
  );
}
