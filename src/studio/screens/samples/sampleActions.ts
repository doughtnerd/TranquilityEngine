// The Samples screen's actions on the open sample, shared by the toolbar, menus and the keyboard (the prototype's
// keys: M marker, L loop, I/O trim, S snip, C razor, Delete, = − 0 Z zoom, Space play, arrows move the playhead). Each
// edit applies through the sample's session as one step.
import { studioHearAs } from "../../encoding/studioEncoding";
import { toasts, audioHost } from "../../shell/studioServices";
import { fitView, followTime, zoomAt, zoomTo } from "../../components/waveformModel";
import { addLoop, addMarker, closeGap, deleteMarker, removeLoop, setTrim, snip, toggleSnippet, viewTime } from "./sampleEditing";
import { editedLength, trimOf } from "./sampleTime";
import { landmarks, liveSelection, selectionSpan, SAMPLE_SELECTED, type SampleSelection } from "./sampleView";
import { lengthOf } from "./sampleSession";
import { renderPathOf } from "./sampleFlatten";
import { followPlayhead, playMode, playheadTime, preRoll, razorOn, returnToStart, seamRepeat, select, selection, openSession, viewSpan, snapSetting, timeFormat } from "./samplesState";
import { planPlay, planSeam, playing, releasePlay, SEAM_SCOPE, startPlay, stopPlay } from "./sampleTransport";
import { formatTime } from "../../components/timeRulerModel";
import { snapSeconds } from "./sampleView";
import { status } from "../../../editor/state";
import { nameOf } from "./sampleLibrary";

/** The open sample with its length, or null when there's none (or its length isn't read yet). */
export function current() {
  const s = openSession.peek();
  if (!s) return null;
  const length = lengthOf(s.project, s.source.peek());
  if (length === null) return null;
  const e = s.edits.peek();
  return { s, e, length, sel: liveSelection(selection.peek(), e, length) };
}

const describeAt = (t: number, rate = 48000) => formatTime(t, timeFormat.peek(), { rate });

export function addMarkerAtPlayhead(): boolean {
  const c = current();
  if (!c) return false;
  const r = addMarker(c.e, playheadTime.peek(), c.length);
  if (c.s.commit(r) && "next" in r) select({ kind: "marker", id: r.next.markers.find((m) => !c.e.markers.some((x) => x.id === m.id))!.id });
  return true;
}

export function addLoopHere(at?: number): boolean {
  const c = current();
  if (!c) return false;
  const r = addLoop(c.e, c.length, at);
  if (c.s.commit(r) && "next" in r) select({ kind: "loop", id: r.next.loops.find((l) => !c.e.loops.some((x) => x.id === l.id))!.id });
  return true;
}

export function trimAtPlayhead(end: "start" | "end"): boolean {
  const c = current();
  if (!c) return false;
  const [a, b] = trimOf(c.e, c.length);
  const t = playheadTime.peek();
  c.s.commit(end === "start" ? setTrim(c.e, t, b, c.length) : setTrim(c.e, a, t, c.length));
  return true;
}

export function snipAtPlayhead(at = playheadTime.peek()): boolean {
  const c = current();
  if (!c) return false;
  c.s.commit(snip(c.e, at, c.length, (t) => describeAt(t)));
  return true;
}

export function toggleRazor(): boolean {
  razorOn.value = !razorOn.peek();
  return true;
}

/** Delete what's selected: a marker or a loop at once (undo brings it back), a snippet becomes silence. */
export function deleteSelected(): boolean {
  const c = current();
  if (!c) return false;
  const sel = c.sel;
  if (sel.kind === "marker") c.s.commit(deleteMarker(c.e, sel.id));
  else if (sel.kind === "loop") c.s.commit(removeLoop(c.e, sel.id));
  else if (sel.kind === "snippet") c.s.commit(toggleSnippet(c.e, sel.index, c.length));
  else return false;
  select(SAMPLE_SELECTED);
  return true;
}

