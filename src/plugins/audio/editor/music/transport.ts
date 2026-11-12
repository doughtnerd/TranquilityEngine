// Ed5 (api-and-models §7, contract H6): the transport of the segment view. Play, stop, loop, play from a cue, a bar or a
// clicked second, trigger a stinger while playing, hot reload, and the playhead, all on the real runtime: the music player
// reached through `Audio.play`, the same path a game's script takes. The audio host (play, flush the pending write,
// reload) is injected, so this module imports neither `Audio` nor Preact and the tests run it against a fake;
// `transportHost.ts` builds the real one. The pure helpers (`seekText`, `playheadSeconds`) need only the tempo grid.
import { signal, type ReadonlySignal } from "@preact/signals";
import { cueTicks, positionToTicks, secondsToNearestTick, ticksToPositionText, ticksToSeconds, type SegmentGrid, type TempoMap } from "../../../../engine/audio/musicGrid";
import type { MusicEventHandle, MusicSeekResult } from "../../../../engine/audio/musicTypes";
import { clearActiveAudition, nextPhase, setActiveAudition, type AuditionAction, type AuditionPhase } from "../event/auditionHost";
import { TICKS_PER_BEAT } from "./segmentViewModel";

/** Where a play or a seek goes, in the segment's own terms. */
export type TransportTarget =
  | { readonly kind: "start" }
  | { readonly kind: "cue"; readonly name: string }
  | { readonly kind: "bar"; readonly bar: number }
  | { readonly kind: "seconds"; readonly seconds: number };

/** The `"bar:beat:tick"` text `handle.music.seek` takes for `target`; null for `start` (no seek) or a target the grid can't place. */
export function seekText(grid: SegmentGrid, target: TransportTarget): string | null {
  switch (target.kind) {
    case "start": return null;
    case "bar": return Number.isInteger(target.bar) && target.bar >= 1 ? `${target.bar}:1:0` : null;
    case "cue": {
      const t = cueTicks(grid, target.name);
      return t === null || !Number.isFinite(t) ? null : ticksToPositionText(grid, t);
    }
    case "seconds": return Number.isFinite(target.seconds) ? ticksToPositionText(grid, secondsToNearestTick(grid, Math.max(0, target.seconds))) : null;
  }
}

