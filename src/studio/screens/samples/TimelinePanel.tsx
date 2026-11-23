// The Sample panel (the screen's fixed panel; the prototype's timeline, spec §4.1.5–4.1.6): one toolbar row (Save split,
// Undo / Redo / History, Source version, A/B, Root note, Normalize, Add marker, Add loop, Razor, Snap), the changed-on-
// disk banner, then tracks with a 168 px header column: Markers (flag-shaped points and capped ranges packed into rows,
// the ghost "Marker N" on hover), the ruler with the big playhead readout, its Time display caret and the tempo button,
// the loop row (Pickup / Loop N / Link / Tail) and the trim row, and the Audio lane (Waveform and/or Spectrogram, the
// baked effects drawn into it, the playing band, snippets, cut lines with Tape, Close gap), dotted guides from every
// marker and loop edge, the zoom group with the range scrollbar, the readout strip and the warnings. Everything is
// drawn in timeline time (closed gaps removed, `sampleTime.ts`); edits store source time. Drags are one coalesced step.
import { Fragment, type ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import type { ReservedRange, SampleEdits, SampleLoop, SampleMarker } from "../../../engine/audio/sample/types";
import { markColourOf } from "../../../engine/audio/markColour";
import { currentProject } from "../../../editor/state";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { FloatingPortal } from "../../../editor/ui/FloatingPortal";
import { HistoryPopover } from "../../../editor/ui/HistoryPopover";
import { formatKeys, isMacPlatform } from "../../../editor/ui/keyCombo";
import { Panel } from "../../../editor/ui/panel/Panel";
import { usePopover } from "../../../editor/ui/popover";
import { Icon } from "../../components/Icon";
import { TimeRuler } from "../../components/TimeRuler";
import { formatTime, type TimeContext } from "../../components/timeRulerModel";
import { Waveform } from "../../components/Waveform";
import { clampView, fitView, timeToX, waveColumns, xToTime, type WaveBand } from "../../components/waveformModel";
import { useElementWidth } from "../../components/useElementWidth";
import * as act from "./sampleActions";
import {
  addLoop, addMarker, closeGap, convertMarker, deleteMarker, hasFixedName, isHold, loopName, MARKER_TYPE_NAMES, MARKER_TYPE_ORDER, moveLoop, moveMarker, nextMarkerName, refusalOf, removeLoop, resetTrim,
  setRangeLook, setSnapToZero, setTrim, slideLoop, snippets, sourceTime, tapeSnippet, toggleSnippet, updateLoop, updateMarker, viewTime, type SampleEdit,
} from "./sampleEditing";
import { effectSpec } from "../../../engine/audio/effects/catalogue";
import { detachMarker, fileOrigin, markerDiff, revertLoop, revertMarker } from "./sampleFile";
import { lengthOf, loudnessOf, pcmNow, pcmOf, peaksFailure, peaksOf, wavMetadataOf, type SampleSession } from "./sampleSession";
import type { DetectKind } from "../../../engine/audio/sample/detect/detect";
import { detectInto } from "./sampleDetect";
import { editedLength, trimOf } from "./sampleTime";
import {
  estimateLabelWidth, liveSelection, loopLabel, loopRegions, MARKER_PRESETS, MARKER_ROWS_SHOWN, markerColour, musicalSpans, nextMarker, packMarkerRows, regionAt, sampleWarnings, selectionSpan,
  shortSeconds, snapTime, snippetMenu, snippetUnder, trimHoldingMarkers, fitToSource, noteLine, RANGE_PRESETS, rangeLook, type SampleSelection, type SnippetAction,
} from "./sampleView";
import { nearestZeroCrossing, seamJump } from "./seam";
import { NormalizePopover, RootPopover, SnapSplit, TempoPopover, TimeDisplayCaret } from "./SampleTools";
import { abSource, dialog, fxFocus, fxPreview, hoverTime, openSession, playheadTime, razorOn, savedColours, select, selection, snapSetting, timeFormat, viewSpan, waveViews } from "./samplesState";
import { playing } from "./sampleTransport";
import { diskChange } from "./sampleDisk";
import { nameOf, shortLength } from "./sampleLibrary";
import { SaveSplitButton } from "./SaveSplitButton";
import { SampleIcon, type SampleIconName } from "./sampleIcons";
import { VersionMenu } from "./VersionMenu";
import { previewOf } from "./samplePreview";
import { effectEdits } from "./sampleEffects";
import { ClipTicks, clipRuns, effectChip, FxChips, SpectrogramView, WaveOutline, type FxChip } from "./WaveOverlays";

/** A marker row's height, px (the prototype's `.mrow`). */
const ROW_PX = 20;
/** The marker area: three rows and a 4 px top pad (more rows scroll). */
const MARKER_AREA_PX = MARKER_ROWS_SHOWN * ROW_PX + 4;
const RULER_PX = 30;
const RESERVED_ROW_PX = 20;

/** How near an edge (px) a press grabs it rather than the body: wider for a finger. */
const edgePx = (e: PointerEvent, mouse: number) => (e.pointerType === "touch" || e.pointerType === "pen" ? Math.max(mouse, 14) : mouse);

/**
 * Drag along a lane: `move` gets the timeline time under the pointer; `done` on release. The pressed element captures
 * the pointer (so a finger or pen keeps the drag when it leaves it), and a cancelled pointer ends the drag too.
 */
function drag(e: PointerEvent, lane: HTMLElement, view: { start: number; end: number }, move: (v: number, done: boolean) => void): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const grabbed = e.currentTarget instanceof Element ? e.currentTarget : null;
  try {
    grabbed?.setPointerCapture(e.pointerId);
  } catch {
    // The pointer is already gone (a synthetic or ended press): the window listeners still follow it.
  }
  const r = lane.getBoundingClientRect();
  const at = (ev: PointerEvent) => xToTime(ev.clientX - r.left, view, r.width);
  const onMove = (ev: PointerEvent) => ev.pointerId === e.pointerId && move(at(ev), false);
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    move(at(ev), true);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

export function TimelinePanel() {
  const session = openSession.value;
  const project = currentProject.value;
  if (!session || !project) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="No sample open" icon={<Icon name="samples" size={28} />} body="Pick a sample in the Samples panel." />
      </Panel>
    );
  }
  return <Timeline session={session} />;
}

/** A compact toolbar icon button (the prototype's `.ibtn`). */
function IconTool(props: { icon: SampleIconName; label: string; title: string; pressed?: boolean; disabled?: boolean; onClick(): void }) {
  return (
    <button type="button" class={`smp-ibtn${props.pressed ? " on" : ""}`} aria-label={props.label} aria-pressed={props.pressed} title={props.title} disabled={props.disabled} onClick={props.onClick}>
      <SampleIcon name={props.icon} size={14} />
    </button>
  );
}

/** An inline Rename / Note editor at a point (the prototype's menu input): Enter keeps (Ctrl+Enter for a note), Escape drops. */
function InlineEdit(props: { at: { x: number; y: number }; label: string; value: string; multiline?: boolean; onKeep(text: string): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(props.value);
  usePopover(ref, true, { anchor: props.at, focusFirst: true, onDismiss: (why) => (why === "outside" ? props.onKeep(text) : props.onClose()) });
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (!props.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      props.onKeep(text);
    }
    e.stopPropagation();
  };
  return (
    <FloatingPortal>
      <div ref={ref} class="smp-popover smp-snm smp-inline-edit" role="dialog" aria-label={props.label}>
        <div class="smp-cap">{props.label}</div>
        {props.multiline ? (
          <textarea rows={4} value={text} aria-label={props.label} placeholder="Shown on hover" onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} onKeyDown={keys} />
        ) : (
          <input value={text} aria-label={props.label} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} onKeyDown={keys} />
        )}
        <div class="smp-tci-line smp-muted">{props.multiline ? "Ctrl+Enter keeps · Esc drops" : "Enter keeps · Esc drops"}</div>
      </div>
    </FloatingPortal>
  );
}

