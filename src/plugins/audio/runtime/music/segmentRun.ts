/**
 * A segment's run: its stems as one group, primed and stamped together (ADR 0166 api-and-models §3.2 `SegmentRun`,
 * `PrimeJob`, §4.6; architecture §2.2, §3.1, §4.2).
 *
 * Owner: **P1** (W3), with `core/musicOps.ts` (the backend's side). Q2 wrote the skeleton.
 *
 * A run picks each track's alternative, decides decoded or streamed per clip (the stream-or-decode rule, §2.6), takes a
 * group id from the counter over 1..1023 that skips live ids, admits the group (`MusicBackend.admitGroup`), primes it
 * (`primeGroup`, one batch per group), watches `primedState`, and stamps it at the planner's time (`stampGroup`). Every
 * voice it starts is an ordinary voice tagged with its group.
 */
import type { AudioVoice, MusicGroupEvent, MusicGroupMember, MusicGroupRequest, MusicGroupStamp, PlayRequest } from "../backend";
import type { MusicTrack, SegmentNode } from "../../../../engine/audio/musicFormat";
import { stemMode, type MusicClipFacts } from "../../../../engine/audio/musicValidate";
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import type { EventOptions } from "../events/eventRuntime";
import { audioBackend } from "../backend";
import { applySlip } from "./anchors";

/** The highest music group id (§3.2: ids 1..1023). */
export const MAX_MUSIC_GROUP_ID = 1023;

/**
 * How a run resolves a stem's clip (P1). The event runtime's clip starter is private to `eventRuntime.ts`, so whoever
 * owns `AudioSource.ts` provides this (P6/P7 wire it; tests set it). `facts` feeds the stream-or-decode rule (§2.6,
 * `musicValidate.stemMode`: up to 30 s decoded, longer streamed); unknown facts fall back to the import setting `stream`.
 */
export interface SegmentClipSource {
  /** The clip's URL. */
  url(path: string): string;
  /** The clip's import settings (ADR 0040): `volume` scales the stem, `stream` is the fallback mode. */
  settings(path: string): { readonly volume: number; readonly stream: boolean };
  /** A mixer bus name for a track's `bus` or the event's (empty or unknown: Master). */
  bus(output: string | undefined): string;
  /** The clip's facts (length, rate), or undefined when not yet probed. */
  facts(path: string): MusicClipFacts | undefined;
}

const DEFAULT_CLIP_SOURCE: SegmentClipSource = {
  url: (path) => path,
  settings: () => ({ volume: 1, stream: true }),
  bus: (output) => output ?? "",
  facts: () => undefined,
};
let clipSource: SegmentClipSource = DEFAULT_CLIP_SOURCE;

/** Set how runs resolve clips; null restores the default (URL = path, streamed, no facts). */
export function setSegmentClipSource(source: SegmentClipSource | null): void {
  clipSource = source ?? DEFAULT_CLIP_SOURCE;
}

/** @internal The clip source in use. */
export function segmentClipSource(): SegmentClipSource {
  return clipSource;
}

/** One stem of a run (§3.2 `StemRun`). */
export interface StemRun {
  /** The track's name (debug rows). */
  readonly track: string;
  /** Index of the picked alternative in the track's list (0 without alternatives). */
  readonly alternative: number;
  /** The clip's asset path. */
  readonly clip: string;
  /** Streamed (a music ring) or decoded (the arena). */
  readonly streamed: boolean;
  /** The member's voice once stamped; null before, or when it couldn't start. */
  voice: AudioVoice | null;
  /** Primed in the group's current epoch (decoded members count as primed). */
  primed: boolean;
}

/** Where a run is (architecture §2.2). */
export type SegmentRunState = "new" | "admitted" | "priming" | "stamped" | "playing" | "ending" | "cancelled";

/** One segment's run (§3.2 `SegmentRun`). P1 may add fields here. */
export interface SegmentRun {
  /** The segment node. */
  readonly node: MusicNodeRef;
  /** The player the run belongs to (P1: its counters, its instance). */
  readonly player: MusicPlayer;
  state: SegmentRunState;
  /** The music group id (1..1023), 0 until admitted. */
  group: number;
  readonly stems: StemRun[];
  /** Heard time (seconds) the group is stamped to start at (entry minus pre-entry), NaN until planned. */
  startAt: number;
  /** File frame the members start at (entry - pre-entry, or a loop or seek offset). */
  startFrame: number;
  /** Loop passes completed (P3). */
  loopsDone: number;
  /** The prime job while priming, else null. */
  prime: PrimeJob | null;
}

