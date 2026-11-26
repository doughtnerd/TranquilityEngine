// ADR 0348 "Annotations": a take's notes file parses leniently into canonical notes and writes back unchanged.
import { describe, expect, it } from "vitest";
import { TAKE_NOTES_LIMITS, emptyTakeNotes, formatTakeNotes, freeNoteId, isTakeNotesPath, parseTakeNotes, takeNotesPath } from "./notes";
import { TAKE_NOTES_FORMAT, type TakeNotes } from "./types";

const NOTES: TakeNotes = {
  format: TAKE_NOTES_FORMAT,
  markers: [
    { id: "m1", at: 2.5, text: "engine too loud here", color: 0xeb5757 },
    { id: "m2", at: 10, text: "", color: 0xf2c94c },
  ],
  regions: [{ id: "r1", from: 4, to: 8.25, text: "boost sounds thin", color: 0x56ccf2 }],
};

describe("take notes (ADR 0348)", () => {
  it("round-trips: parsing what the writer writes gives the same notes", () => {
    const text = formatTakeNotes(NOTES);
    const back = parseTakeNotes(JSON.parse(text));
    expect(back.problems).toEqual([]);
    expect(back.value).toEqual(NOTES);
    expect(formatTakeNotes(back.value)).toBe(text);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("reads no file as empty notes, silently", () => {
    expect(parseTakeNotes(undefined)).toEqual({ value: emptyTakeNotes(), problems: [] });
  });

  it("sorts markers and regions, swaps a backwards region and keeps ids unique", () => {
    const r = parseTakeNotes({
      format: TAKE_NOTES_FORMAT,
      markers: [{ id: "a", at: 5, text: "late", color: 1 }, { id: "a", at: 1, text: "early", color: 2 }],
      regions: [{ id: "g", from: 9, to: 3, text: "x", color: 3 }],
    });
    expect(r.value.markers.map((m) => m.text)).toEqual(["early", "late"]);
    expect(new Set(r.value.markers.map((m) => m.id)).size).toBe(2);
    expect(r.value.regions[0]).toMatchObject({ from: 3, to: 9 });
    expect(r.problems.some((p) => p.includes("used twice"))).toBe(true);
    expect(r.problems.some((p) => p.includes("swapped"))).toBe(true);
  });

  it("falls back with one problem per bad value, never throws", () => {
    for (const raw of [42, "x", [], { markers: 3 }, { markers: [null, 7] }, { format: "other", regions: [{ from: "a" }] }]) {
      expect(() => parseTakeNotes(raw)).not.toThrow();
    }
    const r = parseTakeNotes({ format: TAKE_NOTES_FORMAT, markers: [{ id: "m", at: -3, text: 5, color: 0x1000000 }], regions: [] });
    expect(r.value.markers[0]).toEqual({ id: "m", at: 0, text: "", color: 0xffffff });
    expect(r.problems).toHaveLength(3);
    expect(parseTakeNotes({ format: "nope" }).problems).toHaveLength(1);
  });

  it("cuts long text and drops notes past the limits", () => {
    const long = "y".repeat(TAKE_NOTES_LIMITS.text + 10);
    const r = parseTakeNotes({ format: TAKE_NOTES_FORMAT, markers: [{ id: "m", at: 1, text: long, color: 0 }] });
    expect(r.value.markers[0]!.text).toHaveLength(TAKE_NOTES_LIMITS.text);
    const many = Array.from({ length: TAKE_NOTES_LIMITS.markers + 1 }, (_, i) => ({ id: `m${i}`, at: i, text: "", color: 0 }));
    expect(parseTakeNotes({ format: TAKE_NOTES_FORMAT, markers: many }).value.markers).toHaveLength(TAKE_NOTES_LIMITS.markers);
  });

  it("names the notes file beside the take and hands out free ids", () => {
    expect(takeNotesPath("takes/run_01.sporesample")).toBe("takes/run_01.sporesample.notes.json");
    expect(isTakeNotesPath("takes/run_01.sporesample.notes.json")).toBe(true);
    expect(isTakeNotesPath("takes/notes.json")).toBe(false);
    expect(freeNoteId(NOTES, "m")).toBe("m3");
    expect(freeNoteId(NOTES, "r")).toBe("r2");
  });
});