function Timeline(props: { session: SampleSession }) {
  const { session } = props;
  const project = session.project;
  const source = session.source.value;
  const e = session.edits.value;
  const sourceMips = peaksOf(project, source);
  const length = lengthOf(project, source);
  const failed = peaksFailure(project, source);
  const lanes = useRef<HTMLDivElement>(null);
  const markerScroll = useRef<HTMLDivElement>(null);
  const width = useElementWidth(lanes);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; label: string } | null>(null);
  const [editing, setEditing] = useState<{ x: number; y: number; label: string; value: string; multiline?: boolean; keep(text: string): void } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; row: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const mac = isMacPlatform();

  if (length === null) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title={nameOf(session.path)} body={failed ? `Couldn't read the audio: ${failed}` : "Reading the audio…"} />
      </Panel>
    );
  }
  const ro = session.readOnly;
  const len = editedLength(length, e.closedGaps);
  const view = clampView(viewSpan.value ?? fitView(len), len);
  const sel = liveSelection(selection.value, e, length);
  const rate = sourceMips?.rate ?? 48000;
  const ctx: TimeContext = { rate, bpm: e.tempo?.bpm, meter: e.tempo?.meter };
  const fmt = timeFormat.value;
  const v = (t: number) => viewTime(e, t);
  const x = (t: number) => timeToX(v(t), view, width);
  const pcm = e.snapToZero ? pcmNow(project, source) : null;
  /** A pointer's timeline time to a snapped source time. */
  const toSrc = (vt: number, zero = false) => {
    const t = sourceTime(e, snapTime(vt, snapSetting.value, ctx));
    return zero && pcm ? nearestZeroCrossing(pcm, t) : t;
  };
  const commit = (r: SampleEdit, coalesce = false) => session.commit(r, { coalesce });
  /** Detect (the Tempo and Root note popovers): the source audio, analysed on the detection worker, committed as one step. */
  const detect = async (kind: DetectKind) => detectInto(session, await pcmOf(project, session.source.peek()), kind);
  const [ta, tb] = trimOf(e, length);
  const seamPcm = pcmNow(project, source);
  const seams = new Map(seamPcm ? e.loops.filter((l) => !isHold(l)).map((l) => [l.id, seamJump(seamPcm, l.start, l.end)] as const) : []);
  const warnings = sampleWarnings(e, length, seams);
  const scope = selectionSpan(sel, e, length);
  const rows = packMarkerRows(e.markers, (t) => x(t), estimateLabelWidth);
  const rowCount = Math.max(MARKER_ROWS_SHOWN, ...[...rows.values()].map((r) => r + 1));
  const hiddenRows = Math.max(0, rowCount - MARKER_ROWS_SHOWN);
  const play = playing.value;
  const mine = play && play.path === session.path ? play : null;
  const playT = playheadTime.value;
  const disk = diskChange.value?.path === source ? diskChange.value : null;
  const wav = wavMetadataOf(project, source);
  const ab = abSource.value;
  // An effect hovered in Add effect previews at its defaults, on top of the chain (spec §4.1.7).
  const trying = fxPreview.value;
  const preview = previewOf(session, trying ? effectEdits.add(e, trying).next : e, trying ? null : fxFocus.value, ab);
  // What the lane shows: the render (the source as the outline), or under A/B the source (the render as the outline).
  const shown = ab ? sourceMips : preview.mips ?? sourceMips;
  const outline = ab ? previewOf(session, e, null, false).mips : preview.mips ? sourceMips : null;
  const views = waveViews.value;
  const selKey = (s: SampleSelection) => JSON.stringify(s);
  const isSel = (s: SampleSelection) => selKey(s) === selKey(sel);

  const bands: WaveBand[] = [
    ...e.loops.filter((l) => !isHold(l)).map((l) => ({ start: v(l.start), end: v(l.end), color: "--range-loop" })),
  ];
  // ADR 0350: the post-exit tail and the pre-entry, shaded under the waveform.
  const spans = musicalSpans(e, length);
  if (spans.tail) bands.push({ start: v(spans.tail[0]), end: v(spans.tail[1]), color: "--marker-exit", hatched: true, label: "Tail" });
  if (spans.preEntry) bands.push({ start: v(spans.preEntry[0]), end: v(spans.preEntry[1]), color: "--marker-exit", label: "Pre-entry" });

  const point = (ev: MouseEvent) => ({ x: ev.clientX, y: ev.clientY });

  // --- menus ---------------------------------------------------------------------------------------------------------

  const colourMenu = (current: number | string | undefined, set: (c: number | string | null) => void): MenuEntry[] => [
    { id: "c-default", label: "Default", checked: current === undefined, run: () => set(null) },
    ...MARKER_PRESETS.map((p) => ({ id: `c-${p.name}`, label: p.name, checked: current === p.series, run: () => set(p.series) })),
    ...savedColours.value.map((hex) => ({ id: `c-${hex}`, label: hex, checked: current === hex, run: () => set(hex) })),
    SEPARATOR,
    { id: "c-custom", label: "Custom colour…", title: "Pick any colour in the Inspector's colour row", run: () => undefined },
  ];

  const markerMenu = (m: SampleMarker, at: { x: number; y: number }) => {
    const diff = markerDiff(m);
    select({ kind: "marker", id: m.id });
    setMenu({
      ...at,
      label: `${m.name} menu`,
      entries: tidyEntries([
        { kind: "group", label: `${MARKER_TYPE_NAMES[m.type]} · ${hasFixedName(m.type) ? MARKER_TYPE_NAMES[m.type] : m.name}` },
        !hasFixedName(m.type) && { id: "rename", label: m.type === "cue" ? "Rename cue…" : "Rename…", hint: "F2", disabled: ro, run: () => setEditing({ ...at, label: m.type === "cue" ? "Cue name" : "Name", value: m.name, keep: (t) => (t.trim() && commit(updateMarker(e, m.id, { name: t.trim() })), setEditing(null)) }) },
        { id: "note", label: m.note ? "Edit note…" : "Add note…", disabled: ro, run: () => setEditing({ ...at, label: "Note", value: m.note ?? "", multiline: true, keep: (t) => (commit(updateMarker(e, m.id, { note: t })), setEditing(null)) }) },
        { kind: "group", label: "Type" },
        ...MARKER_TYPE_ORDER.map((t) => ({ id: `type-${t}`, label: MARKER_TYPE_NAMES[t], checked: m.type === t, disabled: ro, run: () => commit(updateMarker(e, m.id, { type: t })) })),
        m.type === "note" && SEPARATOR,
        m.type === "note" && { id: "colour", label: "Colour", disabled: ro, submenu: colourMenu(m.color, (c) => commit(updateMarker(e, m.id, { color: c }))), run: () => undefined },
        SEPARATOR,
        m.type === "note" && { id: "convert", label: m.end !== undefined ? "Convert to point" : "Convert to range", disabled: ro, run: () => commit(convertMarker(e, m.id, length)) },
        { id: "play", label: "Play from here", run: () => act.togglePlay({ kind: "marker", id: m.id }) },
        m.file && { id: "revert", label: "Revert to file", disabled: ro || diff.length === 0, run: () => commit(revertMarker(e, m.id)) },
        m.file && { id: "detach", label: "Detach from file", disabled: ro, run: () => commit(detachMarker(e, m.id)) },
        SEPARATOR,
        { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: ro, run: () => (commit(deleteMarker(e, m.id)), select({ kind: "sample" })) },
      ]),
    });
  };

  const loopMenu = (l: SampleLoop, at: { x: number; y: number }) => {
    const set = (patch: Parameters<typeof updateLoop>[2]) => commit(updateLoop(e, l.id, patch));
    select({ kind: "loop", id: l.id });
    setMenu({
      ...at,
      label: `${loopName(e, l.id)} menu`,
      entries: tidyEntries([
        { kind: "group", label: loopName(e, l.id) },
        { id: "note", label: l.note ? "Edit note…" : "Add note…", disabled: ro, run: () => setEditing({ ...at, label: "Note", value: l.note ?? "", multiline: true, keep: (t) => (set({ note: t }), setEditing(null)) }) },
        { id: "play", label: "Play loop", run: () => act.togglePlay({ kind: "loop", id: l.id }) },
        { kind: "group", label: "Active" },
        ...(["always", "held", "parameter"] as const).map((a) => ({ id: a, label: { always: "Always", held: "While held", parameter: "Parameter" }[a], checked: l.active === a, disabled: ro, run: () => set({ active: a }) })),
        { kind: "group", label: "Repeats" },
        ...[0, 1, 2, 4].map((n) => ({ id: `rep${n}`, label: n === 0 ? "∞ until it stops being active" : `${n} time${n === 1 ? "" : "s"}`, checked: l.count === n, disabled: ro, run: () => set({ count: n }) })),
        { kind: "group", label: "Direction" },
        ...(["forward", "pingPong", "backward"] as const).map((d) => ({ id: d, label: { forward: "Forward", pingPong: "Alternating", backward: "Backward" }[d], checked: l.direction === d, disabled: ro, run: () => set({ direction: d }) })),
        l.active !== "always" && { kind: "group", label: "On exit" },
        ...(l.active !== "always"
          ? [
              ...(["finish", "jump", "crossfade"] as const).map((x) => ({ id: `exit-${x}`, label: { finish: "Finish the pass", jump: "Jump now", crossfade: "Crossfade" }[x], checked: l.exit === x, disabled: ro, run: () => set({ exit: x }) })),
              { id: "reentry", label: "Re-enter if active again", checked: l.reentry === "reenter", disabled: ro, run: () => set({ reentry: l.reentry === "reenter" ? "ignore" : "reenter" }) },
            ]
          : []),
        SEPARATOR,
        l.file && { id: "revert", label: "Revert to file", disabled: ro, run: () => commit(revertLoop(e, l.id)) },
        { id: "remove", label: "Remove loop", hint: "Del", danger: true, disabled: ro, run: () => (commit(removeLoop(e, l.id)), select({ kind: "sample" })) },
      ]),
    });
  };

  /** Select a reserved range and put the caret in its Inspector note. */
  const focusRangeNote = (range: ReservedRange) => {
    select({ kind: range });
    const name = { trim: "Trim", pickup: "Pickup", tail: "Tail" }[range];
    requestAnimationFrame(() => (lanes.current?.ownerDocument ?? document).querySelector<HTMLElement>(`[aria-label="${name} note"]`)?.focus());
  };

  /** ADR 0362 item 4: a reserved range's Colour submenu (its default first) and its note, in the Inspector. */
  const rangeLookEntries = (range: ReservedRange): (MenuEntry | false)[] => {
    const look = rangeLook(e, range);
    const defaultCss = rangeLook({}, range).css;
    const swatches = [{ name: "Default", color: defaultCss }, ...RANGE_PRESETS];
    return [
      SEPARATOR,
      {
        id: "colour", label: "Colour", disabled: ro, run: () => {},
        submenu: swatches.map((p) => ({ id: `colour-${p.name}`, label: p.name, checked: look.css === p.color, run: () => void commit(setRangeLook(session.edits.peek(), range, { colour: p.color === defaultCss ? null : markColourOf(p.color) })) })),
      },
      { id: "note", label: look.note ? "Edit note…" : "Add note…", disabled: ro, run: () => focusRangeNote(range) },
      look.note !== undefined && { id: "clearNote", label: "Clear note", disabled: ro, run: () => commit(setRangeLook(session.edits.peek(), range, { note: "" })) },
    ];
  };

  /** Trim, Pickup, Link and Tail (reserved ranges): what they can do. */
  const reservedMenu = (s: SampleSelection, at: { x: number; y: number }) => {
    select(s);
    const name = { trim: "Trim", pickup: "Pickup", link: "Link", tail: "Tail" }[s.kind as "trim"] ?? "Range";
    const span = selectionSpan(s, e, length);
    setMenu({
      ...at,
      label: `${name} menu`,
      entries: tidyEntries([
        { kind: "group", label: name },
        { id: "play", label: `Play ${name.toLowerCase()}`, run: () => act.togglePlay(s) },
        { id: "zoom", label: `Zoom to the ${name.toLowerCase()}`, hint: "Z", run: () => act.zoomToSelection() },
        s.kind === "trim" && { id: "reset", label: "Reset to the whole file", disabled: ro || !e.trim, run: () => commit(resetTrim(e)) },
        s.kind !== "trim" && span && { id: "loop", label: "Add a loop here", disabled: ro, run: () => act.addLoopHere((span.start + span.end) / 2) },
        ...(s.kind === "trim" || s.kind === "pickup" || s.kind === "tail" ? rangeLookEntries(s.kind) : []),
      ]),
    });
  };

  const cutSnippets = snippets(e, length);
  const snippetMenuAt = (index: number, at: { x: number; y: number }) => {
    const run: Record<SnippetAction, () => void> = {
      save: () => (dialog.value = { kind: "snippet", index }),
      tapeLeft: () => commit(tapeSnippet(e, index, "left", length)),
      tapeRight: () => commit(tapeSnippet(e, index, "right", length)),
      toggle: () => commit(toggleSnippet(e, index, length)),
      closeGap: () => act.closeSnippetGap(index),
    };
    const s = cutSnippets.find((y) => y.index === index);
    const items: MenuEntry[] = snippetMenu(e, length, index).map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.id === "toggle" ? "Del" : undefined,
      disabled: ro || item.refused !== null,
      title: item.refused ?? undefined,
      danger: item.danger,
      run: run[item.id],
    }));
    const caption = s ? `${s.name} · ${formatTime(v(s.start), fmt, ctx)} – ${formatTime(v(s.end), fmt, ctx)}` : `Snippet ${index}`;
    setMenu({ ...at, label: `Snippet ${index} menu`, entries: tidyEntries([{ kind: "group", label: caption }, items[0], SEPARATOR, items[1], items[2], SEPARATOR, items[3], items[4]]) });
  };

  // --- keys on a focused timeline item (spec §4.1.11) -----------------------------------------------------------------

  /** One snap step in seconds (10 ms without one). */
  const stepSeconds = () => {
    const s = snapSetting.value;
    const sec = s.unit === "ms" ? s.step / 1000 : s.unit === "samples" ? s.step / rate : ctx.bpm ? (s.step * 60) / ctx.bpm : 0.01;
    return sec > 0 ? sec : 0.01;
  };
  const itemKeys = (ev: KeyboardEvent, it: { at: number; end?: number; move(at: number, end?: number): void; remove(): void; menu(at: { x: number; y: number }): void; rename?(at: { x: number; y: number }): void }) => {
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const at = { x: box.left, y: box.bottom + 2 };
    const d = (ev.shiftKey && !ev.altKey ? 10 : 1) * stepSeconds();
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      const dir = ev.key === "ArrowLeft" ? -1 : 1;
      if (ev.altKey && it.end !== undefined && ev.shiftKey) it.move(it.at, it.end + dir * stepSeconds());
      else if (ev.altKey) it.move(it.at + dir * stepSeconds(), it.end);
      else it.move(it.at + dir * d, it.end !== undefined ? it.end + dir * d : undefined);
    } else if (ev.key === "Enter") act.movePlayhead(it.at);
    else if (ev.key === "Delete" || ev.key === "Backspace") it.remove();
    else if (ev.key === "F2" && it.rename) it.rename(at);
    else if ((ev.key === "F10" && ev.shiftKey) || ev.key === "ContextMenu") it.menu(at);
    else if (ev.key === "Escape") (ev.currentTarget as HTMLElement).closest<HTMLElement>(".smp-tl")?.focus();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  };

  // --- toolbar ---------------------------------------------------------------------------------------------------------

  const toolbar = (
    <div class="smp-toolbar" role="toolbar" aria-label="Sample tools">
      <span class="smp-file" title={session.path}>{nameOf(session.path)}</span>
      <SaveSplitButton
        canSave={!ro}
        whyNoWrite={ro ? "The project is read-only" : !/\.wave?$/i.test(source) ? "Only a WAV file can carry markers and loops" : null}
        canFork={!ro}
        saveKeys={formatKeys("Mod+S", mac)}
        forkKeys={formatKeys("Mod+Shift+S", mac)}
        onSave={act.save}
        onWrite={() => (dialog.value = { kind: "write" })}
        onFork={() => (dialog.value = { kind: "fork", mode: "fork" })}
      />
      <span class="smp-vsep" aria-hidden="true" />
      <HistoryPopover none="No edits yet" />
      <span class="smp-vsep" aria-hidden="true" />
      <VersionMenu session={session} />
      <button type="button" class={`smp-sbtn smp-ab${ab ? " on" : ""}`} aria-pressed={ab} aria-label="A/B: hear the source without edits"
        title={ab ? "Hearing and showing the source without edits · click to show the edits" : "A/B: hear and show the source with every edit bypassed (not Hear as, which compares platforms)"} onClick={() => (abSource.value = !ab)}>
        A/B
      </button>
      <span class="smp-flex" />
      <RootPopover edits={e} commit={(r) => commit(r)} detect={detect} disabled={ro} />
      <NormalizePopover edits={e} measured={loudnessOf(project, source)} bextLoudness={wav?.bext?.loudnessValue ?? null} commit={(r) => commit(r)} disabled={ro} />
      <IconTool icon="addMarker" label="Add marker" title="Add marker at the playhead (M)" disabled={ro} onClick={act.addMarkerAtPlayhead} />
      <IconTool icon="addLoop" label="Add loop" title={`Add loop: in the largest free space (${e.loops.length} loop${e.loops.length === 1 ? "" : "s"}). You can also double-click the pickup, a link or the tail; L adds one at the playhead. Plays pickup → each loop in order → tail.`} disabled={ro} onClick={() => commit(addLoop(e, length))} />
      <IconTool icon="razor" label="Razor snipping" title="Razor snipping (C): click the waveform to snip; S snips at the playhead · Esc to stop" pressed={razorOn.value} disabled={ro} onClick={act.toggleRazor} />
      <SnapSplit snap={snapSetting.value} zero={e.snapToZero} format={fmt} hasTempo={!!e.tempo} onSnap={(s) => (snapSetting.value = s)} onZero={(on) => commit(setSnapToZero(e, on))} />
    </div>
  );

  // --- markers ---------------------------------------------------------------------------------------------------------

  const markerEls = e.markers.map((m) => {
    const mx = x(m.at);
    if (mx < -200 || mx > width + 10) return null;
    const outside = m.at < ta || m.at > tb;
    const on = sel.kind === "marker" && sel.id === m.id;
    const range = m.end !== undefined;
    const label = `${m.type === "cue" ? "↯ " : ""}${hasFixedName(m.type) ? MARKER_TYPE_NAMES[m.type] : m.name}`;
    const startDrag = (ev: PointerEvent, part: "body" | "start" | "end") => {
      select({ kind: "marker", id: m.id });
      if (ro) return;
      const offset = xToTime(ev.clientX - lanes.current!.getBoundingClientRect().left, view, width) - v(part === "end" ? m.end! : m.at);
      drag(ev, lanes.current!, view, (vt, done) => {
        const t = toSrc(vt - offset);
        const now = session.edits.peek();
        const cur = now.markers.find((y) => y.id === m.id);
        if (!cur || done) return;
        if (part === "end") commit(moveMarker(now, m.id, cur.at, length, Math.max(cur.at + 0.001, t)), true);
        else if (part === "start" && cur.end !== undefined) commit(moveMarker(now, m.id, Math.min(t, cur.end - 0.001), length, cur.end), true);
        else commit(moveMarker(now, m.id, t, length, cur.end !== undefined ? t + (cur.end - cur.at) : undefined), true);
      });
    };
    const keys = (ev: KeyboardEvent) =>
      itemKeys(ev, {
        at: m.at,
        end: m.end,
        move: (at, end) => commit(moveMarker(session.edits.peek(), m.id, at, length, end)),
        remove: () => (commit(deleteMarker(e, m.id)), select({ kind: "sample" })),
        menu: (at) => markerMenu(m, at),
        rename: hasFixedName(m.type) ? undefined : (at) => setEditing({ ...at, label: "Name", value: m.name, keep: (t) => (t.trim() && commit(updateMarker(e, m.id, { name: t.trim() })), setEditing(null)) }),
      });
    const tip = `${MARKER_TYPE_NAMES[m.type]} · ${m.name} · ${formatTime(v(m.at), fmt, ctx)}${range ? ` – ${formatTime(v(m.end!), fmt, ctx)}` : ""}${m.note ? `\n${m.note}` : ""}${m.file ? `\nFrom file · ${fileOrigin(m)}` : ""}${outside ? "\nOutside the trim · won't play" : ""}\nDrag to move · right-click for more`;
    const common = {
      key: m.id,
      role: "button" as const,
      tabIndex: 0,
      "aria-pressed": on,
      "aria-label": `${MARKER_TYPE_NAMES[m.type]} marker ${m.name} at ${formatTime(v(m.at), fmt, ctx)}`,
      "aria-keyshortcuts": "ArrowLeft ArrowRight Enter Delete F2 Shift+F10",
      title: tip,
      onKeyDown: keys,
      onFocus: () => !on && select({ kind: "marker", id: m.id }),
      onContextMenu: (ev: MouseEvent) => (ev.preventDefault(), markerMenu(m, point(ev))),
      onDblClick: (ev: MouseEvent) => ev.stopPropagation(),
    };
    const style = { top: `${(rows.get(m.id) ?? 0) * ROW_PX + 2}px`, "--mc": markerColour(m) };
    if (range) {
      return (
        <div {...common} class={`smp-mr${on ? " on" : ""}${outside ? " oot" : ""}`} style={{ ...style, left: `${mx}px`, width: `${Math.max(14, x(m.end!) - mx)}px` }} onPointerDown={(ev) => startDrag(ev, "body")}>
          <span class="smp-cp" aria-hidden="true" onPointerDown={(ev) => startDrag(ev, "start")} />
          <span class="smp-mt">{m.file ? "▪ " : ""}{label}</span>
          <span class="smp-cp" aria-hidden="true" onPointerDown={(ev) => startDrag(ev, "end")} />
        </div>
      );
    }
    return (
      <div {...common} class={`smp-mp${on ? " on" : ""}${outside ? " oot" : ""}${m.file ? " ff" : ""}${m.type === "entry" ? " entry" : ""}`} style={{ ...style, left: `${mx}px` }} onPointerDown={(ev) => startDrag(ev, "body")}>
        {label}
      </div>
    );
  });

  // --- reserved rows (loops, trim) --------------------------------------------------------------------------------------

  const ACTIVE_ICON: Record<SampleLoop["active"], SampleIconName> = { always: "endless", held: "held", parameter: "parameter" };
  const loopRow = loopRegions(e, length).map((r) => {
    const rx = x(r.start);
    const hold = r.kind === "loop" && r.loop && isHold(r.loop);
    const rw = hold ? 2 : Math.max(6, x(r.end) - rx);
    const on = isSel(r.selection);
    const ro2 = r.kind !== "loop";
    const label = r.kind === "loop" && r.loop ? loopLabel(e, r.loop) : r.label;
    const tips: Record<string, string> = {
      pickup: "Pickup · plays once before the first loop · starts at trim start, ends at the first loop start · double-click to add a loop here",
      link: "Link · plays once between two loops · double-click to add a loop here",
      tail: "Tail · plays once after the last loop · ends at trim end · double-click to add a loop here",
      loop: r.loop ? `${loopName(e, r.loop.id)} · ${{ always: "always", held: "while held", parameter: "by a parameter" }[r.loop.active]} · ${{ forward: "forward", pingPong: "ping-pong", backward: "backward" }[r.loop.direction]} · ${r.loop.count ? `${r.loop.count}×` : "repeats while active"}${r.loop.file ? " · from the WAV file" : ""} · drag the ends or slide the body` : "",
    };
    const grab = (ev: PointerEvent, edge: "start" | "end" | "body") => {
      select(r.selection);
      if (r.kind !== "loop" || !r.loop || ro) return;
      const l = r.loop;
      const g = xToTime(ev.clientX - lanes.current!.getBoundingClientRect().left, view, width) - v(l.start);
      drag(ev, lanes.current!, view, (vt) => {
        const now = session.edits.peek();
        const cur = now.loops.find((y) => y.id === l.id);
        if (!cur) return;
        if (edge === "body") commit(slideLoop(now, l.id, toSrc(vt - g), length), true);
        else if (edge === "start") commit(moveLoop(now, l.id, toSrc(vt, true), cur.end, length), true);
        else commit(moveLoop(now, l.id, cur.start, toSrc(vt, true), length), true);
      });
    };
    const colour = r.kind === "pickup" || r.kind === "tail" ? rangeLook(e, r.kind) : null;
    const mc = colour ? colour.css : `var(${r.kind === "link" ? "--range-pickup" : r.token})`;
    return (
      <div
        key={`${r.kind}${r.start}`}
        class={`smp-mr smp-rg ${r.kind}${ro2 ? " ro" : ""}${on ? " on" : ""}${hold ? " z" : ""}`}
        style={{ left: `${rx}px`, width: `${rw}px`, top: "2px", "--mc": mc }}
        role="button"
        tabIndex={0}
        aria-pressed={on}
        aria-label={`${r.kind === "loop" && r.loop ? loopName(e, r.loop.id) : r.label} ${formatTime(v(r.start), fmt, ctx)} to ${formatTime(v(r.end), fmt, ctx)}`}
        title={`${tips[r.kind]}\n${formatTime(v(r.start), fmt, ctx)} – ${formatTime(v(r.end), fmt, ctx)}${noteLine(colour?.note)}`}
        onPointerDown={(ev) => grab(ev, "body")}
        onFocus={() => !on && select(r.selection)}
        onKeyDown={(ev) => {
          if (r.kind === "loop" && r.loop) {
            const l = r.loop;
            itemKeys(ev, {
              at: l.start,
              end: l.end,
              move: (a, b) => commit(moveLoop(session.edits.peek(), l.id, a, b ?? l.end, length)),
              remove: () => (commit(removeLoop(e, l.id)), select({ kind: "sample" })),
              menu: (at) => loopMenu(l, at),
            });
          } else if (ev.key === "Enter") {
            act.movePlayhead(r.start);
            ev.preventDefault();
          } else if ((ev.key === "F10" && ev.shiftKey) || ev.key === "ContextMenu") {
            const b = (ev.currentTarget as HTMLElement).getBoundingClientRect();
            reservedMenu(r.selection, { x: b.left, y: b.bottom + 2 });
            ev.preventDefault();
          }
        }}
        onDblClick={(ev) => {
          if (r.kind === "loop") return;
          const lr = lanes.current!.getBoundingClientRect();
          act.addLoopHere(toSrc(xToTime(ev.clientX - lr.left, view, width)));
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          if (r.loop) loopMenu(r.loop, point(ev));
          else reservedMenu(r.selection, point(ev));
        }}
      >
        {!ro2 && !hold && <span class="smp-cp live" aria-hidden="true" onPointerDown={(ev) => grab(ev, "start")} />}
        {hold && r.loop ? (
          <span class="smp-hold-icon" aria-hidden="true"><SampleIcon name={ACTIVE_ICON[r.loop.active]} size={11} /></span>
        ) : (
          <span class="smp-mt">
            {r.loop && <SampleIcon name={ACTIVE_ICON[r.loop.active]} size={11} />}
            {label}
          </span>
        )}
        {!ro2 && !hold && <span class="smp-cp live" aria-hidden="true" onPointerDown={(ev) => grab(ev, "end")} />}
      </div>
    );
  });

  const trimOn = sel.kind === "trim";
  const trimRow = (
    <div
      class={`smp-mr smp-rg trim${trimOn ? " on" : ""}`}
      style={{ left: `${x(ta)}px`, width: `${Math.max(14, x(tb) - x(ta))}px`, top: "2px", "--mc": rangeLook(e, "trim").css }}
      role="button"
      tabIndex={0}
      aria-pressed={trimOn}
      aria-label={`Trim ${formatTime(v(ta), fmt, ctx)} to ${formatTime(v(tb), fmt, ctx)}`}
      title={`Trim: audio outside never plays · drag the ends to trim, the body to slide · double-click to reset to the full file\n${formatTime(v(ta), fmt, ctx)} – ${formatTime(v(tb), fmt, ctx)}${noteLine(rangeLook(e, "trim").note)}`}
      onDblClick={() => commit(resetTrim(e))}
      onFocus={() => !trimOn && select({ kind: "trim" })}
      onContextMenu={(ev) => (ev.preventDefault(), reservedMenu({ kind: "trim" }, point(ev)))}
      onKeyDown={(ev) =>
        itemKeys(ev, {
          at: ta,
          end: tb,
          move: (a, b) => commit(setTrim(session.edits.peek(), a, b ?? tb, length)),
          remove: () => commit(resetTrim(e)),
          menu: (at) => reservedMenu({ kind: "trim" }, at),
        })
      }
      onPointerDown={(ev) => {
        select({ kind: "trim" });
        if (ro) return;
        const el = ev.currentTarget as HTMLElement;
        const lx = ev.clientX - el.getBoundingClientRect().left;
        const w = el.getBoundingClientRect().width;
        const near = Math.min(edgePx(ev, 8), w / 3);
        const edge = lx < near ? "start" : lx > w - near ? "end" : "body";
        const grab = xToTime(ev.clientX - lanes.current!.getBoundingClientRect().left, view, width) - v(ta);
        drag(ev, lanes.current!, view, (vt) => {
          const now = session.edits.peek();
          const [a, b] = trimOf(now, length);
          if (edge === "start") commit(setTrim(now, toSrc(vt, true), b, length), true);
          else if (edge === "end") commit(setTrim(now, a, toSrc(vt, true), length), true);
          else {
            const na = toSrc(vt - grab);
            commit(setTrim(now, na, na + (b - a), length), true);
          }
        });
      }}
    >
      <span class="smp-cp live" aria-hidden="true" />
      <span class="smp-mt">{e.loops.length === 0 ? `Plays · ${formatTime(v(tb) - v(ta), fmt, ctx)}` : "Trim"}</span>
      <span class="smp-cp live" aria-hidden="true" />
    </div>
  );

  // --- guides (dotted lines from each item's edges through the waveform) ----------------------------------------------

  const guides: { x: number; top: number; color: string; on: boolean }[] = [];
  const visibleTop = (row: number) => Math.max(0, Math.min(MARKER_AREA_PX, row * ROW_PX + 4 - scrollTop));
  for (const m of e.markers) {
    const on = sel.kind === "marker" && sel.id === m.id;
    const top = visibleTop((rows.get(m.id) ?? 0) + 1);
    for (const t of m.end !== undefined ? [m.at, m.end] : [m.at]) guides.push({ x: x(t), top, color: markerColour(m), on });
  }
  for (const l of e.loops) {
    const on = sel.kind === "loop" && sel.id === l.id;
    for (const t of isHold(l) ? [l.start] : [l.start, l.end]) guides.push({ x: x(t), top: MARKER_AREA_PX + RULER_PX + RESERVED_ROW_PX, color: "var(--range-loop)", on });
  }
  if (e.trim) for (const t of [ta, tb]) guides.push({ x: x(t), top: MARKER_AREA_PX + RULER_PX + 2 * RESERVED_ROW_PX, color: "var(--range-trim)", on: trimOn });

  // --- the audio lane ----------------------------------------------------------------------------------------------------

  const fxChips: FxChip[] = [
    ...(ab ? [{ id: "ab", label: "A/B · source", tip: "Showing the source without edits · click to show the edits", tone: "on" as const, run: () => (abSource.value = false) }] : []),
    ...e.effects.map((f) => ({ id: f.id, label: effectChip(f), tip: `${effectSpec(f.type).label}${f.on ? "" : " · bypassed"} · click to show the waveform after this step`, tone: !f.on ? ("off" as const) : fxFocus.value === f.id ? ("on" as const) : undefined, run: () => (fxFocus.value = fxFocus.value === f.id ? null : f.id) })),
    ...(e.normalize.mode !== "off" ? [{ id: "norm", label: `Norm ${e.normalize.target} ${e.normalize.mode === "loudness" ? "LUFS" : "dBFS"}`, tip: `Normalize · gain ${e.normalize.gainDb > 0 ? "+" : ""}${e.normalize.gainDb.toFixed(1)} dB, applied last` }] : []),
    ...(e.frozen ? [{ id: "frozen", label: "Frozen", tip: "The render is kept as fixed audio", tone: "info" as const }] : []),
  ];
  const clips = clipRuns(shown, view, width);
  if (clips.length) fxChips.push({ id: "clips", label: "Clips", tip: "The audio reaches full scale here: lower the gain or the normalize target", tone: "danger" });

  const playBand = mine ? { left: x(mine.plan.from), width: Math.max(2, x(mine.plan.to) - x(mine.plan.from)) } : null;
  const trimDimL = e.trim ? Math.max(0, x(ta)) : 0;
  const trimDimR = e.trim ? Math.max(0, width - x(tb)) : 0;

  const laneChildren = (
    <>
      {outline && views.wave && <WaveOutline mips={outline} view={view} />}
      {views.wave && <ClipTicks runs={clips} />}
      {playBand && <div class="smp-pband" style={{ left: `${playBand.left}px`, width: `${playBand.width}px` }} aria-hidden="true" />}
      {trimDimL > 0 && <div class="smp-dim" style={{ left: 0, width: `${trimDimL}px` }} aria-hidden="true" />}
      {trimDimR > 0 && <div class="smp-dim" style={{ right: 0, width: `${trimDimR}px` }} aria-hidden="true" />}
      {cutSnippets.length > 1 &&
        cutSnippets.map((s) => {
          const sx = x(s.start), sw = x(s.end) - sx;
          if (sx + sw < 0 || sx > width) return null;
          const on = sel.kind === "snippet" && sel.index === s.index;
          const gap = s.deleted ? refusalOf(closeGap(e, s.index, length)) : null;
          const keep = (ev: Event) => ev.stopPropagation();
          return (
            <div key={s.start} class={`smp-seg${on ? " sel" : ""}${s.deleted ? " gone" : ""}`} style={{ left: `${sx}px`, width: `${sw}px` }}>
              <span class="smp-segl" aria-hidden="true">{s.deleted ? `${s.name} · deleted` : s.name}</span>
              {s.deleted && !ro && sw > 60 && (
                <button type="button" class="smp-gapb" disabled={gap !== null} title={gap ?? "Close gap: slide everything after it up to the snippet in front"} aria-label={`Close ${s.name}'s gap`}
                  onPointerDown={keep} onDblClick={keep} onClick={() => act.closeSnippetGap(s.index)}>
                  ⇤ Close gap
                </button>
              )}
            </div>
          );
        })}
      {e.cuts.map((c) => {
        const after = cutSnippets.find((s) => Math.abs(s.start - c) < 1e-6);
        const tape = after ? refusalOf(tapeSnippet(e, after.index, "left", length)) : "no snippet there";
        const keep = (ev: Event) => ev.stopPropagation();
        return (
          <Fragment key={c}>
            <div class="smp-cut" style={{ left: `${x(c)}px` }} aria-hidden="true" />
            {!ro && after && (
              <button type="button" class="smp-tape" style={{ left: `${x(c)}px` }} disabled={tape !== null} title={tape ?? `Tape: join Snippet ${after.index - 1} and ${after.name} back into one`} aria-label={`Tape Snippet ${after.index - 1} to ${after.name}`}
                onPointerDown={keep} onDblClick={keep} onClick={() => commit(tapeSnippet(e, after.index, "left", length))}>
                <SampleIcon name="tape" size={10} />
              </button>
            )}
          </Fragment>
        );
      })}
      {razorOn.value && hoverTime.value !== null && <div class="smp-rzg" style={{ left: `${timeToX(hoverTime.value, view, width)}px` }} aria-hidden="true" />}
      <FxChips chips={fxChips} />
    </>
  );

  const onWavePress = (vt: number, ev: PointerEvent) => {
    if (ev.button !== 0) return;
    if (razorOn.value) return void act.snipAtPlayhead(toSrc(vt, true));
    const t = sourceTime(e, vt);
    act.movePlayhead(t);
    // Between razor cuts a click also selects the snippet under it (the Inspector shows its bar).
    const s = snippetUnder(e, length, t);
    if (s && e.cuts.length) select({ kind: "snippet", index: s.index });
  };

  const waveform = (
    <Waveform
      mips={shown}
      view={view}
      length={len}
      bands={bands}
      label={`${nameOf(source)} waveform${preview.mips && !ab ? " with its effects" : ""}`}
      placeholder={failed ? `Couldn't read the audio: ${failed}` : undefined}
      onView={(nv) => (viewSpan.value = nv)}
      onHover={(t) => (hoverTime.value = t)}
      onPress={onWavePress}
      onDoubleClick={(vt) => !razorOn.value && act.addLoopHere(sourceTime(e, vt))}
    >
      {laneChildren}
    </Waveform>
  );
  const spectrum = <SpectrogramView pcm={ab ? pcmNow(project, source) : preview.pcm ?? pcmNow(project, source)} view={view} />;

  // --- readout -----------------------------------------------------------------------------------------------------------

  const level = (() => {
    if (playT < ta || playT > tb) return "silent";
    const c = waveColumns(shown, { start: v(playT) - 0.01, end: v(playT) + 0.01 }, 1);
    const a = Math.max(Math.abs(c.min[0] ?? 0), Math.abs(c.max[0] ?? 0));
    return Number.isFinite(a) && a > 0.0001 ? `${(20 * Math.log10(a)).toFixed(1).replace("-", "−")} dB` : "silent";
  })();
  const playScope = mine ? `${mine.plan.held && !mine.released ? "holding" : "playing"} · ${mine.plan.scope}` : scope ? `${sel.kind === "sample" ? "Trim" : (sel.kind[0].toUpperCase() + sel.kind.slice(1))} · ${formatTime(v(scope.start), fmt, ctx)} – ${formatTime(v(scope.end), fmt, ctx)}` : "—";
  const readItem = (icon: SampleIconName, name: string, value: ComponentChildren) => (
    <span class="smp-rdi" title={name}>
      <SampleIcon name={icon} size={14} />
      <span class="smp-vh">{name}</span>
      {value}
    </span>
  );

  const info = [wav?.sampleRate ? `${Math.round(wav.sampleRate / 100) / 10} kHz` : sourceMips ? `${Math.round(sourceMips.rate / 100) / 10} kHz` : null, sourceMips ? (sourceMips.channels === 1 ? "mono" : sourceMips.channels === 2 ? "stereo" : `${sourceMips.channels} ch`) : null, shortLength(length), e.tempo ? `${e.tempo.bpm} BPM ${e.tempo.meter}` : null].filter(Boolean).join(" · ");

  return (
    <Panel class="smp-timeline" toolbar={toolbar}>
      <div class="smp-tl" data-asset-document={session.documentPath} data-keyscope="samples-timeline" tabIndex={0} aria-label={`${nameOf(session.path)} timeline`}
        onKeyDown={(ev) => {
          if (ev.key === "Escape" && razorOn.value) {
            razorOn.value = false;
            ev.preventDefault();
          }
        }}>
        {disk && (
          <div class="smp-banner" role="status">
            <Icon name="warning" />
            <b>{nameOf(source)} changed on disk.</b>
            <span class="smp-banner-text">{disk.summary ? disk.summary.charAt(0).toUpperCase() + disk.summary.slice(1) : ""}</span>
            <button type="button" class="smp-sm2" onClick={() => (dialog.value = { kind: "merge" })}>Review changes…</button>
            <button type="button" class="smp-sm2" title="Keep everything as it is in the project" onClick={() => (diskChange.value = null)}>Ignore</button>
          </div>
        )}
        <div class="smp-sheet">
          <div class="smp-trk">
            <div class="smp-th smp-th-top">
              <div class="smp-mrl" style={{ height: `${MARKER_AREA_PX}px` }}>
                <span>Markers</span>
                {hiddenRows > 0 && <span class="smp-mrl-more">{rowCount} rows · scroll</span>}
              </div>
              <div class="smp-phrow" style={{ height: `${RULER_PX}px` }}>
                <span class="smp-phread" title="Playhead">{formatTime(v(playT), fmt, ctx)}</span>
                <TimeDisplayCaret value={fmt} at={v(playT)} ctx={ctx} onChange={(f) => (timeFormat.value = f)} />
              </div>
              <div class="smp-temporow" style={{ height: `${2 * RESERVED_ROW_PX}px` }}>
                <TempoPopover edits={e} commit={(r) => commit(r)} detect={detect} disabled={ro} />
              </div>
            </div>
            <div class="smp-lanecol" ref={lanes}>
              <div
                ref={markerScroll}
                class="smp-mscroll"
                style={{ height: `${MARKER_AREA_PX}px` }}
                title={hiddenRows > 0 ? `${hiddenRows} more marker row${hiddenRows === 1 ? "" : "s"} · scroll to see them` : undefined}
                onScroll={(ev) => setScrollTop((ev.currentTarget as HTMLElement).scrollTop)}
                onDblClick={(ev) => {
                  if (ro || (ev.target as HTMLElement).closest(".smp-mp, .smp-mr")) return;
                  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  const res = addMarker(e, toSrc(xToTime(ev.clientX - r.left, view, r.width)), length);
                  if (commit(res) && "next" in res) select({ kind: "marker", id: res.next.markers.find((m) => !e.markers.some((y) => y.id === m.id))!.id });
                }}
                onPointerMove={(ev) => {
                  if ((ev.target as HTMLElement).closest(".smp-mp, .smp-mr")) return setGhost(null);
                  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  setGhost({ x: ev.clientX - r.left, row: Math.floor((ev.clientY - r.top - 4 + (ev.currentTarget as HTMLElement).scrollTop) / ROW_PX) });
                }}
                onPointerLeave={() => setGhost(null)}
              >
                <div class="smp-markers-inner" style={{ height: `${rowCount * ROW_PX + 4}px` }}>
                  {markerEls}
                  {ghost && !ro && (
                    <>
                      <div class="smp-mg" style={{ left: `${ghost.x}px`, top: `${Math.max(0, Math.min(ghost.row, rowCount - 1)) * ROW_PX + 2}px` }} aria-hidden="true">{nextMarkerName(e)}</div>
                      <div class={`smp-mgt${ghost.x > width * 0.7 ? " flip" : ""}`} style={{ left: `${ghost.x}px`, top: `${Math.max(0, Math.min(ghost.row, rowCount - 1)) * ROW_PX + 2}px` }} aria-hidden="true">Double-click to add a marker</div>
                    </>
                  )}
                </div>
              </div>
              <div class="smp-ruler" style={{ height: `${RULER_PX}px` }} title="Click or drag to move the playhead">
                <TimeRuler view={view} format={fmt} context={ctx} position={v(playT)} length={len} label="Playhead" labelOf={fmt === "timecode" ? shortSeconds : undefined} onScrub={(vt) => act.movePlayhead(sourceTime(e, vt))} />
                {v(playT) >= view.start && v(playT) <= view.end && <span class="smp-phead" style={{ left: `${x(playT)}px` }} aria-hidden="true" />}
              </div>
              <div class="smp-mrow" aria-label="Loops" onDblClick={(ev) => {
                if (e.loops.length || ro || (ev.target as HTMLElement).closest(".smp-mr")) return;
                const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                act.addLoopHere(toSrc(xToTime(ev.clientX - r.left, view, r.width)));
              }}>
                {loopRow}
                {e.loops.length === 0 && <span class="smp-row-hint">No loops (optional) · double-click to add one</span>}
              </div>
              <div class="smp-mrow" aria-label="Trim">{trimRow}</div>
            </div>
          </div>
          <div class="smp-trk smp-trk-audio">
            <div class="smp-th">
              <span class="smp-th-title">Audio</span>
              <span class="smp-badge" title={wav?.bext ? `Timecode origin ${wav.sampleRate ? formatTime(wav.bext.timeReference / wav.sampleRate, "timecode", ctx) : wav.bext.timeReference}` : undefined}>{info}</span>
              <div class="smp-views" role="group" aria-label="Audio view">
                <button type="button" class={`smp-sbtn${views.wave ? " on" : ""}`} aria-pressed={views.wave} aria-label="Waveform" title={views.wave && !views.spectrogram ? "Waveform (one view always stays on)" : views.wave ? "Hide the waveform" : "Show the waveform"}
                  onClick={() => (waveViews.value = { wave: !views.wave || !views.spectrogram, spectrogram: views.spectrogram || views.wave })}>
                  <SampleIcon name="waveform" size={12} />
                </button>
                <button type="button" class={`smp-sbtn${views.spectrogram ? " on" : ""}`} aria-pressed={views.spectrogram} aria-label="Spectrogram" title={views.spectrogram && !views.wave ? "Spectrogram (one view always stays on)" : views.spectrogram ? "Hide the spectrogram" : "Show the spectrogram (both: a split view)"}
                  onClick={() => (waveViews.value = { spectrogram: !views.spectrogram || !views.wave, wave: views.wave || views.spectrogram })}>
                  <SampleIcon name="spectrogram" size={12} />
                </button>
              </div>
            </div>
            <div
              class={`smp-lane-audio${razorOn.value ? " razor" : e.cuts.length ? " snippets" : ""}`}
              onContextMenu={(ev) => {
                if (e.cuts.length === 0 || razorOn.value) return;
                const r = lanes.current!.getBoundingClientRect();
                const s = snippetUnder(e, length, sourceTime(e, xToTime(ev.clientX - r.left, view, r.width)));
                if (!s) return;
                ev.preventDefault();
                select({ kind: "snippet", index: s.index });
                snippetMenuAt(s.index, point(ev));
              }}
            >
              {views.wave && <div class="smp-wave-wrap">{waveform}</div>}
              {views.spectrogram && <div class="smp-spec-wrap">{spectrum}</div>}
            </div>
          </div>
          <div class="smp-guides" aria-hidden="true">
            {guides.filter((g) => g.x >= 0 && g.x <= width).map((g, i) => (
              <span key={i} class={`smp-guide${g.on ? " on" : ""}`} style={{ left: `${g.x}px`, top: `${g.top}px`, "--gc": g.color }} />
            ))}
            {v(playT) >= view.start && v(playT) <= view.end && <span class={`smp-playline${mine ? " playing" : ""}`} style={{ left: `${x(playT)}px`, top: `${MARKER_AREA_PX}px` }} />}
          </div>
        </div>

        <div class="smp-zoombar">
          <div class="smp-zoomgroup" role="group" aria-label="Zoom">
            <button type="button" class="smp-ibtn" aria-label="Zoom out" title="Zoom out (−) · Shift + wheel or a sideways swipe scrolls" disabled={view.start <= 0 && view.end >= len} onClick={() => act.zoom(1 / 1.5)}><Icon name="zoomOut" size={14} /></button>
            <button type="button" class="smp-ibtn" aria-label="Zoom in" title="Zoom in at the playhead (=) · Ctrl/⌘ + wheel or pinch zooms at the pointer" onClick={() => act.zoom(1.5)}><Icon name="zoomIn" size={14} /></button>
            <button type="button" class="smp-ibtn" aria-label="Zoom to selection" title={`Zoom to ${sel.kind === "sample" ? "the trim" : `the ${sel.kind}`} (Z)`} onClick={act.zoomToSelection}><SampleIcon name="zoomSelection" size={13} /></button>
            <button type="button" class="smp-ibtn" aria-label="Fit the whole sample" title="Fit the whole sample (0) · or double-click the scrollbar" disabled={view.start <= 0 && view.end >= len} onClick={act.zoomFit}><Icon name="fit" size={14} /></button>
            <span class="smp-muted smp-zoom-pct" title="Zoom">{Math.round((len / (view.end - view.start)) * 100)}%</span>
          </div>
          <RangeBar view={view} length={len} label={`${formatTime(view.start, fmt, ctx)} – ${formatTime(view.end, fmt, ctx)}`} onView={(nv) => (viewSpan.value = nv)} />
        </div>

        <div class="smp-readout" aria-live="off">
          {readItem("play", "Play", playScope)}
          {readItem("region", "Region", regionAt(e, length, playT))}
          {readItem("level", "Level", level)}
          {e.markers.length > 0 && readItem("nextMarker", "Next marker", nextMarker(e, playT)?.name ?? "—")}
        </div>

        {warnings.length > 0 && (
          <div class="smp-warnings" role="region" aria-label="Warnings">
            {warnings.map((w) => {
              const [title, ...rest] = w.text.split(" · ");
              return (
                <div key={w.id} class="smp-warnb" role="status">
                  <div class="smp-warnb-text">
                    <span class="smp-warning" aria-hidden="true">⚠</span>
                    <b>{title}</b>
                    <span class="smp-muted smp-ellipsis">{rest.join(" · ")}</span>
                  </div>
                  <div class="smp-warnb-acts">
                    {w.actions.includes("select") && w.select && <button type="button" class="smp-sm2" title="Select it" onClick={() => select(w.select!)}>Select</button>}
                    {w.actions.includes("extendTrim") && <button type="button" class="smp-sm2" title="Move the trim so these play" onClick={() => commit({ next: { ...e, trim: trimHoldingMarkers(e, length) }, label: "Trim" })}>Extend trim</button>}
                    {w.actions.includes("deleteOutside") && <button type="button" class="smp-sm2" title="Delete the markers outside the trim" onClick={() => commit({ next: { ...e, markers: e.markers.filter((m) => !w.ids?.includes(m.id)) }, label: `Delete ${w.ids?.length} markers` })}>Delete</button>}
                    {w.actions.includes("crossfade50") && w.select?.kind === "loop" && <button type="button" class="smp-sm2" title="Lengthen this loop's crossfade" onClick={() => commit(updateLoop(e, (w.select as { id: string }).id, { crossfadeMs: 50 }))}>Crossfade 50 ms</button>}
                    {w.actions.includes("fit") && <button type="button" class="smp-sm2" title="Pull the edits inside the source" onClick={() => commit({ next: fitToSource(e, length), label: "Fit edits to the source" })}>Fit to source</button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {menu && <ContextMenu entries={menu.entries} at={{ x: menu.x, y: menu.y }} label={menu.label} onClose={() => setMenu(null)} />}
      {editing && <InlineEdit at={{ x: editing.x, y: editing.y }} label={editing.label} value={editing.value} multiline={editing.multiline} onKeep={editing.keep} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

/**
 * The range scrollbar: the visible span over the whole length; drag the body to scroll, a round end handle to zoom,
 * press the track to centre there; double-click fits. From the keyboard, the arrows scroll a tenth of the span (Page
 * Up/Down a whole span), Home and End go to the ends.
 */
function RangeBar(props: { view: { start: number; end: number }; length: number; label: string; onView(v: { start: number; end: number }): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { view, length } = props;
  const pct = (t: number) => `${(t / length) * 100}%`;
  const span = view.end - view.start;
  const scrollTo = (start: number) => props.onView(clampView({ start, end: start + span }, length));
  const onKeyDown = (ev: KeyboardEvent) => {
    const to = ({ ArrowLeft: view.start - span / 10, ArrowRight: view.start + span / 10, PageUp: view.start - span, PageDown: view.start + span, Home: 0, End: length - span } as Record<string, number>)[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    ev.stopPropagation();
    scrollTo(to);
  };
  const full = { start: 0, end: length };
  const dragPart = (part: "body" | "start" | "end") => (ev: PointerEvent) => {
    ev.stopPropagation();
    const r = ref.current!.getBoundingClientRect();
    const grab = xToTime(ev.clientX - r.left, full, r.width) - view.start;
    drag(ev, ref.current!, full, (t) => {
      if (part === "body") props.onView(clampView({ start: t - grab, end: t - grab + span }, length));
      else if (part === "start") props.onView(clampView({ start: Math.min(t, view.end - 0.005), end: view.end }, length));
      else props.onView(clampView({ start: view.start, end: Math.max(t, view.start + 0.005) }, length));
    });
  };
  return (
    <div
      ref={ref}
      class="smp-range"
      title={`${props.label} · drag to scroll · drag an end to zoom · double-click to fit`}
      onPointerDown={(ev) => {
        if (ev.button !== 0) return;
        const r = ref.current!.getBoundingClientRect();
        scrollTo(xToTime(ev.clientX - r.left, full, r.width) - span / 2);
      }}
      onDblClick={() => props.onView(fitView(length))}
    >
      <div
        class="smp-range-thumb"
        role="scrollbar"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={length}
        aria-valuenow={view.start}
        aria-valuetext={props.label}
        aria-label="Timeline view"
        onKeyDown={onKeyDown}
        style={{ left: pct(view.start), width: pct(span) }}
        onPointerDown={dragPart("body")}
      >
        <span class="smp-range-knob start" title="Drag to zoom" onPointerDown={dragPart("start")} />
        <span class="smp-range-knob end" title="Drag to zoom" onPointerDown={dragPart("end")} />
      </div>
    </div>
  );
}

export type { SampleEdits };
