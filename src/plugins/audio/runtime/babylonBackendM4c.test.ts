// B3 (ADR 0166 M4c, api-and-models §8): beat callbacks from the fallback's main-side clock, and the rhythm-mode warning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { defaultAudioSettings, parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext, type FakeContext } from "../testing/babylonMocks";
import { setAudioBackend } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { Audio } from "./Audio";
import { _resetMusicPlayers } from "./music/musicSystem";
import { _resetSegmentRuns } from "./music/segmentRun";
import { _resetMusicBackground, updateBeatHolds } from "./music/background";
import { drive, musicSegment, playingRun, rigClips, type Fired } from "./music/testing/beatRig";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

const pageSettings = mixer.audioSettings;
let backend: BabylonBackend;
let context: FakeContext;

beforeEach(async () => {
  babylonMock.reset();
  rigClips(600);
  mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] }).settings);
  context = makeFakeContext("running");
  backend = new BabylonBackend({ createContext: () => context as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null, visibility: null });
  backend.configureBuses(mixer);
  backend.applyMix(mixer.resolveAll());
  // The engine and context are created lazily, on the first sound: admit a group so `backend.time` reads the context.
  backend.music!.admitGroup({ instance: 1, group: 1, members: [{ stem: "a", play: { path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "Music", group: 1 }, startFrame: 0, loop: false }] });
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
});
afterEach(() => {
  backend.dispose();
  setAudioBackend(null);
  _resetMusicPlayers();
  _resetSegmentRuns();
  _resetMusicBackground();
  mixer.configure(pageSettings);
  vi.restoreAllMocks();
});

const setTime = (t: number): void => {
  context.currentTime = t;
  babylonMock.engine.currentTime = t;
};

const DT = 1 / 60;
const T120 = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];

/** Drives the beat clock with the backend's own `time` as each frame's `Audio.time`, as `setFrame` does. */
function run(seconds: number, outputLatency = 0): { beats: Fired[]; bars: Fired[] } {
  (context as unknown as { outputLatency: number }).outputLatency = outputLatency;
  const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0.5);
  const list = Array.from({ length: Math.round(seconds / DT) }, (_, k) => ({
    interval: DT,
    before: () => setTime(k * DT),
    get now() {
      return backend.time;
    },
  }));
  const fired = drive(player, list);
  return { beats: fired.filter((f) => f.kind === "beat"), bars: fired.filter((f) => f.kind === "bar") };
}

describe("Babylon fallback music: callbacks (§8 'Beat callbacks')", () => {
  it("has no heard clock: Audio.timeAt reads the context time", () => {
    expect(backend.music!.caps.heardClock).toBe(false);
    expect((backend as { timeAt?: unknown }).timeAt).toBeUndefined();
    setAudioBackend(backend);
    setTime(3.25);
    expect(Audio.timeAt(12345)).toBe(3.25);
  });

  it("fires beats and bars from backend.time, each once, in the frame whose window holds it", () => {
    const { beats, bars } = run(5);
    expect(beats.map((f) => f.e.time)).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5].map((t) => expect.closeTo(t, 6)));
    expect(bars.map((f) => f.e.time)).toEqual([0.5, 2.5, 4.5].map((t) => expect.closeTo(t, 6)));
    for (const f of beats) {
      expect(f.e.missed).toBe(0);
      expect(f.e.heardIn).toBeGreaterThanOrEqual(-1e-9);
      expect(f.e.heardIn).toBeLessThan(DT + 1e-9); // predicted ahead by less than one display frame
    }
  });

  it("is uncorrected for output latency: a 60 ms output latency moves no callback", () => {
    const plain = run(3).beats.map((f) => [f.frame, f.e.time]);
    _resetMusicPlayers();
    const slow = run(3, 0.06).beats.map((f) => [f.frame, f.e.time]);
    expect(slow).toEqual(plain);
  });

  it("a frame gap longer than a beat coalesces into one callback with missed", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0.5);
    const fired = drive(player, [{ now: 0, interval: DT }, { now: 2.3, interval: DT }], ["beat"]);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.e.missed).toBe(3); // 0.5, 1.0, 1.5 coalesced into the beat at 2.0
  });
});

describe("Babylon fallback music: rhythm mode (§8 'Rhythm mode')", () => {
  const rhythm = (on: boolean) => mixer.configure({ ...defaultAudioSettings(), rhythmMode: on, buses: mixer.audioSettings.buses });

  it("warns once when rhythm mode is on, however often it updates", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    backend.update(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("rhythmMode"))).toHaveLength(0);
    rhythm(true);
    for (let i = 0; i < 5; i++) backend.update(DT);
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("rhythmMode"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("unavailable");
  });

  it("degrades: caps say no rhythm, the setting still reads, nothing is held", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    rhythm(true);
    setAudioBackend(backend);
    backend.update(0);
    expect(backend.music!.caps.rhythm).toBe(false);
    expect(Audio.rhythmMode).toBe(true);
    expect(Audio.latency.reliable).toBe(false);
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0.5);
    player.state = "recovering";
    updateBeatHolds(backend);
    expect(player.beats?.held ?? false).toBe(false);
    const fired = drive(player, [{ now: 0.49, interval: DT }], ["beat"]);
    expect(fired.length).toBe(1);
  });
});
