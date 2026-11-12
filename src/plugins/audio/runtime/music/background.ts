/**
 * Music across a hidden tab, a context rebuild and a worker crash (ADR 0166 api-and-models §10 P9; architecture §2.1
 * "Recovering", §3.7, §3.8; ADR 0167 §3 owner decision 5: `play` and `mute` both commit a segment ahead).
 *
 * Owner: **P9** (W5); it also edits `core/recovery.ts` (and `core/background.ts`, `core/replay.ts` if the hand-off needs
 * them). Q2 wrote the skeleton; `core/musicOps.ts` `reopenGroups` (the hook `reopenStreams` calls) lands here.
 *
 * - **Hidden:** not a state; while hidden the players tick from the STATUS handler (`musicSystem.ts` `tickPlayer` with
 *   `hiddenFrame`), committing a segment ahead under both `play` and `mute`.
 * - **Rebuild, crash, rate change:** `Replayer.restore` hands music groups to the player, never to `reopenStreams`
 *   (C16): each group is re-primed at the heard position and stamped, as a group. A group the core gave up on (1 s)
 *   re-plans; the recovery limit stops the player.
 *
 * P9's model:
 * - **Hidden tick.** `core/background.ts` calls `noteHidden` on each visibility change and, under `play` and `mute`,
 *   `tickHidden` from every STATUS block while hidden (rAF has stopped, so no frame step runs). `tickHidden` advances the
 *   backend's clock and reads the music STATUS (`beginFrame`: outside a rAF the clock samples `performance.now()`, so
 *   Δ̄ becomes the STATUS interval, as §3.8 says), ticks every player in `tickPlayer`'s order with `frame.hidden` set,
 *   then flushes the batch (`frameCommit`), as `background.ts` flushes MASTER. Ê isn't sampled meanwhile (`musicOps`
 *   reads `mirror.freeEndedInMessage`). The planner's lead includes Δ̄, so a start due while hidden is primed and
 *   stamped a STATUS interval ahead, and the music is where it would have been on resume: under `mute` too (owner
 *   decision 5), whose only cost is MASTER at 0. Containers that commit a successor at a segment's start (P4's next
 *   item, R3a) read `frame.hidden` or `musicHidden()`. Stamps made while hidden count in `counters.recoveries.hidden`.
 * - **Recovery** (`recoverGroups`, from `musicOps.reopenGroups` after `musicOps` forgot the dead groups): per player,
 *   one take from its recovery limit (3 per sliding 60 s, `core/rateLimit.ts`, as the core's own rebuilds); past it the
 *   player stops with one warning (`recoveries.refused`). Otherwise the anchors are rebased for the context's rate
 *   (P3), the playing run, the successor and the plan are dropped (their ids released), and the playing segment is
 *   planned again (P2's `requestStart`, reason `recovery`) on the next bar of its own grid at or after now + lead, from
 *   the file position heard at that bar (`sameTime`: `ticksAt(anchor, T)` on the old anchor, loop passes unrolled), so
 *   every stem re-enters together where the music would be. The stamp makes the run the player's again and anchors it
 *   (`anchorRun`), which agrees with the old anchor within a frame. A player that hadn't stamped yet starts again.
 *   A re-entry past the segment's exit cue has nothing to play: the player ends.
 * - **Abandon** (`groupAbandoned`, from `musicOps` after the core's give-up reached the router): the playing group is
 *   recovered as above (cause `abandon`), at the next `recoverAbandoned`, which `musicOps` calls in the same step.
 */
