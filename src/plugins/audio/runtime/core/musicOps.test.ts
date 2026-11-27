// ADR 0166 (Q2): the core backend's music seam and the hooks `coreBackend.ts` and `streams.ts` leave for P1, P9 and
// P10: `music` is `musicOps` with every capability, `beginFrame` is idempotent per frame, `timeAt` is the clock map's
// raw heard clock, `latency` adds the limiter, stream event 4 and music members' events route to musicOps,
// `reopenStreams` hands groups to `reopenGroups`, and `Audio.debug()` reads `musicOps`. On the recording host (`recordingAudio`,
// ADR 0234; no wasm).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClipInfo, ClipRegistry, ClipState } from "./clipRegistry";
import { STREAM_EVENT_MUSIC_FULL } from "./streams";
import { FADE_FLAGS_STOP_AT_END, Op, StreamEvent, gateGroupId, gateGroupSize, PLAY_FLAGS_FADE_ZERO, readFade, readPlay, readSetParams } from "../wire.generated";
import { StatusMirror } from "./mirror";
import { CoreMusicOps, encodedBudgetBytes } from "./musicOps";
import type { MusicGroupEvent, MusicGroupRequest } from "../backend";
import type { PrimeGroupOptions } from "../decoder/decoderClient";
import type { MusicReply } from "../decoder/protocol";
import { CommandWriter } from "./commandWriter";
import { ClockMap } from "./clock";
import { createWarnOnce } from "./codecs";
import { batchRecords } from "./batchRecords";
import { VoiceState, VoiceTable } from "./voiceTable";
import { fakeDecoder } from "./fakeDecoder";
import { closeLoopbackAudio, closeRecordingAudio, endAudioSession, fakeHostClock, loopbackAudio, recordingAudio } from "../testing";
import { debugRows } from "../audioRows";

/** The prime-latency average's seed before any prime has been measured, ms. */
const PRIME_EMA_SEED_MS = 40;

/** Just what the backend's constructor and these tests touch of a registry. */
function fakeClips(over: Partial<ClipRegistry> = {}): ClipRegistry {
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
    ...over,
  } as unknown as ClipRegistry;
}

/**
 * The core backend on the recording host (ADR 0234), over its own mixer. `latency` is the context's read-back; its clock has
 * then run (a stamped output timestamp), so the host's `reliable` rule has its evidence.
 */
function rig(latency?: { base: number; output: number }) {
  const clock = fakeHostClock(latency ? { currentTime: 1 } : {});
  const r = recordingAudio({ mixer: "own", preset: { maxLogical: 16, limiterLookaheadMs: 1.5 }, clips: fakeClips(), clock, latency });
  return { backend: r.backend, clock, raf: () => clock.rafTime(), tick: r.tick };
}

afterEach(async () => {
  await closeRecordingAudio();
  await closeLoopbackAudio();
});

describe("the core's music seam (ADR 0166 §4.6, Q2)", () => {
  it("music is musicOps, with every capability the core will have, and stubs that refuse safely", () => {
    const { backend } = rig();
    expect(backend.music).toBe(backend.musicOps);
    expect(backend.music.caps).toEqual({ primes: true, stampedFades: true, heardClock: true, rhythm: true });
    expect(backend.music.primeEmaMs).toBe(40);
    expect(backend.music.primedState(1)).toBeNull();
    expect(backend.music.admitGroup({ instance: 1, group: 1, members: [] }).ok).toBe(false);
    expect(debugRows(backend.debug(), backend).musicTotals).toBeDefined(); // ADR 0249: composed above the seam
    expect(backend.musicOps.debugView().groups).toEqual([]);
    backend.dispose();
  });

  it("beginFrame is idempotent per frame and leaves Audio.time as frameAttenuate gives it", () => {
    const a = rig();
    const b = rig();
    for (let k = 0; k < 5; k++) {
      a.clock.advance(16);
      b.clock.advance(16);
      a.backend.beginFrame();
      a.backend.beginFrame();
      a.tick(0.016);
      b.tick(0.016);
      expect(a.backend.time).toBe(b.backend.time);
    }
    a.backend.dispose();
    b.backend.dispose();
  });

  it("timeAt maps a performance.now() instant to the raw heard clock", () => {
    const { backend, clock, raf, tick } = rig();
    expect(backend.timeAt(raf())).toBe(backend.time); // no estimate yet: Audio.time
    for (let k = 0; k < 3; k++) {
      clock.advance(16);
      tick(0.016);
    }
    expect(backend.timeAt(raf())).toBeCloseTo(backend.time, 9);
    expect(backend.timeAt(raf() + 100) - backend.timeAt(raf())).toBeCloseTo(0.1, 9);
    backend.dispose();
  });

  it("latency adds the limiter to the host's read-back; reliable only for 0 < output < 0.5", () => {
    const none = rig();
    const l0 = none.backend.latency();
    expect(l0.base).toBe(0);
    expect(l0.output).toBe(0);
    expect(l0.limiter).toBeCloseTo(72 / 48_000, 9); // 1.5 ms look-ahead at 48 kHz
    expect(l0.reliable).toBe(false);
    const read = rig({ base: 0.005, output: 0.02 });
    const l1 = read.backend.latency();
    expect(l1.total).toBeCloseTo(0.005 + 0.02 + l1.limiter, 12);
    expect(l1.reliable).toBe(true);
    none.backend.dispose();
    read.backend.dispose();
  });

  it("stream event 4 and a music member's events go to musicOps; others stay with the stream manager", () => {
    const { backend } = rig();
    const routed = vi.spyOn(backend.musicOps, "onStreamEvent");
    backend.streams.streamEvent(0xffff0100, STREAM_EVENT_MUSIC_FULL);
    expect(routed).toHaveBeenCalledWith(0xffff0100, 4);
    backend.streams.streamEvent(0xffff0101, StreamEvent.Starved);
    expect(routed).toHaveBeenCalledTimes(1);
    expect(backend.streams.stats.starves).toBe(1);
    vi.spyOn(backend.musicOps, "ownsStream").mockImplementation((id) => id === 0xffff0102);
    backend.streams.streamEvent(0xffff0102, StreamEvent.Starved);
    expect(routed).toHaveBeenLastCalledWith(0xffff0102, StreamEvent.Starved);
    expect(backend.streams.stats.starves).toBe(1);
    backend.dispose();
  });

  it("reopenStreams skips music members and reopens their groups as groups", () => {
    const { backend } = rig();
    const reopen = vi.spyOn(backend.musicOps, "reopenGroups");
    const owns = vi.spyOn(backend.musicOps, "ownsVoice").mockReturnValue(true);
    backend.reopenStreams([0x10001]);
    expect(reopen).toHaveBeenCalledTimes(1);
    owns.mockRestore();
    backend.dispose();
  });
});

