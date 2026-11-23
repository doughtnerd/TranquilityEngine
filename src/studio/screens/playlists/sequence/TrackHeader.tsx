// A track's header on the Sequence timeline (proto A3 `.th.tkh`, 68 px, 168 px wide). Line 1: the lanes caret (only with
// automation), the colour chip, the bold name, a "Playlist" badge on a playlist track and "FX n" (its tooltip lists the
// effects), then Enable (power, green when on), M (danger when pressed) and S (warning when pressed). Line 2: the volume
// in dB (locked and showing the live value while automated), the output bus, and Delete. Pressing the header selects
// the track; dragging it vertically reorders the tracks (the timeline handles the press). Right-click for the menu.
// A view over props.
import type { Track } from "../../../../engine/audio/playlist/types";
import { effectSpec } from "../../../../engine/audio/effects/catalogue";
import { NumberField } from "../../../components/NumberField";
import { SeqIcon } from "./sequenceIcons";

export interface TrackHeaderProps {
  readonly track: Track;
  readonly selected: boolean;
  readonly writable: boolean;
  readonly lanesOpen: boolean;
  readonly height: number;
  /** The volume's automation now (its live value and what drives it), or null when it isn't automated. */
  readonly volumeNow: { readonly value: number; readonly by: string } | null;
  /** The header body pressed (not one of its controls): select, or drag to reorder. */
  onPress(e: PointerEvent): void;
  onMenu(e: MouseEvent): void;
  onToggle(field: "enabled" | "mute" | "solo"): void;
  onToggleLanes(): void;
  /** The volume typed or scrubbed (`drag` true while the label scrubs, then false). */
  onVolume(value: number, drag: boolean): void;
  onDelete(): void;
}

export function TrackHeader(props: TrackHeaderProps) {
  const { track: t, writable } = props;
  const color = typeof t.color === "number" ? `var(--series-${t.color})` : t.color;
  const fx = t.effects.map((e) => effectSpec(e.type).label);
  return (
    <div
      class={`sq-track-head${props.selected ? " selected" : ""}${t.enabled ? "" : " disabled"}`}
      style={{ height: `${props.height}px`, "--clip": color }}
      title={`${t.name} · right-click for more`}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("input, button, select")) return;
        props.onPress(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e);
      }}
    >
      <div class="sq-head-line">
        {t.automation.length > 0 && (
          <button type="button" class="sq-tcb lanes" aria-expanded={props.lanesOpen} aria-label={`Automation lanes of ${t.name}`} title="Show or hide automation lanes" onClick={props.onToggleLanes}>
            {props.lanesOpen ? "▾" : "▸"}
          </button>
        )}
        <span class="sq-swatch" aria-hidden="true" />
        <span class="sq-track-name">{t.name}</span>
        {t.kind === "playlist" && <span class="sq-head-badge" title="Playlist track: its clips trigger playlists">Playlist</span>}
        {fx.length > 0 && <span class="sq-head-badge fx" title={`Track effects: ${fx.join(", ")}`}>FX {fx.length}</span>}
        <button type="button" class="sq-ms pw" aria-pressed={t.enabled} aria-label={`${t.name} enabled`} title={t.enabled ? "Enabled · click to disable" : "Disabled · click to enable"} disabled={!writable} onClick={() => props.onToggle("enabled")}>
          <SeqIcon name="power" size={11} />
        </button>
        <button type="button" class="sq-ms m" aria-pressed={t.mute} aria-label={`Mute ${t.name}`} title={t.mute ? "Muted · click to unmute" : "Mute"} disabled={!writable} onClick={() => props.onToggle("mute")}>M</button>
        <button type="button" class="sq-ms s" aria-pressed={t.solo} aria-label={`Solo ${t.name}`} title={t.solo ? "Soloed · click to unsolo" : "Solo"} disabled={!writable} onClick={() => props.onToggle("solo")}>S</button>
      </div>
      <div class="sq-head-line">
        <span class="sq-head-vol" title={props.volumeNow ? `Volume is automated by ${props.volumeNow.by}` : "Track volume"}>
          <NumberField hideLabel size="narrow" label={`${t.name} volume`} value={props.volumeNow ? Math.round(props.volumeNow.value * 10) / 10 : t.volume} min={-60} max={12} step={0.5} digits={1} unit="dB"
            disabled={!writable || !!props.volumeNow} onValue={(v, drag) => props.onVolume(v, drag)} />
        </span>
        <span class="sq-head-out" title={t.output ? `Plays into ${t.output}` : "Plays into the sequence's output"}>{t.output ?? "Sequence"}</span>
        <button type="button" class="sq-ms tr" aria-label={`Delete ${t.name}`} title="Delete track (Ctrl/⌘+Z to undo)" disabled={!writable} onClick={props.onDelete}>
          <SeqIcon name="trash" size={11} />
        </button>
      </div>
    </div>
  );
}
