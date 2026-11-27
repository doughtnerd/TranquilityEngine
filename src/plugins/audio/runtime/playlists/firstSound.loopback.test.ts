// Decision log D44: a sequence started with no stamp was first heard late on the loopback (its clip wasn't on the core
// yet, so its voice waited for the data and then started unstamped, while the playhead had begun at the earliest
// stampable time). On the real wasm core, the playhead's start (read from `handle.music` on the audio clock) and the
// first rendered sample of the sound now agree, whether the clip still had to load or was already there.
import { afterEach, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { audioBackend, setAudioBackend } from "../backend";
import { Audio } from "../index";
import { endAudioSession, loopbackAudio, closeLoopbackAudio } from "../testing";

const RATE = 48_000;
const dc = new Float32Array(2 * RATE).fill(0.5);

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

it.each([
  ["its clip still loading", false],
  ["its clip already on the core", true],
] as const)("an unstamped sequence is first heard where its playhead starts: %s (loopback)", { timeout: 30_000 }, async (_name, resident) => {
  Assets.clearSources();
  const seq = (sample: string) => ({
    format: "myco.playlist@1", type: "sequence", entries: [],
    sequence: { length: 2, tempo: { bpm: 120, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample, at: 0, length: 2, sync: true }] }] },
  });
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "dc.wav": "data:,",
    "warm.wav": "data:,",
    "m.playlist.json": seq("dc.wav"),
    "w.playlist.json": seq(resident ? "dc.wav" : "warm.wav"),
  }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 7 } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  endAudioSession();
  // The warm-up clip is silent, so the measured one is the only sound; a resident run warms the measured clip itself
  // and keeps it playing at zero volume, so it stays on the core.
  const loop = await loopbackAudio({
    mixer: "page", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 },
    decode: (path: string) => ({ channelData: [path.includes("warm") ? new Float32Array(RATE) : dc] }), recovery: { now: () => 0, warn: () => {} },
  });
  if (!loop) return;
  const out: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      loop.mainFrame(0.0107);
      for (const s of loop.render(4).left) out.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  try {
    // Start the core (its clock running) with something else, then play the measured sequence unstamped.
    const warm = Audio.play("w.playlist.json", { volume: 0 });
    await step(24);
    const mark = out.length;
    expect(out.every((s) => s === 0)).toBe(true);
    const h = Audio.play("m.playlist.json");
    await step(40);
    void warm;
    const first = out.findIndex((s, k) => k >= mark && s !== 0);
    expect(first).toBeGreaterThan(mark);
    // The playhead's start on the heard clock: now less the musical position (120 bpm: 0.5 s a beat, 4 beats a bar).
    const m = h.music!;
    const now = m.time; // the heard time its position is read at
    const start = now - ((m.bar - 1) * 4 + (m.beat - 1) + m.beatFraction) * 0.5;
    const map = audioBackend().clock!.frameMap()!;
    const startFrame = (start - map.timeOffset) * map.sampleRate;
    // `out` holds what this test rendered; the rig rendered some quanta before it (`loop.frame` counts every one).
    const firstFrame = first + (loop.frame - out.length);
    expect(Math.abs(firstFrame - startFrame)).toBeLessThanOrEqual(1);
    h.stop();
  } finally {
    endAudioSession();
    setAudioBackend(null);
    engine.dispose?.();
  }
});
