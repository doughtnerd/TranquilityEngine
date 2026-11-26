// The player bar, "Layout A" (ADR 0349 `PlayerBar`; the prototype's adopted transport): a raised three-column frame
// every screen fills through slots. Left: the now-playing tile (a type badge such as WAV, SW, SEQ, MIX, tinted by type
// for a playlist's), a title and a subtitle, and on Samples a mini waveform. Centre: the screen's transport (small round
// buttons around the big one: Play / Pause, or the Playlists screen's Trigger pill) above its scrub row (a track, or the
// Playlists screen's voice strip). Right: a status line, the Hear as control (ADR 0351 §6) and the game session: the
// "Record session" button and the game link badge (ADR 0408; they replace UI pass #1's "Game session" pill, which drove
// take replay before the live game link was built).
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { Icon, type IconName } from "./Icon";
import { badgeFor, type BadgeCode } from "./typeBadgeModel";
import { formatClock } from "./replayControlsModel";
import "./studioComponents.css";

export interface TransportButtonProps {
  readonly icon: IconName;
  /** Its name for assistive tech ("Play", "Stop"); also the visible text when `text` is set. */
  readonly label: string;
  /** The tooltip (with its shortcut); defaults to the label. */
  readonly title?: string;
  /** Show the label beside the icon ("Release"); otherwise the button is the icon alone. */
  readonly text?: boolean;
  /** The big round Play/Pause/Stop button. */
  readonly primary?: boolean;
  /** The Playlists screen's big button: an accent pill with its icon and label ("⚡ Trigger", "Release", "Stop"). */
  readonly trigger?: boolean;
  /** A toggle's state (Loop, Follow): sets `aria-pressed`. */
  readonly pressed?: boolean;
  /** Record: drawn in the danger colour while pressed. */
  readonly record?: boolean;
  readonly disabled?: boolean;
  onClick(): void;
}

/**
 * A player-bar transport button (ADR 0361; the prototype's `.pb-tb`, `.pb-big` and `.pb-big.trig`): an icon with its name
 * for assistive tech, a 28px round button (44px on a touch screen); the primary one a 32px disc in the strong text
 * colour, the trigger one an accent pill with its label.
 */
export function TransportButton(props: TransportButtonProps) {
  const kind = props.trigger ? " trigger" : props.primary ? " primary" : "";
  const showText = props.text || props.trigger;
  return (
    <button
      type="button"
      class={`studio-transport-button${kind}${showText ? " with-text" : ""}${props.record ? " record" : ""}`}
      aria-label={showText ? undefined : props.label}
      aria-pressed={props.pressed}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={props.trigger ? 14 : props.primary ? 14 : 16} />
      {showText && <span>{props.label}</span>}
    </button>
  );
}

export interface NowPlaying {
  /** The tile's badge: a playlist type code (QUE, SW, 1D, 2D, LAY, CLP, SEQ, tinted by type) or a kind (WAV, MIX, 3D, TAKE, CAP). */
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
  /** A short status ("Space plays Trim", "Next trigger: Random pick"). It gives way first: cut with an ellipsis, whole in its tooltip. */
  readonly status?: string;
  /** Beside the now-playing tile (the Samples screen's mini waveform). */
  readonly viz?: ComponentChildren;
  /** The screen's playhead, seconds, for the status bar ("Playhead 00:00.520"); without one it shows the session clock. */
  readonly playhead?: { readonly value: number } | null;
  /** Drawn at the right end, before the game session (a screen's own extra control). */
  readonly replay?: ComponentChildren;
  /** ADR 0351 §6: the Hear as control (the shell's, the same on every screen). */
  readonly hearAs?: ComponentChildren;
}

const BADGE_CODES: ReadonlySet<string> = new Set<BadgeCode>(["QUE", "SW", "1D", "2D", "LAY", "CLP", "SEQ", "SMP"]);

