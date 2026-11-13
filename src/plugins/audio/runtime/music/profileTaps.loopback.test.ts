// ADR 0171 (Rc3, api-and-models §5.6 kind 13): the music taps on the loopback host (real core), through a recording stub
// sink. The player's first segment is a transition from nothing (musicSystem's `tickPlayer`); a change A to B is reported
// once, past its cancel point (transition.ts `commit`); a player that began before the recorder reports no first segment.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend, type AudioBackend } from "../backend";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, MusicSwitchNode } from "../../../../engine/audio/musicFormat";
import { _resetMusicPlayers, createMusicPlayer, tickPlayer, type MusicFrame } from "./musicSystem";
import { _resetSegmentRuns, routeGroupEvent, setSegmentClipSource } from "./segmentRun";
import { requestTransition } from "./transition";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { taps } from "../mix/profileTaps";
import { recordingSink } from "../mix/recordingSink";

const RATE = 48_000;
const FRAMES = 4 * RATE;

const seg = (id: string): Record<string, unknown> => ({ type: "segment", id, value: id, gridOffset: 0, tracks: [{ name: "t", clip: `${id.toLowerCase()}.wav` }] });
function root(): MusicSwitchNode {
  const { value } = parseAudioEvent({
    format: "myco.audioevent@1", bus: "Music",
    root: { type: "musicSwitch", id: "sw", parameter: "zone", children: [seg("A"), seg("B")], transitions: [{ from: "A", to: "B", exit: "beat", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } }] },
  });
  return value.musicRoot as MusicSwitchNode;
}
const child = (r: MusicSwitchNode, id: string): MusicNode => r.children.find((c) => c.id === id)!;
const instance = (): EventInstance =>
  ({ group: 7, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 }, getParameter: () => undefined }) as unknown as EventInstance;

async function rig() {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } });
  } catch {
    return null;
  }
  const [{ createClipRegistry }, { CoreBackend }, { Mixer }, { defaultAudioSettings }, { fakeDecoder }] = await Promise.all([
    import("../core/clipRegistry"), import("../core/coreBackend"), import("../../../../engine/audio/mixer"),
    import("../../../../engine/audio/settings"), import("../core/fakeDecoder"),
  ]);
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m), nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames: FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(FRAMES).fill(0.25)] })),
    nextFrame: (cb) => cb(), nextQuantum: (cb) => cb(),
  });
  const host = { link, status: "running" as const, preset: { maxLogical: 16, maxMixed: 8 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as never };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer }) as unknown as AudioBackend & { dispose(): void; music: NonNullable<AudioBackend["music"]> };
  setAudioBackend(backend);
  backend.music.onGroupEvent = routeGroupEvent;
  const step = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      mixer.update(0.003);
      backend.update(0.003);
      loop.renderQuanta(4);
      await Promise.resolve();
    }
  };
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: false }), bus: () => "Music", facts: () => ({ frames: FRAMES, rate: RATE, channels: 1, gapless: true }) });
  for (const path of ["a.wav", "b.wav"]) backend.play({ path, url: path, loop: false, stream: false, bus: "Music", volume: 0 });
  await step(20);
  const f = { backend: backend as AudioBackend, music: backend.music, now: 0, dt: 0.003, hidden: false };
  const frame = (): MusicFrame => { f.now = backend.time; return f; };
  return { backend, step, frame };
}

afterEach(() => {
  taps.sink = NULL_PROFILE_SINK;
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

/** Ticks the player each frame until `done`, at most `max` frames. */
async function run(r: NonNullable<Awaited<ReturnType<typeof rig>>>, player: ReturnType<typeof createMusicPlayer>, done: () => boolean, max = 600): Promise<void> {
  for (let i = 0; i < max && !done(); i++) {
    tickPlayer(player, r.frame());
    await r.step(1);
  }
}

describe("musicTransition taps (§5.6 kind 13)", () => {
  it("the first segment is a transition from nothing; the change to B is reported once, with the segments' ids", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const stub = recordingSink();
    taps.sink = stub.sink;
    const rt = root();
    const player = createMusicPlayer(instance(), rt);
    player.musicSwitch!.playing = "A";
    const { requestStart } = await import("./planner");
    requestStart(player, { to: child(rt, "A"), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, r.frame());
    await run(r, player, () => player.run !== null, 50);
    tickPlayer(player, r.frame());
    expect(stub.of("musicTransition")).toEqual([[7, null, "A"]]);
    await r.step(10);
    requestTransition(player, child(rt, "B"), r.frame());
    await run(r, player, () => player.run?.node.id === "B");
    expect(player.run?.node.id).toBe("B");
    expect(stub.of("musicTransition")).toEqual([[7, null, "A"], [7, "A", "B"]]);
    r.backend.dispose();
  });

  it("a player that began before the recorder reports no first segment, and with the null object nothing is reported", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const rt = root();
    const player = createMusicPlayer(instance(), rt); // no recorder yet
    const { requestStart } = await import("./planner");
    requestStart(player, { to: child(rt, "A"), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, r.frame());
    await run(r, player, () => player.run !== null, 50);
    const stub = recordingSink();
    taps.sink = stub.sink; // the recorder starts mid-play
    tickPlayer(player, r.frame());
    await r.step(5);
    tickPlayer(player, r.frame());
    expect(stub.calls).toEqual([]);
    r.backend.dispose();
  });
});
