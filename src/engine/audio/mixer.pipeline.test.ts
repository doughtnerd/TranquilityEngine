// ADR 0175: `Mixer.apply`'s pipeline against a fake `MixOpTarget`: what is answered before sending (no target, refused,
// no-op, a capability rule), what the target is sent (the op and its class), and what is answered after (a feature the
// target doesn't run). The rules themselves are `busCapability.table.test.ts`'s (plugin side, with the core).
import { describe, expect, it } from "vitest";
import { APPLY_REASONS, CORE_LIVE_CAPS, FALLBACK_LIVE_CAPS, appliesAtNextPlay, reasonMessage, type LiveCaps } from "./busCapability";
import { Mixer, type MixOpTarget } from "./mixer";
import type { ApplyResult, MixOp } from "./mixOps";
import { parseAudioSettings } from "./settings";

const lp = { type: "lowpass", frequency: 1000, q: 1 } as const;
const AUDIO = { buses: [{ name: "Master" }, { name: "Music", parent: "Master", effects: [lp, lp, lp, lp] }, { name: "SFX", parent: "Master" }] };

function rig(caps: LiveCaps, answer: (op: MixOp, cls: string) => ApplyResult = (_, cls) => ({ ok: true, class: cls as ApplyResult["class"] })) {
  const m = new Mixer(parseAudioSettings(AUDIO).settings);
  const sent: [MixOp, string][] = [];
  const notSent: ApplyResult[] = [];
  const target: MixOpTarget = {
    liveCaps: caps,
    sendOp: (op, cls) => {
      sent.push([op, cls]);
      m._applyLive(op);
      return answer(op, cls);
    },
    notSent: (r) => void notSent.push(r),
  };
  m._setOpTarget(target);
  return { m, sent, notSent };
}

describe("Mixer.apply's pipeline (ADR 0175)", () => {
  it("no target: kept for the next Play (noLiveBackend), the model untouched", () => {
    const m = new Mixer(parseAudioSettings(AUDIO).settings);
    const before = m.audioSettings;
    expect(m.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: false, class: "none", reason: "noLiveBackend" });
    expect(m.audioSettings).toBe(before);
  });

  it("a refused op is answered without sending and the target is told", () => {
    const { m, sent, notSent } = rig(CORE_LIVE_CAPS);
    expect(m.apply({ op: "setBus", bus: "Nope", key: "volume", value: 0.5 })).toEqual({ ok: false, class: "none" });
    expect(sent).toEqual([]);
    expect(notSent).toEqual([{ ok: false, class: "none" }]);
  });

  it("an op that changes nothing is a no-op: not sent, not counted", () => {
    const { m, sent, notSent } = rig(CORE_LIVE_CAPS);
    expect(m.apply({ op: "setBus", bus: "Music", key: "volume", value: 1 })).toEqual({ ok: true, class: "none" });
    expect(sent).toEqual([]);
    expect(notSent).toEqual([]);
  });

  it("the target is sent the op with its class and its answer is returned as is", () => {
    const { m, sent } = rig(CORE_LIVE_CAPS, (_, cls) => ({ ok: true, class: cls as ApplyResult["class"], reason: "waitsForSlot" }));
    const op: MixOp = { op: "removeEffect", bus: "Music", index: 0 };
    expect(m.apply(op)).toEqual({ ok: true, class: "dip", reason: "waitsForSlot" });
    expect(sent).toEqual([[op, "dip"]]);
  });

  it("ADR 0345 (ABI 4.6): the core runs eight effects a bus and any number of compressors; the insert cap refuses the ninth on every target", () => {
    const fifth: MixOp = { op: "addEffect", bus: "Music", index: 4, effect: lp };
    const comp: MixOp = { op: "addEffect", bus: "Music", index: 5, effect: { type: "compressor", threshold: -20, knee: 6, ratio: 4, attack: 0.003, release: 0.25 } };
    const core = rig(CORE_LIVE_CAPS);
    expect(core.m.apply(fifth)).toEqual({ ok: true, class: "direct" });
    expect(core.m.apply(comp)).toEqual({ ok: true, class: "direct" });
    expect(core.m.apply({ ...comp, index: 6 })).toEqual({ ok: true, class: "direct" });
    expect(core.m.apply({ ...fifth, index: 7 })).toEqual({ ok: true, class: "direct" });
    expect(core.m.audioSettings.buses[1]!.effects).toHaveLength(8);
    expect(core.m.apply({ ...fifth, index: 8 })).toMatchObject({ ok: false });
    expect(core.m.audioSettings.buses[1]!.effects).toHaveLength(8);
    const fallback = rig(FALLBACK_LIVE_CAPS);
    expect(fallback.m.apply(fifth)).toEqual({ ok: true, class: "direct" });
    expect(fallback.m.audioSettings.buses[1]!.effects).toHaveLength(5);
  });

  it("a level ducking rule on a target without level ducking is sent (the model keeps it) and answers needsAudioCore", () => {
    const level: MixOp = { op: "setDucking", index: 0, insert: true, rule: { target: "Music", trigger: "SFX", mode: "level", detector: "rms", threshold: -30, amount: 0.3, attack: 0.1, release: 0.1 } };
    const fallback = rig(FALLBACK_LIVE_CAPS);
    expect(fallback.m.apply(level)).toEqual({ ok: false, class: "direct", reason: "needsAudioCore" });
    expect(fallback.sent).toHaveLength(1);
    expect(fallback.m.audioSettings.ducking).toHaveLength(1);
    expect(rig(CORE_LIVE_CAPS).m.apply(level)).toEqual({ ok: true, class: "direct" });
  });

  it("every reason has a message; next-Play results are the not-ok ones with a reason", () => {
    for (const r of APPLY_REASONS) expect(reasonMessage(r).length, r).toBeGreaterThan(0);
    expect(appliesAtNextPlay({ ok: false, reason: "effectsPerBus" })).toBe(true);
    expect(appliesAtNextPlay({ ok: true, reason: "waitsForSlot" })).toBe(false);
    expect(appliesAtNextPlay({ ok: false })).toBe(false);
  });
});
