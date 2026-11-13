// ADR 0171 (K0): until Ma1 fills the live path, every op answers `restartRequired` (applies at the next Play), so no
// live edit can reach the core and click. One op per `op` name covers every class of §6.2's table.
import { describe, expect, it } from "vitest";
import { MIX_OP_NAMES, type MixOp } from "../../../../engine/audio/mixOps";
import { CoreBackend } from "./coreBackend";
import { DeferredAdds } from "./deferredAdds";
import { LiveMix, RESTART_REQUIRED } from "./liveMix";
import { StructuralDip } from "./structuralDip";

/** One op of each name: direct (setBus volume, addBus, setEffect on a filter, snapshot, ducking, automation, target), smoothed (setEffect on a compressor), dip (moveBus, removeBus, removeEffect, moveEffect), config (renameBus, setBus bed, setOption). */
const OPS: MixOp[] = [
  { op: "setBus", bus: "Music", key: "volume", value: 0.5 },
  { op: "setBus", bus: "Music", key: "bed", value: "none" },
  { op: "setBus", bus: "Voice", key: "meter", value: "loudness" },
  { op: "addBus", name: "Amb", parent: "Master" },
  { op: "removeBus", bus: "SFX" },
  { op: "renameBus", from: "UI", to: "Menu" },
  { op: "moveBus", bus: "Voice", parent: "Music" },
  { op: "addEffect", bus: "Music", index: 0, effect: { type: "lowpass", frequency: 800, q: 1 } },
  { op: "removeEffect", bus: "Music", index: 0 },
  { op: "moveEffect", bus: "Music", from: 0, to: 1 },
  { op: "setEffect", bus: "Music", index: 0, key: "frequency", value: 1200 },
  { op: "setEffect", bus: "Music", index: 1, key: "threshold", value: -18 },
  { op: "addSnapshot", index: 0, name: "Paused" },
  { op: "removeSnapshot", index: 0 },
  { op: "renameSnapshot", index: 0, name: "Menu" },
  { op: "setSnapshot", index: 0, bus: "Music", key: "volume", value: 0.3 },
  { op: "setDucking", index: 0, rule: { target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.5 } },
  { op: "setAutomation", index: 0, rule: null },
  { op: "setTarget", index: 0, target: { name: "console", integrated: -24, tolerance: 2, truePeak: -1 } },
  { op: "setOption", key: "loudnessResetOnPlay", value: false },
];

describe("liveMix (K0 stub)", () => {
  it("covers every op name", () => {
    expect(new Set(OPS.map((o) => o.op))).toEqual(new Set(MIX_OP_NAMES));
  });

  it("answers restartRequired for every op", () => {
    const live = new LiveMix({ dip: new StructuralDip(), deferred: new DeferredAdds() });
    for (const op of OPS) expect(live.apply(op), op.op).toEqual({ ok: false, class: "none", restartRequired: RESTART_REQUIRED });
  });

  it("mixer.apply(op) reaches the active backend's applyOp, and nothing once the backend is gone", async () => {
    const { makeFakeBackend } = await import("../testing");
    const { setAudioBackend, mixer } = await import("../backend");
    const fake = makeFakeBackend();
    setAudioBackend(fake);
    try {
      expect(mixer.apply(OPS[0]!)).toEqual({ ok: true, class: "direct" });
      expect(fake.ops).toEqual([OPS[0]]);
    } finally {
      setAudioBackend(null);
    }
    expect(mixer.apply(OPS[0]!).restartRequired).toBeTruthy();
    expect(fake.ops).toHaveLength(1);
  });

  it("CoreBackend.applyOp routes to liveMix", () => {
    const live = new LiveMix({ dip: new StructuralDip(), deferred: new DeferredAdds() });
    for (const op of OPS) expect(CoreBackend.prototype.applyOp.call({ liveMix: live } as unknown as CoreBackend, op).restartRequired).toBe(RESTART_REQUIRED);
  });
});
