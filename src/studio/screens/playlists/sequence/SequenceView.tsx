// The Sequence view (ADR 0329; the prototype's Sequencer timeline, proto §1.5, §2.6, §3.3–3.5, §4): the toolbar
// (+ track, + Loop, + Hold, razor, Write, back to the parent playlist, waveforms, the time display, snap, tempo, zoom),
// the Loops and Markers rows and the ruler above the tracks, the track headers and clip lanes with their automation
// lanes, the scrollbar that zooms, and every gesture of the prototype: drops from the Library and the Playlists tree,
// moves, trims, splits, marquee, envelope points, loops, markers, the sequence's end, copy and paste, the keyboard.
// Each gesture is one labelled edit through `onEdit` (a drag previews locally and commits once on release); a refusal
// shows as a toast. The selection, playhead and modes live in `sequenceState.ts`, shared with the Inspector and the
// transport.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import type { PlaylistLint } from "../../../../engine/audio/playlist/lint";
import type { Clip, PlaylistBody, SequenceSettings } from "../../../../engine/audio/playlist/types";
import type { CurveInterp } from "../../../../engine/core/curve";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../../editor/ui/ContextMenu";
import type { PopoverPoint } from "../../../../editor/ui/popover";
import { accept, type EditResult } from "../../../../plugins/audio/editor/editResult";
import type { PeakMips } from "../../../../plugins/audio/editor/music/peaksMip";
import { Playhead } from "../../../components/Playhead";
import { TimeRuler } from "../../../components/TimeRuler";
import { formatTime, TIME_FORMATS, type TimeFormat } from "../../../components/timeRulerModel";
import { useElementWidth } from "../../../components/useElementWidth";
import { sampleFromDrag } from "../libraryModel";
import { playlistTitle } from "../playlistPaths";
import {
  addAutomation, addPoint, addVolumeEnvelope, deletePoints, isTimeInput, movePoints, ownerOf, setAutomation, setPointShape, SHAPES, targetSpec, targetSpecs, writeAutomation, type AutomationOwner,
} from "./automationEdits";
import { clipFollows } from "./clipGeometry";
import { CurveOverlay, yToValue } from "./CurveOverlay";
import { addLoop, addMarker, deleteLoops, deleteMarkers, makeHoldPoint, moveLoop, moveMarker, nudgeLoopsAndMarkers, renameMarker, setLoopEdge, setMarkerType } from "./loopMarkerEdits";
import { beginDrag } from "./pointerDrag";
import { openSequenceCurves } from "./openSequenceCurves";
import { copySelection, paste, pasteLabel } from "./sequenceClipboard";
import {
  addPlaylistClip, addSampleClip, addSampleOnNewTrack, addTrack, deleteClips, duplicateClips, duplicateTrack, makeAsync, moveClips, moveClipsToAdjacentTrack, moveTrack,
  newTrack, nudgeClipEdge, removeTracks, setClipLength, setMeter, setSequenceLength, setTempo, setTrack, splitClip, toggleClipsEnabled, trimClipStart, trimToPlayhead,
} from "./sequenceEdits";
import { beatSeconds, beatsPerBar, keepTaps, METERS, nudgeStep, SNAP_MENU, snapSpan, snapTime, tapTempo, type SnapMode } from "./sequenceGrid";
import { allClips, clipLength, findClip, onSequence, plural, sequenceLength, type BodyEdit, type SeqEdit, type SourceOf } from "./sequenceModel";
import { clickClip, clickPoint, EMPTY_SELECTION, marqueeSelect, pressClip, selectAll, selectLoop, selectMarker, selectTrack, type SeqSelection } from "./sequenceSelection";
import {
  bindSequence, playback, seqClipboard, seqOpenLanes, seqPlayhead, seqRazor, seqSelection, seqShownCurve, seqShowWave, seqSnap, seqTimeFormat, seqTransport, seqView, seqWrite, transportMessage,
} from "./sequenceState";
import { clipName, TimelineClip } from "./TimelineClip";
import { clampTimeline, fitTimeline, followView, HEADER_WIDTH, pxToTime, rowAt, scrollLimit, scrollTimeline, snapEdges, thumbOf, timeToPx, trackIndexAt, trackRows, viewFromThumb, zoomTimeline, zoomToSpan } from "./timelineLayout";
import { TrackHeader } from "./TrackHeader";
import "./sequence.css";

export interface SequenceViewProps {
  readonly body: PlaylistBody;
  readonly writable: boolean;
  /** The file the sequence lives in (playlist clips that contain it are refused). */
  readonly file: string | null;
  /** The sequence is embedded in another playlist of that file (it plays with its parent). */
  readonly embedded?: boolean;
  /** Distinguishes open sequences (the view's state resets when it changes). */
  readonly stateKey: string;
  readonly title: string;
  /** Where the body sits in its file, for matching lints. */
  readonly where: string;
  readonly lints: readonly PlaylistLint[];
  readonly sourceOf: SourceOf;
  peaksOf(path: string): PeakMips | null;
  loadPlaylist(path: string): PlaylistBody | null;
  readonly parameters: readonly ParameterDef[];
  readonly buses: readonly string[];
  /** The parent playlist, when the sequence is nested (the toolbar's link back). */
  readonly back?: { readonly name: string; open(): void };
  onEdit(label: string, edit: BodyEdit): void;
  /** A refusal or a hint, as a toast. */
  onNotify(text: string): void;
}

interface Draft {
  readonly seq: SequenceSettings;
}
interface Ghost {
  readonly ti: number | "new";
  readonly at: number;
  readonly length: number;
  readonly ok: boolean;
  readonly text: string;
}
interface Marquee {
  readonly t0: number;
  readonly t1: number;
  readonly r0: number;
  readonly r1: number;
}

/** A clip of `sample` to ask `sourceOf` about before it exists. */
const probeClip = (sample: string): Clip => ({ id: "", sample, at: 0, length: 0, offset: 0, gain: 0, pitch: 0, pan: 0, reverse: false, sync: false, enabled: true, loops: {}, hiddenMarkers: [], effects: [], automation: [] });
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, select, textarea, [contenteditable]");

