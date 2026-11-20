// The editor's audition (ADR 0268, extending 0158 §7 and 0166's Ed5): the one instance an editor auditions, whoever
// pressed Play (the Event editor's Audition bar, the segment view's transport, the rules table's "audition this
// transition"). It owns the playing handle and everything about its lifetime: flush the event's pending write, then play
// (an epoch drops a play that a newer Play, a Stop or a closed document overtook during the flush), stop and key-off,
// the end of the instance noticed on one tick, live parameter overrides for whatever is playing, the instance's voices
// and staleness, and the notice the views show. The music-only extras (start at a segment or a position, a seek retried
// while the pool is full, solo/mute stems, loop) are options of the same instance. The audio host is injected
// (`AuditionHost`), so this module imports neither `Audio` nor Preact components and the tests drive it with a fake;
// `editorAudition.ts` builds the real one, and the views (`event/Audition.tsx`, `music/TransportBar.tsx`) only read its
// signals and call it.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { cueTicks, positionToTicks, secondsToNearestTick, ticksToPositionText, ticksToSeconds, type SegmentGrid, type TempoMap } from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import type { MusicEventHandle, MusicSeekResult } from "../../../../engine/audio/musicTypes";
import type { AudioReason, AudioStatus } from "../../runtime/backend";

/** Where the audition is: nothing started, playing, key-off sent (sustain tails playing), or ended by itself or by Stop. */
export type AuditionPhase = "idle" | "playing" | "released" | "ended";

type AuditionAction = "play" | "stop" | "release" | "finished" | "refused";

/** The next phase. `play` always (re)starts; `release` only counts while playing; `finished` is the instance ending by itself. */
function nextPhase(phase: AuditionPhase, action: AuditionAction): AuditionPhase {
  switch (action) {
    case "play": return "playing";
    case "stop": return phase === "idle" ? "idle" : "ended";
    case "release": return phase === "playing" ? "released" : phase;
    case "finished": return phase === "playing" || phase === "released" ? "ended" : phase;
    case "refused": return "ended";
  }
}

/** True while an instance is live (playing, or released with tails sounding). */
export const isLive = (phase: AuditionPhase): boolean => phase === "playing" || phase === "released";

/** The handle `Audio.play` returns, as far as the audition uses it (a test fake implements this much). */
export type AuditionHandle = MusicEventHandle & {
  readonly reason?: AudioReason | null;
  stop(fade?: number): void;
  release?(): void;
  setParameter?(name: string, value: number | string): void;
};

/** One `Audio.debug()` event row and voice row, as far as the audition reads them. */
export interface AuditionEventRow { readonly id: number; readonly asset: string }
export interface AuditionVoiceRow { readonly id: number; readonly clip: string; readonly state: string; readonly gain: number; readonly event?: number | null }

/** What the audio host shows now. A host with no debug rows (a test fake) gives empty lists; the end of an instance is then its handle's `playing`. */
export interface AuditionInspection {
  readonly status: AudioStatus;
  /** `Audio.debug().core.backend`: "core", "babylon", "pending" or anything else; undefined when unknown. */
  readonly backend: unknown;
  readonly events: readonly AuditionEventRow[];
  readonly voices: readonly AuditionVoiceRow[];
}

/** The audio host the audition plays on (`editorAudition.ts` builds the real one over `Audio` and the asset documents). */
export interface AuditionHost {
  /** Start the event (`Audio.play`). */
  play(path: string, parameters: Record<string, number | string>): AuditionHandle;
  /** Write the event document's pending edit so the runtime reads what is on screen. */
  flush(path: string): Promise<void>;
  /** The event or a stem changed on disk: re-prime the playing segment (P8's `noteAssetChanged`). */
  reload(path: string): void;
  /** F-15: start the playing music at segment `segmentId` of its playlist (before its first plan); false when it can't. */
  startAt(handle: AuditionHandle, segmentId: string): boolean;
  /** F-41: start the playing music at `position` of its first segment (before its first plan); false when it can't. */
  startAtPosition(handle: AuditionHandle, position: string): boolean;
  /** F-14: only the stems of `segmentId` named in `audible` sound (null: all). Editor-only; never written to the event. */
  stems(handle: AuditionHandle, segmentId: string, audible: readonly string[] | null): void;
  inspect(): AuditionInspection;
  /** The raw asset object the runtime parses `path` from (a write replaces it), or undefined. */
  asset(path: string): object | undefined;
}

