// The Babylon fallback's voice sound state: wanted level and rate in, the difference put on the sound when it arrives.
import { describe, expect, it } from "vitest";
import { VoiceSoundState, type VoiceStateSound } from "./babylonVoiceState";

/** A sound made with `options`, recording what the state writes. */
class FakeSound implements VoiceStateSound {
  readonly ramps: { value: number; duration: number }[] = [];
  readonly writes: string[] = [];
  private v: number;
  private r: number | undefined;
  constructor(options: { volume: number; playbackRate?: number }) {
    this.v = options.volume;
    this.r = options.playbackRate;
  }
  get volume(): number {
    return this.v;
  }
  set volume(v: number) {
    this.writes.push(`volume=${v}`);
    this.v = v;
  }
  get playbackRate(): number | undefined {
    return this.r;
  }
  set playbackRate(r: number | undefined) {
    this.writes.push(`rate=${r}`);
    this.r = r;
  }
  setVolume(value: number, o: { duration: number }): void {
    this.writes.push(`ramp=${value}/${o.duration}`);
    this.ramps.push({ value, duration: o.duration });
    this.v = value;
  }
}

const soundFrom = (options: { volume: number; playbackRate?: number }): FakeSound => new FakeSound(options);

const decoded = (extra: Partial<{ volume: number; pitch: number; gain: number }> = {}) => new VoiceSoundState({ volume: 1, pitch: 1, gain: 1, decoded: true, ...extra });

describe("VoiceSoundState before the sound exists", () => {
  it("creates the sound at volume × stem × fade × occlusion and pitch × Doppler", () => {
    const s = decoded({ volume: 0.5, pitch: 1.5 });
    s.setOcclusion(0.5);
    s.setDoppler(2);
    expect(s.creationOptions()).toEqual({ volume: 0.25, playbackRate: 3 });
  });

  it("creates at the fade gain the sound starts from, then runs a fade asked meanwhile over its own length", () => {
    const s = decoded({ volume: 0.8, gain: 0 });
    s.fade(1, 2);
    const options = s.creationOptions();
    expect(options.volume).toBe(0);
    const sound = soundFrom(options);
    s.attach(sound);
    expect(sound.ramps).toEqual([{ value: 0.8, duration: 2 }]);
  });

  it("puts on the sound a volume, pitch, Doppler or occlusion change made while it was being created", () => {
    const s = decoded();
    const sound = soundFrom(s.creationOptions());
    s.setVolume(0.5);
    s.setPitch(2);
    s.setDoppler(1.5);
    s.setOcclusion(0.5);
    s.attach(sound);
    expect(sound.volume).toBe(0.25);
    expect(sound.playbackRate).toBe(3);
    expect(sound.ramps).toEqual([]);
  });

  it("writes nothing on attach when nothing changed since creation", () => {
    const s = decoded({ volume: 0.7, pitch: 1.2 });
    const sound = soundFrom(s.creationOptions());
    s.attach(sound);
    expect(sound.writes).toEqual([]);
  });

  it("gives a stream no rate, before and after its sound exists, but keeps its pitch for its rows", () => {
    const s = new VoiceSoundState({ volume: 1, pitch: 1.5, gain: 1, decoded: false });
    s.setDoppler(2);
    const options = s.creationOptions();
    expect("playbackRate" in options).toBe(false);
    const sound = soundFrom(options);
    s.attach(sound);
    s.setPitch(3);
    s.setDoppler(2);
    expect(sound.writes).toEqual([]);
    expect(s.pitch).toBe(3);
  });
});

describe("VoiceSoundState with its sound", () => {
  it("sets volume at once and eases a fade or stem gain over its length", () => {
    const s = decoded();
    const sound = soundFrom(s.creationOptions());
    s.attach(sound);
    s.setVolume(0.5);
    expect(sound.writes).toEqual(["volume=0.5"]);
    s.fade(0.5, 1);
    s.setParam(0.5, 0.25);
    expect(sound.ramps).toEqual([{ value: 0.25, duration: 1 }, { value: 0.125, duration: 0.25 }]);
    expect(s.heardGain).toBe(0.125);
  });

  it("clamps fade and stem gains to 0..4 and repairs a non-finite one to 1", () => {
    const s = decoded();
    s.attach(soundFrom(s.creationOptions()));
    s.fade(9, 0);
    expect(s.gain).toBe(4);
    s.fade(-1, 0);
    expect(s.gain).toBe(0);
    s.setParam(Number.NaN, 0);
    expect(s.param).toBe(1);
  });

  it("clamps occlusion to 0..1 and writes nothing for the same gain twice", () => {
    const s = decoded();
    const sound = soundFrom(s.creationOptions());
    s.attach(sound);
    s.setOcclusion(2);
    expect(sound.writes).toEqual([]);
    s.setOcclusion(0.5);
    s.setOcclusion(0.5);
    expect(sound.writes).toEqual(["volume=0.5"]);
    s.setOcclusion(Number.NaN);
    expect(sound.volume).toBe(1);
  });

  it("repairs a pitch or Doppler factor that isn't finite and above zero to 1", () => {
    const s = decoded();
    const sound = soundFrom(s.creationOptions());
    s.attach(sound);
    s.setPitch(1.5);
    expect(sound.playbackRate).toBe(1.5);
    s.setPitch(0);
    expect(sound.playbackRate).toBe(1);
    s.setPitch(Number.NaN);
    expect(sound.playbackRate).toBe(1);
    s.setPitch(2);
    s.setDoppler(-1);
    expect(sound.playbackRate).toBe(2);
    s.setDoppler(1.25);
    expect(sound.playbackRate).toBe(2.5);
  });

  it("never gives the sound a negative or non-finite volume", () => {
    const s = decoded();
    const sound = soundFrom(s.creationOptions());
    s.attach(sound);
    s.setVolume(-2);
    expect(sound.volume).toBe(0);
    s.setVolume(Number.NaN);
    expect(sound.volume).toBe(1);
  });
});
