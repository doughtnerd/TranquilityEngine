/**
 * Playlists (ADR 0166 api-and-models §2.3 `playlist`, §2.4 natural advance, §3.2 cursors and shuffle bags;
 * architecture §2.1).
 *
 * Owner: **P4** (W5), with the pure order in `playlistOrder.ts` (leaf L-P4a). Q2 wrote the skeleton.
 *
 * Sequence, random, shuffle, `avoidRepeat`, `plays`, `rounds`, nesting; the natural advance at the exit cue; the next
 * item is always primed ahead (a long run never shows an unprimed start).
 *
 * **Model.** A playlist has one cursor per nested playlist (the root's first), each an order over its children. The
 * next leaf segment is found by running the cursors on a *copy* (`computeNext`), so `peekNext` never moves anything and
 * an advance simply adopts the copy: the peek and the advance cannot disagree. A nested playlist starts a fresh cursor,
 * seeded from its parent's seed and visit count, every time it is entered (so `plays` replays it from the top).
 *
 * **Priming ahead.** The moment an item is the playing run (its stamp is the first start's, or its promotion) the next
 * item is asked of the planner (`requestStart` with `grid: "exitCue"`): it is admitted and primed at once, a whole item
 * ahead, and stamps at the playing segment's exit cue (R1's `exitTime` for a natural advance; with counted loop regions
 * the exit is after the last predicted wrap, P3's `predictWrap`). The planner stamps it only when primed (its own
 * deadline and re-plans), so a start is never unprimed.
 *
 * **Promotion.** A stamped successor becomes the player's run when its start is heard (`anchorRun(next, next.startAt)`,
 * P3). The old run's voices ring on until they end, ramp-free (§2.4).
 *
 * P4's readings: a `musicSwitch` inside a playlist plays its default child (the switch isn't ticked below the root); a
 * leaf without a playable track is skipped; a successor the planner drops (the exit is inside the lead) is skipped, the
 * next item asked instead; with nothing planned and the playing run ended, the next item starts as soon as the lead
 * allows (`grid: "immediate"`). The rule's fades and bridge are not applied to a natural advance yet (R3a's plumbing).
 */
import { ticksToSeconds } from "../../../../engine/audio/musicGrid";
import type { PlaylistNode } from "../../../../engine/audio/musicFormat";
import { playingGridOf, predictWrap, anchorRun, heardTimeOf, ticksAt } from "./anchors";
import { segmentGrid } from "./handle";
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import { childFor, createSwitchState } from "./musicSwitch";
import { requestStart, type PlanRequest } from "./planner";
import { createOrder, nextIndex, type PlaylistOrder } from "./playlistOrder";
import { segmentClipSource, type SegmentRun } from "./segmentRun";
import { enterFrame, enterPoint, findRule } from "./transitionRules";

/** One playlist container's cursor (nesting keeps one per playlist node). P4 may add fields here. */
export interface PlaylistCursor {
  readonly node: MusicNodeRef;
  readonly order: PlaylistOrder;
  /** Index of the playing item in the node's item list, -1 before the first. */
  item: number;
  /** Plays of the playing item so far (its `plays` count). */
  plays: number;
  /** Rounds completed. */
  rounds: number;
  /** P4: the seed of this cursor's order. */
  readonly seed: number;
  /** P4: nested playlists entered from this cursor (their seeds follow it). */
  entered: number;
}

/** What the cursors would be, and the leaf they land on, after one advance (null leaf: the list has ended). */
interface Advance {
  readonly cursors: PlaylistCursor[];
  readonly leaf: MusicNodeRef | null;
}

/** The successor asked of the planner: adopted when it plays (or is skipped when it can't). */
interface Request {
  readonly advance: Advance;
  /** The `PlanRequest` handed to the planner (identity tells whether `player.planned` is still ours). */
  readonly request: PlanRequest;
  /** Set when the planner stamped it. */
  run: SegmentRun | null;
}