/** Where a music audition starts or seeks, in the segment's own terms. */
export type AuditionTarget =
  | { readonly kind: "start" }
  | { readonly kind: "cue"; readonly name: string }
  | { readonly kind: "bar"; readonly bar: number }
  | { readonly kind: "seconds"; readonly seconds: number };

/** The music-only options of a play: the segment it is about and where it starts. */
export interface MusicAuditionOptions {
  readonly segmentId: string;
  readonly grid: SegmentGrid;
  readonly from?: AuditionTarget;
  /** Start the playlist at `segmentId` rather than its first segment (the segment view's open segment). */
  readonly startAtSegment?: boolean;
}

export interface AuditionRequest {
  /** The event asset (`*.audioevent.json`). */
  readonly event: string;
  /** The parameter values to start with (the sliders' values over the event's defaults). */
  readonly parameters?: Record<string, number | string>;
  /** Present for a music audition from the segment view or the rules table. */
  readonly music?: MusicAuditionOptions;
}

export interface AuditionVoice { readonly id: number; readonly clip: string; readonly state: string; readonly gain: number }

export interface AuditionState {
  readonly phase: AuditionPhase;
  /** The event playing, or being flushed to play (`starting`), or that last played; null before any. */
  readonly event: string | null;
  /** The music segment the audition is about; null for a whole-event audition (the Event editor's). */
  readonly segmentId: string | null;
  /** True between Play and the instance starting (the document's flush). */
  readonly starting: boolean;
  /** Music auditions restart when they end by themselves. */
  readonly loop: boolean;
  /** A line about the last seek, stinger or parameter request, or null. */
  readonly message: string | null;
  /** Whether the last Play made an instance, and its handle's reason. */
  readonly played: boolean;
  readonly reason: AudioReason | null;
  readonly status: AudioStatus;
  readonly backend: unknown;
  /** The live instance's voices, in the host's debug order. */
  readonly voices: readonly AuditionVoice[];
  /** The event was written after this instance started (the runtime still plays the old version). */
  readonly stale: boolean;
}

/** Parameter values the sliders moved, per event path (the rest are the event's defaults). */
export type AuditionOverrides = Readonly<Record<string, Readonly<Record<string, number | string>>>>;

/** Which audition a `stop` is meant for: the event, and the segment (null: the whole-event audition) or any (omitted). */
export interface AuditionMatch {
  readonly event: string;
  readonly segmentId?: string | null;
}

export interface Audition {
  readonly state: ReadonlySignal<AuditionState>;
  /** What to tell the person, or null: a failed or locked backend, a play that made nothing, else the last message. */
  readonly notice: ReadonlySignal<string | null>;
  /** File seconds of the playhead in the audition's segment; undefined when nothing plays there. */
  readonly playhead: ReadonlySignal<number | undefined>;
  readonly overrides: ReadonlySignal<AuditionOverrides>;
  /** Stop what plays, flush the event, then play it. A newer Play or a Stop during the flush cancels this one. */
  play(request: AuditionRequest): Promise<void>;
  /** Stop now, or a pending play. With `match`, only when the current (or pending) audition is that one. */
  stop(match?: AuditionMatch): void;
  /** Key-off: sustain loops play their tails. Only while playing. */
  release(): void;
  setLoop(loop: boolean): void;
  /** Move the playing music, or start it there when it isn't playing (the segment view's ruler click). */
  seek(request: AuditionRequest): Promise<void>;
  /** A slider moved: remember the value for `event`'s auditions, and set it on the playing instance when that is `event`. */
  setParameter(event: string, name: string, value: number | string): void;
  /**
   * Set a parameter on the playing music once a pending seek has landed and its start segment sounds (a music switch's
   * parameter asks for its change: "audition this transition"). False, with a message, when nothing plays or the handle
   * can't set one.
   */
  requestParameter(name: string, value: number | string): boolean;
  /** The stems that sound in a segment (the segment panel's solo and mute); null: all. Applies now and to later plays. */
  setAudibleStems(segmentId: string, audible: readonly string[] | null): void;
  /** Fire a stinger of the playing event; false (with a message) when nothing plays or it is refused. */
  trigger(name: string): boolean;
  /** What the stinger buttons of `event` get: a trigger while `event` plays, else null (read reactively). */
  stingerTarget(event: string): { trigger(name: string): boolean } | null;
  /** Hot reload: flush the edit and tell the runtime, which swaps the playing segment at the next bar. */
  reload(): Promise<void>;
  /**
   * One display step: the host's status, the instance's voices and staleness, the end of the instance (and a music loop's
   * restart), a pending seek or parameter, the playhead. `grid` replaces the segment's grid (it was edited). With
   * nothing playing it only re-reads the host's status and backend.
   */
  tick(grid?: SegmentGrid): void;
  /** Stop and forget everything. */
  dispose(): void;
}

