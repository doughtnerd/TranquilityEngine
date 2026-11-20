/**
 * Music across a hidden tab, a context rebuild and a worker crash (ADR 0166 api-and-models §10 P9; architecture §2.1
 * "Recovering", §3.7, §3.8; ADR 0167 §3 owner decision 5: `play` and `mute` both commit a segment ahead).
 *
 * ADR 0248: the music seam is one-way. Backends report what happened through the two sinks of their `MusicBackend`
 * (`onGroupEvent`, `onLifecycle`); this module is bound to them (`bindMusicBackend`, on every backend the selector installs
 * and from the early step) and alone decides what to re-plan. Nothing below the seam imports it.
 *
 * - **Hidden:** not a state; while hidden the players tick from the STATUS handler (`musicSystem.ts` `tickPlayer` with
 *   `hiddenFrame`), committing a segment ahead under both `play` and `mute`.
 * - **Rebuild, crash, rate change:** `Replayer.restore` hands music groups to the player, never to `reopenStreams`
 *   (C16): each group is re-primed at the heard position and stamped, as a group. A group the core gave up on (1 s)
 *   re-plans; the recovery limit stops the player.
 *
 * P9's model:
 * - **Hidden tick.** The core's background controller reports `hidden` on each visibility change under `play` and `mute`
 *   and `hiddenTick` for every STATUS block while hidden (rAF has stopped, so no frame step runs), then flushes the batch.
 *   A tick advances the backend's clock and reads the music STATUS (`beginFrame`: outside a rAF the clock samples
 *   `performance.now()`, so Δ̄ becomes the STATUS interval, as §3.8 says) and ticks every player in `tickPlayer`'s order
 *   with `frame.hidden` set. Ê isn't sampled meanwhile (`musicOps` reads `mirror.freeEndedInMessage`). The planner's
 *   lead includes Δ̄, so a start due while hidden is primed and stamped a STATUS interval ahead, and the music is where it
 *   would have been on resume: under `mute` too (owner decision 5), whose only cost is MASTER at 0. Containers that
 *   commit a successor at a segment's start (P4's next item, R3a) read `frame.hidden`. Stamps made while hidden count in
 *   `counters.recoveries.hidden`.
 * - **Recovery** (the lifecycle event `recover`, which `musicOps` reports after it forgot the dead groups): per player,
 *   one take from its recovery limit (3 per sliding 60 s, `core/rateLimit.ts`, as the core's own rebuilds); past it the
 *   player stops with one warning (`recoveries.refused`). Otherwise the anchors are rebased for the context's rate
 *   (P3), the playing run, the successor and the plan are dropped (their ids released), and the playing segment is
 *   planned again (P2's `requestStart`, reason `recovery`) on the next bar of its own grid at or after now + lead, from
 *   the file position heard at that bar (`sameTime`: `ticksAt(anchor, T)` on the old anchor, loop passes unrolled), so
 *   every stem re-enters together where the music would be. The stamp makes the run the player's again and anchors it
 *   (`anchorRun`), which agrees with the old anchor within a frame. A player that hadn't stamped yet starts again.
 *   A re-entry past the segment's exit cue has nothing to play: the player ends.
 * - **Abandon** (the group event `abandon`): the player is looked up before the router releases the run, the event is
 *   routed, and the playing group is recovered as above (cause `abandon`) at once. A successor the core gave up on is
 *   only dropped; the container that asked for it asks again.
 * - **Held callbacks** (Rh1, architecture §3.7, §4.6): in rhythm mode a player's beat clock is held (`beats.held`) from
 *   a recovery's start until its group is stamped: from the backend's `rebuild` event (active) for every player with a
 *   run, through the re-plan (`state` `recovering`), to the stamp. Nothing fires meanwhile; on release the beat clock
 *   delivers the gap as one coalesced call per kind (`missed`), at the re-entry. `updateBeatHolds` sets the flag each
 *   early step (and each hidden tick), before the dispatch. Outside rhythm mode nothing is held.
 */
import type { MusicBackend, MusicGroupEvent, MusicLifecycleEvent } from "../backend";
import { rhythmModeSetting } from "./calibration";
import { exitSeconds, nextGridSeconds, ticksToSeconds } from "../../../../engine/audio/musicGrid";
import { RateLimit, RECOVERY_LIMIT, RECOVERY_WINDOW_MS } from "../core/rateLimit";
import { hiddenFrame, musicPlayers, tickPlayer, type MusicFrame, type MusicHost, type MusicPlayer } from "./musicSystem";
import { playingGridOf, rebaseAnchors, ticksAt } from "./anchors";
import { beginRecovery, cancelSuccessor, commitStart, restartFirst, stopPlayer } from "./musicPlayer";
import { cancelPlanned, requestStart, type PlanRequest } from "./planner";
import { cancelRun, liveRun, routeGroupEvent } from "./segmentRun";

