/**
 * A WAV file's metadata (`wavChunks.ts`) as sample edits and back (ADR 0342): what the Studio's import copies into the
 * sidecar, what "Write to file…" writes into the WAV, and the `file` snapshots refreshed after a write.
 *
 * - Cue points import as **note** markers, regions (`ltxt`) as note ranges, `smpl` loops as loops, `acid` as the tempo,
 *   the `smpl` unity note (else `acid`'s root) as the root. Every imported item carries a `file` snapshot.
 * - Writing writes notes (points as cues, ranges as regions), loops, root and tempo. Exit, Hit point and Cue markers
 *   (and Entry) stay in the sidecar only (the WAV can't carry their types).
 *
 * Pure; no plugin, no DOM.
 */
import { DEFAULT_CROSSFADE_MS, SAMPLE_LIMITS } from "./format";
import { DEFAULT_METER, isMeter, meterParts } from "../meter";
import { midiToNoteName, noteNameToMidi } from "./noteNames";
import type { LoopDirection, SampleEdits, SampleLoop, SampleMarker } from "./types";
import type { WavCue, WavLoop, WavMetadata, WavMetadataEdit, WavRegion } from "./wavChunks";

const DIRECTIONS: readonly LoopDirection[] = ["forward", "pingPong", "backward"];
const directionOf = (type: number): LoopDirection => DIRECTIONS[type] ?? "forward";
const typeOf = (d: LoopDirection): number => DIRECTIONS.indexOf(d);
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The parts of a sample block a WAV file can give. */
export type WavSampleParts = Pick<SampleEdits, "loops" | "markers" | "tempo" | "root">;

/**
 * Sample edits from a WAV file's metadata, times in seconds. Loops are sorted and a loop overlapping the one before it
 * is skipped (the sample block's rule). Empty when the file has no sample rate.
 */
export function sampleEditsFromWav(meta: WavMetadata): WavSampleParts {
  const out: WavSampleParts = { loops: [], markers: [], tempo: null, root: null };
  const rate = meta.sampleRate;
  if (!rate) return out;
  const t = (frame: number) => round6(frame / rate);

  const loops = meta.loops.map((l, index) => ({ l, index })).sort((a, b) => a.l.start - b.l.start);
  for (const { l, index } of loops) {
    if (out.loops.length >= SAMPLE_LIMITS.loops) break;
    const prev = out.loops[out.loops.length - 1];
    if (prev && t(l.start) < prev.end) continue;
    const count = Math.min(SAMPLE_LIMITS.loopCount, l.playCount);
    const direction = directionOf(l.type);
    out.loops.push({
      id: `l${out.loops.length + 1}`, start: t(l.start), end: t(l.end), direction, crossfadeMs: DEFAULT_CROSSFADE_MS, count,
      active: count > 0 ? "always" : "held", exit: "finish", exitFadeMs: 40, reentry: "ignore",
      file: { chunk: "smpl", index, start: t(l.start), end: t(l.end), direction, count },
    });
  }

  const markers: SampleMarker[] = [];
  for (const c of meta.cues) {
    const m: SampleMarker = { id: "", type: "note", name: c.label || `Cue ${c.id}`, at: t(c.frame), file: { chunk: "cue", id: c.id, at: t(c.frame), name: c.label } };
    if (c.note) m.note = c.note;
    markers.push(m);
  }
  for (const r of meta.regions) {
    const m: SampleMarker = {
      id: "", type: "note", name: r.label || r.text || `Region ${r.id}`, at: t(r.frame), end: t(r.frame + r.length),
      file: { chunk: "ltxt", id: r.id, at: t(r.frame), end: t(r.frame + r.length), name: r.label },
    };
    if (r.note) m.note = r.note;
    markers.push(m);
  }
  markers.sort((a, b) => a.at - b.at);
  out.markers = markers.slice(0, SAMPLE_LIMITS.markers).map((m, i) => ({ ...m, id: `m${i + 1}` }));

  if (meta.tempo) {
    const fileMeter = `${meta.tempo.meterNumerator}/${meta.tempo.meterDenominator}`;
    const bpm = Math.min(SAMPLE_LIMITS.maxBpm, Math.max(SAMPLE_LIMITS.minBpm, meta.tempo.bpm));
    out.tempo = { bpm: round6(bpm), meter: isMeter(fileMeter) ? fileMeter : DEFAULT_METER, map: [], source: "file" };
  }
  const midi = meta.root ? meta.root.midiNote : meta.tempo?.rootNote ?? null;
  const name = midi === null ? null : midiToNoteName(midi);
  if (name) out.root = { note: name, cents: meta.root ? Math.max(-SAMPLE_LIMITS.cents, Math.min(SAMPLE_LIMITS.cents, meta.root.cents)) : 0, source: "file" };
  return out;
}

