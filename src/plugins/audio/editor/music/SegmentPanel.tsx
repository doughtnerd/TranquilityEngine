// Ed4 (api-and-models §7, contract H6): the segment panel beside the segment view: tempo from length and bars, tap tempo,
// the stem list (solo, mute, gain, alternatives), cue and region forms, and the import drop (Ed9's `importDropped`).
//
// Every edit is a pure function of the segment below (`Edit`: the next segment or a one-line reason it was refused), so
// the forms are tested without a DOM and round-trip through `formatAudioEvent` / `parseAudioEvent`. The component applies
// the result through the event's asset document (one undo step per edit), exactly as the view does.
//
// Interpretations: solo and mute are audition-only editor state (`stemAudition`, keyed by event and segment; §7 lists them
// as stem-list controls and the format has no field for them), never written to the asset. The audition transport reads
// `audibleStems`. Tap tempo is the median interval of the current run (`tempoTools.ts`).
import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { editor, openAssetDocument, registerAssetDropTarget } from "../../../../editor/sdk";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import {
  BEAT_UNITS, MAX_BPM, MIN_BPM, MUSIC_LIMITS, TRACK_PICKS, type MusicRegion, type MusicTrack, type RegionCondition, type SegmentNode, type TrackPick,
} from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, positionTextToTicks } from "../../../../engine/audio/musicGrid";
import { canonicalPosition, comparePositions, isBarBeatTick, parsePosition, positionProblem } from "../../../../engine/audio/musicPosition";
import { validateSegment, type MusicClipFacts, type MusicLintIssue } from "../../../../engine/audio/musicValidate";
import { importDropped } from "./import";
import { openSegment } from "./index";
import { peaksFor } from "./peaksHost";
import type { PeaksService } from "./peaks";
import { findSegment, replaceSegment } from "./segmentViewModel";
import { barCountCandidates, tapTempo, tempoFromLength } from "./tempoTools";
import "./segmentPanel.css";

// --- pure edits ---------------------------------------------------------------------------------------------------------

/** The next segment, or why the edit was refused (shown under the form; nothing changes). */
export type Edit = { readonly segment: SegmentNode } | { readonly error: string };

const ok = (segment: SegmentNode): Edit => ({ segment });
const fail = (error: string): Edit => ({ error });
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

/** A free name `base`, `base 2`, ... not in `taken`. */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
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
  const cueName = (name ?? "").trim() || freeName("cue", new Set(seg.cues.map((c) => c.name)));
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
  const id = (region?.id ?? "").trim() || freeName("loop", new Set(seg.regions.map((r) => r.id)));
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
export function readCondition(parameter: string, form: ConditionForm, value: string): { condition: RegionCondition } | { error: string } {
  const p = parameter.trim();
  if (p === "") return { error: "name the parameter" };
  if (form === "is") return value.trim() === "" ? { error: "name the label" } : { condition: { parameter: p, is: value.trim() } };
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) return { error: "the value must be a number" };
  return { condition: form === "atLeast" ? { parameter: p, atLeast: n } : { parameter: p, below: n } };
}

// --- audition state (not written to the asset) ---------------------------------------------------------------------------

export interface StemAudition { readonly solo: readonly string[]; readonly mute: readonly string[] }
const NONE: StemAudition = { solo: [], mute: [] };

/** Solo and mute per `event#segmentId`: editor state for the audition, never saved. */
export const stemAudition = signal<Readonly<Record<string, StemAudition>>>({});

export const auditionKey = (event: string, segmentId: string): string => `${event}#${segmentId}`;
export const auditionOf = (key: string): StemAudition => stemAudition.value[key] ?? NONE;

/** Flip `name` in the solo or mute list of `key`. */
export function toggleStem(key: string, kind: "solo" | "mute", name: string): void {
  const cur = auditionOf(key);
  const list = cur[kind].includes(name) ? cur[kind].filter((n) => n !== name) : [...cur[kind], name];
  stemAudition.value = { ...stemAudition.value, [key]: { ...cur, [kind]: list } };
}