export function closeSnippetGap(index: number): void {
  const c = current();
  if (!c) return;
  const r = closeGap(c.e, index, c.length);
  if (c.s.commit(r) && "label" in r && r.removed) toasts.show({ text: `${r.label} · ${r.removed} marker${r.removed === 1 ? "" : "s"}/loops inside it removed`, undo: () => c.s.undo() });
}

// --- view ------------------------------------------------------------------------------------------------------------

function viewNow(length: number) {
  return viewSpan.peek() ?? fitView(length);
}

export function zoom(factor: number): boolean {
  const c = current();
  if (!c) return false;
  const len = editedLength(c.length, c.e.closedGaps);
  const v = viewNow(len);
  const t = viewTime(c.e, playheadTime.peek());
  viewSpan.value = zoomAt(v, factor, t >= v.start && t <= v.end ? t : (v.start + v.end) / 2, len);
  return true;
}

export function zoomFit(): boolean {
  viewSpan.value = null;
  return true;
}

export function zoomToSelection(): boolean {
  const c = current();
  if (!c) return false;
  const span = selectionSpan(c.sel, c.e, c.length);
  if (!span) return false;
  viewSpan.value = zoomTo({ start: viewTime(c.e, span.start), end: viewTime(c.e, span.end) }, editedLength(c.length, c.e.closedGaps));
  return true;
}

// --- playhead --------------------------------------------------------------------------------------------------------

export function movePlayhead(to: number, follow = true): void {
  const c = current();
  if (!c) return;
  const t = Math.max(0, Math.min(c.length, to));
  playheadTime.value = t;
  const len = editedLength(c.length, c.e.closedGaps);
  if (follow && viewSpan.peek()) viewSpan.value = followTime(viewNow(len), viewTime(c.e, t), len);
}

/** ← → by one snap step (Shift ×10, Alt 1 ms). */
export function nudgePlayhead(dir: 1 | -1, big: boolean, fine: boolean): boolean {
  const c = current();
  if (!c) return false;
  const step = fine ? 0.001 : (snapSeconds(snapSetting.peek(), { rate: 48000, bpm: c.e.tempo?.bpm, meter: c.e.tempo?.meter }) ?? 0.01) * (big ? 10 : 1);
  movePlayhead(playheadTime.peek() + dir * step);
  return true;
}

/** Ctrl+← → to the previous or next landmark. */
export function jumpLandmark(dir: 1 | -1): boolean {
  const c = current();
  if (!c) return false;
  const t = playheadTime.peek();
  const marks = landmarks(c.e, c.length);
  const next = dir > 0 ? marks.find((m) => m > t + 1e-6) : [...marks].reverse().find((m) => m < t - 1e-6);
  if (next !== undefined) movePlayhead(next);
  return true;
}

export function playheadToTrim(end: "start" | "end", whole: boolean): boolean {
  const c = current();
  if (!c) return false;
  const [a, b] = whole ? [0, c.length] : trimOf(c.e, c.length);
  movePlayhead(end === "start" ? a : b);
  return true;
}

// --- play ------------------------------------------------------------------------------------------------------------

