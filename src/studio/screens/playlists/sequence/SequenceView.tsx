// The Sequence view (ADR 0343; the owner's prototype Sequencer timeline, proto A1–A8, A12, A13): the toolbar (add track
// split button, add loop, add hold point, razor, Write, the Playlists link; the Waveform and Spectrogram views, Tempo
// and the Snap split button), the header block (Markers and Loops rows, the playhead readout with its Time display
// menu, the ruler with the past-end shading, the end handle and the playhead), the Tempo lane in the bars display, the
// track headers and clip lanes with their automation lanes, the guides over every track (loop bands, hold and marker
// lines, crossfade zones, past-end shading, razor, marquee, playhead), the fill row, the zoom strip with its view bar,
// and the readout. Every gesture of the prototype: drops from the Library and the Playlists tree, moves, trims, splits,
// marquee, envelope and ADSR points, loops, markers, the sequence's end, track reorder, copy and paste, the keyboard.
// Each gesture is one labelled edit through `onEdit` (a drag previews locally and commits once on release); a refusal
// shows as a toast. The selection, playhead and modes live in `sequenceState.ts`, shared with the Inspector and the
// transport.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import type { PlaylistLint } from "../../../../engine/audio/playlist/lint";
import type { Clip, PlaylistBody, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { evalCurve, type CurveInterp } from "../../../../engine/core/curve";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../../editor/ui/ContextMenu";
import type { PopoverPoint } from "../../../../editor/ui/popover";
import { accept, type EditResult } from "../../../../plugins/audio/editor/editResult";
import type { PeakMips } from "../../../../plugins/audio/editor/music/peaksMip";
import { Icon } from "../../../components/Icon";
import { effectiveFormat, formatTime, type TimeFormat } from "../../../components/timeRulerModel";
import { useElementWidth } from "../../../components/useElementWidth";
import type { Pcm } from "../../samples/seam";
import { sampleFromDrag } from "../libraryModel";
import { playlistTitle } from "../playlistPaths";
import { clipAdsr, dragAdsr, type AdsrHandle } from "./adsrModel";
import {
  addAutomation, addPoint, addVolumeEnvelope, deletePoints, isTimeInput, movePoints, ownerOf, parameterLaneRange, pasteCurves, removeAutomation, setAutomation, setDrivenBy, setPointShape, SHAPES, targetSpec, targetSpecs, writeAutomation, type AutomationOwner,
} from "./automationEdits";
import { clipFollows, clipPlan, loopBand } from "./clipGeometry";
import { ClipHoverCard } from "./ClipHoverCard";
import { CurveOverlay, yToValue } from "./CurveOverlay";
import { addLoop, addMarker, deleteLoops, deleteMarkers, makeHoldPoint, moveLoop, moveMarker, nudgeLoopsAndMarkers, renameMarker, setLoopEdge, setMarkerType } from "./loopMarkerEdits";
import { beginDrag } from "./pointerDrag";
import { openSequenceCurves } from "./openSequenceCurves";
import { sequenceReadout } from "./readoutModel";
import { copySelection, paste, pasteLabel } from "./sequenceClipboard";
import {
  addPlaylistClip, addSampleClip, addSampleOnNewTrack, addTrack, deleteClips, duplicateClips, duplicateTrack, makeAsync, moveClips, moveClipsToAdjacentTrack, moveTrack,
  newTrack, nudgeClipEdge, removeTracks, setClipEffects, setClipLength, setMeter, setSequenceLength, setTempo, setTrack, splitClip, toggleClipsEnabled, trimClipStart, trimToPlayhead,
} from "./sequenceEdits";
import { beatSeconds, beatsPerBar, keepTaps, nudgeStep, snapLabel, snapSpan, snapTime, tapTempo, toggleSnap } from "./sequenceGrid";
import { activeIcon, SeqIcon } from "./sequenceIcons";
import { allClips, clipLength, findClip, onSequence, plural, sequenceLength, sequenceTails, type BodyEdit, type SeqEdit, type SourceOf } from "./sequenceModel";
import { clickClip, clickPoint, EMPTY_SELECTION, marqueeSelect, pressClip, selectAll, selectLoop, selectMarker, selectTrack, type SeqSelection } from "./sequenceSelection";
import {
  bindSequence, playback, seqAudioView, seqClipboard, seqCurveClipboard, seqOpenLanes, seqPlayhead, seqRazor, seqSelection, seqShownCurve, seqSnap, seqTimeFormat, seqTransport, seqView, seqWrite, seqWriting, touchWrite, transportMessage,
} from "./sequenceState";
import { clipName, keyboardMenu, TimelineClip } from "./TimelineClip";
import { activeText, crossfadeZones, loopName, voicePosition } from "./timelineOverlays";
import { clampTimeline, fitTimeline, followView, HEADER_WIDTH, pxToTime, rowAt, rulerMarks, scrollLimit, scrollTimeline, snapEdges, thumbOf, timeToPx, trackIndexAt, trackRows, viewFromThumb, zoomPercent, zoomTimeline, zoomToSpan } from "./timelineLayout";
import { SnapPopover, TempoPopover } from "./TimelinePopovers";
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
  /** A sample's decoded audio, for the spectrogram (absent or null: no spectrogram yet). */
  pcmOf?(path: string): Pcm | null;
  loadPlaylist(path: string): PlaylistBody | null;
  readonly parameters: readonly ParameterDef[];
  /** The game parameters' test values (a parameter lane's live marker, the readout's conditions). */
  readonly parameterValues?: Readonly<Record<string, number>>;
  /** "+ New parameter…" in the curves' Driven by (J6.5): make a game parameter. */
  onNewParameter?(kind?: "numeric" | "labelled"): Promise<ParameterDef | null>;
  readonly buses: readonly string[];
  /** The parent playlist, when the sequence is nested (the toolbar's link back). */
  readonly back?: { readonly name: string; open(): void };
  /** Open sample in Samples (the clip menu, Ctrl+1). */
  onOpenSample?(sample: string): void;
  /** Open a linked playlist (double-click a playlist clip). */
  onOpenPlaylist?(path: string): void;
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
const RATE = 48000;

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
  const [menu, setMenu] = useState<{ at: PopoverPoint | Element; entries: MenuEntry[]; label: string } | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [hover, setHover] = useState<{ clip: string; x: number; y: number } | null>(null);
  const [razorAt, setRazorAt] = useState<number | null>(null);
  const [renamingMarker, setRenamingMarker] = useState<string | null>(null);
  const [taps, setTaps] = useState<number[]>([]);
  const [fillOver, setFillOver] = useState(false);
  const [reorder, setReorder] = useState<{ from: number; to: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const values = props.parameterValues ?? {};
  const rawFormat = seqTimeFormat.value;
  const timeCtx = { rate: RATE, bpm: s.tempo?.bpm ?? null, meter: s.tempo?.meter ?? null };
  const format = effectiveFormat(rawFormat, timeCtx);
  const fmt = (t: number) => formatTime(t, format, timeCtx);

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
  const openMenu = (m: { at: PopoverPoint | Element; entries: MenuEntry[]; label: string }) => {
    clearHover();
    setMenu({ ...m, entries: tidyEntries(m.entries) });
  };

  // --- geometry from events ------------------------------------------------------------------------------------------

  const xIn = (e: { clientX: number }) => e.clientX - (lanesRef.current?.getBoundingClientRect().left ?? 0);
  const yIn = (e: { clientY: number }) => e.clientY - (rowsRef.current?.getBoundingClientRect().top ?? 0);
  const timeAt = (e: { clientX: number }) => Math.max(0, toT(xIn(e)));
  const ctxFor = (edges: number[], free = false) => ({ snap, tempo: s.tempo, span, edges, free: free || snap.mode === "off" && !snap.edges });
  const snapAt = (t: number, e?: { altKey?: boolean }, exclude: { clips?: string[]; loop?: string; marker?: string } = {}) =>
    snapTime(t, ctxFor(snapEdges(docSeq, sourceOf, length, { exclude: exclude.clips, excludeLoop: exclude.loop, excludeMarker: exclude.marker, playhead }), !!e?.altKey));
  const focusRoot = () => rootRef.current?.focus({ preventScroll: true });
  const drag = (e: PointerEvent, h: Parameters<typeof beginDrag>[1]) => {
    beginDrag(e, {
      ...h,
      move: (dx, dy, ev) => {
        setDragging(true);
        h.move(dx, dy, ev);
      },
      up: (dragged, ev) => {
        setDragging(false);
        h.up(dragged, ev);
      },
    });
  };

  // --- clips -----------------------------------------------------------------------------------------------------------

  const pressOnClip = (e: PointerEvent, clipId: string, part: "body" | "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    focusRoot();
    clearHover();
    const f = findClip(docSeq, clipId);
    if (!f) return;
    const trackId = f.track.id;
    if (seqRazor.peek() && part === "body") {
      const t = snapAt(timeAt(e), e);
      const len0 = clipLength(f.clip, sourceOf(f.clip));
      if (t <= f.clip.at || t >= f.clip.at + len0) return props.onNotify("Split point must be inside the clip");
      runSeq("Split clip", (x) => splitClip(x, clipId, t, sourceOf));
      return;
    }
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    const next = pressClip(sel, clipId, trackId, mods);
    select(next);
    if (!writable) return;
    const len = clipLength(f.clip, sourceOf(f.clip));
    let cur: { label: string; edit: SeqEdit } | null = null;
    drag(e, {
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
    if (typeof f.clip.playlist === "string" && props.onOpenPlaylist) return props.onOpenPlaylist(f.clip.playlist);
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

  /** An ADSR handle on a clip: drag sets the Amp envelope's stages, one step on release. */
  const pressAdsr = (e: PointerEvent, clipId: string, handle: AdsrHandle, box: { width: number; height: number }) => {
    if (e.button !== 0 || !writable) return;
    e.stopPropagation();
    const f = findClip(docSeq, clipId);
    const env = f ? clipAdsr(f.clip.effects) : null;
    if (!f || !env) return;
    const len = clipLength(f.clip, sourceOf(f.clip));
    const shape = { attack: env.adsr.attack, decay: env.adsr.decay, sustain: env.adsr.sustain, release: env.adsr.release };
    const start = handle === "attack" ? [shape.attack / 1000, 1] : handle === "decaySustain" ? [(shape.attack + shape.decay) / 1000, shape.sustain / 100] : [len - shape.release / 1000, shape.sustain / 100];
    let cur: SeqEdit | null = null;
    drag(e, {
      move: (dx, dy) => {
        const x = start[0]! + (dx / Math.max(1, box.width)) * len;
        const y = start[1]! - dy / Math.max(1, box.height - 20);
        const patch = dragAdsr(shape, handle, x, Math.max(0, Math.min(1, y)), len);
        const effects = f.clip.effects.map((fx) => (fx.id === env.effect.id ? { ...fx, params: { ...fx.params, ...patch } } : fx));
        cur = (q) => setClipEffects(q, clipId, effects);
        const r = cur(docSeq);
        if ("next" in r) setDraft({ seq: r.next });
      },
      up: (dragged) => {
        setDraft(null);
        if (dragged && cur) runSeq("Amp envelope", cur);
      },
    });
  };

  /** Points of a lane: press selects, drag moves (snapped in time), all as one step. */
  const pressPoint = (e: PointerEvent, owner: AutomationOwner, automation: string, index: number, laneHeight: number, xScale?: (dx: number) => number) => {
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
    drag(e, {
      move: (dx, dy, ev) => {
        const k = lane.curve[index]!;
        const x = xScale ? k[0] + xScale(dx) : ev.altKey ? k[0] + dxToT(dx) : snapAt(origin + k[0] + dxToT(dx), ev) - origin;
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
    openMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Segment shape",
      entries: [
        { kind: "group", label: keys.length > 1 ? `Shape · ${keys.length} points` : "Segment shape" },
        ...SHAPES.map((x) => shape(x.shape, x.label)),
        SEPARATOR,
        { id: "curves", label: "Open in curve editor…", run: () => openCurves(owner, curveLength, title) },
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => (seqClipboard.value = copySelection(docSeq, { ...clickPoint(EMPTY_SELECTION, owner, automation, index), points: { owner, automation, keys: [...keys] } })) },
        { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: !writable, run: () => runSeq(keys.length > 1 ? "Delete automation points" : "Delete automation point", (q) => deletePoints(q, owner, automation, keys)) },
      ],
    });
  };

  const openCurves = (owner: AutomationOwner, curveLength: number, title: string, lane?: string) =>
    openSequenceCurves({
      doc: rootRef.current?.ownerDocument ?? document, seq: docSeq, owner, length: curveLength, name: title, context: props.title, parameters: props.parameters, newParameter: props.onNewParameter, lane,
      playhead: "clip" in owner ? Math.max(0, playhead - (findClip(docSeq, owner.clip)?.clip.at ?? 0)) : playhead,
      commit: (label, edit) => runSeq(label, edit),
    });

  /** "Automate X" items for an owner (the targets it hasn't automated yet). */
  const automateItems = (owner: AutomationOwner, curveLength: number, only?: readonly string[]): MenuEntry[] => {
    const v = ownerOf(docSeq, owner);
    if (!v) return [];
    return targetSpecs(v.effects).filter((t) => !only || only.includes(t.target)).map((t) => ({
      id: `auto-${t.target}`,
      label: `Automate ${lowerFirst(t.name)}`,
      disabled: !writable || v.automation.some((a) => a.target === t.target),
      run: () => runWith(`Automate ${t.name}`, (q) => addAutomation(q, owner, t.target, curveLength), (r) => {
        if ("track" in owner) seqOpenLanes.value = new Set([...seqOpenLanes.peek(), owner.track]);
        else seqShownCurve.value = { ...seqShownCurve.peek(), [owner.clip]: r.id };
      }),
    }));
  };

  const clipMenu = (e: MouseEvent, clipId: string) => {
    const f = findClip(docSeq, clipId);
    if (!f) return;
    const ids = sel.clips.includes(clipId) ? [...sel.clips] : [clipId];
    if (!sel.clips.includes(clipId)) select(clickClip(sel, clipId, f.track.id));
    const t = snapAt(timeAt(e), e);
    const len = clipLength(f.clip, sourceOf(f.clip));
    const follows = !!clipFollows(docSeq, clipId, sourceOf);
    const clip = seqClipboard.peek();
    const others = automateItems({ clip: clipId }, len);
    openMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Clip",
      entries: [
        { kind: "group", label: ids.length > 1 ? `${ids.length} clips` : clipName(f.clip) },
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => copyClips(ids) },
        { id: "paste", label: "Paste", hint: "Ctrl+V", disabled: !writable || !clip, run: () => pasteNow(f.track.id, t) },
        { id: "dup", label: "Duplicate", hint: "Ctrl+D", disabled: !writable, run: () => duplicate(ids) },
        { id: "split", label: "Split here", hint: "C", disabled: !writable || ids.length > 1, run: () => runSeq("Split clip", (q) => splitClip(q, clipId, t, sourceOf)) },
        { id: "en", label: f.clip.enabled ? "Disable" : "Enable", hint: "E", disabled: !writable, run: () => toggleEnabled(ids) },
        { id: "del", label: "Delete", hint: "Del", danger: true, disabled: !writable, run: () => removeClips(ids) },
        SEPARATOR,
        ...(f.clip.sample !== undefined && props.onOpenSample ? [{ id: "samples", label: "Open sample in Samples", hint: "Ctrl+1", run: () => props.onOpenSample!(f.clip.sample!) }] : []),
        ...(follows ? [{ id: "async", label: "Make Async", title: "Let this clip loop on its own clock instead of following the clip before it on this track", disabled: !writable, run: () => runSeq("Clip async", (q) => makeAsync(q, clipId)) }] : []),
        SEPARATOR,
        { id: "env", label: "Add volume envelope", disabled: !writable || f.clip.automation.some((a) => a.target === "volume"), run: () => runWith("Add volume envelope", (q) => addVolumeEnvelope(q, clipId, len / 2, 0, len), (r) => (seqShownCurve.value = { ...seqShownCurve.peek(), [clipId]: r.id })) },
        { id: "automate", label: "Automate", submenu: others, run: () => {} },
        { id: "curves", label: "Edit curves…", run: () => openCurves({ clip: clipId }, len, clipName(f.clip)) },
      ],
    });
  };

  const copyClips = (ids: readonly string[]) => {
    seqClipboard.value = copySelection(docSeq, { ...sel, focus: "clips", clips: [...ids] });
    const one = ids.length === 1 ? findClip(docSeq, ids[0]!) : null;
    props.onNotify(one ? `Copied ${clipName(one.clip)}` : `Copied ${ids.length} clips`);
  };

  const pasteNow = (track: string | null, at: number) => {
    const c = seqClipboard.peek();
    if (!c) return;
    const lane = sel.points ? { owner: sel.points.owner, automation: sel.points.automation } : null;
    runWith(pasteLabel(c), (q) => paste(q, c, { playhead: at, track, lane }), (r) => {
      if (r.clips.length) select({ ...EMPTY_SELECTION, focus: "clips", clips: r.clips, track });
      else if (r.loop) select(selectLoop(sel, r.loop));
      else if (r.marker) select(selectMarker(sel, r.marker));
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

  function clearHover() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHover(null);
  }
  const hoverClip = (e: PointerEvent | null, clipId: string) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (!e) return setHover(null);
    const x = e.clientX, y = e.clientY;
    hoverTimer.current = setTimeout(() => setHover({ clip: clipId, x, y }), 450);
  };

  // --- empty lane: marquee, focus, playhead, its menu ----------------------------------------------------------------

  const pressLane = (e: PointerEvent, ti: number) => {
    if (e.button !== 0) return;
    focusRoot();
    const t0 = timeAt(e);
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    drag(e, {
      move: (_dx, _dy, ev) => setMarquee({ t0, t1: timeAt(ev), r0: ti, r1: trackIndexAt(rows, yIn(ev)) }),
      up: (dragged, ev) => {
        setMarquee(null);
        if (dragged) select(marqueeSelect(docSeq, sourceOf, sel, t0, timeAt(ev), ti, trackIndexAt(rows, yIn(ev)), add));
        else {
          select({ ...EMPTY_SELECTION, focus: "track", track: s.tracks[ti]?.id ?? null });
          if (!playback.peek()) seqPlayhead.value = snapAt(t0, ev);
        }
      },
    });
  };

  const laneMenu = (e: MouseEvent, ti: number) => {
    e.preventDefault();
    const t = snapAt(timeAt(e), e);
    const track = s.tracks[ti];
    openMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Lane",
      entries: [
        { kind: "group", label: track?.name ?? "Lane" },
        { id: "paste", label: "Paste here", hint: "Ctrl+V", disabled: !writable || !seqClipboard.peek(), run: () => pasteNow(track?.id ?? null, t) },
        { id: "marker", label: "Add marker here", disabled: !writable, run: () => runWith("Add marker", (q) => addMarker(q, t), (r) => select(selectMarker(sel, r.id))) },
        { id: "hold", label: "Add hold point here", disabled: !writable, run: () => runWith("Add hold point", (q) => addLoop(q, t, t), (r) => select(selectLoop(sel, r.id))) },
      ],
    });
  };

  // --- lanes (track automation) --------------------------------------------------------------------------------------

  const dblClickLane = (e: MouseEvent, trackId: string, automation: string) => {
    const t = s.tracks.find((x) => x.id === trackId);
    const a = t?.automation.find((x) => x.id === automation);
    if (!t || !a) return;
    const spec = targetSpec(a.target, t.effects);
    if (!spec) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const range = parameterLaneRange(a.input, a.curve, props.parameters);
    const x = range ? range.min + ((e.clientX - box.left) / Math.max(1, box.width)) * (range.max - range.min) : snapAt(timeAt(e), e);
    runWith("Add automation point", (q) => addPoint(q, { track: trackId }, automation, x, yToValue(e.clientY - box.top, spec, box.height)), (r) => select(clickPoint(EMPTY_SELECTION, { track: trackId }, automation, r.index)));
  };

  // --- Loops row, Markers row, end handle ----------------------------------------------------------------------------

  const pressLoopsRow = (e: PointerEvent) => {
    if (e.button !== 0 || !writable) return;
    const a = snapAt(timeAt(e), e);
    let b = a;
    drag(e, {
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
    drag(e, {
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
    openMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Loop",
      entries: [
        { kind: "group", label: loopName(docSeq, id) },
        { id: "hold", label: "Make hold point", disabled: !writable || l.start === l.end, run: () => runSeq("Make hold point", (q) => makeHoldPoint(q, id)) },
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => { seqClipboard.value = copySelection(docSeq, selectLoop(EMPTY_SELECTION, id)); props.onNotify(`Copied ${loopName(docSeq, id)}`); } },
        SEPARATOR,
        { id: "del", label: l.start === l.end ? "Delete hold point" : "Delete loop", hint: "Del", danger: true, disabled: !writable, run: () => runSeq("Delete loop", (q) => deleteLoops(q, [id])) },
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
    drag(e, {
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
    const type = (t: "note" | "cue" | "exit" | "entry", label: string) => ({ id: t, label, checked: (m.type ?? "note") === t, disabled: !writable, run: () => runSeq("Marker type", (q) => setMarkerType(q, id, t)) });
    openMenu({
      at: { x: e.clientX, y: e.clientY }, label: "Marker",
      entries: [
        { kind: "group", label: m.name },
        { id: "rename", label: "Rename", hint: "F2", disabled: !writable, run: () => setRenamingMarker(id) },
        type("note", "Note"), type("cue", "Cue (reported to the game)"), type("exit", "Exit (music may leave here)"), type("entry", "Entry (lands on the Switch's beat or bar)"),
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => { seqClipboard.value = copySelection(docSeq, selectMarker(EMPTY_SELECTION, id)); props.onNotify(`Copied marker ${m.name}`); } },
        SEPARATOR,
        { id: "del", label: "Delete marker", hint: "Del", danger: true, disabled: !writable, run: () => runSeq("Delete marker", (q) => deleteMarkers(q, [id])) },
      ],
    });
  };

  const pressEnd = (e: PointerEvent) => {
    if (e.button !== 0 || !writable) return;
    e.stopPropagation();
    let to = length;
    drag(e, {
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
    openMenu({
      at: e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : (e.currentTarget as Element), label: "Track",
      entries: [
        { kind: "group", label: t.name },
        { id: "enable", label: t.enabled ? "Disable track" : "Enable track", disabled: !writable, run: () => runSeq(t.enabled ? "Disable track" : "Enable track", (q) => setTrack(q, t.id, { enabled: !t.enabled })) },
        ...automateItems({ track: trackId }, length, ["enabled", "volume"]),
        { id: "automate", label: "Automate", submenu: automateItems({ track: trackId }, length).filter((x) => !("id" in x) || (x.id !== "auto-enabled" && x.id !== "auto-volume")), run: () => {} },
        SEPARATOR,
        { id: "dup", label: "Duplicate track", disabled: !writable, run: () => runSeq("Duplicate track", (q) => duplicateTrack(q, trackId)) },
        { id: "up", label: "Move up", hint: "drag the header", disabled: !writable || ti === 0, run: () => runSeq("Reorder tracks", (q) => moveTrack(q, trackId, ti - 1)) },
        { id: "down", label: "Move down", disabled: !writable || ti === s.tracks.length - 1, run: () => runSeq("Reorder tracks", (q) => moveTrack(q, trackId, ti + 1)) },
        { id: "del", label: "Delete track", hint: "Del", danger: true, disabled: !writable, run: () => deleteTrack(trackId) },
        SEPARATOR,
        { id: "add", label: "Add audio track", disabled: !writable, run: () => addTrackOf("audio") },
      ],
    });
  };

  const deleteTrack = (trackId: string) => {
    const t = docSeq.tracks.find((x) => x.id === trackId);
    if (t && runSeq("Delete track", (q) => removeTracks(q, [trackId]))) {
      select(EMPTY_SELECTION);
      props.onNotify(`Deleted ${t.name} (Ctrl+Z to undo).`);
    }
  };

  /** A header pressed: a click selects it; a vertical drag reorders the tracks (one step, "Reorder tracks"). */
  const pressHeader = (e: PointerEvent, ti: number) => {
    if (e.button !== 0) return;
    focusRoot();
    const t = s.tracks[ti];
    if (!t) return;
    select(selectTrack(t.id));
    if (!writable) return;
    let to = ti;
    drag(e, {
      move: (_dx, _dy, ev) => {
        to = Math.max(0, Math.min(s.tracks.length - 1, trackIndexAt(rows, yIn(ev))));
        setReorder({ from: ti, to });
      },
      up: (dragged) => {
        setReorder(null);
        if (dragged && to !== ti) runSeq("Reorder tracks", (q) => moveTrack(q, t.id, to));
      },
    });
  };

  /** The header's volume: typed or scrubbed; with Write armed while playing, it writes the curve instead. */
  const onVolume = (trackId: string, value: number, dragging_: boolean) => {
    const w = touchWrite(`${trackId}:volume`, value, dragging_);
    if (w === null) return;
    if (w !== "plain") {
      runWith("Write Volume automation", (q) => writeAutomation(q, { track: trackId }, "volume", w), () => (seqOpenLanes.value = new Set([...seqOpenLanes.peek(), trackId])));
      return;
    }
    if (dragging_) {
      const r = setTrack(docSeq, trackId, { volume: value });
      if ("next" in r) setDraft({ seq: r.next });
      return;
    }
    setDraft(null);
    runSeq("Track volume", (q) => setTrack(q, trackId, { volume: value }));
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
    setFillOver(g.ti === "new");
    setGhost(t && t.kind === "playlist" ? { ...g, ok: false, text: "Playlist tracks take a playlist, not samples" } : { ...g, text: g.ti === "new" ? "New audio track" : "Add clip" });
  };

  const onDrop = (e: DragEvent) => {
    setGhost(null);
    setFillOver(false);
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
        latest.current.run(`Add playlist clip`, (q) => addPlaylistClip(q, t.id, path, g.at, self, latest.current.props.loadPlaylist), (x) => x);
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
    const loop = sel.loop ? s.loops.find((l) => l.id === sel.loop) : undefined;
    if (loop && loop.end > loop.start) return (seqView.value = zoomToSpan(loop.start, loop.end, limit));
    if (!picked.length) return fit();
    seqView.value = zoomToSpan(Math.min(...picked.map((p) => p.clip.at)), Math.max(...picked.map((p) => p.clip.at + clipLength(p.clip, sourceOf(p.clip)))), limit);
  };
  const tap = () => {
    const next = keepTaps(taps, performance.now());
    setTaps(next);
    const bpm = tapTempo(next);
    if (bpm !== null) runSeq("Tap tempo", (q) => setTempo(q, bpm));
    else props.onNotify("Tap again on the next beat");
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
        if (c) {
          seqClipboard.value = c;
          if (sel.focus === "clips" && sel.clips.length) copyClips(sel.clips);
        }
        return true;
      }
      if (mod && key.toLowerCase() === "v") {
        pasteNow(sel.track ?? (sel.clips[0] ? findClip(docSeq, sel.clips[0])?.track.id ?? null : null), playhead);
        return true;
      }
      if (mod && key.toLowerCase() === "d") return sel.clips.length ? (duplicate(sel.clips), true) : false;
      if (mod && key === "1" && sel.clips.length === 1 && props.onOpenSample) {
        const c = findClip(docSeq, sel.clips[0]!)?.clip;
        if (c?.sample !== undefined) return props.onOpenSample(c.sample), true;
        return false;
      }
      if (mod) return false;
      if (key === "Delete" || key === "Backspace") {
        if (sel.focus === "points" && sel.points) runSeq(sel.points.keys.length > 1 ? "Delete automation points" : "Delete automation point", (q) => deletePoints(q, sel.points!.owner, sel.points!.automation, sel.points!.keys));
        else if (sel.focus === "loop" && sel.loop) runSeq("Delete loop", (q) => deleteLoops(q, [sel.loop!]));
        else if (sel.focus === "marker" && sel.marker) runSeq("Delete marker", (q) => deleteMarkers(q, [sel.marker!]));
        else if (sel.clips.length) removeClips(sel.clips);
        else if (sel.focus === "track" && sel.track) deleteTrack(sel.track);
        else return false;
        return true;
      }
      if (key === "Escape") {
        // The prototype's cascade: points, then a menu, then razor, then the selection.
        if (sel.points) select({ ...sel, points: null, focus: sel.clips.length ? "clips" : sel.track ? "track" : "sequence" });
        else if (menu) setMenu(null);
        else if (seqRazor.peek()) seqRazor.value = false;
        else select({ ...EMPTY_SELECTION });
        return true;
      }
      if (key.toLowerCase() === "c" && !e.altKey) return (seqRazor.value = !seqRazor.peek()), clearHover(), true;
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

  const thumb = thumbOf(view, limit);
  const hoverClipAt = hover && !dragging && !menu && !seqRazor.value ? findClip(s, hover.clip) : null;
  const shownTrackLane = (trackId: string, automation: string) => sel.points && "track" in sel.points.owner && sel.points.owner.track === trackId && sel.points.automation === automation ? sel.points.keys : [];
  const endX = toPx(length);
  const visible = (a: number, b: number) => b >= view.start && a <= view.end;
  const anySolo = s.tracks.some((t) => t.solo);
  const readout = sequenceReadout(s, sourceOf, playhead, length, props.body.playback.plays, { playing: !!playing, released: !!playing?.released, writing: seqWrite.value && (!!playing || seqWriting.value), values });
  const audioView = seqAudioView.value;
  const elapsedNow = playing ? playhead : null;
  const pctZoom = zoomPercent(view, length);

  return (
    <div class={`sq-view${seqRazor.value ? " razor-mode" : ""}`} ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Sequence ${props.title}`}>
      <Toolbar
        s={s}
        writable={writable}
        format={format}
        back={props.back}
        taps={taps.length}
        onAddTrack={addTrackOf}
        onAddLoop={() => addLoopAtPlayhead(false)}
        onAddHold={() => addLoopAtPlayhead(true)}
        onTempo={(bpm) => runSeq(bpm === null ? "No tempo" : "Tempo", (q) => setTempo(q, bpm))}
        onTap={tap}
        onMeter={(m) => runSeq("Meter", (q) => setMeter(q, m))}
      />
      {transportMessage.value && <p class="sq-message" role="status">{transportMessage.value}</p>}
      <div class="sq-body" onDragOver={onDragOver} onDragLeave={(e) => e.currentTarget === e.target && (setGhost(null), setFillOver(false))} onDrop={onDrop}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); seqView.value = zoomTimeline(view, Math.exp(-e.deltaY * 0.002), timeAt(e), limit); }
          else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); seqView.value = scrollTimeline(view, dxToT(e.deltaX || e.deltaY), limit); }
        }}>
        <div class="sq-top">
          <div class="sq-top-head">
            <span class="sq-row-label markers">Markers</span>
            <span class="sq-row-label loops" title="Sequence loops and hold points">Loops</span>
            <TimeDisplay format={format} rawFormat={rawFormat} text={fmt(playhead)} hasTempo={!!s.tempo} timeCtx={timeCtx} />
          </div>
          <div class="sq-top-lanes" ref={lanesRef}>
            <div class="sq-markers-row" title="Double-click to add a marker" onDblClick={(e) => writable && runWith("Add marker", (q) => addMarker(q, snapAt(timeAt(e), e)), (r) => select(selectMarker(sel, r.id)))}>
              {sequenceTails(s, length).map((t) => visible(t.from, t.to) && (
                <div key={`${t.kind}${t.loop ?? ""}`} class={`sq-tail ${t.kind}`} style={{ left: `${toPx(t.from)}px`, width: `${Math.max(2, toPx(t.to) - toPx(t.from))}px` }} aria-hidden="true"
                  title={t.kind === "postExit" ? "Tail: after the last Exit marker, this rings on under the next section when a Switch hands over there" : "Loop tail: rings over the next pass at each wrap"} />
              ))}
              {s.markers.map((m) => {
                if (!visible(m.at, m.at)) return null;
                const kind = m.type ?? "note";
                return (
                  <div key={m.id} class={`sq-marker ${kind}${sel.marker === m.id ? " selected" : ""}`} style={{ left: `${toPx(m.at)}px` }} role="button" aria-label={`Marker ${m.name}`}
                    title={`${m.name} · ${fmt(m.at)} · ${kind === "exit" ? "Exit: music may leave here" : kind === "cue" ? "Cue: the game is told when the playhead passes it" : kind === "entry" ? "Entry: a Switch lands here on its beat or bar" : "Marker"}`}
                    tabIndex={0} aria-pressed={sel.marker === m.id} onKeyDown={(e) => e.target === e.currentTarget && !keyboardMenu(e, (ev) => markerMenu(ev, m.id)) && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), e.stopPropagation(), select(selectMarker(sel, m.id)))}
                    onPointerDown={(e) => pressMarker(e, m.id)} onDblClick={(e) => { e.stopPropagation(); select(selectMarker(sel, m.id)); }} onContextMenu={(e) => { e.preventDefault(); markerMenu(e, m.id); }}>
                    {renamingMarker === m.id ? (
                      <input class="sq-marker-rename" aria-label="Marker name" value={m.name} ref={(el) => el?.focus()}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); if (e.key === "Escape") setRenamingMarker(null); }}
                        onBlur={(e) => { const v = (e.currentTarget as HTMLInputElement).value; setRenamingMarker(null); if (v.trim() && v !== m.name) runSeq("Rename marker", (q) => renameMarker(q, m.id, v)); }} />
                    ) : (
                      m.name
                    )}
                  </div>
                );
              })}
            </div>
            <div class="sq-loops-row" title="Drag to add a loop · double-click to add a hold point" onPointerDown={pressLoopsRow} onDblClick={(e) => writable && runWith("Add hold point", (q) => addLoop(q, snapAt(timeAt(e), e), snapAt(timeAt(e), e)), (r) => select(selectLoop(sel, r.id)))}>
              {s.loops.map((l) => {
                if (!visible(l.start, l.end)) return null;
                const x = toPx(l.start), w = toPx(l.end) - x;
                const hold = l.start === l.end;
                const name = loopName(s, l.id);
                return (
                  <div key={l.id} class={`sq-seq-loop${hold ? " hold" : ""}${sel.loop === l.id ? " selected" : ""} ${l.active}`} style={{ left: `${x}px`, width: `${hold ? 12 : Math.max(14, w)}px` }}
                    role="button" aria-label={hold ? `${name} at ${l.start.toFixed(2)} s` : `${name} ${l.start.toFixed(2)}–${l.end.toFixed(2)} s`}
                    title={hold ? `${name} · ${activeText(l)} · the playhead parks here while active` : `${name} · ${activeText(l)} · ${fmt(l.start)} – ${fmt(l.end)}`}
                    tabIndex={0} aria-pressed={sel.loop === l.id} onKeyDown={(e) => e.target === e.currentTarget && !keyboardMenu(e, (m) => loopMenu(m, l.id)) && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), e.stopPropagation(), select(selectLoop(sel, l.id)))}
                    onPointerDown={(e) => pressLoop(e, l.id, "body")} onDblClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); loopMenu(e, l.id); }}>
                    {!hold && <span class="sq-cap start" title="Drag to move the loop start" onPointerDown={(e) => pressLoop(e, l.id, "start")} />}
                    <SeqIcon name={activeIcon(l.active)} size={12} class={`sq-lic${l.active === "parameter" && !l.binding ? " warn" : ""}`} />
                    {!hold && <span class="sq-loop-text">{name}</span>}
                    <span class="sq-cap end" title={hold ? "Drag to stretch into a loop" : "Drag to move the loop end"} onPointerDown={(e) => pressLoop(e, l.id, "end")} />
                  </div>
                );
              })}
            </div>
            <SequenceRuler view={view} width={width} format={format} timeCtx={timeCtx} length={length} onScrub={(t) => !playback.peek() && (seqPlayhead.value = Math.max(0, t))} />
            {endX <= width && <div class="sq-pastend top" style={{ left: `${Math.max(0, endX)}px` }} aria-hidden="true" />}
            {endX >= 0 && endX <= width && (
              <div class="sq-end-handle" style={{ left: `${endX}px` }} role="slider" tabIndex={0} aria-label="Sequence end" aria-valuemin={0.1} aria-valuenow={length} aria-valuetext={fmt(length)}
                title={`Sequence end ${fmt(length)} · drag to change`} onPointerDown={pressEnd}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  e.preventDefault();
                  e.stopPropagation();
                  const d = nudgeStep(snap, s.tempo) * (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
                  runSeq("Sequence length", (q) => setSequenceLength(q, Math.max(0.1, length + d)));
                }} />
            )}
            {playhead >= view.start && playhead <= view.end && (
              <>
                <div class="sq-ph-line" style={{ left: `${toPx(playhead)}px` }} aria-hidden="true" />
                <div class="sq-ph-tri" style={{ left: `${toPx(playhead)}px` }} aria-hidden="true" />
              </>
            )}
          </div>
        </div>
        {format === "bars" && s.tempo && (
          <div class="sq-row sq-tempo-row">
            <div class="sq-tempo-head"><span class="sq-cap-text">Tempo</span></div>
            <div class="sq-lane sq-tempo-lane">
              <div class="sq-tempo-line" aria-hidden="true" />
              <span class="sq-tempo-text">{s.tempo.bpm} BPM · {s.tempo.meter}</span>
            </div>
          </div>
        )}
        <div class="sq-rows" ref={rowsRef}>
          {rows.map((r) => {
            const t = r.track;
            const silent = t.mute || (anySolo && !t.solo);
            const vol = t.automation.find((a) => a.target === "volume" && !a.bypass);
            const zones = crossfadeZones(t, sourceOf);
            return (
              <div key={t.id} class={`sq-track-block${reorder?.from === r.ti ? " dragging" : ""}${reorder && reorder.to === r.ti && reorder.from !== r.ti ? (reorder.to > reorder.from ? " drop-after" : " drop-before") : ""}`}>
                <div class="sq-row" style={{ height: `${r.h}px` }}>
                  <TrackHeader
                    track={t}
                    selected={(sel.focus === "track" && sel.track === t.id) || sel.clips.some((id) => findClip(s, id)?.track.id === t.id)}
                    writable={writable}
                    lanesOpen={seqOpenLanes.value.has(t.id)}
                    height={r.h}
                    volumeNow={vol ? { value: evalCurve(vol.curve, isTimeInput(vol.input) ? playhead : (values[(vol.input as { parameter: string }).parameter] ?? 0)), by: isTimeInput(vol.input) ? "the timeline" : (vol.input as { parameter: string }).parameter } : null}
                    onPress={(e) => pressHeader(e, r.ti)}
                    onMenu={(e) => trackMenu(e, t.id)}
                    onToggle={(field) => runSeq(field === "enabled" ? (t.enabled ? "Disable track" : "Enable track") : field === "mute" ? (t.mute ? "Unmute" : "Mute") : t.solo ? "Unsolo" : "Solo", (q) => setTrack(q, t.id, { [field]: !t[field] }))}
                    onToggleLanes={() => {
                      const next = new Set(seqOpenLanes.peek());
                      if (next.has(t.id)) next.delete(t.id);
                      else next.add(t.id);
                      seqOpenLanes.value = next;
                    }}
                    onVolume={(v, d) => onVolume(t.id, v, d)}
                    onDelete={() => deleteTrack(t.id)}
                  />
                  <div class={`sq-lane${t.enabled ? "" : " disabled"}`} onPointerDown={(e) => pressLane(e, r.ti)} onContextMenu={(e) => laneMenu(e, r.ti)}
                    onPointerMove={(e) => seqRazor.value && setRazorAt(snapAt(timeAt(e), e))} onPointerLeave={() => setRazorAt(null)}>
                    {t.clips.map((c) => {
                      const src = sourceOf(c);
                      const len = clipLength(c, src);
                      if (!visible(c.at, c.at + len)) return null;
                      const x = toPx(c.at);
                      const shown = shownCurve(c.id);
                      const plan = clipPlan(c, src);
                      const band = loopBand(plan);
                      const looping = !!band && (band.active === "always" || (band.active === "held" && !playing?.released) || band.active === "parameter");
                      const voice = elapsedNow !== null && !c.sync && c.enabled && t.enabled && c.sample !== undefined ? voicePosition(c, src, elapsedNow - c.at, looping) : null;
                      return (
                        <TimelineClip
                          key={c.id}
                          clip={c}
                          track={t}
                          src={src}
                          peaks={c.sample !== undefined && audioView.wave ? props.peaksOf(c.sample) : null}
                          pcm={c.sample !== undefined && audioView.spec && props.pcmOf ? props.pcmOf(c.sample) : null}
                          view={audioView}
                          left={x}
                          width={toPx(c.at + len) - x}
                          height={r.h - 6}
                          selected={sel.clips.includes(c.id)}
                          silent={silent}
                          follows={!!clipFollows(s, c.id, sourceOf)}
                          razor={seqRazor.value}
                          playingHere={!!playing && playhead >= c.at && playhead < c.at + len}
                          voice={voice}
                          playlistType={typeof c.playlist === "string" ? props.loadPlaylist(c.playlist)?.type ?? null : typeof c.playlist === "object" ? c.playlist.type : null}
                          playlistCount={typeof c.playlist === "object" ? c.playlist.entries.length : null}
                          curve={shown ? { ...shown, keys: sel.points && "clip" in sel.points.owner && sel.points.owner.clip === c.id && sel.points.automation === shown.automation.id ? sel.points.keys : [] } : null}
                          onPress={(e, part) => pressOnClip(e, c.id, part)}
                          onDoubleClick={(e) => dblClickClip(e, c.id)}
                          onMenu={(e) => clipMenu(e, c.id)}
                          onHover={(e) => hoverClip(e, c.id)}
                          onPointPress={(i, e) => shown && pressPoint(e, { clip: c.id }, shown.automation.id, i, r.h - 6)}
                          onPointDoubleClick={(i) => shown && runSeq("Delete automation point", (q) => deletePoints(q, { clip: c.id }, shown.automation.id, [i]))}
                          onPointMenu={(i, e) => shown && pointMenu(e, { clip: c.id }, shown.automation.id, i, clipName(c), len)}
                          onAdsrPress={(h, e, box) => pressAdsr(e, c.id, h, box)}
                          onKeySelect={(add) => select(clickClip(sel, c.id, t.id, { ctrl: add }))}
                        />
                      );
                    })}
                    {zones.map((z) => visible(z.from, z.to) && (
                      <div key={`${z.a}-${z.b}`} class="sq-xfade" style={{ left: `${toPx(z.from)}px`, width: `${Math.max(2, toPx(z.to) - toPx(z.from))}px` }}
                        title={`Crossfade ${Math.round((z.to - z.from) * 1000)} ms: ${clipName(t.clips.find((c) => c.id === z.a)!)} → ${clipName(t.clips.find((c) => c.id === z.b)!)}`}>
                        <svg viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0L10 10M10 0L0 10" vector-effect="non-scaling-stroke" /></svg>
                      </div>
                    ))}
                    {ghost && ghost.ti === r.ti && <div class={`sq-ghost${ghost.ok ? "" : " refused"}`} style={{ left: `${toPx(ghost.at)}px`, width: `${Math.max(8, toPx(ghost.at + ghost.length) - toPx(ghost.at))}px` }}>{ghost.text}</div>}
                  </div>
                </div>
                {r.lanes.map((lane) => {
                  const a = t.automation.find((x) => x.id === lane.automation)!;
                  const spec = targetSpec(a.target, t.effects);
                  const time = isTimeInput(a.input);
                  const range = parameterLaneRange(a.input, a.curve, props.parameters);
                  const param = time ? null : (a.input as { parameter: string }).parameter;
                  const now = time ? playhead : (values[param!] ?? props.parameters.find((p) => p.name === param)?.default ?? 0);
                  const valueNow = evalCurve(a.curve, now);
                  const nm = spec?.name ?? a.target;
                  const toRange = (v: number) => (range ? ((v - range.min) / (range.max - range.min)) * width : 0);
                  return (
                    <div key={lane.automation} class="sq-row sq-auto-row" style={{ height: `${lane.h}px` }}>
                      <div class="sq-auto-head" style={{ height: `${lane.h}px` }}>
                        <div class="sq-auto-line">
                          <span class={`sq-auto-name${a.bypass ? " off" : ""}`} title={a.target}>{nm}</span>
                          <span class="sq-auto-value">{spec ? valueText(valueNow, spec.unit, spec.bool) : ""}</span>
                          <button type="button" class="sq-ib" aria-label={`Edit ${nm} curve`} title="Open in the curve editor" onClick={() => openCurves({ track: t.id }, length, t.name, a.target)}><Icon name="edit" size={12} /></button>
                          <button type="button" class="sq-ib danger" aria-label={`Delete ${nm} automation`} title="Delete this automation (Ctrl/⌘+Z to undo)" disabled={!writable} onClick={() => runSeq("Delete automation", (q) => removeAutomation(q, { track: t.id }, a.id))}><Icon name="trash" size={12} /></button>
                        </div>
                        <select class="kit-select sq-driven-by" aria-label={`${nm} driven by`} title="What drives this curve: the timeline or a game parameter" disabled={!writable} value={param ?? ""}
                          onChange={(e) => {
                            const v = (e.currentTarget as HTMLSelectElement).value;
                            const def = props.parameters.find((p) => p.name === v);
                            const r2 = def ? parameterLaneRange({ parameter: v }, [], props.parameters)! : null;
                            runSeq(`${nm} driven by ${v || "time"}`, (q) => setDrivenBy(q, { track: t.id }, a.id, v ? { parameter: v } : "sequenceTime", r2 ? r2.min : 0, r2 ? r2.max : length));
                          }}>
                          <option value="">Time</option>
                          {props.parameters.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                          {param && !props.parameters.some((p) => p.name === param) && <option value={param}>{param}</option>}
                        </select>
                      </div>
                      <div class="sq-lane sq-auto-lane" title={time ? `${nm} over the timeline · double-click to add a point` : `${nm} over ${param} (left to right: ${range?.min} – ${range?.max}) · double-click to add a point`} onDblClick={(e) => dblClickLane(e, t.id, a.id)}>
                        {spec && time && (
                          <CurveOverlay curve={a.curve} spec={spec} width={width} height={lane.h} toX={toPx} fromX={toT} selected={shownTrackLane(t.id, a.id)} muted={a.bypass} interactive
                            label={`${t.name} ${spec.name} automation`}
                            onPointPress={(i, e) => pressPoint(e, { track: t.id }, a.id, i, lane.h)}
                            onPointDoubleClick={(i) => runSeq("Delete automation point", (q) => deletePoints(q, { track: t.id }, a.id, [i]))}
                            onPointMenu={(i, e) => pointMenu(e, { track: t.id }, a.id, i, t.name, length)} />
                        )}
                        {spec && !time && range && (
                          <>
                            <CurveOverlay curve={a.curve} spec={spec} width={width} height={lane.h} toX={toRange} fromX={(px) => range.min + (px / Math.max(1, width)) * (range.max - range.min)} selected={shownTrackLane(t.id, a.id)} muted={a.bypass} interactive
                              label={`${t.name} ${spec.name} by ${range.name}, from ${range.min} to ${range.max}`}
                              onPointPress={(i, e) => pressPoint(e, { track: t.id }, a.id, i, lane.h, (dx) => (dx / Math.max(1, width)) * (range.max - range.min))}
                              onPointDoubleClick={(i) => runSeq("Delete automation point", (q) => deletePoints(q, { track: t.id }, a.id, [i]))}
                              onPointMenu={(i, e) => pointMenu(e, { track: t.id }, a.id, i, t.name, length)} />
                            <span class="sq-param-end min">{range.name} {range.min}</span>
                            <span class="sq-param-end max">{range.max}</span>
                            <div class="sq-pmark" style={{ left: `${Math.max(0, Math.min(width, toRange(now)))}px` }} title={`${range.name} now: ${now}`} aria-hidden="true" />
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div class="sq-overlay" style={{ left: `${HEADER_WIDTH}px`, height: `${Math.max(height, 1)}px` }}>
            {s.loops.map((l) => visible(l.start, l.end) && (l.start === l.end
              ? <div key={l.id} class={`sq-g-hold${sel.loop === l.id ? " on" : ""}`} style={{ left: `${toPx(l.start)}px` }} />
              : <div key={l.id} class={`sq-g-loop${sel.loop === l.id ? " on" : ""}`} style={{ left: `${toPx(l.start)}px`, width: `${toPx(l.end) - toPx(l.start)}px` }} />))}
            {s.markers.map((m) => visible(m.at, m.at) && <div key={m.id} class={`sq-g-marker ${m.type ?? "note"}`} style={{ left: `${toPx(m.at)}px` }} />)}
            {endX <= width && <div class="sq-pastend" style={{ left: `${Math.max(0, endX)}px` }} />}
            {playhead >= view.start && playhead <= view.end && <div class={`sq-ph-line${playing ? " playing" : ""}`} style={{ left: `${toPx(playhead)}px` }} />}
            {seqRazor.value && razorAt !== null && <div class="sq-razor-line" style={{ left: `${toPx(razorAt)}px` }} />}
            {marquee && (() => {
              const [a, b] = marquee.t0 <= marquee.t1 ? [marquee.t0, marquee.t1] : [marquee.t1, marquee.t0];
              const [lo, hi] = marquee.r0 <= marquee.r1 ? [marquee.r0, marquee.r1] : [marquee.r1, marquee.r0];
              const top = rows[lo]?.y ?? 0, bottom = (rows[hi]?.y ?? 0) + (rows[hi]?.h ?? 0);
              return <div class="sq-marquee" style={{ left: `${toPx(a)}px`, width: `${toPx(b) - toPx(a)}px`, top: `${top}px`, height: `${bottom - top}px` }} />;
            })()}
          </div>
        </div>
        <div class={`sq-fill${fillOver ? " over" : ""}`} title="Drop a sample here to add it on a new track" onPointerDown={(e) => e.button === 0 && select({ ...EMPTY_SELECTION })}>
          <div class="sq-fill-head">
            <button type="button" class="sq-ibtn" aria-label="Add audio track" title="Add audio track" disabled={!writable} onPointerDown={(e) => e.stopPropagation()} onClick={() => addTrackOf("audio")}><Icon name="plus" size={14} /></button>
          </div>
          <div class="sq-fill-lane">
            {s.tracks.length === 0 && <span class="sq-faint sq-fill-hint">No tracks. Drop a sample here, or add a track with +.</span>}
            {endX <= width && <div class="sq-pastend" style={{ left: `${Math.max(0, endX)}px` }} />}
            {ghost && ghost.ti === "new" && <div class="sq-ghost new" style={{ left: `${toPx(ghost.at)}px`, width: `${Math.max(40, toPx(ghost.at + ghost.length) - toPx(ghost.at))}px` }}>{ghost.text}</div>}
          </div>
        </div>
      </div>
      <div class="sq-zoom-strip">
        <div class="sq-zoom" role="group" aria-label="Zoom">
          <button type="button" class="sq-ibtn small" aria-label="Zoom out" title="Zoom out (−) · Shift + wheel or a sideways swipe scrolls" disabled={pctZoom <= 100} onClick={() => zoom(1 / 1.5)}><Icon name="zoomOut" size={13} /></button>
          <button type="button" class="sq-ibtn small" aria-label="Zoom in" title="Zoom in at the playhead (=) · Ctrl/⌘ + wheel or pinch zooms at the pointer" onClick={() => zoom(1.5)}><Icon name="zoomIn" size={13} /></button>
          <button type="button" class="sq-ibtn small" aria-label="Zoom to selection" title="Zoom to the selection (Z)" onClick={zoomSel}><SeqIcon name="zoomSel" size={13} /></button>
          <button type="button" class="sq-ibtn small" aria-label="Fit" title="Fit the whole sequence (0) · or double-click the scrollbar" disabled={!seqView.value} onClick={fit}><Icon name="fit" size={13} /></button>
          <span class="sq-zoom-pct">{pctZoom}%</span>
        </div>
        <div class="sq-scrollbar" role="scrollbar" aria-orientation="horizontal" aria-label="Scroll and zoom the timeline" aria-valuenow={Math.round(thumb.left * 100)}
          title={`Showing ${fmt(view.start)} – ${fmt(view.end)} of ${fmt(length)} · drag to scroll · drag an end to zoom · double-click to fit`}
          onDblClick={fit}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget || e.button !== 0) return;
            const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const f = (e.clientX - bar.left) / Math.max(1, bar.width);
            seqView.value = viewFromThumb(f - thumb.width / 2, thumb.width, limit);
          }}>
          <div class="sq-thumb" style={{ left: `${thumb.left * 100}%`, width: `${Math.max(1, thumb.width * 100)}%` }}
            onPointerDown={(e) => {
              const bar = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
              const part = (e.target as HTMLElement).classList.contains("start") ? "start" : (e.target as HTMLElement).classList.contains("end") ? "end" : "body";
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
            <span class="sq-thumb-edge start" title="Drag to zoom" />
            <span class="sq-thumb-edge end" title="Drag to zoom" />
          </div>
        </div>
      </div>
      <div class="sq-readout" role="status" aria-label="At the playhead">
        <span class="sq-faint">At {fmt(playhead)}:</span>
        {readout.writing && <span class="sq-chip-r danger">● Writing automation</span>}
        {readout.run && <span class="sq-chip-r accent">{readout.run}</span>}
        {playing && readout.tracks.map((t, i) => (
          <span key={i} class={`sq-ro-track ${t.tone}`}><strong>{t.name}</strong> {t.state}</span>
        ))}
      </div>
      {hover && hoverClipAt && (
        <ClipHoverCard clip={hoverClipAt.clip} track={hoverClipAt.track} src={sourceOf(hoverClipAt.clip)} follows={!!clipFollows(s, hoverClipAt.clip.id, sourceOf)} x={hover.x} y={hover.y} time={fmt} />
      )}
      {menu && <ContextMenu entries={menu.entries} at={menu.at} label={menu.label} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** A value with its unit, as a lane header reads it ("-24.0 dB", "5.6 kHz", "On"). */
function valueText(v: number, unit: string, bool?: boolean): string {
  if (bool) return v >= 0.5 ? "On" : "Off";
  if (unit === "Hz" && v >= 1000) return `${(v / 1000).toFixed(1)} kHz`;
  return `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}${unit ? ` ${unit}` : ""}`;
}

// --- the ruler ---------------------------------------------------------------------------------------------------------

function SequenceRuler(props: { readonly view: { start: number; end: number }; readonly width: number; readonly format: TimeFormat; readonly timeCtx: { rate: number; bpm: number | null; meter: string | null }; readonly length: number; onScrub(t: number): void }) {
  const { view, width } = props;
  const marks = rulerMarks(view, width, props.format, props.timeCtx);
  const at = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return pxToTime(e.clientX - r.left, view, r.width);
  };
  return (
    <div class="sq-ruler" role="slider" tabIndex={-1} aria-label="Sequence time" aria-valuemin={0} aria-valuemax={props.length} title="Click or drag to move the playhead"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        props.onScrub(at(e));
      }}
      onPointerMove={(e) => (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId) && props.onScrub(at(e))}>
      {marks.map((m, i) => {
        const x = timeToPx(m.t, view, width);
        return (
          <span key={m.t}>
            <span class="sq-tick-label" style={{ left: `${x}px`, transform: i === 0 && x < 4 ? "none" : "translateX(-50%)" }}>{m.label}</span>
            <span class="sq-tick" style={{ left: `${x}px` }} />
          </span>
        );
      })}
    </div>
  );
}

// --- the playhead readout and its Time display menu ------------------------------------------------------------------

function TimeDisplay(props: { readonly format: TimeFormat; readonly rawFormat: TimeFormat; readonly text: string; readonly hasTempo: boolean; readonly timeCtx: { rate: number; bpm: number | null; meter: string | null } }) {
  const [open, setOpen] = useState<Element | null>(null);
  const item = (id: TimeFormat, label: string): MenuEntry => ({
    id, label, checked: props.format === id, note: formatTime(0, id, { ...props.timeCtx, bpm: props.timeCtx.bpm ?? 120 }),
    disabled: id === "bars" && !props.hasTempo, title: id === "bars" && !props.hasTempo ? "Needs a tempo: set one in the Tempo menu" : undefined,
    run: () => (seqTimeFormat.value = id),
  });
  return (
    <div class="sq-readout-head">
      <span class="sq-playhead-time" title="Playhead">{props.text}</span>
      <button type="button" class="sq-tcb" aria-haspopup="menu" aria-expanded={!!open} aria-label="Time display" title="Time display: timecode, samples or bars (also sets the ruler and grid)" onClick={(e) => setOpen(open ? null : e.currentTarget)}>
        <SeqIcon name="caret" size={10} />
      </button>
      {open && <ContextMenu at={open} label="Time display" onClose={() => setOpen(null)} entries={[{ kind: "group", label: "Time display" }, item("timecode", "Timecode"), item("samples", "Samples"), item("bars", "Bars")]} />}
    </div>
  );
}

// --- the toolbar -------------------------------------------------------------------------------------------------------

interface ToolbarProps {
  readonly s: SequenceSettings;
  readonly writable: boolean;
  readonly format: TimeFormat;
  readonly back?: { readonly name: string; open(): void };
  readonly taps: number;
  onAddTrack(kind: "audio" | "playlist"): void;
  onAddLoop(): void;
  onAddHold(): void;
  onTempo(bpm: number | null): void;
  onTap(): void;
  onMeter(meter: string): void;
}

/** The audio view toggles: either flips, but one view always stays on. */
function toggleView(v: { readonly wave: boolean; readonly spec: boolean }, which: "wave" | "spec"): { wave: boolean; spec: boolean } {
  const next = { ...v, [which]: !v[which] };
  return next.wave || next.spec ? next : { ...v };
}

function Toolbar(props: ToolbarProps) {
  const { s, writable } = props;
  const [trackMenu, setTrackMenu] = useState<Element | null>(null);
  const [tempoPop, setTempoPop] = useState<Element | null>(null);
  const [snapPop, setSnapPop] = useState<Element | null>(null);
  const snap = seqSnap.value;
  const snapOn = snap.mode !== "off";
  const snapText = snapLabel(snap, props.format, s.tempo);
  const v = seqAudioView.value;
  const write = seqWrite.value;
  const viewTip = (name: string, on: boolean, other: boolean) => `${name} · ${on ? (other ? "on, click to hide" : "on (one view stays on)") : "click to show"}`;
  return (
    <div class="sq-toolbar" role="toolbar" aria-label="Sequence tools">
      <div class="sq-split" role="group" aria-label="Add track">
        <button type="button" class="sq-sbtn main" disabled={!writable} aria-label="Add audio track" title="Add audio track" onClick={() => props.onAddTrack("audio")}><SeqIcon name="addTrack" size={15} /></button>
        <button type="button" class="sq-sbtn caret" disabled={!writable} aria-label="Add track" aria-haspopup="menu" aria-expanded={!!trackMenu} title="Add a track of another type" onClick={(e) => setTrackMenu(trackMenu ? null : e.currentTarget)}><SeqIcon name="caret" size={10} /></button>
      </div>
      {trackMenu && (
        <ContextMenu at={trackMenu} label="Add track" onClose={() => setTrackMenu(null)}
          entries={[
            { id: "audio", label: "Audio track", note: "samples", title: "A track of clips, each one use of a sample", run: () => props.onAddTrack("audio") },
            { id: "playlist", label: "Playlist track", note: "playlists", title: "A track that plays a playlist (its clips trigger the playlist)", run: () => props.onAddTrack("playlist") },
          ]} />
      )}
      <button type="button" class="sq-ibtn" disabled={!writable} aria-label="Add loop" title="Add loop at the playhead · or drag in the Loops row" onClick={props.onAddLoop}><SeqIcon name="addLoop" size={15} /></button>
      <button type="button" class="sq-ibtn" disabled={!writable} aria-label="Add hold point" title="Add hold point at the playhead: a zero-length loop where the playhead parks while it is active · or double-click the Loops row" onClick={props.onAddHold}><SeqIcon name="addHold" /></button>
      <button type="button" class={`sq-ibtn${seqRazor.value ? " on" : ""}`} aria-pressed={seqRazor.value} aria-label="Razor" title="Razor (C): click a clip to split it · Esc to stop" onClick={() => (seqRazor.value = !seqRazor.peek())}><Icon name="razor" size={14} /></button>
      <button type="button" class={`sq-ibtn write${write ? " on" : ""}`} aria-pressed={write} aria-label="Write automation"
        title={write ? "Write automation is armed: moving a control writes its curve at the playhead (W to disarm)" : "Write automation (W): arm, then move controls while playing to record their curves"}
        onClick={() => (seqWrite.value = !seqWrite.peek())}><Icon name="record" size={10} /></button>
      <button type="button" class="sq-ibtn" aria-label="Playlists" title={props.back ? `Playlists: back to ${props.back.name} · transitions between states are Switch change rules` : "Playlists: transitions between states are Switch change rules"}
        onClick={(e) => (props.back ? props.back.open() : (e.currentTarget.ownerDocument.querySelector<HTMLElement>("[data-pl-key][aria-selected=true], [data-pl-key]")?.focus()))}><SeqIcon name="link" size={15} /></button>
      <span class="sq-spacer" />
      <div class="sq-views" role="group" aria-label="Audio view">
        <button type="button" class={`sq-sbtn solo${v.wave ? " on" : ""}`} aria-pressed={v.wave} aria-label="Waveform" title={viewTip("Waveform: level over time", v.wave, v.spec)} onClick={() => (seqAudioView.value = toggleView(v, "wave"))}><SeqIcon name="wave" /></button>
        <button type="button" class={`sq-sbtn solo${v.spec ? " on" : ""}`} aria-pressed={v.spec} aria-label="Spectrogram" title={viewTip("Spectrogram: level by frequency band over time", v.spec, v.wave)} onClick={() => (seqAudioView.value = toggleView(v, "spec"))}><SeqIcon name="spectrogram" /></button>
      </div>
      <button type="button" class={`sq-sbtn solo tempo${s.tempo ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={!!tempoPop} aria-label="Tempo" title={s.tempo ? `Tempo ${s.tempo.bpm} BPM, ${s.tempo.meter}` : "No tempo: set one to use bars"} onClick={(e) => setTempoPop(tempoPop ? null : e.currentTarget)}>
        <SeqIcon name="tempo" size={13} /><span class="sq-tnum">{s.tempo ? `${s.tempo.bpm} · ${s.tempo.meter}` : "No tempo"}</span><SeqIcon name="caret" size={9} />
      </button>
      {tempoPop && <TempoPopover anchor={tempoPop} tempo={s.tempo} writable={writable} taps={props.taps} onTempo={props.onTempo} onTap={props.onTap} onMeter={props.onMeter} onClose={() => setTempoPop(null)} />}
      <div class="sq-split" role="group" aria-label="Snapping">
        <button type="button" class={`sq-sbtn main${snapOn ? " on" : ""}`} aria-pressed={snapOn} aria-label="Snap"
          title={snapOn ? `Snapping on · every ${snapText}${snap.edges ? " · and to edges" : ""} (click to turn off)` : "Snapping off (click to turn on)"}
          onClick={() => (seqSnap.value = toggleSnap(seqSnap.peek(), props.format === "bars" ? "bars" : props.format))}>
          <SeqIcon name="snap" size={13} /><span class="sq-tnum">{snapText}</span>
        </button>
        <button type="button" class="sq-sbtn caret" aria-haspopup="dialog" aria-expanded={!!snapPop} aria-label="Snap settings" title="Snap increment" onClick={(e) => setSnapPop(snapPop ? null : e.currentTarget)}><SeqIcon name="caret" size={10} /></button>
      </div>
      {snapPop && <SnapPopover anchor={snapPop} snap={snap} format={props.format} tempo={s.tempo} onSnap={(n) => (seqSnap.value = n)} onClose={() => setSnapPop(null)} />}
    </div>
  );
}