// --- P1: the group lifecycle on the recording host (no wasm) -----------------------------------------------------------------

/** A backend on the recording host (ADR 0234) with a music pool of `rings` and an in-process decoder that records `primeGroup`s. */
function musicRig(rings = 8, clips: ClipRegistry = fakeClips()) {
  const fake = fakeDecoder(() => ({ frames: 0, channels: 1, sampleRate: 48_000, channelData: [] }));
  const primes: PrimeGroupOptions[] = [];
  const music = new Set<(r: MusicReply) => void>();
  const cancels: number[] = [];
  const closes: number[] = [];
  const decoder = {
    ...fake,
    generation: 1,
    connectWorklet() {},
    openStream() {},
    closeStream: (id: number) => void closes.push(id),
    primeGroup: (o: PrimeGroupOptions) => {
      primes.push(o);
      fake.primeGroup(o);
    },
    cancelGroup: (g: number) => {
      cancels.push(g);
      fake.cancelGroup(g);
    },
    onMusic: (l: (r: MusicReply) => void) => {
      music.add(l);
      return () => music.delete(l);
    },
  };
  const fetched: string[] = [];
  const dummyPort = () => ({ onmessage: null, postMessage() {} });
  const r = recordingAudio({
    mixer: "own",
    preset: { maxLogical: 16, limiterLookaheadMs: 1.5, maxMusicRings: rings },
    clips,
    backend: {
      streams: {
        decoder: () => decoder as never,
        connectWorklet: () => {},
        channel: () => ({ worker: dummyPort(), worklet: dummyPort() }),
        fetchBytes: async (path: string) => {
          fetched.push(path);
          return new ArrayBuffer(16);
        },
      },
    },
  });
  const { backend, clock, posted } = r;
  const events: MusicGroupEvent[] = [];
  backend.music.onGroupEvent = (e) => events.push(e);
  /** One STATUS: every open member ring of `group` at its current epoch, primed. */
  const ringsOf = (group: number) => {
    const out: { streamId: number; epochFlags: number }[] = [];
    for (const p of primes.filter((x) => x.group === group)) for (const m of p.members) out.push({ streamId: m.streamId, epochFlags: (1 << 30) | m.epoch });
    return out;
  };
  const say = (reply: MusicReply) => {
    for (const l of music) l(reply);
  };
  /** What the backend sends from now on (decoded where the core would receive it). */
  posted.take();
  return { backend, ops: backend.musicOps, clock, primes, invalidated: fake.invalidated, cancels, closes, fetched, events, ringsOf, say, status: r.status, posted, tick: r.tick, lock: () => r.lock(), gesture: () => r.gesture() };
}

const flush = async () => {
  for (let k = 0; k < 5; k++) await Promise.resolve();
};

function request(group: number, streamed: number, decoded = 0, instance = 9): MusicGroupRequest {
  const members = [];
  for (let k = 0; k < streamed; k++) members.push({ stem: `s${k}`, play: { path: `music/s${k}.ogg`, url: `s${k}.ogg`, loop: false, stream: true, bus: "Music" }, startFrame: 4800, loop: false });
  for (let k = 0; k < decoded; k++) members.push({ stem: `d${k}`, play: { path: `music/d${k}.wav`, url: `d${k}.wav`, loop: false, stream: false, bus: "Music" }, startFrame: 4800, loop: false, fadeZero: true });
  return { instance, group, members };
}

