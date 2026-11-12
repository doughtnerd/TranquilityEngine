// ADR 0166 §1 (Q2): the whole public surface is declared and delegates to its owners' stubs. These check the wiring
// and the values a stub gives before its owner fills it (nothing plays music yet); the owners' own tests replace them.
import { afterEach, describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { makeFakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { Calibration as PublicCalibration, type GridSpec, type MusicEvent, type MusicHandle, type MusicPositionAt } from "../../../../myco";
import { Calibration } from "./calibration";
import { musicHandleOf } from "./handle";
import { _resetMusicPlayers, createMusicPlayer, onMusicOf } from "./musicSystem";
import { triggerOn } from "./stingers";

afterEach(() => {
  _resetMusicPlayers();
  setAudioBackend(null);
  Audio.calibration = 0;
});

describe("the ADR 0166 §1 surface (Q2)", () => {
  it("exports the types and Calibration from myco", () => {
    const spec: GridSpec = { every: "bar", n: 2 };
    expect(spec.n).toBe(2);
    expect(PublicCalibration).toBe(Calibration);
    const r = Calibration.fromTaps([0.01, 0.02]);
    expect(r).toMatchObject({ used: 0, steady: false });
  });

  it("an event that didn't play has no music", () => {
    const h = Audio.play("missing.audioevent.json");
    expect(h.music).toBeUndefined();
    expect(h.trigger("hit")).toBe(false);
    expect(typeof h.onMusic("beat", () => {})).toBe("function");
  });

  it("a non-music instance: music undefined, onMusic a no-op function, trigger false", () => {
    const instance = { group: 1 };
    expect(musicHandleOf(instance)).toBeUndefined();
    expect(triggerOn(instance, "hit")).toBe(false);
    const off = onMusicOf(instance, "bar", () => {});
    expect(() => off()).not.toThrow();
  });

  it("a music instance has a handle that delegates seek and positionAt", () => {
    setAudioBackend(makeFakeBackend());
    const instance = { group: 2 } as unknown as EventInstance;
    const player = createMusicPlayer(instance, { id: "s", type: "segment" });
    const music: MusicHandle = musicHandleOf(instance)!;
    expect(music).toBe(player.handle);
    expect(music.segment).toBeNull();
    expect(music.transition).toBeNull();
    expect(music.nextGrid("bar")).toBeNull();
    const at: MusicPositionAt = music.positionAt(1000);
    expect(at.segment).toBeNull();
    let heard: MusicEvent | null = null;
    const off = onMusicOf(instance, "beat", (e) => (heard = e)); // K5 fills the subscription
    off();
    expect(heard).toBeNull();
    expect(music.seek("2:1:0")).toEqual({ ok: false, reason: "notPlaying", permanent: false });
  });

  it("Audio.horizon, timeAt, latency, calibration, calibrationStale and rhythmMode", () => {
    const fake = makeFakeBackend();
    setAudioBackend(fake);
    (fake as { time: number }).time = 2;
    expect(Audio.horizon).toBe(2); // no horizon(): Audio.time
    fake.horizonTime = 2.05;
    expect(Audio.horizon).toBe(2.05);
    fake.rafTime = 1000;
    expect(Audio.timeAt(1250)).toBeCloseTo(2.25, 9);
    expect(Audio.latency).toEqual({ base: 0, output: 0, limiter: 0, total: 0, reliable: false });
    Audio.calibration = 0.012;
    expect(Audio.calibration).toBe(0.012);
    Audio.calibration = Number.NaN;
    expect(Audio.calibration).toBe(0.012);
    expect(Audio.calibrationStale).toBe(false);
    expect(Audio.rhythmMode).toBe(false);
  });
});
