// ADR 0166 api-and-models §1.3 (P7): the `Audio` clock members `Audio.horizon` and `Audio.timeAt`, through `Audio` on
// the fake backend (kept from the M4a rows when the music player was retired, ADR 0329).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, endAudioSession, type FakeBackend } from "../testing";

/** The fake's lookahead: the horizon is this far past `Audio.time`. */
const L = 1 / 30;
let b: FakeBackend;

function rig(): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  b.lookahead = L;
  b.advanceTo(1);
}

afterEach(() => {
  endAudioSession();
  setAudioBackend(null);
  Audio.calibration = 0;
  vi.restoreAllMocks();
});

describe("Audio clock members (§1.3)", () => {
  it("Audio.horizon is the backend's horizon (now + lookahead), and Audio.time on a backend without one", () => {
    rig();
    b.advanceTo(2);
    expect(Audio.horizon).toBeCloseTo(2 + L, 9);
    b.lookahead = null;
    expect(Audio.horizon).toBe(Audio.time);
    expect(Audio.horizon).toBe(2);
  });

  it("Audio.timeAt maps a performance.now() instant to heard time, never applies Audio.calibration, and is Audio.time on a backend without timeAt", () => {
    rig();
    b.advanceTo(2);
    // 250 ms after the frame's rAF time is 0.25 s later on the heard clock.
    expect(Audio.timeAt(b.rafTime + 250)).toBeCloseTo(2.25, 9);
    Audio.calibration = 0.05;
    expect(Audio.calibration).toBe(0.05);
    expect(Audio.timeAt(b.rafTime + 250)).toBeCloseTo(2.25, 9);

    // A backend with no heard clock (the Babylon fallback): Audio.time.
    const bare = makeFakeBackend();
    bare.clock = undefined;
    setAudioBackend(bare);
    bare.advanceTo(3);
    expect(Audio.timeAt(1250)).toBe(3);
  });
});
