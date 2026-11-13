// A3.4a, the hard rebuild (architecture §3.6, §7; api-and-models §4.2 REPLAY, §9 row A3.4a: "a simulated trap restores
// voices; the 4th within 60 s goes silent with one warning"). End to end on the loopback host with the test-hooks wasm:
// a real trap inside `myco_audio_process`, the shell's catch, the host replacing its node and link (`respawn`), the
// registry re-sending clips and the backend replaying its voices, all through the real `AudioHost` and `CoreBackend`.
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import {
  ClipFormat,
  Kind,
  readBatchHeader,
  readEnvelope,
  readRecordHead,
  REPLAY_FLAGS_FIRST_CHUNK,
  REPLAY_FLAGS_LAST_CHUNK,
  writePlay,
  ASAP,
  readClipBegin,
} from "../wire.generated";
import { createClipRegistry, RESERVED_CLIP_FIRST } from "./clipRegistry";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { rebuildHost, watchForTraps } from "./recovery";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { PlayheadTracker, ReplayBuilder } from "./replay";
import { Unlock, type UnlockContext } from "./unlock";
import { VoiceFlag, VoiceTable, VoiceState } from "./voiceTable";

const RATE = 48_000;
/** A 1 s clip whose sample k is 0.9 k / CLIP_FRAMES: the output level tells the voice's position. */
const CLIP_FRAMES = 48_000;
const ramp = (): Float32Array => {
  const a = new Float32Array(CLIP_FRAMES);
  for (let k = 0; k < CLIP_FRAMES; k++) a[k] = (0.9 * k) / CLIP_FRAMES;
  return a;
};
const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

const hosts: AudioHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  vi.restoreAllMocks();
});