/** A player's playlist state: the cursors from the root playlist down. P4 may add fields here. */
export interface PlaylistState {
  readonly cursors: PlaylistCursor[];
  /** P4: the leaf last committed (playing, or entered through `enterPlaylist`); null before the first. */
  current: MusicNodeRef | null;
  /** P4: the run of `current` once it is the player's run. */
  currentRun: SegmentRun | null;
  /** P4: the cached next advance (cleared by every commit). */
  peek: Advance | null;
  /** P4: the successor in flight. */
  req: Request | null;
  /** P4: the run whose natural successor was too late to plan (its exit was inside the lead). */
  lateFor: SegmentRun | null;
  /** P4: `f.now` of the last tick (the exit prediction runs inside the planner's callback). */
  now: number;
  /** P4: items started (debug and tests). */
  advances: number;
}

/** Guard for skipping unplayable leaves and ended nested playlists in one advance. */
const MAX_STEPS = 4096;
/** Most loop wraps looked through when predicting the exit of a looping segment (a `count` is 1..64). */
const MAX_WRAPS = 70;
/** Seconds past a wrap at which the position is read. */
const WRAP_PROBE = 1e-4;
const EPS = 1e-7;

const playlistOf = (node: MusicNodeRef): PlaylistNode | null => (node.type === "playlist" ? (node as unknown as PlaylistNode) : null);

const playable = (node: MusicNodeRef): boolean => {
  const tracks = (node as unknown as { tracks?: { clip?: string }[] }).tracks;
  return Array.isArray(tracks) && tracks.some((t) => !!t.clip);
};

const mix = (a: number, b: number): number => (Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) + Math.imul(b + 1, 0x27d4eb2d)) >>> 0;

function makeCursor(node: PlaylistNode, seed: number): PlaylistCursor {
  const order = createOrder(
    node.children.map((c) => ({ weight: c.weight, plays: c.plays })),
    { mode: node.mode, avoidRepeat: node.avoidRepeat, rounds: node.rounds, seed },
  );
  return { node, order, item: -1, plays: 0, rounds: 0, seed, entered: 0 };
}

/** P4: the playlist state for a root (or nested) playlist node, seeded per instance; null when `node` isn't a playlist. */
export function createPlaylistState(node: MusicNodeRef, seed: number): PlaylistState | null {
  const pl = playlistOf(node);
  if (!pl) return null;
  return { cursors: [makeCursor(pl, seed >>> 0)], current: null, currentRun: null, peek: null, req: null, lateFor: null, now: 0, advances: 0 };
}

const cloneCursor = (c: PlaylistCursor): PlaylistCursor => ({ ...c, order: structuredClone(c.order) });

/** A switch inside a playlist plays its default child (the switch isn't ticked below the root). */
function switchChild(node: MusicNodeRef): MusicNodeRef | null {
  const st = createSwitchState(node);
  const id = st ? childFor(st, undefined) : null;
  return (node as unknown as { children: MusicNodeRef[] }).children.find((c) => c.id === id) ?? null;
}

/** Run the cursors one item on a copy: the next playable leaf (descending into nested playlists), or null at the end. */
function computeNext(state: PlaylistState): Advance {
  const cursors = state.cursors.map(cloneCursor);
  for (let steps = 0; cursors.length > 0 && steps < MAX_STEPS; steps++) {
    const cur = cursors[cursors.length - 1]!;
    const idx = nextIndex(cur.order);
    if (idx < 0) {
      cursors.pop(); // a nested playlist ended: its parent advances; the root ended: the list is over
      continue;
    }
    cur.item = idx;
    cur.plays = cur.order.playsLeft;
    cur.rounds = cur.order.round;
    let child: MusicNodeRef | null = (cur.node as unknown as PlaylistNode).children[idx] ?? null;
    if (child && child.type === "musicSwitch") child = switchChild(child);
    if (!child) continue;
    const nested = playlistOf(child);
    if (nested) {
      cursors.push(makeCursor(nested, mix(cur.seed, cur.entered++)));
      continue;
    }
    if (child.type === "segment" && playable(child)) return { cursors, leaf: child };
  }
  return { cursors: [], leaf: null };
}