describe("the core's group operations (ADR 0166 P1)", () => {
  it("admission: the pool mirror, never-fits, no rings, and the 16-entry group table", () => {
    const none = musicRig(0);
    expect(none.ops.admitGroup(request(1, 1))).toEqual({ ok: false, reason: "noMusicRings", permanent: true });
    expect(none.ops.admitGroup(request(1, 0, 2)).ok).toBe(true); // decoded stems need no ring
    none.backend.dispose();

    const r = musicRig(8);
    expect(r.ops.admitGroup(request(1, 9))).toEqual({ ok: false, reason: "neverFits", permanent: true });
    expect(r.ops.admitGroup(request(1, 6)).ok).toBe(true);
    expect(r.ops.debugView().poolUsed).toBe(6);
    expect(r.ops.admitGroup(request(2, 3))).toEqual({ ok: false, reason: "poolFull", permanent: false });
    r.ops.cancelGroup(1);
    expect(r.ops.debugView().poolUsed).toBe(0);
    expect(r.ops.debugView().poolHighWater).toBe(6);
    for (let g = 1; g <= 16; g++) expect(r.ops.admitGroup(request(g, 0, 1)).ok).toBe(true);
    expect(r.ops.debugView().groupTableFull).toBe(0);
    expect(r.ops.admitGroup(request(17, 0, 1))).toEqual({ ok: false, reason: "groupTableFull", permanent: false });
    expect(r.ops.admitGroup(request(18, 0, 1)).ok).toBe(false);
    expect(r.ops.debugView().groupTableFull).toBe(2);
    r.backend.dispose();
  });

  it("a decoded member isn't primed until its clip is resident, and its PLAY goes out only then (F-7b)", () => {
    const acquired: string[] = [];
    const released: number[] = [];
    const states = new Map<number, ClipState>();
    let next = 100;
    const ids = new Map<string, number>();
    const clips = fakeClips({
      acquire: ((path: string) => {
        acquired.push(path);
        let id = ids.get(path);
        if (id === undefined) ids.set(path, (id = next++));
        if (!states.has(id)) states.set(id, "fetching" as ClipState);
        return id;
      }) as ClipRegistry["acquire"],
      release: ((id: number) => void released.push(id)) as ClipRegistry["release"],
      state: ((id: number) => states.get(id) ?? "idle") as ClipRegistry["state"],
    });
    const r = musicRig(8, clips);
    const req = request(7, 1, 2); // one streamed, two decoded
    expect(r.ops.admitGroup(req).ok).toBe(true);
    expect(acquired).toEqual(["music/d0.wav", "music/d1.wav"]); // loading starts at admission, not at the PLAY
    r.ops.primeGroup(req);
    expect(r.ops.primedState(7)).toMatchObject({ of: 3, ready: false });
    states.set(ids.get("music/d0.wav")!, "ready");
    expect(r.ops.primedState(7)!.primed).toBe(1);
    states.set(ids.get("music/d1.wav")!, "failed"); // a failed clip must not hold the group for ever
    expect(r.ops.primedState(7)).toMatchObject({ primed: 2, of: 3, ready: false }); // the stream still waits for its ring
    // Holds are dropped by a cancel.
    r.ops.cancelGroup(7);
    expect(released.sort()).toEqual([...ids.values()].sort());
    r.backend.dispose();
  });

  it("a decoded-only group is ready once resident; the stamp's PLAYs take their own references and the holds go (F-7b)", () => {
    const states = new Map<number, ClipState>();
    const released: number[] = [];
    let acquires = 0;
    const clips = fakeClips({
      acquire: (() => {
        acquires++;
        const id = 50 + (acquires % 2);
        if (!states.has(id)) states.set(id, "fetching" as ClipState);
        return id;
      }) as ClipRegistry["acquire"],
      release: ((id: number) => void released.push(id)) as ClipRegistry["release"],
      state: ((id: number) => states.get(id) ?? "idle") as ClipRegistry["state"],
    });
    const r = musicRig(8, clips);
    const req = request(8, 0, 2);
    r.ops.admitGroup(req);
    expect(acquires).toBe(2);
    expect(r.ops.primedState(8)).toMatchObject({ primed: 0, of: 2, ready: false });
    states.set(50, "ready");
    states.set(51, "ready");
    expect(r.ops.primedState(8)).toMatchObject({ primed: 2, of: 2, ready: true });
    expect(released).toEqual([]);
    r.ops.stampGroup({ group: 8, at: 1 });
    expect(acquires).toBe(4); // two PLAYs, each with its own reference
    expect(released).toHaveLength(2); // the admission holds
    r.ops.cancelGroup(8);
    expect(released).toHaveLength(2); // nothing released twice
    r.backend.dispose();
  });

  it("invalidateClip tells the worker and forgets the path as held, so the next prime sends its bytes (P8)", async () => {
    const r = musicRig(8);
    const a = request(3, 2);
    r.ops.admitGroup(a);
    r.ops.primeGroup(a);
    await flush();
    r.ops.cancelGroup(3);
    r.fetched.length = 0;
    const b = request(4, 2);
    r.ops.admitGroup(b);
    r.ops.primeGroup(b);
    await flush();
    expect(r.fetched).toEqual([]); // both paths are held by the worker
    r.ops.cancelGroup(4);
    r.backend.invalidateClip("music/s0.ogg");
    expect(r.invalidated).toEqual(["music/s0.ogg"]);
    const c = request(5, 2);
    r.ops.admitGroup(c);
    r.ops.primeGroup(c);
    await flush();
    expect(r.fetched).toEqual(["music/s0.ogg"]);
    r.backend.dispose();
  });

  it("a worker musicWarn warns once per instance and counts (F-5)", () => {
    const r = musicRig(8);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const req = request(3, 1);
      r.ops.admitGroup(req);
      r.ops.primeGroup(req); // subscribes the decoder's replies
      expect(r.ops.debugView().encodedOverBudget).toBe(0);
      const msg = { type: "musicWarn", cause: "encodedOverBudget", instance: 9, bytes: 200, budget: 100 } as const;
      r.say(msg);
      r.say(msg);
      r.say({ ...msg, instance: 10 });
      expect(r.ops.debugView().encodedOverBudget).toBe(3);
      const ours = warn.mock.calls.filter((c) => String(c[0]).includes("encoded cache budget"));
      expect(ours).toHaveLength(2);
      expect(String(ours[0]![0])).toContain("200 bytes");
    } finally {
      warn.mockRestore();
      r.backend.dispose();
    }
  });

  it("primeGroup: one message per group, bytes only for paths the worker doesn't hold, protect and budget; needBytes resends", async () => {
    const r = musicRig(8);
    const req = request(3, 3);
    expect(r.ops.admitGroup(req).ok).toBe(true);
    r.ops.primeGroup(req, { protect: ["music/s0.ogg"] });
    await flush();
    expect(r.primes).toHaveLength(1);
    const p = r.primes[0]!;
    expect(p).toMatchObject({ instance: 9, group: 3, retarget: false, protect: ["music/s0.ogg"], budgetBytes: encodedBudgetBytes(8) });
    expect(encodedBudgetBytes(8)).toBe(48 * 1024 * 1024);
    expect(encodedBudgetBytes(16)).toBe(160 * 1024 * 1024);
    expect(p.members.map((m) => [m.asset, m.epoch, m.startFrame, m.music, m.bytes !== undefined])).toEqual([
      ["music/s0.ogg", 1, 4800, true, true],
      ["music/s1.ogg", 1, 4800, true, true],
      ["music/s2.ogg", 1, 4800, true, true],
    ]);
    // The same paths again for the instance: no bytes, no fetch.
    r.ops.cancelGroup(3);
    expect(r.cancels).toEqual([3]);
    const again = request(4, 2);
    r.ops.admitGroup(again);
    r.fetched.length = 0;
    r.ops.primeGroup(again);
    expect(r.primes).toHaveLength(2); // posted at once: nothing to fetch
    expect(r.fetched).toEqual([]);
    expect(r.primes[1]!.members.every((m) => m.bytes === undefined)).toBe(true);
    // The worker evicted one: resend only it, with bytes, retarget false.
    r.say({ type: "needBytes", group: 4, members: [{ streamId: r.primes[1]!.members[1]!.streamId, asset: "music/s1.ogg" }] });
    await flush();
    expect(r.primes).toHaveLength(3);
    expect(r.primes[2]!.retarget).toBe(false);
    expect(r.primes[2]!.members.map((m) => [m.asset, m.bytes !== undefined])).toEqual([["music/s1.ogg", true]]);
    // A released instance's paths are no longer known to be held.
    r.ops.releaseInstance(9);
    r.ops.cancelGroup(4);
    r.ops.admitGroup(request(5, 1));
    r.ops.primeGroup(request(5, 1));
    await flush();
    expect(r.primes[3]!.members[0]!.bytes).toBeDefined();
    r.backend.dispose();
  });

  it("primed counts only the epoch main last sent; a re-target bumps the epochs of moved members", async () => {
    const r = musicRig(8);
    const req = request(2, 2, 1);
    r.ops.admitGroup(req);
    r.ops.primeGroup(req);
    await flush();
    expect(r.ops.primedState(2)).toEqual({ group: 2, primed: 1, of: 3, ready: false });
    const ids = r.primes[0]!.members.map((m) => m.streamId);
    r.status({ musicRings: [{ streamId: ids[0]!, epochFlags: (1 << 30) | 1 }, { streamId: ids[1]!, epochFlags: 1 }] });
    r.ops.beginFrame();
    expect(r.ops.primedState(2)!.primed).toBe(2);
    // Re-target to a new start frame: new epochs, and a STATUS of the old epoch doesn't count.
    const moved = request(2, 2, 1);
    for (const m of moved.members) m.startFrame = 9600;
    r.ops.primeGroup(moved, { retarget: true });
    await flush();
    const rt = r.primes[1]!;
    expect(rt.retarget).toBe(true);
    expect(rt.members.map((m) => [m.epoch, m.startFrame])).toEqual([[2, 9600], [2, 9600]]);
    r.status({ musicRings: [{ streamId: ids[0]!, epochFlags: (1 << 30) | 1 }, { streamId: ids[1]!, epochFlags: (1 << 30) | 1 }] });
    r.ops.beginFrame();
    expect(r.ops.primedState(2)!.primed).toBe(1);
    r.status({ musicRings: r.ringsOf(2).slice(-2) });
    r.ops.beginFrame();
    expect(r.ops.primedState(2)).toEqual({ group: 2, primed: 3, of: 3, ready: true });
    r.backend.dispose();
  });

  it("Ê: seeded at 40 ms, sampled from the primeGroup call to the STATUS showing every member primed, 0.5 up and 0.1 down, not while hidden", async () => {
    const r = musicRig(8);
    let now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    expect(r.ops.primeEmaMs).toBe(PRIME_EMA_SEED_MS);
    const prime = async (group: number, ms: number) => {
      const req = request(group, 2);
      r.ops.admitGroup(req);
      r.ops.primeGroup(req);
      await flush();
      // A STATUS with half primed: no sample yet.
      r.status({ musicRings: r.ringsOf(group).slice(0, 1) });
      now += ms / 2;
      r.ops.beginFrame();
      now += ms / 2;
      r.status({ musicRings: r.ringsOf(group) });
      r.ops.beginFrame();
      r.ops.beginFrame(); // a second call in the frame: no second sample
      r.ops.cancelGroup(group);
    };
    await prime(1, 100); // up: 40 + 0.5 × 60 = 70
    expect(r.ops.primeEmaMs).toBeCloseTo(70, 9);
    await prime(2, 20); // down: 70 + 0.1 × (20 - 70) = 65
    expect(r.ops.primeEmaMs).toBeCloseTo(65, 9);
    r.backend.setHidden(true);
    await prime(3, 500); // hidden: not sampled
    expect(r.ops.primeEmaMs).toBeCloseTo(65, 9);
    r.backend.setHidden(false);
    r.ops.resetPrimeEma();
    expect(r.ops.primeEmaMs).toBe(PRIME_EMA_SEED_MS);
    vi.restoreAllMocks();
    r.backend.dispose();
  });

  it("stamp: every member's PLAY back to back with the gate (id, size), fadeZero and the start frame; then the fades", async () => {
    const r = musicRig(8);
    const req = request(7, 2, 1);
    r.ops.admitGroup(req);
    r.ops.primeGroup(req);
    await flush();
    r.tick(0.016);
    r.posted.take();
    const voices = r.ops.stampGroup({ group: 7, at: 2, fades: [{ member: 2, fade: { to: 1, seconds: 0.5, law: "equalPowerIn" } }] });
    expect(voices).toHaveLength(3);
    expect(voices.every((v) => v !== null)).toBe(true);
    // An ordinary PLAY afterwards is ungated.
    const sfx = r.backend.play({ path: "sfx.wav", url: "sfx.wav", loop: false, stream: false, bus: "SFX" })!;
    r.tick(0.016);
    const batches = r.posted.take();
    const recs = batches.flatMap((b) => b.records);
    const playOf = (id: number) => {
      const x = recs.find((y) => y.opcode === Op.PLAY && y.voiceId === id)!;
      return readPlay(x.view, x.off);
    };
    const ids = voices.map((v) => (v as { id: number }).id);
    expect(recs.filter((x) => x.opcode === Op.PLAY)).toHaveLength(4);
    // The group's PLAYs go in one batch (a group is never split across two).
    expect(batches.filter((b) => b.records.some((x) => x.opcode === Op.PLAY && ids.includes(x.voiceId)))).toHaveLength(1);
    const plays = ids.map(playOf);
    // Each member's PLAY is gated with the group's id and size.
    for (const a of plays) {
      expect(gateGroupId(a.gate)).toBe(7);
      expect(gateGroupSize(a.gate)).toBe(3);
      expect(a.startOffsetFrames).toBe(4800);
    }
    expect(PLAY_FLAGS_FADE_ZERO).toBe(0x100);
    expect(plays.map((a) => (a.flags & PLAY_FLAGS_FADE_ZERO) !== 0)).toEqual([false, false, true]);
    // Streamed members play the streams musicOps primed.
    expect(plays.slice(0, 2).map((a) => a.clip)).toEqual(r.primes[0]!.members.map((m) => m.streamId));
    expect(recs.filter((x) => x.opcode === Op.FADE).map((x) => x.voiceId)).toEqual([ids[2]]);
    for (const id of ids) expect(r.ops.ownsVoice(id)).toBe(true);
    expect(playOf(sfx.id).gate).toBe(0);
    expect(playOf(sfx.id).flags & PLAY_FLAGS_FADE_ZERO).toBe(0);
    r.backend.dispose();
  });

  it("group starts, ends and refusals reach onGroupEvent at the next beginFrame; a freed member closes its ring", async () => {
    const r = musicRig(8);
    const req = request(5, 1, 1);
    r.ops.admitGroup(req);
    r.ops.primeGroup(req);
    await flush();
    const voices = r.ops.stampGroup({ group: 5, at: 1 });
    r.status({ groupStarts: [{ groupId: 5, flags: 1, slipFrames: 256, startFrameLo: 1000, startFrameHi: 0 }] });
    r.ops.beginFrame();
    expect(r.events).toEqual([{ kind: "start", group: 5, late: true, slipFrames: 256, startFrame: 1000 }]);
    expect(r.ops.debugView().groups).toEqual([{ id: 5, state: "playing", primed: 1, of: 2 }]);
    const stream = r.primes[0]!.members[0]!.streamId;
    r.backend.streams.streamEvent(stream, StreamEvent.Starved);
    (voices[0] as { stop(f?: number): void }).stop(0);
    // The core reports it ended; the frame frees it.
    r.status({ ended: [(voices[0] as { id: number }).id] });
    r.tick(0.016);
    expect(r.closes).toContain(stream);
    expect(r.ops.debugView().poolUsed).toBe(0);
    r.ops.beginFrame();
    expect(r.events.slice(1)).toEqual([
      { kind: "starve", group: 5, member: 0 },
      { kind: "end", group: 5, member: 0 },
    ]);
    r.backend.streams.streamEvent(0xffff0abc, STREAM_EVENT_MUSIC_FULL);
    expect(r.ops.debugView().musicRingRefused).toBe(1);
    r.backend.dispose();
  });

});

