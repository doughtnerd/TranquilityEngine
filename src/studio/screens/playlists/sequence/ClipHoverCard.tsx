// The card that shows over a clip after 450 ms (proto A12 `.hovc`, spec §4.2.9): the clip's colour, name and timing badge
// (Sync / Async), its track; Direction, Enabled, Start, End, Length, Offset and Gain; its loops (Active icon, range,
// Inherited / Override, then how it activates, exits and re-enters) and markers (kind, time, "off here"), "None" when it
// has none; and the "follows" warning. Hidden while dragging, in razor mode, or with a menu open (the timeline decides).
import { FloatingPortal } from "../../../../editor/ui/FloatingPortal";
import type { Clip, Track } from "../../../../engine/audio/playlist/types";
import { Icon } from "../../../components/Icon";
import { clipLoops } from "./clipGeometry";
import { clipLength, type SourceFacts } from "./sequenceModel";
import { activeIcon, SeqIcon } from "./sequenceIcons";
import { clipName } from "./TimelineClip";
import { activeText } from "./timelineOverlays";

export interface ClipHoverCardProps {
  readonly clip: Clip;
  readonly track: Track;
  readonly src: SourceFacts | null;
  readonly follows: boolean;
  readonly x: number;
  readonly y: number;
  /** A time in the timeline's display ("00:01.600"). */
  time(t: number): string;
}

const EXIT_TEXT = { jump: "Jump now", finish: "Finish pass", crossfade: "Crossfade" } as const;

export function ClipHoverCard(props: ClipHoverCardProps) {
  const { clip: c, track: t, src } = props;
  const len = clipLength(c, src);
  const loops = c.sample !== undefined ? clipLoops(c, src) : [];
  const markers = c.sample !== undefined ? (src?.markers ?? []) : [];
  const color = typeof t.color === "number" ? `var(--series-${t.color})` : t.color;
  const w = 300;
  const doc = typeof document !== "undefined" ? document.documentElement : null;
  const left = Math.max(4, Math.min(props.x + 14, (doc?.clientWidth ?? 1440) - w - 8));
  const top = Math.max(4, Math.min(props.y + 16, (doc?.clientHeight ?? 1000) - 260));
  const enabled = !t.enabled ? "Off (track)" : c.enabled ? "On" : "Off";
  return (
    <FloatingPortal>
      <div class="sq-hover-card" role="tooltip" style={{ left: `${left}px`, top: `${top}px`, width: `${w}px` }}>
        <div class="sq-hov-top">
          <span class="sq-chip-dot" style={{ background: color }} />
          <strong>{clipName(c)}</strong>
          <span class={`sq-badge ${c.sync ? "sync" : "async"}`}>{c.sync ? "Sync" : "Async"}</span>
        </div>
        <div class="sq-faint">{t.name}</div>
        <div class="sq-hov-grid">
          <span>Direction</span><span>{c.reverse ? "Reverse" : "Forward"}</span>
          <span>Enabled</span><span>{enabled}</span>
          <span>Start</span><span class="sq-mono">{props.time(c.at)}</span>
          <span>End</span><span class="sq-mono">{props.time(c.at + len)}</span>
          <span>Length</span><span class="sq-mono">{len.toFixed(3)} s</span>
          <span>Offset</span><span class="sq-mono">{c.offset.toFixed(3)} s</span>
          <span>Gain</span><span>{c.gain.toFixed(1)} dB</span>
        </div>
        {c.sample !== undefined && (
          <>
            <div class="sq-hov-cap">Loops</div>
            {loops.length === 0 && <div class="sq-faint">None</div>}
            {loops.map((l, i) => (
              <div key={l.id} class="sq-hov-loop">
                <div class="sq-hov-line">
                  <SeqIcon name={activeIcon(l.active)} size={12} />
                  <span>Loop {i + 1}</span>
                  <span class="sq-faint">{l.start === l.end ? `at ${l.start.toFixed(2)} s` : `${l.start.toFixed(2)} – ${l.end.toFixed(2)} s`}</span>
                  <span class={`sq-badge ${l.overridden ? "override" : "inherited"}`}>{l.overridden ? "Override" : "Inherited"}</span>
                </div>
                <div class="sq-faint">{activeText(l)} · {EXIT_TEXT[l.exit]}{l.exit === "crossfade" ? ` ${l.exitFadeMs} ms` : ""} · {l.reentry === "reenter" ? "Re-enter" : "Ignore"}</div>
              </div>
            ))}
            <div class="sq-hov-cap">Markers</div>
            {markers.length === 0 && <div class="sq-faint">None</div>}
            {markers.map((m) => (
              <div key={m.id} class="sq-hov-line">
                <span class={`sq-hov-mk ${m.type}`} />
                <span>{m.name}</span>
                <span class="sq-faint">{m.type === "exit" ? "Exit" : m.type === "cue" ? "Cue" : "Marker"} · {m.at.toFixed(2)} s{c.hiddenMarkers.includes(m.id) ? " · off here" : ""}</span>
              </div>
            ))}
          </>
        )}
        {props.follows && (
          <div class="sq-hov-warn"><Icon name="warning" size={12} /> Follows another Sync loop</div>
        )}
      </div>
    </FloatingPortal>
  );
}
