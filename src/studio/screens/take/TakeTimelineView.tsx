// The Take screen's timeline (ADR 0348 "The Take screen"; spec §4.5.4; the prototype's Take, with its fixed 32 s replaced
// by the take's real duration): the playhead ruler (its readout, second labels, the triangle; press and drag to scrub),
// the Gameplay take row (its name and length, and the take's FRAME pictures as a filmstrip), one instance lane per
// playlist path (how it plays, mute and solo in the replay, lifetimes with held parts up to the release, overlapping
// ones on one row until the lane's caret stacks them; click selects, Enter or a double-click opens the playlist), the game parameter lanes ("Game · Speed": the value at the playhead, what
// it drives, a line or labelled segments; hovering one outlines the Inspector cards it drives) and the notes lane (the game's marks, and the designer's note markers and regions: drag to move, a
// double-click adds a marker; focused, Left and Right pick a note when none is, then nudge it by 0.1 s, 1 s with Shift).
// The playhead is the replay's time. A view over props.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TakeNotes } from "../../../engine/audio/take/types";
import { Filmstrip } from "../../components/Filmstrip";
import { SpanLane } from "../../components/SpanLane";
import { packSpans } from "../../components/spanLaneModel";
import { ValueLane } from "../../components/ValueLane";
import { linearTimeAxis, type TimeAxis } from "../../components/timeAxis";
import { TimelineZoomStrip } from "../../components/TimelineZoomStrip";
import { useElementWidth } from "../../components/useElementWidth";
import { useTimelineView } from "../../components/useTimelineView";
import { recordingView } from "../../components/recordingView";
import { heatOfCounts } from "../../components/heatmapModel";
import { noteColourCss } from "./notesEdits";
import type { TakeSelection } from "./takeScreen";
import { RunPlayhead, RunRuler } from "../run/RunRuler";
import { secondsLabel } from "../run/runRulerModel";
import { parameterText, pathLabel, type ParameterLane, type TakeTimeline } from "./takeTimeline";

export interface TakeTimelineViewProps {
  readonly timeline: TakeTimeline;
  /** The take's name (the Gameplay take row). */
  readonly name?: string;
  /** The playhead, take seconds. */
  readonly time: number;
  readonly playing: boolean;
  readonly selected: TakeSelection;
  readonly notes: TakeNotes;
  /** Notes can be edited (a writable project). */
  readonly notesWritable: boolean;
  /** How a lane's playlist plays ("until stopped · Layer"); default: its instance count. */
  readonly plays?: (path: string) => string;
  /** What a game parameter drives ("Drives pitch on engine"); "" for nothing. */
  readonly drives?: (parameter: string) => string;
  /** Lanes muted and soloed (paths). */
  readonly muted?: ReadonlySet<string>;
  readonly soloed?: ReadonlySet<string>;
  onMute?(path: string, on: boolean): void;
  onSolo?(path: string, on: boolean): void;
  /** The game parameter under the pointer (here or in the Inspector), outlined in both. */
  readonly hovered?: string | null;
  onHover?(parameter: string | null): void;
  /** Experimental: colour each lane's instances by how often its playlist played in the take. */
  readonly heatmap?: boolean;
  /** A scrub: `done` on release. */
  /** The recording's path: the Profiler's timeline of the same file shows the same seconds. */
  readonly viewKey?: string | null;
  /** A picture on the Gameplay row clicked: show the game at `t` (default: seek). */
  onPicture?(t: number): void;
  onSeek(t: number, done: boolean): void;
  onSelectInstance(key: string): void;
  onOpenInstance(key: string): void;
  onSelectNote(id: string): void;
  /** A note dragged to `at` (a marker's time, a region's start); `done` on release. */
  onMoveNote(id: string, at: number, done: boolean): void;
  onAddMarker(at: number): void;
}

/** Placeholder tiles of the Gameplay take row when the take has no pictures. */
const TILES = 8;