// ADR 0294: while the context is locked a music member's fades, parameter ramps and its group's prime are held (the mirror
// and the stamped log updated at once) and go out once the session may send: right after the member's PLAY for a member
// that waited in the locked queue, at the resume for one already on the core. A stop asked during an interruption is a
// stop-at-end fade, so before this the old voice kept playing after the resume.
describe("music group operations while the context is locked (ADR 0294)", () => {
  type Rec = { opcode: number; voiceId: number; view: DataView; off: number };
  const recsOf = (r: ReturnType<typeof musicRig>): Rec[] => r.posted.take().flatMap((b) => b.records as Rec[]);
  const fadesOf = (recs: Rec[], id: number) => recs.filter((x) => x.opcode === Op.FADE && x.voiceId === id).map((x) => readFade(x.view, x.off));
  const indexOf = (recs: Rec[], op: number, id: number) => recs.findIndex((x) => x.opcode === op && x.voiceId === id);

  it("a member queued while locked takes its first fade and a stop after its PLAY when the context resumes", () => {
    const r = musicRig(8);
    r.lock();
    r.tick(0.016);
    const req = request(7, 0, 1);
    expect(r.ops.admitGroup(req).ok).toBe(true);
    r.ops.primeGroup(req);
    const [v] = r.ops.stampGroup({ group: 7, at: 1, fades: [{ member: 0, fade: { to: 1, seconds: 0.5, law: "equalPowerIn" } }] }) as CoreVoiceLike[];
    expect(v!.reason).toBe("locked");
    v!.fadeShaped({ to: 0, seconds: 0.25, law: "equalPowerOut", stopAtEnd: true });
    r.tick(0.016);
    const locked = recsOf(r);
    expect(locked.filter((x) => x.voiceId === v!.id)).toEqual([]); // nothing reaches the suspended core
    r.gesture();
    r.tick(0.016);
    const recs = recsOf(r);
    const play = indexOf(recs, Op.PLAY, v!.id);
    expect(play).toBeGreaterThanOrEqual(0);
    const fades = fadesOf(recs, v!.id);
    // The asap stop sorts before the fade stamped at 1 s (a batch is in frame order); both follow the PLAY.
    expect(fades.map((f) => [f.target, (f.flags & FADE_FLAGS_STOP_AT_END) !== 0])).toEqual([[0, true], [1, false]]);
    expect(indexOf(recs, Op.FADE, v!.id)).toBeGreaterThan(play);
    // Sent once: a later frame repeats nothing.
    r.tick(0.016);
    expect(fadesOf(recsOf(r), v!.id)).toEqual([]);
    r.backend.dispose();
  });

  it("a member already on the core when the context is interrupted takes a stop and a parameter ramp asked meanwhile on resume", () => {
    const r = musicRig(8);
    r.tick(0.016);
    const req = request(7, 0, 1);
    r.ops.admitGroup(req);
    r.ops.primeGroup(req);
    const [v] = r.ops.stampGroup({ group: 7, at: 0 }) as CoreVoiceLike[];
    r.tick(0.016);
    expect(indexOf(recsOf(r), Op.PLAY, v!.id)).toBeGreaterThanOrEqual(0);
    r.lock();
    r.tick(0.016);
    v!.paramsShaped({ gain: 0.5, seconds: 0.1 });
    v!.fadeShaped({ to: 0, seconds: 0.25, law: "equalPowerOut", stopAtEnd: true });
    r.tick(0.016);
    expect(recsOf(r).filter((x) => x.voiceId === v!.id)).toEqual([]);
    r.gesture();
    r.tick(0.016);
    const recs = recsOf(r);
    expect(recs.filter((x) => x.voiceId === v!.id && (x.opcode === Op.FADE || x.opcode === Op.SET_PARAMS)).map((x) => x.opcode)).toEqual([Op.SET_PARAMS, Op.FADE]);
    expect(fadesOf(recs, v!.id).map((f) => (f.flags & FADE_FLAGS_STOP_AT_END) !== 0)).toEqual([true]);
    r.backend.dispose();
  });

  it("a member freed while locked sends nothing on resume", () => {
    const r = musicRig(8);
    r.lock();
    r.tick(0.016);
    const req = request(7, 0, 1);
    r.ops.admitGroup(req);
    r.ops.primeGroup(req);
    const [v] = r.ops.stampGroup({ group: 7, at: 1 }) as CoreVoiceLike[];
    v!.fadeShaped({ to: 0.5, seconds: 0.25, law: "linear" });
    v!.stop(0);
    r.gesture();
    r.tick(0.016);
    expect(recsOf(r).filter((x) => x.voiceId === v!.id)).toEqual([]);
    r.backend.dispose();
  });

  it("a group primed while locked is posted to the decoder once the context resumes", async () => {
    const r = musicRig(8);
    r.lock();
    r.tick(0.016);
    const req = request(7, 1);
    r.ops.admitGroup(req);
    r.ops.primeGroup(req);
    await flush();
    expect(r.primes).toHaveLength(0);
    r.gesture();
    r.tick(0.016);
    await flush();
    expect(r.primes.map((p) => p.group)).toEqual([7]);
    r.backend.dispose();
  });
});

