// The Sequence timeline's track, clip and sequence edits (proto §3.3–3.4; labels from the Sequencer's history list,
// proto §3.1). Each is a pure `SeqEdit`: the next `sequence` block, or why it was refused (nothing changes). The view
// applies one per gesture through the screen's `applyEdit` path, so every edit is one labelled undo step. Pure.
import type { Effect, EffectType } from "../../../../engine/audio/effects/types";
import { wouldContain } from "../../../../engine/audio/playlist/references";
import type { Automation, Clip, PlaylistBody, SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import { isMeter } from "../../../../engine/audio/meter";
import { accept, refuse, type EditResult } from "../../../../editor/sdk/editResult";
import { clipPlan, clipToSource } from "./clipGeometry";
import { cutCurve } from "./curveCut";
import {
  allClips, clipIds, clipLength, findClip, fitsTrack, kindRefusal, mapClips, mapTrack, MIN_CLIP_LENGTH, nextId, nextIds, PLAYLIST_CLIP_LENGTH, tidy, trackIndex,
  type SourceFacts, type SourceOf,
} from "./sequenceModel";

type R = EditResult<SequenceSettings>;

// --- tracks ----------------------------------------------------------------------------------------------------------

/** A new track's colour: the series index after the last track's (1..8, wrapping). */
function nextColour(s: SequenceSettings): number {
  const last = s.tracks[s.tracks.length - 1]?.color;
  return typeof last === "number" ? (last % 8) + 1 : (s.tracks.length % 8) + 1;
}

/** The format's track limit (ADR 0343). */
export const MAX_TRACKS = 32;
export const MAX_CLIPS = 512;

export function newTrack(s: SequenceSettings, kind: Track["kind"], name?: string): Track {
  const n = s.tracks.filter((t) => t.kind === kind).length + 1;
  return {
    id: nextId("t", s.tracks.map((t) => t.id)),
    name: name ?? (kind === "audio" ? `Audio ${n}` : `Playlist ${n}`),
    kind, color: nextColour(s), volume: 0, pan: 0, output: null, mute: false, solo: false, enabled: true, effects: [], automation: [], clips: [],
  };
}

/**
 * A new sequence's tracks (the prototype's): an empty Audio 1 for samples and an empty Playlist 1 for playlists, so a
 * drop lands on a track at once (J6.1: a new sequence started with none).
 */
export function starterTracks(s: SequenceSettings): Track[] {
  const audio = newTrack(s, "audio");
  return [audio, newTrack({ ...s, tracks: [audio] }, "playlist")];
}

/** "Add audio track" / "Add playlist track", at the end (or after `after`). */
export function addTrack(s: SequenceSettings, kind: Track["kind"], after?: number): R {
  if (s.tracks.length >= MAX_TRACKS) return refuse(`a sequence holds at most ${MAX_TRACKS} tracks`);
  const t = newTrack(s, kind);
  const tracks = [...s.tracks];
  tracks.splice(after === undefined ? tracks.length : after + 1, 0, t);
  return accept({ ...s, tracks });
}

export function removeTracks(s: SequenceSettings, ids: readonly string[]): R {
  const tracks = s.tracks.filter((t) => !ids.includes(t.id));
  return tracks.length === s.tracks.length ? accept(s) : accept({ ...s, tracks });
}

/** "Duplicate track": a copy right below, with fresh track, clip and automation ids. */
export function duplicateTrack(s: SequenceSettings, id: string): R {
  const i = trackIndex(s, id);
  if (i < 0) return refuse("that track isn't there any more");
  if (s.tracks.length >= MAX_TRACKS) return refuse(`a sequence holds at most ${MAX_TRACKS} tracks`);
  const t = s.tracks[i]!;
  if (allClips(s).length + t.clips.length > MAX_CLIPS) return refuse(`a sequence holds at most ${MAX_CLIPS} clips`);
  const ids = nextIds("c", clipIds(s), t.clips.length);
  const copy: Track = { ...structuredClone(t), id: nextId("t", s.tracks.map((x) => x.id)), name: `${t.name} copy`, clips: t.clips.map((c, k) => ({ ...structuredClone(c), id: ids[k]! })) };
  const tracks = [...s.tracks];
  tracks.splice(i + 1, 0, copy);
  return accept({ ...s, tracks });
}

/** "Reorder tracks": move track `id` to index `to`. */
export function moveTrack(s: SequenceSettings, id: string, to: number): R {
  const i = trackIndex(s, id);
  if (i < 0) return refuse("that track isn't there any more");
  const j = Math.max(0, Math.min(s.tracks.length - 1, to));
  if (i === j) return accept(s);
  const tracks = [...s.tracks];
  const [t] = tracks.splice(i, 1);
  tracks.splice(j, 0, t!);
  return accept({ ...s, tracks });
}

export type TrackPatch = Partial<Pick<Track, "name" | "color" | "volume" | "pan" | "output" | "mute" | "solo" | "enabled">>;

export function setTrack(s: SequenceSettings, id: string, patch: TrackPatch): R {
  if (trackIndex(s, id) < 0) return refuse("that track isn't there any more");
  if (patch.name !== undefined && !patch.name.trim()) return refuse("a track needs a name");
  const clean: TrackPatch = { ...patch };
  if (clean.name !== undefined) clean.name = clean.name.trim();
  if (clean.volume !== undefined) clean.volume = Math.max(-96, Math.min(24, clean.volume));
  if (clean.pan !== undefined) clean.pan = Math.max(-1, Math.min(1, clean.pan));
  return accept(mapTrack(s, id, (t) => ({ ...t, ...clean })));
}

/** A track's effects; automation of a removed effect goes with it (proto "Remove fx (also removes its automation)"). */
export function setTrackEffects(s: SequenceSettings, id: string, effects: Effect[]): R {
  if (trackIndex(s, id) < 0) return refuse("that track isn't there any more");
  return accept(mapTrack(s, id, (t) => ({ ...t, effects, automation: keepFxAutomation(t.automation, effects) })));
}

function keepFxAutomation(list: readonly Automation[], effects: readonly Effect[]): Automation[] {
  return list.filter((a) => !a.target.startsWith("fx:") || effects.some((e) => e.id === a.target.split(":")[1]));
}

// --- adding clips ----------------------------------------------------------------------------------------------------

function baseClip(id: string, at: number): Omit<Clip, "sample" | "playlist"> {
  return { id, at: tidy(Math.max(0, at)), length: 0, offset: 0, gain: 0, pitch: 0, pan: 0, reverse: false, sync: false, enabled: true, loops: {}, hiddenMarkers: [], effects: [], automation: [] };
}

function insertClip(s: SequenceSettings, ti: number, clip: Clip): R {
  if (allClips(s).length >= MAX_CLIPS) return refuse(`a sequence holds at most ${MAX_CLIPS} clips`);
  const tracks = [...s.tracks];
  tracks[ti] = { ...tracks[ti]!, clips: [...tracks[ti]!.clips, clip] };
  return accept({ ...s, tracks });
}

/**
 * "Add clip": a sample dropped on audio track `trackId` at `at`. Its length is the sample's (written out, so trims are
 * explicit); a music sample is a Sync clip (proto). A playlist track refuses.
 */
export function addSampleClip(s: SequenceSettings, trackId: string, sample: string, at: number, src: SourceFacts | null): R {
  const ti = trackIndex(s, trackId);
  if (ti < 0) return refuse("that track isn't there any more");
  if (s.tracks[ti]!.kind !== "audio") return refuse(kindRefusal(s.tracks[ti]!));
  const clip: Clip = { ...baseClip(nextId("c", clipIds(s)), at), sample, length: src?.length ?? 0, sync: src?.kind === "music" };
  return insertClip(s, ti, clip);
}

/** A track name from a sample path's prefix ("audio/brake_skid_02.wav" → "brake"). */
function trackNameFor(sample: string): string {
  const file = sample.slice(sample.lastIndexOf("/") + 1).replace(/\.(sample\.json|wav|ogg|mp3|flac|m4a)$/i, "");
  const head = file.split(/[_\-\s.]+/).find(Boolean) ?? "Audio";
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/** A sample dropped below the tracks: a new audio track named after it, holding the clip (one step, "Add clip"). */
export function addSampleOnNewTrack(s: SequenceSettings, sample: string, at: number, src: SourceFacts | null): R {
  if (s.tracks.length >= MAX_TRACKS) return refuse(`a sequence holds at most ${MAX_TRACKS} tracks`);
  const t = newTrack(s, "audio", trackNameFor(sample));
  return addSampleClip({ ...s, tracks: [...s.tracks, t] }, t.id, sample, at, src);
}

/**
 * "Add playlist clip": playlist file `playlist` on playlist track `trackId` at `at`, 2 s long. Refused on an audio
 * track, and when the playlist contains the sequence (`self`, the sequence's file) through its links.
 */
export function addPlaylistClip(s: SequenceSettings, trackId: string, playlist: string, at: number, self: string, load: (path: string) => PlaylistBody | null | undefined): R {
  const ti = trackIndex(s, trackId);
  if (ti < 0) return refuse("that track isn't there any more");
  const track = s.tracks[ti]!;
  if (track.kind !== "playlist") return refuse("Audio tracks take samples; drop playlists on a Playlist track");
  if (wouldContain(self, playlist, load)) return refuse(`it contains this sequence`);
  return insertClip(s, ti, { ...baseClip(nextId("c", clipIds(s)), at), playlist, length: PLAYLIST_CLIP_LENGTH });
}

// --- moving and trimming ---------------------------------------------------------------------------------------------

/**
 * Move clips `ids` by `dt` seconds (the group clamps so nothing goes before 0) and `trackDelta` tracks. A vertical move
 * happens only when every clip lands on an existing track of its kind; otherwise the clips move in time only.
 */
export function moveClips(s: SequenceSettings, ids: readonly string[], dt: number, trackDelta = 0): R {
  const moving = allClips(s).filter((c) => ids.includes(c.clip.id));
  if (!moving.length) return refuse("those clips aren't there any more");
  const minAt = Math.min(...moving.map((m) => m.clip.at));
  const d = Math.max(-minAt, dt);
  const fits = trackDelta !== 0 && moving.every((m) => {
    const t = s.tracks[m.ti + trackDelta];
    return !!t && fitsTrack(m.clip, t);
  });
  const delta = fits ? trackDelta : 0;
  if (d === 0 && delta === 0) return accept(s);
  const tracks = s.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !ids.includes(c.id)) }));
  for (const m of moving) {
    const to = tracks[m.ti + delta]!;
    to.clips = [...to.clips, { ...m.clip, at: tidy(m.clip.at + d) }];
  }
  // Keep each track's clip order stable for clips that didn't change track.
  for (let i = 0; i < tracks.length; i++) {
    const before = s.tracks[i]!.clips.map((c) => c.id);
    tracks[i]!.clips.sort((a, b) => idx(before, a.id) - idx(before, b.id));
  }
  return accept({ ...s, tracks: tracks.map((t, i) => (sameClips(t.clips, s.tracks[i]!.clips) ? s.tracks[i]! : t)) });
}