/** The file second the music is at, from `handle.music`'s bar, beat and beat fraction; undefined when another segment plays. */
export function playheadSeconds(
  grid: TempoMap,
  music: { readonly segment: string | null; readonly bar: number; readonly beat: number; readonly beatFraction: number } | undefined,
  segmentId: string,
): number | undefined {
  if (!music || music.segment !== segmentId) return undefined;
  const ticks = positionToTicks(grid, music.bar, music.beat, 0) + Math.round(Math.min(1, Math.max(0, music.beatFraction)) * TICKS_PER_BEAT);
  const seconds = ticksToSeconds(grid, ticks);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** What a refused seek tells the person. */
export function seekMessage(result: MusicSeekResult): string | null {
  if (result.ok) return null;
  switch (result.reason) {
    case "invalid": return "That position is not in the playing segment.";
    case "notPlaying": return "The music is not playing, so there is nothing to move.";
    case "neverFits": return "The seek needs more streaming slots than the pool has.";
    case "poolFull": return "No free streaming slots yet; trying again.";
  }
}

/** The part of the audio host the transport uses. */
export interface TransportHost {
  /** Start the event (`Audio.play`). */
  play(path: string, parameters: Record<string, number | string>): TransportHandle;
  /** Write the document's pending edit so the runtime reads what is on screen. */
  flush(path: string): Promise<void>;
  /** The event or a stem changed on disk: re-prime the playing segment (P8's `noteAssetChanged`). */
  reload(path: string): void;
  /** F-15: start the playing music at segment `segmentId` of its playlist (before its first plan); false when it can't. */
  startAt(handle: TransportHandle, segmentId: string): boolean;
  /** F-14: only the stems of `segmentId` named in `audible` sound (null: all). Editor-only; never written to the event. */
  stems(handle: TransportHandle, segmentId: string, audible: readonly string[] | null): void;
}

export type TransportHandle = MusicEventHandle & { stop(fade?: number): void; setParameter?(name: string, value: number | string): void };

export interface TransportState {
  readonly phase: AuditionPhase;
  readonly event: string | null;
  readonly segmentId: string | null;
  readonly loop: boolean;
  /** A line for the person (a refused play or seek), or null. */
  readonly message: string | null;
}

export interface PlayRequest {
  readonly event: string;
  readonly segmentId: string;
  readonly grid: SegmentGrid;
  readonly parameters?: Record<string, number | string>;
  readonly from?: TransportTarget;
  /** Start the playlist at `segmentId` rather than its first segment (the segment view's open segment). */
  readonly startAtSegment?: boolean;
}

/** A refused-for-now seek is retried this many ticks (about two seconds at the default tick) before giving up. */
const SEEK_RETRIES = 40;

export interface Transport {
  readonly state: ReadonlySignal<TransportState>;
  /** File seconds of the playhead in the open segment; undefined when nothing plays there. */
  readonly playhead: ReadonlySignal<number | undefined>;
  play(request: PlayRequest): Promise<void>;
  stop(): void;
  setLoop(loop: boolean): void;
  /** Move the playing music, or start it there when it isn't playing (the segment view's ruler click). */
  seek(request: PlayRequest): Promise<void>;
  /**
   * Set an event parameter on the playing instance once any pending seek has landed (a music switch's parameter asks for
   * its change; "audition this transition"). False, with a message, when nothing plays or the handle can't set one.
   */
  requestParameter(name: string, value: number | string): boolean;
  /** The stems that sound in the open segment (solo and mute of the segment panel); null: all. Applies now and to later plays. */
  setAudibleStems(segmentId: string, audible: readonly string[] | null): void;
  /** Fire a stinger of the playing event; false (with a message) when nothing plays or it is refused. */
  trigger(name: string): boolean;
  /** Hot reload: flush the edit and tell the runtime, which swaps the playing segment at the next bar. */
  reload(): Promise<void>;
  /** Advance by one display step: the playhead, a pending seek, the end of the instance, the loop restart. */
  tick(grid?: SegmentGrid): void;
  /** Stop and forget everything (the panel closing). */
  dispose(): void;
}

const IDLE: TransportState = { phase: "idle", event: null, segmentId: null, loop: false, message: null };

export function createTransport(host: TransportHost): Transport {
  const state = signal<TransportState>(IDLE);
  const playhead = signal<number | undefined>(undefined);
  let handle: TransportHandle | null = null;
  let last: PlayRequest | null = null;
  let pendingSeek: { text: string; retries: number } | null = null;
  let pendingParameter: { name: string; value: number | string } | null = null;
  let grid: SegmentGrid | null = null;
  let stems: { segmentId: string; audible: readonly string[] | null } | null = null;
  /** Bumped by every play and stop, so a flush that resolves after a newer one does nothing. */
  let epoch = 0;

  const set = (patch: Partial<TransportState>): void => void (state.value = { ...state.value, ...patch });
  const move = (action: AuditionAction): void => set({ phase: nextPhase(state.value.phase, action) });

  const drop = (fade: number): void => {
    const h = handle;
    handle = null;
    pendingSeek = null;
    pendingParameter = null;
    playhead.value = undefined;
    if (h) {
      clearActiveAudition(h);
      try { h.stop(fade); } catch { /* already gone */ }
    }
  };

  const trySeek = (): void => {
    if (!handle?.music || !pendingSeek) return;
    const result = handle.music.seek(pendingSeek.text);
    if (result.ok) { pendingSeek = null; set({ message: null }); return; }
    if (result.permanent || --pendingSeek.retries <= 0) {
      pendingSeek = null;
      set({ message: seekMessage(result) ?? "The seek was refused." });
    }
  };

  const play = async (request: PlayRequest): Promise<void> => {
    const mine = ++epoch;
    last = request;
    grid = request.grid;
    drop(0.02);
    try { await host.flush(request.event); } catch { /* an unwritable project: play what the host has */ }
    if (mine !== epoch) return;
    const h = host.play(request.event, request.parameters ?? {});
    const text = request.from ? seekText(request.grid, request.from) : null;
    if (!h.playing) {
      set({ event: request.event, segmentId: request.segmentId, message: "Nothing played: the event may be empty, in its cooldown, at its instance limit, or its clips are missing." });
      move("refused");
      return;
    }
    handle = h;
    setActiveAudition(request.event, h);
    // Before the first plan tick: the playlist starts at the open segment, and the stems with the panel's solo and mute.
    let startMessage: string | null = null;
    if (request.startAtSegment && !host.startAt(h, request.segmentId)) startMessage = "This segment can't be started on its own here; playing from the event's start.";
    if (stems) host.stems(h, stems.segmentId, stems.audible);
    pendingSeek = text === null ? null : { text, retries: SEEK_RETRIES };
    set({
      event: request.event,
      segmentId: request.segmentId,
      message: request.from && request.from.kind !== "start" && text === null ? "That position is not on the grid." : startMessage,
    });
    move("play");
    trySeek();
  };

  return {
    state,
    playhead,
    play,
    stop() {
      epoch++;
      drop(0.05);
      move("stop");
    },
    setLoop(loop) {
      set({ loop });
    },
    async seek(request) {
      grid = request.grid;
      const text = request.from ? seekText(request.grid, request.from) : null;
      if (handle?.playing && handle.music && text !== null) {
        last = request;
        pendingSeek = { text, retries: SEEK_RETRIES };
        trySeek();
        return;
      }
      await play(request);
    },
    requestParameter(name, value) {
      if (!handle?.playing || !handle.setParameter) {
        set({ message: handle?.playing ? "This handle can't set parameters." : "Press Play first: a parameter change needs running music." });
        return false;
      }
      pendingParameter = { name, value };
      set({ message: null });
      return true;
    },
    setAudibleStems(segmentId, audible) {
      stems = { segmentId, audible };
      if (handle?.playing) host.stems(handle, segmentId, audible);
    },
    trigger(name) {
      if (!handle?.playing) {
        set({ message: "Press Play first: a stinger plays over the running music." });
        return false;
      }
      const ok = handle.trigger(name);
      set({ message: ok ? null : `Stinger “${name}” was not played: unknown, dropped by its own rules, or the pool refused it.` });
      return ok;
    },
    async reload() {
      const event = state.value.event;
      if (!event) return;
      try { await host.flush(event); } catch { /* play what the host has */ }
      host.reload(event);
    },
    tick(next) {
      if (next) grid = next;
      const h = handle;
      if (!h) return;
      if (!h.playing) {
        clearActiveAudition(h);
        handle = null;
        pendingSeek = null;
        pendingParameter = null;
        playhead.value = undefined;
        const again = state.value.loop && state.value.phase === "playing" ? last : null;
        move("finished");
        if (again) void play({ ...again, grid: grid ?? again.grid });
        return;
      }
      trySeek();
      // Held until the segment the play started in is the one sounding: while the music primes `segment` is null, and a
      // parameter set then makes it start in the target (no transition to audition).
      const sourcePlaying = !h.music || h.music.segment === state.value.segmentId;
      if (pendingParameter && !pendingSeek && sourcePlaying && h.setParameter) {
        const { name, value } = pendingParameter;
        pendingParameter = null;
        try { h.setParameter(name, value); } catch { /* the instance ended between the check and the call */ }
      }
      const id = state.value.segmentId;
      playhead.value = grid && id ? playheadSeconds(grid, h.music, id) : undefined;
    },
    dispose() {
      epoch++;
      drop(0.05);
      state.value = IDLE;
    },
  };
}
