/**
 * Loop tails and the members' region walk (ADR 0166 api-and-models §2.3 regions, §11 point 5; architecture §3.5; ADR
 * 0167 §2: loop tails are decoded clips).
 *
 * Owner: **R4a** (W7), on R4c's span clips (`core/clipRegistry.ts`: decode `[start, end)` of an asset as its own clip).
 * Q2 wrote the skeleton.
 *
 * **Tails.** At each wrap of a loop region with `tailBeats`, the audio after the loop end (the tail: `tailBeats` beats
 * from the region's `to`) is played as a decoded span voice per stem, stamped at the wrap, ungated, ramp-free, so it
 * rings over the wrap while the next pass starts on the grid. A wrap the music leaves by a transition at the wrap (an
 * exit at the loop end) still gets its tail: it rings on under the next segment. A wrap the music leaves before (an
 * exit earlier in the pass) gets none, nor does the last pass's end (the members play on into the audio after the
 * region by themselves). The spans are held (`AudioBackend.holdSpan`) from the moment the run plays, so a span is
 * resident when its voice is stamped; a span the backend refuses (over 30 s, over the clip ceiling) drops that tail
 * with one warning (`tailRefused`) and the loop goes on. A tail whose span is still loading, or whose wrap is already
 * inside the lead when it would be stamped, is skipped (`refusals.tailLate`). A backend without span clips plays no
 * tails.
 *
 * **The region walk** (counted loops, several regions, `while` releases). The members start looping the region of
 * their first wrap (`segmentRun.groupRequest` through `anchors.firstLoopOf`). Each tick the region of the next wrap
 * (`anchors.nextWrapOf`, which honours R4b's `released`) is the one they should loop; when it changes (the last wrap of
 * a `count` region was heard, or R4b released a `while` region) the members are moved on with the voice's own loop
 * record (`AutomationSink.setLoop`, else `AudioVoice.setLoop`): a new region they reach later, or a release. A decoded
 * member's release lands at once and the voice plays on through its last pass; a streamed member's lands at the end of
 * its current pass (the worker's region-release splice). Either way the last pass ends at the predicted exit.
 *
 * **Ringing runs** (P4's open point). When the player's run changes while the old run still sounds (the audio after
 * its exit cue ringing under the next segment), the old run is kept here until its voices end, so `handle.stop`
 * stops it and the instance counts its voices, like the tail voices (`eventRuntime.ts` `musicVoices`; F-7e).
 */
import type { AudioVoice, ClipSpanHold, PlayRequest } from "../backend";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, positionTextToTicks, ticksToSeconds, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import { warnOnce } from "../core/handle";
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import { firstLoopOf, nextWrapOf, regionFramesOf } from "./anchors";
import { frameIntervalSeconds, lookaheadSeconds } from "./planner";
import { groupRequest, segmentClipSource, type SegmentRun } from "./segmentRun";

/** One held tail span: a region's tail for one stem of the run. */
interface TailSpan {
  /** Index of the region in the node's `regions`. */
  readonly region: number;
  /** Index of the stem in the run's `stems`. */
  readonly stem: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly hold: ClipSpanHold;
}

/** The player's ringing tails. R4a may add fields here. */
export interface LoopTailState {
  /** Tail voices still ringing, with the heard time (seconds) each was stamped at. */
  readonly ringing: { voice: AudioVoice; at: number }[];
  /** Heard time (seconds) of the last wrap whose tail was stamped (or skipped); NaN: none yet for this run. */
  nextWrap: number;
  /** R4a: the run the walk and the holds follow (the player's run when last ticked). */
  run: SegmentRun | null;
  /** R4a: the region (index in the node's `regions`) the run's members loop now; -1: none (released, or never). */
  looping: number;
  /** R4a: the run's held tail spans (every region with `tailBeats`, every stem), taken once the run plays. */
  readonly spans: TailSpan[];
  /** R4a: the spans were taken for `run`. */
  held: boolean;
  /** R4a: outgoing runs still sounding after the player moved on (their post-exit audio), until their voices end. */
  readonly runs: SegmentRun[];
}

/** R4a: an empty tail state. */
export function createLoopTailState(): LoopTailState {
  return { ringing: [], nextWrap: Number.NaN, run: null, looping: -1, spans: [], held: false, runs: [] };
}

/** Float noise allowed when comparing heard seconds (far under one frame at 192 kHz). */
const EPS = 1e-7;
/** The clip rate when no stem has facts yet (as `anchors.ts`). */
const FALLBACK_RATE = 48_000;

const alive = (v: AudioVoice): boolean => v.alive ?? v.playing;

function sounding(run: SegmentRun): boolean {
  if (run.state === "cancelled" || run.state === "new") return false;
  for (const s of run.stems) if (s.voice && alive(s.voice)) return true;
  return false;
}

function clipRate(clip: string): number {
  const r = segmentClipSource().facts(clip)?.rate;
  return r !== undefined && r > 0 ? r : FALLBACK_RATE;
}

