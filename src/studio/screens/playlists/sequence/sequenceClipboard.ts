// Copy and paste in the Sequence timeline (proto §3.4 "Copy/paste"): clips, loops, markers and automation points.
// Clips paste at the playhead on the focused track, keeping their tracks' relative offsets, and only onto tracks of
// their kind; loops and markers at the playhead; points at the playhead (a parameter curve's at their own x),
// replacing the points within the pasted span, and a time curve's points don't go into a parameter curve (or the
// reverse). Pure.
import type { CurveKey } from "../../../../engine/core/curve";
import type { Clip, SequenceLoop, SequenceMarker, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { accept, refuse, type EditResult } from "../../../../editor/sdk/editResult";
import { isTimeInput, MAX_KEYS, ownerOf, setAutomation, type AutomationOwner } from "./automationEdits";
import { MAX_SEQUENCE_LOOPS, MAX_SEQUENCE_MARKERS } from "./loopMarkerEdits";
import { shiftKey } from "./curveCut";
import { MAX_CLIPS } from "./sequenceEdits";
import type { SeqSelection } from "./sequenceSelection";
import { allClips, clipIds, findClip, fitsTrack, nextIds, tidy, trackIndex } from "./sequenceModel";

export type SeqClipboard =
  | { readonly kind: "clips"; readonly items: readonly { readonly dTrack: number; readonly clip: Clip }[] }
  | { readonly kind: "loops"; readonly loops: readonly SequenceLoop[] }
  | { readonly kind: "markers"; readonly markers: readonly SequenceMarker[] }
  | { readonly kind: "points"; readonly time: boolean; readonly keys: readonly CurveKey[] };

/** What Ctrl+C copies from the selection (null: nothing to copy). Times are relative to the earliest item. */
export function copySelection(s: SequenceSettings, sel: SeqSelection): SeqClipboard | null {
  if (sel.focus === "points" && sel.points) {
    const lane = ownerOf(s, sel.points.owner)?.automation.find((a) => a.id === sel.points!.automation);
    if (!lane) return null;
    const keys = sel.points.keys.filter((k) => k < lane.curve.length).sort((a, b) => a - b).map((k) => lane.curve[k]!);
    if (!keys.length) return null;
    return { kind: "points", time: isTimeInput(lane.input), keys: keys.map((k) => shiftKey(k, -keys[0]![0])) };
  }
  if (sel.focus === "loop" && sel.loop) {
    const l = s.loops.find((x) => x.id === sel.loop);
    return l ? { kind: "loops", loops: [{ ...l, start: 0, end: tidy(l.end - l.start) }] } : null;
  }
  if (sel.focus === "marker" && sel.marker) {
    const m = s.markers.find((x) => x.id === sel.marker);
    return m ? { kind: "markers", markers: [{ ...m, at: 0 }] } : null;
  }
  const picked = allClips(s).filter((c) => sel.clips.includes(c.clip.id));
  if (!picked.length) return null;
  const t0 = Math.min(...picked.map((p) => p.clip.at));
  const top = Math.min(...picked.map((p) => p.ti));
  return { kind: "clips", items: picked.map((p) => ({ dTrack: p.ti - top, clip: { ...structuredClone(p.clip), at: tidy(p.clip.at - t0) } })) };
}

export interface PasteTarget {
  readonly playhead: number;
  /** The focused track (clips land here, the topmost copied track's place). */
  readonly track: string | null;
  /** The lane points go into. */
  readonly lane: { readonly owner: AutomationOwner; readonly automation: string } | null;
}

/** "Paste clip(s)", "Paste automation points", … Returns the next sequence and what to select. */
export function paste(s: SequenceSettings, clip: SeqClipboard, at: PasteTarget): EditResult<{ seq: SequenceSettings; clips: string[]; loop?: string; marker?: string }> {
  switch (clip.kind) {
    case "clips": {
      const top = at.track ? trackIndex(s, at.track) : 0;
      if (top < 0 || !s.tracks.length) return refuse("add a track first");
      if (allClips(s).length + clip.items.length > MAX_CLIPS) return refuse(`a sequence holds at most ${MAX_CLIPS} clips`);
      for (const it of clip.items) {
        const t = s.tracks[top + it.dTrack];
        if (!t) return refuse("there aren't enough tracks below the focused one");
        if (!fitsTrack(it.clip, t)) return refuse(t.kind === "playlist" ? "sample clips don't paste onto playlist tracks" : "playlist clips paste only onto playlist tracks");
      }
      const ids = nextIds("c", clipIds(s), clip.items.length);
      const tracks = s.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
      clip.items.forEach((it, k) => tracks[top + it.dTrack]!.clips.push({ ...structuredClone(it.clip), id: ids[k]!, at: tidy(at.playhead + it.clip.at) }));
      return accept({ seq: { ...s, tracks: tracks.map((t, i) => (t.clips.length === s.tracks[i]!.clips.length ? s.tracks[i]! : t)) }, clips: ids });
    }
    case "loops": {
      if (s.loops.length + clip.loops.length > MAX_SEQUENCE_LOOPS) return refuse(`a sequence holds at most ${MAX_SEQUENCE_LOOPS} loops`);
      const ids = nextIds("l", s.loops.map((l) => l.id), clip.loops.length);
      const loops = clip.loops.map((l, k) => ({ ...l, id: ids[k]!, start: tidy(at.playhead + l.start), end: tidy(at.playhead + l.end) }));
      return accept({ seq: { ...s, loops: [...s.loops, ...loops] }, clips: [], loop: ids[0] });
    }
    case "markers": {
      if (s.markers.length + clip.markers.length > MAX_SEQUENCE_MARKERS) return refuse(`a sequence holds at most ${MAX_SEQUENCE_MARKERS} markers`);
      const ids = nextIds("m", s.markers.map((m) => m.id), clip.markers.length);
      const markers = clip.markers.map((m, k) => ({ ...m, id: ids[k]!, at: tidy(at.playhead + m.at) }));
      return accept({ seq: { ...s, markers: [...s.markers, ...markers] }, clips: [], marker: ids[0] });
    }
    case "points": {
      if (!at.lane) return refuse("select an automation lane or a point to paste into");
      const lane = ownerOf(s, at.lane.owner)?.automation.find((a) => a.id === at.lane!.automation);
      if (!lane) return refuse("that automation isn't there any more");
      const time = isTimeInput(lane.input);
      if (time && !clip.time) return refuse("parameter curve points don't go into a time curve");
      if (!time && clip.time) return refuse("time curve points don't go into a parameter curve");
      let x0 = 0;
      if (time) {
        x0 = at.playhead;
        if ("clip" in at.lane.owner) x0 -= findClip(s, at.lane.owner.clip)?.clip.at ?? 0;
        x0 = Math.max(0, x0);
      } else x0 = 0;
      const placed = time ? clip.keys.map((k) => shiftKey(k, x0)) : clip.keys.map((k) => shiftKey(k, 0));
      const lo = placed[0]![0], hi = placed[placed.length - 1]![0];
      const curve = [...lane.curve.filter((k) => k[0] < lo - 1e-9 || k[0] > hi + 1e-9), ...placed].sort((a, b) => a[0] - b[0]);
      if (curve.length > MAX_KEYS) return refuse(`a curve holds at most ${MAX_KEYS} keys`);
      const r = setAutomation(s, at.lane.owner, lane.id, { curve });
      return "refused" in r ? r : accept({ seq: r.next, clips: [] });
    }
  }
}

/** The paste's undo label (proto history list). */
export function pasteLabel(clip: SeqClipboard): string {
  switch (clip.kind) {
    case "clips": return clip.items.length === 1 ? "Paste clip" : "Paste clips";
    case "loops": return "Paste loop";
    case "markers": return "Paste marker";
    case "points": return "Paste automation points";
  }
}
