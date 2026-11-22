// The Sequence view's shared model pieces (ADR 0329 Sequence; the prototype's Sequencer, proto §1.5): what a clip's
// source tells the timeline (`SourceFacts`, read from the sample's sidecar or the linked playlist), a clip's length
// when its file says 0 ("to the end of the source"), the sequence's length when it says 0 ("to the end of the longest
// clip"), finding clips and tracks, fresh ids, and lifting an edit of the `sequence` block into an edit of the playlist
// body (the Playlists screen's `onEdit` takes body edits). Pure.
import type { Clip, LoopBehaviour, PlaylistBody, SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import { accept, refuse, type EditResult } from "../../../../plugins/audio/editor/editResult";

/** An edit of the `sequence` block. */
export type SeqEdit = (s: SequenceSettings) => EditResult<SequenceSettings>;
/** An edit of the playlist body (what the screen applies). */
export type BodyEdit = (b: PlaylistBody) => EditResult<PlaylistBody>;

/** A sample loop as a clip sees it (source time, seconds). */
export interface SourceLoop extends LoopBehaviour {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

/** A sample marker as a clip sees it (source time). */
export interface SourceMarker {
  readonly id: string;
  readonly name: string;
  readonly at: number;
  readonly type: "note" | "exit" | "hit" | "cue";
}

/** What the timeline knows about a clip's source; `length` null while unknown (peaks not read yet). */
export interface SourceFacts {
  /** The playable length in seconds: the sample after its trim, or a playlist's natural length. */
  readonly length: number | null;
  /** Where the trimmed sample starts in its file (loops and markers are in file time), default 0. */
  readonly start?: number;
  readonly loops: readonly SourceLoop[];
  readonly markers: readonly SourceMarker[];
  /** The sample's kind (music samples default to Sync clips). */
  readonly kind?: "oneshot" | "loop" | "sustain" | "music";
  readonly bpm?: number | null;
}

/** What the timeline asks about a clip's source. Null: unknown. */
export type SourceOf = (clip: Clip) => SourceFacts | null;

/** The shortest clip (prototype trim minimum). */
export const MIN_CLIP_LENGTH = 0.02;
/** A playlist clip's length when it is made (prototype default). */
export const PLAYLIST_CLIP_LENGTH = 2;
/** A sequence with no clips and no length is this long (the format's default). */
export const EMPTY_SEQUENCE_LENGTH = 4;

/** Lift a sequence edit into a body edit; a body without a sequence refuses. */
export function onSequence(edit: SeqEdit): BodyEdit {
  return (b) => {
    if (!b.sequence) return refuse("this playlist isn't a Sequence");
    const r = edit(b.sequence);
    if ("refused" in r) return r;
    return r.next === b.sequence ? accept(b) : accept({ ...b, sequence: r.next });
  };
}

/** A clip's length in seconds: its own, else to the end of its source (after its offset), else a default. */
export function clipLength(c: Clip, src: SourceFacts | null): number {
  if (c.length > 0) return c.length;
  if (src?.length != null) return Math.max(MIN_CLIP_LENGTH, src.length - c.offset);
  return c.playlist !== undefined ? PLAYLIST_CLIP_LENGTH : 1;
}

const clipEnd = (c: Clip, src: SourceFacts | null): number => c.at + clipLength(c, src);

/** The end of the longest clip (0 with none). */
function contentEnd(s: SequenceSettings, sourceOf: SourceOf): number {
  let end = 0;
  for (const t of s.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c, sourceOf(c)));
  return end;
}

/** The sequence's length: its own, else the end of the longest clip, else the default. */
export function sequenceLength(s: SequenceSettings, sourceOf: SourceOf): number {
  if (s.length > 0) return s.length;
  const end = contentEnd(s, sourceOf);
  return end > 0 ? end : EMPTY_SEQUENCE_LENGTH;
}

/** A clip and where it sits. */
export interface ClipAt {
  readonly track: Track;
  readonly ti: number;
  readonly clip: Clip;
  readonly ci: number;
}

/**
 * ADR 0336: the tails the timeline shades. `postExit`: from the last Exit marker to the end of the audio (`end`, the
 * sequence's length or its longest clip's end), what rings on when a Switch hands over there. `loopTail`: for a loop
 * with `tail`, from its end to the first Exit marker after it, what rings over the next pass at each wrap.
 */
export function sequenceTails(s: SequenceSettings, end: number): { kind: "postExit" | "loopTail"; from: number; to: number; loop?: string }[] {
  const out: { kind: "postExit" | "loopTail"; from: number; to: number; loop?: string }[] = [];
  const exits = s.markers.filter((m) => m.type === "exit").map((m) => m.at).sort((a, b) => a - b);
  const last = exits.at(-1);
  if (last !== undefined && end > last + 1e-6) out.push({ kind: "postExit", from: last, to: end });
  for (const l of s.loops) {
    if (!l.tail || l.end <= l.start) continue;
    const next = exits.find((x) => x > l.end + 1e-9);
    if (next !== undefined) out.push({ kind: "loopTail", from: l.end, to: next, loop: l.id });
  }
  return out;
}

export function findClip(s: SequenceSettings, id: string): ClipAt | null {
  for (let ti = 0; ti < s.tracks.length; ti++) {
    const track = s.tracks[ti]!;
    const ci = track.clips.findIndex((c) => c.id === id);
    if (ci >= 0) return { track, ti, clip: track.clips[ci]!, ci };
  }
  return null;
}

export const trackIndex = (s: SequenceSettings, id: string): number => s.tracks.findIndex((t) => t.id === id);

/** Every clip of the sequence, in track order. */
export const allClips = (s: SequenceSettings): ClipAt[] => s.tracks.flatMap((track, ti) => track.clips.map((clip, ci) => ({ track, ti, clip, ci })));

/** `prefix` + the smallest number not taken ("c4"). */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** `count` fresh ids at once (each distinct from the others). */
export function nextIds(prefix: string, taken: Iterable<string>, count: number): string[] {
  const used = new Set(taken);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId(prefix, used);
    used.add(id);
    out.push(id);
  }
  return out;
}