const idx = (list: readonly string[], id: string) => {
  const i = list.indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};
const sameClips = (a: readonly Clip[], b: readonly Clip[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/** ↑/↓: move clips to the nearest track of their kind above or below. */
export function moveClipsToAdjacentTrack(s: SequenceSettings, ids: readonly string[], dir: -1 | 1): R {
  const moving = allClips(s).filter((c) => ids.includes(c.clip.id));
  if (!moving.length) return refuse("select a clip first");
  // The smallest step that fits every clip.
  for (let step = 1; step < s.tracks.length; step++) {
    const delta = dir * step;
    if (moving.every((m) => { const t = s.tracks[m.ti + delta]; return !!t && fitsTrack(m.clip, t); })) return moveClips(s, ids, 0, delta);
    if (moving.some((m) => !s.tracks[m.ti + delta])) break;
  }
  return refuse(dir < 0 ? "there's no track of its kind above" : "there's no track of its kind below");
}

/**
 * "Trim clip start": the left edge to `at`. The clip's end stays put; it can't start before its sample does (offset ≥
 * 0) and stays at least 0.02 s long.
 */
export function trimClipStart(s: SequenceSettings, id: string, at: number, sourceOf: SourceOf): R {
  const f = findClip(s, id);
  if (!f) return refuse("that clip isn't there any more");
  const c = f.clip;
  const len = clipLength(c, sourceOf(c));
  const end = c.at + len;
  let d = at - c.at;
  d = Math.max(d, -c.offset, -c.at);
  d = Math.min(d, len - MIN_CLIP_LENGTH);
  if (Math.abs(d) < 1e-9) return accept(s);
  return accept(mapClips(s, (x) => (x.id === id ? { ...x, at: tidy(c.at + d), offset: tidy(c.offset + d), length: tidy(end - (c.at + d)) } : x)));
}

/** "Set clip length": the right edge. It may pass the sample's end: loops fill the extra length. */
export function setClipLength(s: SequenceSettings, id: string, length: number): R {
  const f = findClip(s, id);
  if (!f) return refuse("that clip isn't there any more");
  const l = tidy(Math.max(MIN_CLIP_LENGTH, length));
  return f.clip.length === l ? accept(s) : accept(mapClips(s, (x) => (x.id === id ? { ...x, length: l } : x)));
}

/** `[`: trim the start to the playhead; `]`: the end. The playhead has to be inside the clip. */
export function trimToPlayhead(s: SequenceSettings, id: string, playhead: number, edge: "start" | "end", sourceOf: SourceOf): R {
  const f = findClip(s, id);
  if (!f) return refuse("that clip isn't there any more");
  const len = clipLength(f.clip, sourceOf(f.clip));
  if (playhead <= f.clip.at || playhead >= f.clip.at + len) return refuse("the playhead isn't inside the clip");
  return edge === "start" ? trimClipStart(s, id, playhead, sourceOf) : setClipLength(s, id, playhead - f.clip.at);
}

/** Alt+←/→ moves the end by `dt`; Alt+Shift+←/→ the start. */
export function nudgeClipEdge(s: SequenceSettings, ids: readonly string[], edge: "start" | "end", dt: number, sourceOf: SourceOf): R {
  let next = s;
  for (const id of ids) {
    const f = findClip(next, id);
    if (!f) continue;
    const len = clipLength(f.clip, sourceOf(f.clip));
    const r = edge === "start" ? trimClipStart(next, id, f.clip.at + dt, sourceOf) : setClipLength(next, id, len + dt);
    if ("refused" in r) return r;
    next = r.next;
  }
  return accept(next);
}

/** The split point must be this far from either edge (proto: 10 ms). */
export const SPLIT_MARGIN = 0.01;

/**
 * "Split clip" at sequence time `t`. The left half ends at `t`; the right half starts there with the sample time it
 * would have played (`offset` follows the clip's loop passes), and its clip-time automation is shifted by the split
 * offset (the prototype copied the points unshifted, so the second half's curves were misaligned). Each half keeps the
 * curve's value at the cut with a key there. Parameter-driven automation is copied as is.
 */
export function splitClip(s: SequenceSettings, id: string, t: number, sourceOf: SourceOf): R {
  const f = findClip(s, id);
  if (!f) return refuse("that clip isn't there any more");
  const c = f.clip;
  const src = sourceOf(c);
  const len = clipLength(c, src);
  const rel = t - c.at;
  if (rel <= SPLIT_MARGIN || rel >= len - SPLIT_MARGIN) return refuse("Split point must be inside the clip");
  const plan = clipPlan(c, src);
  const at = clipToSource(plan, rel);
  const offset = at !== null && c.sample !== undefined ? tidy(at - (src?.start ?? 0)) : tidy(c.offset + rel);
  const left: Clip = { ...c, length: tidy(rel), automation: c.automation.map((a) => (isClipTime(a) ? { ...a, curve: cutCurve(a.curve, 0, rel) } : a)) };
  const right: Clip = {
    ...structuredClone(c),
    id: nextId("c", clipIds(s)),
    at: tidy(t),
    offset,
    length: tidy(len - rel),
    automation: c.automation.map((a) => (isClipTime(a) ? { ...a, curve: cutCurve(a.curve, rel, len) } : structuredClone(a))),
  };
  const tracks = [...s.tracks];
  const clips = [...f.track.clips];
  clips.splice(f.ci, 1, left, right);
  tracks[f.ti] = { ...f.track, clips };
  return accept({ ...s, tracks });
}

const isClipTime = (a: Automation) => a.input === "clipTime" || a.input === "voiceTime";

// --- clip lists ------------------------------------------------------------------------------------------------------

export function deleteClips(s: SequenceSettings, ids: readonly string[]): R {
  if (!ids.length) return refuse("select a clip first");
  const tracks = s.tracks.map((t) => (t.clips.some((c) => ids.includes(c.id)) ? { ...t, clips: t.clips.filter((c) => !ids.includes(c.id)) } : t));
  return accept({ ...s, tracks });
}

/** "Duplicate clip(s)": each copy right after the selection's end, on the same track. */
export function duplicateClips(s: SequenceSettings, ids: readonly string[], sourceOf: SourceOf): EditResult<{ seq: SequenceSettings; ids: string[] }> {
  const picked = allClips(s).filter((c) => ids.includes(c.clip.id));
  if (!picked.length) return refuse("select a clip first");
  if (allClips(s).length + picked.length > MAX_CLIPS) return refuse(`a sequence holds at most ${MAX_CLIPS} clips`);
  const start = Math.min(...picked.map((p) => p.clip.at));
  const end = Math.max(...picked.map((p) => p.clip.at + clipLength(p.clip, sourceOf(p.clip))));
  const fresh = nextIds("c", clipIds(s), picked.length);
  const tracks = s.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
  picked.forEach((p, k) => tracks[p.ti]!.clips.push({ ...structuredClone(p.clip), id: fresh[k]!, at: tidy(p.clip.at + (end - start)) }));
  return accept({ seq: { ...s, tracks: tracks.map((t, i) => (t.clips.length === s.tracks[i]!.clips.length ? s.tracks[i]! : t)) }, ids: fresh });
}

/** E: disable the clips when any is enabled, else enable them all. */
export function toggleClipsEnabled(s: SequenceSettings, ids: readonly string[]): EditResult<{ seq: SequenceSettings; enabled: boolean }> {
  const picked = allClips(s).filter((c) => ids.includes(c.clip.id));
  if (!picked.length) return refuse("select a clip first");
  const enabled = !picked.some((p) => p.clip.enabled);
  return accept({ seq: mapClips(s, (c) => (ids.includes(c.id) && c.enabled !== enabled ? { ...c, enabled } : c)), enabled });
}

export type ClipPatch = Partial<Pick<Clip, "at" | "length" | "offset" | "gain" | "pitch" | "pan" | "reverse" | "sync" | "enabled">>;

const CLIP_LIMITS = { gain: [-96, 24], pitch: [-48, 48], pan: [-1, 1] } as const;

/** Inspector fields of one clip ("Clip gain", "Clip start", …); length 0 means to the end of its source. */
export function setClip(s: SequenceSettings, id: string, patch: ClipPatch): R {
  if (!findClip(s, id)) return refuse("that clip isn't there any more");
  const p: ClipPatch = { ...patch };
  for (const k of ["gain", "pitch", "pan"] as const) if (p[k] !== undefined) p[k] = Math.max(CLIP_LIMITS[k][0], Math.min(CLIP_LIMITS[k][1], p[k]!));
  if (p.at !== undefined) p.at = tidy(Math.max(0, p.at));
  if (p.offset !== undefined) p.offset = tidy(Math.max(0, p.offset));
  if (p.length !== undefined) p.length = p.length <= 0 ? 0 : tidy(Math.max(MIN_CLIP_LENGTH, p.length));
  return accept(mapClips(s, (c) => (c.id === id ? { ...c, ...p } : c)));
}

/** A clip's effects (voice level); automation of a removed effect goes with it. */
export function setClipEffects(s: SequenceSettings, id: string, effects: Effect[]): R {
  if (!findClip(s, id)) return refuse("that clip isn't there any more");
  return accept(mapClips(s, (c) => (c.id === id ? { ...c, effects, automation: keepFxAutomation(c.automation, effects) } : c)));
}

/** "Clip async" for every clip a lint says follows (the lint's "Make Async"). */
export const makeAsync = (s: SequenceSettings, id: string): R => setClip(s, id, { sync: false });

/**
 * The effect type every clip on a track has (proto A9b "Move to track" hint: it then runs once on the track's mix
 * instead of on each voice), or null: a track with no clips, or clips without one in common. The first in chain order.
 */
export function sharedClipEffect(t: Pick<Track, "clips" | "effects">): EffectType | null {
  if (!t.clips.length) return null;
  for (const e of t.clips[0]!.effects) {
    if (t.clips.every((c) => c.effects.some((x) => x.type === e.type)) && !t.effects.some((x) => x.type === e.type)) return e.type;
  }
  return null;
}

/** "Move to track": take `type` off every clip of the track (and its curves) and add the first clip's to the track's chain. */
export function moveEffectToTrack(s: SequenceSettings, trackId: string, type: EffectType): R {
  const t = s.tracks[trackIndex(s, trackId)];
  if (!t) return refuse("that track isn't there any more");
  if (sharedClipEffect(t) !== type && !t.clips.every((c) => c.effects.some((e) => e.type === type))) return refuse("not every clip on the track has it");
  const first = t.clips[0]!.effects.find((e) => e.type === type)!;
  const id = nextId("fx", t.effects.map((e) => e.id));
  return accept(mapTrack(s, trackId, (tr) => ({
    ...tr,
    effects: [...tr.effects, { ...first, id, params: { ...first.params } }],
    clips: tr.clips.map((c) => {
      const effects = c.effects.filter((e) => e.type !== type);
      return { ...c, effects, automation: keepFxAutomation(c.automation, effects) };
    }),
  })));
}

// --- the sequence ----------------------------------------------------------------------------------------------------

/** "Sequence length" (0: to the end of the longest clip). */
export function setSequenceLength(s: SequenceSettings, length: number): R {
  const l = length <= 0 ? 0 : tidy(Math.min(86400, length));
  return s.length === l ? accept(s) : accept({ ...s, length: l });
}

/** "Tempo" (20..400 BPM) keeps the meter; "No tempo" is `null`. */
export function setTempo(s: SequenceSettings, bpm: number | null): R {
  if (bpm === null) return accept({ ...s, tempo: null });
  if (!Number.isFinite(bpm)) return refuse("type a number of beats per minute");
  const b = Math.round(Math.max(20, Math.min(400, bpm)) * 1000) / 1000;
  return accept({ ...s, tempo: { bpm: b, meter: s.tempo?.meter ?? "4/4" } });
}

/** "Meter": needs a tempo (it starts one at 120 BPM). */
export function setMeter(s: SequenceSettings, meter: string): R {
  if (!isMeter(meter)) return refuse(`"${meter}" isn't a meter like 4/4`);
  return accept({ ...s, tempo: { bpm: s.tempo?.bpm ?? 120, meter } });
}
