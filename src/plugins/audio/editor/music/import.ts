/**
 * Music import (ADR 0166 §2.7, task Ed9): files dropped onto a segment become stems, the hints the files carry
 * (`importHints.ts`) are written into the segment once as suggestions, and the result is linted on the spot with
 * `validateSegment` (F3). Pure over its inputs: the caller reads the bytes, probes the clip facts and applies the
 * returned segment through the editor's command stack. Nothing here mutates its input or throws.
 *
 * Interpretations of §2.7 (the event file stays authoritative, so each is written once and never re-read):
 *  - Hints are applied only to a segment that still has its default grid (the default tempo map, no cues, no regions),
 *    and only from the first dropped file that has any. A segment the author already shaped is never overwritten.
 *  - Tempo: `acid` tempo and metre, else Ogg `BPM` (metre stays 4/4). A metre that the format can't hold keeps 4/4.
 *  - Cues: each `cue ` point becomes a cue at its frame, snapped to the nearest tick on the new grid; the `adtl`
 *    label is its name (made unique), else `cue N`. A cue named `entry` or `exit` keeps that meaning (segment default).
 *  - Loop: the first `smpl` loop (forward preferred), else the Ogg pair, becomes a region `loop`, forever, with
 *    `start` and `end` used where the loop touches the file's ends. It needs a tempo to place it, so it is written
 *    only when the grid came from a hint or the default one.
 */

import { BEAT_UNITS, MAX_BPM, MIN_BPM, MUSIC_LIMITS, type MusicCue, type MusicRegion, type MusicTrack, type SegmentNode } from "../../../../engine/audio/musicFormat";
import { MUSIC_TICKS_PER_BEAT, MAX_POSITION_BAR, formatPosition } from "../../../../engine/audio/musicPosition";
import { validateSegment, type MusicFactsLookup, type MusicValidateOptions, type MusicValidation } from "../../../../engine/audio/musicValidate";
import { readImportHints, type ImportHints, type SmplLoop } from "./importHints";

/** One dropped file. */
export interface ImportFile {
  /** The asset path the clip will have (no `asset:`). */
  path: string;
  /** The file bytes, for the hint readers; absent: no hints are read. */
  bytes?: Uint8Array;
  /** Hints already read (tests, a cache); wins over `bytes`. */
  hints?: ImportHints;
}

export interface ImportOptions extends MusicValidateOptions {
  /**
   * `"tracks"` (default): each file is a new stem. `{ alternativeOf }`: each file is added as an alternative of the
   * named existing stem (equal length is linted as `alternativeLengthMismatch`).
   */
  mode?: "tracks" | { alternativeOf: string };
  /** The bus for new stems; default empty (the event's). */
  bus?: string;
}

/** What the import wrote, for the editor's toast and the undo label. */
export interface ImportApplied {
  /** Names of the stems added. */
  tracks: string[];
  /** Clips added as alternatives. */
  alternatives: string[];
  /** The tempo written (`bpm`, metre, source file path), when one was. */
  tempo?: { bpm: number; beatsPerBar: number; beatUnit: number; from: string };
  /** Cue names written. */
  cues: string[];
  /** The region id written. */
  region?: string;
  /** Files skipped and why (segment full, missing alternative target, ...). */
  skipped: { path: string; reason: string }[];
}

export interface ImportResult {
  /** The new segment; `segment` itself when nothing could be added. */
  segment: SegmentNode;
  /** `validateSegment` over the new segment: the lint rows of §2.6. */
  validation: MusicValidation;
  applied: ImportApplied;
}

/** The stem name for a path: its file name without extension, made to fit `[A-Za-z0-9_ -]`-style names, unique in `taken`. */
export function stemNameFor(path: string, taken: ReadonlySet<string>): string {
  const base = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]*$/, "").trim().replace(/[^\w -]+/g, "_").slice(0, 40) || "stem";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Whether the segment still has its default grid, the only case hints are written into. */
export function hasDefaultGrid(seg: SegmentNode): boolean {
  const t = seg.tempo[0];
  return seg.tempo.length === 1 && t !== undefined && t.at === "1:1:0" && t.bpm === 120 && t.beatsPerBar === 4 && t.beatUnit === 4
    && seg.cues.length === 0 && seg.regions.length === 0 && seg.gridOffset === 0;
}

/** Frames to a `bar:beat:tick` text on a single-tempo grid, snapped to the nearest tick; null past the position range. */
function framesToPosition(frame: number, rate: number, bpm: number, beatsPerBar: number): string | null {
  const ticks = Math.round((frame / rate) * (bpm / 60) * MUSIC_TICKS_PER_BEAT);
  if (!(ticks >= 0)) return null;
  const beats = Math.floor(ticks / MUSIC_TICKS_PER_BEAT);
  const bar = Math.floor(beats / beatsPerBar) + 1;
  if (bar > MAX_POSITION_BAR) return null;
  return formatPosition({ bar, beat: (beats % beatsPerBar) + 1, tick: ticks % MUSIC_TICKS_PER_BEAT });
}

/** The loop a file hints, as frames with `end` exclusive: a forward `smpl` loop first, any `smpl` loop next, then the Ogg pair. */
function hintedLoop(h: ImportHints): { start: number; end: number } | null {
  const loops: SmplLoop[] = h.wav?.loops ?? [];
  const l = loops.find((x) => x.type === 0) ?? loops[0];
  if (l) return { start: l.start, end: l.end };
  return h.ogg?.loop ?? null;
}

/**
 * Add `files` to `segment` as stems (or alternatives), write the first file's hints into a still-default grid, and lint.
 * `facts(path)` is the decoder's probe reduced to `MusicClipFacts`; it supplies the sample rate that frame hints need
 * (`wav.rate` of the hints is the fallback) and feeds the lint.
 */
