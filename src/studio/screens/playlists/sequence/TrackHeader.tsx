// A track's header on the Sequence timeline (proto §4 "Track headers"): its colour (a theme series; click for the
// next), name (double-click to rename), kind, Enabled with its automate button, Mute and Solo, volume and pan (which
// write automation while Write is armed and the sequence plays), the lanes caret, the FX count and the output bus.
// A view over props.
import { useState } from "preact/hooks";
import type { Track } from "../../../../engine/audio/playlist/types";
import { RenameField } from "../../../../editor/ui/RenameField";
import { Icon } from "../../../components/Icon";

export interface TrackHeaderProps {
  readonly track: Track;
  readonly selected: boolean;
  readonly writable: boolean;
  readonly lanesOpen: boolean;
  readonly buses: readonly string[];
  readonly height: number;
  onSelect(e: MouseEvent): void;
  onMenu(e: MouseEvent): void;
  onRename(name: string): void;
  onColour(): void;
  onToggle(field: "enabled" | "mute" | "solo"): void;
  onAutomateEnabled(): void;
  onToggleLanes(): void;
  onOutput(bus: string | null): void;
  /** A slider pressed (Write records while it is held), moved (preview) and released (commit). */
  onSlider(field: "volume" | "pan", phase: "start" | "input" | "end", value: number): void;
}

export function TrackHeader(props: TrackHeaderProps) {
  const { track: t, writable } = props;
  const [renaming, setRenaming] = useState(false);
  const color = typeof t.color === "number" ? `var(--series-${t.color})` : t.color;
  const slider = (field: "volume" | "pan", min: number, max: number, step: number, label: string) => (
    <input
      type="range"
      class={`sq-slider ${field}`}
      aria-label={`${t.name} ${label}`}
      title={`${label}: ${field === "volume" ? `${t.volume.toFixed(1)} dB` : t.pan === 0 ? "centre" : `${Math.round(Math.abs(t.pan) * 100)} % ${t.pan < 0 ? "left" : "right"}`}`}
      min={min}
      max={max}
      step={step}
      value={t[field]}
      disabled={!writable}
      onPointerDown={(e) => props.onSlider(field, "start", Number((e.currentTarget as HTMLInputElement).value))}
      onInput={(e) => props.onSlider(field, "input", Number((e.currentTarget as HTMLInputElement).value))}
      onChange={(e) => props.onSlider(field, "end", Number((e.currentTarget as HTMLInputElement).value))}
    />
  );
  return (
    <div
      class={`sq-track-head${props.selected ? " selected" : ""}${t.enabled ? "" : " disabled"}`}
      style={{ height: `${props.height}px`, "--clip": color }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("input, button, select")) return;
        props.onSelect(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e);
      }}
    >
      <div class="sq-head-line">
        <button type="button" class="sq-swatch" aria-label={`${t.name} colour`} title="Track colour (click for the next)" disabled={!writable} onClick={props.onColour} />
        {renaming ? (
          <RenameField value={t.name} label="Track name" onCommit={(v) => { setRenaming(false); if (v.trim() && v !== t.name) props.onRename(v); }} onCancel={() => setRenaming(false)} />
        ) : (
          <span class="sq-track-name" title={`${t.name} · ${t.kind === "audio" ? "Audio track: takes samples" : "Playlist track: takes playlists"} (double-click to rename)`} onDblClick={() => writable && setRenaming(true)}>
            {t.name}
          </span>
        )}
        <span class="sq-kind" title={t.kind === "audio" ? "Audio track" : "Playlist track"}>{t.kind === "audio" ? "AUD" : "PL"}</span>
        <button type="button" class="sq-icon" aria-label={`${t.name} menu`} title="Track menu" aria-haspopup="menu" onClick={(e) => props.onMenu(e)}><Icon name="more" /></button>
      </div>
      <div class="sq-head-line">
        <label class="sq-check" title="Enabled: a disabled track's clips don't play">
          <input type="checkbox" checked={t.enabled} disabled={!writable} aria-label={`${t.name} enabled`} onChange={() => props.onToggle("enabled")} />
        </label>
        <button type="button" class="sq-icon sq-automate" aria-label={`Automate ${t.name} enabled`} title="Automate Enabled" disabled={!writable} onClick={props.onAutomateEnabled}><Icon name="automate" size={14} /></button>
        <button type="button" class={`sq-ms${t.mute ? " on mute" : ""}`} aria-pressed={t.mute} aria-label={`Mute ${t.name}`} disabled={!writable} onClick={() => props.onToggle("mute")}>M</button>
        <button type="button" class={`sq-ms${t.solo ? " on solo" : ""}`} aria-pressed={t.solo} aria-label={`Solo ${t.name}`} disabled={!writable} onClick={() => props.onToggle("solo")}>S</button>
        {slider("volume", -60, 12, 0.5, "Volume")}
        {slider("pan", -1, 1, 0.01, "Pan")}
      </div>
      <div class="sq-head-line">
        <button type="button" class="sq-icon sq-caret" aria-expanded={props.lanesOpen} aria-label={`${t.name} automation lanes`} title={t.automation.length ? "Show or hide the automation lanes" : "No automation yet (track menu › Automate)"} disabled={!t.automation.length} onClick={props.onToggleLanes}>
          <Icon name={props.lanesOpen ? "chevronDown" : "chevronRight"} size={12} /> {t.automation.length}
        </button>
        <button type="button" class="sq-fx" title={t.effects.length ? t.effects.map((e) => e.type).join(", ") : "No track effects (edit them in the Inspector)"} onClick={(e) => props.onSelect(e)}>FX {t.effects.length}</button>
        <select class="sq-out" aria-label={`${t.name} output`} title="Output bus" disabled={!writable} value={t.output ?? ""} onChange={(e) => props.onOutput((e.currentTarget as HTMLSelectElement).value || null)}>
          <option value="">→ Sequence</option>
          {props.buses.map((b) => <option key={b} value={b}>→ {b}</option>)}
        </select>
      </div>
    </div>
  );
}