const isRange = (m: SampleMarker): boolean => m.type === "note" && m.end !== undefined;
const isPoint = (m: SampleMarker): boolean => m.type === "note" && m.end === undefined;

/**
 * What "Write to file…" writes for `edits` (a `writeWavMetadata` edit): notes as cue points and regions (keeping their
 * file ids where they came from the file), loops, the root and the tempo. With `frames`, the tempo's beat count is the
 * file's length in beats.
 */
export function wavEditFromSample(edits: SampleEdits, sampleRate: number, frames?: number): WavMetadataEdit {
  const f = (s: number) => Math.max(0, Math.round(s * sampleRate));
  const cues: WavCue[] = edits.markers.filter(isPoint).map((m) => ({ id: m.file?.chunk === "cue" ? m.file.id : 0, frame: f(m.at), label: m.name, note: m.note ?? "" }));
  const regions: WavRegion[] = edits.markers.filter(isRange).map((m) => ({
    id: m.file?.chunk === "ltxt" ? m.file.id : 0, frame: f(m.at), length: Math.max(1, f(m.end!) - f(m.at)), label: m.name, note: m.note ?? "", purpose: "rgn ", text: "",
  }));
  const loops: WavLoop[] = edits.loops.map((l) => ({ cueId: 0, type: typeOf(l.direction), start: f(l.start), end: Math.max(f(l.start) + 1, f(l.end)), fraction: 0, playCount: l.count }));
  const midi = edits.root ? noteNameToMidi(edits.root.note) : null;
  const out: WavMetadataEdit = { cues, regions, loops, root: midi === null ? null : { midiNote: midi, cents: edits.root!.cents } };
  if (edits.tempo) {
    const { beatsPerBar: n, beatUnit: d } = meterParts(edits.tempo.meter);
    const beats = frames !== undefined ? Math.round((frames / sampleRate) * (edits.tempo.bpm / 60)) : 0;
    out.tempo = { bpm: edits.tempo.bpm, beats, meterNumerator: n, meterDenominator: d, oneShot: edits.kind === "oneshot", rootNote: null };
  } else out.tempo = null;
  return out;
}

/**
 * `edits` with the `file` snapshots of what a write put in the file (`written` is the file read back after the write):
 * loops match the written loops in order, point notes the cues, range notes the regions. Other markers keep theirs.
 */
export function refreshFileSnapshots(edits: SampleEdits, written: WavMetadata): SampleEdits {
  const rate = written.sampleRate;
  if (!rate) return edits;
  const t = (frame: number) => round6(frame / rate);
  const loops = edits.loops.map((l, i): SampleLoop => {
    const w = written.loops[i];
    return w ? { ...l, file: { chunk: "smpl", index: i, start: t(w.start), end: t(w.end), direction: directionOf(w.type), count: w.playCount } } : l;
  });
  let cue = 0, region = 0;
  const markers = edits.markers.map((m): SampleMarker => {
    if (isPoint(m)) {
      const w = written.cues[cue++];
      return w ? { ...m, file: { chunk: "cue", id: w.id, at: t(w.frame), name: w.label } } : m;
    }
    if (isRange(m)) {
      const w = written.regions[region++];
      return w ? { ...m, file: { chunk: "ltxt", id: w.id, at: t(w.frame), end: t(w.frame + w.length), name: w.label } } : m;
    }
    return m;
  });
  return { ...edits, loops, markers };
}