/** The voice members the tests above read. */
type CoreVoiceLike = { id: number; reason: string | null; fadeShaped(f: { to: number; seconds: number; law: "linear" | "equalPowerIn" | "equalPowerOut"; stopAtEnd?: boolean }): void; paramsShaped(p: { gain?: number; seconds: number }): void; stop(f?: number): void };

/** CoreMusicOps alone, through its own interface: over a voice table and a command writer on a recording link the test owns. */
function opsRig(session: { maySend: boolean; mayQueue: boolean } = { maySend: true, mayQueue: true }) {
  const table = new VoiceTable(16);
  const posted: ArrayBuffer[] = [];
  const link = { batchPool: { acquire: () => new ArrayBuffer(64 * 1024), release: () => true }, nextSeq: () => 1, post: (b: ArrayBuffer) => void posted.push(b.slice(0)) };
  const writer = new CommandWriter(link as never, 48_000);
  const clockMap = new ClockMap(fakeHostClock(), 48_000);
  const ops = new CoreMusicOps({
    table,
    writer,
    mirror: new StatusMirror(table, 48_000),
    clockMap,
    streams: {} as never,
    worklet: {} as never,
    decoder: () => ({}) as never,
    fetchBytes: async () => new ArrayBuffer(0),
    clips: fakeClips(),
    play: () => null,
    session,
    musicRings: () => 0,
    sampleRate: () => 48_000,
    warnOnce: createWarnOnce(() => {}),
    // As the backend's (`CoreVoices.setStemLevel`): the level into the table.
    setStemLevel: (i, level, at, now, ramp, shape) => table.setStemLevel(i, level, at, now, ramp, shape),
  });
  /** A live voice on the Music bus. */
  const voice = () => table.allocate(1, 128, 1, VoiceState.PLAYING, 1);
  /** The SET_PARAMS records the writer sent since the last call: gain and absolute frame (-1 asap). */
  const params = () => {
    writer.flush(clockMap.nextFirstFrame());
    return posted.splice(0).flatMap((b) => batchRecords(b)?.records ?? []).filter((x) => x.opcode === Op.SET_PARAMS).map((x) => ({ gain: readSetParams(x.view, x.off).gain, at: x.frame }));
  };
  return { table, ops, clockMap, voice, params };
}