export function PlayerBar(props: PlayerBarSlots & { readonly label?: string; readonly idleArt?: string; readonly session?: ComponentChildren }) {
  const np = props.nowPlaying;
  const art = np?.art ?? props.idleArt ?? "—";
  const badge = BADGE_CODES.has(art) ? badgeFor(art as BadgeCode) : null;
  return (
    <footer class="studio-player" aria-label={props.label ?? "Player"}>
      <div class="studio-player-grid">
        <div class="studio-player-now">
          <div class={`studio-player-art${np ? "" : " idle"}${badge ? ` typed studio-tone-${badge.tone}` : ""}`} title={badge?.name} aria-hidden="true">
            {art}
          </div>
          <div class="studio-player-titles">
            <div class="studio-player-title" title={np?.title}>
              {np?.title ?? "Nothing playing"}
            </div>
            {np?.subtitle && (
              <div class="studio-player-sub" title={np.subtitle}>
                {np.subtitle}
              </div>
            )}
          </div>
          {props.viz && <div class="studio-player-viz">{props.viz}</div>}
        </div>
        <div class="studio-player-centre">
          {/* Both rows are always there (empty when idle), so the bar's height never changes between states and screens. */}
          <div class="studio-player-transport" role={props.transport ? "toolbar" : undefined} aria-label={props.transport ? "Transport" : undefined}>
            {props.transport}
          </div>
          <div class="studio-player-scrub">{props.scrub}</div>
        </div>
        <div class="studio-player-right">
          {props.status && (
            <span class="studio-player-status" title={props.status}>
              {props.status}
            </span>
          )}
          {props.hearAs}
          {props.replay && <div class="studio-player-replay">{props.replay}</div>}
          {props.session}
        </div>
      </div>
    </footer>
  );
}

/** The link to a game build, as the player bar's badge shows it: linked, ended, or never made (no badge). */
export type GameLinkState = "linked" | "disconnected" | "none";

export interface RecordSessionProps {
  /** A recording runs on the connected build. */
  readonly recording: boolean;
  /** Seconds recorded so far. */
  readonly time: number;
  /** A game build is connected: only then can a session be recorded. */
  readonly connected: boolean;
  /** Busy starting, stopping or saving: the button waits. */
  readonly busy?: boolean;
  /** The tooltip: what pressing it does now. */
  readonly title: string;
  /** The badge beside it. */
  readonly link: GameLinkState;
  /** The connected build's name, for the badge's tooltip. */
  readonly build?: string | null;
  onToggle(): void;
}

/**
 * ADR 0408: "Record session" (the prototype's `.pb-ses` disc and clock): records a take on the connected game build, and
 * the next press stops it and saves it. Inactive with no build connected. Beside it the link badge: "Linked to game"
 * while linked, a grey "Disconnected" once the link has ended. A view over props.
 */
export function RecordSession(props: RecordSessionProps) {
  const clock = formatClock(props.time);
  const label = props.recording ? "Stop and save the recording" : "Record session";
  return (
    <>
      <button
        type="button"
        class={`studio-session${props.recording ? " on" : ""}`}
        aria-pressed={props.recording}
        aria-label={`${label}, ${clock}`}
        title={props.title}
        disabled={!props.connected || props.busy}
        onClick={props.onToggle}
      >
        <span class="studio-session-disc" aria-hidden="true">
          <Icon name={props.recording ? "stop" : "record"} size={10} />
        </span>
        <span class="studio-session-text">
          Record session<small>{clock}</small>
        </span>
      </button>
      {props.link === "linked" && (
        <span class="studio-linked" title={props.build ? `Linked to ${props.build}` : "Linked to the running game"}>
          Linked to game
        </span>
      )}
      {props.link === "disconnected" && (
        <span class="studio-linked off" title="The link to the game has ended. Connect again from the status bar's builds menu.">
          Disconnected
        </span>
      )}
    </>
  );
}

/** The prototype's live label (`.pb-live`): "● STOPPED" muted, "● LIVE" in the danger colour. */
export function LiveLabel(props: { readonly live: boolean }) {
  return <span class={`studio-live${props.live ? " on" : ""}`}>{props.live ? "Live" : "Stopped"}</span>;
}

/** A voice's run on the strip, seconds; `end` null while it still plays (it fades out at the strip's right edge). */
export interface VoiceStripSegment {
  readonly start: number;
  readonly end: number | null;
  /** Finished before the cursor: drawn faded. */
  readonly done?: boolean;
}

export interface VoiceStripProps {
  /** The span the strip covers, seconds. */
  readonly from: number;
  readonly to: number;
  readonly segments: readonly VoiceStripSegment[];
  /** Times of note (a voice's end, a hold, a stop), drawn as thin marks. */
  readonly marks?: readonly { readonly at: number; readonly kind: "end" | "hold" | "stop" }[];
  /** The playhead, seconds (null: at the end). */
  readonly cursor: number | null;
  /** Now, seconds: where a voice still playing ends (default: the strip's end). */
  readonly now?: number;
  /** The times either side ("0.00", "4.00 s"). */
  readonly startText?: string;
  readonly endText?: string;
  readonly title?: string;
  readonly disabled?: boolean;
  onSeek(t: number): void;
}

