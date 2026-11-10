// ADR 0158 §4 / E3.2: region loops and release for event voices on the Babylon fallback, clip durations and the
// `event` column of the debug rows, against the mocked AudioV2 engine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext, type MockSound } from "../testing/babylonMocks";
import { setAudioBackend, type PlayRequest } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { _resetHandleWarningsForTests } from "./core/handle";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

const req = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "Master", ...extra });
const live: BabylonBackend[] = [];
const sound = (i = 0): MockSound & { loopStart?: number; loopEnd?: number } => babylonMock.engine.sounds[i]!;

function make(): BabylonBackend {
  const context = makeFakeContext("running");
  const backend = new BabylonBackend({ createContext: () => context as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null });
  live.push(backend);
  backend.configureBuses(mixer);
  backend.applyMix(mixer.resolveAll());
  return backend;
}

beforeEach(() => {
  babylonMock.reset();
  _resetHandleWarningsForTests();
  mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }] }).settings);
});
afterEach(() => {
  setAudioBackend(null);
  for (const b of live.splice(0)) b.dispose();
  vi.restoreAllMocks();
});

describe("Babylon event loops", () => {
  it("setLoop sets loopStart, loopEnd and loop on a ready sound; release clears loop", async () => {
    const backend = make();
    const voice = backend.play(req({ loop: true }))!;
    await flush();
    voice.setLoop!(1.5, 3, true);
    expect(sound()).toMatchObject({ loopStart: 1.5, loopEnd: 3, loop: true });
    voice.setLoop!(1.5, 3, false);
    expect(sound().loop).toBe(false);
    expect(voice.playing).toBe(true);
  });

  it("applies a setLoop made before the sound is ready", async () => {
    const backend = make();
    const voice = backend.play(req())!;
    voice.setLoop!(0.5, 2, true);
    await flush();
    expect(sound()).toMatchObject({ loopStart: 0.5, loopEnd: 2, loop: true });
  });

  it("a streamed clip loops whole and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = make();
    const voice = backend.play(req({ stream: true, loop: true }))!;
    await flush();
    voice.setLoop!(1, 2, true);
    voice.setLoop!(1, 2, true);
    expect(sound().loop).toBe(true);
    expect(sound().loopStart).toBeUndefined();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("loops whole"))).toHaveLength(1);
    voice.setLoop!(1, 2, false);
    expect(sound().loop).toBe(false);
  });
});

describe("Babylon clip durations and debug rows", () => {
  it("clipDuration is null until the buffer is loaded, then its length", async () => {
    const backend = make();
    expect(backend.clipDuration("a.wav")).toBeNull();
    backend.play(req());
    await flush();
    expect(backend.clipDuration("a.wav")).toBe(1); // MockBuffer.duration
    expect(backend.clipDuration("other.wav")).toBeNull();
  });

  it("debug rows carry the event from PlayRequest.group, none for 0 or absent", async () => {
    const backend = make();
    backend.play(req({ group: 7 }));
    backend.play(req({ group: 0 }));
    backend.play(req());
    await flush();
    // Only event voices have rows on the fallback (plain voices keep the empty list the existing tests pin).
    expect(backend.debug().voices.map((v) => v.event)).toEqual([7]);
  });
});
