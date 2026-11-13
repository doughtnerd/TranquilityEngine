// ADR 0171 amended by 0172 (Ma1; api-and-models §6.3, architecture §4.7): the bus index on the session slot table. At a
// configure the table is today's mapping (slot = project position, BUS_CONFIG byte for byte as before); after a live add
// every consumer (the name map, `names`, the bed plan's parents, BUS_CONFIG's tree for the replay) reads the slot, not the
// position; a configure the host saw no remap for, after a live edit, configures the tree again.
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { BUS_ROOT, type BusConfigBuses } from "../wire.generated";
import { BusIndex, wireEffect, type BusIndexHost } from "./busIndex";
import { Presence } from "./presence";
import { VoiceTable } from "./voiceTable";

const PROJECT = {
  buses: [
    { name: "Master" },
    { name: "Music", parent: "Master", effects: [{ type: "lowpass", frequency: 800, q: 1 }] },
    { name: "Stems", parent: "Music" },
    { name: "SFX", parent: "Master", maxVoices: 4 },
  ],
};

function rig() {
  const mixer = new Mixer(parseAudioSettings(PROJECT).settings);
  const configs: BusConfigBuses[][] = [];
  const slots: { slot: number; parent: number; effects: readonly unknown[]; fresh?: boolean }[] = [];
  const plans: { names: string[]; parents: number[] }[] = [];
  const table = new VoiceTable(8);
  const host: BusIndexHost = {
    mixer,
    writer: { busConfig: (b) => void configs.push(b.map((x) => ({ ...x }))), setParams() {}, busSlot: (a) => void slots.push({ ...a }), fadeShaped() {} },
    beds: { plan: (_s, names, parents) => void plans.push({ names: [...names], parents: Array.from(parents).slice(0, names.length) }) },
    automation: { onBusesConfigured() {} },
    mirror: { resetPeaks() {} },
    table,
    presence: new Presence(null),
    onCore: () => false,
    applyMix() {},
    busesReset() {},
  };
  const index = new BusIndex(host);
  return { mixer, index, configs, slots, plans, table };
}

describe("BusIndex on the slot table (Ma1)", () => {
  it("a configure is today's mapping: slot = project position, BUS_CONFIG as the position mapping wrote it", () => {
    const { mixer, index, configs, table } = rig();
    index.configureBuses(mixer);
    expect(index.names).toEqual(["Master", "Music", "Stems", "SFX"]);
    expect([...index.busIndexByName]).toEqual([["Master", 0], ["Music", 1], ["Stems", 2], ["SFX", 3]]);
    // The K0 body: parent = the parent's position (root: BUS_ROOT), effects in wire form.
    const settings = mixer.audioSettings.buses;
    const positional = settings.map((b) => ({ parent: b.parent === undefined ? BUS_ROOT : settings.findIndex((x) => x.name === b.parent), effects: b.effects.map(wireEffect) }));
    expect(configs).toEqual([positional]);
    expect(table.busMax[3]).toBe(4);
  });

  it("after a live add, every consumer reads the new bus's slot: names, the map, the bed plan, BUS_CONFIG's tree and the limits", () => {
    const { mixer, index, slots, plans, table } = rig();
    index.configureBuses(mixer);
    const before = mixer.audioSettings;
    // Added between Music and Stems in the project; it takes the next slot (4) and the mixer appends it.
    const slot = index.addBus("Amb", "Music");
    expect(slot).toBe(4);
    mixer._applyLive({ op: "addBus", name: "Amb", parent: "Music", index: 2 }, 4);
    expect(index.writeSlot("Amb", true)).toBe(4);
    expect(slots).toEqual([{ slot: 4, parent: 1, effects: [], fresh: true }]);
    index.liveSettings(before);
    expect(plans.at(-1)).toEqual({ names: ["Master", "Music", "Stems", "SFX", "Amb"], parents: [-1, 0, 1, 0, 1] });
    expect(index.busIndexByName.get("Amb")).toBe(4);
    expect(index.busConfigWire()[4]).toEqual({ parent: 1, effects: [] });
    mixer._applyLive({ op: "setBus", bus: "Amb", key: "maxVoices", value: 2 });
    index.writeLimits();
    expect([table.busMax[3], table.busMax[4]]).toEqual([4, 2]);
  });

  it("an effect edit is one BUS_SLOT of the bus's slot with its whole chain; an unknown bus sends nothing", () => {
    const { mixer, index, slots } = rig();
    index.configureBuses(mixer);
    mixer._applyLive({ op: "setEffect", bus: "Music", index: 0, key: "frequency", value: 1200 });
    expect(index.writeSlot("Music")).toBe(1);
    expect(index.writeSlot("Nope")).toBe(-1);
    expect(slots).toEqual([{ slot: 1, parent: 0, effects: [{ type: 0, p: [1200, 1, 0, 0, 0, 0, 0] }], fresh: false }]);
  });

  it("a live edit that leaves the bed settings alone plans nothing again; a bed edit does", () => {
    const { mixer, index, plans } = rig();
    index.configureBuses(mixer);
    const n = plans.length;
    let before = mixer.audioSettings;
    mixer._applyLive({ op: "setBus", bus: "SFX", key: "volume", value: 0.5 });
    index.liveSettings(before);
    index.replanBedsOnSettings(); // the mixer's change notification
    expect(plans).toHaveLength(n);
    before = mixer.audioSettings;
    mixer._applyLive({ op: "setBus", bus: "SFX", key: "bed", value: "own" });
    index.liveSettings(before);
    index.replanBedsOnSettings();
    expect(plans).toHaveLength(n + 1);
  });

  it("a configure with the host's names after a live add (an undo back to them, no remap) configures the tree again", () => {
    const { mixer, index, configs } = rig();
    index.configureBuses(mixer);
    index.addBus("Amb", "Master");
    mixer._applyLive({ op: "addBus", name: "Amb", parent: "Master" }, 4);
    expect(index.names).toHaveLength(5);
    mixer.configure(parseAudioSettings(PROJECT).settings);
    index.replanBedsOnSettings();
    expect(index.names).toEqual(["Master", "Music", "Stems", "SFX"]);
    expect(configs).toHaveLength(2);
    expect(index.slots.version).toBe(0);
  });

  it("a rename keeps the slot; the old name maps to it until the next configure", () => {
    const { mixer, index } = rig();
    index.configureBuses(mixer);
    index.renameBus("Stems", "Layers");
    expect(index.names[2]).toBe("Layers");
    expect([index.slotOf("Layers"), index.slotOf("Stems")]).toEqual([2, 2]);
    index.configureBuses(mixer);
    expect(index.slotOf("Layers")).toBe(-1);
  });
});
