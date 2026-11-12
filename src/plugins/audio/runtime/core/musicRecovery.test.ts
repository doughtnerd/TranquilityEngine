// ADR 0166 P9: `musicOps`'s half of music recovery on a fake host (no wasm): `reopenGroups` drops every live group
// without events (voices freed, rings returned, the worker's groups cancelled, Ê reset) and hands the players to
// `music/background.ts`; the Replayer hands off once per rebuild even with no member voice; a worker crash is told from
// a stem failure by the decoder's generation and recovered at the next `beginFrame`. The loopback halves are in
// `musicRecoveryLoopback.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost, HostLifecycleListener } from "./context";
import { CoreLink, type LinkPort } from "./context";
import type { ClipInfo, ClipRegistry, ClipState } from "./clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { PRIME_EMA_SEED_MS } from "./musicOps";
import { fakeDecoder } from "./fakeDecoder";
import type { MusicGroupEvent, MusicGroupRequest } from "../backend";
import type { PrimeGroupOptions, StreamReply } from "../decoder/decoderClient";
import * as musicBackground from "../music/background";

function fakeClips(): ClipRegistry {
  const info = (id: number): ClipInfo => ({ id, path: "", state: "ready" as ClipState, refs: 0, frames: 0, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null });
  return {
    acquire: () => 1,
    release() {},
    state: () => "ready",
    info,
    onResident: () => () => {},
    releaseWorld() {},
    applyClipEvent() {},
    residentIds: () => [],
    acquireReserved() {},
    resend() {},
  } as unknown as ClipRegistry;
}

function rig(rings = 8) {
  const link = new CoreLink({ onmessage: null, postMessage: () => {} } as LinkPort);
  let raf = 1000;
  let ctx = 0;
  const clock = {
    rafTime: () => raf,
    outputTimestamp: () => ({ contextTime: ctx, performanceTime: raf }),
    currentTime: () => ctx,
    dateNow: () => 1_000_000 + raf,
    fake: true as const,
    advance(ms: number) {
      raf += ms;
      ctx += ms / 1000;
    },
  };
  const fake = fakeDecoder(() => ({ frames: 0, channels: 1, sampleRate: 48_000, channelData: [] }));
  const primes: PrimeGroupOptions[] = [];
  const cancels: number[] = [];
  const closes: number[] = [];
  const streamListeners = new Set<(r: StreamReply) => void>();
  const decoder = {
    ...fake,
    generation: 1,
    connectWorklet() {},
    openStream() {},
    closeStream: (id: number) => void closes.push(id),
    onStream: (l: (r: StreamReply) => void) => {
      streamListeners.add(l);
      return () => streamListeners.delete(l);
    },
    primeGroup: (o: PrimeGroupOptions) => void primes.push(o),
    cancelGroup: (g: number) => void cancels.push(g),
  };
  let lifecycle: HostLifecycleListener | null = null;
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, limiterLookaheadMs: 1.5, maxMusicRings: rings },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: ((l: HostLifecycleListener) => {
      lifecycle = l;
      return () => {};
    }) as AudioHost["addLifecycleListener"],
  };
  const dummyPort = () => ({ onmessage: null, postMessage() {} });
  const backend = new CoreBackend(host, {
    clips: fakeClips(),
    clock,
    mixer: new Mixer(defaultAudioSettings()),
    streams: {
      decoder: () => decoder as never,
      connectWorklet: () => {},
      channel: () => ({ worker: dummyPort(), worklet: dummyPort() }),
      fetchBytes: async () => new ArrayBuffer(16),
    },
  });
  const events: MusicGroupEvent[] = [];
  backend.music.onGroupEvent = (e) => events.push(e);
  for (let k = 0; k < 3; k++) {
    clock.advance(16);
    backend.update(0.016);
  }
  const failAll = (message: string) => {
    for (const p of primes) for (const m of p.members) for (const l of streamListeners) l({ type: "error", streamId: m.streamId, asset: m.asset, message });
  };
  return { backend, ops: backend.musicOps, clock, decoder, primes, cancels, closes, events, failAll, lifecycle: () => lifecycle! };
}

const flush = async () => {
  for (let k = 0; k < 5; k++) await Promise.resolve();
};

