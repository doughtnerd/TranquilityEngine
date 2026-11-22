// What is selected in the Sequence timeline (proto §3.6 "Selection model": `sel` plus clip and point selections): a
// set of clips (Shift/Ctrl toggles, a marquee over empty lane space, Ctrl+A), or one track, loop or marker, or points
// of one automation lane; the focused track receives pastes. The Inspector shows the focus. Pure.
import type { SequenceSettings } from "../../../../engine/audio/playlist/types";
import { ownerOf, type AutomationOwner } from "./automationEdits";
import { allClips, clipLength, type SourceOf } from "./sequenceModel";

export interface PointSelection {
  readonly owner: AutomationOwner;
  readonly automation: string;
  readonly keys: readonly number[];
}

export interface SeqSelection {
  /** What the Inspector shows. */
  readonly focus: "sequence" | "clips" | "track" | "loop" | "marker" | "points";
  readonly clips: readonly string[];
  /** The focused track: pastes and "+ Loop at playhead" go here; the Inspector shows it when focus is "track". */
  readonly track: string | null;
  readonly loop: string | null;
  readonly marker: string | null;
  readonly points: PointSelection | null;
}

export const EMPTY_SELECTION: SeqSelection = { focus: "sequence", clips: [], track: null, loop: null, marker: null, points: null };

export interface Modifiers {
  readonly shift?: boolean;
  readonly ctrl?: boolean;
}

/** A click on clip `id` (on track `track`): alone selects it; Shift/Ctrl toggles it in the selection. */
export function clickClip(sel: SeqSelection, id: string, track: string, mod: Modifiers = {}): SeqSelection {
  if (mod.shift || mod.ctrl) {
    const clips = sel.clips.includes(id) ? sel.clips.filter((c) => c !== id) : [...sel.clips, id];
    return { ...EMPTY_SELECTION, focus: clips.length ? "clips" : "sequence", clips, track };
  }
  return { ...EMPTY_SELECTION, focus: "clips", clips: [id], track };
}

/** Pressing a clip that's already selected keeps the group (so it can be dragged together). */
export function pressClip(sel: SeqSelection, id: string, track: string, mod: Modifiers = {}): SeqSelection {
  if (!mod.shift && !mod.ctrl && sel.clips.includes(id)) return { ...sel, focus: "clips", track, loop: null, marker: null, points: null };
  return clickClip(sel, id, track, mod);
}

export const selectTrack = (id: string): SeqSelection => ({ ...EMPTY_SELECTION, focus: "track", track: id });
export const selectLoop = (sel: SeqSelection, id: string): SeqSelection => ({ ...EMPTY_SELECTION, focus: "loop", loop: id, track: sel.track });
export const selectMarker = (sel: SeqSelection, id: string): SeqSelection => ({ ...EMPTY_SELECTION, focus: "marker", marker: id, track: sel.track });

/** Points of a lane: alone selects, Shift adds or removes. */
export function clickPoint(sel: SeqSelection, owner: AutomationOwner, automation: string, key: number, mod: Modifiers = {}): SeqSelection {
  const same = sel.points && sel.points.automation === automation && JSON.stringify(sel.points.owner) === JSON.stringify(owner);
  let keys: number[];
  if ((mod.shift || mod.ctrl) && same) keys = sel.points!.keys.includes(key) ? sel.points!.keys.filter((k) => k !== key) : [...sel.points!.keys, key];
  else if (same && sel.points!.keys.includes(key)) keys = [...sel.points!.keys];
  else keys = [key];
  const clips = "clip" in owner ? [owner.clip] : [];
  return { ...EMPTY_SELECTION, focus: keys.length ? "points" : "sequence", clips, track: "track" in owner ? owner.track : sel.track, points: keys.length ? { owner, automation, keys } : null };
}

/** Ctrl+A: every clip. */
export function selectAll(s: SequenceSettings, sel: SeqSelection): SeqSelection {
  const clips = allClips(s).map((c) => c.clip.id);
  return { ...EMPTY_SELECTION, focus: clips.length ? "clips" : "sequence", clips, track: sel.track };
}

/** A marquee over `[t0, t1]` and track rows `[r0, r1]` (indices, inclusive): the clips it touches (Shift adds). */
export function marqueeSelect(s: SequenceSettings, sourceOf: SourceOf, sel: SeqSelection, t0: number, t1: number, r0: number, r1: number, add = false): SeqSelection {
  const [a, b] = t0 <= t1 ? [t0, t1] : [t1, t0];
  const [lo, hi] = r0 <= r1 ? [r0, r1] : [r1, r0];
  const hit = allClips(s).filter((c) => c.ti >= lo && c.ti <= hi && c.clip.at < b && c.clip.at + clipLength(c.clip, sourceOf(c.clip)) > a).map((c) => c.clip.id);
  const clips = add ? [...new Set([...sel.clips, ...hit])] : hit;
  return { ...EMPTY_SELECTION, focus: clips.length ? "clips" : "sequence", clips, track: sel.track };
}

/** The selection after an edit or undo: what no longer exists drops out. */
export function pruneSelection(s: SequenceSettings, sel: SeqSelection): SeqSelection {
  const ids = new Set(allClips(s).map((c) => c.clip.id));
  const clips = sel.clips.filter((c) => ids.has(c));
  const track = sel.track && s.tracks.some((t) => t.id === sel.track) ? sel.track : null;
  const loop = sel.loop && s.loops.some((l) => l.id === sel.loop) ? sel.loop : null;
  const marker = sel.marker && s.markers.some((m) => m.id === sel.marker) ? sel.marker : null;
  let points = sel.points;
  if (points) {
    const lane = ownerOf(s, points.owner)?.automation.find((a) => a.id === points!.automation);
    const keys = lane ? points.keys.filter((k) => k < lane.curve.length) : [];
    points = keys.length ? { ...points, keys } : null;
  }
  const kept = { clips: clips.length > 0, track: !!track, loop: !!loop, marker: !!marker, points: !!points };
  const focus: SeqSelection["focus"] = sel.focus === "sequence" ? "sequence" : kept[sel.focus] ? sel.focus : "sequence";
  const next: SeqSelection = { focus, clips, track, loop, marker, points };
  return same(next, sel) ? sel : next;
}

const same = (a: SeqSelection, b: SeqSelection) =>
  a.focus === b.focus && a.track === b.track && a.loop === b.loop && a.marker === b.marker && a.points === b.points && a.clips.length === b.clips.length && a.clips.every((c, i) => c === b.clips[i]);