/** The cached advance from the committed state. */
function advanceOf(state: PlaylistState): Advance {
  return (state.peek ??= computeNext(state));
}

/** P4: the item after the playing one (descending into nested containers), or null at the end of the last round. */
export function peekNext(state: PlaylistState): MusicNodeRef | null {
  return advanceOf(state).leaf;
}

/** Make `advance` the committed state: its leaf is now (or was, when skipped) the current item. */
function commit(state: PlaylistState, advance: Advance, run: SegmentRun | null): void {
  state.cursors.splice(0, state.cursors.length, ...advance.cursors);
  state.current = advance.leaf;
  state.currentRun = run;
  state.peek = null;
  state.advances++;
}

/**
 * P4, the descent: the first leaf segment of `node` for a switch's playlist child (P7's `startSwitchRoot`, R3a's
 * `requestTransition`). A segment is returned as it is (null when it has no playable track). A playlist gets a fresh
 * state whose first item is chosen now; it becomes `player.playlist` when that leaf is the player's run (a later
 * tick), so a refused or replaced change leaves the playing playlist alone. Null: nothing playable.
 */
export function enterPlaylist(player: MusicPlayer, node: MusicNodeRef): MusicNodeRef | null {
  if (node.type === "segment") return playable(node) ? node : null;
  const st = createPlaylistState(node, mix(player.instance.group, hashId(node.id)));
  if (!st) return null;
  const first = computeNext(st);
  if (!first.leaf) return null;
  commit(st, first, null);
  candidates.set(player, st);
  return first.leaf;
}

const candidates = new WeakMap<MusicPlayer, PlaylistState>();

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

// --- The exit and the request ---------------------------------------------------------------------------------------

/**
 * Heard seconds of the playing segment's exit cue (its end by default), through the loop passes still to come: after
 * the last predicted wrap the position is read back from the anchor. NaN when unknown (no grid, a forever loop).
 */
function naturalExit(player: MusicPlayer, now: number): number {
  const a = player.anchor;
  const run = player.run;
  if (!a || !run || a.segment !== run.node.id) return Number.NaN;
  const pg = playingGridOf(a);
  if (!pg || !Number.isFinite(pg.grid.exitTicks)) return Number.NaN;
  let last = Number.NaN;
  let t = Math.max(now, a.time);
  let n = 0;
  for (; n < MAX_WRAPS; n++) {
    const w = predictWrap(player, t);
    if (!Number.isFinite(w)) break;
    last = w;
    t = w + WRAP_PROBE;
  }
  if (n === MAX_WRAPS) return Number.NaN;
  if (!Number.isFinite(last)) return heardTimeOf(a, pg.grid.exitTicks);
  const pos = ticksAt(a, last + WRAP_PROBE);
  return last + WRAP_PROBE + ticksToSeconds(pg.grid, pg.grid.exitTicks) - ticksToSeconds(pg.grid, pos);
}

function clipRate(node: MusicNodeRef): number {
  const tracks = (node as unknown as { tracks?: { clip?: string }[] }).tracks ?? [];
  for (const t of tracks) {
    const facts = t.clip ? segmentClipSource().facts(t.clip) : undefined;
    if (facts && facts.rate > 0) return facts.rate;
  }
  return 48_000;
}