// --- pure helpers -----------------------------------------------------------------------------------------------------

const normal = (path: string): string => path.replace(/^asset:/, "");

/** The instance a play just made: the row for `path` whose id wasn't there before (the handle doesn't expose its id). */
function newInstanceId(before: readonly number[], rows: readonly AuditionEventRow[], path: string): number | null {
  const known = new Set(before);
  const p = normal(path);
  let found: number | null = null;
  for (const r of rows) if (!known.has(r.id) && normal(r.asset) === p) found = r.id;
  return found;
}

/** The runtime caches a parsed event per raw asset object, and a write hands out a new object: stale when they differ (an unknown side is not). */
const isStale = (startedWith: object | undefined, current: object | undefined): boolean =>
  startedWith !== undefined && current !== undefined && startedWith !== current;

const sameVoices = (a: readonly AuditionVoice[], b: readonly AuditionVoice[]): boolean =>
  a.length === b.length && a.every((v, i) => v.id === b[i]!.id && v.clip === b[i]!.clip && v.state === b[i]!.state && v.gain === b[i]!.gain);

/** The notice for the backend and the last play; null when there is nothing to say about them. */
function playNotice(status: AudioStatus, phase: AuditionPhase, reason: AudioReason | null, played: boolean): string | null {
  if (status === "failed") return "The audio backend failed to start, so nothing can be heard. See the Audio Debug panel and the console.";
  if (phase === "idle") return null;
  if (status === "locked") return "Audio is locked by the browser until you click in the page. Press Play again after clicking.";
  if (!played) {
    if (reason === "locked") return "Audio is locked by the browser until you click in the page.";
    return "Nothing played: the event may be empty, in its cooldown, at its instance limit, or its clips are missing.";
  }
  return null;
}

