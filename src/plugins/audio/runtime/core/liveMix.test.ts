// ADR 0171 amended by 0172 (Ma1; api-and-models §6.2, §6.6): the live path's answers per class, the preview path's
// coalescing, and its routing. The core-level cases (each class's records in its frame's batch, on the audio clock) are in
// `liveMixLoopback.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { DRAG_RAMP_MS, Mixer } from "../../../../engine/audio/mixer";
import { MIX_OP_NAMES, opClass, type MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { DRAG_RAMP_MS as WIRE_DRAG_RAMP_MS, FADER_COALESCE_MS } from "../wire.generated";
import { CoreBackend } from "./coreBackend";
import { DeferredAdds } from "./deferredAdds";
import { FIFTH_EFFECT, LiveMix, RESTART_REQUIRED, type LiveMixHost } from "./liveMix";
import { DIP_UNAVAILABLE, StructuralDip } from "./structuralDip";

const PROJECT = {
  buses: [
    { name: "Master" },
    { name: "Music", parent: "Master", effects: [{ type: "lowpass", frequency: 800, q: 1 }, { type: "compressor", threshold: -12, knee: 6, ratio: 4, attack: 0.01, release: 0.2 }] },
    { name: "SFX", parent: "Master" },
    { name: "Voice", parent: "Master" },
    { name: "UI", parent: "Master" },
  ],
  snapshots: [{ name: "Paused", volumes: { Music: 0.5 } }],
};

/** One op of each name, with the class it has against `PROJECT` (§6.2's table). */
const OPS: [MixOp, string][] = [
  [{ op: "setBus", bus: "Music", key: "volume", value: 0.5 }, "direct"],
  [{ op: "setBus", bus: "Music", key: "bed", value: "own" }, "config"],
  [{ op: "setBus", bus: "Voice", key: "meter", value: "loudness" }, "direct"],
  [{ op: "addBus", name: "Amb", parent: "Master" }, "direct"],
  [{ op: "removeBus", bus: "SFX" }, "dip"],
  [{ op: "renameBus", from: "UI", to: "Menu" }, "config"],
  [{ op: "moveBus", bus: "Voice", parent: "Music" }, "dip"],
  [{ op: "addEffect", bus: "Music", index: 2, effect: { type: "highpass", frequency: 80, q: 1 } }, "direct"],
  [{ op: "removeEffect", bus: "Music", index: 0 }, "dip"],
  [{ op: "moveEffect", bus: "Music", from: 0, to: 1 }, "dip"],
  [{ op: "setEffect", bus: "Music", index: 0, key: "frequency", value: 1200 }, "direct"],
  [{ op: "setEffect", bus: "Music", index: 1, key: "threshold", value: -18 }, "smoothed"],
  [{ op: "addSnapshot", index: 1, name: "Menu" }, "direct"],
  [{ op: "removeSnapshot", index: 0 }, "direct"],
  [{ op: "renameSnapshot", index: 0, name: "Hush" }, "direct"],
  [{ op: "setSnapshot", index: 0, bus: "Music", key: "volume", value: 0.3 }, "direct"],
  [{ op: "setDucking", index: 0, insert: true, rule: { target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.5 } }, "direct"],
  [{ op: "setAutomation", index: 0, insert: true, rule: { bus: "Music", parameter: "x", target: "volume", curve: [[0, 1]] } }, "direct"],
  [{ op: "setTarget", index: 0, target: { name: "console", integrated: -23, tolerance: 2, truePeak: -1 } }, "direct"],
  [{ op: "setOption", key: "loudnessResetOnPlay", value: false }, "config"],
];

/** A backend with a recording link (no wasm), over its own mixer. */
function backendRig() {
  const posted: ArrayBuffer[] = [];
  const mixer = new Mixer(parseAudioSettings(PROJECT).settings);
  const link = {
    batchPool: { acquire: () => new ArrayBuffer(64 * 1024), release() {} },
    nextSeq: () => 1,
    post: (b: ArrayBuffer) => void posted.push(b),
    onStatus: () => () => {},
    statusDecoder: null,
  };
  const host = {
    link,
    status: "running" as const,
    preset: { maxLogical: 16 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: () => () => {},
  };
  const clock = { rafTime: () => 0, outputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }), currentTime: () => 0, dateNow: () => 0, fake: true as const };
  const clips = { acquire: () => 1, release() {}, state: () => "ready", info: () => null, onResident: () => () => {}, releaseWorld() {}, applyClipEvent() {}, residentIds: () => [], acquireReserved() {} };
  const backend = new CoreBackend(host as never, { clips: clips as never, clock: clock as never, mixer });
  return { backend, mixer, posted };
}