describe("a voice's stamped ramps and stem level, as musicOps keeps them (ADR 0166 Z4, F-9b)", () => {
  it("ADR 0294: asked while the session may not send, a ramp is logged and mirrored at once and its record waits for sendHeld", () => {
    const session = { maySend: false, mayQueue: true };
    const r = opsRig(session);
    const id = r.voice();
    const i = id & 0xffff;
    const t = r.table;
    t.gain[i] = 0.8;
    r.ops.fadeShaped(id, { to: 0.25, seconds: 0, law: "linear" });
    r.ops.paramsShaped(id, { gain: 0.5, seconds: 0 });
    expect([t.fadeGain[i], t.stampedCount[i], t.stemDry[i]]).toEqual([0.25, 2, 0.5]); // the mirror and the log, now
    expect(r.params()).toEqual([]);
    r.ops.sendHeld(); // still may not send: nothing
    expect(r.params()).toEqual([]);
    session.maySend = true;
    r.ops.sendHeld();
    expect(r.params()).toEqual([{ gain: expect.closeTo(0.4, 6), at: -1 }]);
    r.ops.sendHeld();
    expect(r.params()).toEqual([]); // sent once
  });

  it("ADR 0294: during a rebuild nothing is held for a voice on the core (its REPLAY restores the log)", () => {
    const session = { maySend: false, mayQueue: false };
    const r = opsRig(session);
    const id = r.voice();
    r.ops.paramsShaped(id, { gain: 0.5, seconds: 0 });
    expect(r.table.stampedCount[id & 0xffff]).toBe(1);
    session.maySend = session.mayQueue = true;
    r.ops.sendHeld();
    expect(r.params()).toEqual([]);
  });

  it("fadeShaped logs the stamped ramp with the level it starts from (Z4: REPLAY restores it)", () => {
    const r = opsRig();
    const id = r.voice();
    const i = id & 0xffff;
    const t = r.table;
    t.fadeGain[i] = 0; // a fadeZero member
    r.ops.fadeShaped(id, { to: 1, seconds: 0.5, law: "equalPowerIn" });
    expect(t.stampedCount[i]).toBe(1);
    expect(t.stampedFrom[i * 4]).toBe(0);
    expect(t.stampedTo[i * 4]).toBe(1);
    // A second fade at the first one's end starts from 1.
    const end = t.stampedEnd[i * 4]!;
    vi.spyOn(r.clockMap, "stampFor").mockImplementation((f) => f);
    vi.spyOn(r.clockMap, "frameOfTime").mockImplementation(() => end + 10);
    r.ops.fadeShaped(id, { to: 0, seconds: 1, law: "equalPowerOut", at: 99, stopAtEnd: true });
    expect(t.stampedCount[i]).toBe(2);
    expect(t.stampedFrom[i * 4 + 1]).toBe(1);
    expect(t.stampedFlags[i * 4 + 1]).toBe(1);
    vi.restoreAllMocks();
  });

  it("F-9b: paramsShaped keeps the stem's level in the table; its multiplier is over the dry gain without it", () => {
    const r = opsRig();
    const id = r.voice();
    const i = id & 0xffff;
    const t = r.table;
    t.gain[i] = 0.8;
    // Asap: the level at once, for the dry gain and audibility.
    r.ops.paramsShaped(id, { gain: 0.5, seconds: 0 });
    expect(t.stemDry[i]).toBe(0.5);
    expect(t.stemGain[i]).toBe(0.5);
    const sent = r.params();
    expect(sent[0]!.gain).toBeCloseTo(0.4, 6); // 0.5 x 0.8, not x 0.5 again
    // Stamped fall: pending until its frame (dry and audibility stay 0.5); the multiplier is still over 0.8 alone.
    const now = r.clockMap.framesNow();
    vi.spyOn(r.clockMap, "stampFor").mockImplementation((f) => f);
    vi.spyOn(r.clockMap, "frameOfTime").mockImplementation(() => now + 48_000);
    r.ops.paramsShaped(id, { gain: 0.25, seconds: 0.02, at: 1 });
    expect(r.params()).toEqual([{ gain: expect.closeTo(0.2, 6), at: now + 48_000 }]);
    expect(t.stemDry[i]).toBe(0.5);
    expect(t.stemGain[i]).toBe(0.5);
    expect(t.stemCount[i]).toBe(1);
    expect(t.stemRamp[i * 4]).toBe(Math.round(0.02 * r.clockMap.sampleRate));
    // The logged ramp starts from the stem's level (0.5 x 0.8).
    expect(t.stampedFrom[i * 4 + t.stampedCount[i]! - 1]).toBeCloseTo(0.4, 6);
    // A stamped rise counts for audibility at once.
    r.ops.paramsShaped(id, { gain: 2, seconds: 0, at: 1 });
    expect(t.stemGain[i]).toBe(2);
    expect(t.stemDry[i]).toBe(0.5);
    t.resolveStems(now + 48_000);
    expect(t.stemDry[i]).toBe(2);
    vi.restoreAllMocks();
  });
});

