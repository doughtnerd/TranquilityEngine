// Batch import (ADR 0340 §9, §8): pick files or a folder of a voice-over delivery, choose a naming pattern (presets or
// typed, tokens {lang} {key} {table} {ignore}), the language of files without {lang}, and whether unknown keys become
// rows of a table; the preview lists every file with what applying does (matched, replace, new row, skipped and why).
// Apply copies the files into the localised roots and writes each sidecar's `vo` and `normalize` (and `lipsync` from a
// Rhubarb Lip Sync `.txt`/`.json` picked beside a file with the same name, ADR 0340 §7). A view over props;
// the screen reads the files and applies the plan.
import { SelectBox } from "../../../editor/ui/PanelFields";
import type { LanguageDef } from "../../../engine/localisation/languages";
import { batchCounts, PATTERN_PRESETS, type BatchRow, type BatchStatus } from "./batchImport";

export interface BatchImportViewProps {
  /** Picked files, relative to what was picked. */
  readonly files: readonly string[];
  readonly pattern: string;
  readonly language: string;
  readonly createIn: string | null;
  readonly preview: { readonly rows: readonly BatchRow[] } | { readonly refused: string };
  readonly tables: readonly string[];
  readonly languages: readonly LanguageDef[];
  readonly busy?: { readonly done: number; readonly total: number } | null;
  onPick(files: readonly File[]): void;
  onPattern(pattern: string): void;
  onLanguage(code: string): void;
  onCreateIn(table: string | null): void;
  onApply(): void;
  onCancel(): void;
}

const STATUS_TEXT: Record<BatchStatus, string> = {
  matched: "new", replace: "replace", unknownKey: "unknown key", unknownLanguage: "unknown language", conflict: "conflict", duplicate: "duplicate", unmatched: "no match",
};

/** The file chooser: files, or a whole folder (its relative paths kept for {lang}/{key} patterns). */
function Pick(props: { folder: boolean; onPick(files: readonly File[]): void }) {
  return (
    <label class="smp-link" style={{ cursor: "pointer" }}>
      {props.folder ? "Choose a folder…" : "Choose files…"}
      <input type="file" hidden multiple accept="audio/*,.wav,.flac,.ogg,.mp3,.m4a,.txt,.tsv,.json" aria-label={props.folder ? "Choose a folder" : "Choose files"}
        {...(props.folder ? { webkitdirectory: "" } : {})}
        onChange={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          const files = [...(input.files ?? [])];
          input.value = "";
          props.onPick(files);
        }} />
    </label>
  );
}

export function BatchImportView(props: BatchImportViewProps) {
  const p = props.preview;
  const rows = "rows" in p ? p.rows : [];
  const counts = batchCounts(rows);
  const copies = counts.matched + counts.replace + (props.createIn ? counts.unknownKey : 0);
  const stem = (t: string) => t.slice(t.lastIndexOf("/") + 1).replace(/\.lines\.json$/i, "");
  return (
    <div class="dl-dialog">
      <div class="dl-row">
        <Pick folder={false} onPick={props.onPick} />
        <Pick folder onPick={props.onPick} />
        <span class="dl-muted">{props.files.length} file{props.files.length === 1 ? "" : "s"}</span>
      </div>
      <div class="dl-row">
        <label class="dl-row">Pattern
          <input type="text" aria-label="Naming pattern" list="dl-pattern-presets" value={props.pattern} onInput={(e) => props.onPattern((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <datalist id="dl-pattern-presets">{PATTERN_PRESETS.map((x) => <option key={x} value={x} />)}</datalist>
        {PATTERN_PRESETS.map((x) => <button key={x} class={x === props.pattern ? "primary" : undefined} onClick={() => props.onPattern(x)}>{x}</button>)}
      </div>
      <div class="dl-row">
        <SelectBox label="Language without {lang}" value={props.language} options={props.languages.map((l) => ({ value: l.code, label: `${l.code} · ${l.name}` }))} onValue={props.onLanguage} />
        <SelectBox label="Unknown keys" value={props.createIn ?? ""} options={[{ value: "", label: "Skip unknown keys" }, ...props.tables.map((t) => ({ value: t, label: `Create rows in ${stem(t)}` }))]} onValue={(v) => props.onCreateIn(v || null)} />
      </div>
      {"refused" in p ? <p class="dl-warn" role="alert">{p.refused}</p> : (
        <>
          <p class="dl-note" aria-label="Import summary">
            {counts.matched} new, {counts.replace} replacing (the old audio is kept as a source version), {counts.unknownKey} unknown key{props.createIn ? " (new rows)" : " (skipped)"}, {counts.unknownLanguage} unknown language, {counts.conflict + counts.duplicate} conflicts, {counts.unmatched} not matching.
          </p>
          <div class="dl-dialog-body">
            <table class="dl-table" aria-label="Import preview">
              <thead><tr><th scope="col">File</th><th scope="col">Status</th><th scope="col">Key</th><th scope="col">Language</th><th scope="col">Goes to</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <th scope="row" class="dl-key">{r.rel}</th>
                    <td><span class={`dl-status ${r.status}`} title={r.note}>{STATUS_TEXT[r.status]}</span>{r.note && <span class="dl-from">{r.note}</span>}{r.lipsync && r.dest && <span class="dl-from" title={r.lipsync}>with lip-sync</span>}</td>
                    <td class="dl-key">{r.key ?? ""}</td>
                    <td>{r.lang ?? ""}</td>
                    <td class="dl-key dl-muted">{r.dest ?? "skipped"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div class="dialog-buttons">
        {props.busy && <span role="status">Importing {props.busy.done}/{props.busy.total}…</span>}
        <button onClick={props.onCancel}>Cancel</button>
        <button class="primary" disabled={copies === 0 || !!props.busy} onClick={props.onApply}>Import {copies} file{copies === 1 ? "" : "s"}</button>
      </div>
    </div>
  );
}

/** The dialog frame around the view. */
export function BatchImportDialog(props: BatchImportViewProps) {
  return (
    <div class="dialog-backdrop" onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
      <div class="dialog dl-dialog-frame" role="dialog" aria-modal="true" aria-labelledby="dl-batch-title" style={{ width: "min(860px, calc(100vw - 32px))" }}>
        <h2 id="dl-batch-title">Batch import voice-over</h2>
        <BatchImportView {...props} />
      </div>
    </div>
  );
}