describe("liveMix (Ma1)", () => {
  it("covers every op name, and the wire's DRAG_RAMP_MS is the mixer's", () => {
    expect(new Set(OPS.map(([o]) => o.op))).toEqual(new Set(MIX_OP_NAMES));
    expect(DRAG_RAMP_MS).toBe(WIRE_DRAG_RAMP_MS);
    const settings = parseAudioSettings(PROJECT).settings;
    for (const [op, cls] of OPS) expect(opClass(op, settings), op.op).toBe(cls);
  });

  it("answers each class: every class applies (ok), dip through Ma2's sequence; the model changes at once", () => {
    for (const [op, cls] of OPS) {
      const { backend, mixer } = backendRig();
      const before = mixer.audioSettings;
      const r = mixer.apply(op);
      expect(r, op.op).toEqual({ ok: true, class: cls });
      expect(mixer.audioSettings, op.op).not.toBe(before);
      expect(backend.liveMix.refused).toBe(0);
      if (cls === "dip") expect(backend.dip.inFlight, op.op).toBe(true);
      backend.dispose();
    }
  });

  it("a structural op with no dip bound answers restartRequired and changes nothing (a backend with no live path)", () => {
    const dip = new StructuralDip();
    expect(dip.apply({ op: "moveBus", bus: "Voice", parent: "Music" })).toEqual({ ok: false, class: "dip", restartRequired: DIP_UNAVAILABLE });
    expect(RESTART_REQUIRED).toMatch(/next Play/);
  });

  it("a fifth effect inserted mid-chain (a dip-class insert) applies at the next Play too", () => {
    const { backend, mixer } = backendRig();
    for (let k = 2; k < 4; k++) expect(mixer.apply({ op: "addEffect", bus: "Music", index: k, effect: { type: "highpass", frequency: 80, q: 1 } }).ok).toBe(true);
    const before = mixer.audioSettings;
    expect(mixer.apply({ op: "addEffect", bus: "Music", index: 0, effect: { type: "highpass", frequency: 80, q: 1 } })).toEqual({ ok: false, class: "dip", restartRequired: FIFTH_EFFECT });
    expect(mixer.audioSettings).toBe(before);
    backend.dispose();
  });

  it("an op that changes nothing is a no-op (a commit after its preview); a refused op changes nothing and is counted", () => {
    const { backend, mixer } = backendRig();
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "direct" });
    const settings = mixer.audioSettings;
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "none" });
    expect(mixer.apply({ op: "setBus", bus: "Nope", key: "volume", value: 0.5 })).toEqual({ ok: false, class: "none" });
    expect(mixer.audioSettings).toBe(settings);
    expect(backend.liveMix.refused).toBe(1);
    backend.dispose();
  });

  it("a fifth effect on a bus applies at the next Play (BUS_SLOT carries four)", () => {
    const { backend, mixer } = backendRig();
    for (let k = 2; k < 4; k++) expect(mixer.apply({ op: "addEffect", bus: "Music", index: k, effect: { type: "highpass", frequency: 80, q: 1 } }).ok).toBe(true);
    expect(mixer.apply({ op: "addEffect", bus: "Music", index: 4, effect: { type: "highpass", frequency: 80, q: 1 } })).toEqual({ ok: false, class: "direct", restartRequired: FIFTH_EFFECT });
    expect(mixer.audioSettings.buses[1]!.effects).toHaveLength(4);
    backend.dispose();
  });

  it("an authored edit keeps every runtime value: the script's volume, its mute, its fade and the snapshot in force", () => {
    const { backend, mixer } = backendRig();
    const music = mixer.bus("Music");
    music.volume = 0.5;
    music.mute = true;
    mixer.snapshot("Paused", 0);
    mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.25 });
    mixer.apply({ op: "setBus", bus: "Music", key: "mute", value: true });
    expect(music.volume).toBe(0.5);
    expect(music.mute).toBe(true);
    expect(music.authoredMute).toBe(true);
    expect(mixer.currentSnapshot).toBe("Paused");
    expect(mixer._lanes("Music")!.authored).toMatchObject({ to: 0.25, seconds: DRAG_RAMP_MS / 1000 });
    expect(mixer._lanes("Music")!.runtime.to).toBe(0.5);
    backend.dispose();
  });

  it("a rename keeps the bus's slot and state; a held handle and new plays under the old name reach it", () => {
    const { backend, mixer } = backendRig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ui = mixer.bus("UI");
    ui.volume = 0.7;
    expect(mixer.apply({ op: "renameBus", from: "UI", to: "Menu" })).toEqual({ ok: true, class: "config" });
    expect(backend.buses.slotOf("Menu")).toBe(4);
    expect(backend.buses.slotOf("UI")).toBe(4);
    expect(backend.busNames[4]).toBe("Menu");
    expect(mixer.bus("Menu").volume).toBe(0.7);
    expect(ui.volume).toBe(0.7);
    expect(mixer.resolveOutput("UI")).toBe("Menu");
    const v = backend.play({ path: "a.wav", url: "a.wav", loop: false, stream: false, bus: "UI" })!;
    expect(backend.table.bus[v.id & 0xffff]).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1); // one warning for the old name
    warn.mockRestore();
    backend.dispose();
  });

  it("an added bus takes the next slot and the running tree stays in slot order", () => {
    const { backend, mixer } = backendRig();
    expect(mixer.apply({ op: "addBus", name: "Amb", parent: "Music", index: 1 })).toEqual({ ok: true, class: "direct" });
    expect(backend.buses.slotOf("Amb")).toBe(5);
    expect(mixer.busNames).toEqual(["Master", "Music", "SFX", "Voice", "UI", "Amb"]);
    expect(mixer.audioSettings.buses.map((b) => b.name)).toEqual(mixer.busNames);
    expect(backend.busConfigWire()[5]).toEqual({ parent: 1, effects: [] });
    backend.dispose();
  });

  it("CoreBackend.applyOp routes to liveMix; mixer.apply reaches the active backend's applyOp, and nothing once it is gone", async () => {
    const apply = vi.fn(() => ({ ok: true, class: "direct" as const }));
    expect(CoreBackend.prototype.applyOp.call({ liveMix: { apply } } as unknown as CoreBackend, OPS[0]![0])).toEqual({ ok: true, class: "direct" });
    expect(apply).toHaveBeenCalledWith(OPS[0]![0]);
    const { makeFakeBackend } = await import("../testing");
    const { setAudioBackend, mixer } = await import("../backend");
    const fake = makeFakeBackend();
    setAudioBackend(fake);
    try {
      expect(mixer.apply(OPS[0]![0])).toEqual({ ok: true, class: "direct" });
      expect(fake.ops).toEqual([OPS[0]![0]]);
    } finally {
      setAudioBackend(null);
    }
    expect(mixer.apply(OPS[0]![0]).restartRequired).toBeTruthy();
    expect(fake.ops).toHaveLength(1);
  });
});

