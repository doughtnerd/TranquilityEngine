// The gain lanes panel (ADR 0335 `GainLanes`, ADR 0330 "Gain"): for the selected bus or return, each lane of its level
// (fader, runtime, snapshot, VCA, monitor, dip, duck, automation) as a value and a bar, the levels added from above,
// and what you hear (total dB and linear gain). The sums are `gainLanesModel.ts`'s.
import { dbText, gainBreakdown, gainText, laneBar, laneText, type GainInputs } from "./gainLanesModel";
import "./audioParts.css";

export interface GainLanesProps {
  readonly inputs: GainInputs;
  /** The bus or return shown. */
  readonly bus: string | null;
}

export function GainLanes(props: GainLanesProps) {
  const b = props.bus ? gainBreakdown(props.inputs, props.bus) : null;
  if (!b) return <p class="studio-row-empty">Select a bus to see where its level comes from.</p>;
  return (
    <div class="studio-gain" role="table" aria-label={`Gain lanes of ${b.name}`}>
      {b.lanes.map((lane) => {
        const bar = laneBar(lane.db);
        return (
          <div key={lane.key} class={`studio-gain-row${lane.neutral ? " neutral" : ""}`} role="row" title={lane.note}>
            <span class="studio-gain-label" role="rowheader">
              {lane.label}
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
          × Parents
        </span>
        <span class="studio-gain-bar" role="presentation">
          {b.parents.length > 0 && b.parentsDb !== 0 && <span class={`studio-gain-fill${laneBar(b.parentsDb).cut ? " cut" : " boost"}`} style={{ width: `${laneBar(b.parentsDb).fill * 100}%` }} />}
        </span>
        <span class="studio-gain-value" role="cell">
          {b.parents.length === 0 || b.parentsDb === 0 ? "neutral" : dbText(b.parentsDb)}
        </span>
      </div>
      <div class="studio-gain-row total" role="row">
        <span class="studio-gain-label" role="rowheader">
          You hear
        </span>
        <span class="studio-gain-value" role="cell">
          {dbText(b.totalDb)}
        </span>
        <span class="studio-gain-linear" role="cell" title="Linear gain">
          {gainText(b.gain)}
        </span>
      </div>
    </div>
  );
}