/** Why a player recovers (`counters.recoveries` keys; `hidden` counts the stamps made while hidden). */
export type MusicRecoveryCause = "rebuild" | "crash" | "rate" | "abandon";

/** A backend as the music side binds it: what music reads, and its music operations. */
export type MusicBoundBackend = MusicHost & { readonly music?: MusicBackend };

/** Float noise allowed when comparing heard or file seconds. */
const EPS = 1e-9;

/** The page is hidden and music keeps ticking (the backend's `hidden` event). */
let hidden = false;
/** A hard rebuild runs (the backend's `rebuild` event). */
let rebuilding = false;
/** The backend each music backend was bound for (`bindMusicBackend` is idempotent per pair). */
const boundTo = new WeakMap<MusicBackend, MusicBoundBackend>();

/**
 * ADR 0248: bind the music side to `backend`'s music sinks (nothing without `music`). Group events go to the router (an
 * abandon re-plans its player); lifecycle events to the policy above. A newly bound backend starts visible and not
 * rebuilding. Called for every backend the selector installs, and by the early step for one set some other way.
 */
export function bindMusicBackend(backend: MusicBoundBackend): void {
  const music = backend.music;
  if (!music || boundTo.get(music) === backend) return;
  boundTo.set(music, backend);
  hidden = false;
  rebuilding = false;
  music.onGroupEvent = (e) => groupEvent(backend, e);
  music.onLifecycle = (e) => lifecycleEvent(backend, e);
}

function groupEvent(backend: MusicBoundBackend, e: MusicGroupEvent): void {
  if (e.kind !== "abandon") {
    routeGroupEvent(e);
    return;
  }
  // The player whose group the core gave up on, looked up before the router releases the run.
  const player = liveRun(e.group)?.player ?? null;
  routeGroupEvent(e);
  if (player) groupAbandoned(player, e.group, backend);
}

function lifecycleEvent(backend: MusicBoundBackend, e: MusicLifecycleEvent): void {
  switch (e.kind) {
    case "rebuild":
      rebuilding = e.active;
      if (e.active) for (const p of musicPlayers()) if (p.run !== null) awaitingRecovery.add(p);
      return;
    case "recover":
      recoverGroups(backend, e.cause);
      return;
    case "hidden":
      hidden = e.hidden;
      return;
    case "hiddenTick":
      tickHidden(backend);
      return;
  }
}

/** P9: a STATUS block arrived while hidden: tick every player from the handler (architecture §3.8). */
function tickHidden(backend: MusicBoundBackend): void {
  const players = musicPlayers();
  if (!hidden || players.length === 0) return;
  // The clock (outside a rAF it samples performance.now(): Δ̄ becomes the STATUS interval) and this STATUS's music
  // sections; the group events reach the router here, as from step 0.
  backend.clock?.beginFrame();
  const music = backend.music ?? null;
  updateBeatHolds(music);
  const f = hiddenFrame(backend, music);
  for (let k = 0; k < players.length; k++) {
    const p = players[k]!;
    const planned = p.planned;
    const state = p.state;
    tickPlayer(p, f);
    // A stamp in this tick: the plan it had, or a first start (or re-entry) planned and stamped at once (decoded).
    const stamped = planned !== null ? p.planned !== planned && planned.run.state === "stamped" : state !== "committed" && p.state === "committed";
    if (stamped) bump(p.counters.recoveries, "hidden");
    if (players[k] !== p) k--;
  }
  // No frame will flush the stamps: the backend flushes them once this event returns.
}

/** P9: every live group died with its core (a rebuild, a new decoder worker, a new rate): re-plan each player. */
function recoverGroups(backend: MusicBoundBackend, cause: "rebuild" | "crash" | "rate"): void {
  const f = frameOf(backend);
  for (const p of [...musicPlayers()]) {
    // From here its own state (`recovering` until the stamp) holds its callbacks in rhythm mode.
    awaitingRecovery.delete(p);
    recoverPlayer(p, f, cause);
  }
}

/** Players that had a run when a rebuild started and haven't been re-planned (`recoverGroups`) yet. */
const awaitingRecovery = new WeakSet<MusicPlayer>();

/**
 * Rh1 (architecture §3.7, §4.6): sets each player's `beats.held` for this frame. In rhythm mode (`audio.rhythmMode` on
 * a backend whose `caps.rhythm` is true), a player is held while the backend rebuilds (its `rebuild` event), until the
 * recovery re-plans it, and while its re-entry is unstamped (`state` `recovering`, also after an abandon or a crash).
 * Otherwise nothing is held, and a hold left over from a recovery is released. Call it after the backend's `beginFrame`
 * (the group events) and before the dispatch: the music system's early step and the hidden tick. Allocates nothing.
 */
export function updateBeatHolds(music: MusicBackend | null): void {
  const players = musicPlayers();
  if (players.length === 0) return;
  const rhythm = music?.caps.rhythm === true && rhythmModeSetting();
  for (let k = 0; k < players.length; k++) {
    const p = players[k]!;
    if (rebuilding && p.run !== null) awaitingRecovery.add(p);
    const st = p.beats;
    if (st) st.held = rhythm && (rebuilding || p.state === "recovering" || awaitingRecovery.has(p));
  }
}

