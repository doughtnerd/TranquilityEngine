// ADR 0166 P9: `musicOps`'s half of music recovery on the recording host (`recordingAudio`, ADR 0234; no wasm): `reopenGroups` drops every live group
// without events (voices freed, rings returned, the worker's groups cancelled, Ê reset) and reports a `recover`
// lifecycle event up the music seam (ADR 0248); the Replayer hands off once per rebuild even with no member voice; a worker crash is told from
// a stem failure by the decoder's generation and recovered at the next `beginFrame`. The loopback halves are in
// `musicRecoveryLoopback.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDecoder } from "./fakeDecoder";
import type { MusicGroupEvent, MusicGroupRequest, MusicLifecycleEvent } from "../backend";
import type { PrimeGroupOptions, StreamReply } from "../decoder/decoderClient";
import { closeRecordingAudio, recordingAudio } from "../testing";

/** The prime-latency average's seed before any prime has been measured, ms. */
const PRIME_EMA_SEED_MS = 40;

/** The core backend on the recording host (ADR 0234) with `rings` music rings and an in-process decoder that records primes and cancels. */
function rig(rings = 8) {
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
  const dummyPort = () => ({ onmessage: null, postMessage() {} });
  const r = recordingAudio({
    mixer: "own",
    preset: { maxLogical: 16, limiterLookaheadMs: 1.5, maxMusicRings: rings },
    backend: {
      streams: {
        decoder: () => decoder as never,
        connectWorklet: () => {},
        channel: () => ({ worker: dummyPort(), worklet: dummyPort() }),
        fetchBytes: async () => new ArrayBuffer(16),
      },
    },
  });
  const { backend, clock } = r;
  const events: MusicGroupEvent[] = [];
  backend.music.onGroupEvent = (e) => events.push(e);
  // ADR 0248: what the core reports up the music seam (the music side decides what to re-plan).
  const lifecycle: MusicLifecycleEvent[] = [];
  backend.music.onLifecycle = (e) => lifecycle.push(e);
  for (let k = 0; k < 3; k++) {
    r.frame(0.016);
  }
  const failAll = (message: string) => {
    for (const p of primes) for (const m of p.members) for (const l of streamListeners) l({ type: "error", streamId: m.streamId, asset: m.asset, message });
  };
  return { backend, ops: backend.musicOps, clock, decoder, primes, cancels, closes, events, lifecycle, failAll, status: r.status, frame: (dt: number) => r.frame(dt), rebuild: () => r.rebuild("trap") };
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

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRecordingAudio();
});

describe("musicOps recovery (ADR 0166 P9)", () => {
  it("reopenGroups drops every group quietly: voices freed, rings back, the worker's groups cancelled, Ê reset, recovery reported", async () => {
    const r = rig(8);
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
    // Group 4's member shows primed 200 ms after its primeGroup: one Ê sample, above the seed.
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 200);
    const member = r.primes[1]!.members[0]!;
    r.status({ musicRings: [{ streamId: member.streamId, epochFlags: (1 << 30) | member.epoch }] });
    r.ops.beginFrame();
    expect(r.ops.primedState(4)?.ready).toBe(true);
    expect(r.ops.primeEmaMs).toBeGreaterThan(PRIME_EMA_SEED_MS);

    r.ops.reopenGroups();
    expect(r.ops.debugView().groups).toEqual([]);
    expect(r.ops.debugView().poolUsed).toBe(0);
    expect(r.ops.primeEmaMs).toBe(PRIME_EMA_SEED_MS);
    expect(r.cancels.sort()).toEqual([3, 4]);
    // The stamped group's bound streams close on the worker.
    expect(r.closes).toEqual(expect.arrayContaining(r.primes[0]!.members.map((m) => m.streamId)));
    for (const v of voices) {
      expect(r.backend.debug().voices.some((x) => x.id === v.id)).toBe(false);
      expect(r.ops.ownsVoice(v.id)).toBe(false);
    }
    expect(r.lifecycle).toEqual([{ kind: "recover", cause: "rebuild" }]);
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
    expect(await r.rebuild()).toBe("rebuilt");
    r.frame(0.016);
    expect(reopen).toHaveBeenCalledTimes(1);
    // The rebuild's begin and end, then the groups' recovery (the music side's beat holds and re-plan, ADR 0248).
    expect(r.lifecycle).toEqual([{ kind: "rebuild", active: true }, { kind: "rebuild", active: false }, { kind: "recover", cause: "rebuild" }]);
    expect(r.cancels).toEqual([6]);
    expect(r.ops.primedState(6)).toBeNull();
    // Once: the next frame doesn't hand off again.
    r.frame(0.016);
    expect(reopen).toHaveBeenCalledTimes(1);
    r.backend.dispose();
  });

  it("a rebuild at another rate is a `rate` recovery", () => {
    const r = rig(8);
    vi.spyOn(r.backend.clockMap, "sampleRate", "get").mockReturnValue(44_100);
    r.ops.reopenGroups();
    r.ops.reopenGroups();
    expect(r.lifecycle).toEqual([{ kind: "recover", cause: "rate" }, { kind: "recover", cause: "rebuild" }]);
    r.backend.dispose();
  });

  it("a worker crash (every stream fails under a new generation) recovers at the next beginFrame; a stem failure stays an error", async () => {
    const r = rig(8);
    const recovered = () => r.lifecycle.filter((e) => e.kind === "recover");
    const a = request(8, 2, 1);
    r.ops.admitGroup(a);
    r.ops.primeGroup(a);
    await flush();
    const voices = r.ops.stampGroup({ group: 8, at: r.backend.time + 0.5 }) as { id: number; playing: boolean }[];
    // A stem failure (same generation): an error event, no recovery.
    r.failAll("bad file");
    r.ops.beginFrame();
    expect(r.events.filter((e) => e.kind === "error")).toHaveLength(2);
    expect(recovered()).toEqual([]);
    r.events.length = 0;
    // The worker died: the client retired it (new generation) and failed every stream.
    r.decoder.generation = 2;
    r.failAll("the worker failed; the stream stopped");
    expect(recovered()).toEqual([]); // nothing inside the client's handler
    expect(r.ops.debugView().groups).toHaveLength(1);
    r.ops.beginFrame();
    expect(recovered()).toEqual([{ kind: "recover", cause: "crash" }]);
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