/** The stems that sound: any solo narrows to the soloed ones; a muted stem never sounds. Names not in `tracks` are ignored. */
export function audibleStems(tracks: readonly MusicTrack[], state: StemAudition): string[] {
  const names = tracks.map((t) => t.name);
  const pool = state.solo.some((s) => names.includes(s)) ? names.filter((n) => state.solo.includes(n)) : names;
  return pool.filter((n) => !state.mute.includes(n));
}

// --- the component ------------------------------------------------------------------------------------------------------

const AUDIO_EXT = /\.(wav|ogg|oga|opus|mp3|flac|m4a|aac)$/i;

export function SegmentPanel() {
  const open = openSegment.value;
  const project = editor.project.current;
  editor.project.version;
  if (!project || !open) return <p class="empty">Segment: open a segment from the Event editor to edit its tempo, stems, cues and regions here.</p>;
  if (!project.files.includes(open.event)) return <p class="empty">{open.event} isn't in the project any more.</p>;
  return <OpenPanel key={auditionKey(open.event, open.segmentId)} path={open.event} segmentId={open.segmentId} />;
}

function OpenPanel({ path, segmentId }: { path: string; segmentId: string }) {
  const project = editor.project.current!;
  const doc = openAssetDocument<AudioEventAsset>(project, path, "audioEvent");
  const event = doc.value.value;
  const segment = useMemo(() => findSegment(event.musicRoot, segmentId), [event.musicRoot, segmentId]);
  const peaks = peaksFor(project);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const key = auditionKey(path, segmentId);
  const audition = auditionOf(key);

  // Probe every clip once so lengths and the lint have facts.
  const clips = useMemo(() => (segment ? segment.tracks.flatMap((t) => [t.clip, ...t.alternatives]) : []), [segment]);
  useEffect(() => {
    let live = true;
    for (const c of clips) if (c && !peaks.peek(c)) peaks.get(c).then(() => live && setVersion((v) => v + 1), () => {});
    return () => void (live = false);
  }, [clips.join("\n")]);

  if (!segment) return <p class="empty">{path} has no segment “{segmentId}”.</p>;

  const apply = (e: Edit, label: string): boolean => {
    if ("error" in e) { setError(e.error); return false; }
    setError("");
    if (e.segment !== segment && event.musicRoot) doc.edit({ ...event, musicRoot: replaceSegment(event.musicRoot, segmentId, e.segment) }, { label });
    return true;
  };

  const facts = (p: string): MusicClipFacts | undefined => {
    const m = peaks.peek(p);
    return m ? { frames: m.frames, rate: m.rate, channels: Math.min(2, Math.max(1, m.channels)), gapless: true } : undefined;
  };
  void version;
  const lint = validateSegment(segment, facts).issues;
  const readOnly = doc.readOnly;

  const doImport = async (paths: readonly string[], alternativeOf?: string) => {
    if (readOnly) return editor.messages.info("This project is read-only.");
    await Promise.all(paths.map((p) => peaks.get(p).catch(() => undefined)));
    const read = async (p: string) => {
      const url = project.assets.get(p);
      return typeof url === "string" ? new Uint8Array(await (await fetch(url)).arrayBuffer()) : undefined;
    };
    const r = await importDropped(segment, paths, read, facts, alternativeOf ? { mode: { alternativeOf } } : undefined);
    const a = r.applied;
    if (r.segment !== segment) apply(ok(r.segment), alternativeOf ? "Add alternatives" : "Import stems");
    const parts = [
      a.tracks.length ? `${a.tracks.length} stem${a.tracks.length === 1 ? "" : "s"}` : "",
      a.alternatives.length ? `${a.alternatives.length} alternative${a.alternatives.length === 1 ? "" : "s"}` : "",
      a.tempo ? `tempo ${a.tempo.bpm} bpm` : "",
      a.cues.length ? `${a.cues.length} cue${a.cues.length === 1 ? "" : "s"}` : "",
      a.region ? `region ${a.region}` : "",
    ].filter(Boolean);
    const skipped = a.skipped.map((s) => `${s.path}: ${s.reason}`);
    editor.messages.info(parts.length ? `Imported ${parts.join(", ")}.` : "Nothing imported.", skipped.length ? skipped.join("\n") : undefined);
  };

  return (
    <div class="segment-panel" data-asset-document={doc.path}>
      <TempoSection segment={segment} peaks={peaks} version={version} readOnly={readOnly} apply={apply} />
      <StemsSection segment={segment} audition={audition} auditionKey={key} readOnly={readOnly} apply={apply} onDrop={doImport} />
      <CuesSection segment={segment} readOnly={readOnly} apply={apply} />
      <RegionsSection segment={segment} readOnly={readOnly} apply={apply} />
      {error && <p class="segment-panel-error" role="alert">{error}</p>}
      <Lint issues={lint} />
    </div>
  );
}