/** A group's priming (§3.2 `PrimeJob`). */
export interface PrimeJob {
  readonly group: number;
  /** Heard time (seconds) the prime was asked for. */
  readonly requestedAt: number;
  /** `performance.now()` ms when `primeGroup` was posted (for Ê, architecture §4.2). */
  readonly postedMs: number;
  /** Members primed in the current epoch, of `of`. */
  primed: number;
  readonly of: number;
  /** `performance.now()` ms of the poll that first saw every member primed; NaN until then. */
  readyMs: number;
}

/**
 * P1: a run for `node`: picks alternatives (seeded by the instance), resolves clips and the stream-or-decode rule. Does
 * not admit, prime or start anything. Null when the node has no playable track.
 */
export function createSegmentRun(player: MusicPlayer, node: MusicNodeRef, startFrame: number): SegmentRun | null {
  const tracks = (node as Partial<SegmentNode>).tracks;
  if (node.type !== "segment" || !Array.isArray(tracks) || tracks.length === 0) return null;
  const stems: StemRun[] = [];
  for (let k = 0; k < tracks.length; k++) {
    const t = tracks[k]!;
    if (!t.clip) continue;
    const alternative = pickAlternative(t, player.instance.group, node.id, k, 0);
    const clip = alternative === 0 ? t.clip : t.alternatives[alternative - 1]!;
    const streamed = isStreamed(clip);
    stems.push({ track: t.name, alternative, clip, streamed, voice: null, primed: !streamed });
  }
  if (stems.length === 0) return null;
  return { node, player, state: "new", group: 0, stems, startAt: Number.NaN, startFrame: Math.max(0, Math.round(startFrame)), loopsDone: 0, prime: null };
}

/** The stream-or-decode rule (§2.6): the clip's facts when known (30 s rule), else its import setting. */
function isStreamed(clip: string): boolean {
  const facts = clipSource.facts(clip);
  if (facts && facts.rate > 0) return stemMode(clip, facts) === "stream";
  return clipSource.settings(clip).stream;
}

/**
 * The alternative a track plays on `pass` (0 = its `clip`, k = `alternatives[k - 1]`): `sequence` steps through them,
 * `random` hashes the instance, segment, track and pass (deterministic per instance, so a REPLAY picks the same).
 */
export function pickAlternative(t: MusicTrack, instance: number, segment: string, track: number, pass: number): number {
  const n = 1 + (t.alternatives?.length ?? 0);
  if (n === 1) return 0;
  if (t.pick !== "random") return pass % n;
  let h = (Math.imul(instance | 0, 0x9e3779b1) ^ Math.imul(track + 1, 0x85ebca6b) ^ Math.imul(pass + 1, 0xc2b2ae35)) >>> 0;
  for (let i = 0; i < segment.length; i++) h = Math.imul(h ^ segment.charCodeAt(i), 16777619) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 0) % n;
}

/**
 * P1: the group request of a run (one member per stem, `play` requests on the event's bus, `world`, `group`). P3
 * (F-7c): the instance's `EventOptions` count as for any event voice (`eventRuntime.ts` `playClip`): `bus` overrides
 * the event's bus (a track's own `bus` still wins), `priority` the event's priority, and the volume is the event's
 * `volume` times the option's (clamped at 0) times the track's and the clip's import volume.
 */
export function groupRequest(player: MusicPlayer, run: SegmentRun): MusicGroupRequest {
  const inst = player.instance;
  const asset = inst.asset as { bus?: string; priority?: number; volume?: number } | undefined;
  // `options` is private to the event runtime (a coordinator file); read it as data, as `playClip` does.
  const options = (inst as unknown as { options?: EventOptions }).options;
  const bus = options?.bus ?? (asset?.bus || undefined);
  const priority = options?.priority ?? asset?.priority;
  const level = (asset?.volume ?? 1) * Math.max(0, options?.volume ?? 1);
  const tracks = (run.node as SegmentNode).tracks;
  const members: MusicGroupMember[] = [];
  for (const s of run.stems) {
    const t = tracks.find((x) => x.name === s.track);
    const settings = clipSource.settings(s.clip);
    const play: PlayRequest = {
      path: s.clip,
      url: clipSource.url(s.clip),
      loop: false,
      stream: s.streamed,
      bus: clipSource.bus(t?.bus || bus),
      volume: level * (t?.volume ?? 1) * settings.volume,
      priority,
      world: inst.world,
      group: inst.group,
    };
    members.push({ stem: s.track, play, startFrame: run.startFrame, loop: false });
  }
  return { instance: inst.group, group: run.group, members };
}

