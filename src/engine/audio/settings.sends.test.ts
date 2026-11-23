// ADR 0344 (ABI 4.7): a bus's `sends` in the backends' view (`BusSettings.sends`), read leniently like the rest of the
// section: each into another bus of the list, once, at a linear level clamped to 0..MAX_SEND_LEVEL; more than the core's
// four a bus are kept as authored with one warning (`busCapability.ts`' `sendsPerBus`). Through `parseAudioSettings` and
// the ops that rename and remove buses (`applyOpToSettings`).
import { describe, expect, it } from "vitest";
import { applyOpToSettings } from "./mixOps";
import { MAX_SEND_LEVEL, parseAudioSettings } from "./settings";

const buses = (sends: unknown) => [
  { name: "Master" },
  { name: "SFX", parent: "Master", sends },
  { name: "Echo", parent: "Master" },
  { name: "Hall", parent: "Master" },
];

describe("audio.buses[].sends parse (ADR 0344)", () => {
  it("reads sends into other buses at their linear level; absent or empty is none (never written)", () => {
    const { settings, problems, warnings } = parseAudioSettings({ buses: buses([{ to: "Echo", level: 0.5 }, { to: "Hall" }]) });
    expect([problems, warnings]).toEqual([[], []]);
    expect(settings.buses[1]!.sends).toEqual([{ to: "Echo", level: 0.5 }, { to: "Hall", level: 1 }]);
    expect(settings.buses[2]!.sends).toBeUndefined();
    expect(parseAudioSettings({ buses: buses([]) }).settings.buses[1]!.sends).toBeUndefined();
  });

  it("drops a send to itself, to an unknown bus, a second send to one bus and junk, each with one problem; clamps a level", () => {
    const { settings, problems } = parseAudioSettings({
      buses: buses([{ to: "SFX" }, { to: "Nope" }, { to: "Echo", level: 9 }, { to: "Echo", level: 0.2 }, 3, { to: "Hall", level: "loud" }]),
    });
    expect(settings.buses[1]!.sends).toEqual([{ to: "Echo", level: MAX_SEND_LEVEL }, { to: "Hall", level: 1 }]);
    expect(problems).toEqual([
      "audio.buses[1].sends[0]: to must name another bus; dropped.",
      "audio.buses[1].sends[1]: to must name another bus; dropped.",
      'audio.buses[1].sends[3]: a second send to "Echo"; dropped.',
      "audio.buses[1].sends[4]: to must name another bus; dropped.",
      "audio.buses[1].sends[5].level: must be a number 0..4; using 1.",
    ]);
    expect(parseAudioSettings({ buses: buses("Echo") }).problems).toEqual(["audio.buses[1].sends: must be a list; ignored."]);
  });

  it("keeps more than the core's four sends a bus as authored, with one warning (sendsPerBus)", () => {
    const names = ["R1", "R2", "R3", "R4", "R5"];
    const { settings, problems, warnings } = parseAudioSettings({
      buses: [{ name: "Master" }, { name: "SFX", parent: "Master", sends: names.map((to) => ({ to, level: 0.5 })) }, ...names.map((name) => ({ name, parent: "Master" }))],
    });
    expect(problems).toEqual([]);
    expect(settings.buses[1]!.sends).toHaveLength(5);
    expect(warnings).toEqual(["audio.buses[1]: a bus runs at most 4 sends; the edit is saved and applies at the next Play, where only the first 4 sends of the list run."]);
  });

  it("a renamed bus's sends follow it; a removed bus takes the sends into it", () => {
    const a = parseAudioSettings({ buses: buses([{ to: "Echo", level: 0.5 }, { to: "Hall", level: 0.25 }]) }).settings;
    const renamed = applyOpToSettings(a, { op: "renameBus", from: "Echo", to: "Delay" });
    expect(renamed.buses[1]!.sends).toEqual([{ to: "Delay", level: 0.5 }, { to: "Hall", level: 0.25 }]);
    const removed = applyOpToSettings(a, { op: "removeBus", bus: "Echo" });
    expect(removed.buses[1]!.sends).toEqual([{ to: "Hall", level: 0.25 }]);
    const none = applyOpToSettings(removed, { op: "removeBus", bus: "Hall" });
    expect(none.buses[1]!.sends).toBeUndefined();
  });
});