/** Ask the planner for the next leaf: at the playing segment's exit cue, or as soon as possible when nothing plays. */
function request(player: MusicPlayer, state: PlaylistState, f: MusicFrame, natural: boolean): boolean {
  const advance = advanceOf(state);
  const leaf = advance.leaf;
  if (!leaf) return false;
  const toGrid = segmentGrid(leaf);
  let startFrame = 0;
  let preEntry = toGrid ? Math.max(0, ticksToSeconds(toGrid, toGrid.entryTicks)) : 0;
  let points: PlanRequest["points"];
  if (natural) {
    const a = player.anchor;
    const run = player.run;
    const playing = a && run && a.segment === run.node.id ? playingGridOf(a) : null;
    if (!playing || !run || !Number.isFinite(naturalExit(player, f.now))) return false; // no grid yet, or a forever loop
    const match = findRule(player.root, run.node.id, leaf.id);
    if (toGrid) {
      const from = { grid: playing.grid, ticks: playing.grid.exitTicks };
      startFrame = enterFrame(match, toGrid, from, clipRate(leaf));
      preEntry = enterPoint(match, toGrid, from).preEntry;
    }
    points = () => naturalExit(player, state.now); // re-asked at every re-plan
  }
  const req: Request = { advance, request: null as unknown as PlanRequest, run: null };
  const planRequest: PlanRequest = {
    to: leaf,
    reason: player.run === null ? "start" : "playlist",
    grid: natural ? "exitCue" : "immediate",
    notBefore: Number.NaN,
    startFrame,
    preEntry,
    ...(points ? { points } : {}),
    onStamped: (planned) => {
      req.run = planned.run;
    },
    onDropped: (_planned, cause) => {
      if (state.req !== req) return;
      state.req = null;
      if (natural && cause === "noPoint") {
        state.lateFor = player.run; // the exit is inside the lead: no retry (it would only skip items); start it in the gap
        return;
      }
      commit(state, req.advance, state.currentRun); // the music plays on; this item is skipped (a first start's refusal leaves `refused`)
    },
  };
  (req as { request: PlanRequest }).request = planRequest;
  state.req = req;
  requestStart(player, planRequest, f);
  return true;
}

// --- The tick -------------------------------------------------------------------------------------------------------

/** True when the run ended (its voices are gone) or was cancelled. */
const finished = (run: SegmentRun): boolean => run.state === "ending" || run.state === "cancelled";

/** P4, step 9: keep the next item primed; at the playing segment's exit cue, advance the cursor (natural advance). */
export function tickPlaylist(player: MusicPlayer, f: MusicFrame): void {
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return;
  // A playlist entered through a switch becomes ours when its first leaf plays.
  const cand = candidates.get(player);
  if (cand && player.run && player.run.node === cand.current && cand.currentRun === null) {
    cand.currentRun = player.run;
    player.playlist = cand;
    candidates.delete(player);
  }
  const state = player.playlist;
  if (!state) return;
  state.now = f.now;

  const req = state.req;
  if (req) {
    if (req.run === null && player.planned?.request !== req.request) {
      state.req = null; // replaced or cancelled by someone else (a switch's change): nothing of ours is in flight
    } else if (req.run !== null) {
      if (req.run.state === "cancelled") {
        state.req = null;
        commit(state, req.advance, state.currentRun); // abandoned by the core: skip the item
      } else if (player.run === req.run) {
        state.req = null; // the first start: the planner made it the run
        commit(state, req.advance, req.run);
      } else if (f.now + EPS >= req.run.startAt) {
        // Promotion: the stamped successor is heard.
        const next = req.run;
        player.run = next;
        if (player.next === next) player.next = null;
        player.anchor = anchorRun(next, next.startAt);
        player.regions = null; // the new segment's regions start fresh (R4b)
        state.req = null;
        commit(state, req.advance, next);
      }
    }
  }
  if (state.req) return;

  const run = player.run;
  if (run === null) {
    // The root's first item (the descent): the planner starts it like a first segment.
    if (player.state === "starting" && !player.planned && state.current === null) request(player, state, f, false);
    return;
  }
  if (state.currentRun === null || state.currentRun !== run) return; // not our run (a switch moved on)
  if (player.planned || player.next || player.transition) return; // a change of someone else's is in flight
  if (finished(run)) {
    state.lateFor = null;
    request(player, state, f, false); // gap: nothing sounds, start the next item as soon as the lead allows
    return;
  }
  if (state.lateFor === run) return;
  if (run.state === "stamped" || run.state === "playing") request(player, state, f, true);
}