/** A fake running context with the loopback's rate. */
function fakeContext() {
  const ctx = {
    state: "running",
    sampleRate: RATE,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => {
      ctx.state = "closed";
      return Promise.resolve();
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return ctx;
}

/**
 * The real host on the loopback: an `AudioHost` whose node is a fake (an EventTarget, so `processorerror` can be
 * fired) and whose `respawn` makes a new loopback core; the real core backend with a registry whose clips are `ramp()`
 * (or a constant 0.5 for paths starting "c"), traps watched with a fake clock for the rate limit and a warn spy.
 */
async function rig() {
  const testing = await import("../testing");
  const loop = await testing.createLoopbackHost({ testHooks: true });
  const context = fakeContext();
  const firstNode = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
  const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
  const host = AudioHost._create({
    context: context as unknown as AudioContext,
    node: firstNode,
    link: loop.link,
    unlock,
    preset: presetFromSettings(defaultAudioSettings()),
    respawn: () => loop.respawn(),
  });
  hosts.push(host);
  const link = loop.link;
  const decodes: string[] = [];
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
    decodeWorker: fakeDecoder((encoded) => {
      const path = new TextDecoder().decode(encoded);
      decodes.push(path);
      return { frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [path.startsWith("c") ? new Float32Array(CLIP_FRAMES).fill(0.5) : ramp()] };
    }),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const mixer = new Mixer(defaultAudioSettings());
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  const now = { ms: 0 };
  const warn = vi.fn();
  watchForTraps(host, { now: () => now.ms, warn });
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** `n` frames of 4 quanta; returns every rendered left sample and the output frame of the first one. */
  const step = async (n: number) => {
    const start = loop.frame;
    const out: number[] = [];
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      const { left } = loop.renderQuanta(4);
      for (const v of left) out.push(v);
      await settle();
    }
    return { start, out, last: out[out.length - 1]! };
  };
  /** Steps until the last sample is non-zero (at most `max` frames); returns how many frames that took. */
  const untilSound = async (max = 60) => {
    for (let f = 1; f <= max; f++) {
      const { last } = await step(1);
      if (last !== 0) return f;
    }
    return -1;
  };
  return { loop, host, backend, clips, mixer, now, warn, step, untilSound, decodes, firstNode };
}

describe("the hard rebuild on the loopback host (A3.4a)", () => {
  it("a simulated trap restores the voices: the same handles and ids, playing on, at the right position", async () => {
    const r = await rig();
    const { loop, host, backend, step } = r;
    const music = backend.play(req("music.wav"))!;
    const constant = backend.play(req("const.wav", { volume: 0.5 }))!;
    await step(4);
    const before = await step(1);
    // ramp (0..0.9) + 0.5 × 0.5: the ramp's level tells where the voice is in its clip.
    expect(before.last).toBeGreaterThan(0.25);
    const ids = backend.debug().voices.map((v) => v.id).sort();
    const posBefore = ((before.last - 0.25) / 0.9) * CLIP_FRAMES;
    const frameBefore = before.start + before.out.length - 1;

    loop.trapNext();
    const during = await step(2);
    // The shell caught the trap: silence from the next quantum, one trap counted, the host recovering.
    expect(during.out.slice(-128).every((v) => v === 0)).toBe(true);
    expect(host.health.traps).toBe(1);
    expect(backend.status).toBe("running");
    expect(music.playing).toBe(true);
    expect(constant.playing).toBe(true);
    expect(music.reason).toBeNull();

    const frames = await r.untilSound();
    expect(frames).toBeGreaterThan(0);
    expect(host.health.recoveries).toBe(1);
    expect(host.health.rebuilds).toBe(0);
    expect(loop.cores).toBe(2);
    expect(host.rebuilding).toBe(false);
    await step(2);
    const after = await step(1);
    expect(backend.debug().voices.map((v) => v.id).sort()).toEqual(ids);
    expect(backend.debug().voices.every((v) => v.state === "playing")).toBe(true);
    expect(music.playing && constant.playing).toBe(true);
    // Resumed where it would be: the gap is skipped, not replayed late (within the asap estimate's few quanta).
    const frameAfter = after.start + after.out.length - 1;
    const expected = (posBefore + (frameAfter - frameBefore)) % CLIP_FRAMES;
    const posAfter = ((after.last - 0.25) / 0.9) * CLIP_FRAMES;
    // Measured: 128 frames (one quantum: an asap PLAY lands a quantum after the clock map's F_now).
    expect(Math.abs(posAfter - expected)).toBeLessThan(384);
    // Audio.debug(): the host's trap count survives the new core's STATUS (which starts at 0), plus the recoveries.
    const debug = backend.debug();
    expect(debug.counters.traps).toBe(1);
    expect(debug.core.recoveries).toBe(1);
    expect(backend.replayer.stats.replayed).toBe(2);
    backend.dispose();
  });

  it("the buses and MASTER are sent again: bus gain, master volume and a muted bus hold across the rebuild", async () => {
    const r = await rig();
    const { loop, backend, mixer, step } = r;
    backend.play(req("const.wav")); // 0.5 on SFX
    backend.play(req("c-music.wav", { bus: "Music" })); // 0.5 on Music, muted below
    mixer.bus("SFX").volume = 0.5;
    mixer.bus("Music").mute = true;
    backend.masterVolume = 0.5;
    await step(8);
    expect((await step(1)).last).toBeCloseTo(0.125, 5);
    loop.trapNext();
    expect(await r.untilSound()).toBeGreaterThan(0);
    await step(4);
    // A fresh core would have every gain at 1 (1.0 here); the replayed bus lanes (BUS_RAMP) and MASTER give 0.5 × 0.5 × 0.5 again.
    expect((await step(1)).last).toBeCloseTo(0.125, 5);
    backend.dispose();
  });

  it("plays made during the rebuild wait in the locked queue and start once the new core runs", async () => {
    const r = await rig();
    const { loop, backend, step } = r;
    backend.play(req("music.wav"));
    await step(5);
    loop.trapNext();
    await step(1);
    expect(backend.isRecovering).toBe(true);
    const late = backend.play(req("const.wav", { volume: 0.5, loop: false, oneShot: true }))!;
    expect(late.playing).toBe(true);
    expect(late.reason).toBe("locked");
    expect(await r.untilSound()).toBeGreaterThan(0);
    await step(3);
    expect(late.playing).toBe(true);
    expect(late.reason).toBeNull();
    expect(backend.debug().voices).toHaveLength(2);
    backend.dispose();
  });

  it("the clips go back to the new core (the music's first: higher priority), re-decoded from the kept bytes", async () => {
    const r = await rig();
    const { loop, backend, step, decodes } = r;
    backend.play(req("const.wav", { priority: 10 }));
    backend.play(req("music.wav", { priority: 200 }));
    await step(5);
    expect(decodes).toEqual(["const.wav", "music.wav"]);
    loop.trapNext();
    expect(await r.untilSound()).toBeGreaterThan(0);
    expect(decodes).toEqual(["const.wav", "music.wav", "music.wav", "const.wav"]);
    expect(backend.clips.residentIds()).toHaveLength(2);
    backend.dispose();
  });

  it("a voice stopped during the rebuild is freed, and a one-shot that would have ended is dropped", async () => {
    const r = await rig();
    const { loop, backend, step } = r;
    const music = backend.play(req("music.wav"))!;
    const shot = backend.play(req("const.wav", { loop: false, oneShot: true }))!;
    const keep = backend.play(req("const2.wav", { volume: 0.1 }))!;
    // 1 s one-shot: trap 10.7 ms before its end, so it has ended by the frame the replay would start it on.
    await step(91);
    expect(shot.playing).toBe(true);
    loop.trapNext();
    await step(1);
    music.stop();
    expect(music.playing).toBe(false);
    expect(await r.untilSound()).toBeGreaterThan(0);
    await step(2);
    expect(shot.playing).toBe(false);
    expect(shot.reason).toBeNull(); // ended, as it would have
    expect(keep.playing).toBe(true);
    expect(backend.replayer.stats).toMatchObject({ replayed: 1, dropped: 2, failed: 0 });
    expect(backend.debug().voices.map((v) => v.id)).toEqual([keep.id]);
    expect(backend.table.liveCount).toBe(1);
    backend.dispose();
  });

  it("the 4th trap within 60 s goes silent with exactly one warning; no rebuild, no switch", async () => {
    const r = await rig();
    const { loop, host, backend, now, warn, step } = r;
    const music = backend.play(req("music.wav"))!;
    await step(5);
    for (let n = 1; n <= 3; n++) {
      loop.trapNext();
      expect(await r.untilSound()).toBeGreaterThan(0);
      expect(host.health.recoveries).toBe(n);
      await step(2);
      now.ms += 10_000;
    }
    expect(loop.cores).toBe(4);
    expect(warn).not.toHaveBeenCalled();
    loop.trapNext();
    const silent = await step(20);
    expect(silent.out.slice(-1024).every((v) => v === 0)).toBe(true);
    expect(loop.cores).toBe(4);
    expect(host.status).toBe("failed");
    expect(backend.status).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/failed/);
    expect(music.playing).toBe(false);
    expect(music.reason).toBe("failed");
    expect(backend.play(req("music.wav"))).toBeNull();
    // Nothing more happens: a later request is "unavailable" and doesn't warn again.
    await expect(rebuildHost(host, "trap")).resolves.toBe("unavailable");
    await expect(rebuildHost(host, "stall")).resolves.toBe("unavailable");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(backend.debug().counters.traps).toBe(4);
    expect(backend.debug().core.recoveries).toBe(3);
    backend.dispose();
  });

  it("a trap after the window starts a fresh count", async () => {
    const r = await rig();
    const { loop, host, backend, now, warn, step } = r;
    backend.play(req("music.wav"));
    await step(5);
    for (let n = 1; n <= 3; n++) {
      loop.trapNext();
      expect(await r.untilSound()).toBeGreaterThan(0);
      await step(2);
      now.ms += 1_000;
    }
    now.ms += 60_000;
    loop.trapNext();
    expect(await r.untilSound()).toBeGreaterThan(0);
    expect(host.health.recoveries).toBe(4);
    expect(host.status).toBe("running");
    expect(warn).not.toHaveBeenCalled();
    backend.dispose();
  });

  it("ADR 0171 (K0): a rebuild reports a GAP at its start and an EPOCH with its reason to the backend's profile sink", async () => {
    const r = await rig();
    const { backend, step, firstNode } = r;
    const calls: string[] = [];
    const sink = { ...NULL_PROFILE_SINK, gap: (reason: string) => calls.push(`gap:${reason}`), epoch: (reason: string) => calls.push(`epoch:${reason}`) };
    backend.setProfileSink(sink);
    try {
      backend.play(req("const.wav"));
      await step(5);
      firstNode.dispatchEvent(new Event("processorerror"));
      expect(await r.untilSound()).toBeGreaterThan(0);
      expect(calls).toEqual(["gap:rebuild", "epoch:trap"]);
    } finally {
      backend.setProfileSink(null);
      backend.dispose();
    }
  });

  it("processorerror on the node takes the same path; other reasons count as rebuilds", async () => {
    const r = await rig();
    const { host, backend, step, firstNode } = r;
    backend.play(req("const.wav"));
    await step(5);
    firstNode.dispatchEvent(new Event("processorerror"));
    expect(host.health.traps).toBe(1);
    expect(host.rebuilding).toBe(true);
    expect(await r.untilSound()).toBeGreaterThan(0);
    expect(host.health.recoveries).toBe(1);
    const stall = rebuildHost(host, "stall");
    // Concurrent requests share the rebuild in flight.
    expect(rebuildHost(host, "device")).toBe(stall);
    for (let k = 0; k < 20 && host.rebuilding; k++) await step(1);
    await expect(stall).resolves.toBe("rebuilt");
    expect(host.health.rebuilds).toBe(1);
    expect(await r.untilSound()).toBeGreaterThan(0);
    backend.dispose();
  });

  it("a host that can't make a new node fails silent with the one warning", async () => {
    const r = await rig();
    const context = fakeContext();
    const node = { connect() {}, disconnect() {}, port: { postMessage() {}, onmessage: null } };
    const host = AudioHost._create({
      context: context as unknown as AudioContext,
      node: node as unknown as AudioWorkletNode,
      link: r.loop.link,
      unlock: new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext }),
      preset: presetFromSettings(defaultAudioSettings()),
    });
    hosts.push(host);
    const warn = vi.fn();
    watchForTraps(host, { warn });
    await expect(rebuildHost(host, "device")).resolves.toBe("unavailable");
    expect(host.status).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    r.backend.dispose();
  });
});