describe("flushNow (the preview path, §6.6)", () => {
  function flushRig() {
    let now = 0;
    let pending = 0;
    const posts: number[] = [];
    const timers: { at: number; fn: () => void }[] = [];
    const host: LiveMixHost = {
      dip: new StructuralDip(),
      deferred: new DeferredAdds(),
      mixer: () => { throw new Error("unused"); },
      buses: () => { throw new Error("unused"); },
      writer: () => ({ busSlot() {}, loudConfig() {}, busRampFrames() {}, sampleRate: 48_000, get pending() { return pending; }, flush: () => { posts.push(now); pending = 0; return 1; } }),
      automation: () => ({ renameBus() {} }),
      syncMix() {},
      sending: () => true,
      firstFrame: () => 0,
      nowMs: () => now,
      setTimer: (fn, ms) => void timers.push({ at: now + ms, fn }),
    };
    const live = new LiveMix(host);
    /** Advances the fake clock to `t`, firing due timers in order. */
    const to = (t: number) => {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > t) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = t;
    };
    return { live, posts, to, stage: () => void pending++, timers };
  }

  it("posts at once, then at most once per FADER_COALESCE_MS; an edit inside the window goes out when it ends", () => {
    const { live, posts, to, stage, timers } = flushRig();
    stage();
    live.flushNow();
    expect(posts).toEqual([0]);
    to(1);
    stage();
    live.flushNow();
    to(2);
    stage();
    live.flushNow();
    expect(posts).toEqual([0]); // held
    expect(timers).toHaveLength(1); // one timer for the window
    to(FADER_COALESCE_MS);
    expect(posts).toEqual([0, FADER_COALESCE_MS]); // both held edits in one post at the window's end
    to(20);
    live.flushNow(); // nothing staged: no post
    expect(posts).toHaveLength(2);
  });

  it("a 100-step drag at a pointer event every 0.5 ms posts no more than once per window, and its last edit goes out", () => {
    const { live, posts, to, stage } = flushRig();
    for (let k = 0; k < 100; k++) {
      to(k * 0.5);
      stage();
      live.flushNow();
    }
    to(100);
    for (let i = 1; i < posts.length; i++) expect(posts[i]! - posts[i - 1]!).toBeGreaterThanOrEqual(FADER_COALESCE_MS);
    expect(posts.length).toBeLessThanOrEqual(Math.floor(49.5 / FADER_COALESCE_MS) + 2);
    expect(posts[posts.length - 1]!).toBeGreaterThanOrEqual(49.5); // the last edit (at 49.5 ms) was posted
    expect(live.posts).toBe(posts.length);
  });

  it("posts nothing while the backend can't send (locked, recovering, disposed)", () => {
    const { backend, mixer, posted } = backendRig();
    (backend.host as { status: string }).status = "locked";
    mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
    posted.length = 0;
    backend.flushNow();
    expect(posted).toHaveLength(0);
    backend.dispose();
  });
});
