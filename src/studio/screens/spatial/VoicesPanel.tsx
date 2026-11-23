// The Voices panel (ADR 0347 "The Voices table reads the runtime's own debug rows"; the prototype's Voices table, spec
// §4.4.5): each emitter, audio zone and 2D sound of the scene with its distance from the listener, how it is rendered
// (HRTF, panned, ambisonic bed, 2D), its occlusion and Doppler, read from the test scene player while the scene plays,
// then the base game scene's own sounds (marked "base"; read-only, so a click doesn't select them). Each of the scene's
// rows plays it solo or mutes it. A click selects.
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Icon } from "../../components/Icon";
import type { VoiceTableRow } from "./voicesTable";

export interface VoicesPanelProps {
  readonly rows: readonly VoiceTableRow[];
  readonly playing: boolean;
  /** Why it can't play (the runtime failed, no scene). */
  readonly blocked?: string;
  readonly selected: string | null;
  onSelect(id: string): void;
  onPlay(): void;
  /** The object played on its own (null: none). */
  readonly solo?: string | null;
  /** Whether an object is muted by hand in the audition. */
  muted?(id: string): boolean;
  onSolo?(id: string): void;
  onMute?(id: string): void;
}

const renderedClass = (r: VoiceTableRow) =>
  r.silenced || !r.playing ? "" : r.rendered === "hrtf" ? "hrtf" : r.rendered === "panned" ? "panned" : r.rendered === "2d" ? "flat" : r.rendered === "bed" || r.rendered === "ambisonic" ? "bed" : "";

export function VoicesPanel(props: VoicesPanelProps) {
  if (!props.playing) {
    return (
      <span title="Play the scene to see how each sound is heard: its distance, HRTF, panned or bed, occlusion and Doppler, as the engine renders it.">
        <EmptyState compact title="Not playing" body={props.blocked} action={props.blocked ? undefined : { label: "Play scene", run: props.onPlay }} />
      </span>
    );
  }
  const actions = !!props.onSolo && !!props.onMute;
  return (
    <div class="sp-voices">
      <table class="sp-voices-table">
        <thead>
          <tr>
            <th scope="col">Emitter</th>
            <th scope="col">Distance</th>
            <th scope="col">Rendered as</th>
            <th scope="col">Occlusion</th>
            <th scope="col">Doppler</th>
            {actions && <th scope="col"><span class="sp-sr">Play or mute</span></th>}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => {
            const soloed = props.solo === r.id;
            const muted = props.muted?.(r.id) ?? false;
            return (
              <tr key={r.id} class={`${props.selected === r.id ? "selected" : ""}${r.silenced || !r.playing ? " quiet" : ""}`} onClick={() => !r.base && props.onSelect(r.id)}>
                <th scope="row">
                  {r.base ? (
                    <span title="A sound of the base game scene, playing underneath (read-only)">
                      {r.name} <span class="sp-base-tag">base</span>
                    </span>
                  ) : (
                    <button type="button" class="sp-voice-name" onClick={() => props.onSelect(r.id)}>{r.name}</button>
                  )}
                </th>
                <td class="num">{r.distanceText}</td>
                <td class={`sp-rendered ${renderedClass(r)}`}>{r.renderedText}</td>
                <td class={r.occlusionText !== "Clear" && /dB|silent/.test(r.occlusionText) ? "sp-occluded" : ""}>{r.occlusionText}</td>
                <td class="num">{r.dopplerText}</td>
                {actions && (
                  <td class="sp-voice-acts">
                    {!r.base && (
                      <>
                        <button type="button" class={`sp-voice-btn${soloed ? " on" : ""}`} aria-pressed={soloed} aria-label={soloed ? `Stop ${r.name}` : `Play ${r.name} solo`} title={soloed ? "Stop: hear everything again" : "Play it on its own"} onClick={(e) => { e.stopPropagation(); props.onSolo!(r.id); }}>
                          <Icon name={soloed ? "stop" : "play"} size={11} />
                        </button>
                        <button type="button" class={`sp-voice-btn${muted ? " warn" : ""}`} aria-pressed={muted} aria-label={muted ? `Unmute ${r.name}` : `Mute ${r.name}`} title={muted ? "Unmute it" : "Mute it"} onClick={(e) => { e.stopPropagation(); props.onMute!(r.id); }}>
                          <Icon name={muted ? "mute" : "volume"} size={13} />
                        </button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