describe("REPLAY messages (api-and-models §4.2)", () => {
  /** Posts collected by a fake port. */
  const port = () => {
    const posted: ArrayBuffer[] = [];
    let seq = 0;
    return { posted, post: (b: ArrayBuffer) => void posted.push(b), nextSeq: () => seq++ };
  };
  const play = (id: number) => (view: DataView, off: number) =>
    writePlay(view, off, { voiceId: id, frameOffset: 0, clip: 1, bus: 0, flags: 0, group: 0, gate: 0, gain: 1, pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 24_000, score: 0, startOffsetFrames: id });

  it("splits at the record limit, in order, kind 12, bit1 on the first chunk of a RESET wave, bit2 on the last", () => {
    const b = new ReplayBuilder(56 * 3);
    for (let id = 1; id <= 7; id++) b.record(56, play(id));
    const p = port();
    expect(b.post(p, 4_800, true)).toBe(3);
    expect(b.count).toBe(0);
    const ids: number[] = [];
    p.posted.forEach((buffer, m) => {
      const view = new DataView(buffer);
      const env = readEnvelope(view, 0);
      expect(env.kind).toBe(Kind.REPLAY);
      expect(env.seq).toBe(m);
      expect(env.bodyBytes).toBe(buffer.byteLength - 16);
      const header = readBatchHeader(view, 0);
      expect(header.firstFrame).toBe(4_800);
      expect(header.flags).toBe((m === 0 ? REPLAY_FLAGS_FIRST_CHUNK : 0) | (m === 2 ? REPLAY_FLAGS_LAST_CHUNK : 0));
      for (let k = 0, off = 32; k < header.count; k++, off += 56) ids.push(readRecordHead(view, off).voiceId);
    });
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // A wave without RESET never carries bit1; one message holds 4,096 voices (229 KB) at the default limit.
    const big = new ReplayBuilder();
    for (let id = 1; id <= 4_096; id++) big.record(56, play(id));
    const q = port();
    expect(big.post(q, 0, false)).toBe(1);
    expect(readBatchHeader(new DataView(q.posted[0]!), 0)).toMatchObject({ count: 4_096, flags: REPLAY_FLAGS_LAST_CHUNK });
    expect(q.posted[0]!.byteLength).toBe(32 + 4_096 * 56);
    expect(ASAP).toBe(0xffffffff);
  });
});

