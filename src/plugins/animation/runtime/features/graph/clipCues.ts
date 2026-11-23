// A compiled clip's sections (ADR 0372: `play(clip, { slot, section })`), read on the host from its `cue` markers
// (`myco.anim@1`'s `marker` track keys, kind `Cue`: `native/anim/crates/anim-format/src/clip.rs`). A section starts at
// its cue and runs to the next cue, or the clip's end (Unreal's montage sections). Its `hit` markers are read the same
// way, for musical timing's `align: "hit"` (T72). Lenient: bytes that don't parse give no sections or hits, never
// throw. A pure library.
import { readAnimationHeader } from "../../../../../engine/animation/binaryHeader";

const NONE = 0xffffffff;
const TRACK_LEN = 32;
const KEY_LEN = 32;
/** `TrackKind::Marker`, and `MarkerKind::Hit` and `MarkerKind::Cue`. */
const TRACK_MARKER = 14;
const MARKER_HIT = 2;
const MARKER_CUE = 3;

/** @internal One cue: its name and time (clip seconds). */
export interface ClipCue {
  readonly name: string;
  readonly time: number;
}

/** A clip's markers of `kind`, by time (`name` null for an unnamed one); empty when it has none or the bytes aren't a clip. */
function readMarkers(bytes: Uint8Array, kind: number): { name: string | null; time: number }[] {
  const read = readAnimationHeader(bytes, "myco.anim@1");
  if (!read.ok) return [];
  const sec = (name: string) => read.header.sections.find((s) => s.name === name);
  const strings = sec("STRINGS"), tracks = sec("TRACKS"), keys = sec("KEYS");
  if (!strings || !tracks || !keys) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => view.getUint32(at, true);
  const chars = strings.offset + 4 * (strings.count + 1);
  const decoder = new TextDecoder();
  const string = (id: number): string | null =>
    id === NONE || id >= strings.count ? null : decoder.decode(bytes.subarray(chars + u32(strings.offset + 4 * id), chars + u32(strings.offset + 4 * id + 4)));
  const out: { name: string | null; time: number }[] = [];
  for (let t = 0; t < tracks.count; t++) {
    const at = tracks.offset + t * TRACK_LEN;
    if (view.getUint8(at) !== TRACK_MARKER) continue;
    const first = u32(at + 24), count = u32(at + 28);
    for (let k = first; k < first + count && k < keys.count; k++) {
      const ka = keys.offset + k * KEY_LEN;
      if (u32(ka + 8) !== kind) continue;
      const time = view.getFloat32(ka, true);
      if (Number.isFinite(time)) out.push({ name: string(u32(ka + 12)), time });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** @internal A clip's named cues, by time; empty when it has none or the bytes aren't a clip. */
export function readClipCues(bytes: Uint8Array): ClipCue[] {
  const cues: ClipCue[] = [];
  for (const m of readMarkers(bytes, MARKER_CUE)) if (m.name) cues.push({ name: m.name, time: m.time });
  return cues;
}

/** @internal The times (clip seconds, ascending) of a clip's `hit` markers, named or not; empty when it has none. */
export function readClipHits(bytes: Uint8Array): number[] {
  return readMarkers(bytes, MARKER_HIT).map((m) => m.time);
}

/** @internal Section `name` of `cues`: from its cue to the next later cue (`end` 0: the clip's end); null when no cue has that name. */
export function sectionRange(cues: readonly ClipCue[], name: string): { start: number; end: number } | null {
  const i = cues.findIndex((c) => c.name === name);
  if (i < 0) return null;
  const start = cues[i]!.time;
  const next = cues.slice(i + 1).find((c) => c.time > start);
  return { start, end: next ? next.time : 0 };
}