export function SequenceView(props: SequenceViewProps) {
  const { writable, sourceOf } = props;
  const docSeq = props.body.sequence!;
  const [draft, setDraft] = useState<Draft | null>(null);
  const s = draft?.seq ?? docSeq;
  const sel = seqSelection.value;
  const playhead = seqPlayhead.value;
  const playing = playback.value;
  const snap = seqSnap.value;
  const length = sequenceLength(s, sourceOf);
  const limit = scrollLimit(length);
  const view = clampTimeline(seqView.value ?? fitTimeline(length), limit);
  const span = view.end - view.start;
  const lanesRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(lanesRef);
  const { rows, height } = trackRows(s, seqOpenLanes.value);
  const toPx = (t: number) => timeToPx(t, view, width);
  const toT = (px: number) => pxToTime(px, view, width);
  const dxToT = (dx: number) => (dx / Math.max(1, width)) * span;
  const [menu, setMenu] = useState<{ at: PopoverPoint; entries: MenuEntry[]; label: string } | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [hover, setHover] = useState<{ clip: string; x: number; y: number } | null>(null);
  const [razorAt, setRazorAt] = useState<number | null>(null);
  const [renamingMarker, setRenamingMarker] = useState<string | null>(null);
  const [taps, setTaps] = useState<number[]>([]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writing = useRef<{ owner: AutomationOwner; target: "volume" | "pan"; samples: [number, number][]; last: number } | null>(null);

  useEffect(() => {
    bindSequence(props.stateKey, { file: props.embedded ? null : props.file, title: props.title, seq: docSeq, plays: props.body.playback.plays, sourceOf });
  });

  // Follow the playhead while playing.
  useEffect(() => {
    if (playing && seqTransport.peek().follow) {
      const next = followView(view, playhead, limit);
      if (next !== view) seqView.value = next;
    }
  }, [playhead, !!playing]);

  // --- applying edits --------------------------------------------------------------------------------------------

  /** Run an edit as one undo step (refusals as a toast); `after` gets the edit's result (new ids to select). */
  function run<X>(label: string, edit: (s: SequenceSettings) => EditResult<X>, pick: (x: X) => SequenceSettings, after?: (x: X) => void): boolean {
    if (!writable) return false;
    const r = edit(docSeq);
    if ("refused" in r) {
      props.onNotify(`Can't ${lowerFirst(label)}: ${r.refused}.`);
      return false;
    }
    if (pick(r.next) !== docSeq) {
      props.onEdit(label, onSequence((cur) => {
        const r2 = edit(cur);
        return "refused" in r2 ? r2 : accept(pick(r2.next));
      }));
    }
    after?.(r.next);
    return true;
  }
  const runSeq = (label: string, edit: SeqEdit, after?: (x: SequenceSettings) => void) => run(label, edit, (x) => x, after);
  const runWith = <X extends { seq: SequenceSettings }>(label: string, edit: (s: SequenceSettings) => EditResult<X>, after?: (x: X) => void) => run(label, edit, (x) => x.seq, after);
  const select = (next: SeqSelection) => (seqSelection.value = next);

  // --- geometry from events ------------------------------------------------------------------------------------------

  const xIn = (e: { clientX: number }) => e.clientX - (lanesRef.current?.getBoundingClientRect().left ?? 0);
  const yIn = (e: { clientY: number }) => e.clientY - (rowsRef.current?.getBoundingClientRect().top ?? 0);
  const timeAt = (e: { clientX: number }) => Math.max(0, toT(xIn(e)));
  const ctxFor = (edges: number[], free = false) => ({ snap, tempo: s.tempo, span, edges, free: free || snap.mode === "off" && !snap.edges });
  const snapAt = (t: number, e?: { altKey?: boolean }, exclude: { clips?: string[]; loop?: string; marker?: string } = {}) =>
    snapTime(t, ctxFor(snapEdges(docSeq, sourceOf, length, { exclude: exclude.clips, excludeLoop: exclude.loop, excludeMarker: exclude.marker, playhead }), !!e?.altKey));
  const focusRoot = () => rootRef.current?.focus({ preventScroll: true });

  // --- clips -----------------------------------------------------------------------------------------------------------

  const pressOnClip = (e: PointerEvent, clipId: string, part: "body" | "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    focusRoot();
    setHover(null);
    const f = findClip(docSeq, clipId);
    if (!f) return;
    const trackId = f.track.id;
    if (seqRazor.peek() && part === "body") {
      const t = snapAt(timeAt(e), e);
      runSeq("Split clip", (x) => splitClip(x, clipId, t, sourceOf));
      return;
    }
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    const next = pressClip(sel, clipId, trackId, mods);
    select(next);
    if (!writable) return;
    const len = clipLength(f.clip, sourceOf(f.clip));
    let cur: { label: string; edit: SeqEdit } | null = null;
    beginDrag(e, {
      move: (dx, _dy, ev) => {
        const dt = dxToT(dx);
        const free = ev.altKey;
        if (part === "body") {
          const ids = next.clips.includes(clipId) ? [...next.clips] : [clipId];
          const edges = snapEdges(docSeq, sourceOf, length, { exclude: ids, playhead });
          const at = snapSpan(f.clip.at + dt, len, ctxFor(edges, free));
          const delta = trackIndexAt(rows, yIn(ev)) - f.ti;
          const moved = moveClips(docSeq, ids, at - f.clip.at, delta);
          const changedTrack = "next" in moved && findClip(moved.next, clipId)?.ti !== f.ti;
          cur = { label: changedTrack ? "Move clip to track" : `Move ${plural(ids.length, "clip")}`, edit: (x) => moveClips(x, ids, at - f.clip.at, delta) };
        } else if (part === "start") {
          const t = snapAt(f.clip.at + dt, ev, { clips: [clipId] });
          cur = { label: "Trim clip start", edit: (x) => trimClipStart(x, clipId, t, sourceOf) };
        } else {
          const t = snapAt(f.clip.at + len + dt, ev, { clips: [clipId] });
          cur = { label: "Set clip length", edit: (x) => setClipLength(x, clipId, t - f.clip.at) };
        }
        const r = cur.edit(docSeq);
        if ("next" in r) setDraft({ seq: r.next });
      },
      up: (dragged) => {
        setDraft(null);
        if (dragged && cur) runSeq(cur.label, cur.edit);
        else if (!dragged && part === "body" && !mods.shift && !mods.ctrl) select(clickClip(next, clipId, trackId));
      },
    });
  };

  /** The curve a clip shows: the chosen one, else its first time curve. */
  const shownCurve = (clipId: string) => {
    const f = findClip(s, clipId);
    if (!f) return null;
    const id = seqShownCurve.value[clipId];
    const a = f.clip.automation.find((x) => x.id === id && isTimeInput(x.input)) ?? f.clip.automation.find((x) => isTimeInput(x.input));
    if (!a) return null;
    const spec = targetSpec(a.target, f.clip.effects);
    return spec ? { automation: a, spec } : null;
  };

  const dblClickClip = (e: MouseEvent, clipId: string) => {
    if (seqRazor.peek()) return;
    const f = findClip(docSeq, clipId);
    if (!f) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const len = clipLength(f.clip, sourceOf(f.clip));
    const x = Math.max(0, Math.min(len, ((e.clientX - box.left) / Math.max(1, box.width)) * len));
    const shown = shownCurve(clipId);
    if (shown) {
      const y = yToValue(e.clientY - box.top, shown.spec, box.height);
      runWith("Add automation point", (q) => addPoint(q, { clip: clipId }, shown.automation.id, x, y), (r) => select(clickPoint(EMPTY_SELECTION, { clip: clipId }, shown.automation.id, r.index)));
    } else {
      const y = yToValue(e.clientY - box.top, targetSpec("volume", [])!, box.height);
      runWith("Add volume envelope", (q) => addVolumeEnvelope(q, clipId, x, y, len), (r) => (seqShownCurve.value = { ...seqShownCurve.peek(), [clipId]: r.id }));
    }
  };

  /** Points of a lane: press selects, drag moves (snapped in time), all as one step. */
  const pressPoint = (e: PointerEvent, owner: AutomationOwner, automation: string, index: number, laneHeight: number) => {
    if (e.button !== 0) return;
    focusRoot();
    const next = clickPoint(sel, owner, automation, index, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    select(next);
    if (!writable || !next.points) return;
    const lane = ownerOf(docSeq, owner)?.automation.find((a) => a.id === automation);
    const spec = lane ? targetSpec(lane.target, ownerOf(docSeq, owner)!.effects) : null;
    if (!lane || !spec) return;
    const keys = [...next.points.keys];
    const origin = "clip" in owner ? (findClip(docSeq, owner.clip)?.clip.at ?? 0) : 0;
    let cur: SeqEdit | null = null;
    beginDrag(e, {
      move: (dx, dy, ev) => {
        const k = lane.curve[index]!;
        const x = ev.altKey ? k[0] + dxToT(dx) : snapAt(origin + k[0] + dxToT(dx), ev) - origin;
        const dv = spec.bool ? (dy < -laneHeight / 4 ? 1 : dy > laneHeight / 4 ? -1 : 0) : (-dy / Math.max(1, laneHeight - 8)) * (spec.max - spec.min);
        cur = (q) => movePoints(q, owner, automation, keys, x - k[0], dv);
        const r = cur(docSeq);
        if ("next" in r) setDraft({ seq: r.next });
      },
      up: (dragged) => {
        setDraft(null);
        if (dragged && cur) runSeq(keys.length > 1 ? "Move automation points" : "Move automation point", cur);
      },
    });
  };

  const pointMenu = (e: MouseEvent, owner: AutomationOwner, automation: string, index: number, title: string, curveLength: number) => {
    const keys = sel.points && sel.points.automation === automation && sel.points.keys.includes(index) ? sel.points.keys : [index];
    if (!(sel.points?.keys.includes(index))) select(clickPoint(sel, owner, automation, index));
    const shape = (sh: CurveInterp, label: string) => ({ id: sh, label, disabled: !writable, run: () => runSeq(`Curve shape: ${label}`, (q) => setPointShape(q, owner, automation, keys, sh)) });
    setMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Point",
      entries: [
        ...SHAPES.map((x) => shape(x.shape, x.label)),
        SEPARATOR,
        { id: "curves", label: "Open in curve editor…", run: () => openCurves(owner, curveLength, title) },
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => (seqClipboard.value = copySelection(docSeq, clickPoint(EMPTY_SELECTION, owner, automation, index))) },
        { id: "delete", label: keys.length > 1 ? "Delete points" : "Delete", danger: true, disabled: !writable, run: () => runSeq(keys.length > 1 ? "Delete automation points" : "Delete automation point", (q) => deletePoints(q, owner, automation, keys)) },
      ],
    });
  };

  const openCurves = (owner: AutomationOwner, curveLength: number, title: string, lane?: string) =>
    openSequenceCurves({
      doc: rootRef.current?.ownerDocument ?? document, seq: docSeq, owner, length: curveLength, name: title, context: props.title, parameters: props.parameters, lane,
      playhead: "clip" in owner ? Math.max(0, playhead - (findClip(docSeq, owner.clip)?.clip.at ?? 0)) : playhead,
      commit: (label, edit) => runSeq(label, edit),
    });

  const automateMenu = (owner: AutomationOwner, curveLength: number, title: string): MenuEntry[] => {
    const v = ownerOf(docSeq, owner);
    if (!v) return [];
    return targetSpecs(v.effects).map((t) => ({
      id: `auto-${t.target}`,
      label: `Automate ${t.name}`,
      disabled: !writable || v.automation.some((a) => a.target === t.target),
      run: () => runWith(`Automate ${t.name}`, (q) => addAutomation(q, owner, t.target, curveLength), (r) => {
        if ("track" in owner) seqOpenLanes.value = new Set([...seqOpenLanes.peek(), owner.track]);
        else seqShownCurve.value = { ...seqShownCurve.peek(), [owner.clip]: r.id };
      }),
    })).concat([SEPARATOR as never, { id: "curves", label: "Edit curves…", run: () => openCurves(owner, curveLength, title) } as never]);
  };

  const clipMenu = (e: MouseEvent, clipId: string) => {
    const f = findClip(docSeq, clipId);
    if (!f) return;
    const ids = sel.clips.includes(clipId) ? [...sel.clips] : [clipId];
    if (!sel.clips.includes(clipId)) select(clickClip(sel, clipId, f.track.id));
    const t = snapAt(timeAt(e), e);
    const len = clipLength(f.clip, sourceOf(f.clip));
    const follows = clipFollows(props.lints, `${props.where ? `${props.where}.` : ""}sequence.tracks[${f.ti}]`, f.track, f.clip);
    setMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Clip",
      entries: [
        { id: "split", label: "Split here", hint: "C", disabled: !writable, run: () => runSeq("Split clip", (q) => splitClip(q, clipId, t, sourceOf)) },
        { id: "env", label: "Add volume envelope", disabled: !writable || f.clip.automation.some((a) => a.target === "volume"), run: () => runWith("Add volume envelope", (q) => addVolumeEnvelope(q, clipId, len / 2, 0, len)) },
        ...automateMenu({ clip: clipId }, len, clipName(f.clip)),
        SEPARATOR,
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => (seqClipboard.value = copySelection(docSeq, { ...sel, focus: "clips", clips: ids })) },
        { id: "dup", label: ids.length > 1 ? "Duplicate clips" : "Duplicate clip", hint: "Ctrl+D", disabled: !writable, run: () => duplicate(ids) },
        { id: "en", label: f.clip.enabled ? "Disable" : "Enable", hint: "E", disabled: !writable, run: () => toggleEnabled(ids) },
        ...(follows ? [{ id: "async", label: "Make Async", title: "Let this clip loop on its own clock instead of following the higher track", disabled: !writable, run: () => runSeq("Clip async", (q) => makeAsync(q, clipId)) }] : []),
        SEPARATOR,
        { id: "del", label: ids.length > 1 ? "Delete clips" : "Delete clip", hint: "Del", danger: true, disabled: !writable, run: () => removeClips(ids) },
      ],
    });
  };

  const duplicate = (ids: readonly string[]) =>
    runWith(ids.length > 1 ? "Duplicate clips" : "Duplicate clip", (q) => {
      const r = duplicateClips(q, ids, sourceOf);
      return "refused" in r ? r : accept({ seq: r.next.seq, ids: r.next.ids });
    }, (r) => select({ ...EMPTY_SELECTION, focus: "clips", clips: r.ids, track: sel.track }));

  const toggleEnabled = (ids: readonly string[]) => {
    const r = toggleClipsEnabled(docSeq, ids);
    const label = "refused" in r ? "Disable clip" : `${r.next.enabled ? "Enable" : "Disable"} ${plural(ids.length, "clip")}`;
    runWith(label, (q) => {
      const x = toggleClipsEnabled(q, ids);
      return "refused" in x ? x : accept({ seq: x.next.seq });
    });
  };

  const removeClips = (ids: readonly string[]) => {
    if (runSeq(ids.length > 1 ? "Delete clips" : "Delete clip", (q) => deleteClips(q, ids))) {
      select({ ...EMPTY_SELECTION, track: sel.track });
      props.onNotify(`Deleted ${plural(ids.length, "clip")} (Ctrl+Z to undo).`);
    }
  };

  const hoverClip = (e: PointerEvent | null, clipId: string) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (!e) return setHover(null);
    const x = e.clientX, y = e.clientY;
    hoverTimer.current = setTimeout(() => setHover({ clip: clipId, x, y }), 450);
  };

  // --- empty lane: marquee, focus, playhead ------------------------------------------------------------------------

  const pressLane = (e: PointerEvent, ti: number) => {
    if (e.button !== 0) return;
    focusRoot();
    const t0 = timeAt(e);
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    beginDrag(e, {
      move: (_dx, _dy, ev) => setMarquee({ t0, t1: timeAt(ev), r0: ti, r1: trackIndexAt(rows, yIn(ev)) }),
      up: (dragged, ev) => {
        setMarquee(null);
        if (dragged) select(marqueeSelect(docSeq, sourceOf, sel, t0, timeAt(ev), ti, trackIndexAt(rows, yIn(ev)), add));
        else {
          select({ ...EMPTY_SELECTION, track: s.tracks[ti]?.id ?? null });
          if (!playback.peek()) seqPlayhead.value = snapAt(t0, ev);
        }
      },
    });
  };

  // --- lanes (track automation) --------------------------------------------------------------------------------------

  const dblClickLane = (e: MouseEvent, trackId: string, automation: string) => {
    const t = s.tracks.find((x) => x.id === trackId);
    const a = t?.automation.find((x) => x.id === automation);
    if (!t || !a || !isTimeInput(a.input)) return;
    const spec = targetSpec(a.target, t.effects);
    if (!spec) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = snapAt(timeAt(e), e);
    runWith("Add automation point", (q) => addPoint(q, { track: trackId }, automation, x, yToValue(e.clientY - box.top, spec, box.height)), (r) => select(clickPoint(EMPTY_SELECTION, { track: trackId }, automation, r.index)));
  };

  // --- Loops row, Markers row, end handle ----------------------------------------------------------------------------

  const pressLoopsRow = (e: PointerEvent) => {
    if (e.button !== 0 || !writable) return;
    const a = snapAt(timeAt(e), e);
    let b = a;
    beginDrag(e, {
      move: (_dx, _dy, ev) => {
        b = snapAt(timeAt(ev), ev);
        const r = addLoop(docSeq, a, b);
        if ("next" in r) setDraft({ seq: r.next.seq });
      },
      up: (dragged) => {
        setDraft(null);
        if (dragged && Math.abs(b - a) > 1e-6) runWith("Add loop", (q) => addLoop(q, a, b), (r) => select(selectLoop(sel, r.id)));
      },
    });
  };

  const pressLoop = (e: PointerEvent, id: string, part: "body" | "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    focusRoot();
    select(selectLoop(sel, id));
    const l = docSeq.loops.find((x) => x.id === id);
    if (!l || !writable) return;
    let cur: { label: string; edit: SeqEdit } | null = null;
    beginDrag(e, {
      move: (dx, _dy, ev) => {
        const dt = dxToT(dx);
        if (part === "body") {
          const start = snapAt(l.start + dt, ev, { loop: id });
          cur = { label: "Move loop", edit: (q) => moveLoop(q, id, start - l.start) };
        } else {
          const t = snapAt((part === "start" ? l.start : l.end) + dt, ev, { loop: id });
          cur = { label: "Resize loop", edit: (q) => setLoopEdge(q, id, part, t) };
        }
        const r = cur.edit(docSeq);
        if ("next" in r) setDraft({ seq: r.next });
      },
      up: (dragged) => {
        setDraft(null);
        if (dragged && cur) runSeq(cur.label, cur.edit);
      },
    });
  };

  const loopMenu = (e: MouseEvent, id: string) => {
    const l = docSeq.loops.find((x) => x.id === id);
    if (!l) return;
    select(selectLoop(sel, id));
    setMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Loop",
      entries: [
        { id: "hold", label: "Make hold point", disabled: !writable || l.start === l.end, run: () => runSeq("Make hold point", (q) => makeHoldPoint(q, id)) },
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => (seqClipboard.value = copySelection(docSeq, selectLoop(EMPTY_SELECTION, id))) },
        SEPARATOR,
        { id: "del", label: l.start === l.end ? "Delete hold point" : "Delete loop", danger: true, disabled: !writable, run: () => runSeq("Delete loop", (q) => deleteLoops(q, [id])) },
      ],
    });
  };

  const pressMarker = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    focusRoot();
    select(selectMarker(sel, id));
    const m = docSeq.markers.find((x) => x.id === id);
    if (!m || !writable) return;
    let at = m.at;
    beginDrag(e, {
      move: (dx, _dy, ev) => {
        at = snapAt(m.at + dxToT(dx), ev, { marker: id });
        const r = moveMarker(docSeq, id, at);
        if ("next" in r) setDraft({ seq: r.next });
      },
      up: (dragged) => {
        setDraft(null);
        if (dragged) runSeq("Move marker", (q) => moveMarker(q, id, at));
      },
    });
  };

  const markerMenu = (e: MouseEvent, id: string) => {
    const m = docSeq.markers.find((x) => x.id === id);
    if (!m) return;
    select(selectMarker(sel, id));
    const type = (t: "note" | "cue" | "exit", label: string) => ({ id: t, label: `${(m.type ?? "note") === t ? "✓ " : ""}${label}`, disabled: !writable, run: () => runSeq("Marker type", (q) => setMarkerType(q, id, t)) });
    setMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Marker",
      entries: [
        { id: "rename", label: "Rename", hint: "F2", disabled: !writable, run: () => setRenamingMarker(id) },
        type("note", "Note"), type("cue", "Cue (reported to the game)"), type("exit", "Exit (music may leave here)"),
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => (seqClipboard.value = copySelection(docSeq, selectMarker(EMPTY_SELECTION, id))) },
        SEPARATOR,
        { id: "del", label: "Delete marker", danger: true, disabled: !writable, run: () => runSeq("Delete marker", (q) => deleteMarkers(q, [id])) },
      ],
    });
  };

  const pressEnd = (e: PointerEvent) => {
    if (e.button !== 0 || !writable) return;
    e.stopPropagation();
    let to = length;
    beginDrag(e, {
      move: (dx, _dy, ev) => {
        to = Math.max(0.1, snapAt(length + dxToT(dx), ev));
        const r = setSequenceLength(docSeq, to);
        if ("next" in r) setDraft({ seq: r.next });
      },
      up: (dragged) => {
        setDraft(null);
        if (dragged) runSeq("Sequence length", (q) => setSequenceLength(q, to));
      },
    });
  };

  // --- tracks ----------------------------------------------------------------------------------------------------------

  const trackMenu = (e: MouseEvent, trackId: string) => {
    const ti = s.tracks.findIndex((t) => t.id === trackId);
    const t = s.tracks[ti];
    if (!t) return;
    select(selectTrack(trackId));
    setMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Track",
      entries: [
        ...automateMenu({ track: trackId }, length, t.name),
        SEPARATOR,
        { id: "dup", label: "Duplicate track", disabled: !writable, run: () => runSeq("Duplicate track", (q) => duplicateTrack(q, trackId)) },
        { id: "up", label: "Move up", disabled: !writable || ti === 0, run: () => runSeq("Reorder tracks", (q) => moveTrack(q, trackId, ti - 1)) },
        { id: "down", label: "Move down", disabled: !writable || ti === s.tracks.length - 1, run: () => runSeq("Reorder tracks", (q) => moveTrack(q, trackId, ti + 1)) },
        SEPARATOR,
        { id: "del", label: "Delete track", danger: true, disabled: !writable, run: () => { if (runSeq("Delete track", (q) => removeTracks(q, [trackId]))) props.onNotify(`Deleted ${t.name} (Ctrl+Z to undo).`); } },
      ],
    });
  };

  /** Track sliders: preview while moving, one step on release; with Write armed during playback, touch-write automation. */
  const onSlider = (trackId: string, field: "volume" | "pan", phase: "start" | "input" | "end", value: number) => {
    const writeNow = seqWrite.peek() && !!playback.peek();
    const label = field === "volume" ? "Volume" : "Pan";
    if (phase === "start") {
      writing.current = writeNow ? { owner: { track: trackId }, target: field, samples: [[seqPlayhead.peek(), value]], last: performance.now() } : null;
      return;
    }
    const w = writing.current;
    if (w) {
      w.samples.push([seqPlayhead.peek(), value]);
      if (phase === "end") {
        writing.current = null;
        runWith(`Write ${label} automation`, (q) => writeAutomation(q, w.owner, w.target, w.samples), () => (seqOpenLanes.value = new Set([...seqOpenLanes.peek(), trackId])));
      }
      return;
    }
    const patch = field === "volume" ? { volume: value } : { pan: value };
    if (phase === "input") {
      const r = setTrack(docSeq, trackId, patch);
      if ("next" in r) setDraft({ seq: r.next });
    } else {
      setDraft(null);
      runSeq(field === "volume" ? "Track volume" : "Track pan", (q) => setTrack(q, trackId, patch));
    }
  };

  // --- drops: Library samples (HTML drag) and Playlists tree rows (pointer drag) -----------------------------------

  const hitFor = (e: { clientX: number; clientY: number }, length0: number): Ghost => {
    const at = snapSpan(timeAt(e), length0, ctxFor(snapEdges(docSeq, sourceOf, length, { playhead })));
    const h = rowAt(rows, yIn(e));
    if (h.kind === "below") return { ti: "new", at, length: length0, ok: true, text: "New track" };
    return { ti: h.ti, at, length: length0, ok: true, text: "" };
  };

  const onDragOver = (e: DragEvent) => {
    if (!writable || ![...(e.dataTransfer?.types ?? [])].includes("text/plain")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const g = hitFor(e, 1);
    const t = g.ti === "new" ? null : s.tracks[g.ti];
    setGhost(t && t.kind === "playlist" ? { ...g, ok: false, text: "Playlist tracks take a playlist, not samples" } : { ...g, text: g.ti === "new" ? "New audio track" : "Add clip" });
  };

  const onDrop = (e: DragEvent) => {
    setGhost(null);
    const sample = sampleFromDrag(e.dataTransfer?.getData("text/plain"));
    if (!sample || !writable) return;
    e.preventDefault();
    const src = sourceOf(probeClip(sample));
    const g = hitFor(e, src?.length ?? 1);
    if (g.ti === "new") {
      runSeq("Add clip", (q) => addSampleOnNewTrack(q, sample, g.at, src), (x) => {
        const t = x.tracks[x.tracks.length - 1]!;
        select(clickClip(EMPTY_SELECTION, t.clips[0]!.id, t.id));
      });
      return;
    }
    const ti = g.ti;
    const t = docSeq.tracks[ti]!;
    if (t.kind === "playlist") return props.onNotify("Playlist tracks take a playlist, not samples");
    runSeq("Add clip", (q) => addSampleClip(q, t.id, sample, g.at, src), (x) => {
      const nt = x.tracks[ti]!;
      select(clickClip(EMPTY_SELECTION, nt.clips[nt.clips.length - 1]!.id, nt.id));
    });
  };

  // The Playlists tree drags rows with the pointer (not HTML drag): watch its presses, show a ghost over the lanes,
  // and add a playlist clip on release here.
  const latest = useRef({ docSeq, rows, writable, run, hitFor, props });
  latest.current = { docSeq, rows, writable, run, hitFor, props };
  useEffect(() => {
    const doc = rootRef.current?.ownerDocument ?? document;
    const down = (e: PointerEvent) => {
      const row = (e.target as Element | null)?.closest?.("[data-pl-key]") as HTMLElement | null;
      const key = row?.dataset.plKey ?? "";
      if (!key.startsWith("p:") || e.button !== 0 || !latest.current.writable) return;
      const path = key.slice(2);
      const over = (ev: PointerEvent) => {
        const r = rowsRef.current?.getBoundingClientRect();
        return !!r && ev.clientX >= r.left + HEADER_WIDTH && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      };
      const move = (ev: PointerEvent) => {
        if (!over(ev)) return setGhost(null);
        const g = latest.current.hitFor(ev, 2);
        const t = g.ti === "new" ? null : latest.current.docSeq.tracks[g.ti];
        setGhost(t && t.kind === "audio" ? { ...g, ok: false, text: "Audio tracks take samples; drop playlists on a Playlist track" } : { ...g, text: g.ti === "new" ? "New playlist track" : "Add playlist clip" });
      };
      const up = (ev: PointerEvent) => {
        doc.removeEventListener("pointermove", move);
        doc.removeEventListener("pointerup", up);
        setGhost(null);
        if (!over(ev)) return;
        const g = latest.current.hitFor(ev, 2);
        const self = latest.current.props.file ?? "";
        if (g.ti === "new") {
          latest.current.run("Add playlist clip", (q) => {
            const t = newTrack(q, "playlist", playlistTitle(path));
            return addPlaylistClip({ ...q, tracks: [...q.tracks, t] }, t.id, path, g.at, self, latest.current.props.loadPlaylist);
          }, (x) => x);
          return;
        }
        const t = latest.current.docSeq.tracks[g.ti]!;
        if (t.kind !== "playlist") return latest.current.props.onNotify("Audio tracks take samples; drop playlists on a Playlist track");
        if (!latest.current.run(`Add playlist clip`, (q) => addPlaylistClip(q, t.id, path, g.at, self, latest.current.props.loadPlaylist), (x) => x)) return;
      };
      doc.addEventListener("pointermove", move);
      doc.addEventListener("pointerup", up);
    };
    doc.addEventListener("pointerdown", down, true);
    return () => doc.removeEventListener("pointerdown", down, true);
  }, []);

  // --- toolbar actions ---------------------------------------------------------------------------------------------

  const addTrackOf = (kind: "audio" | "playlist") => runSeq(kind === "audio" ? "Add audio track" : "Add playlist track", (q) => addTrack(q, kind), (x) => select(selectTrack(x.tracks[x.tracks.length - 1]!.id)));
  const addLoopAtPlayhead = (hold: boolean) => {
    const a = playhead;
    const b = hold ? a : a + beatSeconds(s.tempo) * beatsPerBar(s.tempo);
    runWith(hold ? "Add hold point" : "Add loop", (q) => addLoop(q, a, b), (r) => select(selectLoop(sel, r.id)));
  };
  const zoom = (factor: number) => (seqView.value = zoomTimeline(view, factor, playing || (playhead >= view.start && playhead <= view.end) ? playhead : (view.start + view.end) / 2, limit));
  const fit = () => (seqView.value = null);
  const zoomSel = () => {
    const picked = allClips(s).filter((c) => sel.clips.includes(c.clip.id));
    if (!picked.length) return fit();
    seqView.value = zoomToSpan(Math.min(...picked.map((p) => p.clip.at)), Math.max(...picked.map((p) => p.clip.at + clipLength(p.clip, sourceOf(p.clip)))), limit);
  };

  // --- keyboard ----------------------------------------------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const step = nudgeStep(snap, s.tempo) * (e.shiftKey ? 10 : 1);
    const handled = (() => {
      if (mod && key.toLowerCase() === "a") return select(selectAll(docSeq, sel)), true;
      if (mod && key.toLowerCase() === "c") {
        const c = copySelection(docSeq, sel);
        if (c) seqClipboard.value = c;
        return true;
      }
      if (mod && key.toLowerCase() === "v") {
        const c = seqClipboard.peek();
        if (!c) return true;
        const lane = sel.points ? { owner: sel.points.owner, automation: sel.points.automation } : null;
        runWith(pasteLabel(c), (q) => paste(q, c, { playhead, track: sel.track ?? (sel.clips[0] ? findClip(docSeq, sel.clips[0])?.track.id ?? null : null), lane }), (r) => {
          if (r.clips.length) select({ ...EMPTY_SELECTION, focus: "clips", clips: r.clips, track: sel.track });
          else if (r.loop) select(selectLoop(sel, r.loop));
          else if (r.marker) select(selectMarker(sel, r.marker));
        });
        return true;
      }
      if (mod && key.toLowerCase() === "d") return sel.clips.length ? (duplicate(sel.clips), true) : false;
      if (mod) return false;
      if (key === "Delete" || key === "Backspace") {
        if (sel.focus === "points" && sel.points) runSeq(sel.points.keys.length > 1 ? "Delete automation points" : "Delete automation point", (q) => deletePoints(q, sel.points!.owner, sel.points!.automation, sel.points!.keys));
        else if (sel.focus === "loop" && sel.loop) runSeq("Delete loop", (q) => deleteLoops(q, [sel.loop!]));
        else if (sel.focus === "marker" && sel.marker) runSeq("Delete marker", (q) => deleteMarkers(q, [sel.marker!]));
        else if (sel.clips.length) removeClips(sel.clips);
        else return false;
        return true;
      }
      if (key === "Escape") {
        if (seqRazor.peek()) seqRazor.value = false;
        else select({ ...EMPTY_SELECTION, track: sel.track });
        return true;
      }
      if (key.toLowerCase() === "c" && !e.altKey) return (seqRazor.value = !seqRazor.peek()), true;
      if (key.toLowerCase() === "w" && !e.altKey) return (seqWrite.value = !seqWrite.peek()), true;
      if (key.toLowerCase() === "e" && sel.clips.length) return toggleEnabled(sel.clips), true;
      if (key === "F2" && sel.focus === "marker" && sel.marker) return setRenamingMarker(sel.marker), true;
      if (key === "[" && sel.clips.length === 1) return runSeq("Trim start to playhead", (q) => trimToPlayhead(q, sel.clips[0]!, playhead, "start", sourceOf)), true;
      if (key === "]" && sel.clips.length === 1) return runSeq("Trim end to playhead", (q) => trimToPlayhead(q, sel.clips[0]!, playhead, "end", sourceOf)), true;
      if (key === "=" || key === "+") return zoom(1.5), true;
      if (key === "-") return zoom(1 / 1.5), true;
      if (key === "0") return fit(), true;
      if (key.toLowerCase() === "z") return zoomSel(), true;
      if (key === "ArrowLeft" || key === "ArrowRight") {
        const dir = key === "ArrowLeft" ? -1 : 1;
        if (e.altKey && sel.clips.length) {
          const edge = e.shiftKey ? "start" : "end";
          const one = nudgeStep(snap, s.tempo);
          runSeq(edge === "start" ? "Trim clip start" : "Set clip length", (q) => nudgeClipEdge(q, sel.clips, edge, dir * one, sourceOf));
        } else if (sel.focus === "clips" && sel.clips.length) runSeq("Nudge", (q) => moveClips(q, sel.clips, dir * step));
        else if (sel.focus === "loop" && sel.loop) runSeq("Nudge", (q) => nudgeLoopsAndMarkers(q, [sel.loop!], [], dir * step));
        else if (sel.focus === "marker" && sel.marker) runSeq("Nudge", (q) => nudgeLoopsAndMarkers(q, [], [sel.marker!], dir * step));
        else if (!playback.peek()) seqPlayhead.value = Math.max(0, playhead + dir * step);
        return true;
      }
      if ((key === "ArrowUp" || key === "ArrowDown") && sel.clips.length) return runSeq("Move clip to track", (q) => moveClipsToAdjacentTrack(q, sel.clips, key === "ArrowUp" ? -1 : 1)), true;
      return false;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // --- drawing -------------------------------------------------------------------------------------------------------

  const rate = 48000;
  const timeCtx = { rate, bpm: s.tempo?.bpm ?? null, meter: s.tempo?.meter ?? null };
  const format = seqTimeFormat.value;
  const thumb = thumbOf(view, limit);
  const lintPrefix = props.where ? `${props.where}.` : "";
  const hoverClipAt = hover ? findClip(s, hover.clip) : null;
  const shownTrackLane = (trackId: string, automation: string) => sel.points && "track" in sel.points.owner && sel.points.owner.track === trackId && sel.points.automation === automation ? sel.points.keys : [];
  const endX = toPx(length);
  const visible = (a: number, b: number) => b >= view.start && a <= view.end;

  return (
    <div class={`sq-view${seqRazor.value ? " razor-mode" : ""}`} ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Sequence ${props.title}`}>
      <Toolbar
        s={s}
        writable={writable}
        playhead={playhead}
        format={format}
        timeText={formatTime(playhead, format, timeCtx)}
        back={props.back}
        taps={taps}
        onAddTrack={addTrackOf}
        onAddLoop={() => addLoopAtPlayhead(false)}
        onAddHold={() => addLoopAtPlayhead(true)}
        onTempo={(bpm) => runSeq(bpm === null ? "No tempo" : "Tempo", (q) => setTempo(q, bpm))}
        onTap={() => {
          const next = keepTaps(taps, performance.now());
          setTaps(next);
          const bpm = tapTempo(next);
          if (bpm !== null) runSeq("Tap tempo", (q) => setTempo(q, bpm));
        }}
        onMeter={(m) => runSeq("Meter", (q) => setMeter(q, m))}
        onZoom={zoom}
        onFit={fit}
      />
      {transportMessage.value && <p class="sq-message" role="status">{transportMessage.value}</p>}
      <div class="sq-top">
        <div class="sq-top-head">
          <span class="sq-row-label">Loops</span>
          <span class="sq-row-label">Markers</span>
          <span class="sq-row-label sq-ruler-label">{TIME_FORMATS.find((f) => f.id === format)?.label}</span>
        </div>
        <div class="sq-top-lanes" ref={lanesRef}>
          <div class="sq-loops-row" title="Drag to add a loop; double-click for a hold point" onPointerDown={pressLoopsRow} onDblClick={(e) => writable && runWith("Add hold point", (q) => addLoop(q, snapAt(timeAt(e), e), snapAt(timeAt(e), e)), (r) => select(selectLoop(sel, r.id)))}>
            {s.loops.map((l) => {
              if (!visible(l.start, l.end)) return null;
              const x = toPx(l.start), w = toPx(l.end) - x;
              const hold = l.start === l.end;
              return (
                <div key={l.id} class={`sq-seq-loop${hold ? " hold" : ""}${sel.loop === l.id ? " selected" : ""} ${l.active}`} style={{ left: `${x}px`, width: `${hold ? 10 : Math.max(4, w)}px` }}
                  role="button" aria-label={hold ? `Hold point at ${l.start.toFixed(2)} s` : `Loop ${l.start.toFixed(2)}–${l.end.toFixed(2)} s`} title={`${hold ? "Hold point" : "Loop"} · ${l.active === "parameter" ? (l.binding ? `while ${l.binding.parameter} ${l.binding.op} ${l.binding.value}` : "⚠ unbound") : l.active === "held" ? "while held" : "always"} · exit ${l.exit}`}
                  onPointerDown={(e) => pressLoop(e, l.id, "body")} onDblClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); loopMenu(e, l.id); }}>
                  {!hold && <span class="sq-cap start" onPointerDown={(e) => pressLoop(e, l.id, "start")} />}
                  <span class="sq-cap end" title={hold ? "Drag to stretch the hold point into a loop" : "Loop end"} onPointerDown={(e) => pressLoop(e, l.id, "end")} />
                  {l.active === "parameter" && !l.binding && <span class="sq-chip unbound">⚠</span>}
                </div>
              );
            })}
          </div>
          <div class="sq-markers-row" title="Double-click to add a marker" onDblClick={(e) => writable && runWith("Add marker", (q) => addMarker(q, snapAt(timeAt(e), e)), (r) => select(selectMarker(sel, r.id)))}>
            {s.markers.map((m) => {
              if (!visible(m.at, m.at)) return null;
              return (
                <div key={m.id} class={`sq-marker ${m.type ?? "note"}${sel.marker === m.id ? " selected" : ""}`} style={{ left: `${toPx(m.at)}px` }} role="button" aria-label={`Marker ${m.name}`}
                  title={`${m.name} · ${m.type === "exit" ? "Exit: music may leave here" : m.type === "cue" ? "Cue: reported to the game" : "Note"}`}
                  onPointerDown={(e) => pressMarker(e, m.id)} onDblClick={(e) => { e.stopPropagation(); if (writable) setRenamingMarker(m.id); }} onContextMenu={(e) => { e.preventDefault(); markerMenu(e, m.id); }}>
                  {renamingMarker === m.id ? (
                    <input class="sq-marker-rename" aria-label="Marker name" value={m.name} ref={(el) => el?.focus()}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); if (e.key === "Escape") setRenamingMarker(null); }}
                      onBlur={(e) => { const v = (e.currentTarget as HTMLInputElement).value; setRenamingMarker(null); if (v.trim() && v !== m.name) runSeq("Rename marker", (q) => renameMarker(q, m.id, v)); }} />
                  ) : (
                    <span class="sq-marker-name">{m.name}</span>
                  )}
                </div>
              );
            })}
          </div>
          <TimeRuler view={view} format={format} context={timeCtx} position={playhead} length={length} label="Sequence time" onScrub={(t) => !playback.peek() && (seqPlayhead.value = Math.max(0, t))} />
          <Playhead t={playhead} view={view} playing={!!playing} />
          {endX >= 0 && endX <= width && <div class="sq-end-handle" style={{ left: `${endX}px` }} role="separator" aria-label="Sequence end" title={`Sequence length ${length.toFixed(2)} s${s.length === 0 ? " (to the end of the longest clip)" : ""}: drag to set`} onPointerDown={pressEnd} />}
        </div>
      </div>
      <div class="sq-body" onDragOver={onDragOver} onDragLeave={(e) => e.currentTarget === e.target && setGhost(null)} onDrop={onDrop}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); seqView.value = zoomTimeline(view, Math.exp(-e.deltaY * 0.002), timeAt(e), limit); }
          else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); seqView.value = scrollTimeline(view, dxToT(e.deltaX || e.deltaY), limit); }
        }}>
        <div class="sq-rows" ref={rowsRef} style={{ minHeight: `${height + 60}px` }}>
          {rows.map((r) => {
            const t = r.track;
            const trackWhere = `${lintPrefix}sequence.tracks[${r.ti}]`;
            return (
              <div key={t.id} class="sq-track-block">
                <div class="sq-row" style={{ height: `${r.h}px` }}>
                  <TrackHeader
                    track={t}
                    selected={sel.focus === "track" && sel.track === t.id}
                    writable={writable}
                    lanesOpen={seqOpenLanes.value.has(t.id)}
                    buses={props.buses}
                    height={r.h}
                    onSelect={() => select(selectTrack(t.id))}
                    onMenu={(e) => trackMenu(e, t.id)}
                    onRename={(name) => runSeq("Rename track", (q) => setTrack(q, t.id, { name }))}
                    onColour={() => runSeq("Track colour", (q) => setTrack(q, t.id, { color: typeof t.color === "number" ? (t.color % 8) + 1 : 1 }))}
                    onToggle={(field) => runSeq(field === "enabled" ? (t.enabled ? "Disable track" : "Enable track") : field === "mute" ? (t.mute ? "Unmute" : "Mute") : t.solo ? "Unsolo" : "Solo", (q) => setTrack(q, t.id, { [field]: !t[field] }))}
                    onAutomateEnabled={() => runWith("Automate Enabled", (q) => addAutomation(q, { track: t.id }, "enabled", length), () => (seqOpenLanes.value = new Set([...seqOpenLanes.peek(), t.id])))}
                    onToggleLanes={() => {
                      const next = new Set(seqOpenLanes.peek());
                      if (next.has(t.id)) next.delete(t.id);
                      else next.add(t.id);
                      seqOpenLanes.value = next;
                    }}
                    onOutput={(bus) => runSeq("Track output", (q) => setTrack(q, t.id, { output: bus }))}
                    onSlider={(field, phase, value) => onSlider(t.id, field, phase, value)}
                  />
                  <div class={`sq-lane${t.enabled ? "" : " disabled"}`} onPointerDown={(e) => pressLane(e, r.ti)}
                    onPointerMove={(e) => seqRazor.value && setRazorAt(snapAt(timeAt(e), e))} onPointerLeave={() => setRazorAt(null)}>
                    {t.clips.map((c) => {
                      const src = sourceOf(c);
                      const len = clipLength(c, src);
                      if (!visible(c.at, c.at + len)) return null;
                      const x = toPx(c.at);
                      const shown = shownCurve(c.id);
                      return (
                        <TimelineClip
                          key={c.id}
                          clip={c}
                          track={t}
                          src={src}
                          peaks={c.sample !== undefined && seqShowWave.value ? props.peaksOf(c.sample) : null}
                          left={x}
                          width={toPx(c.at + len) - x}
                          height={r.h - 4}
                          selected={sel.clips.includes(c.id)}
                          follows={clipFollows(props.lints, trackWhere, t, c)}
                          showWave={seqShowWave.value}
                          razor={seqRazor.value}
                          curve={shown ? { ...shown, keys: sel.points && "clip" in sel.points.owner && sel.points.owner.clip === c.id && sel.points.automation === shown.automation.id ? sel.points.keys : [] } : null}
                          onPress={(e, part) => pressOnClip(e, c.id, part)}
                          onDoubleClick={(e) => dblClickClip(e, c.id)}
                          onMenu={(e) => clipMenu(e, c.id)}
                          onHover={(e) => hoverClip(e, c.id)}
                          onPointPress={(i, e) => shown && pressPoint(e, { clip: c.id }, shown.automation.id, i, r.h - 4)}
                          onPointDoubleClick={(i) => shown && runSeq("Delete automation point", (q) => deletePoints(q, { clip: c.id }, shown.automation.id, [i]))}
                          onPointMenu={(i, e) => shown && pointMenu(e, { clip: c.id }, shown.automation.id, i, clipName(c), len)}
                        />
                      );
                    })}
                    {ghost && ghost.ti === r.ti && <div class={`sq-ghost${ghost.ok ? "" : " refused"}`} style={{ left: `${toPx(ghost.at)}px`, width: `${Math.max(8, toPx(ghost.at + ghost.length) - toPx(ghost.at))}px` }}>{ghost.text}</div>}
                  </div>
                </div>
                {r.lanes.map((lane) => {
                  const a = t.automation.find((x) => x.id === lane.automation)!;
                  const spec = targetSpec(a.target, t.effects);
                  const time = isTimeInput(a.input);
                  return (
                    <div key={lane.automation} class="sq-row sq-auto-row" style={{ height: `${lane.h}px` }}>
                      <div class="sq-auto-head" style={{ height: `${lane.h}px` }}>
                        <span class="sq-auto-name" title={a.target}>{spec?.name ?? a.target}</span>
                        <span class="sq-faint">{time ? "time" : `by ${(a.input as { parameter: string }).parameter}`}</span>
                        <button type="button" class={`sq-icon${a.bypass ? "" : " on"}`} aria-pressed={!a.bypass} aria-label={`${spec?.name ?? a.target} automation on`} title={a.bypass ? "Bypassed: the plain value plays (click to turn on)" : "On (click to bypass)"} disabled={!writable}
                          onClick={() => runSeq(`${spec?.name ?? a.target} automation ${a.bypass ? "on" : "off"}`, (q) => setAutomation(q, { track: t.id }, a.id, { bypass: !a.bypass }))}>●</button>
                        <button type="button" class="sq-icon" aria-label={`Edit ${spec?.name ?? a.target} curve`} title="Open in the curve editor" onClick={() => openCurves({ track: t.id }, length, t.name, a.target)}>✎</button>
                      </div>
                      <div class="sq-lane sq-auto-lane" onDblClick={(e) => dblClickLane(e, t.id, a.id)}>
                        {spec && time ? (
                          <CurveOverlay curve={a.curve} spec={spec} width={width} height={lane.h} toX={toPx} fromX={toT} selected={shownTrackLane(t.id, a.id)} muted={a.bypass} interactive
                            label={`${t.name} ${spec.name} automation`}
                            onPointPress={(i, e) => pressPoint(e, { track: t.id }, a.id, i, lane.h)}
                            onPointDoubleClick={(i) => runSeq("Delete automation point", (q) => deletePoints(q, { track: t.id }, a.id, [i]))}
                            onPointMenu={(i, e) => pointMenu(e, { track: t.id }, a.id, i, t.name, length)} />
                        ) : (
                          <span class="sq-faint sq-driven">Driven by {(a.input as { parameter: string }).parameter}: edit it in the curve editor (✎).</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div class="sq-fill" style={{ top: `${height}px` }} onPointerDown={() => select({ ...EMPTY_SELECTION })}>
            {s.tracks.length === 0 && <p class="sq-faint sq-fill-hint">Drop a sample from the Library here for an audio track, or a playlist from the Playlists panel; or use + Track.</p>}
            {ghost && ghost.ti === "new" && <div class="sq-ghost new" style={{ left: `${HEADER_WIDTH + toPx(ghost.at)}px`, width: `${Math.max(40, toPx(ghost.at + ghost.length) - toPx(ghost.at))}px` }}>{ghost.text}</div>}
          </div>
          <div class="sq-overlay" style={{ left: `${HEADER_WIDTH}px`, height: `${Math.max(height, 1)}px` }}>
            <Playhead t={playhead} view={view} playing={!!playing} />
            {endX >= 0 && endX <= width && <div class="sq-end-line" style={{ left: `${endX}px` }} />}
            {seqRazor.value && razorAt !== null && <div class="sq-razor-line" style={{ left: `${toPx(razorAt)}px` }} />}
            {marquee && (() => {
              const [a, b] = marquee.t0 <= marquee.t1 ? [marquee.t0, marquee.t1] : [marquee.t1, marquee.t0];
              const [lo, hi] = marquee.r0 <= marquee.r1 ? [marquee.r0, marquee.r1] : [marquee.r1, marquee.r0];
              const top = rows[lo]?.y ?? 0, bottom = (rows[hi]?.y ?? 0) + (rows[hi]?.h ?? 0);
              return <div class="sq-marquee" style={{ left: `${toPx(a)}px`, width: `${toPx(b) - toPx(a)}px`, top: `${top}px`, height: `${bottom - top}px` }} />;
            })()}
          </div>
        </div>
      </div>
      <div class="sq-scrollbar" role="scrollbar" aria-orientation="horizontal" aria-label="Scroll and zoom the timeline" aria-valuenow={Math.round(thumb.left * 100)}>
        <div class="sq-thumb" style={{ left: `${thumb.left * 100}%`, width: `${Math.max(1, thumb.width * 100)}%` }}
          onPointerDown={(e) => {
            const bar = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
            const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const part = e.clientX - box.left < 6 ? "start" : box.right - e.clientX < 6 ? "end" : "body";
            const t0 = thumbOf(view, limit);
            beginDrag(e, {
              threshold: 1,
              move: (dx) => {
                const f = dx / Math.max(1, bar.width);
                if (part === "body") seqView.value = viewFromThumb(t0.left + f, t0.width, limit);
                else if (part === "start") seqView.value = viewFromThumb(t0.left + f, t0.width - f, limit);
                else seqView.value = viewFromThumb(t0.left, t0.width + f, limit);
              },
              up: () => {},
            });
          }}>
          <span class="sq-thumb-edge start" />
          <span class="sq-thumb-edge end" />
        </div>
      </div>
      {hover && hoverClipAt && (
        <div class="sq-hover-card" role="tooltip" style={{ left: `${hover.x + 12}px`, top: `${hover.y + 12}px` }}>
          <strong>{clipName(hoverClipAt.clip)}</strong>
          <span>{hoverClipAt.track.name} · {hoverClipAt.clip.sync ? "Sync" : "Async"}{hoverClipAt.clip.enabled ? "" : " · disabled"}</span>
          <span>at {formatTime(hoverClipAt.clip.at, format, timeCtx)} · {clipLength(hoverClipAt.clip, sourceOf(hoverClipAt.clip)).toFixed(3)} s{hoverClipAt.clip.offset ? ` · offset ${hoverClipAt.clip.offset.toFixed(3)} s` : ""}</span>
          {hoverClipAt.clip.gain !== 0 && <span>gain {hoverClipAt.clip.gain.toFixed(1)} dB</span>}
        </div>
      )}
      {menu && <ContextMenu entries={menu.entries} at={menu.at} label={menu.label} onClose={() => setMenu(null)} />}
    </div>
  );
}

// --- the toolbar -------------------------------------------------------------------------------------------------------

interface ToolbarProps {
  readonly s: SequenceSettings;
  readonly writable: boolean;
  readonly playhead: number;
  readonly format: TimeFormat;
  readonly timeText: string;
  readonly back?: { readonly name: string; open(): void };
  readonly taps: readonly number[];
  onAddTrack(kind: "audio" | "playlist"): void;
  onAddLoop(): void;
  onAddHold(): void;
  onTempo(bpm: number | null): void;
  onTap(): void;
  onMeter(meter: string): void;
  onZoom(factor: number): void;
  onFit(): void;
}

function Toolbar(props: ToolbarProps) {
  const { s, writable } = props;
  const [trackMenu, setTrackMenu] = useState<Element | null>(null);
  const snap = seqSnap.value;
  const nextFormat = (f: TimeFormat): TimeFormat => (f === "timecode" ? "samples" : f === "samples" ? (s.tempo ? "bars" : "timecode") : "timecode");
  return (
    <div class="sq-toolbar" role="toolbar" aria-label="Sequence tools">
      {props.back && <button type="button" class="pl-link sq-back" title={`Back to ${props.back.name}`} onClick={props.back.open}>‹ {props.back.name}</button>}
      <button type="button" class="pl-small" disabled={!writable} aria-haspopup="menu" onClick={(e) => setTrackMenu(e.currentTarget)}>+ Track ▾</button>
      {trackMenu && (
        <ContextMenu at={trackMenu} label="Add track" onClose={() => setTrackMenu(null)}
          entries={[{ id: "audio", label: "Audio track", title: "Takes samples", run: () => props.onAddTrack("audio") }, { id: "playlist", label: "Playlist track", title: "Takes playlists", run: () => props.onAddTrack("playlist") }]} />
      )}
      <button type="button" class="pl-small" disabled={!writable} title="A one-bar loop at the playhead" onClick={props.onAddLoop}>+ Loop</button>
      <button type="button" class="pl-small" disabled={!writable} title="A hold point at the playhead: the playhead parks there while it is active" onClick={props.onAddHold}>+ Hold</button>
      <span class="sq-sep" />
      <button type="button" class={`sq-tool${seqRazor.value ? " on" : ""}`} aria-pressed={seqRazor.value} title="Razor (C): click a clip to split it" onClick={() => (seqRazor.value = !seqRazor.peek())}>✂ Razor</button>
      <button type="button" class={`sq-tool write${seqWrite.value ? " on" : ""}`} aria-pressed={seqWrite.value} title="Write automation (W): moving a track's volume or pan while it plays writes a curve over the time it is held" onClick={() => (seqWrite.value = !seqWrite.peek())}>● Write</button>
      <button type="button" class={`sq-tool${seqShowWave.value ? " on" : ""}`} aria-pressed={seqShowWave.value} title="Draw waveforms in clips" onClick={() => (seqShowWave.value = !seqShowWave.peek())}>∿ Wave</button>
      <span class="sq-sep" />
      <button type="button" class="sq-time" title="Time display (click for the next: timecode, samples, bars)" aria-label={`Playhead ${props.timeText}`} onClick={() => (seqTimeFormat.value = nextFormat(props.format))}>{props.timeText}</button>
      <label class="sq-inline" title="Snap: edges within 0.8 % of the view first, then the grid (hold Alt to place freely)">
        <span class="sq-faint">Snap</span>
        <select class="pl-select" aria-label="Snap" value={snap.mode} onChange={(e) => (seqSnap.value = { ...snap, mode: (e.currentTarget as HTMLSelectElement).value as SnapMode })}>
          {SNAP_MENU.map((o) => <option key={o.mode} value={o.mode}>{o.label}</option>)}
        </select>
        {snap.mode === "custom" && (
          <input class="pl-num" aria-label="Custom snap, seconds" value={snap.custom} onChange={(e) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (v > 0) seqSnap.value = { ...snap, custom: v };
          }} />
        )}
        <input type="checkbox" aria-label="Snap to edges" title="Snap to edges" checked={snap.edges} onChange={(e) => (seqSnap.value = { ...snap, edges: (e.currentTarget as HTMLInputElement).checked })} />
      </label>
      <details class="sq-tempo">
        <summary title="Tempo and meter (the grid and the bars display; the runtime's musical clock)">{s.tempo ? `♩ ${s.tempo.bpm} · ${s.tempo.meter}` : "♩ No tempo"}</summary>
        <div class="sq-tempo-pop">
          <label class="sq-inline">BPM
            <input class="pl-num" aria-label="Tempo, BPM" disabled={!writable} value={s.tempo?.bpm ?? ""} placeholder="—" onChange={(e) => {
              const v = Number((e.currentTarget as HTMLInputElement).value);
              if (Number.isFinite(v) && v > 0) props.onTempo(v);
            }} />
          </label>
          <button type="button" class="pl-small" disabled={!writable} title="Tap the beat (two taps or more)" onClick={props.onTap}>Tap{props.taps.length > 1 ? ` (${props.taps.length})` : ""}</button>
          <label class="sq-inline">Meter
            <select class="pl-select" aria-label="Meter" disabled={!writable} value={s.tempo?.meter ?? "4/4"} onChange={(e) => props.onMeter((e.currentTarget as HTMLSelectElement).value)}>
              {METERS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label class="sq-inline"><input type="checkbox" disabled={!writable} checked={!s.tempo} onChange={(e) => props.onTempo((e.currentTarget as HTMLInputElement).checked ? null : 120)} /> No tempo</label>
        </div>
      </details>
      <span class="sq-sep" />
      <button type="button" class="sq-icon" aria-label="Zoom out" title="Zoom out (−)" onClick={() => props.onZoom(1 / 1.5)}>−</button>
      <button type="button" class="sq-icon" aria-label="Fit" title="Fit the sequence (0); Z zooms to the selection" onClick={props.onFit}>⤢</button>
      <button type="button" class="sq-icon" aria-label="Zoom in" title="Zoom in (=)" onClick={() => props.onZoom(1.5)}>+</button>
    </div>
  );
}
