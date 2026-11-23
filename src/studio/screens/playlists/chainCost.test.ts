// ADR 0345 levels (ABI 4.9): the note under a Playlists or Sequence effect chain says it runs on a submix of the level's
// own (a clip's delay rings past the clip) and shows its cost by the catalogue's classes, enabled effects only.
import { describe, expect, it } from "vitest";
import type { Effect } from "../../../engine/audio/effects/types";
import { chainCostText, chainNote } from "./chainCost";

const fx = (type: string, on = true): Effect => ({ id: type, type, on, params: {} } as Effect);

describe("chainNote", () => {
  it("counts the enabled effects by cost class", () => {
    expect(chainCostText([fx("reverb"), fx("delay"), fx("eq"), fx("lowpass"), fx("chorus", false)])).toBe("Cost: 1 heavy, 1 medium, 2 light.");
    expect(chainCostText([])).toBe("Cost: none.");
  });

  it("says a clip's chain runs on its own submix, past the clip's end, and is no longer a per-voice mapping", () => {
    const note = chainNote("clip", [fx("delay")]);
    expect(note).toContain("clip's submix");
    expect(note).toContain("rings on after the clip ends");
    expect(note).toContain("Cost: 1 medium.");
    expect(chainNote("track", [])).toContain("track's submix");
    expect(chainNote("playlist", [fx("eq")])).toContain("own voices");
  });
});
