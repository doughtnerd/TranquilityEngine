// The Babylon fallback's mix: the mixer's bus tree as AudioBuses with the resolved gains, snapshots and presence ducking
// folded into bus volumes, `mixCaps` and the inert loudness rows (ADR 0171 §9), live mixing through `mixer.apply`
// (direct, smoothed and structural ops, level ducking needing the core), and the one warning for returns, sends and bus
// effects (ADR 0344). Against the mocked AudioV2 engine, through the shared rig.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import type { MixOp } from "../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { reasonMessage } from "../../../engine/audio/busCapability";
import { babylonMock, type MockBus } from "../testing/babylonMocks";
import { babylonRig, disposeBabylonRigs, engine, flush, playRequest, sound } from "../testing/babylonRig";
import { setAudioBackend } from "./backend";
import type { BabylonBackend } from "./babylonBackend";
import { NULL_PROFILE_SINK } from "./mix/profileSink";
import { taps } from "./mix/profileTaps";
import { endAudioSession } from "./testing";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

describe("buses and mixer features", () => {
  const BUSES = [{ name: "Master" }, { name: "SFX", parent: "Master", maxVoices: 2 }, { name: "Music", parent: "Master" }];
  const configureMixer = (buses: unknown[] = BUSES): void => mixer.configure(parseAudioSettings({ buses }).settings);
  const req = playRequest;
  const rig = babylonRig;
  const bus = (name: string): MockBus => engine().buses.find((b) => b.name === name)!;

  beforeEach(() => {
    babylonMock.reset();
    configureMixer();
  });
  afterEach(() => {
    vi.useRealTimers();
    setAudioBackend(null);
    disposeBabylonRigs();
    vi.restoreAllMocks();
  });

  describe("BabylonBackend buses", () => {
    it("maps the mixer's tree to AudioBuses, parents through outBus and the root to the main bus", async () => {
      const { backend } = rig();
      backend.play(req());
      await flush();
      expect(engine().buses.map((b) => b.name)).toEqual(["Master", "SFX", "Music"]);
      expect(bus("Master").outBus).toBe(engine().defaultMainBus);
      expect(bus("SFX").outBus).toBe(bus("Master"));
      expect(bus("Music").outBus).toBe(bus("Master"));
    });

    it("creates a parent that the project lists later first", async () => {
      configureMixer([{ name: "Master" }, { name: "Child", parent: "Mid" }, { name: "Mid", parent: "Master" }]);
      const { backend } = rig();
      backend.play(req({ bus: "Child" }));
      await flush();
      expect(engine().buses.map((b) => b.name)).toEqual(["Master", "Mid", "Child"]);
      expect(bus("Child").outBus).toBe(bus("Mid"));
    });

    it("starts each bus at the gain applyMix last gave it and sets bus volumes from the resolved gain", async () => {
      const { backend } = rig();
      mixer.bus("Music").volume = 0.5;
      backend.applyMix(mixer.resolveAll());
      backend.play(req());
      await flush();
      expect(bus("Music").volume).toBe(0.5);
      expect(bus("SFX").volume).toBe(1);
      mixer.bus("SFX").volume = 0.25;
      mixer.bus("Music").mute = true;
      mixer.bus("Master").volume = 0.8;
      backend.applyMix(mixer.resolveAll());
      expect(bus("SFX").volume).toBeCloseTo(0.25);
      expect(bus("Music").volume).toBe(0);
      // Each bus gets its own gain: the parent's is not multiplied in (the buses are chained).
      expect(bus("Master").volume).toBeCloseTo(0.8);
    });

    it("applies snapshot and ducking gains the mixer resolved, and skips buses whose volume didn't change", async () => {
      const { backend } = rig();
      backend.play(req());
      await flush();
      const before = bus("SFX").ramps.length;
      backend.applyMix(mixer.resolveAll());
      expect(bus("SFX").ramps.length).toBe(before);
      const resolved = mixer.resolveAll().map((b) => (b.name === "Music" ? { ...b, gain: 0.4 } : b));
      backend.applyMix(resolved);
      expect(bus("Music").volume).toBe(0.4);
    });

    it("rebuilds the buses on configureBuses and moves live voices onto the new ones", async () => {
      const { backend } = rig();
      backend.play(req({ bus: "Music" }));
      await flush();
      const oldMusic = bus("Music");
      const oldMaster = bus("Master");
      configureMixer([{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Extra", parent: "Music" }]);
      backend.configureBuses(mixer);
      backend.applyMix(mixer.resolveAll());
      await flush();
      expect(oldMusic.disposed).toBe(true);
      expect(oldMaster.disposed).toBe(true);
      const names = engine().buses.map((b) => b.name);
      expect(names).toEqual(["Master", "SFX", "Music", "Master", "Music", "Extra"]);
      const newMusic = engine().buses.at(-2)!;
      expect(sound().outBus).toBe(newMusic);
      expect(engine().buses.at(-1)!.outBus).toBe(newMusic);
    });

    it("plays on the root when the bus name is unknown", async () => {
      const { backend } = rig();
      backend.play(req({ bus: "Gone" }));
      await flush();
      expect(sound().outBus).toBe(bus("Master"));
    });

    it("reports the buses in debug", async () => {
      const { backend } = rig();
      backend.play(req());
      backend.play(req());
      await flush();
      const info = backend.debug();
      expect(info.buses.find((b) => b.name === "SFX")).toMatchObject({ voices: 2, maxVoices: 2, gain: 1 });
      expect(info.buses.find((b) => b.name === "Music")).toMatchObject({ voices: 0, maxVoices: null });
    });
  });

  describe("BabylonBackend mixer features", () => {
    const tick = (seconds: number) => mixer.update(seconds);
    const mixConfig = {
      buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Music", parent: "Master" }],
      snapshots: [{ name: "Quiet", volumes: { Music: 0.25 } }],
      ducking: [{ trigger: "SFX", target: "Music", mode: "presence", amount: 0.4, attack: 0.1, release: 0.1 }],
    };

    it("carries a snapshot's gain to the bus volume as the mixer fades to it", async () => {
      mixer.configure(parseAudioSettings(mixConfig).settings);
      const { backend } = rig();
      backend.play(req({ bus: "Music" }));
      await flush();
      mixer.onChange(() => backend.applyMix(mixer.resolveAll()));
      mixer.snapshot("Quiet", 0);
      tick(0.016);
      expect(bus("Music").volume).toBeCloseTo(0.25);
      mixer.clearSnapshot(0);
      tick(0.016);
      expect(bus("Music").volume).toBeCloseTo(1);
    });

    it("ducks the target bus while a trigger-bus voice plays, for every way a voice can end", async () => {
      mixer.configure(parseAudioSettings(mixConfig).settings);
      const { backend } = rig();
      mixer.onChange(() => backend.applyMix(mixer.resolveAll()));
      const duck = () => {
        tick(1);
        return bus("Music").volume;
      };
      const first = backend.play(req())!;
      await flush();
      expect(duck()).toBeCloseTo(0.4);
      first.stop();
      expect(duck()).toBeCloseTo(1);
      // A clip that ends on its own.
      backend.play(req());
      await flush();
      expect(duck()).toBeCloseTo(0.4);
      sound(1).finish();
      expect(duck()).toBeCloseTo(1);
      // A fade-out ends the voice's bookkeeping at once: the duck releases as it begins.
      const faded = backend.play(req())!;
      await flush();
      expect(duck()).toBeCloseTo(0.4);
      faded.stop(0.5);
      expect(mixer.bus("SFX").activeVoices).toBe(0);
      expect(duck()).toBeCloseTo(1);
      // A voice moved onto the trigger bus ducks, and off it releases.
      const mover = backend.play(req({ bus: "Music" }))!;
      await flush();
      expect(duck()).toBeCloseTo(1);
      mover.setBus("SFX");
      expect(duck()).toBeCloseTo(0.4);
      mover.setBus("Music");
      expect(duck()).toBeCloseTo(1);
      // A failed load.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      babylonMock.failUrls.add("asset://bad.wav");
      const bad = backend.play(req({ url: "asset://bad.wav" }))!;
      expect(duck()).toBeCloseTo(0.4);
      await flush();
      expect(bad.reason).toBe("failed");
      expect(duck()).toBeCloseTo(1);
      // Dispose releases every bus.
      backend.play(req());
      expect(duck()).toBeCloseTo(0.4);
      backend.dispose();
      expect(mixer.bus("SFX").activeVoices).toBe(0);
      tick(1);
      expect(mixer.resolveAll().find((b) => b.name === "Music")!.gain).toBeCloseTo(1);
    });

    it("releases a trigger bus's count when the bus cap stops the oldest voice", async () => {
      mixer.configure(parseAudioSettings({ ...mixConfig, buses: [{ name: "Master" }, { name: "SFX", parent: "Master", maxVoices: 1 }, { name: "Music", parent: "Master" }] }).settings);
      const { backend } = rig();
      backend.play(req());
      backend.play(req());
      backend.play(req());
      expect(mixer.bus("SFX").activeVoices).toBe(1);
      await flush();
      sound().finish();
      expect(mixer.bus("SFX").activeVoices).toBe(0);
    });

    it("applies only the resolved gain: a snapshot's low-pass and bus effects have no node on the fallback", async () => {
      mixer.configure(parseAudioSettings({
        buses: [{ name: "Master" }, { name: "SFX", parent: "Master", effects: [{ type: "lowpass", frequency: 800 }] }],
        snapshots: [{ name: "Muffled", lowpass: { SFX: 500 } }],
      }).settings);
      const { backend } = rig();
      backend.play(req());
      await flush();
      mixer.snapshot("Muffled", 0);
      mixer.update(0.016);
      backend.applyMix(mixer.resolveAll());
      expect(bus("SFX").volume).toBe(1);
      expect(Object.keys(bus("SFX").options).filter((k) => k !== "outBus" && k !== "volume")).toEqual([]);
    });
  });
});

describe("mixCaps and loudness (ADR 0171 Bb2)", () => {
  const BUSES = [{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Music", parent: "Master" }];
  const backend = (): BabylonBackend => babylonRig().backend;

  beforeEach(() => {
    mixer.configure(parseAudioSettings({ buses: BUSES }).settings);
  });
  afterEach(() => {
    disposeBabylonRigs();
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
});

describe("mixCaps and CPU (ADR 0171 §9)", () => {
  const BUSES = [
    { name: "Master" },
    { name: "SFX", parent: "Master", maxVoices: 2 },
    { name: "Music", parent: "Master" },
    { name: "Voice", parent: "SFX" },
  ];
  // Slots: the mixer numbers the buses in list order.
  const SLOT = { Master: 0, SFX: 1, Music: 2, Voice: 3 } as const;

  function configure(): void {
    mixer.configure(parseAudioSettings({ buses: BUSES, snapshots: [{ name: "Quiet", volumes: { Music: 0.5 } }] }).settings);
  }

  const req = playRequest;

  function newBackend(visibility: unknown = null): BabylonBackend {
    const { backend: b } = babylonRig({ visibility: visibility as never, wire: false });
    setAudioBackend(b);
    mixer.onChange(() => b.applyMix(mixer.resolveAll()));
    return b;
  }

  beforeEach(() => {
    babylonMock.reset();
    configure();
  });
  afterEach(() => {
    setAudioBackend(null);
    disposeBabylonRigs(); // a disposed backend takes its tap off the mixer
    taps.sink = NULL_PROFILE_SINK;
    vi.restoreAllMocks();
  });

  describe("BabylonBackend mixCaps and CPU on the fallback (§9 CPU)", () => {
    it("captures main-side only", () => {
      expect(newBackend().mixCaps?.capture).toBe("mainSideOnly");
      expect(newBackend().debug().mixCaps?.capture).toBe("mainSideOnly");
    });

    it("Audio.debug().cpu has no load figure and says why", () => {
      const cpu = newBackend().debug().cpu!;
      expect(cpu.loadPermille).toBeNull();
      expect(cpu.hidden).toBe("Babylon fallback has no audio core");
    });
  });
});

describe("live mixing (ADR 0171 Bb3)", () => {
  const BUSES = [
    { name: "Master" },
    { name: "SFX", parent: "Master", maxVoices: 2, effects: [{ type: "lowpass", frequency: 4000 }, { type: "highpass", frequency: 80 }] },
    { name: "Music", parent: "Master" },
    { name: "Voice", parent: "SFX" },
  ];
  const DUCKING = [{ trigger: "SFX", target: "Music", mode: "presence", amount: 0.4, attack: 0.1, release: 0.1 }];

  function configure(extra: Record<string, unknown> = {}): void {
    mixer.configure(parseAudioSettings({ buses: BUSES, ducking: DUCKING, ...extra }).settings);
  }

  const req = playRequest;
  /** The buses the engine holds now: created and not disposed. */
  const liveBuses = (): MockBus[] => engine().buses.filter((b) => !b.disposed);
  const bus = (name: string): MockBus => liveBuses().find((b) => b.name === name)!;
  const parentOf = (name: string): string | null => bus(name).outBus?.name ?? null;
  const names = (): string[] => liveBuses().map((b) => b.name).sort();

  function newBackend(): BabylonBackend {
    const { backend: b } = babylonRig({ wire: false });
    setAudioBackend(b); // `mixer.apply(op)` sends to the backend's `mixOpTarget`
    mixer.onChange(() => b.applyMix(mixer.resolveAll()));
    return b;
  }

  /** A backend whose engine exists (a first play creates it and the buses). */
  async function rig(): Promise<BabylonBackend> {
    const b = newBackend();
    b.play(req({ bus: "Voice" }));
    await flush();
    return b;
  }

  beforeEach(() => {
    babylonMock.reset();
    configure();
  });
  afterEach(() => {
    setAudioBackend(null);
    disposeBabylonRigs();
    vi.restoreAllMocks();
  });

  describe("BabylonBackend direct ops (§9 Live mixing)", () => {
    it("sets a bus volume through mixer.apply and answers class direct", async () => {
      await rig();
      expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "direct" });
      mixer.update(0.1); // the authored lane's ramp is far shorter than this
      expect(bus("Music").volume).toBeCloseTo(0.5);
      expect(mixer.audioSettings.buses.find((b) => b.name === "Music")!.volume).toBe(0.5);
    });

    it("mutes and unmutes a bus", async () => {
      await rig();
      expect(mixer.apply({ op: "setBus", bus: "Music", key: "mute", value: true })).toEqual({ ok: true, class: "direct" });
      expect(bus("Music").volume).toBe(0);
      expect(mixer.apply({ op: "setBus", bus: "Music", key: "mute", value: false }).ok).toBe(true);
      expect(bus("Music").volume).toBeCloseTo(1);
    });

    it("does not rebuild the graph for a volume edit", async () => {
      await rig();
      const created = engine().buses.length;
      mixer.apply({ op: "setBus", bus: "SFX", key: "volume", value: 0.7 });
      mixer.update(0.1);
      expect(engine().buses.length).toBe(created);
      expect(engine().buses.some((b) => b.disposed)).toBe(false);
      expect(bus("SFX").volume).toBeCloseTo(0.7);
    });

    it("applies maxVoices at once: the next play stops the oldest voice over the new cap", async () => {
      const b = await rig();
      b.play(req());
      b.play(req());
      await flush();
      const sfx = () => b.debug().buses.find((x) => x.name === "SFX")!;
      expect(sfx()).toMatchObject({ voices: 2, maxVoices: 2 });
      expect(mixer.apply({ op: "setBus", bus: "SFX", key: "maxVoices", value: 1 })).toEqual({ ok: true, class: "direct" });
      b.play(req());
      await flush();
      expect(sfx()).toMatchObject({ voices: 1, maxVoices: 1 });
    });

    it.each<[string, MixOp]>([
      ["a filter parameter", { op: "setEffect", bus: "SFX", index: 0, key: "frequency", value: 2000 }],
      ["an effect appended", { op: "addEffect", bus: "Music", index: 0, effect: { type: "lowpass", frequency: 1000, q: 1 } }],
      ["a snapshot", { op: "addSnapshot", index: 0, name: "Quiet" }],
      ["a presence ducking rule", { op: "setDucking", index: 1, insert: true, rule: { trigger: "Voice", target: "Music", mode: "presence", amount: 0.5, attack: 0.1, release: 0.1 } }],
      ["a metered bus", { op: "setBus", bus: "Music", key: "meter", value: "loudness" }],
    ])("%s changes the model, answers direct and leaves the graph alone", async (_label, op) => {
      await rig();
      const created = engine().buses.length;
      expect(mixer.apply(op)).toEqual({ ok: true, class: "direct" });
      expect(engine().buses.length).toBe(created);
    });

    it("a compressor parameter answers smoothed and a bed edit answers config", async () => {
      configure({ buses: [BUSES[0], { name: "SFX", parent: "Master", effects: [{ type: "compressor" }] }, BUSES[2], BUSES[3]] });
      await rig();
      expect(mixer.apply({ op: "setEffect", bus: "SFX", index: 0, key: "ratio", value: 6 }).class).toBe("smoothed");
      expect(mixer.apply({ op: "setBus", bus: "Music", key: "bedPriority", value: 3 })).toEqual({ ok: true, class: "config" });
    });

    it("refuses a bad op with ok false, and a re-applied value is ok with class none", async () => {
      await rig();
      expect(mixer.apply({ op: "setBus", bus: "Nope", key: "volume", value: 0.5 })).toEqual({ ok: false, class: "none" });
      mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
      expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "none" });
    });

    it("flushNow does nothing and does not throw (no batch is staged)", async () => {
      const b = await rig();
      expect(() => b.flushNow()).not.toThrow();
    });

    it("applies an op before the first play (no engine yet) and creates nothing", () => {
      newBackend();
      expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "direct" });
      expect(babylonMock.creates).toBe(0);
    });
  });

  describe("BabylonBackend presence ducking through main (§9 Ducking)", () => {
    it("a presence rule added live ducks its target while the trigger plays", async () => {
      const b = await rig();
      mixer.apply({ op: "setDucking", index: 0, rule: null });
      b.play(req({ bus: "SFX" }));
      await flush();
      mixer.update(1);
      expect(bus("Music").volume).toBeCloseTo(1);
      expect(mixer.apply({ op: "setDucking", index: 0, insert: true, rule: { trigger: "SFX", target: "Music", mode: "presence", amount: 0.4, attack: 0.1, release: 0.1 } })).toEqual({ ok: true, class: "direct" });
      mixer.update(1);
      expect(bus("Music").volume).toBeCloseTo(0.4);
      expect(mixer.bus("Music").duckGain).toBeCloseTo(0.4);
    });

    it("the configured presence rule still ducks after unrelated live edits", async () => {
      const b = await rig();
      mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
      b.play(req({ bus: "SFX" }));
      await flush();
      mixer.update(1);
      expect(bus("Music").volume).toBeCloseTo(0.5 * 0.4);
    });
  });

  describe("BabylonBackend level ducking rules (§9 Ducking)", () => {
    const level: MixOp = { op: "setDucking", index: 1, insert: true, rule: { trigger: "SFX", target: "Music", mode: "level", detector: "rms", threshold: -30, amount: 0.3, attack: 0.1, release: 0.1 } };

    it("answers as needing the audio core, with the design's message", async () => {
      await rig();
      expect(mixer.apply(level)).toEqual({ ok: false, class: "direct", reason: "needsAudioCore" });
      expect(reasonMessage("needsAudioCore")).toBe("Needs the audio core");
    });

    it("does nothing: the level rule never ducks, while a presence rule beside it still does", async () => {
      const b = await rig();
      mixer.apply({ op: "setDucking", index: 0, rule: null });
      mixer.apply({ op: "setDucking", index: 0, insert: true, rule: { trigger: "SFX", target: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.3, attack: 0.1, release: 0.1 } });
      b.play(req({ bus: "SFX" }));
      await flush();
      mixer.update(2);
      expect(bus("Voice").volume).toBeCloseTo(1);
      expect(mixer.bus("Voice").duckGain).toBe(1);
      mixer.apply({ op: "setDucking", index: 1, insert: true, rule: { trigger: "SFX", target: "Music", mode: "presence", amount: 0.4, attack: 0.1, release: 0.1 } });
      mixer.update(1);
      expect(bus("Music").volume).toBeCloseTo(0.4);
    });

    it("editing a presence rule into level mode stops its ducking and answers the same", async () => {
      const b = await rig();
      b.play(req({ bus: "SFX" }));
      await flush();
      mixer.update(1);
      expect(bus("Music").volume).toBeCloseTo(0.4);
      const r = mixer.apply({ op: "setDucking", index: 0, rule: { trigger: "SFX", target: "Music", mode: "level", detector: "rms", threshold: -30, amount: 0.4, attack: 0.1, release: 0.1 } });
      expect(r.reason).toBe("needsAudioCore");
      mixer.update(1);
      expect(bus("Music").volume).toBeCloseTo(1);
    });

    it("removing a level rule is an ordinary edit", async () => {
      await rig();
      mixer.apply(level);
      expect(mixer.apply({ op: "setDucking", index: 1, rule: null })).toEqual({ ok: true, class: "direct" });
    });

    it("debug lists the level rule as mode level with no duck", async () => {
      const b = await rig();
      mixer.apply(level);
      const d = b.debug().mix!.ducking;
      expect(d.map((r) => r.mode)).toEqual(["presence", "level"]);
      expect(d[1]!.gain).toBe(1);
      expect(b.mixCaps.levelDucking).toBe(false);
    });
  });

  describe("BabylonBackend structural ops rebuild the graph (§9 Live mixing)", () => {
    const shape = (): Record<string, [string | null, number]> => {
      const s: Record<string, [string | null, number]> = {};
      for (const b of liveBuses()) s[b.name] = [b.outBus?.name ?? null, b.volume];
      return s;
    };

    it("a move reparents the bus: new nodes, the old ones disposed, voices carried over", async () => {
      await rig();
      const before = liveBuses();
      expect(mixer.apply({ op: "moveBus", bus: "Voice", parent: "Music" })).toEqual({ ok: true, class: "dip" });
      await flush();
      expect(before.every((x) => x.disposed)).toBe(true);
      expect(names()).toEqual(["Master", "Music", "SFX", "Voice"]);
      expect(parentOf("Voice")).toBe("Music");
      expect(parentOf("Music")).toBe("Master");
      expect(engine().sounds[engine().sounds.length - 1]!.outBus).toBe(bus("Voice"));
    });

    it("lands on the end state of several structural ops in a row", async () => {
      await rig();
      mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
      mixer.apply({ op: "addBus", name: "Ambience", parent: "Master" });
      mixer.apply({ op: "moveBus", bus: "Voice", parent: "Ambience" });
      mixer.apply({ op: "removeBus", bus: "SFX" });
      mixer.update(0.1);
      await flush();
      expect(shape()).toEqual({ Master: ["default", 1], Music: ["Master", 0.5], Ambience: ["Master", 1], Voice: ["Ambience", 1] });
      expect(mixer.audioSettings.buses.map((x) => x.name).sort()).toEqual(["Ambience", "Master", "Music", "Voice"]);
    });

    it("a removed bus's nodes go, its voices play on the root, and the mixer no longer resolves it", async () => {
      const b = await rig();
      b.play(req({ bus: "SFX" }))!;
      await flush();
      expect(mixer.apply({ op: "removeBus", bus: "SFX" })).toEqual({ ok: true, class: "dip" });
      await flush();
      expect(names()).toEqual(["Master", "Music"]);
      // the SFX voice and the Voice voice (a descendant) both moved to the root
      expect(b.debug().buses.find((x) => x.name === "Master")!.voices).toBe(2);
      expect(engine().sounds[engine().sounds.length - 1]!.outBus).toBe(bus("Master"));
      expect(mixer.resolveAll().map((x) => x.name).sort()).toEqual(["Master", "Music"]);
      expect(b.debug().buses.map((x) => x.name).sort()).toEqual(["Master", "Music"]);
    });

    it("an added bus gets a node under its parent", async () => {
      await rig();
      expect(mixer.apply({ op: "addBus", name: "Ambience", parent: "Music" })).toEqual({ ok: true, class: "direct" });
      await flush();
      expect(parentOf("Ambience")).toBe("Music");
      expect(bus("Ambience").volume).toBe(1);
    });

    it("a rename rebuilds under the new name and keeps the voices and the bus's volume", async () => {
      const b = await rig();
      mixer.apply({ op: "setBus", bus: "SFX", key: "volume", value: 0.6 });
      mixer.update(0.1);
      b.play(req({ bus: "SFX" }))!;
      await flush();
      expect(mixer.apply({ op: "renameBus", from: "SFX", to: "Effects" })).toEqual({ ok: true, class: "config" });
      await flush();
      expect(names()).toEqual(["Effects", "Master", "Music", "Voice"]);
      expect(bus("Effects").volume).toBeCloseTo(0.6);
      expect(parentOf("Voice")).toBe("Effects");
      expect(b.debug().buses.find((x) => x.name === "Effects")!.voices).toBe(1);
    });

    it.each<[string, MixOp]>([
      ["removeEffect", { op: "removeEffect", bus: "SFX", index: 0 }],
      ["moveEffect", { op: "moveEffect", bus: "SFX", from: 0, to: 1 }],
      ["an effect inserted before the end", { op: "addEffect", bus: "SFX", index: 0, effect: { type: "lowpass", frequency: 900, q: 1 } }],
    ])("%s answers dip, rebuilds the graph and keeps the volumes", async (_label, op) => {
      await rig();
      const before = liveBuses();
      expect(mixer.apply(op)).toEqual({ ok: true, class: "dip" });
      await flush();
      expect(before.every((x) => x.disposed)).toBe(true);
      expect(shape()).toEqual({ Master: ["default", 1], SFX: ["Master", 1], Music: ["Master", 1], Voice: ["SFX", 1] });
    });

    it("a rebuilt bus still takes volume edits on the engine's short ramp", async () => {
      await rig();
      expect(engine().options).toMatchObject({ parameterRampDuration: 0.015 });
      mixer.apply({ op: "moveBus", bus: "Voice", parent: "Music" });
      await flush();
      mixer.apply({ op: "setBus", bus: "Voice", key: "volume", value: 0.5 });
      mixer.update(0.1);
      expect(bus("Voice").volume).toBeCloseTo(0.5);
    });
  });

  describe("BabylonBackend debug and panel rows (§9)", () => {
    it("reports the capabilities that say what the fallback lacks, and no CPU figure", async () => {
      const d = (await rig()).debug();
      expect(d.mixCaps).toEqual({ loudness: false, levelDucking: false, cpu: false, cpuReason: "Babylon fallback has no audio core", stampedBusRamps: false, capture: "mainSideOnly" });
      expect(d.cpu).toMatchObject({ loadPermille: null, hidden: "Babylon fallback has no audio core" });
    });

    it("loudness stays inert after a live edit that meters a bus", async () => {
      await rig();
      mixer.apply({ op: "setBus", bus: "Music", key: "meter", value: "loudness" });
      const l = mixer.bus("Music").loudness;
      expect(l.metered).toBe(false);
      expect(l.integrated).toBe(Number.NEGATIVE_INFINITY);
    });

    it("the mix section counts no refused or deferred edit and its slots follow the live tree", async () => {
      const b = await rig();
      mixer.apply({ op: "addBus", name: "Ambience", parent: "Master" });
      mixer.apply({ op: "removeBus", bus: "SFX" });
      await flush();
      const mix = b.debug().mix!;
      expect(mix.liveRefused).toBe(0);
      expect(mix.liveDeferred).toBe(0);
      expect(mix.liveDeferredPending).toBe(0);
      expect(mix.slots.map((s) => s.name).sort()).toEqual(["Ambience", "Master", "Music"]);
    });
  });
});

describe("returns, sends and bus effects (ADR 0344)", () => {
  const pageSettings = mixer.audioSettings;
  let backend: BabylonBackend;

  const make = (): BabylonBackend => babylonRig({ wire: false }).backend;
  const mixWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((c) => String(c[0]).includes("need the audio core") && String(c[0]).includes("returns, bus sends and bus effects"));

  beforeEach(() => {
    babylonMock.reset();
    endAudioSession();
  });
  afterEach(() => {
    disposeBabylonRigs();
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
});