// --- P1: the real core (loopback host): a decoded group starts on its stamp's frame --------------------------------

describe("a stamped group on the loopback host (ADR 0166 P1)", () => {
  it("every decoded member starts on the stamp's frame, together", async (ctx) => {
    const FRAMES = 48_000;
    const dc = new Float32Array(FRAMES).fill(0.25);
    // ADR 0221: the production assembly on the loopback, with its own mixer; no limiter look-ahead (output frames are core frames).
    const loop = await loopbackAudio({ mixer: "own", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 }, decode: () => ({ channelData: [dc] }) });
    if (!loop) return ctx.skip();
    const { backend } = loop;
    /** The core frame `out[0]` was rendered at. */
    const origin = loop.frame;
    const out: number[] = [];
    const step = async (n: number) => {
      for (let f = 0; f < n; f++) {
        loop.mainFrame(0.003);
        const { left } = loop.render(4);
        for (const s of left) out.push(s);
        await Promise.resolve();
      }
    };
    // Load the clip (a silent voice), then let the clock settle.
    backend.play({ path: "dc.wav", url: "dc.wav", loop: false, stream: false, bus: "Music", volume: 0 });
    await step(20);
    expect(out.every((s) => s === 0)).toBe(true);
    const member = (k: number) => ({ stem: `d${k}`, play: { path: "dc.wav", url: "dc.wav", loop: false, stream: false, bus: "Music" }, startFrame: 0, loop: false });
    const req = { instance: 1, group: 11, members: [member(0), member(1)] };
    expect(backend.music.admitGroup(req).ok).toBe(true);
    const at = backend.time + 0.1;
    const planned = backend.clockMap.frameOfTime(at);
    expect(backend.clockMap.stampFor(planned)).toBe(planned); // ahead of F_now: stamped, not asap
    const voices = backend.music.stampGroup({ group: 11, at });
    expect(voices.filter((v) => v !== null)).toHaveLength(2);
    await step(30);
    const first = out.findIndex((s) => s !== 0);
    expect(origin + first).toBe(planned);
    // Both members from that frame on: twice the clip's level (bus and master at unity).
    expect(out[first]).toBeCloseTo(out[first + 1000]!, 6);
    expect(out[first]!).toBeGreaterThan(0.25 * 1.5);
    backend.dispose();
  });
});

