import { describe, expect, it } from "vitest";
import { parseAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import { LoudnessHub } from "../../runtime/mix/loudnessHub";
import { createMixerSession, type MixerSessionHost } from "./mixerSession";

/** A clock the test advances; the model never reads any other. */
function makeClock() {
  let t = 100;
  return { now: () => t, advance: (s: number) => { t += s; } };
}

const applied = () => ({ ok: true, class: "direct" }) as const;

function setup(over: { audio?: AudioSettings } = {}) {
  const clock = makeClock();
  const calls: string[] = [];
  const host: MixerSessionHost = {
    reset: (w) => calls.push(`reset ${w}`),
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    setTarget: (n) => calls.push(`setTarget ${n}`),
    apply: applied,
  };
  const audio = over.audio ?? parseAudioSettings({}).settings;
  const model = createMixerSession({ host, clock: clock.now, current: () => audio });
  return { model, clock, calls };
}

describe("session controls", () => {
  it("elapsed counts the injected clock from construction", () => {
    const { model, clock } = setup();
    expect(model.elapsed).toBe(0);
    clock.advance(2.5);
    expect(model.elapsed).toBe(2.5);
  });

  it("pause freezes elapsed and resume continues it; paused time is excluded", () => {
    const { model, clock, calls } = setup();
    clock.advance(3);
    model.pause();
    expect(model.paused).toBe(true);
    clock.advance(10);
    expect(model.elapsed).toBe(3);
    model.resume();
    expect(model.paused).toBe(false);
    clock.advance(1);
    expect(model.elapsed).toBe(4);
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("pause and resume are idempotent (one host call each) and togglePause flips", () => {
    const { model, calls } = setup();
    model.pause(); model.pause();
    model.resume(); model.resume();
    model.togglePause(); model.togglePause();
    expect(calls).toEqual(["pause", "resume", "pause", "resume"]);
  });

  const RESETS: Array<[LoudnessResetWhat, boolean]> = [["all", true], ["integrated", true], ["maxPeak", false]];
  for (const [what, zeroes] of RESETS) {
    it(`reset("${what}") ${zeroes ? "restarts" : "leaves"} elapsed and goes to the host`, () => {
      const { model, clock, calls } = setup();
      clock.advance(5);
      model.reset(what);
      clock.advance(1);
      expect(model.elapsed).toBe(zeroes ? 1 : 6);
      expect(calls).toEqual([`reset ${what}`]);
    });
  }

  it("reset defaults to all, and a reset while paused keeps it paused at 0", () => {
    const { model, clock, calls } = setup();
    clock.advance(4);
    model.pause();
    model.reset();
    expect(calls).toEqual(["pause", "reset all"]);
    expect(model.paused).toBe(true);
    expect(model.elapsed).toBe(0);
    model.resume();
    clock.advance(2);
    expect(model.elapsed).toBe(2);
  });

  describe("reset on Play (loudnessResetOnPlay), a case per option", () => {
    const play = (resetOnPlay: boolean) => parseAudioSettings({ loudnessResetOnPlay: resetOnPlay }).settings;
    it("true: elapsed restarts", () => {
      const { model, clock } = setup();
      clock.advance(7);
      model.playStarted(play(true));
      expect(model.elapsed).toBe(0);
      clock.advance(1);
      expect(model.elapsed).toBe(1);
    });

    it("false: elapsed carries across the Play, and a new Engine clock does not lose or add time", () => {
      const { model, clock } = setup();
      clock.advance(7);
      model.playStarted(play(false));
      expect(model.elapsed).toBe(7);
      clock.advance(2);
      expect(model.elapsed).toBe(9);
    });

    it("false: a pause carries across the Play", () => {
      const { model, clock } = setup();
      clock.advance(2);
      model.pause();
      model.playStarted(play(false));
      clock.advance(5);
      expect(model.paused).toBe(true);
      expect(model.elapsed).toBe(2);
    });
  });
});

describe("the target picker", () => {
  it("lists the design's two default platforms, the first selected", () => {
    const { model } = setup();
    expect(model.targets().map((t) => [t.name, t.integrated, t.tolerance, t.truePeak, t.selected])).toEqual([
      ["console", -24, 2, -1, true],
      ["mobile", -18, 2, -1, false],
    ]);
    expect(model.targets()[0].label).toBe("-24 LUFS ±2 LU, -1 dBTP");
    expect(model.target).toBe("console");
  });

  it("lists the project's own targets, in order", () => {
    const audio = parseAudioSettings({
      loudnessTargets: [{ name: "tv", integrated: -27, tolerance: 1, truePeak: -2 }, { name: "web", integrated: -16 }],
    }).settings;
    const { model } = setup({ audio });
    expect(model.targets().map((t) => t.name)).toEqual(["tv", "web"]);
    expect(model.target).toBe("tv");
    expect(model.targets()[1]!.label).toBe("-16 LUFS ±2 LU, -1 dBTP");
  });

  it("a pick for each entry is exactly one host call and marks it selected (never a commit: the host has no way to)", () => {
    const { model, calls } = setup();
    for (const name of ["mobile", "console"]) {
      calls.length = 0;
      expect(model.pickTarget(name)).toBe(true);
      expect(calls).toEqual([`setTarget ${name}`]);
      expect(model.target).toBe(name);
      expect(model.targets().filter((t) => t.selected).map((t) => t.name)).toEqual([name]);
    }
  });

  it("an unknown name does nothing", () => {
    const { model, calls } = setup();
    expect(model.pickTarget("nope")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.target).toBe("console");
  });

  it("a live edit of the table keeps the pick if its entry survives, else falls back to the first", () => {
    const { model } = setup();
    model.pickTarget("mobile");
    model.setAudio(parseAudioSettings({ loudnessTargets: [{ name: "tv", integrated: -27 }, { name: "mobile", integrated: -17 }] }).settings);
    expect(model.target).toBe("mobile");
    expect(model.targets().find((t) => t.name === "mobile")!.integrated).toBe(-17);
    model.setAudio(parseAudioSettings({ loudnessTargets: [{ name: "tv", integrated: -27 }] }).settings);
    expect(model.target).toBe("tv");
  });

  it("follows the hub when a script changes it", () => {
    const { model } = setup();
    model.syncTarget("mobile");
    expect(model.target).toBe("mobile");
    model.syncTarget("nope");
    expect(model.target).toBe("mobile");
    model.syncTarget(null);
    expect(model.target).toBe("console");
  });

  it("sets the real hub's target", () => {
    const hub = new LoudnessHub();
    hub.configure({ available: true, root: "Master", buses: [{ name: "Master", parent: null, slot: 0, metered: false }] });
    const model = createMixerSession({ host: { setTarget: (n) => { hub.target = n; }, apply: applied }, clock: () => 0, current: () => parseAudioSettings({}).settings });
    model.pickTarget("mobile");
    expect(hub.target).toBe("mobile");
    expect(hub.busLoudness("Master")!.target!.name).toBe("mobile");
  });
});

describe("taint marks cleared by the session (6.6), through the monitor and Compare models and the real hub", () => {
  // Master is the root (always metered); Sfx and Voice meter loudness; Music doesn't.
  const AUDIO = parseAudioSettings({
    buses: [{ name: "Master" }, { name: "Sfx", parent: "Master", meter: "loudness" }, { name: "Voice", parent: "Sfx", meter: "loudness" }, { name: "Music", parent: "Master" }],
  }).settings;
  const METERED = ["Master", "Sfx", "Voice"];

  function rig(audio: AudioSettings = AUDIO) {
    const hub = new LoudnessHub();
    hub.configure({
      available: true,
      root: "Master",
      buses: [
        { name: "Master", parent: null, slot: 0, metered: false },
        { name: "Sfx", parent: "Master", slot: 1, metered: true },
        { name: "Voice", parent: "Sfx", slot: 2, metered: true },
        { name: "Music", parent: "Master", slot: 3, metered: false },
      ],
    });
    const clock = makeClock();
    const session = createMixerSession({
      clock: clock.now,
      current: () => audio,
      host: {
        reset: (w) => { for (const b of METERED) hub.busLoudness(b)!.reset(w); },
        noteMonitorMute: (b) => hub.noteMonitorMute(b),
        noteMonitorSolo: () => hub.noteMonitorSolo(),
        setMonitorActive: (on) => hub.setMonitorActive(on),
        setCompare: (on) => hub.setCompare(on),
        apply: applied,
      },
    });
    session.setAudio(audio);
    const hubTainted = () => METERED.filter((b) => hub.busLoudness(b)!.tainted);
    return { hub, monitor: session.monitor, compare: session.compare, session, hubTainted };
  }

  it("a monitor mute of Voice taints exactly Voice, Sfx and Master in the model and the hub; Reset clears both", () => {
    const r = rig();
    r.monitor.setMute("Voice", true);
    expect(r.monitor.taintedMeters()).toEqual(["Master", "Sfx", "Voice"]);
    expect(r.hubTainted()).toEqual(["Master", "Sfx", "Voice"]);
    r.session.reset("all");
    expect(r.monitor.taintedMeters()).toEqual([]);
    expect(r.hubTainted()).toEqual([]);
    expect(r.monitor.isMuted("Voice")).toBe(true); // the control itself stays on
  });

  it("a mute of Sfx leaves Voice (a descendant) clean; reset(integrated) clears, reset(maxPeak) doesn't", () => {
    const r = rig();
    r.monitor.setMute("Sfx", true);
    expect(r.monitor.taintedMeters()).toEqual(["Master", "Sfx"]);
    expect(r.hubTainted()).toEqual(["Master", "Sfx"]);
    r.session.reset("maxPeak");
    expect(r.monitor.taintedMeters()).toEqual(["Master", "Sfx"]);
    expect(r.hubTainted()).toEqual(["Master", "Sfx"]);
    r.session.reset("integrated");
    expect(r.monitor.taintedMeters()).toEqual([]);
    expect(r.hubTainted()).toEqual([]);
  });

  it("a monitor solo and Compare taint every meter; Reset clears every mark", () => {
    const r = rig();
    r.session.playStarted(AUDIO);
    r.monitor.setSolo("Voice", true);
    expect(r.monitor.taintedMeters()).toEqual(METERED);
    expect(r.hubTainted()).toEqual(METERED);
    r.compare.toggle();
    expect(r.compare.tainted).toBe(true);
    r.session.reset();
    expect(r.monitor.taintedMeters()).toEqual([]);
    expect(r.compare.tainted).toBe(false);
    expect(r.hubTainted()).toEqual([]);
  });

  it("Play: loudnessResetOnPlay true clears the monitor's and Compare's marks (hub.play resets its meters), false keeps them", () => {
    for (const reset of [false, true]) {
      const audio = { ...AUDIO, loudnessResetOnPlay: reset };
      const r = rig(audio);
      r.session.playStarted(audio);
      r.monitor.setSolo("Sfx", true);
      r.compare.toggle();
      r.session.playStopped();
      r.session.playStarted(audio);
      if (reset) r.hub.play();
      expect(r.monitor.taintedMeters(), `reset ${reset}`).toEqual(reset ? [] : METERED);
      expect(r.compare.tainted, `reset ${reset}`).toBe(!reset);
      expect(r.hubTainted(), `reset ${reset}`).toEqual(reset ? [] : METERED);
    }
  });

  it("a mark made after a reset taints afresh", () => {
    const r = rig();
    r.monitor.setMute("Voice", true);
    r.session.reset();
    r.monitor.setMute("Sfx", true);
    expect(r.monitor.taintedMeters()).toEqual(["Master", "Sfx"]);
    expect(r.hubTainted()).toEqual(["Master", "Sfx"]);
  });
});

describe("what Reset, Play and Stop clear (ADR 0292)", () => {
  const AUDIO = parseAudioSettings({ buses: [{ name: "master" }, { name: "sfx", parent: "master" }, { name: "music", parent: "master" }] }).settings;

  function rig(audio: AudioSettings = AUDIO) {
    const clock = makeClock();
    const calls: string[] = [];
    const session = createMixerSession({
      clock: clock.now,
      current: () => audio,
      host: {
        setMonitor: (b, c) => calls.push(`setMonitor ${b} ${JSON.stringify(c)}`),
        setCompare: (on) => calls.push(`setCompare ${on}`),
        apply: applied,
      },
    });
    session.setAudio(audio);
    return { session, clock, calls, latched: (bus: string) => session.meter(bus)?.clipped ?? false };
  }

  it("Reset: all clears every clip latch and keeps the hold; integrated and maxPeak keep the latches", () => {
    for (const [what, clears] of [["all", true], ["integrated", false], ["maxPeak", false]] as const) {
      const r = rig();
      r.session.playStarted(AUDIO);
      r.session.tickMeters(["sfx"], () => 1.2, 0);
      r.session.reset(what);
      expect(r.latched("sfx"), what).toBe(!clears);
      expect(r.session.meter("sfx")!.hold, what).toBe(1.2);
    }
  });

  it("a click clears one bus's clip latch", () => {
    const r = rig();
    r.session.playStarted(AUDIO);
    r.session.tickMeters(["sfx", "music"], () => 1.5, 0);
    r.session.resetClip("sfx");
    expect([r.latched("sfx"), r.latched("music")]).toEqual([false, true]);
  });

  it("Play: loudnessResetOnPlay true starts the meters and the elapsed time over; false keeps both", () => {
    for (const reset of [true, false]) {
      const audio = { ...AUDIO, loudnessResetOnPlay: reset };
      const r = rig(audio);
      r.session.playStarted(audio);
      r.session.tickMeters(["sfx"], () => 1.5, 0);
      r.clock.advance(30);
      r.session.playStarted(audio); // a new Play's start (the panel sees one after each Stop)
      expect(r.latched("sfx"), `reset ${reset}`).toBe(!reset);
      expect(r.session.elapsed, `reset ${reset}`).toBe(reset ? 0 : 30);
    }
  });

  it("Play and Stop turn the monitor controls off (they belong to the Engine); Stop forgets the meters and ends Compare", () => {
    const r = rig({ ...AUDIO, loudnessResetOnPlay: false });
    r.session.playStarted(AUDIO);
    r.session.monitor.setSolo("sfx", true);
    r.session.playStarted(AUDIO);
    expect(r.session.monitor.active).toBe(false);
    r.session.monitor.setMute("music", true);
    r.session.compare.toggle();
    r.session.tickMeters(["sfx"], () => 0.5, 0);
    r.calls.length = 0;
    r.session.playStopped();
    expect(r.calls).toEqual(["setCompare false", 'setMonitor music {"mute":false}']);
    expect([r.session.monitor.active, r.session.compare.active, r.session.compare.available]).toEqual([false, false, false]);
    expect(r.session.meter("sfx")).toBeUndefined();
  });

  it("a bus removed from the section loses its meter and its monitor controls", () => {
    const r = rig();
    r.session.playStarted(AUDIO);
    r.session.monitor.setMute("music", true);
    r.session.tickMeters(["sfx", "music"], () => 0.5, 0);
    r.session.setAudio(parseAudioSettings({ buses: [{ name: "master" }, { name: "sfx", parent: "master" }] }).settings);
    expect(r.session.meter("music")).toBeUndefined();
    expect(r.session.meter("sfx")).toBeDefined();
    expect(r.session.monitor.isMuted("music")).toBe(false);
  });
});
