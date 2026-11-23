// The Packages screen's Report tab (ADR 0351 §5 step 6, §6, §8): for the chosen platform, the download and the static
// memory bound against the budgets (a bar in `var(--danger)` past one: a tripwire, never a failure), the budgets
// themselves, each package's size and memory, the sounds by size, warnings and problems, and Convert now: the export's
// audio step for the platform into `.myco/cache/audio/`, with progress, after which the figures are exact. A view over props.
import { Chip } from "../../../editor/ui/Chip";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { Icon } from "../../components/Icon";
import type { AudioBudget } from "../../../engine/audio/encoding/types";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import { figureText, formatBytes } from "../../encoding/estimate";
import { PLATFORM_LABELS, PLATFORM_OPTIONS } from "../samples/encodingModel";
import { budgetBar, type PlatformReport } from "./reportModel";

export interface ReportViewProps {
  readonly report: PlatformReport;
  readonly platform: ImportPlatform;
  /** Convert now running for this platform: how far. */
  readonly converting: { readonly done: number; readonly total: number } | null;
  readonly readOnly?: boolean;
  onPlatform(p: ImportPlatform): void;
  onConvert(): void;
  onCancel(): void;
  onBudget(key: keyof AudioBudget, mb: number | null): void;
}

function Bar(props: { label: string; bytes: number; mb: number | undefined; exact: boolean }) {
  const bar = budgetBar(props.bytes, props.mb);
  return (
    <div class="pk-bar-row">
      <span class="pk-bar-label">{props.label}</span>
      <span class="pk-bar-value">
        {figureText(props.bytes, props.exact)}{bar ? ` of ${props.mb} MB` : ""}
        {bar?.over && <> <Icon name="warning" label="Over budget" class="pk-over" /></>}
      </span>
      {bar && (
        <span class={`pk-bar${bar.over ? " over" : ""}`} role="meter" aria-label={`${props.label} against its budget`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(bar.share, 9.99) * 100)}
          aria-valuetext={`${Math.round(bar.share * 100)} % of the budget${bar.over ? ", over" : ""}`}>
          <span class="pk-bar-fill" style={{ width: `${Math.min(100, bar.share * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

function BudgetField(props: { label: string; value: number | undefined; disabled: boolean; onChange(mb: number | null): void }) {
  return (
    <label class="pk-budget">
      <span>{props.label}</span>
      <input type="number" min={0} step={1} placeholder="none" aria-label={props.label} disabled={props.disabled} value={props.value === undefined ? "" : String(props.value)}
        onChange={(e) => {
          const raw = (e.currentTarget as HTMLInputElement).value.trim();
          if (raw === "") return props.onChange(null);
          const n = Number(raw);
          if (Number.isFinite(n)) props.onChange(n);
        }} /> MB
    </label>
  );
}

export function ReportView(props: ReportViewProps) {
  const r = props.report;
  const name = PLATFORM_LABELS[props.platform];
  const biggest = [...r.sounds].filter((s) => s.bytes !== null).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 12);
  return (
    <div class="pk-report" aria-label={`Report for ${name}`}>
      <div class="pk-report-head">
        <SegmentedControl size="small" label="Report platform" value={props.platform} options={PLATFORM_OPTIONS} onChange={props.onPlatform} />
        <Chip tone={r.exact ? "success" : "neutral"} title={r.exact ? "From Convert now: the export's own figures" : "Estimated from bitrate × length until converted"}>{r.exact ? "Exact" : "Estimated"}</Chip>
        {props.converting ? (
          <span class="pk-progress" role="status">
            <progress max={Math.max(1, props.converting.total)} value={props.converting.done} aria-label="Conversion progress" />
            {props.converting.done}/{props.converting.total || "…"}
            <button class="smp-link" onClick={props.onCancel}>Cancel</button>
          </span>
        ) : (
          <button class="primary" disabled={props.readOnly} title={`Encode every sound for ${name} into the project's cache, so exports are fast and these figures exact`} onClick={props.onConvert}>Convert now</button>
        )}
      </div>
      <section class="pk-totals" aria-label="Totals">
        <Bar label="Download" bytes={r.totals.shippedBytes} mb={r.budget.downloadMB} exact={r.exact} />
        <Bar label="Memory (preload + largest package)" bytes={r.totals.memoryBytes} mb={r.budget.memoryMB} exact={r.exact} />
        <p class="smp-muted">{r.totals.files} sound{r.totals.files === 1 ? "" : "s"} · sources {formatBytes(r.totals.sourceBytes)}{r.unknown > 0 ? ` · ${r.unknown} still being measured` : ""}</p>
        <div class="pk-budgets">
          <BudgetField label={`${name} download budget`} value={r.budget.downloadMB} disabled={props.readOnly === true} onChange={(mb) => props.onBudget("downloadMB", mb)} />
          <BudgetField label={`${name} memory budget`} value={r.budget.memoryMB} disabled={props.readOnly === true} onChange={(mb) => props.onBudget("memoryMB", mb)} />
        </div>
      </section>
      {r.warnings.length > 0 && (
        <ul class="pk-warnings" aria-label="Budget warnings">
          {r.warnings.map((w) => <li key={w} class="pk-warning">{w}</li>)}
        </ul>
      )}
      <div class="pk-scroll">
      <table class="pk-table" aria-label="Packages">
        <thead><tr><th scope="col">Package</th><th scope="col">Sounds</th><th scope="col">Size</th><th scope="col">Memory</th></tr></thead>
        <tbody>
          {r.packages.length === 0 && <tr><td colSpan={4} class="smp-muted">No packages ship on {name}: every sound is loose.</td></tr>}
          {r.packages.map((p) => (
            <tr key={p.name}>
              <th scope="row">{p.name}{p.preload ? " · preload" : ""}</th>
              <td>{p.sounds}</td>
              <td>{figureText(p.bytes, r.exact)}</td>
              <td>{figureText(p.memoryBytes, r.exact)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div class="pk-scroll">
      <table class="pk-table" aria-label="Largest sounds">
        <thead><tr><th scope="col">Sound</th><th scope="col">Codec</th><th scope="col">Load</th><th scope="col">Size</th><th scope="col">Memory</th></tr></thead>
        <tbody>
          {biggest.map((s) => (
            <tr key={s.path}>
              <th scope="row" title={s.notes.join("\n") || s.path}>{s.path}</th>
              <td>{s.codec}</td>
              <td>{s.load}</td>
              <td>{figureText(s.bytes ?? 0, r.exact)}</td>
              <td>{s.memoryBytes === null ? "…" : figureText(s.memoryBytes, r.exact)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {r.problems.length > 0 && (
        <details class="pk-problems">
          <summary>{r.problems.length} problem{r.problems.length === 1 ? "" : "s"}</summary>
          <ul>{r.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