/** Space: play the selection by the play mode, pause, or release a held loop. */
export function togglePlay(sel?: SampleSelection): boolean {
  const c = current();
  if (!c) return false;
  const host = audioHost();
  const now = playing.peek();
  if (now && now.path === c.s.path) {
    if (now.plan.held && !now.released) releasePlay(host);
    else stopPlay(host);
    return true;
  }
  const plan = planPlay(c.e, c.length, sel ?? c.sel, playMode.peek(), playheadTime.peek());
  if (!plan) {
    toasts.show({ text: "Nothing to play there" });
    return true;
  }
  const back = playheadTime.peek();
  // A flattened sample plays its render, which keeps the source's timeline: the plan's source seconds hold.
  const audio = renderPathOf(c.s.project.files, c.s.source.peek(), c.e) ?? c.s.source.peek();
  const begin = () => {
    const why = startPlay(host, c.s.path, audio, plan, preRoll.peek() ? 1 : 0, (t) => movePlayhead(t, followPlayhead.peek()), () => {
      if (returnToStart.peek()) playheadTime.value = back;
    });
    if (why) toasts.show({ text: `Can't play: ${why}.`, kind: "error" });
  };
  // ADR 0351 §6: Hear as a platform converts the sound first (cached), then plays what that platform ships.
  const hear = studioHearAs();
  if (hear.choice.peek() === "source") begin();
  else void hear.prepare([audio]).then(begin);
  return true;
}

/**
 * Play across the seam (the Loop seam panel): the loop's last moment into its first, through the crossfade, and only
 * that (`planSeam`); with Repeat on it plays again each time it ends, until stopped. Pressed while it plays: stop.
 */
export function playSeam(loopId: string): boolean {
  const c = current();
  if (!c) return false;
  const host = audioHost();
  const now = playing.peek();
  if (now && now.path === c.s.path) {
    stopPlay(host);
    if (now.plan.scope === SEAM_SCOPE) return true;
  }
  const plan = planSeam(c.e, loopId);
  if (!plan) {
    toasts.show({ text: "That loop has no seam to play" });
    return true;
  }
  const path = c.s.path;
  const audio = renderPathOf(c.s.project.files, c.s.source.peek(), c.e) ?? c.s.source.peek();
  const begin = () => {
    const why = startPlay(host, path, audio, plan, 0, (t) => movePlayhead(t, false), () => {
      // Ended by itself (Stop doesn't come here): again, while Repeat is on and the same sample is open, with the
      // loop as it is now (a crossfade changed meanwhile is heard on the next pass).
      if (seamRepeat.peek() && openSession.peek()?.path === path) playSeam(loopId);
    });
    if (why) toasts.show({ text: `Can't play: ${why}.`, kind: "error" });
  };
  const hear = studioHearAs();
  if (hear.choice.peek() === "source") begin();
  else void hear.prepare([audio]).then(begin);
  return true;
}

// --- save ------------------------------------------------------------------------------------------------------------

/**
 * Ctrl+S pressed while typing in a field: the field's draft is committed first (its change runs as on leaving it),
 * then focus goes back to it, so what was typed is in what's saved.
 */
function commitTyping(): void {
  const el = typeof document === "undefined" ? null : document.activeElement;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
  const at = el instanceof HTMLSelectElement ? null : [el.selectionStart, el.selectionEnd] as const;
  el.blur();
  if (!el.isConnected) return;
  el.focus({ preventScroll: true });
  if (at && at[0] !== null && el instanceof HTMLInputElement && el.type !== "number") el.setSelectionRange(at[0], at[1]);
  else if (at && at[0] !== null && el instanceof HTMLTextAreaElement) el.setSelectionRange(at[0], at[1]);
}

/**
 * Save (Ctrl+S, the Save split button; owner decision 3): the open sample's project data, its sidecar or derived-sample
 * file, written now. The audio file isn't touched: that is Write to file…. A field being typed in commits first.
 */
export function save(): boolean {
  const s = openSession.peek();
  if (!s) return false;
  commitTyping();
  if (s.readOnly) {
    status.value = { kind: "info", text: `Can't save ${nameOf(s.path)}: the project is read-only.` };
    return true;
  }
  void s.flush().then(
    () => (status.value = { kind: "info", text: `Saved ${nameOf(s.path)}.` }),
    (err: unknown) => (status.value = { kind: "error", text: `Couldn't save ${nameOf(s.path)}: ${err instanceof Error ? err.message : String(err)}` }),
  );
  return true;
}

export function stop(): boolean {
  stopPlay(audioHost());
  return true;
}
