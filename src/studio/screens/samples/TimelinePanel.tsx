// The Sample panel (the screen's fixed panel; the prototype's timeline): toolbar, changed-on-disk banner, marker rows,
// ruler, loop row (Pickup / Loop / Link / Tail), trim row, waveform with loop bands, the play band, snippets, cut lines
// and the playhead, zoom and the range scrollbar, the readout and the warnings stack. Everything is drawn in timeline
// time (closed gaps removed, `sampleTime.ts`); edits store source time. Drags are one coalesced step each.
import { useRef, useState } from "preact/hooks";
import type { SampleEdits, SampleMarker } from "../../../engine/audio/sample/types";
import { currentProject } from "../../../editor/state";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { HistoryPopover } from "../../../editor/ui/HistoryPopover";
import { formatKeys, isMacPlatform } from "../../../editor/ui/keyCombo";
import { Panel } from "../../../editor/ui/panel/Panel";
import { Icon } from "../../components/Icon";
import { Playhead } from "../../components/Playhead";
import { TimeRuler } from "../../components/TimeRuler";
import { formatTime, type TimeContext } from "../../components/timeRulerModel";
import { Waveform } from "../../components/Waveform";
import { clampView, fitView, timeToX, xToTime, type WaveBand } from "../../components/waveformModel";
import { useElementWidth } from "../../components/useElementWidth";
import * as act from "./sampleActions";
import {
  addLoop, addMarker, convertMarker, deleteMarker, hasFixedName, isHold, MARKER_TOKENS, MARKER_TYPE_NAMES, MARKER_TYPE_ORDER, moveLoop, moveMarker, removeLoop, resetTrim, setSnapToZero, setTrim,
  slideLoop, snippets, sourceTime, updateLoop, updateMarker, viewTime, type SampleEdit,
} from "./sampleEditing";
import { detachMarker, fileOrigin, markerDiff, revertLoop, revertMarker } from "./sampleFile";
import { lengthOf, loudnessOf, pcmNow, pcmOf, peaksFailure, peaksOf, wavMetadataOf, type SampleSession } from "./sampleSession";
import type { DetectKind } from "../../../engine/audio/sample/detect/detect";
import { detectInto } from "./sampleDetect";
import { editedLength, trimOf } from "./sampleTime";
import { estimateLabelWidth, liveSelection, loopRegions, MARKER_ROWS_SHOWN, musicalSpans,nextMarker, packMarkerRows, regionAt, sampleWarnings, selectionSpan, snapTime, trimHoldingMarkers, fitToSource } from "./sampleView";
import { nearestZeroCrossing, seamJump } from "./seam";
import { NormalizePopover, RootPopover, SnapPopover, TempoPopover, TimeFormatPopover } from "./SampleTools";
import { dialog, hoverTime, openSession, playheadTime, razorOn, select, selection, snapSetting, timeFormat, viewSpan } from "./samplesState";
import { playing } from "./sampleTransport";
import { diskChange } from "./sampleDisk";
import { nameOf } from "./sampleLibrary";
import { SaveSplitButton } from "./SaveSplitButton";

const ROW_PX = 18;

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
        <EmptyState title="Samples" icon={<Icon name="samples" size={28} />} body={<p>Pick a sample in the Samples panel to edit its markers, loops, trim, tempo and loudness. Edits are kept beside the file; the audio isn't changed.</p>} />
      </Panel>
    );
  }
  return <Timeline session={session} />;
}

