// ADR 0171 M5 Bb2: the Babylon fallback's loudness rows (api-and-models §1.3, §9). The fallback reports `mixCaps` with
// every mix capability false but `capture: "mainSideOnly"`, and every bus reads the inert loudness object: `metered`
// false, readings -Infinity, and `reset`, `pause` and `resume` do nothing and never throw.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { makeFakeContext } from "../testing/babylonMocks";
import { BabylonBackend } from "./babylonBackend";

const BUSES = [{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Music", parent: "Master" }];

const live: BabylonBackend[] = [];

function backend(): BabylonBackend {
  const context = makeFakeContext("running");
  const b = new BabylonBackend({
    createContext: () => context as unknown as AudioContext,
    unlockTarget: new EventTarget(),
    hostContext: () => null,
    visibility: null,
  });
  live.push(b);
  b.configureBuses(mixer);
  b.applyMix(mixer.resolveAll());
  return b;
}

beforeEach(() => {
  mixer.configure(parseAudioSettings({ buses: BUSES }).settings);
});

afterEach(() => {
  for (const b of live.splice(0)) b.dispose();
});

describe("BabylonBackend mixCaps (ADR 0171 §1.3, §9)", () => {
  it("reports every mix capability false, the CPU reason, and a main-side-only capture", () => {
    const caps = backend().mixCaps;
    expect(caps).toEqual({
      loudness: false,
      levelDucking: false,
      cpu: false,
      cpuReason: "Babylon fallback has no audio core",
      stampedBusRamps: false,
      capture: "mainSideOnly",
    });
  });

  it("reports loudness false, so the panel knows the meters are absent", () => {
    expect(backend().mixCaps?.loudness).toBe(false);
  });
});

describe("BabylonBackend loudness on the fallback (ADR 0171 §9)", () => {
  it.each(["Master", "SFX", "Music"])("bus %s reads metered false with every reading -Infinity", (name) => {
    backend();
    const l = mixer.bus(name).loudness;
    expect(l.metered).toBe(false);
    expect(l.momentary).toBe(Number.NEGATIVE_INFINITY);
    expect(l.shortTerm).toBe(Number.NEGATIVE_INFINITY);
    expect(l.integrated).toBe(Number.NEGATIVE_INFINITY);
    expect(l.lra).toBe(Number.NEGATIVE_INFINITY);
    expect(l.maxTruePeak).toBe(Number.NEGATIVE_INFINITY);
    expect(l.maxMomentary).toBe(Number.NEGATIVE_INFINITY);
    expect(l.elapsed).toBe(0);
    expect(l.target).toBeNull();
  });

  it("a missing bus reads the same inert object", () => {
    backend();
    const l = mixer.bus("Nope").loudness;
    expect(l.metered).toBe(false);
    expect(l.integrated).toBe(Number.NEGATIVE_INFINITY);
  });

  it("reset, pause and resume do not throw and change nothing", () => {
    backend();
    const l = mixer.bus("SFX").loudness;
    const before = { metered: l.metered, paused: l.paused, pausedBy: l.pausedBy, integrated: l.integrated, tainted: l.tainted, incomplete: l.incomplete, elapsed: l.elapsed };
    expect(() => l.reset()).not.toThrow();
    expect(() => l.reset("integrated")).not.toThrow();
    expect(() => l.reset("maxPeak")).not.toThrow();
    expect(() => l.pause()).not.toThrow();
    expect(() => l.resume()).not.toThrow();
    expect({ metered: l.metered, paused: l.paused, pausedBy: l.pausedBy, integrated: l.integrated, tainted: l.tainted, incomplete: l.incomplete, elapsed: l.elapsed }).toEqual(before);
    expect(l.momentary).toBe(Number.NEGATIVE_INFINITY);
  });

  it("keeps the inert reading after playback-free mix updates", () => {
    const b = backend();
    b.applyMix(mixer.resolveAll());
    expect(mixer.bus("Music").loudness.metered).toBe(false);
  });
});
