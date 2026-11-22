// The Samples import's model (ADR 0328 "Import", the prototype's review): which metadata kinds the picked WAV files
// carry (cue points and labels, regions, sampler loops, root note, tempo, timecode origin), a toggle per kind, where
// each file lands (Into folder, Keep structure), and the sidecar `sample` block each file gets from its chunks
// filtered by the toggles, with the detected tempo and root filling what a file lacks ("Detect what's missing"). Pure:
// the view reads the files, runs the detection and copies them.
import type { SampleDetection } from "../../../engine/audio/sample/detect/detect";
import { defaultSampleEdits } from "../../../engine/audio/sample/format";
import type { SampleEdits, SampleKind } from "../../../engine/audio/sample/types";
import type { WavMetadata } from "../../../engine/audio/sample/wavChunks";
import { sampleEditsFromWav } from "../../../engine/audio/sample/wavSample";
import { detectedEdit, detectionNeeded } from "./sampleDetectModel";

export type MetadataKind = "cues" | "regions" | "loops" | "root" | "tempo" | "timecode" | "detect";

export interface KindInfo {
  readonly id: MetadataKind;
  readonly title: string;
  readonly chunks: string;
  /** What it becomes in the project. */
  readonly becomes: string;
}

export const METADATA_KINDS: readonly KindInfo[] = [
  { id: "cues", title: "Cue points", chunks: "cue + LIST/adtl/labl", becomes: "Markers (note)" },
  { id: "regions", title: "Regions", chunks: "LIST/adtl/ltxt", becomes: "Range markers" },
  { id: "loops", title: "Sampler loops", chunks: "smpl", becomes: "Loops, in order" },
  { id: "root", title: "Root note", chunks: "smpl", becomes: "Root note (pitch default when used in a Sound)" },
  { id: "tempo", title: "Tempo and beats", chunks: "acid", becomes: "Tempo" },
  { id: "timecode", title: "Timecode origin", chunks: "bext (BWF)", becomes: "Shown in the Inspector" },
  { id: "detect", title: "Detect what's missing", chunks: "analysis", becomes: "Detected tempo and root where the file has none" },
];

/** One picked file and what reading it gave (null metadata: not a WAV, or unreadable: copied with no sample block). */
export interface PickedFile {
  /** Its path relative to what was picked (`Footsteps/Dirt/step_01.wav`, or the bare name for a picked file). */
  readonly rel: string;
  readonly meta: WavMetadata | null;
}

export interface KindCount {
  readonly kind: KindInfo;
  /** Files carrying it. */
  readonly files: number;
  /** Items found over all files (cue points, loops…; 1 per file for root, tempo and timecode). */
  readonly items: number;
}

/**
 * The kinds the files carry, in the review's order. Detect is offered whenever a file lacks tempo or root (a file
 * that isn't a WAV has neither).
 */
export function kindsFound(files: readonly PickedFile[]): KindCount[] {
  const count = (pick: (m: WavMetadata) => number, orNoMeta = 0) => {
    let f = 0, n = 0;
    for (const x of files) {
      const c = x.meta ? pick(x.meta) : orNoMeta;
      if (c > 0) (f++, (n += c));
    }
    return { files: f, items: n };
  };
  const counts: Record<MetadataKind, { files: number; items: number }> = {
    cues: count((m) => m.cues.length),
    regions: count((m) => m.regions.length),
    loops: count((m) => m.loops.length),
    root: count((m) => (m.root || m.tempo?.rootNote != null ? 1 : 0)),
    tempo: count((m) => (m.tempo ? 1 : 0)),
    timecode: count((m) => (m.bext ? 1 : 0)),
    detect: count((m) => (!m.tempo || !(m.root || m.tempo.rootNote != null) ? 1 : 0), 1),
  };
  return METADATA_KINDS.map((kind) => ({ kind, ...counts[kind.id] })).filter((k) => k.files > 0);
}

export type KindToggles = Readonly<Partial<Record<MetadataKind, boolean>>>;

/** On unless turned off. */
export const kindOn = (toggles: KindToggles, k: MetadataKind): boolean => toggles[k] !== false;

/** The kind a sample starts as: a loop if a loop repeats a count, held (sustain) if one is endless, music with a tempo. */
export function guessKind(e: Pick<SampleEdits, "loops" | "tempo">): SampleKind {
  if (e.loops.length) return e.loops.every((l) => l.count > 0) ? "loop" : "sustain";
  return e.tempo ? "music" : "oneshot";
}

/** What "Detect what's missing" analyses for a file: the tempo and root its chunks don't give (after the toggles). */
export function detectionFor(meta: WavMetadata | null, toggles: KindToggles): ("tempo" | "root")[] {
  if (!kindOn(toggles, "detect")) return [];
  const parts = meta ? sampleEditsFromWav(meta) : null;
  return detectionNeeded({ tempo: kindOn(toggles, "tempo") ? (parts?.tempo ?? null) : null, root: kindOn(toggles, "root") ? (parts?.root ?? null) : null });
}

/**
 * The sidecar `sample` block a file gets: its chunks (`sampleEditsFromWav`) less the kinds turned off, then, with
 * Detect on, a confident `detected` tempo and root where the file has none (never over the file's own). Null when
 * nothing is left (the file needs no block; a sidecar may still be written for Load).
 */
export function sampleBlockFor(meta: WavMetadata | null, toggles: KindToggles, detected: SampleDetection | null = null): SampleEdits | null {
  const parts = meta ? sampleEditsFromWav(meta) : { markers: [], loops: [], tempo: null, root: null };
  const markers = parts.markers
    .filter((m) => (m.file?.chunk === "ltxt" ? kindOn(toggles, "regions") : kindOn(toggles, "cues")))
    .map((m, i) => ({ ...m, id: `m${i + 1}` }));
  const loops = kindOn(toggles, "loops") ? parts.loops : [];
  let tempo = kindOn(toggles, "tempo") ? parts.tempo : null;
  let root = kindOn(toggles, "root") ? parts.root : null;
  if (detected && kindOn(toggles, "detect")) {
    const r = detectedEdit({ ...defaultSampleEdits(), tempo, root }, detected, ["tempo", "root"], "import");
    if ("next" in r) ({ tempo, root } = r.next);
  }
  if (!markers.length && !loops.length && !tempo && !root) return null;
  const kind = guessKind({ loops, tempo });
  return { ...defaultSampleEdits(kind), markers, loops, tempo, root };
}

const join = (a: string, b: string) => (a && b ? `${a}/${b}` : a || b);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The project folder a picked file goes to: under `into`, keeping its folders when `keep` is on. */
export const destinationFolder = (into: string, rel: string, keep: boolean): string => (keep ? join(into, dirOf(rel)) : into);

/** The project path a picked file would have (before " (1)" numbering of a taken name). */
export const destinationPath = (into: string, rel: string, keep: boolean): string => join(destinationFolder(into, rel, keep), nameOf(rel));

/** Audio files the Samples screen imports (the core audio kind's endings). */
export const AUDIO_EXTENSIONS = [".wav", ".mp3", ".ogg", ".flac", ".m4a"] as const;
export const isAudioPath = (p: string): boolean => AUDIO_EXTENSIONS.some((x) => p.toLowerCase().endsWith(x));
export const isWavPath = (p: string): boolean => /\.wave?$/i.test(p);

/** "Imported 3 samples into Audio › Footsteps". */
export function importedMessage(count: number, into: string): string {
  return `Imported ${count} sample${count === 1 ? "" : "s"} into ${into ? into.split("/").join(" › ") : "the project"}`;
}
