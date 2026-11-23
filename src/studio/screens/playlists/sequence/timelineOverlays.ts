// What the Sequence timeline draws over its tracks besides the clips (proto A4, A6): the names of the sequence's loops
// and hold points ("Loop 2", "Hold 1", numbered in time order, each kind on its own), the auto-crossfade zones where two
// clips on one track overlap (the runtime crossfades them, ADR 0343; proto `.xfz`), and where an Async clip's voice is
// while the sequence plays (proto `.vcur`: it runs on its own clock, so it keeps looping while the playhead holds or
// moves on). Pure.
import type { SequenceLoop, SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import { clipPlan, loopBand } from "./clipGeometry";
import { clipLength, type SourceOf } from "./sequenceModel";

/** A sequence loop's name as the timeline and the Inspector show it: "Loop N", or "Hold N" for a hold point. */
export function loopName(s: Pick<SequenceSettings, "loops">, id: string): string {
  const l = s.loops.find((x) => x.id === id);
  if (!l) return "Loop";
  const hold = l.start === l.end;
  const same = s.loops.filter((x) => (x.start === x.end) === hold).sort((a, b) => a.start - b.start || a.end - b.end);
  return `${hold ? "Hold" : "Loop"} ${same.indexOf(l) + 1}`;
}

/** The words for a loop's Active setting (the Loops row's tooltip, the hover card, the readout). */
export function activeText(l: Pick<SequenceLoop, "active" | "binding">): string {
  if (l.active === "held") return "While held";
  if (l.active === "parameter") return l.binding ? `Parameter (${l.binding.parameter} ${l.binding.op} ${l.binding.value})` : "Parameter (unbound)";
  return "Always";
}

/** A zone where two clips on one track overlap: the earlier one fades out under the later one. */
export interface CrossfadeZone {
  readonly from: number;
  readonly to: number;
  /** The clip fading out, and the clip fading in. */
  readonly a: string;
  readonly b: string;
}

/** The overlaps of a track's enabled clips, in time order (each pair once). */
export function crossfadeZones(t: Pick<Track, "clips">, sourceOf: SourceOf): CrossfadeZone[] {
  const spans = t.clips
    .filter((c) => c.enabled)
    .map((c) => ({ id: c.id, from: c.at, to: c.at + clipLength(c, sourceOf(c)) }))
    .sort((x, y) => x.from - y.from || x.to - y.to);
  const out: CrossfadeZone[] = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!, b = spans[j]!;
      if (b.from >= a.to - 1e-9) break;
      out.push({ from: b.from, to: Math.min(a.to, b.to), a: a.id, b: b.id });
    }
  }
  return out;
}

/**
 * Where an Async clip's voice is, in clip time, `elapsed` seconds after it started (the playhead reached the clip's
 * start). It plays its plan; once it reaches the end of its loop's last pass while the loop is still active (`looping`),
 * it keeps cycling that pass instead of going on to the tail. Null once the voice has ended.
 */
export function voicePosition(c: Parameters<typeof clipPlan>[0], src: Parameters<typeof clipPlan>[1], elapsed: number, looping: boolean): number | null {
  if (elapsed < 0) return null;
  const plan = clipPlan(c, src);
  const band = loopBand(plan);
  const span = plan.loop ? plan.loop.end - plan.loop.start : 0;
  if (c.reverse && Number.isFinite(plan.length)) {
    // ADR 0362: reversed, the voice reads down from the clip's end: through the tail (drawn first), into the loop's last
    // pass (drawn mirrored, the first after the tail), which it cycles backwards while the loop is active.
    if (looping && band && span > 0) {
      const enter = plan.length - band.end;
      const pass = Math.min(span, band.end - band.start);
      if (elapsed >= enter + pass) return enter + ((elapsed - enter) % (pass || span));
    }
    if (looping && band && span <= 0 && elapsed >= plan.length - band.start) return plan.length - band.start;
    return elapsed < plan.length ? elapsed : null;
  }
  if (looping && band && span > 0 && elapsed >= band.end) {
    const lastPass = Math.max(band.start, band.end - span);
    return lastPass + ((elapsed - lastPass) % (band.end - lastPass || span));
  }
  if (looping && band && span <= 0 && elapsed >= band.start) return band.start;
  return elapsed < plan.length ? elapsed : null;
}