/** The rate the run's `startFrame` is in: its first stem's (as `anchors.ts`). */
function runRate(run: SegmentRun): number {
  for (const s of run.stems) {
    const r = segmentClipSource().facts(s.clip)?.rate;
    if (r !== undefined && r > 0) return r;
  }
  return FALLBACK_RATE;
}

const grids = new WeakMap<object, SegmentGrid | null>();

/** The segment's grid (positions only: a tail never needs the file's end). */
function gridOf(node: MusicNodeRef): SegmentGrid | null {
  if (grids.has(node)) return grids.get(node) ?? null;
  const seg = node as Partial<SegmentNode>;
  const grid = node.type === "segment" && Array.isArray(seg.tempo) ? compileSegmentGrid({ ...seg, cues: seg.cues ?? [] } as SegmentNode) : null;
  grids.set(node, grid);
  return grid;
}

/**
 * The tail span of region `index` in file frames of `rate`: from the region's `to` (as the members loop it) for its
 * `tailBeats` beats. Null without a tail, or when the region ends at the file's end (nothing follows it).
 */
export function tailSpanOf(node: MusicNodeRef, index: number, rate: number): { startFrame: number; endFrame: number } | null {
  const reg = (node as Partial<SegmentNode>).regions?.[index];
  const beats = reg?.tailBeats ?? 0;
  if (!reg || !(beats > 0) || reg.to === "end" || reg.to === "start") return null;
  const frames = regionFramesOf(node, index, rate);
  const grid = gridOf(node);
  const to = grid ? positionTextToTicks(grid, reg.to) : null;
  if (!frames || frames.endFrame <= 0 || !grid || to === null) return null;
  const endFrame = Math.round(ticksToSeconds(grid, to + beats * MUSIC_TICKS_PER_BEAT) * rate);
  return endFrame > frames.endFrame ? { startFrame: frames.endFrame, endFrame } : null;
}

function releaseSpans(st: LoopTailState): void {
  for (const s of st.spans) s.hold.release();
  st.spans.length = 0;
  st.held = false;
}

/** Take the run's tail spans (every region with a tail, every stem), once. */
function holdSpans(st: LoopTailState, run: SegmentRun, f: MusicFrame): void {
  st.held = true;
  const hold = f.backend.holdSpan;
  const regions = (run.node as Partial<SegmentNode>).regions;
  if (!hold || !Array.isArray(regions)) return;
  for (let region = 0; region < regions.length; region++) {
    if (!((regions[region]!.tailBeats ?? 0) > 0)) continue;
    for (let stem = 0; stem < run.stems.length; stem++) {
      const clip = run.stems[stem]!.clip;
      const span = tailSpanOf(run.node, region, clipRate(clip));
      if (!span) continue;
      st.spans.push({ region, stem, ...span, hold: hold.call(f.backend, clip, span.startFrame, span.endFrame) });
    }
  }
}

/** The members move on to region `target` (a loop of it), or are released (`target` -1) from region `from`. */
function moveMembers(run: SegmentRun, from: number, target: number, f: MusicFrame): void {
  for (const s of run.stems) {
    const v = s.voice;
    if (!v) continue;
    const rate = clipRate(s.clip);
    const frames = regionFramesOf(run.node, target >= 0 ? target : from, rate);
    if (!frames) continue;
    const start = frames.startFrame / rate, end = frames.endFrame / rate;
    const sink = f.backend.automation;
    if (sink) sink.setLoop(v, start, end, target >= 0);
    else v.setLoop?.(start, end, target >= 0);
  }
}

/** True when an open transition leaves the playing run before heard time `t`. */
function leavesBefore(player: MusicPlayer, t: number): boolean {
  const tr = player.transition;
  if (!tr || tr.state === "done" || tr.state === "cancelled") return false;
  return Number.isFinite(tr.exitAt) && tr.exitAt < t - 1e-6;
}

/** Stamp region `region`'s tail at the wrap heard at `at`, one decoded span voice per stem. */
function stampTails(player: MusicPlayer, st: LoopTailState, run: SegmentRun, region: number, at: number, f: MusicFrame): void {
  let req: ReturnType<typeof groupRequest> | null = null;
  for (const span of st.spans) {
    if (span.region !== region) continue;
    const stem = run.stems[span.stem];
    if (!stem || !stem.voice) continue; // the stem ended or never started: nothing rings
    const state = span.hold.state;
    if (state === "failed") {
      refuse(player, `${run.node.id}:${region}:${stem.track}`, `Music "${player.instance.path}": the loop tail of segment "${run.node.id}" region ${region} on stem "${stem.track}" was refused (${span.hold.failure ?? "failed"}); the loop goes on without it.`);
      continue;
    }
    if (state !== "ready") {
      count(player, "tailLate");
      continue;
    }
    req ??= groupRequest(player, run);
    const base = req.members[span.stem]?.play;
    if (!base) continue;
    const play: PlayRequest = { ...base, loop: false, stream: false, at, span: { startFrame: span.startFrame, endFrame: span.endFrame } };
    delete play.fadeZero;
    const voice = f.backend.play(play);
    if (voice) st.ringing.push({ voice, at });
  }
}