// --- F-16: a streamed stem's voice row (the core backend's `debug().voices`) ----------------------------------------------

describe("a streamed music stem's voice (F-16)", () => {

  it("reads playing, with its clip and playhead, once STATUS shows it moving; a starve reads waitingForData until it moves again", async () => {
    const r = musicRig(8);
    const req = request(3, 1);
    r.ops.admitGroup(req);
    r.ops.primeGroup(req);
    await flush();
    const [v] = r.ops.stampGroup({ group: 3, at: 0 }) as { id: number }[];
    const id = v!.id;
    const row = () => r.backend.debug().voices.find((x) => x.id === id)!;
    // Before it sounds: waiting for its data (the core holds the gated member until the group starts).
    expect(row().state).toBe("waitingForData");
    // Held at its start frame (the gate not yet open): still waiting.
    r.status({ currentFrame: 1024, playheads: [{ id, clipFrame: 4800 }] });
    expect(row().state).toBe("waitingForData");
    r.status({ currentFrame: 2048, playheads: [{ id, clipFrame: 4800 + 1024 }] });
    expect(row().state).toBe("playing");
    expect(row().clip).toBe("music/s0.ogg");
    expect(row().playheadSeconds).toBeCloseTo((4800 + 1024) / 48_000, 9);
    // A starve: waiting again (the mirror), and playing once the playhead moves on.
    r.status({ currentFrame: 3072, starved: [id], playheads: [{ id, clipFrame: 4800 + 1024 }] });
    expect(row().state).toBe("waitingForData");
    r.status({ currentFrame: 4096, playheads: [{ id, clipFrame: 4800 + 2048 }] });
    expect(row().state).toBe("playing");
    r.backend.dispose();
  });
});
