/**
 * Where a sample's source seconds land in what it plays (ADR 0328). Every time in a sample block is seconds in the source
 * file; what plays is the trim, less the closed gaps (`[sourceStart, length]`, removed, what follows moves up), with the
 * deleted snippets silent in place (a snippet runs from its start, a razor cut or 0, to the next cut or the file's end).
 *
 * - `sampleEditPlan` is that edit as pieces of the source played back to back, and the silent spans; the offline render
 *   (`sampleRender.ts`) cuts the PCM by it.
 * - A **render** (a flattened file, `sample.source`) starts at the trim's start: `renderTimeMap` places a source second
 *   in the render (`renderTime`) and back (`sourceTimeAt`), so loops, markers and auditions given in source seconds find
 *   their place in it. A chain with a reverse (an odd number of enabled `reverse` effects) mirrors the map about the
 *   render's end, exact when no effect after the reverse adds a tail (reverse last, or a reverb before it: the usual
 *   "reverse reverb").
 *
 * Pure; no plugin, no DOM.
 */
import type { SampleEdits } from "./types";

/** A piece of the source that plays: `[srcStart, srcEnd)` seconds, heard from `outStart` seconds. */
export interface SamplePiece {
  readonly srcStart: number;
  readonly srcEnd: number;
  readonly outStart: number;
}

export interface SampleEditPlan {
  /** In play order (source order); empty when nothing plays. */
  readonly pieces: readonly SamplePiece[];
  /** Source spans played as silence (deleted snippets), sorted, inside the pieces. */
  readonly silent: readonly (readonly [number, number])[];
  /** Seconds that play. */
  readonly length: number;
}

type Edit = Pick<SampleEdits, "trim" | "cuts" | "deleted" | "closedGaps">;

/** Closed gaps as sorted, merged `[start, end]` spans. */
function gapSpans(gaps: Edit["closedGaps"]): [number, number][] {
  const spans = gaps.map(([s, l]) => [s, s + l] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const g of spans) {
    const last = out[out.length - 1];
    if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]);
    else out.push([g[0], g[1]]);
  }
  return out;
}

/** What plays of a source `sourceSeconds` long under `edits`. */
export function sampleEditPlan(edits: Edit, sourceSeconds: number): SampleEditPlan {
  const len = Math.max(0, sourceSeconds);
  const a = Math.min(len, Math.max(0, edits.trim ? edits.trim[0] : 0));
  const b = Math.min(len, Math.max(a, edits.trim ? edits.trim[1] : len));
  const pieces: SamplePiece[] = [];
  let at = a, out = 0;
  const keep = (s: number, e: number) => {
    if (e - s <= 0) return;
    pieces.push({ srcStart: s, srcEnd: e, outStart: out });
    out += e - s;
  };
  for (const [gs, ge] of gapSpans(edits.closedGaps)) {
    if (ge <= at) continue;
    if (gs >= b) break;
    keep(at, Math.min(gs, b));
    at = Math.max(at, ge);
  }
  keep(at, b);
  const edges = [...edits.cuts.filter((c) => c > 0 && c < len), len].sort((x, y) => x - y);
  const silent: [number, number][] = [];
  for (const d of [...edits.deleted].sort((x, y) => x - y)) {
    const end = edges.find((e) => e > d + 1e-9) ?? len;
    for (const p of pieces) {
      const s = Math.max(d, p.srcStart), e = Math.min(end, p.srcEnd);
      if (e > s) silent.push([s, e]);
    }
  }
  return { pieces, silent, length: out };
}

export interface RenderTimeMap {
  readonly pieces: readonly SamplePiece[];
  /** The chain reverses the sample. */
  readonly reversed: boolean;
  /** The render's length, seconds (the edited length plus any tail). */
  readonly renderSeconds: number;
}

/** True when `edits`' chain plays the sample backwards (an odd number of enabled reverses). */
export const chainReverses = (edits: Pick<SampleEdits, "effects">): boolean => edits.effects.filter((f) => f.on && f.type === "reverse").length % 2 === 1;

/** The map from source seconds to a render of `edits` that is `renderSeconds` long. */
export function renderTimeMap(edits: Edit & Pick<SampleEdits, "effects">, sourceSeconds: number, renderSeconds: number): RenderTimeMap {
  return { pieces: sampleEditPlan(edits, sourceSeconds).pieces, reversed: chainReverses(edits), renderSeconds };
}

/** Where source second `t` is heard in the render; null when it isn't (outside the trim, in a closed gap). */
export function renderTime(map: RenderTimeMap, t: number): number | null {
  const p = map.pieces.find((q) => t >= q.srcStart && t <= q.srcEnd);
  if (!p) return null;
  const u = p.outStart + (t - p.srcStart);
  return map.reversed ? map.renderSeconds - u : u;
}

/** The source second heard at render second `u` (a tail continues the last piece; a reversed render mirrors). */
export function sourceTimeAt(map: RenderTimeMap, u: number): number {
  const v = map.reversed ? map.renderSeconds - u : u;
  const ps = map.pieces;
  if (ps.length === 0) return v;
  let p = ps[0];
  for (const q of ps) if (q.outStart <= v) p = q;
  return p.srcStart + (v - p.outStart);
}