import type { AudioBackend } from "../backend";
import { exitSeconds, nextGridSeconds, ticksToSeconds } from "../../../../engine/audio/musicGrid";
import { RateLimit, RECOVERY_LIMIT, RECOVERY_WINDOW_MS } from "../core/rateLimit";
import { hiddenFrame, musicPlayers, tickPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { anchorRun, playingGridOf, rebaseAnchors, ticksAt } from "./anchors";
import { cancelPlanned, requestStart, type PlanRequest } from "./planner";
import { cancelRun, routeGroupEvent } from "./segmentRun";

/** Why a player recovers (`counters.recoveries` keys; `hidden` counts the stamps made while hidden). */
export type MusicRecoveryCause = "rebuild" | "crash" | "rate" | "abandon";

/** Float noise allowed when comparing heard or file seconds. */
const EPS = 1e-9;

let hidden = false;

/** True while the page is hidden under `play` or `mute` and the players tick from STATUS (architecture §3.8). */
export function musicHidden(): boolean {
  return hidden;
}

/** P9: the page became hidden or visible (from the background controller). */
export function noteHidden(isHidden: boolean): void {
  hidden = isHidden;
}

/** P9: a STATUS block arrived while hidden: tick every player from the handler (architecture §3.8). */
export function tickHidden(backend: AudioBackend): void {
  const players = musicPlayers();
  if (!hidden || players.length === 0) return;
  // The clock (outside a rAF it samples performance.now(): Δ̄ becomes the STATUS interval) and this STATUS's music
  // sections; the group events reach the router here, as from step 0.
  const music = backend.music ?? null;
  if (music !== null && music.onGroupEvent === null) music.onGroupEvent = routeGroupEvent;
  backend.beginFrame?.();
  const f = hiddenFrame(backend);
  for (let k = 0; k < players.length; k++) {
    const p = players[k]!;
    const planned = p.planned;
    tickPlayer(p, f);
    if (planned !== null && p.planned !== planned && planned.run.state === "stamped") bump(p.counters.recoveries, "hidden");
    if (players[k] !== p) k--;
  }
  // No frame will flush it: the stamps go now (`background.ts` flushes MASTER the same way).
  (backend as { frameCommit?(): void }).frameCommit?.();
}

/**
 * P9: after a hard rebuild (or a new decoder worker), reopen every live music group as a group: re-prime at the heard
 * position and stamp. Called by `core/musicOps.ts` `reopenGroups`.
 */
export function recoverGroups(backend: AudioBackend, cause: "rebuild" | "crash" | "rate"): void {
  const f = frameOf(backend);
  for (const p of [...musicPlayers()]) recoverPlayer(p, f, cause);
}

/** Players whose playing group the core gave up on, waiting for `recoverAbandoned`. */
const abandoned = new Set<MusicPlayer>();

/** P9: the core gave up on a group (abandon after 1 s): re-plan, or stop at the recovery limit. */
export function groupAbandoned(player: MusicPlayer, group: number): void {
  if (player.run !== null && player.run.group === group) {
    abandoned.add(player);
    return;
  }
  // A successor the core gave up on: the router cancelled it; the container that asked for it asks again (R3a, P4).
  if (player.next !== null && player.next.group === group && player.next.state === "cancelled") player.next = null;
}

/** P9: recover the players `groupAbandoned` noted (`musicOps` calls it right after delivering the group events). */
export function recoverAbandoned(backend: AudioBackend): void {
  if (abandoned.size === 0) return;
  const f = frameOf(backend);
  const players = [...abandoned];
  abandoned.clear();
  for (const p of players) recoverPlayer(p, f, "abandon");
}

/** @internal Tests: forget the hidden flag, pending abandons and every player's recovery limit. */
export function _resetMusicBackground(): void {
  hidden = false;
  abandoned.clear();
  limits = new WeakMap();
}

// --- Internals -------------------------------------------------------------------------------------------------------

let limits = new WeakMap<MusicPlayer, RateLimit>();
const warned = new WeakSet<MusicPlayer>();

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function frameOf(backend: AudioBackend): MusicFrame {
  return { backend, music: backend.music ?? null, now: backend.time, dt: 0, hidden };
}

/** The context's rate (the core backend's clock map), or 0 when the backend doesn't say. */
function contextRate(backend: AudioBackend): number {
  const sr = (backend as { clockMap?: { sampleRate?: number } }).clockMap?.sampleRate;
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
  player.state = "stopping";
}

function dropRuns(player: MusicPlayer, f: MusicFrame): void {
  cancelPlanned(player, f);
  for (const run of [player.run, player.next]) if (run) cancelRun(run, f);
  player.next = null;
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
  player.next = null;
  if (!old || !anchor || anchor.segment !== old.node.id || !Number.isFinite(old.startAt)) {
    // Nothing stamped yet: the first start runs again from `starting` (step 9's planner).
    if (old) cancelRun(old, f);
    player.run = null;
    player.anchor = null;
    player.state = "starting";
    return true;
  }
  cancelRun(old, f);
  player.state = "recovering";
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
    onStamped: (p) => {
      player.run = p.run;
      if (player.next === p.run) player.next = null;
      player.anchor = anchorRun(p.run, p.at);
      player.state = "committed";
    },
    onDropped: () => {
      // Past the exit cue (the segment ended in the gap) or refused for good: nothing re-enters; the player ends.
      if (player.state === "recovering") player.state = "stopping";
    },
  };
  requestStart(player, req, f);
  return true;
}
