// The builder's Test Drop (ADR 0373; T55): when the button is on, what it says, and which mode each press writes.
import { describe, expect, it } from "vitest";
import { DROP_MODE, nextDropMode, testDropState } from "./testDropLogic";

describe("testDropState", () => {
  it("is off until the game plays, and says to press Play", () => {
    for (const state of ["edit", "starting"] as const) {
      const s = testDropState(state, { mode: "off" }, false);
      expect(s.disabled).toBe(true);
      expect(s.label).toBe("Test Drop");
      expect(s.title).toMatch(/Press Play first/);
    }
  });

  it("is off when the selected node isn't in the running game", () => {
    const s = testDropState("playing", null, false);
    expect(s.disabled).toBe(true);
    expect(s.title).toMatch(/isn't in the running game/);
  });

  it("drops a playing character, and offers Reset while the test holds it ragdolling", () => {
    expect(testDropState("playing", { mode: "off" }, false)).toMatchObject({ label: "Test Drop", disabled: false });
    expect(testDropState("playing", { mode: "powered" }, false)).toMatchObject({ label: "Test Drop", disabled: false });
    expect(testDropState("playing", { mode: DROP_MODE }, true)).toMatchObject({ label: "Reset", disabled: false });
    // Gameplay changed the mode since the drop: the button is a drop again, not a reset.
    expect(testDropState("playing", { mode: "off" }, true)).toMatchObject({ label: "Test Drop", disabled: false });
  });
});

describe("nextDropMode", () => {
  it("drops to ragdoll, and resets to the mode before", () => {
    expect(nextDropMode(false, "powered")).toBe("ragdoll");
    expect(nextDropMode(true, "powered")).toBe("powered");
    expect(nextDropMode(true, "off")).toBe("off");
  });
});
