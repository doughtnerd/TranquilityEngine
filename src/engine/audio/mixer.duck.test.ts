// Dp1 (ADR 0172 §1.1; api-and-models §1.1): on the core backend the mixer reads the duck lane from a source (STATUS's
// `busDuck`) and computes no presence duck; without one (the Babylon fallback) it computes them on main as before. And
// Mx2's timing note: a ramp with a length starts at the backend's stamp time, so a getter reads the value heard.
import { describe, expect, it } from "vitest";
import { Lane, Mixer } from "./mixer";
import { defaultAudioSettings, type AudioSettings } from "./settings";

const settings = (): AudioSettings => ({ ...defaultAudioSettings(), ducking: [{ target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.5 }] });

describe("the mixer's duck lane (Dp1)", () => {
  it("without a source (the Babylon fallback) main computes presence ducks", () => {
    const m = new Mixer(settings());
    m.voiceStarted("Voice");
    for (let i = 0; i < 20; i++) m.update(0.1);
    expect(m.bus("Music").duckGain).toBe(0.4);
    expect(m.resolve("Music")!.gain).toBeCloseTo(0.4, 6);
  });

  it("main's presence duck settles on its goal, and once there stops telling listeners every frame", () => {
    const slow = settings();
    slow.ducking[0] = { ...slow.ducking[0]!, attack: 0.5, release: 2 };
    const m = new Mixer(slow);
    m.voiceStarted("Voice");
    for (let i = 0; i < 3000; i++) m.update(1 / 60);
    expect(m.bus("Music").duckGain).toBe(0.4);
    let notified = 0;
    m.onChange(() => notified++);
    for (let i = 0; i < 10; i++) m.update(1 / 60);
    expect(notified).toBe(0);
    m.voiceEnded("Voice");
    for (let i = 0; i < 3000; i++) m.update(1 / 60);
    expect(m.bus("Music").duckGain).toBe(1);
  });

  it("a duck lifting to a shallower rule's level eases at the release time, not the attack (Q20, ADR 0386)", () => {
    const two: AudioSettings = {
      ...defaultAudioSettings(),
      ducking: [
        { target: "Music", trigger: "Voice", mode: "presence", amount: 0.2, attack: 0.1, release: 1 },
        { target: "Music", trigger: "SFX", mode: "presence", amount: 0.6, attack: 0.1, release: 0.8 },
      ],
    };
    const m = new Mixer(two);
    m.voiceStarted("Voice");
    m.voiceStarted("SFX");
    for (let i = 0; i < 100; i++) m.update(0.1);
    expect(m.bus("Music").duckGain).toBe(0.2);
    m.voiceEnded("Voice"); // the deeper trigger stops; the lighter one keeps ducking
    m.update(0.1);
    // Released at the leaving rule's 1 s release: a tenth of the way from 0.2 to 0.6 (the 0.1 s attack would go all the way).
    expect(m.bus("Music").duckGain).toBeCloseTo(0.2 + (0.6 - 0.2) * 0.1, 9);
    for (let i = 0; i < 300; i++) m.update(0.1);
    expect(m.bus("Music").duckGain).toBe(0.6);
    // Deepening again uses the attack.
    m.voiceStarted("Voice");
    m.update(0.05);
    expect(m.bus("Music").duckGain).toBeCloseTo(0.6 + (0.2 - 0.6) * 0.5, 9);
  });

  it("with a source every duck read is the source's and main computes none; clearing it resumes main's from 1", () => {
    const m = new Mixer(settings());
    const core = new Map<string, number>();
    m._setDuckSource((bus) => core.get(bus) ?? 1);
    m.voiceStarted("Voice");
    for (let i = 0; i < 20; i++) m.update(0.1);
    expect(m.bus("Music").duckGain).toBe(1);
    core.set("Music", 0.25);
    let notified = 0;
    m.onChange(() => notified++);
    m.update(0.1);
    expect(notified, "a moved core duck notifies listeners (selection re-reads it)").toBe(1);
    expect(m.bus("Music").duckGain).toBe(0.25);
    expect(m.laneGain("Music", Lane.duck)).toBe(0.25); // the lane writer's duck lane reads the same (`_duckOf`)
    expect(m.resolve("Music")!.gain).toBeCloseTo(0.25, 6);
    expect(m.bus("Music").effectiveGain).toBeCloseTo(0.25, 6);
    core.set("Music", Number.NaN);
    expect(m.bus("Music").duckGain).toBe(1);
    m._setDuckSource(null);
    expect(m.bus("Music").duckGain).toBe(1);
    m.update(0.05);
    expect(m.bus("Music").duckGain).toBeCloseTo(1 - 0.6 * 0.5, 6);
  });

  it("a fade starts at the backend's stamp time on the heard clock; a set and the own clock are unchanged", () => {
    const m = new Mixer(defaultAudioSettings());
    let now = 10;
    const stamp = 10.01;
    m.setClock(() => now, () => stamp);
    m.bus("SFX").fadeTo(0, 1);
    expect(m.bus("SFX").volume, "nothing heard moves before the stamp").toBe(1);
    now = 10.01;
    expect(m.bus("SFX").volume).toBe(1);
    now = 10.51;
    expect(m.bus("SFX").volume).toBeCloseTo(0.5, 9);
    now = 11.01;
    expect(m.bus("SFX").volume).toBe(0);
    // An interrupting fade starts from the first one's value at its own stamp.
    const m2 = new Mixer(defaultAudioSettings());
    let t = 0;
    let s = 0.02;
    m2.setClock(() => t, () => s);
    m2.bus("SFX").fadeTo(0, 1);
    t = 0.5;
    s = 0.52;
    m2.bus("SFX").fadeTo(1, 1);
    // From the first fade's value at the stamp (0.5, not 0.52 now), starting at the stamp: heard as 0.5 until then.
    expect(m2.bus("SFX").volume).toBeCloseTo(0.5, 9);
    t = 0.52;
    expect(m2.bus("SFX").volume).toBeCloseTo(0.5, 9);
    t = 1.02;
    expect(m2.bus("SFX").volume).toBeCloseTo(0.75, 9);
    t = 1.52;
    expect(m2.bus("SFX").volume).toBe(1);
    // A set is asap (no length): the target at once.
    m2.bus("SFX").volume = 0.3;
    expect(m2.bus("SFX").volume).toBe(0.3);
    // No stamp (NaN) or the mixer's own clock: the ramp starts now.
    const m3 = new Mixer(defaultAudioSettings());
    let n = 5;
    m3.setClock(() => n, () => Number.NaN);
    m3.bus("SFX").fadeTo(0, 1);
    n = 5.5;
    expect(m3.bus("SFX").volume).toBeCloseTo(0.5, 9); // started at 5
    m3.setClock(null, () => 99);
    m3.bus("Music").fadeTo(0, 1);
    m3.update(0.5);
    expect(m3.bus("Music").volume).toBeCloseTo(0.5, 9); // started at the own clock's time, not at 99
  });
});
