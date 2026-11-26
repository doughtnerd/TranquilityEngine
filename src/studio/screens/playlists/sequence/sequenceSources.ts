// What the Sequence view reads from the project about a clip's source: a sample's length (its peaks, after its trim),
// loops, markers, kind and tempo from its sidecar (an audio file's `.meta.json` sample block, or a derived
// `*.sample.json`, ADR 0342), the peaks to draw, and a linked playlist (none has a natural length the Studio can know
// before it plays, so playlist clips use their own length). Peaks come from the Samples screen's shared reader, so
// a file is decoded once for both screens. Tracks the project's signals.
import { audioProject } from "../../../shell/audioProject";
import { docVersion } from "../../../../editor/state";
import type { EditorProject } from "../../../../editor/projects";
import { parseImportSettings, sidecarPath } from "../../../../engine/scene/importSettings";
import { parseDerivedSample } from "../../../../engine/audio/sample/format";
import type { SampleEdits } from "../../../../engine/audio/sample/types";
import type { PeakMips } from "../../../../plugins/audio/editor/music/peaksMip";
import { lengthOf, pcmNow, peaksOf } from "../../samples/sampleSession";
import type { Pcm } from "../../samples/seam";
import type { SourceFacts, SourceOf } from "./sequenceModel";

/** The audio file a sample path plays, where its playable part starts in that file, and its sample block. */
function resolveSample(p: EditorProject, path: string): { file: string; base: number; edits: SampleEdits | null } {
  try {
    if (path.toLowerCase().endsWith(".sample.json")) {
      const raw = p.assets.get(path);
      if (raw === undefined) return { file: path, base: 0, edits: null };
      const d = parseDerivedSample(raw).sample;
      return { file: d.source, base: d.range?.[0] ?? 0, edits: d.sample };
    }
    const side = p.assets.get(sidecarPath(path));
    return { file: path, base: 0, edits: side === undefined ? null : parseImportSettings(side).settings.sample };
  } catch {
    return { file: path, base: 0, edits: null };
  }
}

/** A sample's facts for the timeline (length null until its peaks are read). */
function sampleFacts(p: EditorProject, path: string): SourceFacts {
  const { file, base, edits } = resolveSample(p, path);
  const fileLength = lengthOf(p, file);
  const trim = edits?.trim ?? null;
  const start = base + (trim ? trim[0] : 0);
  const end = trim ? base + trim[1] : fileLength;
  return {
    length: end !== null && end !== undefined ? Math.max(0, end - start) : null,
    start,
    loops: (edits?.loops ?? []).map((l) => ({ id: l.id, start: base + l.start, end: base + l.end, active: l.active, binding: l.binding, exit: l.exit, exitFadeMs: l.exitFadeMs, reentry: l.reentry })),
    // A sample's Entry marker is its pre-entry for a Switch change (ADR 0350); a clip in a sequence doesn't use it.
    markers: (edits?.markers ?? []).flatMap((m) => (m.type === "entry" ? [] : [{ id: m.id, name: m.name, at: base + m.at, type: m.type }])),
    kind: edits?.kind,
    bpm: edits?.tempo?.bpm ?? null,
  };
}

/** The project's `SourceOf` (tracks the project). */
export function projectSources(): SourceOf {
  const p = audioProject.value;
  void docVersion.value;
  const cache = new Map<string, SourceFacts | null>();
  return (c) => {
    if (!p || c.sample === undefined) return null;
    if (!cache.has(c.sample)) cache.set(c.sample, sampleFacts(p, c.sample));
    return cache.get(c.sample)!;
  };
}

/** A sample's decoded audio (its audio file's), for the spectrogram; null while it decodes (decoding starts on the first ask). */
export function projectPcm(path: string): Pcm | null {
  const p = audioProject.value;
  if (!p) return null;
  return pcmNow(p, resolveSample(p, path).file);
}

/** The peaks to draw for a sample (its audio file's), null while they load. */
export function projectPeaks(path: string): PeakMips | null {
  const p = audioProject.value;
  if (!p) return null;
  return peaksOf(p, resolveSample(p, path).file);
}