type Apply = (e: Edit, label: string) => boolean;

/** A number that commits on Enter or blur, reverts on Escape; a refused edit puts the old value back. */
function Num(props: { label: string; value: number; onCommit: (n: number) => void; suffix?: string; narrow?: boolean; disabled?: boolean }) {
  const shown = String(props.value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === shown) return;
    if (draft.trim() !== "" && Number.isFinite(n)) props.onCommit(n);
    setDraft(shown);
  };
  return (
    <span class="sp-num">
      <input
        type="text" inputMode="decimal" aria-label={props.label} class={props.narrow ? "narrow" : ""} value={draft} disabled={props.disabled}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") { setDraft(shown); (e.currentTarget as HTMLInputElement).blur(); }
        }}
      />
      {props.suffix && <span class="sp-suffix">{props.suffix}</span>}
    </span>
  );
}

/** Text that commits on Enter or blur and reverts on Escape. */
function Txt(props: { label: string; value: string; onCommit: (s: string) => void; disabled?: boolean; narrow?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
    setDraft(props.value);
  };
  return (
    <input
      type="text" aria-label={props.label} class={props.narrow ? "narrow" : ""} value={draft} disabled={props.disabled} placeholder={props.placeholder}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") { setDraft(props.value); (e.currentTarget as HTMLInputElement).blur(); }
      }}
    />
  );
}

function TempoSection(props: { segment: SegmentNode; peaks: PeaksService; version: number; readOnly: boolean; apply: Apply }) {
  const { segment, readOnly, apply } = props;
  const t = segment.tempo[0]!;
  const [bars, setBars] = useState("");
  const taps = useRef<number[]>([]);
  const [tap, setTap] = useState<ReturnType<typeof tapTempo>>(null);
  const [tapCount, setTapCount] = useState(0);

  void props.version;
  // The longest stem decides the length, as the grid's "end" does.
  let seconds = 0;
  for (const tr of segment.tracks) {
    const m = props.peaks.peek(tr.clip);
    if (m && m.rate > 0) seconds = Math.max(seconds, m.frames / m.rate);
  }
  const barsN = Number(bars);
  const fromLength = bars.trim() !== "" && seconds > 0 ? tempoFromLength(seconds, barsN, t.beatsPerBar, segment.gridOffset) : null;
  const candidates = seconds > 0 ? barCountCandidates(seconds, t.beatsPerBar, { gridOffset: segment.gridOffset }) : [];

  const onTap = () => {
    const now = performance.now() / 1000;
    const last = taps.current[taps.current.length - 1];
    taps.current = last !== undefined && now - last > 2 ? [now] : [...taps.current, now].slice(-32);
    setTapCount(taps.current.length);
    setTap(tapTempo(taps.current));
  };

  return (
    <section class="sp-section" aria-label="Tempo">
      <h3>Tempo</h3>
      <div class="sp-row">
        <label>Tempo <Num label="Tempo" value={t.bpm} suffix="bpm" disabled={readOnly} onCommit={(n) => apply(setTempo(segment, { bpm: n }), "Set tempo")} /></label>
        <label>Metre <Num label="Beats per bar" value={t.beatsPerBar} narrow disabled={readOnly} onCommit={(n) => apply(setTempo(segment, { beatsPerBar: n }), "Set metre")} />
          <span class="sp-suffix">/</span>
          <select aria-label="Beat unit" value={t.beatUnit} disabled={readOnly} onChange={(e) => apply(setTempo(segment, { beatUnit: Number((e.currentTarget as HTMLSelectElement).value) }), "Set metre")}>
            {BEAT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        <label>Grid offset <Num label="Grid offset" value={segment.gridOffset} suffix="s" disabled={readOnly} onCommit={(n) => apply(setGridOffset(segment, n), "Set grid offset")} /></label>
      </div>
      <div class="sp-row" aria-label="Tempo from length">
        <span class="sp-muted">{seconds > 0 ? `Length ${seconds.toFixed(3)} s` : "Length unknown (stems not decoded yet)"}</span>
        <label>Bars
          <input type="text" inputMode="numeric" aria-label="Bars in the clip" class="narrow" value={bars} disabled={readOnly || seconds <= 0} onInput={(e) => setBars((e.currentTarget as HTMLInputElement).value)} />
        </label>
        {candidates.length > 0 && (
          <select aria-label="Likely bar counts" value="" disabled={readOnly} onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) setBars(v); }}>
            <option value="">likely…</option>
            {candidates.map((c) => <option key={c.bars} value={c.bars}>{c.bars} bars ({Math.round(c.bpm * 10) / 10} bpm)</option>)}
          </select>
        )}
        <button disabled={readOnly || !fromLength} title={fromLength && !fromLength.valid ? `outside ${MIN_BPM}..${MAX_BPM} bpm` : undefined}
          onClick={() => fromLength && apply(setTempo(segment, { bpm: fromLength.bpm }), "Tempo from length")}>
          {fromLength ? `Use ${round3(fromLength.bpm)} bpm` : "Use"}
        </button>
      </div>
      <div class="sp-row" aria-label="Tap tempo">
        <button onClick={onTap} disabled={readOnly}>Tap</button>
        <span class="sp-muted" aria-live="polite">{tap ? `${Math.round(tap.bpm * 10) / 10} bpm (${tapCount} taps)` : tapCount > 0 ? "keep tapping" : "tap on the beat"}</span>
        <button disabled={readOnly || !tap} onClick={() => tap && apply(setTempo(segment, { bpm: tap.bpm }), "Tap tempo")}>Use</button>
        <button disabled={tapCount === 0} onClick={() => { taps.current = []; setTapCount(0); setTap(null); }}>Reset</button>
      </div>
    </section>
  );
}

