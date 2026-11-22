/**
 * A sample's edits carried onto a new version of its audio file (ADR 0328 "Source versions": re-import keeps the edits).
 * Every time in a sample block is seconds in the source file, so a new file of another length needs a rule:
 *
 * - **Keep seconds** (`"seconds"`, the default): every time stays where it was. Right for a re-render with a longer or
 *   shorter tail, a fixed click, a new mix of the same take.
 * - **Scale** (`"scale"`): every time keeps its relative position (`t × new / old`): markers, ranges, loops, the trim,
 *   cuts, deleted snippets, closed gaps, the tempo map and the automation keys; the file snapshots scale with them, so
 *   an item the project never moved still reads as matching the file. The tempo scales the other way (a file stretched
 *   to twice the length plays at half the tempo). Right for a time-stretched version.
 *
 * What the new file's own chunks say about loops and markers is the merge review's (`sampleFile.ts` `mergeRows`: per
 * changed item, Keep project / Use file), compared against the `file` snapshots. A tempo or root that came from the
 * old file (`source: "file"`) takes the new file's value when it has one.
 *
 * Nothing is dropped: items past the new end are listed in `outside` (the Samples screen warns and offers "Fit to the
 * source").
 *
 * Pure; no plugin, no DOM.
 */
import type { CurveKey } from "../../core/curve";
import type { SampleEdits, SampleMarker, SampleLoop } from "./types";
import type { WavSampleParts } from "./wavSample";

export type RemapMode = "seconds" | "scale";

export interface RemapResult {
  readonly edits: SampleEdits;
  /** Ids of markers and loops that end past the new file's end, and whether the trim does. */
  readonly outside: { readonly markers: readonly string[]; readonly loops: readonly string[]; readonly trim: boolean };
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * `e` carried from a source `oldLength` seconds long onto one `newLength` long, by `mode`; `newFile` is what the new
 * file's chunks give (for a tempo and root from the file), when it is a WAV.
 */
export function remapToNewSource(e: SampleEdits, oldLength: number, newLength: number, mode: RemapMode, newFile: Pick<WavSampleParts, "tempo" | "root"> | null = null): RemapResult {
  const k = mode === "scale" && oldLength > 0 && newLength > 0 ? newLength / oldLength : 1;
  const t = (v: number) => (k === 1 ? v : r6(v * k));
  const markers: SampleMarker[] = e.markers.map((m) => {
    const next: SampleMarker = { ...m, at: t(m.at), file: m.file ? { ...m.file, at: t(m.file.at), ...(m.file.end !== undefined ? { end: t(m.file.end) } : {}) } : null };
    if (m.end !== undefined) next.end = t(m.end);
    return next;
  });
  const loops: SampleLoop[] = e.loops.map((l) => ({ ...l, start: t(l.start), end: t(l.end), file: l.file ? { ...l.file, start: t(l.file.start), end: t(l.file.end) } : null }));
  let tempo = e.tempo ? { ...e.tempo, map: e.tempo.map.map((m) => ({ ...m })) } : null;
  if (tempo && k !== 1) tempo = { ...tempo, bpm: Math.round((tempo.bpm / k) * 100) / 100, map: tempo.map.map((m) => ({ ...m, at: t(m.at), bpm: Math.round((m.bpm / k) * 100) / 100 })) };
  if (tempo?.source === "file" && newFile?.tempo) tempo = { ...newFile.tempo, map: newFile.tempo.map.map((m) => ({ ...m })) };
  const root = e.root?.source === "file" && newFile?.root ? { ...newFile.root } : e.root;
  const edits: SampleEdits = {
    ...e,
    trim: e.trim ? [t(e.trim[0]), t(e.trim[1])] : null,
    markers,
    loops,
    tempo,
    root,
    cuts: e.cuts.map(t),
    deleted: e.deleted.map(t),
    closedGaps: e.closedGaps.map(([s, len]) => [t(s), t(len)] as [number, number]),
    automation: e.automation.map((a) => ({ ...a, curve: k === 1 ? a.curve : a.curve.map((key) => scaleKey(key, k)) })),
  };
  const past = (v: number) => v > newLength + 1e-6;
  return {
    edits,
    outside: {
      markers: markers.filter((m) => past(m.end ?? m.at)).map((m) => m.id),
      loops: loops.filter((l) => past(l.end)).map((l) => l.id),
      trim: !!edits.trim && past(edits.trim[1]),
    },
  };
}

/** A curve key with its time (and a Bézier key's handle times) scaled by `k`. */
function scaleKey(key: CurveKey, k: number): CurveKey {
  const out = [...key] as unknown[];
  out[0] = r6((key[0] as number) * k);
  const h = out[3] as { in?: [number, number]; out?: [number, number] } | undefined;
  if (h && typeof h === "object") out[3] = { ...h, ...(h.in ? { in: [h.in[0] * k, h.in[1]] } : {}), ...(h.out ? { out: [h.out[0] * k, h.out[1]] } : {}) };
  return out as unknown as CurveKey;
}
