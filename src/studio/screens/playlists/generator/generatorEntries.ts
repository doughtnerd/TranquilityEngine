// Generators in playlists and sequences, and in the Library (ADR 0360 §1, §9): what "Add generator" and "New embedded
// generator" do to the open playlist (a Clip's source becomes the generator; any other playlist gets it wrapped in an
// embedded Clip, as a sample is), a generator clip on a sequence's audio track, the open Clip's generator (which the
// Generator editor edits when it is embedded), and the Library's generator rows. Each edit is a pure `EditResult`
// the screen applies as one undo step. Pure.
import { generatorIsEndless, generatorSpec } from "../../../../engine/audio/generators/catalogue";
import { isGeneratorPath, parseGenerator } from "../../../../engine/audio/generators/format";
import type { GeneratorBody, GeneratorKind } from "../../../../engine/audio/generators/types";
import { defaultEntryUse, emptyPlaylistBody } from "../../../../engine/audio/playlist/format";
import type { Clip, Entry, GeneratorEntry, PlaylistBody, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { accept, refuse, type EditResult } from "../../../../editor/sdk/editResult";
import { addEntries, type EditContext } from "../playlistEdits";
import { MAX_CLIPS, MAX_TRACKS, newTrack } from "../sequence/sequenceEdits";
import { allClips, clipIds, nextId, tidy } from "../sequence/sequenceModel";
import { generatorSoundSeconds } from "./previewRender";

/** A generator's name: its file's, without `.generator.json`. */
export const generatorName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.generator\.json$/i, "");

/** A generator entry of `generator` (a path or an embedded body). */
export const generatorEntry = (generator: string | GeneratorBody): GeneratorEntry => ({ kind: "generator", generator, ...defaultEntryUse() });

/**
 * "Add generator" to playlist `b`: a Clip plays it (its source replaced), a Sequence refuses (its clips go on tracks),
 * and any other playlist gets a new entry: an embedded Clip of the generator.
 */
export function addGenerator(b: PlaylistBody, generator: string | GeneratorBody, ctx: EditContext): EditResult<PlaylistBody> {
  if (b.type === "sequence") return refuse("a Sequence's generators go on an audio track");
  if (b.type === "clip") return accept({ ...b, entries: [generatorEntry(generator)] });
  const wrapped: Entry = { kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [generatorEntry(generator)] }, ...defaultEntryUse() };
  return addEntries(b, [wrapped], ctx);
}

/** The generator a Clip plays (its first generator entry, if that is what it plays), with the entry's index. */
export function clipGenerator(b: PlaylistBody | null): { index: number; generator: string | GeneratorBody } | null {
  if (!b || b.type !== "clip") return null;
  const index = b.entries.findIndex((e) => e.kind === "sample" || e.kind === "line" || e.kind === "generator");
  const e = b.entries[index];
  return e?.kind === "generator" ? { index, generator: e.generator } : null;
}

/** Replace the embedded generator a Clip plays with `next` (the Generator editor's edit of an embedded generator). */
export function setClipGenerator(b: PlaylistBody, next: GeneratorBody): EditResult<PlaylistBody> {
  const g = clipGenerator(b);
  if (!g) return refuse("this Clip doesn't play a generator");
  if (typeof g.generator === "string") return refuse(`it plays ${g.generator}; edit that file`);
  if (g.generator === next) return accept(b);
  const entries = [...b.entries];
  entries[g.index] = { ...(entries[g.index] as GeneratorEntry), generator: next };
  return accept({ ...b, entries });
}

/**
 * How long a generator clip is on a timeline: its sound's length (`generatorSoundSeconds`: to the end of its release,
 * its sfxr envelope or its `length`); an endless one 2 s, ended at the clip's end.
 */
export function generatorClipLength(body: GeneratorBody | null): number {
  if (!body) return 2;
  if (generatorIsEndless(body.kind, body.params)) return 2;
  return tidy(Math.max(0.05, Math.min(60, generatorSoundSeconds(body))));
}

/**
 * "Add generator" to a sequence: a generator clip at `at` on the first audio track, or on a new audio track named after
 * the generator when there is none (ADR 0360: generator clips sit on audio tracks).
 */
export function addGeneratorClip(s: SequenceSettings, generator: string | GeneratorBody, at: number, length: number): EditResult<SequenceSettings> {
  if (allClips(s).length >= MAX_CLIPS) return refuse(`a sequence holds at most ${MAX_CLIPS} clips`);
  let tracks = s.tracks;
  let ti = tracks.findIndex((t) => t.kind === "audio");
  if (ti < 0) {
    if (tracks.length >= MAX_TRACKS) return refuse(`a sequence holds at most ${MAX_TRACKS} tracks`);
    const name = typeof generator === "string" ? generatorName(generator) : generatorSpec(generator.kind).label;
    tracks = [...tracks, newTrack(s, "audio", name)];
    ti = tracks.length - 1;
  }
  const clip: Clip = {
    id: nextId("c", clipIds(s)), generator, at: tidy(Math.max(0, at)), length: tidy(Math.max(0.05, length)), offset: 0, gain: 0, pitch: 0, pan: 0,
    reverse: false, sync: false, enabled: true, loops: {}, hiddenMarkers: [], effects: [], automation: [],
  };
  const next = [...tracks];
  next[ti] = { ...next[ti]!, clips: [...next[ti]!.clips, clip] };
  return accept({ ...s, tracks: next });
}

// --- the Library's generators ----------------------------------------------------------------------------------------

export interface GeneratorRow {
  readonly path: string;
  readonly name: string;
  /** Null when the file can't be read. */
  readonly kind: GeneratorKind | null;
  readonly preset: string | null;
}

/** The project's generators (matching every word of `query` in their path), A–Z, with their kind. */
export function libraryGenerators(files: readonly string[], query: string, read: (path: string) => unknown): GeneratorRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hidden = (p: string) => p.split("/").some((part) => part.startsWith("."));
  return files
    .filter((p) => isGeneratorPath(p) && !hidden(p) && words.every((w) => p.toLowerCase().includes(w)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((path) => {
      const raw = read(path);
      const g = raw === undefined ? null : parseGenerator(raw).generator;
      return { path, name: generatorName(path), kind: g?.kind ?? null, preset: g?.preset ?? null };
    });
}

/** The drag payload of a Library generator row (`text/plain`), and reading it back. */
export const GENERATOR_DRAG_PREFIX = "generator:";
export const generatorDragText = (path: string): string => `${GENERATOR_DRAG_PREFIX}${path}`;
export const generatorFromDrag = (text: string | null | undefined): string | null => (text && text.startsWith(GENERATOR_DRAG_PREFIX) ? text.slice(GENERATOR_DRAG_PREFIX.length) : null);
