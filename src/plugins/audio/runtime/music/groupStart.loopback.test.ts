// ADR 0166 C2b acceptance on the loopback host (the real core, wasm): a segment of 8 decoded stems is one gated group;
// the core's gate starts every member on one frame and reports the start in STATUS `groupStarts`, which reaches the
// run through the status reader, the mirror and `musicOps.beginFrame` (`routeGroupEvent`): the run turns from
// "stamped" to "playing". Each stem is a DC clip of its own level, so "one frame" reads off the output: silence up to
// the start frame, then one step to the sum of all eight, flat from there.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend, type AudioBackend } from "../backend";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame } from "./musicSystem";
import { _resetSegmentRuns, routeGroupEvent, setSegmentClipSource } from "./segmentRun";
import { planTick, requestStart } from "./planner";

const RATE = 48_000;
const FRAMES = 4 * RATE;
const STEMS = 8;
/** Stem k's level; the "encoded" bytes of `s{k}.wav` are (k + 1) × 8 long, which the fake decoder reads back. */
const level = (k: number): number => 0.01 * (k + 1);

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

describe("C2b: the group gate on the loopback host (ADR 0166 §4.3)", () => {
  it("8 stems start on one frame, and the group start turns the run to playing", async (ctx) => {
    const testing = await import("../testing");
    let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
    try {
      loop = await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } });
    } catch {
      return ctx.skip();
    }
    const [{ createClipRegistry }, { CoreBackend }, { Mixer }, { defaultAudioSettings }, { fakeDecoder }] = await Promise.all([
      import("../core/clipRegistry"),
      import("../core/coreBackend"),
      import("../../../../engine/audio/mixer"),
      import("../../../../engine/audio/settings"),
      import("../core/fakeDecoder"),
    ]);
    const link = loop.link;
    const clips = createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async (url: string) => new ArrayBuffer((Number(/s(\d)/.exec(url)![1]) + 1) * 8),
      decodeWorker: fakeDecoder(async (bytes) => ({ frames: FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(FRAMES).fill(level(bytes.byteLength / 8 - 1))] })),
      nextFrame: (cb) => cb(),
      nextQuantum: (cb) => cb(),
    });
    const host = { link, status: "running" as const, preset: { maxLogical: 64, maxMixed: 32 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as never };
    const mixer = new Mixer(defaultAudioSettings());
    const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer }) as unknown as AudioBackend & {
      clockMap: { frameOfTime(t: number): number };
      music: NonNullable<AudioBackend["music"]>;
      mirror: { groupsLate: number; maxSlipFrames: number };
      dispose(): void;
    };
    setAudioBackend(backend);
    backend.music.onGroupEvent = routeGroupEvent;
    const out: number[] = [];
    const step = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        mixer.update(0.003);
        backend.update(0.003);
        for (const s of loop.renderQuanta(4).left) out.push(s);
        await Promise.resolve();
      }
    };
    const paths = Array.from({ length: STEMS }, (_, k) => `s${k}.wav`);
    setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: false }), bus: () => "Music", facts: () => ({ frames: FRAMES, rate: RATE, channels: 1, gapless: true }) });
    // Load the clips (silent voices), then let them end.
    for (const path of paths) backend.play({ path, url: path, loop: false, stream: false, bus: "Music", volume: 0 });
    await step(20);
    const frame = (): MusicFrame => ({ backend, music: backend.music, now: backend.time, dt: 0.003, hidden: false });

    const { value } = parseAudioEvent({
      format: "myco.audioevent@1",
      bus: "Music",
      root: { type: "segment", id: "A", tracks: paths.map((clip, k) => ({ name: `t${k}`, clip })) },
    });
    const root = value.musicRoot as MusicNode;
    expect(root).toBeTruthy();
    const instance = { group: 7, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 }, getParameter: () => undefined } as unknown as EventInstance;
    const player = createMusicPlayer(instance, root);
    const silentUpTo = out.length;
    requestStart(player, { to: root, reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, frame());
    planTick(player, frame());
    const run = player.run!;
    expect(run.node.id).toBe("A");
    expect(run.stems).toHaveLength(STEMS);
    expect(run.stems.every((s) => s.voice !== null)).toBe(true);
    expect(run.state).toBe("stamped");
    const start = backend.clockMap.frameOfTime(run.startAt);
    for (let i = 0; i < 60 && out.length < start + 0.05 * RATE; i++) {
      planTick(player, frame());
      await step(1);
    }
    await step(2); // the STATUS that carries the start, read at the next frame
    expect(run.state).toBe("playing");

    // Silence until the start frame, then one step to all eight levels together.
    const sum = Array.from({ length: STEMS }, (_, k) => level(k)).reduce((a, b) => a + b, 0);
    const first = out.findIndex((s, i) => i >= silentUpTo && s !== 0);
    expect(first).toBe(start);
    const onset = out[start]!;
    let flat = 0;
    for (let i = start; i < start + 0.04 * RATE; i++) flat = Math.max(flat, Math.abs(out[i]! - onset));
    console.info(`C2b loopback: 8 stems at frame ${start}, onset ${onset.toFixed(6)} (sum of levels ${sum.toFixed(2)}), max deviation after ${flat}`);
    expect(flat).toBe(0);
    expect(onset).toBeCloseTo(sum, 4); // every stem is in the first sample
    expect(backend.mirror.groupsLate).toBe(0);
    backend.dispose();
  });
});