describe("PlayheadTracker (architecture §7: last playhead + elapsed frames × pitch)", () => {
  it("advances at pitch × clip rate / context rate, re-anchors on a pitch change, freezes while paused", () => {
    const table = new VoiceTable(4);
    const id = table.allocate(0, 128, 0, VoiceState.PLAYING);
    const i = id & 0xffff;
    table.clip[i] = 7;
    const clips = { info: (clip: number) => (clip === 7 ? ({ sampleRate: 24_000 } as never) : null) };
    const t = new PlayheadTracker(table, clips, 48_000);
    t.start(i, 1_000, 100);
    expect(t.at(i, 1_000)).toBe(100);
    expect(t.at(i, 500)).toBe(100); // never before its anchor
    expect(t.at(i, 3_000)).toBe(100 + 2_000 * 0.5); // a 24 kHz clip at 48 kHz
    table.pitch[i] = 2;
    t.retime(i, 3_000);
    expect(t.at(i, 4_000)).toBe(1_100 + 1_000);
    table.flags[i]! |= VoiceFlag.PAUSED;
    t.retime(i, 4_000);
    expect(t.at(i, 10_000)).toBe(2_100);
    table.flags[i]! &= ~VoiceFlag.PAUSED;
    t.retime(i, 10_000);
    expect(t.at(i, 10_480)).toBe(2_580);
  });

  it("A3.4c: carries anchors across a context swap in Audio.time seconds; scales a position when the clip's rate changed", () => {
    const table = new VoiceTable(4);
    const id = table.allocate(0, 128, 0, VoiceState.PLAYING);
    const i = id & 0xffff;
    table.clip[i] = 7;
    let clipRate = 48_000;
    const clips = { info: (clip: number) => (clip === 7 ? ({ sampleRate: clipRate } as never) : null) };
    const t = new PlayheadTracker(table, clips, 48_000);
    // At 48 kHz, anchored at frame 48 000 (1 s on Audio.time with no offset) at clip frame 0.
    t.start(i, 48_000, 0);
    t.toTimeline(0);
    // A retime while carried is ignored (it would mix the old frames with the new).
    t.retime(i, 5);
    // The new context runs at 44.1 kHz and its frame 0 is Audio.time 1.5 s: the anchor is half a second before it.
    t.fromTimeline(44_100, 1.5);
    expect(t.anchorFrame[i]).toBeCloseTo(-22_050, 6);
    // At new frame 44 100 (Audio.time 2.5 s), 1.5 s after the anchor: 72 000 clip frames of the 48 kHz clip.
    expect(t.at(i, 44_100)).toBeCloseTo(72_000, 6);
    // Its clip came back decoded at 44.1 kHz instead: the same instant is 66 150 frames into it.
    clipRate = 44_100;
    expect(t.positionNow(i, 44_100)).toBeCloseTo(66_150, 6);
    // A new start anchors in the new frames at the new rates.
    t.start(i, 44_100, 66_150);
    expect(t.at(i, 88_200)).toBeCloseTo(66_150 + 44_100, 6);
  });
});

