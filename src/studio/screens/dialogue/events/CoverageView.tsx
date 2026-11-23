// The Events tab's coverage report (ADR 0355 §7): per event, the argument combinations with no line as compact `*`
// patterns, intended silences, and per language the combinations whose candidate lines are all missing there; then lines
// no event names and events no script names; Export CSV. A view over props.
import { Icon } from "../../../components/Icon";
import type { EventCoverage } from "./coverage";

export interface CoverageViewProps {
  readonly events: readonly EventCoverage[];
  readonly unusedLines: readonly string[];
  readonly unnamedEvents: readonly string[];
  onExport(): void;
}

export function CoverageView(props: CoverageViewProps) {
  return (
    <section class="dl-section" aria-label="Coverage">
      <div class="dl-row"><h3 style={{ flex: 1 }}>Coverage</h3><button onClick={props.onExport}><Icon name="export" /> Export coverage CSV</button></div>
      {props.events.length === 0 && <p class="dl-note">No dialogue events yet.</p>}
      {props.events.map((c) => {
        const langs = Object.entries(c.languages).filter(([, l]) => l.length > 0);
        const clean = c.gaps.length + c.silences.length + langs.length === 0;
        return (
          <details key={c.event} open={!clean} aria-label={`Coverage of ${c.event}`}>
            <summary><b>{c.event}</b> {clean ? <span class="dl-muted">every combination has a line in every language</span> : <span class="dl-warn"><Icon name="warning" /> {c.gaps.length} gap{c.gaps.length === 1 ? "" : "s"}</span>}</summary>
            {c.gaps.length > 0 && <><p class="dl-note">No line:</p><ul class="dl-list dl-key" aria-label={`Gaps of ${c.event}`}>{c.gaps.map((g) => <li key={g}>{g}</li>)}</ul></>}
            {c.silences.length > 0 && <><p class="dl-note">Intended silence:</p><ul class="dl-list dl-key dl-muted">{c.silences.map((g) => <li key={g}>{g}</li>)}</ul></>}
            {langs.map(([code, list]) => (
              <div key={code}>
                <p class="dl-note">Missing in {code} (plays subtitle-only or nothing):</p>
                <ul class="dl-list dl-key" aria-label={`Missing in ${code} for ${c.event}`}>{list.map((g) => <li key={g}>{g}</li>)}</ul>
              </div>
            ))}
            {c.truncated && <p class="dl-warn"><Icon name="warning" /> Stopped early: the event has too many combinations to list.</p>}
          </details>
        );
      })}
      {props.unusedLines.length > 0 && <details><summary>{props.unusedLines.length} line{props.unusedLines.length === 1 ? "" : "s"} in no event</summary><p class="dl-key dl-muted dl-wrap" aria-label="Unused lines">{props.unusedLines.join(", ")}</p></details>}
      {props.unnamedEvents.length > 0 && <p class="dl-note" aria-label="Events no script names">No script names {props.unnamedEvents.join(", ")} (best effort over string literals).</p>}
    </section>
  );
}