function StemsSection(props: {
  segment: SegmentNode; audition: StemAudition; auditionKey: string; readOnly: boolean; apply: Apply;
  onDrop: (paths: readonly string[], alternativeOf?: string) => Promise<void>;
}) {
  const { segment, audition, readOnly, apply } = props;
  const list = useRef<HTMLUListElement>(null);
  const latest = useRef(props);
  latest.current = props;

  // A drop on a stem row adds alternatives to it; elsewhere in the list each file is a new stem.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const target = (point: { x: number; y: number }) => document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-stem]")?.dataset.stem;
    return registerAssetDropTarget(el, {
      accepts: (assets) => assets.length > 0 && assets.every((a) => AUDIO_EXT.test(a)),
      label: (assets, point) => {
        const s = target(point);
        return s ? `Add ${assets.length} alternative${assets.length === 1 ? "" : "s"} to ${s}` : `Add ${assets.length} stem${assets.length === 1 ? "" : "s"}`;
      },
      drop: (assets, point) => void latest.current.onDrop(assets, target(point)),
    });
  }, []);

  const audible = new Set(audibleStems(segment.tracks, audition));
  return (
    <section class="sp-section" aria-label="Stems">
      <h3>Stems <span class="sp-muted">{segment.tracks.length}/{MUSIC_LIMITS.tracks}</span></h3>
      <ul class="sp-list" ref={list}>
        {segment.tracks.length === 0 && <li class="sp-muted">Drop audio files from the Assets panel to add stems.</li>}
        {segment.tracks.map((t, i) => (
          <li key={t.name} class={`sp-stem${audible.has(t.name) ? "" : " silent"}`} data-stem={t.name}>
            <div class="sp-row">
              <button class={`sp-toggle${audition.solo.includes(t.name) ? " on" : ""}`} aria-pressed={audition.solo.includes(t.name)} title="Solo (audition only)" onClick={() => toggleStem(props.auditionKey, "solo", t.name)}>S</button>
              <button class={`sp-toggle${audition.mute.includes(t.name) ? " on" : ""}`} aria-pressed={audition.mute.includes(t.name)} title="Mute (audition only)" onClick={() => toggleStem(props.auditionKey, "mute", t.name)}>M</button>
              <Txt label={`Name of ${t.name}`} value={t.name} disabled={readOnly} onCommit={(s) => apply(renameTrack(segment, t.name, s), "Rename stem")} />
              <Num label={`Gain of ${t.name}`} value={t.volume} narrow disabled={readOnly} onCommit={(n) => apply(setTrackVolume(segment, t.name, n), "Set stem gain")} />
              <button disabled={readOnly || i === 0} title="Move up" onClick={() => apply(moveTrack(segment, t.name, -1), "Move stem")}>↑</button>
              <button disabled={readOnly || i === segment.tracks.length - 1} title="Move down" onClick={() => apply(moveTrack(segment, t.name, 1), "Move stem")}>↓</button>
              <button disabled={readOnly} title="Remove stem" onClick={() => apply(removeTrack(segment, t.name), "Remove stem")}>✕</button>
            </div>
            <div class="sp-clip sp-muted" title={t.clip}>{t.clip || "(no clip)"}</div>
            {t.alternatives.length > 0 && (
              <div class="sp-alts">
                <label>Pick
                  <select aria-label={`Pick of ${t.name}`} value={t.pick} disabled={readOnly} onChange={(e) => apply(setTrackPick(segment, t.name, (e.currentTarget as HTMLSelectElement).value as TrackPick), "Set stem pick")}>
                    {TRACK_PICKS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <ul>
                  {t.alternatives.map((a) => (
                    <li key={a}>
                      <span class="sp-clip" title={a}>{a}</span>
                      <button disabled={readOnly} title="Make this the main clip" onClick={() => apply(promoteAlternative(segment, t.name, a), "Promote alternative")}>Use</button>
                      <button disabled={readOnly} title="Remove alternative" onClick={() => apply(removeAlternative(segment, t.name, a), "Remove alternative")}>✕</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p class="sp-muted sp-hint">Solo and mute only affect the audition. Drop a file on a stem to add it as an alternative.</p>
    </section>
  );
}

function CuesSection(props: { segment: SegmentNode; readOnly: boolean; apply: Apply }) {
  const { segment, readOnly, apply } = props;
  const names = segment.cues.map((c) => c.name);
  return (
    <section class="sp-section" aria-label="Cues">
      <h3>Cues <span class="sp-muted">{segment.cues.length}/{MUSIC_LIMITS.cues}</span></h3>
      <div class="sp-row">
        <label>Entry
          <select aria-label="Entry cue" value={segment.entry ?? ""} disabled={readOnly} onChange={(e) => apply(setEntry(segment, (e.currentTarget as HTMLSelectElement).value || undefined), "Set entry")}>
            <option value="">default</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>Exit
          <select aria-label="Exit cue" value={segment.exit ?? ""} disabled={readOnly} onChange={(e) => apply(setExit(segment, (e.currentTarget as HTMLSelectElement).value || undefined), "Set exit")}>
            <option value="">default</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <ul class="sp-list">
        {segment.cues.map((c) => (
          <li key={c.name} class="sp-row">
            <Txt label={`Name of cue ${c.name}`} value={c.name} disabled={readOnly} onCommit={(s) => apply(renameCue(segment, c.name, s), "Rename cue")} />
            <Txt label={`Position of cue ${c.name}`} value={c.at} narrow disabled={readOnly} onCommit={(s) => apply(setCueAt(segment, c.name, s), "Move cue")} />
            <button disabled={readOnly} title="Remove cue" onClick={() => apply(removeCue(segment, c.name), "Remove cue")}>✕</button>
          </li>
        ))}
      </ul>
      <button disabled={readOnly || segment.cues.length >= MUSIC_LIMITS.cues} onClick={() => apply(addCue(segment), "Add cue")}>+ Cue</button>
    </section>
  );
}

function RegionsSection(props: { segment: SegmentNode; readOnly: boolean; apply: Apply }) {
  const { segment, readOnly, apply } = props;
  return (
    <section class="sp-section" aria-label="Regions">
      <h3>Regions <span class="sp-muted">{segment.regions.length}/{MUSIC_LIMITS.regions}</span></h3>
      <ul class="sp-list">
        {segment.regions.map((r) => <RegionForm key={r.id} segment={segment} region={r} readOnly={readOnly} apply={apply} />)}
      </ul>
      <button disabled={readOnly || segment.regions.length >= MUSIC_LIMITS.regions} onClick={() => apply(addRegion(segment), "Add region")}>+ Region</button>
    </section>
  );
}

function RegionForm(props: { segment: SegmentNode; region: MusicRegion; readOnly: boolean; apply: Apply }) {
  const { segment, region: r, readOnly, apply } = props;
  const patch = (p: RegionPatch, label: string) => apply(updateRegion(segment, r.id, p), label);
  const w = r.while;
  const form: ConditionForm = !w ? "is" : "is" in w ? "is" : "atLeast" in w ? "atLeast" : "below";
  const valueOf = !w ? "" : "is" in w ? w.is : String("atLeast" in w ? w.atLeast : w.below);
  const [cond, setCond] = useState({ parameter: w?.parameter ?? "", form, value: valueOf });
  useEffect(() => setCond({ parameter: w?.parameter ?? "", form, value: valueOf }), [w?.parameter, form, valueOf]);
  const commitCond = (next: typeof cond) => {
    setCond(next);
    if (next.parameter.trim() === "" && next.value.trim() === "") return void patch({ while: null }, "Clear region condition");
    const c = readCondition(next.parameter, next.form, next.value);
    if ("error" in c) return void apply(fail(`while: ${c.error}`), "");
    patch({ while: c.condition }, "Set region condition");
  };
  return (
    <li class="sp-region">
      <div class="sp-row">
        <Txt label={`Name of region ${r.id}`} value={r.id} disabled={readOnly} onCommit={(s) => patch({ id: s }, "Rename region")} />
        <Txt label={`From of region ${r.id}`} value={r.from} narrow disabled={readOnly} onCommit={(s) => patch({ from: s }, "Set region start")} />
        <span class="sp-suffix">to</span>
        <Txt label={`To of region ${r.id}`} value={r.to} narrow disabled={readOnly} onCommit={(s) => patch({ to: s }, "Set region end")} />
        <button disabled={readOnly} title="Remove region" onClick={() => apply(removeRegion(segment, r.id), "Remove region")}>✕</button>
      </div>
      <div class="sp-row">
        <label>Passes <Num label={`Passes of region ${r.id}`} value={r.count} narrow disabled={readOnly} onCommit={(n) => patch({ count: n }, "Set region passes")} /><span class="sp-suffix">0 = forever</span></label>
        <label>Tail <Num label={`Tail of region ${r.id}`} value={r.tailBeats ?? 0} narrow suffix="beats" disabled={readOnly} onCommit={(n) => patch({ tailBeats: n === 0 ? null : n }, "Set region tail")} /></label>
      </div>
      <div class="sp-row">
        <span class="sp-muted">While</span>
        <input type="text" aria-label={`While parameter of region ${r.id}`} placeholder="parameter" value={cond.parameter} disabled={readOnly}
          onInput={(e) => setCond({ ...cond, parameter: (e.currentTarget as HTMLInputElement).value })} onBlur={() => commitCond(cond)} />
        <select aria-label={`While comparison of region ${r.id}`} value={cond.form} disabled={readOnly} onChange={(e) => commitCond({ ...cond, form: (e.currentTarget as HTMLSelectElement).value as ConditionForm })}>
          <option value="is">is</option><option value="atLeast">at least</option><option value="below">below</option>
        </select>
        <input type="text" aria-label={`While value of region ${r.id}`} class="narrow" placeholder="value" value={cond.value} disabled={readOnly}
          onInput={(e) => setCond({ ...cond, value: (e.currentTarget as HTMLInputElement).value })} onBlur={() => commitCond(cond)} />
      </div>
    </li>
  );
}

function Lint({ issues }: { issues: readonly MusicLintIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <section class="sp-section" aria-label="Lint">
      <h3>Lint <span class="sp-muted">{issues.length}</span></h3>
      <ul class="sp-lint">
        {issues.map((i, n) => <li key={n} class={i.severity}>{i.message}</li>)}
      </ul>
    </section>
  );
}