function count(player: MusicPlayer, cause: string): void {
  const r = player.counters.refusals;
  r[cause] = (r[cause] ?? 0) + 1;
}

const refusedKeys = new WeakMap<MusicPlayer, Set<string>>();

/** A refused tail span: counted and warned once per region and stem (`tailRefused`). */
function refuse(player: MusicPlayer, key: string, message: string): void {
  let keys = refusedKeys.get(player);
  if (!keys) refusedKeys.set(player, (keys = new Set()));
  if (keys.has(key)) return;
  keys.add(key);
  count(player, "tailRefused");
  warnOnce(`music:tailRefused:${player.instance.path}:${key}`, message);
}

/** R4a, step 9: walk the members' regions, stamp the tail for the next wrap when it is within the lead; forget ended tails. */
export function tickLoopTails(player: MusicPlayer, f: MusicFrame): void {
  let st = player.tails;
  if (!st) {
    if (!player.run) return;
    st = player.tails = createLoopTailState();
  }
  // Forget what ended.
  let w = 0;
  for (const t of st.ringing) if (alive(t.voice)) st.ringing[w++] = t;
  st.ringing.length = w;
  w = 0;
  for (const r of st.runs) if (r !== player.run && sounding(r)) st.runs[w++] = r;
  st.runs.length = w;

  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") {
    if (st.spans.length > 0) releaseSpans(st);
    return;
  }

  const run = player.run;
  if (run !== st.run) {
    // The player moved on: an old run still sounding (its post-exit audio) is kept until it ends.
    const old = st.run;
    if (old && old !== run && sounding(old) && !st.runs.includes(old)) st.runs.push(old);
    releaseSpans(st);
    st.run = run;
    st.nextWrap = Number.NaN;
    const rate = run && run.stems.length > 0 ? clipRate(run.stems[0]!.clip) : FALLBACK_RATE;
    st.looping = run ? (firstLoopOf(run.node, rate, run.startFrame * (rate / runRate(run)))?.region ?? -1) : -1;
  }
  if (!run || (run.state !== "stamped" && run.state !== "playing")) return;
  if (!st.held) holdSpans(st, run, f);

  const next = nextWrapOf(player, f.now);
  const wrap = next.at;
  // The region walk: the members loop the region of the next wrap, or nothing.
  const target = Number.isFinite(wrap) ? next.region : -1;
  if (target !== st.looping) {
    moveMembers(run, st.looping, target, f);
    st.looping = target;
  }

  // The tail of the next wrap, in the last frame before it is inside the lead.
  if (!Number.isFinite(wrap) || Math.abs(wrap - st.nextWrap) < 1e-6 || st.spans.length === 0) return;
  const lead = lookaheadSeconds(f);
  if (wrap - f.now > lead + frameIntervalSeconds(f) + EPS) return;
  st.nextWrap = wrap;
  if (!st.spans.some((s) => s.region === target)) return;
  if (wrap < f.now + lead - EPS) {
    count(player, "tailLate");
    return;
  }
  if (leavesBefore(player, wrap)) return; // the music leaves before the loop end: no tail
  stampTails(player, st, run, target, wrap, f);
}

/**
 * R4a: `handle.stop(fade)` (from `segmentRun.stopPlayerRuns`): every ringing tail voice and outgoing run fades out with
 * the stems, stamped at `at` (heard seconds); the held spans are dropped.
 */
export function stopLoopTails(player: MusicPlayer, seconds: number, at: number): void {
  const st = player.tails;
  if (!st) return;
  const stop = (v: AudioVoice): void => {
    if (!alive(v)) return;
    if (v.fadeShaped) v.fadeShaped({ to: 0, seconds, law: "equalPowerOut", at, stopAtEnd: true });
    else v.stop(seconds);
  };
  for (const t of st.ringing) stop(t.voice);
  for (const r of st.runs) {
    if (r === player.run || r === player.next) continue; // `stopPlayerRuns` stops those
    for (const s of r.stems) if (s.voice) stop(s.voice);
  }
  releaseSpans(st);
}

/**
 * R4a: the voices this state keeps sounding beyond the player's run and next run (tail voices, outgoing runs), for the
 * instance's voice reads (`hasVoices`, pause, fades; F-7e). Appends to `out`.
 */
export function loopTailVoices(player: MusicPlayer, out: AudioVoice[]): void {
  const st = player.tails;
  if (!st) return;
  for (const t of st.ringing) out.push(t.voice);
  for (const r of st.runs) {
    if (r === player.run || r === player.next) continue;
    for (const s of r.stems) if (s.voice) out.push(s.voice);
  }
}