/** P9: the core gave up on a group (abandon after 1 s): re-plan, or stop at the recovery limit. */
function groupAbandoned(player: MusicPlayer, group: number, backend: MusicBoundBackend): void {
  if (player.run !== null && player.run.group === group) {
    recoverPlayer(player, frameOf(backend), "abandon");
    return;
  }
  // A successor the core gave up on: the router cancelled it; the container that asked for it asks again (R3a, P4).
  if (player.next !== null && player.next.group === group && player.next.state === "cancelled") cancelSuccessor(player, player.next);
}

// --- Internals -------------------------------------------------------------------------------------------------------

const limits = new WeakMap<MusicPlayer, RateLimit>();
const warned = new WeakSet<MusicPlayer>();

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function frameOf(backend: MusicBoundBackend): MusicFrame {
  return { backend, music: backend.music ?? null, now: backend.time, dt: 0, hidden };
}

/** The context's rate (the core backend's clock map), or 0 when the backend doesn't say. */
function contextRate(backend: MusicHost): number {
  const sr = backend.clock?.frameMap()?.sampleRate;
  return sr !== undefined && sr > 0 ? sr : 0;
}

/** Past the recovery limit: every run goes, one warning, and the player ends once nothing sounds. */
function refuse(player: MusicPlayer, f: MusicFrame): void {
  bump(player.counters.recoveries, "refused");
  if (!warned.has(player)) {
    warned.add(player);
    console.warn(`[myco] Music "${player.instance.path}": more than ${RECOVERY_LIMIT} recoveries within ${RECOVERY_WINDOW_MS / 1000} s; the music stops.`);
  }
  dropRuns(player, f);
  stopPlayer(player);
}

function dropRuns(player: MusicPlayer, f: MusicFrame): void {
  cancelPlanned(player, f);
  for (const run of [player.run, player.next]) if (run) cancelRun(run, f);
  cancelSuccessor(player, null);
}

/** One player's recovery (see the header). False when nothing was planned (stopped, refused, or nothing to play). */
function recoverPlayer(player: MusicPlayer, f: MusicFrame, cause: MusicRecoveryCause): boolean {
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return false;
  let limit = limits.get(player);
  if (!limit) limits.set(player, (limit = new RateLimit(RECOVERY_LIMIT, RECOVERY_WINDOW_MS)));
  if (!limit.take()) {
    refuse(player, f);
    return false;
  }
  bump(player.counters.recoveries, cause);
  const rate = contextRate(f.backend);
  if (rate > 0) rebaseAnchors(player, rate);
  const old = player.run;
  const anchor = player.anchor;
  // The successor and any plan go with the dead groups (a cancel of a group musicOps already forgot does nothing).
  cancelPlanned(player, f);
  if (player.next && player.next !== old) cancelRun(player.next, f);
  cancelSuccessor(player, null);
  if (!old || !anchor || anchor.segment !== old.node.id || !Number.isFinite(old.startAt)) {
    // Nothing stamped yet: the first start runs again from `starting` (step 9's planner).
    if (old) cancelRun(old, f);
    restartFirst(player);
    return true;
  }
  cancelRun(old, f);
  beginRecovery(player);
  const grid = playingGridOf(anchor)?.grid ?? null;
  const fileRate = anchor.rate;
  /** File seconds heard at `t` on the old anchor (loop passes unrolled); without a grid, linear from the old stamp. */
  const fileAt = (t: number): number => {
    const k = grid ? ticksAt(anchor, t) : Number.NaN;
    return grid && Number.isFinite(k) ? ticksToSeconds(grid, k) : old.startFrame / fileRate + (t - old.startAt);
  };
  const exit = grid ? exitSeconds(grid) : null;
  /** The next bar at or after heard `nb` (heard seconds), NaN at or past the exit cue. */
  const points = (nb: number): number => {
    const s = fileAt(nb);
    if (!Number.isFinite(s)) return Number.NaN;
    const bar = grid ? nextGridSeconds(grid, s, "bar") : s;
    if (exit !== null && bar >= exit - EPS) return Number.NaN;
    return nb + (bar - s);
  };
  const startFrameAt = (t: number): number => Math.max(0, Math.round(fileAt(t) * fileRate));
  const req: PlanRequest = {
    to: old.node,
    reason: "recovery",
    grid: "bar",
    notBefore: Number.NaN,
    startFrame: startFrameAt(f.now),
    points,
    startFrameAt,
    onStamped: (p) => commitStart(player, p.run, p.at),
    onDropped: () => {
      // Past the exit cue (the segment ended in the gap) or refused for good: nothing re-enters; the player ends.
      if (player.state === "recovering") stopPlayer(player);
    },
  };
  requestStart(player, req, f);
  return true;
}
