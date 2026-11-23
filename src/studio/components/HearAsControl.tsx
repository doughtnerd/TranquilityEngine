// Hear as (ADR 0351 §6) in the player bar: Source · Web · Desktop · Android, an A/B button flipping between Source and
// the last platform (also the H key), and a progress chip while sounds convert ("Converting for Android…"). A wide
// player bar shows the choices as a segmented control with its caption; a narrower one (≤1700px, as at 1440) a compact
// select, so no segment is ever clipped (UI pass P14). A view over props; the shell feeds it the page's Hear as service
// (`encoding/hearAs.ts`).
import { Chip } from "../../editor/ui/Chip";
import { SegmentedControl } from "../../editor/ui/SegmentedControl";
import { HEAR_AS_CHOICES, hearAsStatus, type HearAsChoice } from "../encoding/hearAs";
import "./studioComponents.css";

export interface HearAsControlProps {
  readonly choice: HearAsChoice;
  /** Conversions running. */
  readonly busy: number;
  readonly failure: string | null;
  onChoose(choice: HearAsChoice): void;
  /** A/B: Source ↔ the last platform. */
  onToggle(): void;
}

export function HearAsControl(props: HearAsControlProps) {
  const s = hearAsStatus(props.choice, props.busy, props.failure);
  return (
    <div class="studio-hear-as" role="group" aria-label="Hear as">
      <span class="studio-hear-as-wide studio-hear-as">
        <span class="studio-hear-as-label">Hear as</span>
        <SegmentedControl size="small" label="Hear as platform" value={props.choice} options={HEAR_AS_CHOICES} onChange={props.onChoose} />
      </span>
      <span class="studio-hear-as-narrow">
        <select class="studio-hear-as-select" aria-label="Hear as platform" title="Hear as: how the sounds play on each platform's encoding" value={props.choice} onChange={(e) => props.onChoose((e.currentTarget as HTMLSelectElement).value as HearAsChoice)}>
          {HEAR_AS_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </span>
      <button type="button" class="studio-hear-as-ab" aria-label="Compare with source" title="A/B: switch between Source and the last platform (H)" onClick={props.onToggle}>
        A/B
      </button>
      {(props.choice !== "source" || props.failure) && (
        <span role="status" title={props.failure ?? undefined}>
          <Chip tone={s.tone}>{s.text}</Chip>
        </span>
      )}
    </div>
  );
}
