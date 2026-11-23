// ADR 0362 item 4: a sample's reserved ranges (Trim, Pickup, Tail) carry a colour and a note in the sidecar — the edit
// the Inspector and the range menus make, how the range is drawn, and the sidecar's round trip.
import { describe, expect, it } from "vitest";
import { defaultSampleEdits, parseSampleEdits, sampleEditsToJson } from "../../../engine/audio/sample/format";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { setRangeLook, type SampleEdit } from "./sampleEditing";
import { noteLine, outlineGroups, rangeLook } from "./sampleView";

const next = (r: SampleEdit): SampleEdits => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("a reserved range's colour and note", () => {
  it("set, labelled for undo, and cleared back to the default look (the field goes when nothing is left)", () => {
    const e = defaultSampleEdits();
    const r = setRangeLook(e, "tail", { colour: "danger" });
    expect(r).toMatchObject({ label: "Tail colour", next: { ranges: { tail: { colour: "danger" } } } });
    const noted = next(setRangeLook(next(r), "tail", { note: "Rings into the next bar" }));
    expect(noted.ranges).toEqual({ tail: { colour: "danger", note: "Rings into the next bar" } });
    const cleared = next(setRangeLook(next(setRangeLook(noted, "tail", { colour: null })), "tail", { note: " " }));
    expect(cleared).not.toHaveProperty("ranges");
    expect(setRangeLook(e, "trim", { colour: "rgb(1, 2, 3)" })).toEqual({ refused: expect.stringContaining("theme colour") });
  });

  it("draw with their own colour, else their theme token; the note goes on the tooltip", () => {
    const e = next(setRangeLook(next(setRangeLook(defaultSampleEdits(), "pickup", { colour: "#ABCDEF" })), "trim", { note: "Breath kept" }));
    expect(rangeLook(e, "pickup")).toEqual({ css: "#abcdef", own: true });
    expect(rangeLook(e, "trim")).toEqual({ css: "var(--range-trim)", own: false, note: "Breath kept" });
    expect(rangeLook(e, "tail").css).toBe("var(--range-tail)");
    expect(noteLine("Breath kept")).toBe("\nBreath kept");
    expect(noteLine(undefined)).toBe("");
    // The Outline's Trim row draws with it too.
    const red = next(setRangeLook(defaultSampleEdits(), "trim", { colour: "danger" }));
    expect(outlineGroups(red, 4).find((g) => g.id === "trim")?.items[0]?.color).toBe("var(--danger)");
  });

  it("are kept in the sidecar's sample block and read back; bad entries are dropped with a problem", () => {
    const e = next(setRangeLook(next(setRangeLook(defaultSampleEdits(), "trim", { colour: "warning", note: "Keep the breath" })), "tail", { colour: "#112233" }));
    const json = sampleEditsToJson(e);
    expect(json.ranges).toEqual({ trim: { colour: "warning", note: "Keep the breath" }, tail: { colour: "#112233" } });
    const problems: string[] = [];
    expect(parseSampleEdits(JSON.parse(JSON.stringify(json)), "sample", problems).ranges).toEqual(e.ranges);
    expect(problems).toEqual([]);
    const bad = parseSampleEdits({ ranges: { loop: { colour: "warning" }, tail: { colour: "nope!", note: 3 }, trim: 5 } }, "sample", problems);
    expect(bad).not.toHaveProperty("ranges");
    expect(problems).toHaveLength(4);
    expect(sampleEditsToJson(defaultSampleEdits())).not.toHaveProperty("ranges");
  });
});