function Timeline(props: { session: SampleSession }) {
  const { session } = props;
  const project = session.project;
  const source = session.source.value;
  const e = session.edits.value;
  const mips = peaksOf(project, source);
  const length = lengthOf(project, source);
  const failed = peaksFailure(project, source);
  const lanes = useRef<HTMLDivElement>(null);
  const width = useElementWidth(lanes);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; label: string } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; row: number } | null>(null);
  const mac = isMacPlatform();

  if (length === null) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState title={nameOf(session.path)} body={failed ? <p>Couldn't read the audio: {failed}</p> : <p>Reading the audio…</p>} />
      </Panel>
    );
  }
  const len = editedLength(length, e.closedGaps);
  const view = clampView(viewSpan.value ?? fitView(len), len);
  const sel = liveSelection(selection.value, e, length);
  const ctx: TimeContext = { rate: mips?.rate ?? 48000, bpm: e.tempo?.bpm, meter: e.tempo?.meter };
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
  const play = playing.value;
  const playT = playheadTime.value;
  const disk = diskChange.value?.path === source ? diskChange.value : null;
  const wav = wavMetadataOf(project, source);

  const bands: WaveBand[] = [
    ...e.loops.map((l) => ({ start: v(l.start), end: v(l.end), color: "--range-loop", label: isHold(l) ? "Hold" : undefined })),
    ...snippets(e, length).filter((s) => s.deleted).map((s) => ({ start: v(s.start), end: v(s.end), color: "--danger", hatched: true })),
    ...(scope && sel.kind !== "sample" ? [{ start: v(scope.start), end: v(scope.end), color: "--accent" }] : []),
  ];
  if (e.trim) bands.push({ start: 0, end: v(ta), color: "--faint", hatched: true }, { start: v(tb), end: len, color: "--faint", hatched: true });
  // ADR 0350: the post-exit tail and the pre-entry, shaded under the waveform.
  const spans = musicalSpans(e, length);
  if (spans.tail) bands.push({ start: v(spans.tail[0]), end: v(spans.tail[1]), color: "--marker-exit", hatched: true, label: "Tail" });
  if (spans.preEntry) bands.push({ start: v(spans.preEntry[0]), end: v(spans.preEntry[1]), color: "--marker-exit", label: "Pre-entry" });

  const markerMenu = (m: SampleMarker, at: { x: number; y: number }) => {
    const diff = markerDiff(m);
    setMenu({
      ...at,
      label: `${m.name} menu`,
      entries: tidyEntries([
        ...MARKER_TYPE_ORDER.map((t) => ({ id: `type-${t}`, label: `${m.type === t ? "✓ " : ""}${MARKER_TYPE_NAMES[t]}`, run: () => commit(updateMarker(e, m.id, { type: t })) })),
        SEPARATOR,
        m.type === "note" && { id: "convert", label: m.end !== undefined ? "Convert to point" : "Convert to range", run: () => commit(convertMarker(e, m.id, length)) },
        { id: "play", label: "Play from here", run: () => act.togglePlay({ kind: "marker", id: m.id }) },
        SEPARATOR,
        m.file && { id: "revert", label: "Revert to file", disabled: diff.length === 0, run: () => commit(revertMarker(e, m.id)) },
        m.file && { id: "detach", label: "Detach from file", run: () => commit(detachMarker(e, m.id)) },
        SEPARATOR,
        { id: "delete", label: "Delete", hint: "Del", danger: true, run: () => commit(deleteMarker(e, m.id)) },
      ]),
    });
  };

  const loopMenu = (id: string, at: { x: number; y: number }) => {
    const l = e.loops.find((y) => y.id === id)!;
    setMenu({
      ...at,
      label: "Loop menu",
      entries: tidyEntries([
        { id: "play", label: "Play loop", run: () => act.togglePlay({ kind: "loop", id }) },
        SEPARATOR,
        ...(["forward", "pingPong", "backward"] as const).map((d) => ({ id: d, label: `${l.direction === d ? "✓ " : ""}${{ forward: "Forward", pingPong: "Ping-pong", backward: "Backward" }[d]}`, run: () => commit(updateLoop(e, id, { direction: d })) })),
        SEPARATOR,
        ...(["always", "held", "parameter"] as const).map((a) => ({ id: a, label: `${l.active === a ? "✓ " : ""}Active: ${{ always: "Always", held: "While held", parameter: "Parameter" }[a]}`, run: () => commit(updateLoop(e, id, { active: a })) })),
        { id: "reentry", label: `${l.reentry === "reenter" ? "✓ " : ""}Re-enter on play`, run: () => commit(updateLoop(e, id, { reentry: l.reentry === "reenter" ? "ignore" : "reenter" })) },
        SEPARATOR,
        l.file && { id: "revert", label: "Revert to file", run: () => commit(revertLoop(e, id)) },
        { id: "remove", label: "Remove loop", danger: true, run: () => commit(removeLoop(e, id)) },
      ]),
    });
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && razorOn.value) {
      razorOn.value = false;
      ev.preventDefault();
    }
  };

  return (
    <Panel
      class="smp-timeline"
      toolbar={
        <div class="smp-toolbar" role="toolbar" aria-label="Sample tools">
          <span class="smp-file" title={session.path}>{nameOf(session.path)}</span>
          <SaveSplitButton
            canSave={!session.readOnly}
            whyNoWrite={session.readOnly ? "The project is read-only" : !/\.wave?$/i.test(source) ? "Only a WAV file can carry markers and loops" : null}
            canFork={!session.readOnly}
            saveKeys={formatKeys("Mod+S", mac)}
            forkKeys={formatKeys("Mod+Shift+S", mac)}
            onSave={act.save}
            onWrite={() => (dialog.value = { kind: "write" })}
            onFork={() => (dialog.value = { kind: "fork", mode: "fork" })}
          />
          <button class="smp-tool smp-tool-icon" aria-label="Re-import…" title="Replace the audio with a new file, keeping the edits (the current audio is kept as a version)" disabled={session.readOnly || session.derived.value !== null} onClick={() => (dialog.value = { kind: "reimport" })}>
            <Icon name="import" />
            <span class="smp-hide-narrow">Re-import…</span>
          </button>
          <HistoryPopover none="No edits yet" />
          <span class="smp-sep" aria-hidden="true" />
          <TempoPopover edits={e} commit={(r) => commit(r)} detect={detect} disabled={session.readOnly} />
          <RootPopover edits={e} commit={(r) => commit(r)} detect={detect} disabled={session.readOnly} />
          <NormalizePopover edits={e} measured={loudnessOf(project, source)} bextLoudness={wav?.bext?.loudnessValue ?? null} commit={(r) => commit(r)} disabled={session.readOnly} />
          <span class="smp-sep" aria-hidden="true" />
          <button class="smp-tool smp-tool-icon" title="Add marker at the playhead (M)" disabled={session.readOnly} onClick={act.addMarkerAtPlayhead}>
            <Icon name="plus" />
            Marker
          </button>
          <button class="smp-tool smp-tool-icon" title="Add loop in the largest free gap (L adds one at the playhead)" disabled={session.readOnly} onClick={() => commit(addLoop(e, length))}>
            <Icon name="plus" />
            Loop
          </button>
          <button class={`smp-tool${razorOn.value ? " on" : ""}`} aria-pressed={razorOn.value} title="Razor (C): click the waveform to snip; S snips at the playhead" disabled={session.readOnly} onClick={act.toggleRazor}>Razor</button>
          <SnapPopover snap={snapSetting.value} zero={e.snapToZero} onSnap={(s) => (snapSetting.value = s)} onZero={(on) => commit(setSnapToZero(e, on))} />
          <TimeFormatPopover value={fmt} hasTempo={!!e.tempo} onChange={(f) => (timeFormat.value = f)} />
        </div>
      }
    >
      <div class="smp-tl" data-asset-document={session.documentPath} data-keyscope="samples-timeline" tabIndex={0} aria-label={`${nameOf(session.path)} timeline`} onKeyDown={onKeyDown}>
        {disk && (
          <div class="smp-banner" role="status">
            <span>{nameOf(source)} changed on disk. {disk.summary}</span>
            <Icon name="warning" />
            <button onClick={() => (dialog.value = { kind: "merge" })}>Review changes…</button>
            <button onClick={() => (diskChange.value = null)}>Ignore</button>
          </div>
        )}
        <div class="smp-lanes" ref={lanes}>
          {/* Marker rows */}
          <div
            class="smp-markers"
            style={{ height: `${MARKER_ROWS_SHOWN * ROW_PX + 4}px` }}
            onDblClick={(ev) => {
              if ((ev.target as HTMLElement).closest(".smp-marker")) return;
              const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
              const res = addMarker(e, toSrc(xToTime(ev.clientX - r.left, view, r.width)), length);
              if (commit(res) && "next" in res) select({ kind: "marker", id: res.next.markers.find((m) => !e.markers.some((y) => y.id === m.id))!.id });
            }}
            onPointerMove={(ev) => {
              if ((ev.target as HTMLElement).closest(".smp-marker")) return setGhost(null);
              const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
              setGhost({ x: ev.clientX - r.left, row: Math.floor((ev.clientY - r.top + (ev.currentTarget as HTMLElement).scrollTop) / ROW_PX) });
            }}
            onPointerLeave={() => setGhost(null)}
          >
            <div class="smp-markers-inner" style={{ height: `${rowCount * ROW_PX}px` }}>
              {e.markers.map((m) => {
                const mx = x(m.at);
                if (mx < -200 || mx > width + 10) return null;
                const outside = m.at < ta || m.at > tb;
                const token = m.type === "note" && m.color !== undefined ? (typeof m.color === "number" ? `var(--series-${m.color})` : m.color) : `var(${MARKER_TOKENS[m.type]})`;
                const on = sel.kind === "marker" && sel.id === m.id;
                return (
                  <div
                    key={m.id}
                    class={`smp-marker${m.type === "entry" ? " entry" : ""}${on ? " on" : ""}${m.file ? " ff" : ""}${outside ? " outside" : ""}`}
                    style={{ left: `${mx}px`, top: `${(rows.get(m.id) ?? 0) * ROW_PX}px`, width: m.end !== undefined ? `${Math.max(2, x(m.end) - mx)}px` : undefined, "--mk": token }}
                    role="button"
                    tabIndex={-1}
                    aria-pressed={on}
                    title={`${MARKER_TYPE_NAMES[m.type]} · ${m.name} · ${formatTime(v(m.at), fmt, ctx)}${m.note ? `\n${m.note}` : ""}${m.file ? `\nFrom file · ${fileOrigin(m)}` : ""}${outside ? "\nOutside the trim · won't play" : ""}`}
                    onPointerDown={(ev) => {
                      select({ kind: "marker", id: m.id });
                      const grabEnd = m.end !== undefined && (ev.target as HTMLElement).classList.contains("smp-marker-end");
                      const offset = xToTime(ev.clientX - lanes.current!.getBoundingClientRect().left, view, width) - v(grabEnd ? m.end! : m.at);
                      drag(ev, lanes.current!, view, (vt, done) => {
                        const t = toSrc(vt - offset);
                        const now = session.edits.peek();
                        const cur = now.markers.find((y) => y.id === m.id);
                        if (!cur) return;
                        if (!done) commit(grabEnd ? moveMarker(now, m.id, cur.at, length, t) : moveMarker(now, m.id, t, length), true);
                      });
                    }}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      markerMenu(m, { x: ev.clientX, y: ev.clientY });
                    }}
                  >
                    <span class="smp-marker-label">
                      {m.type === "cue" ? "↯ " : ""}
                      {outside && <Icon name="warning" size={11} />}
                      {hasFixedName(m.type) ? MARKER_TYPE_NAMES[m.type] : m.name}
                    </span>
                    {m.end !== undefined && <span class="smp-marker-end" aria-hidden="true" />}
                  </div>
                );
              })}
              {ghost && !session.readOnly && (
                <div class="smp-marker-ghost" style={{ left: `${ghost.x}px`, top: `${Math.min(ghost.row, rowCount - 1) * ROW_PX}px` }} aria-hidden="true">
                  Double-click to add a marker
                </div>
              )}
            </div>
          </div>

          <TimeRuler view={view} format={fmt} context={ctx} position={v(playT)} length={len} onScrub={(vt) => act.movePlayhead(sourceTime(e, vt))} />

          {/* Loop row */}
          <div class="smp-looprow" aria-label="Loops">
            {loopRegions(e, length).map((r) => {
              const rx = x(r.start), rw = Math.max(r.kind === "loop" && r.loop && isHold(r.loop) ? 3 : 1, x(r.end) - rx);
              const on = JSON.stringify(sel) === JSON.stringify(r.selection);
              return (
                <div
                  key={`${r.kind}${r.start}`}
                  class={`smp-region ${r.kind}${on ? " on" : ""}`}
                  style={{ left: `${rx}px`, width: `${rw}px`, "--rg": `var(${r.token})` }}
                  title={`${r.label} · ${formatTime(v(r.start), fmt, ctx)} – ${formatTime(v(r.end), fmt, ctx)}${r.kind !== "loop" ? " · double-click to add a loop here" : ""}`}
                  onPointerDown={(ev) => {
                    select(r.selection);
                    if (r.kind !== "loop" || !r.loop || session.readOnly) return;
                    const l = r.loop;
                    const lx = ev.clientX - (ev.currentTarget as HTMLElement).getBoundingClientRect().left;
                    const near = Math.min(edgePx(ev, 6), rw / 3);
                    const edge = lx < near ? "start" : lx > rw - near ? "end" : "body";
                    const grab = xToTime(ev.clientX - lanes.current!.getBoundingClientRect().left, view, width) - v(l.start);
                    drag(ev, lanes.current!, view, (vt) => {
                      const now = session.edits.peek();
                      const cur = now.loops.find((y) => y.id === l.id);
                      if (!cur) return;
                      if (edge === "body") commit(slideLoop(now, l.id, toSrc(vt - grab), length), true);
                      else if (edge === "start") commit(moveLoop(now, l.id, toSrc(vt, true), cur.end, length), true);
                      else commit(moveLoop(now, l.id, cur.start, toSrc(vt, true), length), true);
                    });
                  }}
                  onDblClick={(ev) => {
                    if (r.kind === "loop") return;
                    const lr = lanes.current!.getBoundingClientRect();
                    act.addLoopHere(toSrc(xToTime(ev.clientX - lr.left, view, width)));
                  }}
                  onContextMenu={(ev) => {
                    if (!r.loop) return;
                    ev.preventDefault();
                    loopMenu(r.loop.id, { x: ev.clientX, y: ev.clientY });
                  }}
                >
                  <span class="smp-region-label">{r.label}</span>
                </div>
              );
            })}
            {e.loops.length === 0 && <span class="smp-row-hint">No loops · + Loop, or L at the playhead</span>}
          </div>

          {/* Trim row */}
          <div class="smp-trimrow" aria-label="Trim">
            <div
              class={`smp-trim${sel.kind === "trim" ? " on" : ""}${e.trim ? " set" : ""}`}
              style={{ left: `${x(ta)}px`, width: `${Math.max(4, x(tb) - x(ta))}px` }}
              title={`Trim · ${formatTime(v(ta), fmt, ctx)} – ${formatTime(v(tb), fmt, ctx)} · audio outside never plays · double-click to reset`}
              onDblClick={() => commit(resetTrim(e))}
              onPointerDown={(ev) => {
                select({ kind: "trim" });
                if (session.readOnly) return;
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
              <span class="smp-trim-handle start" aria-hidden="true" />
              <span class="smp-region-label">Trim</span>
              <span class="smp-trim-handle end" aria-hidden="true" />
            </div>
          </div>

          <div class="smp-wave-wrap">
            <Waveform
              mips={mips}
              view={view}
              length={len}
              bands={bands}
              label={`${nameOf(source)} waveform`}
              placeholder={failed ? `Couldn't read the audio: ${failed}` : undefined}
              onView={(nv) => (viewSpan.value = nv)}
              onHover={(t) => (hoverTime.value = t)}
              onPress={(vt, ev) => {
                if (ev.button !== 0) return;
                if (razorOn.value) act.snipAtPlayhead(toSrc(vt, true));
                else act.movePlayhead(sourceTime(e, vt));
              }}
              onDoubleClick={(vt) => !razorOn.value && act.addLoopHere(sourceTime(e, vt))}
            >
              {e.cuts.map((c) => (
                <div key={c} class="smp-cut" style={{ left: `${x(c)}px` }} title={`Cut at ${formatTime(v(c), fmt, ctx)}`} />
              ))}
              {razorOn.value && hoverTime.value !== null && <div class="smp-cut ghost" style={{ left: `${timeToX(hoverTime.value, view, width)}px` }} aria-hidden="true" />}
              <Playhead t={v(playT)} view={view} playing={!!play} />
            </Waveform>
          </div>

          <div class="smp-zoombar">
            <button class="smp-tool smp-icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => act.zoom(1 / 1.5)}><Icon name="zoomOut" /></button>
            <button class="smp-tool smp-icon-button" aria-label="Zoom in" title="Zoom in (=)" onClick={() => act.zoom(1.5)}><Icon name="zoomIn" /></button>
            <button class="smp-tool smp-icon-button" aria-label="Fit" title="Fit the whole sample (0)" onClick={act.zoomFit}><Icon name="fit" /></button>
            <span class="smp-muted smp-zoom-pct">{Math.round((len / (view.end - view.start)) * 100)}%</span>
            <RangeBar view={view} length={len} onView={(nv) => (viewSpan.value = nv)} />
          </div>
        </div>

        <div class="smp-readout" aria-live="off">
          <span>Playhead <b>{formatTime(v(playT), fmt, ctx)}</b></span>
          <span>Region <b>{regionAt(e, length, playT)}</b></span>
          <span>Play scope <b>{scope ? `${formatTime(v(scope.start), fmt, ctx)} – ${formatTime(v(scope.end), fmt, ctx)}` : "—"}</b></span>
          <span>Next marker <b>{nextMarker(e, playT)?.name ?? "—"}</b></span>
          <span>Length <b>{formatTime(len, fmt, ctx)}</b></span>
        </div>

        {warnings.length > 0 && (
          <div class="smp-warnings" role="status">
            {warnings.map((w) => (
              <div key={w.id} class="smp-warning-row">
                <Icon name="warning" />
                <span>{w.text}</span>
                {w.actions.includes("select") && w.select && <button onClick={() => select(w.select!)}>Select</button>}
                {w.actions.includes("extendTrim") && <button onClick={() => commit({ next: { ...e, trim: trimHoldingMarkers(e, length) }, label: "Trim" })}>Extend trim</button>}
                {w.actions.includes("deleteOutside") && <button onClick={() => commit({ next: { ...e, markers: e.markers.filter((m) => !w.ids?.includes(m.id)) }, label: `Delete ${w.ids?.length} markers` })}>Delete</button>}
                {w.actions.includes("crossfade50") && w.select?.kind === "loop" && <button onClick={() => commit(updateLoop(e, (w.select as { id: string }).id, { crossfadeMs: 50 }))}>Crossfade 50 ms</button>}
                {w.actions.includes("fit") && <button onClick={() => commit({ next: fitToSource(e, length), label: "Fit edits to the source" })}>Fit to source</button>}
              </div>
            ))}
          </div>
        )}
      </div>
      {menu && <ContextMenu entries={menu.entries} at={{ x: menu.x, y: menu.y }} label={menu.label} onClose={() => setMenu(null)} />}
    </Panel>
  );
}

