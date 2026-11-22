// The Voices panel (ADR 0333 "The Voices table reads the runtime's own debug rows"; the prototype's Voices table): each
// emitter, audio zone and 2D sound of the scene with its distance from the listener, how it is rendered (HRTF, panned,
// ambisonic bed, 2D), its occlusion and Doppler, read from the test scene player while the scene plays. A click selects.
import { EmptyState } from "../../../editor/ui/EmptyState";
import type { VoiceTableRow } from "./voicesTable";

export interface VoicesPanelProps {
  readonly rows: readonly VoiceTableRow[];
  readonly playing: boolean;
  /** Why it can't play (the runtime failed, no scene). */
  readonly blocked?: string;
  readonly selected: string | null;
  onSelect(id: string): void;
  onPlay(): void;
}

export function VoicesPanel(props: VoicesPanelProps) {
  if (!props.playing) {
    return (
      <EmptyState
        compact
        title="Not playing"
        body={props.blocked ?? "Play the scene to see how each sound is heard: its distance, HRTF, panned or bed, occlusion and Doppler, as the engine renders it."}
        action={props.blocked ? undefined : { label: "Play scene", run: props.onPlay }}
      />
    );
  }
  return (
    <div class="sp-voices">
      <table class="sp-voices-table">
        <thead>
          <tr>
            <th scope="col">Emitter</th>
            <th scope="col" class="num">Distance</th>
            <th scope="col">Rendered as</th>
            <th scope="col">Occlusion</th>
            <th scope="col" class="num">Doppler</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.id} class={`${props.selected === r.id ? "selected" : ""}${r.silenced || !r.playing ? " quiet" : ""}`} onClick={() => props.onSelect(r.id)}>
              <th scope="row">
                <button type="button" class="sp-link" onClick={() => props.onSelect(r.id)}>{r.name}</button>
              </th>
              <td class="num">{r.distanceText}</td>
              <td>
                <span class={`sp-swatch ${r.rendered === "hrtf" ? "hrtf" : r.rendered === "panned" ? "panned" : r.rendered === "bed" || r.rendered === "ambisonic" ? "bed" : "none"}`} aria-hidden="true" />
                {r.renderedText}
              </td>
              <td>{r.occlusionText}</td>
              <td class="num">{r.dopplerText}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
