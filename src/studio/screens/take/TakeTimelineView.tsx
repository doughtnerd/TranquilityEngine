// The Take screen's timeline (ADR 0348 "The Take screen"; the prototype's Take, with its fixed 32 s replaced by the
// take's real duration): a ruler over the whole take (press and drag to scrub), the picture lane (the take's FRAME
// pictures, when it has them), one instance lane per playlist path (lifetimes, held parts up to the release; click
// selects, Enter or a double-click opens the playlist), the parameter lanes (a line per parameter, labelled ones as
// segments) and the notes lane (the game's marks, and the designer's note markers and regions: drag to move, a
// double-click adds a marker; focused, Left and Right pick a note when none is, then nudge it by 0.1 s, 1 s with Shift).
// The playhead is the replay's time. A view over props.
import { useMemo, useRef } from "preact/hooks";
import type { TakeNotes } from "../../../engine/audio/take/types";
import { Playhead } from "../../components/Playhead";
import { SpanLane } from "../../components/SpanLane";
import { TimeRuler } from "../../components/TimeRuler";
import { ValueLane, type ValueLaneProps } from "../../components/ValueLane";
import { linearTimeAxis, type TimeAxis } from "../../components/timeAxis";
import { useElementWidth } from "../../components/useElementWidth";
import { noteColourCss } from "./notesEdits";
import type { TakeSelection } from "./takeScreen";
import { PictureLane } from "./TakePicture";
import { parameterText, type ParameterLane, type TakeTimeline } from "./takeTimeline";

export interface TakeTimelineViewProps {
  readonly timeline: TakeTimeline;
  /** The playhead, take seconds. */
  readonly time: number;
  readonly playing: boolean;
  readonly selected: TakeSelection;
  readonly notes: TakeNotes;
  /** Notes can be edited (a writable project). */
  readonly notesWritable: boolean;
  /** A scrub: `done` on release. */
  onSeek(t: number, done: boolean): void;
  onSelectInstance(key: string): void;
  onOpenInstance(key: string): void;
  onSelectNote(id: string): void;
  /** A note dragged to `at` (a marker's time, a region's start); `done` on release. */
  onMoveNote(id: string, at: number, done: boolean): void;
  onAddMarker(at: number): void;
}

const CONTEXT = { rate: 48000 } as const;

export function TakeTimelineView(props: TakeTimelineViewProps) {
  const lane = useRef<HTMLDivElement>(null);
  const width = Math.max(0, useElementWidth(lane));
  const { timeline } = props;
  const duration = Math.max(0.001, timeline.duration);
  const axis = useMemo(() => linearTimeAxis(0, duration, width), [duration, width]);
  const view = { start: 0, end: duration };
  const selectedKey = props.selected?.kind === "instance" ? props.selected.key : null;
  return (
    <div class="tk-timeline">
      <div class="tk-row tk-ruler-row">
        <div class="tk-head">
          <span class="tk-head-name">Time</span>
        </div>
        <div class="tk-lane" ref={lane}>
          <TimeRuler view={view} format="timecode" context={CONTEXT} position={props.time} length={duration} label="Take time" onScrub={props.onSeek} />
        </div>
      </div>
      <div class="tk-rows">
        {timeline.frames.length > 0 && <PictureLane frames={timeline.frames} axis={axis} time={props.time} onSeek={props.onSeek} />}
        {timeline.lanes.map((l) => (
          <div class={`tk-row${l.instances.some((i) => i.key === selectedKey) ? " active" : ""}`} key={l.path}>
            <div class="tk-head" title={l.path}>
              <span class="tk-head-name">{l.label}</span>
              <span class="tk-head-sub">{l.instances.length === 1 ? "1 instance" : `${l.instances.length} instances`}</span>
            </div>
            <div class="tk-lane">
              <SpanLane spans={l.spans} toX={axis.toX} width={width} now={duration} label={`${l.label} instances`} selected={selectedKey} onSelect={props.onSelectInstance} onOpen={props.onOpenInstance} />
            </div>
          </div>
        ))}
        {timeline.parameters.map((p, i) => (
          <ParameterRow key={p.key} lane={p} axis={axis} time={props.time} series={((i % 8) + 1) as Series} />
        ))}
        <NotesRow {...props} axis={axis} />
        <div class="tk-playhead-layer">
          <Playhead t={props.time} view={view} playing={props.playing} label="Replay position" />
        </div>
      </div>
    </div>
  );
}

type Series = NonNullable<ValueLaneProps["series"]>;

