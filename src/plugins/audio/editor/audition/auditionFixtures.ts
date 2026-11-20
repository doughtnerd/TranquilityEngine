// A fake audio host and handles for the audition's tests (ADR 0268): what `Audio.play` and the document flush would do,
// recorded, with the debug rows and asset objects the test sets.
import type { MusicSeekResult } from "../../../../engine/audio/musicTypes";
import type { AudioStatus } from "../../runtime/backend";
import type { AuditionEventRow, AuditionHandle, AuditionHost, AuditionVoiceRow } from "./audition";

export interface FakeHandle extends AuditionHandle {
  alive: boolean;
  seeks: string[];
  triggers: string[];
  stops: number;
  releases: number;
  sets: [string, number | string][];
  seekResults: MusicSeekResult[];
  position: { segment: string | null; bar: number; beat: number; beatFraction: number };
}

/** A handle that plays until stopped (or `alive` is cleared); `music` reads `position` and records seeks. */
export function fakeHandle(playing = true, options: { music?: boolean } = {}): FakeHandle {
  const h = {
    alive: playing, seeks: [] as string[], triggers: [] as string[], stops: 0, releases: 0, sets: [] as [string, number | string][],
    seekResults: [] as MusicSeekResult[], position: { segment: "a" as string | null, bar: 1, beat: 1, beatFraction: 0 },
    reason: null,
    onMusic: () => () => undefined,
    trigger: (name: string) => { h.triggers.push(name); return name !== "unknown"; },
    stop: () => { h.stops++; h.alive = false; },
    release: () => void h.releases++,
    setParameter: (name: string, value: number | string) => void h.sets.push([name, value]),
  } as unknown as FakeHandle;
  Object.defineProperty(h, "playing", { get: () => h.alive });
  Object.defineProperty(h, "music", {
    get: () => (options.music === false ? undefined : { ...h.position, seek: (to: string) => { h.seeks.push(to); return h.seekResults.shift() ?? { ok: true, time: 1 }; } }),
  });
  return h;
}

export interface FakeHost extends AuditionHost {
  flushed: string[];
  reloaded: string[];
  played: string[];
  params: Record<string, number | string>[];
  positions: string[];
  positionOk: boolean;
  started: string[];
  stemCalls: (readonly string[] | null)[];
  status: AudioStatus;
  backend: unknown;
  events: AuditionEventRow[];
  voices: AuditionVoiceRow[];
  assets: Map<string, object>;
  /** Resolves the next flush only when the test calls it (null: flushes resolve at once). */
  holdFlush: (() => void) | null;
  hold(): void;
}

/** A host that hands out `handles` in turn (a fresh playing one after them). */
export function fakeHost(handles: FakeHandle[] = []): FakeHost {
  const host: FakeHost = {
    flushed: [], reloaded: [], played: [], params: [], positions: [], positionOk: false, started: [], stemCalls: [],
    status: "running", backend: "fake", events: [], voices: [], assets: new Map(), holdFlush: null,
    hold() {
      host.flush = (path) => new Promise<void>((resolve) => { host.flushed.push(path); host.holdFlush = resolve; });
    },
    play: (path, parameters) => { host.played.push(path); host.params.push(parameters); return handles.shift() ?? fakeHandle(); },
    flush: async (path) => void host.flushed.push(path),
    reload: (path) => void host.reloaded.push(path),
    startAt: (_h, id) => { host.started.push(id); return id !== "nope"; },
    startAtPosition: (_h, position) => { host.positions.push(position); return host.positionOk; },
    stems: (_h, _id, audible) => void host.stemCalls.push(audible),
    inspect: () => ({ status: host.status, backend: host.backend, events: host.events, voices: host.voices }),
    asset: (path) => host.assets.get(path),
  };
  return host;
}