/** Voice lanes on the strip before they repeat. */
const STRIP_LANES = 4;
/** At most this many voice bars (the newest). */
const STRIP_SEGMENTS = 16;

/**
 * The Playlists screen's voice strip (the prototype's `.vstrip`): one thin bar per voice of the trigger across its time
 * span, the playhead over them; drag (or ←/→, Shift for bigger steps, Home/End) to preview any point. A slider for
 * assistive tech.
 */
export function VoiceStrip(props: VoiceStripProps) {
  const strip = useRef<HTMLDivElement>(null);
  const span = Math.max(1e-6, props.to - props.from);
  const pct = (t: number) => `${(Math.max(0, Math.min(1, (t - props.from) / span)) * 100).toFixed(3)}%`;
  const cursor = props.cursor ?? props.to;
  const seekAt = (clientX: number) => {
    const r = strip.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    props.onSeek(props.from + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span);
  };
  const step = span / 100;
  return (
    <span class="studio-vbar">
      {props.startText !== undefined && <span class="studio-vtc">{props.startText}</span>}
      <div
        ref={strip}
        class={`studio-vstrip${props.now === undefined && props.segments.some((s) => s.end === null) ? " open" : ""}`}
        role="slider"
        tabIndex={props.disabled ? -1 : 0}
        aria-label="Scrub through the voices"
        aria-disabled={props.disabled || undefined}
        aria-valuemin={0}
        aria-valuemax={Number(span.toFixed(2))}
        aria-valuenow={Number((cursor - props.from).toFixed(2))}
        aria-valuetext={`${(cursor - props.from).toFixed(2)} s`}
        title={props.title}
        onPointerDown={(e) => {
          if (props.disabled || e.button !== 0) return;
          const el = e.currentTarget as HTMLElement;
          el.setPointerCapture?.(e.pointerId);
          seekAt(e.clientX);
        }}
        onPointerMove={(e) => {
          if (!props.disabled && (e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) seekAt(e.clientX);
        }}
        onKeyDown={(e) => {
          if (props.disabled) return;
          const by = e.shiftKey ? step * 10 : step;
          const next = e.key === "ArrowLeft" || e.key === "ArrowDown" ? cursor - by : e.key === "ArrowRight" || e.key === "ArrowUp" ? cursor + by : e.key === "Home" ? props.from : e.key === "End" ? props.to : null;
          if (next === null) return;
          e.preventDefault();
          props.onSeek(Math.max(props.from, Math.min(props.to, next)));
        }}
      >
        {props.segments.slice(-STRIP_SEGMENTS).map((s, i, shown) => {
          // The newest voices; each keeps its lane as older ones drop off the front.
          const lane = (props.segments.length - shown.length + i) % STRIP_LANES;
          const end = s.end ?? props.now;
          return (
            <i
              key={props.segments.length - shown.length + i}
              class={`studio-vseg${s.done ? " done" : ""}${s.end === null ? " open" : ""}`}
              style={{ left: pct(s.start), width: end === undefined ? `calc(100% - ${pct(s.start)})` : `max(1px, calc(${pct(end)} - ${pct(s.start)}))`, top: `${3 + lane * 4}px` }}
            />
          );
        })}
        {(props.marks ?? []).map((m, i) => (
          <b key={`m${i}`} class={`studio-vmark ${m.kind}`} style={{ left: pct(m.at) }} />
        ))}
        <span class="studio-vph" style={{ left: pct(cursor) }} />
      </div>
      {props.endText !== undefined && <span class="studio-vtc end">{props.endText}</span>}
    </span>
  );
}

/** The Samples screen's mini waveform (the prototype's `.pb-viz`): 24 bars of the file's level, the playhead over them. */
export function MiniWaveform(props: { readonly levels: readonly number[]; readonly playhead?: number | null }) {
  const n = props.levels.length;
  return (
    <span class="studio-miniwave" aria-hidden="true">
      {props.levels.map((v, i) => (
        <i key={i} style={{ left: `${(i / Math.max(1, n)) * 100}%`, height: `${Math.max(1, Math.min(1, v) * 100)}%` }} />
      ))}
      {props.playhead != null && <em style={{ left: `${Math.max(0, Math.min(1, props.playhead)) * 100}%` }} />}
    </span>
  );
}