function ParameterRow(props: { lane: ParameterLane; axis: TimeAxis; time: number; series: Series }) {
  const { lane, axis } = props;
  return (
    <div class="tk-row">
      <div class="tk-head" title={lane.path ?? "Global parameter"}>
        <span class="tk-head-name">{lane.label}</span>
        <span class="tk-head-sub">{parameterText(lane, props.time)}</span>
      </div>
      <div class="tk-lane">
        {lane.segments ? (
          <div class="tk-segments" role="group" aria-label={`${lane.label}: ${parameterText(lane, props.time)}`}>
            {lane.segments.map((s, i) => (
              <span key={i} class="tk-segment" style={{ left: `${axis.toX(s.from)}px`, width: `${Math.max(1, axis.toX(s.to) - axis.toX(s.from))}px` }} title={s.label}>
                {s.label}
              </span>
            ))}
          </div>
        ) : (
          <ValueLane points={lane.points} toX={axis.toX} width={axis.width} height={34} label={lane.label} interp="step" cursor={props.time} series={props.series} />
        )}
      </div>
    </div>
  );
}

function NotesRow(props: TakeTimelineViewProps & { axis: TimeAxis }) {
  const { axis, notes } = props;
  const drag = useRef<{ id: string; grab: number; last: number } | null>(null);
  const timeAt = (e: PointerEvent, el: HTMLElement) => axis.toTime(e.clientX - el.closest(".tk-lane")!.getBoundingClientRect().left);
  const selectedId = props.selected?.kind === "note" ? props.selected.id : null;
  // Every note's start, in time order (the keys step through them).
  const starts = [...notes.markers.map((m) => ({ id: m.id, at: m.at })), ...notes.regions.map((r) => ({ id: r.id, at: r.from }))].sort((a, b) => a.at - b.at);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const left = e.key === "ArrowLeft";
    const current = starts.find((n) => n.id === selectedId);
    if (!current) {
      const pick = left ? starts[starts.length - 1] : starts[0];
      if (!pick) return;
      e.preventDefault();
      props.onSelectNote(pick.id);
      return;
    }
    if (!props.notesWritable) return;
    e.preventDefault();
    props.onMoveNote(current.id, Math.max(0, current.at + (e.shiftKey ? 1 : 0.1) * (left ? -1 : 1)), true);
  };
  const grab = (id: string, start: number) => (e: PointerEvent) => {
    e.stopPropagation();
    props.onSelectNote(id);
    if (!props.notesWritable || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    drag.current = { id, grab: timeAt(e, el) - start, last: start };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    const el = e.currentTarget as HTMLElement;
    if (!d || !el.hasPointerCapture(e.pointerId)) return;
    const at = timeAt(e, el) - d.grab;
    if (Math.abs(at - d.last) < 1e-4) return;
    d.last = at;
    props.onMoveNote(d.id, at, false);
  };
  const up = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) props.onMoveNote(d.id, d.last, true);
  };
  return (
    <div class="tk-row tk-notes-row">
      <div class="tk-head">
        <span class="tk-head-name">Notes</span>
        <span class="tk-head-sub">{notes.markers.length + notes.regions.length + props.timeline.marks.length || "none"}</span>
      </div>
      <div
        class="tk-lane tk-notes"
        role="listbox"
        tabIndex={0}
        aria-label="Notes and game marks"
        aria-activedescendant={selectedId ? `tk-note-${selectedId}` : undefined}
        title={props.notesWritable ? "Double-click (or Add marker) to add a note marker; Left and Right move the selected note" : undefined}
        onKeyDown={onKey}
        onDblClick={(e) => {
          if (!props.notesWritable || e.target !== e.currentTarget) return;
          props.onAddMarker(axis.toTime(e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left));
        }}
      >
        {notes.regions.map((r) => (
          <div
            key={r.id}
            id={`tk-note-${r.id}`}
            role="option"
            aria-selected={r.id === selectedId}
            class={`tk-region${r.id === selectedId ? " selected" : ""}`}
            style={{ left: `${axis.toX(r.from)}px`, width: `${Math.max(3, axis.toX(r.to) - axis.toX(r.from))}px`, "--tk-note": noteColourCss(r.color) }}
            title={r.text || "Region"}
            onPointerDown={grab(r.id, r.from)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          >
            <span class="tk-note-text">{r.text}</span>
          </div>
        ))}
        {props.timeline.marks.map((m, i) => (
          <div key={`mark${i}`} class="tk-mark" style={{ left: `${axis.toX(m.t)}px` }} title={`Game mark: ${m.text}`} aria-hidden="true">
            <span class="tk-note-text">{m.text}</span>
          </div>
        ))}
        {notes.markers.map((m) => (
          <div
            key={m.id}
            id={`tk-note-${m.id}`}
            role="option"
            aria-selected={m.id === selectedId}
            class={`tk-marker${m.id === selectedId ? " selected" : ""}`}
            style={{ left: `${axis.toX(m.at)}px`, "--tk-note": noteColourCss(m.color) }}
            title={m.text || "Marker"}
            onPointerDown={grab(m.id, m.at)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          >
            <span class="tk-note-text">{m.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
