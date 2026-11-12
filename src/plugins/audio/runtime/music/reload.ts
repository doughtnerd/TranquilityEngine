/**
 * Hot reload of a playing segment (ADR 0166 api-and-models §10 P8; architecture §3.10).
 *
 * Owner: **P8** (W5). Q2 wrote the skeleton.
 *
 * An edited stem or segment of a playing instance is re-primed and swapped at the next bar without a gap; the worker's
 * encoded cache entry for the edited file is invalidated first (`ReloadHost.invalidateClip`).
 *
 * - `noteAssetChanged(path)` (the editor's reload event, any asset): invalidates `path`, then marks each player whose
 *   playing segment uses it as a clip, or whose event asset it is. It does no planning.
 * - `applyReloads` (step 9, first in the tick) plans the swap for a marked player: the changed segment is planned with
 *   the planner (`requestStart`, grid `bar`, reason `reload`) as a successor of the same segment. The outgoing stems keep
 *   playing until the bar line, where each fades out over `RELOAD_FADE_MS` (a stamped shaped fade, stamped with the
 *   incoming group so both start at T); at T the incoming run becomes the player's run and its anchor is made from its
 *   (slip-corrected) start. The outgoing run is cancelled once its fade is over.
 * - Position: `sameTime` (the incoming starts at the file position the outgoing is at, so the music doesn't jump) when
 *   the tempo map is unchanged and the position is inside the new audio; otherwise the incoming enters at its entry
 *   cue (`entryCue`), its pre-entry heard before T as for a first start.
 * - An event asset that is gone, invalid or no longer holds the playing segment keeps the old version with one
 *   warning. An event change that leaves the playing segment as it was only swaps the player's root, so rules,
 *   playlists, switches and stingers apply to the next decision.
 * - A change that arrives while another change is planned waits until that plan has been stamped.
 */
import type { AudioVoice } from "../backend";
import { eventNodes, type AnyEventNode } from "../../../../engine/audio/eventFormat";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, entrySeconds, exitSeconds, ticksToSeconds, type SegmentGrid, type TempoMap } from "../../../../engine/audio/musicGrid";
import { advanceAnchor, anchorRun, ticksAt } from "./anchors";
import { musicPlayers, type MusicFrame, type MusicNodeRef, type MusicPlayer } from "./musicSystem";
import { lookaheadSeconds, requestStart, type PlannedStart } from "./planner";
import { cancelRun, segmentClipSource, type SegmentRun } from "./segmentRun";

/** The crossfade at the swap, milliseconds: the outgoing stems fade out from T (the seek's 5 ms, R25). */
export const RELOAD_FADE_MS = 5;

/** Seconds after the fade's end the outgoing run is cancelled (its voices have stopped; this frees the group). */
const RETIRE_SLACK_SECONDS = 0.1;
const EPS = 1e-7;

/** What the reload needs from the rest of the runtime (set once by whoever owns the asset events). */
export interface ReloadHost {
  /** Drop what is cached for the clip file `path` (the clip registry's decoded slot, the worker's encoded bytes). */
  invalidateClip(path: string): void;
  /** The event asset's current music root, or null when the asset is missing or isn't a music event. */
  eventRoot(path: string): MusicNodeRef | null;
}

let host: ReloadHost | null = null;

/** Set (or clear) the host. Without one, `noteAssetChanged` still marks players on clip changes; event changes are ignored. */
export function setReloadHost(next: ReloadHost | null): void {
  host = next;
}

/** An outgoing run waiting for its fade to end. */
interface Retiring {
  readonly run: SegmentRun;
  /** Heard seconds at which the run is cancelled. */
  readonly until: number;
  /** Voices of a backend with no stamped fades: faded when T comes within the lookahead. */
  deferred: AudioVoice[] | null;
  /** Heard seconds the deferred voices fade at. */
  readonly fadeAt: number;
}

interface ReloadState {
  /** Changed clip paths not yet planned. */
  readonly clips: Set<string>;
  /** The event asset changed and is not yet re-read. */
  event: boolean;
  /** The plan made for the swap, until it is stamped. */
  planned: PlannedStart | null;
  /** Stamped, not yet at T: the incoming run that takes over. */
  swap: { run: SegmentRun; at: number; point: number } | null;
  readonly retiring: Retiring[];
  readonly warned: Set<string>;
}

const states = new WeakMap<MusicPlayer, ReloadState>();

