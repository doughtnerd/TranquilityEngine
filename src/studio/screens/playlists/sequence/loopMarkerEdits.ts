// Sequence loops, hold points, markers and per-clip loop/marker overrides (proto §1.5, §3.4 "Loop/marker rows"; labels
// from the Sequencer's history list). A sequence loop is `{ start, end }` plus its behaviour; start == end is a hold
// point (the playhead parks there while it is active). A clip's override changes some of a sample loop's behaviour
// for that clip only ("Override" vs "Inherited"); "Use sample loop settings" drops it. Pure.
import type { Clip, FadeShape, LoopBehaviour, SequenceLoop, SequenceMarker, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { DEFAULT_EXIT_FADE_MS, MAX_EXIT_FADE_MS } from "../../../../engine/audio/playlist/loopBehaviour";
import { accept, refuse, type EditResult } from "../../../../plugins/audio/editor/editResult";
import { findClip, mapClips, nextId, tidy } from "./sequenceModel";

type R = EditResult<SequenceSettings>;

/** The format's limits (ADR 0343). */
export const MAX_SEQUENCE_LOOPS = 64;
export const MAX_SEQUENCE_MARKERS = 256;

/** A new loop's behaviour: always active, finish the pass on exit. */
const defaultBehaviour = (): LoopBehaviour => ({ active: "always", exit: "finish", exitFadeMs: DEFAULT_EXIT_FADE_MS, reentry: "ignore" });

/** "Add loop" over `[a, b]` (either order), or "Add hold point" when they're equal. Returns the new loop's id too. */
export function addLoop(s: SequenceSettings, a: number, b: number): EditResult<{ seq: SequenceSettings; id: string }> {
  if (s.loops.length >= MAX_SEQUENCE_LOOPS) return refuse(`a sequence holds at most ${MAX_SEQUENCE_LOOPS} loops`);
  const start = tidy(Math.max(0, Math.min(a, b))), end = tidy(Math.max(0, Math.max(a, b)));
  const id = nextId("l", s.loops.map((l) => l.id));
  // A hold point waits for release by default (the prototype's seed hold points are "while held").
  const behaviour: LoopBehaviour = start === end ? { ...defaultBehaviour(), active: "held", exit: "jump" } : defaultBehaviour();
  return accept({ seq: { ...s, loops: [...s.loops, { id, start, end, ...behaviour }] }, id });
}

function mapLoop(s: SequenceSettings, id: string, fn: (l: SequenceLoop) => SequenceLoop): R {
  const i = s.loops.findIndex((l) => l.id === id);
  if (i < 0) return refuse("that loop isn't there any more");
  const loops = [...s.loops];
  loops[i] = fn(loops[i]!);
  return accept({ ...s, loops });
}

/** "Move loop": both ends by `dt` (never before 0). */
export const moveLoop = (s: SequenceSettings, id: string, dt: number): R =>
  mapLoop(s, id, (l) => {
    const d = Math.max(-l.start, dt);
    return { ...l, start: tidy(l.start + d), end: tidy(l.end + d) };
  });

/** "Loop start" / "Loop end" (a drag past the other end swaps them). Stretching a hold point's cap makes it a loop. */
export const setLoopEdge = (s: SequenceSettings, id: string, edge: "start" | "end", t: number): R =>
  mapLoop(s, id, (l) => {
    const v = tidy(Math.max(0, t));
    const [start, end] = edge === "start" ? [v, l.end] : [l.start, v];
    return { ...l, start: Math.min(start, end), end: Math.max(start, end) };
  });

/** "Make hold point": the loop shrinks to its start. */
export const makeHoldPoint = (s: SequenceSettings, id: string): R => mapLoop(s, id, (l) => ({ ...l, end: l.start }));

/** The behaviour fields of a loop ("Loop active: k", "Loop exit", "Loop re-entry", "Exit fade", "Bind parameter", …). */
export function setLoopBehaviour(s: SequenceSettings, id: string, patch: Partial<LoopBehaviour>): R {
  return mapLoop(s, id, (l) => cleanBehaviour({ ...l, ...patch }));
}

/** ADR 0350: a sequence loop's tail ("Ring the tail") and its crossfade exit's shape; false and equal power are written as absent. */
export function setLoopMusic(s: SequenceSettings, id: string, patch: { tail?: boolean; exitShape?: FadeShape }): R {
  return mapLoop(s, id, (l) => {
    const next = { ...l };
    if ("tail" in patch) { if (patch.tail) next.tail = true; else delete next.tail; }
    if ("exitShape" in patch) { if (patch.exitShape && patch.exitShape !== "equalPower") next.exitShape = patch.exitShape; else delete next.exitShape; }
    return next;
  });
}

function cleanBehaviour<T extends LoopBehaviour>(l: T): T {
  const out = { ...l, exitFadeMs: Math.max(0, Math.min(MAX_EXIT_FADE_MS, Math.round(l.exitFadeMs))) };
  if (out.active !== "parameter") delete out.binding;
  return out;
}

export function deleteLoops(s: SequenceSettings, ids: readonly string[]): R {
  const loops = s.loops.filter((l) => !ids.includes(l.id));
  return loops.length === s.loops.length ? refuse("that loop isn't there any more") : accept({ ...s, loops });
}

// --- markers ---------------------------------------------------------------------------------------------------------

/** "Add marker" at `at`, named "Marker N". Returns its id. */
export function addMarker(s: SequenceSettings, at: number, name?: string, type?: SequenceMarker["type"]): EditResult<{ seq: SequenceSettings; id: string }> {
  if (s.markers.length >= MAX_SEQUENCE_MARKERS) return refuse(`a sequence holds at most ${MAX_SEQUENCE_MARKERS} markers`);
  const id = nextId("m", s.markers.map((m) => m.id));
  const m: SequenceMarker = { id, name: name ?? `Marker ${s.markers.length + 1}`, at: tidy(Math.max(0, at)) };
  if (type && type !== "note") m.type = type;
  return accept({ seq: { ...s, markers: [...s.markers, m] }, id });
}

function mapMarker(s: SequenceSettings, id: string, fn: (m: SequenceMarker) => SequenceMarker): R {
  const i = s.markers.findIndex((m) => m.id === id);
  if (i < 0) return refuse("that marker isn't there any more");
  const markers = [...s.markers];
  markers[i] = fn(markers[i]!);
  return accept({ ...s, markers });
}

export const moveMarker = (s: SequenceSettings, id: string, at: number): R => mapMarker(s, id, (m) => ({ ...m, at: tidy(Math.max(0, at)) }));

export function renameMarker(s: SequenceSettings, id: string, name: string): R {
  if (!name.trim()) return refuse("a marker needs a name");
  return mapMarker(s, id, (m) => ({ ...m, name: name.trim() }));
}

/** Note (a label), Cue (reported to the game) or Exit (Switch rules timed `exit` and sync clips may leave here). */
export const setMarkerType = (s: SequenceSettings, id: string, type: NonNullable<SequenceMarker["type"]>): R =>
  mapMarker(s, id, (m) => {
    const { type: _old, ...rest } = m;
    return type === "note" ? rest : { ...rest, type };
  });

export function deleteMarkers(s: SequenceSettings, ids: readonly string[]): R {
  const markers = s.markers.filter((m) => !ids.includes(m.id));
  return markers.length === s.markers.length ? refuse("that marker isn't there any more") : accept({ ...s, markers });
}

/** Nudge (←/→) loops and markers by `dt`. */
export function nudgeLoopsAndMarkers(s: SequenceSettings, loopIds: readonly string[], markerIds: readonly string[], dt: number): R {
  let next = s;
  for (const id of loopIds) {
    const r = moveLoop(next, id, dt);
    if ("refused" in r) return r;
    next = r.next;
  }
  for (const id of markerIds) {
    const m = next.markers.find((x) => x.id === id);
    if (!m) continue;
    const r = moveMarker(next, id, m.at + dt);
    if ("refused" in r) return r;
    next = r.next;
  }
  return accept(next);
}

// --- per-clip overrides ----------------------------------------------------------------------------------------------

type Override = Clip["loops"][string];

/** Override some of sample loop `loopId`'s behaviour in this clip (the fields it sets win over the sample's). */
export function setLoopOverride(s: SequenceSettings, clipId: string, loopId: string, patch: Partial<LoopBehaviour>): R {
  if (!findClip(s, clipId)) return refuse("that clip isn't there any more");
  return accept(mapClips(s, (c) => {
    if (c.id !== clipId) return c;
    const o: Override = { ...(c.loops[loopId] ?? {}), ...patch };
    if (o.exitFadeMs !== undefined) o.exitFadeMs = Math.max(0, Math.min(MAX_EXIT_FADE_MS, Math.round(o.exitFadeMs)));
    if (o.active !== undefined && o.active !== "parameter") delete o.binding;
    return { ...c, loops: { ...c.loops, [loopId]: o } };
  }));
}

/** "Use sample loop settings": drop this clip's override of `loopId`. */
export function clearLoopOverride(s: SequenceSettings, clipId: string, loopId: string): R {
  const f = findClip(s, clipId);
  if (!f) return refuse("that clip isn't there any more");
  if (!(loopId in f.clip.loops)) return accept(s);
  return accept(mapClips(s, (c) => {
    if (c.id !== clipId) return c;
    const { [loopId]: _gone, ...loops } = c.loops;
    return { ...c, loops };
  }));
}

/** "Ignore marker in clip" / "Use marker in clip": hide or show sample marker `markerId` in this clip only. */
export function setMarkerHidden(s: SequenceSettings, clipId: string, markerId: string, hidden: boolean): R {
  const f = findClip(s, clipId);
  if (!f) return refuse("that clip isn't there any more");
  const has = f.clip.hiddenMarkers.includes(markerId);
  if (has === hidden) return accept(s);
  return accept(mapClips(s, (c) => (c.id === clipId ? { ...c, hiddenMarkers: hidden ? [...c.hiddenMarkers, markerId] : c.hiddenMarkers.filter((m) => m !== markerId) } : c)));
}
