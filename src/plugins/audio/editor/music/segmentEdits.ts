// Ed4 (api-and-models §7, contract H6): the segment panel's edits as pure functions of a segment. Each returns the next
// segment or a one-line reason it was refused (the refused-or-next `EditResult`, ADR 0307), so the forms are tested
// without a DOM and round-trip through `formatAudioEvent` / `parseAudioEvent`. `SegmentPanel.tsx` applies a result
// through the event's asset document (one undo step per edit, a refusal in the status bar).
import { BEAT_UNITS, MAX_BPM, MIN_BPM, MUSIC_LIMITS, TRACK_PICKS, type MusicRegion, type MusicTrack, type RegionCondition, type SegmentNode, type TrackPick } from "../../../../engine/audio/musicFormat";
import { uniqueName } from "../../../../engine/core/uniqueName";
import { compileSegmentGrid, positionTextToTicks } from "../../../../engine/audio/musicGrid";
import { accept, refuse, type EditResult } from "../editResult";
import { canonicalPosition, comparePositions, isBarBeatTick, parsePosition, positionProblem } from "../../../../engine/audio/musicPosition";

/** The next segment, or why the edit was refused (nothing changes). */
type Edit = EditResult<SegmentNode>;

const ok = (segment: SegmentNode): Edit => accept(segment);
const fail = refuse;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The first marker's tempo and metre (the form edits that one; later markers are the view's). */
export function setTempo(seg: SegmentNode, patch: { bpm?: number; beatsPerBar?: number; beatUnit?: number }): Edit {
  const first = seg.tempo[0];
  if (!first) return fail("the segment has no tempo marker");
  const next = { ...first };
  if (patch.bpm !== undefined) {
    if (!Number.isFinite(patch.bpm) || patch.bpm < MIN_BPM || patch.bpm > MAX_BPM) return fail(`tempo must be ${MIN_BPM}..${MAX_BPM} bpm`);
    next.bpm = round3(patch.bpm);
  }
  if (patch.beatsPerBar !== undefined) {
    if (!Number.isInteger(patch.beatsPerBar) || patch.beatsPerBar < 1 || patch.beatsPerBar > MUSIC_LIMITS.beatsPerBar) return fail(`beats per bar must be a whole number 1..${MUSIC_LIMITS.beatsPerBar}`);
    next.beatsPerBar = patch.beatsPerBar;
  }
  if (patch.beatUnit !== undefined) {
    if (!(BEAT_UNITS as readonly number[]).includes(patch.beatUnit)) return fail(`beat unit must be one of ${BEAT_UNITS.join(", ")}`);
    next.beatUnit = patch.beatUnit;
  }
  return ok({ ...seg, tempo: [next, ...seg.tempo.slice(1)] });
}

/** Where bar 1 beat 1 sits in the files, seconds >= 0. */
export function setGridOffset(seg: SegmentNode, seconds: number): Edit {
  if (!Number.isFinite(seconds) || seconds < 0) return fail("grid offset must be 0 or more seconds");
  return ok({ ...seg, gridOffset: round3(seconds) });
}

const trackAt = (seg: SegmentNode, name: string): number => seg.tracks.findIndex((t) => t.name === name);
const withTrack = (seg: SegmentNode, name: string, f: (t: MusicTrack) => MusicTrack): Edit => {
  const i = trackAt(seg, name);
  if (i < 0) return fail(`no stem named "${name}"`);
  return ok({ ...seg, tracks: seg.tracks.map((t, j) => (j === i ? f(t) : t)) });
};

export function renameTrack(seg: SegmentNode, name: string, to: string): Edit {
  const next = to.trim();
  if (next === "") return fail("a stem needs a name");
  if (next !== name && trackAt(seg, next) >= 0) return fail(`another stem is already named "${next}"`);
  return withTrack(seg, name, (t) => ({ ...t, name: next }));
}

/** Linear gain 0..4. */
export function setTrackVolume(seg: SegmentNode, name: string, volume: number): Edit {
  if (!Number.isFinite(volume) || volume < 0 || volume > 4) return fail("gain must be 0..4");
  return withTrack(seg, name, (t) => ({ ...t, volume: round3(volume) }));
}

export function setTrackPick(seg: SegmentNode, name: string, pick: TrackPick): Edit {
  if (!(TRACK_PICKS as readonly string[]).includes(pick)) return fail(`pick must be one of ${TRACK_PICKS.join(", ")}`);
  return withTrack(seg, name, (t) => ({ ...t, pick }));
}

export function setTrackBus(seg: SegmentNode, name: string, bus: string): Edit {
  return withTrack(seg, name, (t) => ({ ...t, bus: bus.trim() }));
}

