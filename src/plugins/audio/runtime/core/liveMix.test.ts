// ADR 0171 amended by 0172 (Ma1; api-and-models §6.2, §6.6): the live path's answers per class, the preview path's
// coalescing, and its routing. The core-level cases (each class's records in its frame's batch, on the audio clock) are in
// `liveMixLoopback.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAG_RAMP_MS } from "../../../../engine/audio/mixer";
import { MIX_OP_NAMES, isProjectOp, opClass, type MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { mixJsonOf, parseAudioProject } from "../../../../engine/audio/project/format";
import { BUS_SEND_MUTED, BUS_SLOT_FLAGS_FRESH, BUS_SLOT_FLAGS_STRUCTURAL, DRAG_RAMP_MS as WIRE_DRAG_RAMP_MS, FADER_COALESCE_MS, LANE_AUTHORED, Op, readBusRamp, readBusSends, readBusSlot } from "../wire.generated";
import { closeRecordingAudio, recordingAudio } from "../testing";
import { DeferredAdds } from "./deferredAdds";
import { LiveMix, type LiveMixHost } from "./liveMix";
import { StructuralDip } from "./structuralDip";

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

/** A backend on the recording host (no wasm, ADR 0234), over its own mixer. */
function backendRig() {
  const r = recordingAudio({ mixer: "own", settings: parseAudioSettings(PROJECT).settings, preset: { maxLogical: 16 } });
  return { backend: r.backend, mixer: r.mixer, posted: r.posted, tick: (dt: number) => r.tick(dt) };
}

afterEach(closeRecordingAudio);

describe("liveMix (Ma1)", () => {
  it("covers every op name, and the wire's DRAG_RAMP_MS is the mixer's", () => {
    // The mix model's own ops (ADR 0330) reach the core as the old ops they change (`mixer.apply`; `projectOps.test.ts`).
    expect(new Set(OPS.map(([o]) => o.op))).toEqual(new Set(MIX_OP_NAMES.filter((n) => !isProjectOp({ op: n }))));
    expect(DRAG_RAMP_MS).toBe(WIRE_DRAG_RAMP_MS);
    const settings = parseAudioSettings(PROJECT).settings;
    for (const [op, cls] of OPS) expect(opClass(op, settings), op.op).toBe(cls);
  });

  it("answers each class: every class applies (ok), dip through Ma2's sequence; the model changes at once", () => {
    for (const [op, cls] of OPS) {
      const { backend, mixer, posted, tick } = backendRig();
      const before = mixer.audioSettings;
      const r = mixer.apply(op);
      expect(r, op.op).toEqual({ ok: true, class: cls });
      expect(mixer.audioSettings, op.op).not.toBe(before);
      expect(backend.debug().mix!.liveRefused).toBe(0);
      if (cls === "dip") {
        // The frame emits the open sequence: a structural BUS_SLOT tagged with its sequence id.
        posted.take();
        tick(0.016);
        const slots = posted.takeOps(Op.BUS_SLOT).map((x) => readBusSlot(x.view, x.off));
        expect(slots.some((x) => x.sequenceId > 0 && (x.flags & BUS_SLOT_FLAGS_STRUCTURAL) !== 0), op.op).toBe(true);
      }
      backend.dispose();
    }
  });

  // ADR 0330: what the main thread moves of a bus's effects (a snapshot's override) reaches the core as one BUS_SLOT for
  // that bus; the mix model's own ops send the old ops they change of the bus view: a return is a bus of it (ABI 4.7), so
  // its level is its own authored lane, and the sends into it are BUS_SENDS of the buses that feed it.
  it("the mixer's live effects reach the core: a snapshot override is a BUS_SLOT, a return's level its own lane, a send BUS_SENDS", () => {
    const project = parseAudioProject({
      format: "myco.audio@1",
      buses: [
        { name: "Master", parent: null },
        { name: "Music", parent: "Master", effects: [{ id: "fx1", type: "lowpass", params: { cutoff: 12000 } }] },
        { name: "SFX", parent: "Master", sends: [{ to: "Reverb", levelDb: -6 }] },
      ],
      returns: [{ name: "Reverb", output: "Master", effects: [{ id: "fx1", type: "reverb", params: { mix: 100 } }] }],
      snapshots: [{ name: "Under", fadeInMs: 0, effects: { Music: { fx1: { cutoff: 900 } } } }],
    }).project;
    const r = recordingAudio({ mixer: "own", settings: { ...parseAudioSettings({}).settings, mix: mixJsonOf(project) }, preset: { maxLogical: 16 } });
    const slots = () => r.posted.takeOps(Op.BUS_SLOT).map((x) => readBusSlot(x.view, x.off));
    r.tick(0.016);
    r.posted.take();
    r.mixer.startSnapshot("Under");
    r.mixer.update(0.016); // the rig's tick runs the backend's frame only
    r.tick(0.016);
    const music = slots().filter((x) => x.slot === 1);
    expect(music.at(-1)!.effects.map((e) => [e.type, e.p[0]])).toEqual([[0, 900]]);
    r.posted.take();
    r.mixer.apply({ op: "setReturn", name: "Reverb", ret: { name: "Reverb", output: "Master", volumeDb: -6, mute: false, effects: project.returns[0]!.effects } });
    r.mixer.update(0.016);
    r.tick(0.016);
    expect(r.backend.buses.slotOf("Reverb")).toBe(3);
    const ramps = r.posted.takeOps(Op.BUS_RAMP).map((x) => readBusRamp(x.view, x.off)).filter((x) => x.voiceId === 3 && x.lane === LANE_AUTHORED);
    expect(ramps.at(-1)!.gain).toBeCloseTo(Math.pow(10, -6 / 20), 6);
    expect(slots().filter((x) => x.slot === 2), "SFX's chain is untouched").toEqual([]);
    // A send's level: BUS_SENDS for SFX into the return's slot.
    r.mixer.apply({ op: "setSend", bus: "SFX", to: "Reverb", levelDb: -12 });
    r.mixer.update(0.016);
    r.tick(0.016);
    const sends = r.posted.takeOps(Op.BUS_SENDS).map((x) => readBusSends(x.view, x.off));
    expect(sends.map((x) => [x.voiceId, x.sends.map((y) => [y.to, y.flags])])).toEqual([[2, [[3, 0]]]]);
    expect(sends[0]!.sends[0]!.level).toBeCloseTo(Math.pow(10, -12 / 20), 6);
    r.backend.dispose();
  });

  // ADR 0330: a return added live takes a fresh slot (an appended BUS_SLOT, as a bus added live); a send into it is a
  // BUS_SENDS of the sending bus naming that slot; a send removed is kept muted (it ramps out, no cut), its level kept.
  it("a return added live gets a slot, a send into it a BUS_SENDS; a removed send fades out muted", () => {
    const project = parseAudioProject({ format: "myco.audio@1", buses: [{ name: "Master", parent: null }, { name: "SFX", parent: "Master" }] }).project;
    const r = recordingAudio({ mixer: "own", settings: { ...parseAudioSettings({}).settings, mix: mixJsonOf(project) }, preset: { maxLogical: 16 } });
    const frame = () => (r.mixer.update(0.016), r.tick(0.016));
    frame();
    r.posted.take();
    expect(r.mixer.apply({ op: "setReturn", name: "Echo", ret: { name: "Echo", output: "Master", volumeDb: 0, mute: false, effects: [{ id: "fx1", type: "delay", on: true, params: { time: 100, feedback: 0, mix: 100 } }] } }).ok).toBe(true);
    frame();
    const echo = r.backend.buses.slotOf("Echo");
    expect(echo).toBe(2);
    expect(r.posted.takeOps(Op.BUS_SLOT).map((x) => readBusSlot(x.view, x.off)).some((x) => x.slot === echo && (x.flags & BUS_SLOT_FLAGS_FRESH) !== 0)).toBe(true);
    expect(r.mixer.apply({ op: "setSend", bus: "SFX", to: "Echo", levelDb: -6 })).toEqual({ ok: true, class: "direct" });
    frame();
    const sends = () => r.posted.takeOps(Op.BUS_SENDS).map((x) => readBusSends(x.view, x.off)).map((x) => [x.voiceId, x.sends.map((y) => [y.to, y.flags, Number(y.level.toFixed(4))])]);
    expect(sends()).toEqual([[1, [[echo, 0, 0.5012]]]]);
    frame();
    expect(sends(), "nothing moved: nothing sent").toEqual([]);
    r.mixer.apply({ op: "setSend", bus: "SFX", to: "Echo", levelDb: null });
    frame();
    expect(sends()).toEqual([[1, [[echo, BUS_SEND_MUTED, 0.5012]]]]);
    r.backend.dispose();
  });

  it("a structural op with no dip bound is kept for the next Play and changes nothing (a backend with no live path)", () => {
    const dip = new StructuralDip();
    expect(dip.apply({ op: "moveBus", bus: "Voice", parent: "Music" })).toEqual({ ok: false, class: "dip", reason: "structuralUnavailable" });
  });

  it("an op that changes nothing is a no-op (a commit after its preview); a refused op changes nothing and is counted", () => {
    const { backend, mixer } = backendRig();
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "direct" });
    const settings = mixer.audioSettings;
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "none" });
    expect(mixer.apply({ op: "setBus", bus: "Nope", key: "volume", value: 0.5 })).toEqual({ ok: false, class: "none" });
    expect(mixer.audioSettings).toBe(settings);
    expect(backend.debug().mix!.liveRefused).toBe(1);
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
    expect(backend.debug().voices.find((x) => x.id === v.id)!.bus).toBe("Menu");
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

  it("mixer.apply reaches CoreBackend's mixOpTarget, the active backend's target, and nothing once it is gone", async () => {
    const { backend, mixer: own } = backendRig();
    const send = vi.spyOn(backend.mixOpTarget, "sendOp");
    expect(own.apply(OPS[0]![0])).toEqual({ ok: true, class: "direct" });
    expect(send).toHaveBeenCalledWith(OPS[0]![0], "direct");
    backend.dispose();
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
    expect(mixer.apply(OPS[0]![0])).toEqual({ ok: false, class: "none", reason: "noLiveBackend" });
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
      session: { maySend: true },
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
  });
});
