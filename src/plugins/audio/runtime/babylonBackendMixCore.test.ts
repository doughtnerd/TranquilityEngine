// ADR 0344 ("one warning per feature", ADR 0179's rule): on the Babylon fallback, returns, bus sends and bus effects
// need the audio core; the fallback says so once, whatever the mix and however often its buses are configured.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext } from "../testing/babylonMocks";
import { setAudioBackend } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { endAudioSession } from "./testing";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

const pageSettings = mixer.audioSettings;
let backend: BabylonBackend;

const make = (): BabylonBackend => new BabylonBackend({ createContext: () => makeFakeContext("running") as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null, visibility: null });
const mixWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((c) => String(c[0]).includes("need the audio core") && String(c[0]).includes("returns, bus sends and bus effects"));

beforeEach(() => {
  babylonMock.reset();
  endAudioSession();
});
afterEach(() => {
  backend.dispose();
  setAudioBackend(null);
  endAudioSession();
  mixer.configure(pageSettings);
  vi.restoreAllMocks();
});

describe("Babylon fallback: returns, sends and bus effects need the audio core (ADR 0344)", () => {
  it("says nothing for a mix of plain buses", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] }).settings);
    backend = make();
    backend.configureBuses(mixer);
    expect(mixWarnings(warn)).toHaveLength(0);
  });

  it("warns once for a bus with a send and an effect, however often the buses are configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mixer.configure(parseAudioSettings({
      buses: [
        { name: "Master" },
        { name: "SFX", parent: "Master", effects: [{ type: "lowpass", frequency: 800, q: 1 }], sends: [{ to: "Echo", level: 0.5 }] },
        { name: "Echo", parent: "Master" },
      ],
    }).settings);
    backend = make();
    backend.configureBuses(mixer);
    backend.configureBuses(mixer);
    expect(mixWarnings(warn)).toHaveLength(1);
  });
});