// --- Live groups and the id counter (§3.2) ---

/** Runs holding a group id, by id. An id is live from admission until cancel, abandon or every member's end. */
const live = new Map<number, SegmentRun>();
let counter = 1;

/** P1: a free group id from the counter over 1..1023 that skips live ids; 0 when every id is live. */
export function nextGroupId(isLive: (id: number) => boolean): number {
  for (let n = 0; n < MAX_MUSIC_GROUP_ID; n++) {
    const id = counter;
    counter = counter >= MAX_MUSIC_GROUP_ID ? 1 : counter + 1;
    if (!isLive(id)) return id;
  }
  return 0;
}

/** @internal The live run of `group`, or undefined. */
export function liveRun(group: number): SegmentRun | undefined {
  return live.get(group);
}

function release(run: SegmentRun): void {
  if (run.group > 0 && live.get(run.group) === run) live.delete(run.group);
}

/** Every path the player's runs use: the instance's protected set for the worker's encoded cache (C8). */
function protectedPaths(player: MusicPlayer, extra: SegmentRun): string[] {
  const out = new Set<string>();
  for (const r of [player.run, player.next, extra]) {
    if (!r || r.state === "cancelled") continue;
    for (const s of r.stems) if (s.streamed) out.add(s.clip);
  }
  return [...out];
}

/**
 * P1: admit and prime the run's group (`admitGroup`, `primeGroup` with the instance's protected paths). False when the
 * backend refused it (the planner reads the refusal from the run's state and the counters).
 */
export function primeRun(player: MusicPlayer, run: SegmentRun, f: MusicFrame): boolean {
  const music = f.music;
  if (!music || run.state !== "new") return false;
  const group = nextGroupId((id) => live.has(id));
  if (group === 0) return false;
  run.group = group;
  const req = groupRequest(player, run);
  const admit = music.admitGroup(req);
  if (!admit.ok) {
    run.group = 0;
    return false;
  }
  live.set(group, run);
  const streamed = run.stems.filter((s) => s.streamed).length;
  if (streamed === 0) {
    run.state = "admitted";
    run.prime = null;
    return true;
  }
  const postedMs = performance.now();
  music.primeGroup(req, { protect: protectedPaths(player, run) });
  run.state = "priming";
  run.prime = { group, requestedAt: f.now, postedMs, primed: run.stems.length - streamed, of: run.stems.length, readyMs: Number.NaN };
  return true;
}

/** P1: the run's primed state from the backend's last STATUS (updates `stems[].primed` and `prime`). True when every member is primed. */
export function pollPrimed(run: SegmentRun, f: MusicFrame): boolean {
  if (run.state === "admitted") return true;
  if (run.state !== "priming" || !f.music) return false;
  const job = run.prime;
  const st = f.music.primedState(run.group);
  if (!st || !job) return false;
  job.primed = st.primed;
  if (!st.ready) return false;
  for (const s of run.stems) s.primed = true;
  if (Number.isNaN(job.readyMs)) {
    job.readyMs = performance.now();
    run.player.counters.primeLastMs = job.readyMs - job.postedMs;
  }
  return true;
}

/** P1: stamp the primed group at `at` (heard seconds), with first in-voice fades if any; the members' voices are kept. */
export function stampRun(player: MusicPlayer, run: SegmentRun, at: number, f: MusicFrame, fades?: MusicGroupStamp["fades"]): void {
  void player;
  const music = f.music;
  if (!music || (run.state !== "priming" && run.state !== "admitted")) return;
  const stamp: MusicGroupStamp = fades && fades.length > 0 ? { group: run.group, at, fades } : { group: run.group, at };
  const voices = music.stampGroup(stamp);
  for (let k = 0; k < run.stems.length; k++) run.stems[k]!.voice = voices[k] ?? null;
  run.startAt = at;
  run.state = "stamped";
  run.prime = null;
}