/** The `"bar:beat:tick"` text `handle.music.seek` takes for `target`; null for `start` (no seek) or a target the grid can't place. */
function seekText(grid: SegmentGrid, target: AuditionTarget): string | null {
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
function playheadSeconds(
  grid: TempoMap,
  music: { readonly segment: string | null; readonly bar: number; readonly beat: number; readonly beatFraction: number } | undefined,
  segmentId: string,
): number | undefined {
  if (!music || music.segment !== segmentId) return undefined;
  const ticks = positionToTicks(grid, music.bar, music.beat, 0) + Math.round(Math.min(1, Math.max(0, music.beatFraction)) * MUSIC_TICKS_PER_BEAT);
  const seconds = ticksToSeconds(grid, ticks);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** What a refused seek tells the person. */
function seekMessage(result: MusicSeekResult): string | null {
  if (result.ok) return null;
  switch (result.reason) {
    case "invalid": return "That position is not in the playing segment.";
    case "notPlaying": return "The music is not playing, so there is nothing to move.";
    case "neverFits": return "The seek needs more streaming slots than the pool has.";
    case "poolFull": return "No free streaming slots yet; trying again.";
  }
}

/** A refused-for-now seek is retried this many ticks (about two seconds at the 50 ms tick) before giving up. */
const SEEK_RETRIES = 40;

// --- the audition -----------------------------------------------------------------------------------------------------

export function createAudition(host: AuditionHost): Audition {
  const first = (() => { try { return host.inspect(); } catch { return null; } })();
  const idle: AuditionState = {
    phase: "idle", event: null, segmentId: null, starting: false, loop: false, message: null, played: false, reason: null,
    status: first?.status ?? "running", backend: first?.backend, voices: [], stale: false,
  };
  const state = signal<AuditionState>(idle);
  const playhead = signal<number | undefined>(undefined);
  const overrides = signal<AuditionOverrides>({});
  let handle: AuditionHandle | null = null;
  /** The playing instance's debug row id, when the host has rows. */
  let instance: number | null = null;
  /** The raw asset object the instance started from. */
  let startedWith: object | undefined;
  let last: AuditionRequest | null = null;
  let grid: SegmentGrid | null = null;
  let pendingSeek: { text: string; retries: number } | null = null;
  let pendingParameter: { name: string; value: number | string } | null = null;
  let stems: { segmentId: string; audible: readonly string[] | null } | null = null;
  /** Bumped by every play and stop, so a flush that resolves after a newer one does nothing. */
  let epoch = 0;

  const set = (patch: Partial<AuditionState>): void => void (state.value = { ...state.value, ...patch });
  const move = (action: AuditionAction, patch: Partial<AuditionState> = {}): void => set({ ...patch, phase: nextPhase(state.value.phase, action) });

  const inspect = (): AuditionInspection | null => { try { return host.inspect(); } catch { return null; } };
  /** The host's status and backend, and the live instance's voices and staleness, into the state (only what changed). */
  const refresh = (info: AuditionInspection | null): void => {
    const s = state.value;
    const patch: { -readonly [K in keyof AuditionState]?: AuditionState[K] } = {};
    if (info && info.status !== s.status) patch.status = info.status;
    if (info && info.backend !== s.backend) patch.backend = info.backend;
    if (handle) {
      const voices = info && instance !== null
        ? info.voices.filter((v) => v.event === instance).map((v) => ({ id: v.id, clip: v.clip, state: v.state, gain: v.gain }))
        : [];
      if (!sameVoices(voices, s.voices)) patch.voices = voices;
      const stale = s.event !== null && isStale(startedWith, host.asset(s.event));
      if (stale !== s.stale) patch.stale = stale;
    }
    if (Object.keys(patch).length > 0) set(patch);
  };

  /** Forget the instance (and stop it with `fade` when given); the state keeps its phase for the caller to move. */
  const drop = (fade: number | null): void => {
    const h = handle;
    handle = null;
    instance = null;
    startedWith = undefined;
    pendingSeek = null;
    pendingParameter = null;
    playhead.value = undefined;
    if (state.value.voices.length > 0 || state.value.stale) set({ voices: [], stale: false });
    if (h && fade !== null) { try { h.stop(fade); } catch { /* already gone */ } }
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

  const play = async (request: AuditionRequest): Promise<void> => {
    const mine = ++epoch;
    const music = request.music;
    last = request;
    grid = music?.grid ?? null;
    drop(0.02);
    set({ event: request.event, segmentId: music?.segmentId ?? null, starting: true });
    try { await host.flush(request.event); } catch { /* an unwritable project: play what the host has */ }
    if (mine !== epoch) return;
    const before = inspect()?.events.map((e) => e.id) ?? [];
    startedWith = host.asset(request.event);
    const h = host.play(request.event, request.parameters ?? {});
    const info = inspect();
    const base: Partial<AuditionState> = { starting: false, played: h.playing, reason: h.reason ?? null, message: null, stale: false };
    if (!h.playing) {
      startedWith = undefined;
      move("refused", base);
      refresh(info);
      return;
    }
    handle = h;
    instance = info ? newInstanceId(before, info.events, request.event) : null;
    let message: string | null = null;
    if (music) {
      // Before the first plan tick: the playlist starts at the open segment, and the stems with the panel's solo and mute.
      const text = music.from ? seekText(music.grid, music.from) : null;
      if (music.startAtSegment && !host.startAt(h, music.segmentId)) message = "This segment can't be started on its own here; playing from the event's start.";
      if (stems) host.stems(h, stems.segmentId, stems.audible);
      // F-41: a position the music can start at is started there once; only a refused one falls back to a seek after the start.
      const placed = text !== null && message === null && host.startAtPosition(h, text);
      pendingSeek = text === null || placed ? null : { text, retries: SEEK_RETRIES };
      if (music.from && music.from.kind !== "start" && text === null) message = "That position is not on the grid.";
    }
    move("play", { ...base, message });
    refresh(info);
    trySeek();
  };

  /** Whether `match` names the audition that plays or is starting now. */
  const matches = (match: AuditionMatch): boolean => {
    const s = state.value;
    if (!s.starting && !isLive(s.phase)) return false;
    return s.event === match.event && (match.segmentId === undefined || match.segmentId === s.segmentId);
  };

  const trigger = (name: string): boolean => {
    if (!handle?.playing) {
      set({ message: "Press Play first: a stinger plays over the running music." });
      return false;
    }
    const ok = handle.trigger(name);
    set({ message: ok ? null : `Stinger “${name}” was not played: unknown, dropped by its own rules, or the pool refused it.` });
    return ok;
  };

  /** What `stingerTarget` hands out: one object, so a view that keeps it sees a change only when the audition starts or stops. */
  const stingerTarget = { trigger };

  return {
    state,
    playhead,
    overrides,
    notice: computed(() => {
      const s = state.value;
      return playNotice(s.status, s.phase, s.reason, s.played) ?? s.message;
    }),
    play,
    stop(match) {
      if (match && !matches(match)) return;
      epoch++;
      drop(0.05);
      move("stop", { starting: false });
    },
    release() {
      if (!handle || state.value.phase !== "playing") return;
      try { handle.release?.(); } catch { /* already gone */ }
      move("release");
    },
    setLoop(loop) {
      set({ loop });
    },
    async seek(request) {
      const music = request.music;
      if (music) grid = music.grid;
      const text = music?.from ? seekText(music.grid, music.from) : null;
      if (handle?.playing && handle.music && text !== null && state.value.event === request.event) {
        last = request;
        pendingSeek = { text, retries: SEEK_RETRIES };
        trySeek();
        return;
      }
      await play(request);
    },
    setParameter(event, name, value) {
      const cur = overrides.value;
      overrides.value = { ...cur, [event]: { ...cur[event], [name]: value } };
      if (!handle?.playing || state.value.event !== event || !handle.setParameter) return;
      try { handle.setParameter(name, value); } catch { /* the instance ended between the check and the call */ }
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
    trigger,
    stingerTarget(event) {
      const s = state.value;
      if (!isLive(s.phase) || s.event !== event || !handle?.playing) return null;
      return stingerTarget;
    },
    async reload() {
      const event = state.value.event;
      if (!event || !handle) return;
      try { await host.flush(event); } catch { /* play what the host has */ }
      host.reload(event);
    },
    tick(next) {
      if (next) grid = next;
      const info = inspect();
      const h = handle;
      if (!h) return void refresh(info);
      // The end of the instance: its row is gone from the host (tails included) and its handle no longer plays. Only the
      // instance this audition holds can end here: another Play or a Stop drops the handle first, so a loop never
      // restarts an audition that something else stopped.
      const alive = instance !== null && info ? info.events.some((r) => r.id === instance) : h.playing;
      if (!alive && !h.playing) {
        const s = state.value;
        const again = s.loop && s.phase === "playing" && last?.music ? last : null;
        drop(null);
        move("finished");
        if (again) void play({ ...again, music: { ...again.music!, grid: grid ?? again.music!.grid } });
        return;
      }
      refresh(info);
      trySeek();
      // Held until the segment the play started in is the one sounding: while the music primes `segment` is null, and a
      // parameter set then makes it start in the target (no transition to audition).
      const segmentId = state.value.segmentId;
      const sourcePlaying = !h.music || h.music.segment === segmentId;
      if (pendingParameter && !pendingSeek && sourcePlaying && h.setParameter) {
        const { name, value } = pendingParameter;
        pendingParameter = null;
        try { h.setParameter(name, value); } catch { /* the instance ended between the check and the call */ }
      }
      playhead.value = grid && segmentId ? playheadSeconds(grid, h.music, segmentId) : undefined;
    },
    dispose() {
      epoch++;
      drop(0.05);
      state.value = { ...idle, status: state.value.status, backend: state.value.backend };
    },
  };
}
