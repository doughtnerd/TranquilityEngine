// The player bar, "Layout A" (ADR 0349 `PlayerBar`; the prototype's adopted transport): a three-column frame every
// screen fills through slots. Left: the now-playing tile (a kind badge, a title and a subtitle). Centre: the screen's
// transport buttons above its scrub row. Right: a status line, and a slot reserved for a take's replay controls
// (owner decision 2026-11-22: v1 has no Game session pill and no "Linked to game" badge; take replay stands in), and the
// Hear as control (ADR 0351 §6) beside it.
import type { ComponentChildren } from "preact";
import "./studioComponents.css";

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
      <div class="studio-player-now">
        <div class={`studio-player-art${np ? "" : " idle"}`} aria-hidden="true">
          {np?.art ?? props.idleArt ?? "—"}
        </div>
        <div class="studio-player-titles">
          <div class="studio-player-title">{np?.title ?? "Nothing playing"}</div>
          {np?.subtitle && <div class="studio-player-sub">{np.subtitle}</div>}
        </div>
      </div>
      <div class="studio-player-centre">
        <div class="studio-player-transport" role="toolbar" aria-label="Transport">
          {props.transport}
        </div>
        {props.scrub && <div class="studio-player-scrub">{props.scrub}</div>}
      </div>
      <div class="studio-player-right">
        {props.status && <span class="studio-player-status">{props.status}</span>}
        {props.hearAs}
        {props.replay && <div class="studio-player-replay">{props.replay}</div>}
      </div>
    </footer>
  );
}
