// The gain lanes panel (ADR 0349 `GainLanes`, ADR 0344 "Gain"): for the selected bus or return, each lane of its level
// (fader, runtime, snapshot, VCA, monitor, dip, duck, automation) as a value and a bar, the levels added from above,
// and what you hear (total dB and linear gain). The sums are `gainLanesModel.ts`'s.
import { dbText, gainBreakdown, laneBar, laneText, parentsText, totalText, type GainInputs } from "./gainLanesModel";
import "./audioParts.css";
import { EmptyState } from "../../editor/ui/EmptyState";

export interface GainLanesProps {
  readonly inputs: GainInputs;
  /** The bus or return shown. */
  readonly bus: string | null;
}

export function GainLanes(props: GainLanesProps) {
  const b = props.bus ? gainBreakdown(props.inputs, props.bus) : null;
  if (!b) return <EmptyState compact title="Select a bus to see where its level comes from." />;
  return (
    <div class="studio-gain" role="table" aria-label={`Gain lanes of ${b.name}`}>
      {b.lanes.map((lane) => {
        const bar = laneBar(lane.db);
        return (
          <div key={lane.key} class={`studio-gain-row ${lane.key}${lane.neutral ? " neutral" : ""}`} role="row" title={lane.note}>
            <span class="studio-gain-label" role="rowheader">
              {lane.source ? `${lane.label} · ${lane.source}` : lane.label}
            </span>
            <span class="studio-gain-bar" role="presentation">
              {!lane.neutral && <span class={`studio-gain-fill${bar.cut ? " cut" : " boost"}`} style={{ width: `${bar.fill * 100}%` }} />}
            </span>
            <span class="studio-gain-value" role="cell">
              {laneText(lane)}
            </span>
          </div>
        );
      })}
      <div class={`studio-gain-row parents${b.parents.length === 0 ? " neutral" : ""}`} role="row" title={b.parents.map((p) => `${p.name} ${dbText(p.db)}`).join(" · ") || "No bus above"}>
        <span class="studio-gain-label" role="rowheader">
          × parents
        </span>
        <span class="studio-gain-chain" role="cell">
          {parentsText(b) || "—"}
        </span>
        <span class="studio-gain-value" role="cell">
          {b.parents.length === 0 || b.parentsDb === 0 ? "neutral" : dbText(b.parentsDb)}
        </span>
      </div>
      <div class="studio-gain-row total" role="row">
        <span class="studio-gain-label" role="rowheader">
          You hear
        </span>
        <span class="studio-gain-value" role="cell" title="Total level and linear gain">
          {totalText(b)}
        </span>
      </div>
    </div>
  );
}