export function importClips(segment: SegmentNode, files: readonly ImportFile[], facts: MusicFactsLookup, options?: ImportOptions): ImportResult {
  const applied: ImportApplied = { tracks: [], alternatives: [], cues: [], skipped: [] };
  const tracks: MusicTrack[] = segment.tracks.map((t) => ({ ...t, alternatives: [...t.alternatives] }));
  const taken = new Set(tracks.map((t) => t.name));
  const mode = options?.mode ?? "tracks";
  const added: ImportFile[] = [];

  for (const f of files) {
    if (!f.path) { applied.skipped.push({ path: f.path, reason: "no path" }); continue; }
    if (tracks.some((t) => t.clip === f.path || t.alternatives.includes(f.path))) { applied.skipped.push({ path: f.path, reason: "already in the segment" }); continue; }
    if (mode === "tracks") {
      if (tracks.length >= MUSIC_LIMITS.tracks) { applied.skipped.push({ path: f.path, reason: `a segment holds at most ${MUSIC_LIMITS.tracks} stems` }); continue; }
      const name = stemNameFor(f.path, taken);
      taken.add(name);
      tracks.push({ name, clip: f.path, alternatives: [], pick: "sequence", volume: 1, bus: options?.bus ?? "", automation: [] });
      applied.tracks.push(name);
    } else {
      const target = tracks.find((t) => t.name === mode.alternativeOf);
      if (!target) { applied.skipped.push({ path: f.path, reason: `no stem named "${mode.alternativeOf}"` }); continue; }
      if (target.alternatives.length >= MUSIC_LIMITS.alternatives) { applied.skipped.push({ path: f.path, reason: `a stem holds at most ${MUSIC_LIMITS.alternatives} alternatives` }); continue; }
      target.alternatives.push(f.path);
      applied.alternatives.push(f.path);
    }
    added.push(f);
  }

  let next: SegmentNode = { ...segment, tracks };

  if (added.length > 0 && hasDefaultGrid(segment)) {
    for (const f of added) {
      const h = f.hints ?? (f.bytes ? readImportHints(f.bytes) : undefined);
      if (!h) continue;
      const w = h.wav;
      const bpm = w?.acid?.bpm ?? h.ogg?.bpm;
      const loop = hintedLoop(h);
      if (bpm === undefined && !w?.cues.length && !loop) continue;
      // Hints only help with a clock: the clip's rate from the facts, else the WAV's own.
      const rate = facts(f.path)?.rate ?? w?.rate;
      const t = next.tempo[0]!;
      let beatsPerBar = t.beatsPerBar, beatUnit = t.beatUnit, tempoBpm = t.bpm;
      let tempoWritten = false;
      if (bpm !== undefined && Number.isFinite(bpm)) {
        tempoBpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm * 1000) / 1000));
        const a = w?.acid;
        if (a && Number.isInteger(a.meterNumerator) && a.meterNumerator >= 1 && a.meterNumerator <= MUSIC_LIMITS.beatsPerBar
          && (BEAT_UNITS as readonly number[]).includes(a.meterDenominator)) {
          beatsPerBar = a.meterNumerator;
          beatUnit = a.meterDenominator;
        }
        tempoWritten = true;
      }
      const cues: MusicCue[] = [];
      let region: MusicRegion | undefined;
      if (rate !== undefined && rate > 0) {
        const names = new Set<string>();
        let n = 0;
        for (const c of [...(w?.cues ?? [])].sort((a, b) => a.frame - b.frame)) {
          if (cues.length >= MUSIC_LIMITS.cues) break;
          const at = framesToPosition(c.frame, rate, tempoBpm, beatsPerBar);
          if (at === null) continue;
          n++;
          let name = c.label.trim() || `cue ${n}`;
          for (let i = 2; names.has(name); i++) name = `${c.label.trim() || `cue ${n}`} ${i}`;
          names.add(name);
          cues.push({ name, at });
        }
        if (loop) {
          const frames = facts(f.path)?.frames ?? w?.frames;
          const from = loop.start <= 0 ? "start" : framesToPosition(loop.start, rate, tempoBpm, beatsPerBar);
          const to = frames !== undefined && loop.end >= frames ? "end" : framesToPosition(loop.end, rate, tempoBpm, beatsPerBar);
          if (from !== null && to !== null && from !== to) region = { id: "loop", from, to, count: 0 };
        }
      }
      if (!tempoWritten && cues.length === 0 && !region) continue;
      next = {
        ...next,
        tempo: [{ at: "1:1:0", bpm: tempoBpm, beatsPerBar, beatUnit }],
        cues,
        regions: region ? [region] : [],
      };
      if (tempoWritten) applied.tempo = { bpm: tempoBpm, beatsPerBar, beatUnit, from: f.path };
      applied.cues = cues.map((c) => c.name);
      if (region) applied.region = region.id;
      break;
    }
  }

  const validation = validateSegment(next, facts, options);
  return { segment: next, validation, applied };
}

/**
 * The drop handler's entry: files dropped from the OS or the asset browser. `read` returns a file's bytes (the
 * editor's project filesystem); a failed read just means no hints for that file.
 */
export async function importDropped(
  segment: SegmentNode,
  paths: readonly string[],
  read: (path: string) => Promise<Uint8Array | undefined>,
  facts: MusicFactsLookup,
  options?: ImportOptions,
): Promise<ImportResult> {
  const files: ImportFile[] = [];
  for (const path of paths) {
    let bytes: Uint8Array | undefined;
    try { bytes = await read(path); } catch { bytes = undefined; }
    files.push({ path, bytes });
  }
  return importClips(segment, files, facts, options);
}