export const clipIds = (s: SequenceSettings): string[] => allClips(s).map((c) => c.clip.id);

/** Replace the clips whose ids `fn` maps (unchanged clips keep their identity; an untouched sequence is itself). */
export function mapClips(s: SequenceSettings, fn: (c: Clip, track: Track) => Clip): SequenceSettings {
  let changed = false;
  const tracks = s.tracks.map((t) => {
    let tc = false;
    const clips = t.clips.map((c) => {
      const n = fn(c, t);
      if (n !== c) tc = true;
      return n;
    });
    if (!tc) return t;
    changed = true;
    return { ...t, clips };
  });
  return changed ? { ...s, tracks } : s;
}

/** Replace one track by id. */
export function mapTrack(s: SequenceSettings, id: string, fn: (t: Track) => Track): SequenceSettings {
  const i = trackIndex(s, id);
  if (i < 0) return s;
  const n = fn(s.tracks[i]!);
  if (n === s.tracks[i]) return s;
  const tracks = [...s.tracks];
  tracks[i] = n;
  return { ...s, tracks };
}

/** A track kind takes this clip kind ("audio" takes samples, "playlist" playlists). */
export const fitsTrack = (c: Pick<Clip, "sample" | "playlist">, t: Pick<Track, "kind">): boolean => (t.kind === "audio" ? c.sample !== undefined : c.playlist !== undefined);

/** Why a clip can't go on a track, in the prototype's words. */
export const kindRefusal = (t: Pick<Track, "kind">): string => (t.kind === "playlist" ? "Playlist tracks take a playlist, not samples" : "Audio tracks take samples; drop playlists on a Playlist track");

/** Round to a microsecond, so snapped values don't drift (0.30000000000000004). */
export const tidy = (t: number): number => Math.round(t * 1e6) / 1e6;

/** "Move clip" / "Move 3 clips". */
export const plural = (n: number, one: string, many: string = `${one}s`): string => (n === 1 ? one : `${n} ${many}`);