export function removeTrack(seg: SegmentNode, name: string): Edit {
  if (trackAt(seg, name) < 0) return fail(`no stem named "${name}"`);
  return ok({ ...seg, tracks: seg.tracks.filter((t) => t.name !== name) });
}

/** Move a stem up (-1) or down (+1) in the list. */
export function moveTrack(seg: SegmentNode, name: string, by: number): Edit {
  const i = trackAt(seg, name), j = i + by;
  if (i < 0) return fail(`no stem named "${name}"`);
  if (j < 0 || j >= seg.tracks.length) return ok(seg);
  const tracks = [...seg.tracks];
  [tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
  return ok({ ...seg, tracks });
}

export function removeAlternative(seg: SegmentNode, name: string, clip: string): Edit {
  return withTrack(seg, name, (t) => ({ ...t, alternatives: t.alternatives.filter((a) => a !== clip) }));
}

/** Swap an alternative with the stem's main clip. */
export function promoteAlternative(seg: SegmentNode, name: string, clip: string): Edit {
  const t = seg.tracks[trackAt(seg, name)];
  if (!t) return fail(`no stem named "${name}"`);
  if (!t.alternatives.includes(clip)) return fail(`"${clip}" is not an alternative of "${name}"`);
  return withTrack(seg, name, (s) => ({ ...s, clip, alternatives: s.alternatives.map((a) => (a === clip ? s.clip : a)) }));
}

/** Canonical stored text of a position the user typed, checked against the segment's metre; null `why` means fine. */
function readPosition(seg: SegmentNode, text: string, words: { start?: boolean; end?: boolean }): { text: string } | { why: string } {
  const raw = text.trim();
  const problem = positionProblem(raw, words);
  if (problem) return { why: problem };
  const canon = canonicalPosition(raw, words)!;
  if (canon !== "start" && canon !== "end") {
    const grid = compileSegmentGrid(seg, {});
    if (positionTextToTicks(grid, canon) === null) return { why: `${canon} is past the end of its bar in this metre` };
  }
  return { text: canon };
}

// cues

export function addCue(seg: SegmentNode, at = "1:1:0", name?: string): Edit {
  if (seg.cues.length >= MUSIC_LIMITS.cues) return fail(`a segment holds at most ${MUSIC_LIMITS.cues} cues`);
  const pos = readPosition(seg, at, { start: true, end: true });
  if ("why" in pos) return fail(pos.why);
  const cueName = (name ?? "").trim() || uniqueName("cue", seg.cues.map((c) => c.name));
  if (seg.cues.some((c) => c.name === cueName)) return fail(`another cue is already named "${cueName}"`);
  return ok({ ...seg, cues: [...seg.cues, { name: cueName, at: pos.text }] });
}

/** Renaming follows the entry and exit references. */
export function renameCue(seg: SegmentNode, name: string, to: string): Edit {
  const next = to.trim();
  if (!seg.cues.some((c) => c.name === name)) return fail(`no cue named "${name}"`);
  if (next === "") return fail("a cue needs a name");
  if (next !== name && seg.cues.some((c) => c.name === next)) return fail(`another cue is already named "${next}"`);
  const out: SegmentNode = { ...seg, cues: seg.cues.map((c) => (c.name === name ? { ...c, name: next } : c)) };
  if (seg.entry === name) out.entry = next;
  if (seg.exit === name) out.exit = next;
  return ok(out);
}

export function setCueAt(seg: SegmentNode, name: string, at: string): Edit {
  if (!seg.cues.some((c) => c.name === name)) return fail(`no cue named "${name}"`);
  const pos = readPosition(seg, at, { start: true, end: true });
  if ("why" in pos) return fail(pos.why);
  return ok({ ...seg, cues: seg.cues.map((c) => (c.name === name ? { ...c, at: pos.text } : c)) });
}

/** Removing a cue clears the entry or exit that named it. */
export function removeCue(seg: SegmentNode, name: string): Edit {
  if (!seg.cues.some((c) => c.name === name)) return fail(`no cue named "${name}"`);
  const { entry, exit, ...rest } = seg;
  const out: SegmentNode = { ...rest, cues: seg.cues.filter((c) => c.name !== name) };
  if (entry !== undefined && entry !== name) out.entry = entry;
  if (exit !== undefined && exit !== name) out.exit = exit;
  return ok(out);
}

/** `cue` undefined: back to the default (a cue named `entry` / `exit` if any, else the grid start / the end). */
export function setEntry(seg: SegmentNode, cue: string | undefined): Edit { return setEnd(seg, "entry", cue); }
export function setExit(seg: SegmentNode, cue: string | undefined): Edit { return setEnd(seg, "exit", cue); }
function setEnd(seg: SegmentNode, key: "entry" | "exit", cue: string | undefined): Edit {
  if (cue !== undefined && !seg.cues.some((c) => c.name === cue)) return fail(`no cue named "${cue}"`);
  const { [key]: _old, ...rest } = seg;
  return ok(cue === undefined ? (rest as SegmentNode) : { ...(rest as SegmentNode), [key]: cue });
}

// regions

export function addRegion(seg: SegmentNode, region?: Partial<MusicRegion>): Edit {
  if (seg.regions.length >= MUSIC_LIMITS.regions) return fail(`a segment holds at most ${MUSIC_LIMITS.regions} regions`);
  const id = (region?.id ?? "").trim() || uniqueName("loop", seg.regions.map((r) => r.id));
  if (seg.regions.some((r) => r.id === id)) return fail(`another region is already named "${id}"`);
  const base: MusicRegion = { id, from: "start", to: "end", count: 0 };
  return checkRegion(seg, { ...base, ...region, id }, null);
}

/** A field change of one region; `tailBeats: null` and `while: null` clear them. */
export interface RegionPatch {
  id?: string;
  from?: string;
  to?: string;
  count?: number;
  tailBeats?: number | null;
  while?: RegionCondition | null;
}

export function updateRegion(seg: SegmentNode, id: string, patch: RegionPatch): Edit {
  const cur = seg.regions.find((r) => r.id === id);
  if (!cur) return fail(`no region named "${id}"`);
  const { tailBeats: _t, while: _w, ...core } = cur;
  const next: MusicRegion = { ...core, ...(cur.tailBeats !== undefined ? { tailBeats: cur.tailBeats } : {}), ...(cur.while ? { while: cur.while } : {}) };
  if (patch.id !== undefined) next.id = patch.id.trim();
  if (patch.from !== undefined) next.from = patch.from;
  if (patch.to !== undefined) next.to = patch.to;
  if (patch.count !== undefined) next.count = patch.count;
  if (patch.tailBeats === null) delete next.tailBeats;
  else if (patch.tailBeats !== undefined) next.tailBeats = patch.tailBeats;
  if (patch.while === null) delete next.while;
  else if (patch.while !== undefined) next.while = patch.while;
  return checkRegion(seg, next, id);
}

function checkRegion(seg: SegmentNode, r: MusicRegion, replacing: string | null): Edit {
  if (r.id === "") return fail("a region needs a name");
  if (r.id !== replacing && seg.regions.some((o) => o.id === r.id)) return fail(`another region is already named "${r.id}"`);
  const from = readPosition(seg, r.from, { start: true });
  if ("why" in from) return fail(`from: ${from.why}`);
  const to = readPosition(seg, r.to, { end: true });
  if ("why" in to) return fail(`to: ${to.why}`);
  const a = parsePosition(from.text, { start: true })!, b = parsePosition(to.text, { end: true })!;
  if (isBarBeatTick(a) && isBarBeatTick(b) && comparePositions(a, b) >= 0) return fail(`from ${from.text} is not before to ${to.text}`);
  if (!Number.isInteger(r.count) || r.count < 0 || r.count > MUSIC_LIMITS.regionCount) return fail(`passes must be 0 (forever) or 1..${MUSIC_LIMITS.regionCount}`);
  if (r.tailBeats !== undefined && (!Number.isFinite(r.tailBeats) || r.tailBeats < 0 || r.tailBeats > MUSIC_LIMITS.tailBeats)) return fail(`tail must be 0..${MUSIC_LIMITS.tailBeats} beats`);
  const out: MusicRegion = { ...r, from: from.text, to: to.text };
  const regions = replacing === null ? [...seg.regions, out] : seg.regions.map((o) => (o.id === replacing ? out : o));
  return ok({ ...seg, regions });
}

export function removeRegion(seg: SegmentNode, id: string): Edit {
  if (!seg.regions.some((r) => r.id === id)) return fail(`no region named "${id}"`);
  return ok({ ...seg, regions: seg.regions.filter((r) => r.id !== id) });
}

export type ConditionForm = "is" | "atLeast" | "below";

/** The `while` condition a form describes: a parameter, one of three comparisons and its value text. */
export function readCondition(parameter: string, form: ConditionForm, value: string): EditResult<RegionCondition> {
  const p = parameter.trim();
  if (p === "") return refuse("name the parameter");
  if (form === "is") return value.trim() === "" ? refuse("name the label") : accept({ parameter: p, is: value.trim() });
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) return refuse("the value must be a number");
  return accept(form === "atLeast" ? { parameter: p, atLeast: n } : { parameter: p, below: n });
}
