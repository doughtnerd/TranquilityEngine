// ADR 0352 §9 (B6): the Profiler's Plugins panel rows from `Audio.debug().plugins`: the card's health view per row,
// the rows that need attention (off after faults, failed, faulted, over budget) first, then by type.
import { describe, expect, it } from "vitest";
import type { AudioPluginDebug } from "../../../plugins/audio/runtime/debugTypes";
import { pluginRows } from "./pluginRowsModel";

const row = (type: string, over: Partial<AudioPluginDebug> = {}): AudioPluginDebug => ({
  plugin: "p", type, module: "dsp", e: 0, state: "live", warmUps: 1, instances: 4, inUse: 1,
  instructionsPerQuantum: 100 * 128, faults: { trap: 0, budget: 0, grow: 0, nonFinite: 0, range: 0 }, starved: 0, noInstance: 0, memoryBytes: 65536, ...over,
});

describe("the Profiler's plugin rows", () => {
  it("puts the rows that need attention first, each read as the card reads it", () => {
    const budgets: Record<string, number> = { "a.ok": 300, "b.over": 50, "c.off": 300, "d.faulted": 300 };
    const rows = pluginRows(
      [row("a.ok"), row("d.faulted", { faults: { trap: 1, budget: 0, grow: 0, nonFinite: 0, range: 0 } }), row("c.off", { state: "disabled" }), row("b.over")],
      (t) => budgets[t] ?? null,
    );
    expect(rows.map((r) => [r.type, r.attention])).toEqual([["b.over", true], ["c.off", true], ["d.faulted", true], ["a.ok", false]]);
    expect(rows[0]).toMatchObject({ perFrame: 100, budget: 50, load: 2, resettable: false });
    expect(rows[1]).toMatchObject({ state: "Off after faults", resettable: true });
    expect(rows[2]).toMatchObject({ faults: "trapped ×1", resettable: true });
    expect(rows[3]!.text).toBe("Live · 100 of 300 instructions per frame · 64 KB · no faults");
  });

  it("is empty with nothing running", () => {
    expect(pluginRows([])).toEqual([]);
  });
});
