// B3 (ADR 0166 M4c, api-and-models §8): the fallback's clock (no heard clock) and the rhythm-mode warning. Its beat
// callbacks were the music player's (retired by ADR 0329); a playlist's beats come from `playlists/beatCallbacks.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { defaultAudioSettings, parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext, type FakeContext } from "../testing/babylonMocks";
import { setAudioBackend } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { Audio } from "./Audio";
import { endAudioSession } from "./testing";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

const pageSettings = mixer.audioSettings;
let backend: BabylonBackend;
let context: FakeContext;

beforeEach(async () => {
  babylonMock.reset();
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
  endAudioSession();
  mixer.configure(pageSettings);
  vi.restoreAllMocks();
});

const setTime = (t: number): void => {
  context.currentTime = t;
  babylonMock.engine.currentTime = t;
};

const DT = 1 / 60;

describe("Babylon fallback music: the clock (§8)", () => {
  it("has no heard clock: Audio.timeAt reads the context time", () => {
    expect(backend.music!.caps.heardClock).toBe(false);
    expect((backend as { timeAt?: unknown }).timeAt).toBeUndefined();
    setAudioBackend(backend);
    setTime(3.25);
    expect(Audio.timeAt(12345)).toBe(3.25);
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

  it("degrades: caps say no rhythm, the setting still reads, the latency is not reliable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    rhythm(true);
    setAudioBackend(backend);
    backend.update(0);
    expect(backend.music!.caps.rhythm).toBe(false);
    expect(Audio.rhythmMode).toBe(true);
    expect(Audio.latency.reliable).toBe(false);
  });
});