describe("ClipRegistry.resend (A3.4a)", () => {
  it("re-sends the HRIR first, then the clips in the given order, each from a fresh CLIP_BEGIN", async () => {
    const sent: ArrayBuffer[] = [];
    const clips = createClipRegistry({
      send: (m) => void sent.push(m),
      fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
      decodeWorker: fakeDecoder(async () => ({ frames: 256, channels: 1, sampleRate: RATE, channelData: [new Float32Array(256)] })),
      nextFrame: (cb) => cb(),
      nextQuantum: (cb) => cb(),
    });
    const a = clips.acquire("a.wav");
    const b = clips.acquire("b.wav");
    const c = clips.acquire("c.wav");
    clips.acquireReserved(RESERVED_CLIP_FIRST, { bytes: new ArrayBuffer(64), sampleRate: RATE, format: 2 });
    for (let k = 0; k < 10; k++) await Promise.resolve();
    for (const id of [a, b, c, RESERVED_CLIP_FIRST]) clips.applyClipEvent(id, 1);
    expect(clips.residentIds()).toHaveLength(4);
    sent.length = 0;
    clips.resend!([c, a]);
    expect(clips.state(a)).toBe("decoding"); // from the kept bytes: no fetch
    expect(clips.state(RESERVED_CLIP_FIRST)).toBe("copying");
    for (let k = 0; k < 20; k++) await Promise.resolve();
    const begins = sent.filter((m) => new DataView(m).getUint16(6, true) === Kind.CLIP_BEGIN).map((m) => readClipBegin(new DataView(m), 0).clipId);
    expect(begins).toEqual([RESERVED_CLIP_FIRST, c, a, b]);
    expect(clips.state(c)).toBe("copying");
    clips.applyClipEvent(c, 1);
    expect(clips.state(c)).toBe("ready");
  });
});
