// The player bar, "Layout A" (ADR 0349 `PlayerBar`; the prototype's adopted transport): a three-column frame every
// screen fills through slots. Left: the now-playing tile (a kind badge, a title and a subtitle). Centre: the screen's
// transport buttons above its scrub row. Right: a status line, and a slot reserved for a take's replay controls
// (owner decision 2026-11-22: v1 has no Game session pill and no "Linked to game" badge; take replay stands in), and the
// Hear as control (ADR 0351 §6) beside it.
import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "./Icon";
import "./studioComponents.css";

export interface TransportButtonProps {
  readonly icon: IconName;
  /** Its name for assistive tech ("Play", "Stop"); also the visible text when `text` is set. */
  readonly label: string;
  /** The tooltip (with its shortcut); defaults to the label. */
  readonly title?: string;
  /** Show the label beside the icon ("Release"); otherwise the button is the icon alone. */
  readonly text?: boolean;
  /** The big round Play/Stop/Trigger button. */
  readonly primary?: boolean;
  /** A toggle's state (Loop, Follow): sets `aria-pressed`. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  onClick(): void;
}

/**
 * A player-bar transport button (ADR 0361): an icon with its name for assistive tech, at least 32px square (44px on a
 * touch screen), the primary one filled with the accent.
 */
export function TransportButton(props: TransportButtonProps) {
  return (
    <button
      type="button"
      class={`studio-transport-button${props.primary ? " primary" : ""}${props.text ? " with-text" : ""}`}
      aria-label={props.text ? undefined : props.label}
      aria-pressed={props.pressed}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={props.primary ? 18 : 16} />
      {props.text && <span>{props.label}</span>}
    </button>
  );
}

export interface NowPlaying {
  /** The kind badge: 2–4 letters (WAV, PL, MIX, 3D, TAKE, CAP). */
  readonly art: string;
  readonly title: string;
  readonly subtitle?: string;
}

export interface PlayerBarSlots {
  readonly nowPlaying?: NowPlaying | null;
  /** The screen's transport buttons. */
  readonly transport?: ComponentChildren;
  /** The scrub row (time, track, end). */
  readonly scrub?: ComponentChildren;
  /** A short status ("Auditioning engine loop", "Replaying take 3 · 0:12"). */
  readonly status?: string;
  /** Reserved for a take's replay (M8): drawn at the right end. */
  readonly replay?: ComponentChildren;
  /** ADR 0351 §6: the Hear as control, before the replay slot (the shell's, the same on every screen). */
  readonly hearAs?: ComponentChildren;
}

export function PlayerBar(props: PlayerBarSlots & { readonly label?: string; readonly idleArt?: string }) {
  const np = props.nowPlaying;
  return (
    <footer class="studio-player" aria-label={props.label ?? "Player"}>
      <div class="studio-player-grid">
        <div class="studio-player-now">
          <div class={`studio-player-art${np ? "" : " idle"}`} aria-hidden="true">
            {np?.art ?? props.idleArt ?? "—"}
          </div>
          <div class="studio-player-titles">
            <div class="studio-player-title">{np?.title ?? "Nothing playing"}</div>
            {np?.subtitle && <div class="studio-player-sub">{np.subtitle}</div>}
          </div>
        </div>
        {(props.transport || props.scrub) && (
          <div class="studio-player-centre">
            <div class="studio-player-transport" role="toolbar" aria-label="Transport">
              {props.transport}
            </div>
            {props.scrub && <div class="studio-player-scrub">{props.scrub}</div>}
          </div>
        )}
        <div class="studio-player-right">
          {props.status && <span class="studio-player-status">{props.status}</span>}
          {props.hearAs}
          {props.replay && <div class="studio-player-replay">{props.replay}</div>}
        </div>
      </div>
    </footer>
  );
}
