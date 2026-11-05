import { describe, expect, it } from "vitest";
import {
  defaultNavigationSettings,
  describeNavAvoidanceMask,
  lowestNavLayerBit,
  navAvoidanceLayerName,
  navShownLayers,
  parseNavigationSettings,
} from "../nav/settings";

// ADR 0066: named avoidance layers in the `navigation` settings, and the one-layer rule for agent types.

describe("avoidance layer names", () => {
  it("default to Default on layer 0", () => {
    expect(defaultNavigationSettings().avoidanceLayers).toEqual(["Default"]);
    expect(parseNavigationSettings({}).settings.avoidanceLayers).toEqual(["Default"]);
  });

  it("parse leniently: strings only, at most 32, trailing unnamed slots dropped", () => {
    const ok = parseNavigationSettings({ avoidanceLayers: ["Default", "", "Enemy", "", ""] });
    expect(ok.problems).toEqual([]);
    expect(ok.settings.avoidanceLayers).toEqual(["Default", "", "Enemy"]);

    const bad = parseNavigationSettings({ avoidanceLayers: ["Default", 5, null, "Player"] });
    expect(bad.settings.avoidanceLayers).toEqual(["Default", "", "", "Player"]);
    expect(bad.problems).toHaveLength(1); // the 5 (null is an unnamed slot)
    expect(bad.problems[0]).toContain("avoidanceLayers[1]");

    const many = parseNavigationSettings({ avoidanceLayers: Array.from({ length: 40 }, (_, i) => `L${i}`) });
    expect(many.settings.avoidanceLayers).toHaveLength(32);
    expect(many.problems.join()).toContain("more than 32");

    const notList = parseNavigationSettings({ avoidanceLayers: "Default" });
    expect(notList.settings.avoidanceLayers).toEqual(["Default"]);
    expect(notList.problems.join()).toContain("avoidanceLayers");
  });

  it("label layers, list the named ones (plus layer 0 and any in use) and describe masks", () => {
    const nav = { avoidanceLayers: ["Default", "", "Enemy", "  "] };
    expect(navAvoidanceLayerName(nav, 0)).toBe("Default");
    expect(navAvoidanceLayerName(nav, 1)).toBe("Layer 1");
    expect(navAvoidanceLayerName(nav, 3)).toBe("Layer 3"); // blank counts as unnamed
    expect(navShownLayers(nav)).toEqual([0, 2]);
    expect(navShownLayers(nav, 2 ** 31 + 2)).toEqual([0, 1, 2, 31]);
    expect(describeNavAvoidanceMask(nav, 0)).toBe("Nothing");
    expect(describeNavAvoidanceMask(nav, 0xffffffff)).toBe("Everything");
    expect(describeNavAvoidanceMask(nav, 0b101)).toBe("Default, Enemy");
    expect(describeNavAvoidanceMask(nav, 2 ** 31)).toBe("Layer 31");
  });
});

describe("an agent type's avoidance layer", () => {
  it("is one bit: several keep the lowest, with a problem", () => {
    expect(lowestNavLayerBit(0b1100)).toBe(0b100);
    expect(lowestNavLayerBit(0xffffffff)).toBe(1);
    expect(lowestNavLayerBit(2 ** 31)).toBe(2 ** 31);
    expect(lowestNavLayerBit(0)).toBe(0);

    const one = parseNavigationSettings({ agentTypes: [{ id: "a", name: "A", avoidance: { layers: 4, avoidLayers: 0xffffffff } }] });
    expect(one.problems).toEqual([]);
    expect(one.settings.agentTypes[0].avoidance).toMatchObject({ layers: 4, avoidLayers: 0xffffffff });

    const none = parseNavigationSettings({ agentTypes: [{ id: "a", name: "A", avoidance: { layers: 0 } }] });
    expect(none.problems).toEqual([]); // on no layer (Foxfire's "Nothing")

    const several = parseNavigationSettings({ agentTypes: [{ id: "a", name: "A", avoidance: { layers: 6, avoidLayers: 6 } }] });
    expect(several.settings.agentTypes[0].avoidance).toMatchObject({ layers: 2, avoidLayers: 6 }); // the mask keeps every bit
    expect(several.problems).toHaveLength(1);
    expect(several.problems[0]).toContain("avoidance.layers");
  });
});