/** P1: cancel the run's group (closes its rings, STOPs members already stamped); unknown or 0 groups are ignored. */
export function cancelRun(run: SegmentRun, f: MusicFrame): void {
  if (run.state === "cancelled") return;
  const owned = run.group > 0 && live.get(run.group) === run;
  if (owned) f.music?.cancelGroup(run.group);
  release(run);
  for (const s of run.stems) s.voice = null;
  run.state = "cancelled";
  run.prime = null;
}

/**
 * P1: stop every stem of the player with one in-voice fade stamped at now plus the lookahead (`handle.stop(fade)`,
 * §1.2: not grid-quantised, allowed in rhythm mode; R19: no music record is asap).
 */
export function stopPlayerRuns(player: MusicPlayer, fadeSeconds: number, f: MusicFrame): void {
  const at = Math.max(f.now, f.backend.horizon?.() ?? f.now);
  const seconds = Math.max(0, fadeSeconds);
  for (const run of [player.run, player.next]) {
    if (!run || run.state === "cancelled" || run.state === "ending") continue;
    if (run.state === "new" || run.state === "admitted" || run.state === "priming") {
      cancelRun(run, f);
      continue;
    }
    for (const s of run.stems) {
      const v = s.voice;
      if (!v) continue;
      if (v.fadeShaped) v.fadeShaped({ to: 0, seconds, law: "equalPowerOut", at, stopAtEnd: true });
      else v.stop(seconds);
    }
    run.state = "ending";
  }
}

/** What the router reads of the core backend's clock map (absent on other backends). */
interface EventClock {
  readonly sampleRate?: number;
  readonly timeOffset?: number;
  readonly carryPending?: boolean;
}

/** The core backend's clock map (a rebuild may change its rate), or null. */
function eventClock(): EventClock | null {
  try {
    return (audioBackend() as unknown as { clockMap?: EventClock }).clockMap ?? null;
  } catch {
    return null;
  }
}

/**
 * P1, P3: the backend's group and member events (`MusicBackend.onGroupEvent`), delivered after the status mirror is
 * read. `musicSystem.ts` binds this once per backend. A `start`, `resume` or `abandon` goes to P3's `applySlip` first
 * (the anchor's heard time moves by the slip, architecture §3.6; the counters count it). `sampleRate` is the context
 * rate of the event's frames (default: the core backend's clock map, else 48 kHz); with the clock map a `start` also
 * pins the anchor to its start frame's heard time (t0 = f0 / sr, §4.5).
 */
export function routeGroupEvent(e: MusicGroupEvent, sampleRate?: number): void {
  const run = live.get(e.group);
  if (!run) return;
  switch (e.kind) {
    case "start":
    case "resume": {
      const clock = sampleRate === undefined ? eventClock() : null;
      const sr = sampleRate ?? (clock?.sampleRate && clock.sampleRate > 0 ? clock.sampleRate : 48_000);
      const heard = e.kind === "start" && clock && !clock.carryPending && Number.isFinite(clock.timeOffset)
        ? e.startFrame / sr + clock.timeOffset!
        : undefined;
      applySlip(run.player, e, sr, heard);
      if (run.state === "stamped") run.state = "playing";
      return;
    }
    case "abandon":
      applySlip(run.player, e, 0);
      // The core ended every member; the planner re-plans (§8).
      for (const s of run.stems) s.voice = null;
      release(run);
      run.state = "cancelled";
      return;
    case "end":
    case "refused":
    case "error": {
      const s = run.stems[e.member];
      if (s) s.voice = null;
      if (run.stems.every((x) => x.voice === null) && (run.state === "playing" || run.state === "ending" || run.state === "stamped")) {
        release(run);
        run.state = "ending";
      }
      return;
    }
    case "starve":
      return; // P3 counts holds from the group's own resume report (`applySlip`)
  }
}

/** @internal Tests: forget every live run and group id, reset the id counter to 1 and the clip source to the default. */
export function _resetSegmentRuns(): void {
  clipSource = DEFAULT_CLIP_SOURCE;
  live.clear();
  counter = 1;
}