function request(group: number, streamed: number, decoded = 0): MusicGroupRequest {
  const members = [];
  for (let k = 0; k < streamed; k++) members.push({ stem: `s${k}`, play: { path: `music/s${k}.ogg`, url: `s${k}.ogg`, loop: false, stream: true, bus: "Music" }, startFrame: 0, loop: false });
  for (let k = 0; k < decoded; k++) members.push({ stem: `d${k}`, play: { path: `music/d${k}.wav`, url: `d${k}.wav`, loop: false, stream: false, bus: "Music" }, startFrame: 0, loop: false });
  return { instance: 9, group, members };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("musicOps recovery (ADR 0166 P9)", () => {
  it("reopenGroups drops every group quietly: voices freed, rings back, the worker's groups cancelled, Ê reset, players re-plan", async () => {
    const r = rig(8);
    const recover = vi.spyOn(musicBackground, "recoverGroups");
    const a = request(3, 2, 1);
    r.ops.admitGroup(a);
    r.ops.primeGroup(a);
    const b = request(4, 1);
    r.ops.admitGroup(b);
    r.ops.primeGroup(b);
    await flush();
    const voices = r.ops.stampGroup({ group: 3, at: r.backend.time + 0.5 }) as { id: number }[];
    expect(voices.every((v) => v !== null)).toBe(true);
    expect(r.ops.debugView().poolUsed).toBe(3);
    r.ops.samplePrime(200);
    expect(r.ops.primeEmaMs).toBeGreaterThan(PRIME_EMA_SEED_MS);

    r.ops.reopenGroups();
    expect(r.ops.debugView().groups).toEqual([]);
    expect(r.ops.debugView().poolUsed).toBe(0);
    expect(r.ops.primeEmaMs).toBe(PRIME_EMA_SEED_MS);
    expect(r.cancels.sort()).toEqual([3, 4]);
    // The stamped group's bound streams close on the worker.
    expect(r.closes).toEqual(expect.arrayContaining(r.primes[0]!.members.map((m) => m.streamId)));
    for (const v of voices) {
      expect(r.backend.table.isLive(v.id)).toBe(false);
      expect(r.ops.ownsVoice(v.id)).toBe(false);
      expect(r.backend.table.musicGroup[v.id & 0xffff]).toBe(0);
    }
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]![1]).toBe("rebuild");
    // No end, error or other event of the dead groups reaches the router.
    r.ops.beginFrame();
    expect(r.events).toEqual([]);
    r.backend.dispose();
  });

  it("the Replayer hands off once per rebuild even when no member voice is listed (a group still priming)", async () => {
    const r = rig(8);
    const reopen = vi.spyOn(r.ops, "reopenGroups");
    const a = request(6, 1);
    r.ops.admitGroup(a);
    r.ops.primeGroup(a);
    await flush();
    r.lifecycle().onRebuildStart?.("trap");
    r.lifecycle().onRebuilt?.();
    r.clock.advance(16);
    r.backend.update(0.016);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(r.cancels).toEqual([6]);
    expect(r.ops.primedState(6)).toBeNull();
    // Once: the next frame doesn't hand off again.
    r.clock.advance(16);
    r.backend.update(0.016);
    expect(reopen).toHaveBeenCalledTimes(1);
    r.backend.dispose();
  });

  it("a rebuild at another rate is a `rate` recovery", () => {
    const r = rig(8);
    const recover = vi.spyOn(musicBackground, "recoverGroups");
    vi.spyOn(r.backend.clockMap, "sampleRate", "get").mockReturnValue(44_100);
    r.ops.reopenGroups();
    expect(recover.mock.calls[0]![1]).toBe("rate");
    r.ops.reopenGroups();
    expect(recover.mock.calls[1]![1]).toBe("rebuild");
    r.backend.dispose();
  });

  it("a worker crash (every stream fails under a new generation) recovers at the next beginFrame; a stem failure stays an error", async () => {
    const r = rig(8);
    const recover = vi.spyOn(musicBackground, "recoverGroups");
    const a = request(8, 2, 1);
    r.ops.admitGroup(a);
    r.ops.primeGroup(a);
    await flush();
    const voices = r.ops.stampGroup({ group: 8, at: r.backend.time + 0.5 }) as { id: number; playing: boolean }[];
    // A stem failure (same generation): an error event, no recovery.
    r.failAll("bad file");
    r.ops.beginFrame();
    expect(r.events.filter((e) => e.kind === "error")).toHaveLength(2);
    expect(recover).not.toHaveBeenCalled();
    r.events.length = 0;
    // The worker died: the client retired it (new generation) and failed every stream.
    r.decoder.generation = 2;
    r.failAll("the worker failed; the stream stopped");
    expect(recover).not.toHaveBeenCalled(); // nothing inside the client's handler
    expect(r.ops.debugView().groups).toHaveLength(1);
    r.ops.beginFrame();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]![1]).toBe("crash");
    expect(r.ops.debugView().groups).toEqual([]);
    expect(r.ops.debugView().poolUsed).toBe(0);
    expect(r.events).toEqual([]);
    // Members still on the core take a short stop (decoded too: the group re-enters whole).
    for (const v of voices) expect(r.ops.ownsVoice(v.id)).toBe(false);
    expect(voices.every((v) => !v.playing)).toBe(true);
    // The worker's cache died with it: the next prime sends the bytes again.
    const again = request(9, 1);
    r.ops.admitGroup(again);
    r.ops.primeGroup(again);
    await flush();
    expect(r.primes.at(-1)!.members[0]!.bytes).toBeDefined();
    r.backend.dispose();
  });
});
