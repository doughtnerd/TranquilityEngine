// Ck1's presence fix (ADR 0171 amended by 0172; architecture §4.7 "every consumer that indexed buses by project
// position reads the slot instead"; Ma2's finding): presence rules name their buses by slot (Sm1's table), not by their
// position in `mixer.busNames`. After a live remove the removed bus keeps its slot as a tombstone (and leaves
// `busNames`), and a bus added into a recycled slot is listed last, so position and slot differ; a rule sent by position ducks the wrong bus. On the real
// wasm (the loopback host), on the audio clock: Music plays a constant 0.5, Voice (silent) triggers its duck.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../../engine/audio/mixer";
import type { BusDuckRules } from "../wire.generated";
import { closeRigs, liveRig } from "../mix/clickHarness";

const LEVEL = 0.5;
const AMOUNT = 0.25;
const AMB_AMOUNT = 0.4;
const RULE = { target: "Music", trigger: "Voice", mode: "presence" as const, amount: AMOUNT, attack: 0.005, release: 0.05 };
const PROJECT = {
  buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Master" }, { name: "UI", parent: "Master" }, { name: "Voice", parent: "Master", volume: 0 }],
  ducking: [RULE],
};

afterEach(async () => {
  await closeRigs();
  vi.restoreAllMocks();
});

describe("presence rules by slot after live structural edits (Ck1)", () => {
  it("a rule sent after a remove still names the trigger's slot, and ducks", { timeout: 60_000 }, async (ctx) => {
    const r = await liveRig(PROJECT);
    if (!r) return ctx.skip();
    const ducks = vi.spyOn(r.backend.writer, "busDuck");
    r.play("Music");
    await r.step(12);
    expect(mixer.apply({ op: "removeBus", bus: "SFX" })).toEqual({ ok: true, class: "dip" });
    await r.step(24);
    // The removed bus's slot is a tombstone (index-stable routing, §4.7): Voice keeps slot 4, so the rules are the same
    // on the wire and nothing is sent again.
    expect(r.backend.buses.slotOf("Voice")).toBe(4);
    expect(ducks).not.toHaveBeenCalled();
    r.play("Voice");
    const run = await r.step(30);
    expect(run.last / LEVEL, "Music ducks while Voice plays").toBeCloseTo(AMOUNT, 3);
    r.backend.dispose();
  });

  it("a bus added into a recycled slot: a rule triggered by it names its slot and ducks", { timeout: 60_000 }, async (ctx) => {
    const r = await liveRig(PROJECT);
    if (!r) return ctx.skip();
    const ducks = vi.spyOn(r.backend.writer, "busDuck");
    r.play("Music");
    await r.step(12);
    expect(mixer.apply({ op: "removeBus", bus: "SFX" })).toEqual({ ok: true, class: "dip" });
    await r.step(24); // past the dip's end and the tombstone's tail
    expect(mixer.apply({ op: "addBus", name: "Amb", parent: "Master" })).toMatchObject({ ok: true });
    expect(r.backend.buses.slotOf("Amb"), "the add took the recycled slot").toBe(2);
    // G7c: the removed bus left the mixer's model at once (its freed slot is Amb's now, architecture §2.3, §4.7), and
    // the added bus is listed last: position 4, slot 2, so a rule sent by position would name the wrong slot.
    expect(mixer.busNames).toEqual(["Master", "Music", "UI", "Voice", "Amb"]);
    expect(mixer.busNames.indexOf("Amb")).toBe(4);
    mixer.apply({ op: "setBus", bus: "Amb", key: "volume", value: 0 });
    // A rule triggered by the new bus, inserted after it (so the rules are sent again).
    mixer.apply({ op: "setDucking", index: 1, insert: true, rule: { target: "Music", trigger: "Amb", mode: "presence", amount: AMB_AMOUNT, attack: 0.005, release: 0.05 } });
    await r.step(1);
    const last = ducks.mock.calls.at(-1)![0] as readonly BusDuckRules[];
    expect(last.map((x) => [x.target, x.trigger])).toEqual([
      [1, 4],
      [1, 2],
    ]);
    r.play("Amb");
    const run = await r.step(30);
    expect(run.last / LEVEL, "Music ducks while Amb plays").toBeCloseTo(AMB_AMOUNT, 3);
    r.backend.dispose();
  });
});