/**
 * The range scrollbar: the visible span over the whole length; drag the body to scroll, an end to zoom; double-click
 * fits. From the keyboard, the arrows scroll a tenth of the span (Page Up/Down a whole span), Home and End go to the ends.
 */
function RangeBar(props: { view: { start: number; end: number }; length: number; onView(v: { start: number; end: number }): void }) {
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
  return (
    <div
      ref={ref}
      class="smp-range"
      role="scrollbar"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={length}
      aria-valuenow={view.start}
      aria-valuetext={`${view.start.toFixed(2)} s to ${view.end.toFixed(2)} s of ${length.toFixed(2)} s`}
      aria-label="Visible range"
      onKeyDown={onKeyDown}
      onDblClick={() => props.onView(fitView(length))}
    >
      <div
        class="smp-range-thumb"
        style={{ left: pct(view.start), width: pct(view.end - view.start) }}
        onPointerDown={(ev) => {
          const r = ref.current!.getBoundingClientRect();
          const full = { start: 0, end: length };
          const lx = ev.clientX - (ev.currentTarget as HTMLElement).getBoundingClientRect().left;
          const w = (ev.currentTarget as HTMLElement).getBoundingClientRect().width;
          const near = Math.min(edgePx(ev, 6), w / 3);
          const edge = lx < near ? "start" : lx > w - near ? "end" : "body";
          const grab = xToTime(ev.clientX - r.left, full, r.width) - view.start;
          drag(ev, ref.current!, full, (t) => {
            if (edge === "body") props.onView(clampView({ start: t - grab, end: t - grab + (view.end - view.start) }, length));
            else if (edge === "start") props.onView(clampView({ start: Math.min(t, view.end - 0.005), end: view.end }, length));
            else props.onView(clampView({ start: view.start, end: Math.max(t, view.start + 0.005) }, length));
          });
        }}
      />
    </div>
  );
}

export type { SampleEdits };