export function TakeTimelineView(props: TakeTimelineViewProps) {
  const lane = useRef<HTMLDivElement>(null);
  // Lanes whose overlapping instances are stacked in rows; the rest draw them on one row, so the game parameter lanes
  // stay in view (journeys walk 2, V16).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const width = Math.max(0, useElementWidth(lane));
  const { timeline } = props;
  const duration = Math.max(0.001, timeline.duration);
  // The view: the whole take until zoomed (Ctrl/⌘ + wheel or pinch, Shift + wheel or a sideways swipe, the strip below).
  const zoom = useTimelineView(duration, props.viewKey ? recordingView(props.viewKey) : undefined);
  const { start, end } = zoom.view;
  const axis = useMemo(() => linearTimeAxis(start, end, width), [start, end, width]);
  // Replaying: page the view to keep the playhead in it.
  useEffect(() => {
    if (props.playing) zoom.follow(props.time);
  }, [props.time, props.playing]);
  const onWheel = (e: WheelEvent) => {
    const r = lane.current?.getBoundingClientRect();
    const x = r ? Math.min(Math.max(e.clientX - r.left, 0), r.width) : 0;
    if (zoom.wheel(e, axis.toTime(x), width)) e.preventDefault();
  };
  const selectedKey = props.selected?.kind === "instance" ? props.selected.key : null;
  const globals = timeline.parameters.filter((p) => p.path === null);
  const locals = timeline.parameters.filter((p) => p.path !== null);
  const heats = useMemo(() => (props.heatmap ? heatOfCounts(new Map(timeline.lanes.map((l) => [l.path, l.instances.length]))) : null), [props.heatmap, timeline]);
  return (
    <div class="tk-timeline" onWheel={onWheel}>
      <RunRuler duration={duration} view={zoom.view} time={props.time} label="Take time" onSeek={props.onSeek} />
      <div class="tk-rows">
        <div class="tk-row tk-gameplay-row">
          <div class="tk-head">
            <span class="tk-cap">Gameplay take</span>
            <span class="tk-head-meta">{props.name ? `${props.name} · ` : ""}{timeline.duration.toFixed(1)} s</span>
          </div>
          <div class="tk-lane tk-film" ref={lane}>
            {timeline.frames.length > 0 ? (
              <Filmstrip frames={timeline.frames} toX={axis.toX} time={props.time} onSeek={(t) => (props.onPicture ? props.onPicture(t) : props.onSeek(t, true))} />
            ) : (
              <div class="tk-tiles" title="This take has no pictures of the game view (a take recorded with pictures shows them here)">
                {Array.from({ length: TILES }, (_, i) => (
                  <span key={i} class="tk-tile">{secondsLabel(Math.round((duration / TILES) * i * 10) / 10)}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <SectionRow label="Playlist instances" />
        {timeline.lanes.map((l) => {
          const muted = !!props.muted?.has(l.path);
          const soloed = !!props.soloed?.has(l.path);
          const silent = muted || (!!props.soloed?.size && !soloed);
          const count = l.instances.length === 1 ? "1 instance" : `${l.instances.length} instances`;
          const stacks = packSpans(l.spans, duration).count > 1;
          const open = stacks && expanded.has(l.path);
          return (
            <div class={`tk-row tk-inst-row${l.instances.some((i) => i.key === selectedKey) ? " active" : ""}${silent ? " silent" : ""}`} key={l.path}>
              <div class="tk-head" title={`${l.path} · ${count}`}>
                <span class="tk-head-line">
                  {stacks ? (
                    <button
                      type="button"
                      class="tk-head-caret"
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${l.label} instances`}
                      title={open ? "Draw the overlapping instances on one row" : "Stack the overlapping instances in rows"}
                      onClick={() => setExpanded((was) => {
                        const next = new Set(was);
                        if (open) next.delete(l.path);
                        else next.add(l.path);
                        return next;
                      })}
                    >
                      {open ? "▾" : "▸"}
                    </button>
                  ) : null}
                  <span class="tk-head-name">{l.label}</span>
                  {props.onMute && (
                    <span class="tk-ms" role="group" aria-label={`${l.label} mute and solo`}>
                      <button type="button" class={`tk-ms-b m${muted ? " on" : ""}`} aria-pressed={muted} aria-label={`Mute ${l.label}`} title={`Mute ${l.label} in the replay`} onClick={() => props.onMute!(l.path, !muted)}>M</button>
                      <button type="button" class={`tk-ms-b s${soloed ? " on" : ""}`} aria-pressed={soloed} aria-label={`Solo ${l.label}`} title={`Hear only ${l.label} (and other soloed lanes) in the replay`} onClick={() => props.onSolo?.(l.path, !soloed)}>S</button>
                    </span>
                  )}
                </span>
                <span class="tk-head-sub">{props.plays?.(l.path) || count}</span>
              </div>
              <div class="tk-lane tk-inst-lane">
                <SpanLane spans={l.spans} toX={axis.toX} width={width} rowHeight={32} collapsed={!open} now={duration} label={`${l.label} instances`} heat={heats ? () => heats.get(l.path) ?? null : undefined} selected={selectedKey} onSelect={props.onSelectInstance} onOpen={props.onOpenInstance} />
              </div>
            </div>
          );
        })}
        {timeline.parameters.length > 0 && <SectionRow label="Game parameters" />}
        {[...globals, ...locals].map((p) => (
          <ParameterRow key={p.key} lane={p} axis={axis} time={props.time} drives={p.path === null ? (props.drives?.(p.name) ?? "") : ""} hovered={props.hovered === p.name && p.path === null} onHover={p.path === null ? props.onHover : undefined} />
        ))}
        <NotesRow {...props} axis={axis} />
        <div class="tk-playhead-layer">
          <RunPlayhead time={props.time} duration={duration} view={zoom.view} />
        </div>
      </div>
      <TimelineZoomStrip timeline={zoom} anchor={props.time} />
    </div>
  );
}

function SectionRow(props: { label: string }) {
  return (
    <div class="tk-row tk-section-row">
      <div class="tk-head">
        <span class="tk-cap">{props.label}</span>
      </div>
      <div class="tk-lane" />
    </div>
  );
}

function ParameterRow(props: { lane: ParameterLane; axis: TimeAxis; time: number; drives: string; hovered: boolean; onHover?(parameter: string | null): void }) {
  const { lane, axis } = props;
  const value = parameterText(lane, props.time);
  const cap = lane.path === null ? `Game · ${lane.name}` : `${pathLabel(lane.path)} · ${lane.name}`;
  return (
    <div class={`tk-row tk-param-row${props.hovered ? " linked" : ""}${lane.segments ? " labelled" : ""}`}>
      <div
        class="tk-head"
        title={lane.path === null ? `Game parameter ${lane.name}${props.drives ? `. ${props.drives}` : ""}` : `${lane.name} on ${lane.path}`}
        onMouseEnter={props.onHover ? () => props.onHover!(lane.name) : undefined}
        onMouseLeave={props.onHover ? () => props.onHover!(null) : undefined}
      >
        <span class="tk-cap tk-cap-game">{cap}</span>
        <span class="tk-param-value">{value}</span>
        {props.drives && <span class="tk-head-sub tk-drives">{props.drives}</span>}
      </div>
      <div class="tk-lane">
        {lane.segments ? (
          <div class="tk-segments" role="group" aria-label={`${lane.label}: ${value}`}>
            {lane.segments.map((s, i) => (
              <span key={i} class="tk-segment" style={{ left: `${axis.toX(s.from)}px`, width: `${Math.max(1, axis.toX(s.to) - axis.toX(s.from) - 2)}px` }} title={s.label}>
                {s.label}
              </span>
            ))}
          </div>
        ) : (
          <ValueLane points={lane.points} toX={axis.toX} width={axis.width} height={46} label={lane.label} interp={lane.path === null ? "linear" : "step"} cursor={props.time} />
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