function stateOf(player: MusicPlayer): ReloadState {
  let st = states.get(player);
  if (!st) states.set(player, (st = { clips: new Set(), event: false, planned: null, swap: null, retiring: [], warned: new Set() }));
  return st;
}

function warn(player: MusicPlayer, st: ReloadState, cause: string, message: string): void {
  if (st.warned.has(cause)) return;
  st.warned.add(cause);
  console.warn(`[myco] Music "${player.instance.path}": ${message}`);
}

function usesClip(run: SegmentRun | null, path: string): boolean {
  if (!run || run.state === "cancelled" || run.state === "ending") return false;
  for (const s of run.stems) if (s.clip === path) return true;
  return false;
}

/** P8: an asset changed on disk (the editor's reload event): marks the players that use `path` for a swap. */
export function noteAssetChanged(path: string): void {
  host?.invalidateClip(path);
  for (const player of musicPlayers()) {
    if (player.instance.path === path) {
      stateOf(player).event = true;
    } else if (usesClip(player.run, path)) {
      stateOf(player).clips.add(path);
    }
  }
}

// --- Tempo maps and positions --------------------------------------------------------------------------------------------

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>, n: number): boolean {
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** The two maps put every bar and beat at the same file time. */
function sameTempoMap(a: TempoMap, b: TempoMap): boolean {
  return a.count === b.count && a.gridOffset === b.gridOffset &&
    sameArray(a.startTick, b.startTick, a.count) && sameArray(a.bpm, b.bpm, a.count) &&
    sameArray(a.beatsPerBar, b.beatsPerBar, a.count) && sameArray(a.beatUnit, b.beatUnit, a.count);
}

function gridOfNode(node: MusicNodeRef): { grid: SegmentGrid; rate: number } | null {
  const seg = node as Partial<SegmentNode>;
  if (node.type !== "segment" || !Array.isArray(seg.tempo)) return null;
  const clip = seg.tracks?.find((t) => t.clip)?.clip;
  const facts = clip ? segmentClipSource().facts(clip) : undefined;
  const known = facts && facts.rate > 0 ? facts : undefined;
  const grid = compileSegmentGrid({ ...seg, cues: seg.cues ?? [] } as SegmentNode, known ? { endSeconds: known.frames / known.rate } : {});
  return { grid, rate: known?.rate ?? 48_000 };
}

/** A segment node by id in an event's music tree (children and library), or null. */
function findNode(root: MusicNodeRef, id: string): MusicNodeRef | null {
  for (const n of eventNodes(root as unknown as AnyEventNode)) {
    const ref = n as unknown as MusicNodeRef;
    if (ref.id === id && ref.type === "segment") return ref;
  }
  return null;
}

// --- Planning ----------------------------------------------------------------------------------------------------------

/** Fade out the outgoing run's stems from `at`: stamped where the voice can, else deferred to the lookahead. */
function fadeOutgoing(run: SegmentRun, at: number, seconds: number): AudioVoice[] | null {
  let deferred: AudioVoice[] | null = null;
  for (const s of run.stems) {
    const v = s.voice;
    if (!v) continue;
    if (v.fadeShaped) v.fadeShaped({ to: 0, seconds, law: "equalPowerOut", at, stopAtEnd: true });
    else (deferred ??= []).push(v);
  }
  return deferred;
}

/** Plan the swap of the playing segment for `node` at the next bar. False when nothing could be planned yet. */
function planSwap(player: MusicPlayer, st: ReloadState, node: MusicNodeRef, f: MusicFrame): boolean {
  const old = player.run;
  const anchor = player.anchor;
  if (!old || !anchor) return false;
  advanceAnchor(player, f.now);
  const oldG = gridOfNode(old.node);
  const newG = gridOfNode(node);
  const fade = RELOAD_FADE_MS / 1000;
  const sameTime = !!oldG && !!newG && sameTempoMap(oldG.grid, newG.grid);
  const entryFrames = (g: { grid: SegmentGrid; rate: number }): number => Math.max(0, Math.round(ticksToSeconds(g.grid, g.grid.entryTicks) * g.rate));
  const request = {
    to: node,
    reason: "reload" as const,
    grid: "bar" as const,
    notBefore: Number.NaN,
    startFrame: 0,
    // entryCue: the incoming starts from the file start and its entry is heard at T (as a first start).
    preEntry: !sameTime && newG ? Math.max(0, entrySeconds(newG.grid)) : 0,
    startFrameAt: (point: number): number => {
      if (!sameTime || !newG) return 0;
      const s = ticksToSeconds(newG.grid, ticksAt(anchor, point));
      const end = Number.isFinite(newG.grid.endSeconds) ? newG.grid.endSeconds : (exitSeconds(newG.grid) ?? Number.POSITIVE_INFINITY);
      // Past the new audio: nothing to continue into, so enter at the entry cue.
      return s < end - 1e-6 ? Math.max(0, Math.round(s * newG.rate)) : entryFrames(newG);
    },
    onStamped: (p: PlannedStart, ff: MusicFrame): void => {
      void ff;
      st.planned = null;
      const outgoing = player.run;
      if (!outgoing) return;
      const deferred = fadeOutgoing(outgoing, p.point, fade);
      st.swap = { run: p.run, at: p.at, point: p.point };
      st.retiring.push({ run: outgoing, until: p.point + fade + RETIRE_SLACK_SECONDS, deferred, fadeAt: p.point });
    },
    onDropped: (): void => {
      st.planned = null; // the old version plays on; the planner warned and counted the refusal
    },
  };
  requestStart(player, request, f);
  const planned = player.planned;
  st.planned = planned && planned.request.reason === "reload" ? planned : null;
  return true;
}

/** Take over at T: the incoming run is the player's, anchored from its own start. */
function promote(player: MusicPlayer, st: ReloadState): void {
  const swap = st.swap!;
  st.swap = null;
  if (player.state === "stopping" || player.state === "stopped") return;
  if (swap.run.state === "cancelled") return;
  const old = player.run;
  if (old && old !== swap.run) old.state = "ending";
  player.run = swap.run;
  if (player.next === swap.run) player.next = null;
  player.anchor = anchorRun(swap.run, Number.isFinite(swap.run.startAt) ? swap.run.startAt : swap.at);
}

/** P8, step 9 (first in the tick): plan the swap at the next bar for a marked player. */
export function applyReloads(player: MusicPlayer, f: MusicFrame): void {
  const st = states.get(player);
  if (!st) return;

  // The outgoing runs: deferred fades when T is within the lookahead, cancel when the fade is over.
  if (st.retiring.length > 0) {
    const L = lookaheadSeconds(f);
    for (let k = st.retiring.length - 1; k >= 0; k--) {
      const r = st.retiring[k]!;
      if (r.deferred && f.now + L >= r.fadeAt - EPS) {
        for (const v of r.deferred) v.stop(RELOAD_FADE_MS / 1000);
        r.deferred = null;
      }
      if (f.now >= r.until) {
        cancelRun(r.run, f);
        st.retiring.splice(k, 1);
      }
    }
  }

  if (st.swap && f.now + EPS >= st.swap.at) promote(player, st);

  if (!st.event && st.clips.size === 0) return;
  if (st.swap || player.state === "stopping" || player.state === "stopped" || player.state === "refused") return;
  const run = player.run;
  if (!run || run.state === "cancelled" || run.state === "ending") return; // nothing plays yet: the first start primes fresh bytes
  if (player.planned && player.planned !== st.planned) return; // another change is planned: wait for its stamp

  // The segment as it is now: the new event's node, or this node when only a clip file changed.
  let node: MusicNodeRef = run.node;
  let root: MusicNodeRef | null = null;
  let changedNode = false;
  if (st.event) {
    st.event = false;
    root = host?.eventRoot(player.instance.path) ?? null;
    const found = root ? findNode(root, run.node.id) : null;
    if (!root || !found) {
      warn(player, st, "invalid", `the reloaded event is missing or no longer holds segment "${run.node.id}"; the old version keeps playing.`);
      root = null;
    } else {
      changedNode = JSON.stringify(found) !== JSON.stringify(run.node);
      if (changedNode) node = found;
    }
  }
  let clipsChanged = false;
  for (const p of st.clips) if (usesClip(run, p)) clipsChanged = true;
  st.clips.clear();
  if (root) (player as { root: MusicNodeRef }).root = root; // rules, playlists, switches and stingers apply to the next decision
  if (!changedNode && !clipsChanged) return;
  // A fresh node object when only a file changed: the length and tempo caches are keyed by node, and the file's length may differ.
  if (!changedNode) node = { ...(node as object) } as MusicNodeRef;
  planSwap(player, st, node, f);
}
