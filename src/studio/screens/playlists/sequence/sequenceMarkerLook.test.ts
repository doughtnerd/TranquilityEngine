// ADR 0362 item 4: a sequence marker's colour and note — the edits the Marker inspector makes and how the flag looks.
import { describe, expect, it } from "vitest";
import { defaultSequence } from "../../../../engine/audio/playlist/format";
import { addMarker, setMarkerColour, setMarkerNote } from "./loopMarkerEdits";
import { markerColourCss, markerFlagStyle, markerTitle } from "./markerLook";

const next = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("marker colour and note edits", () => {
  it("set and clear a colour (a theme token or #rrggbb, kept lower-case); anything else is refused", () => {
    const { seq, id } = next(addMarker(defaultSequence(), 1, "Drop", "exit"));
    const red = next(setMarkerColour(seq, id, "danger"));
    expect(red.markers[0]).toMatchObject({ colour: "danger" });
    expect(next(setMarkerColour(red, id, "#ABCDEF")).markers[0]!.colour).toBe("#abcdef");
    expect(next(setMarkerColour(red, id, null)).markers[0]).not.toHaveProperty("colour");
    expect(setMarkerColour(seq, id, "rgb(0,0,0)")).toEqual({ refused: expect.stringContaining("theme colour") });
    expect(setMarkerColour(seq, "nope", "danger")).toEqual({ refused: expect.any(String) });
  });

  it("set a note; a blank note removes it", () => {
    const { seq, id } = next(addMarker(defaultSequence(), 1));
    const noted = next(setMarkerNote(seq, id, "Brass enters"));
    expect(noted.markers[0]!.note).toBe("Brass enters");
    expect(next(setMarkerNote(noted, id, "   ")).markers[0]).not.toHaveProperty("note");
  });
});

describe("the flag", () => {
  it("takes the marker's own colour, else its type's; the tooltip carries the note", () => {
    expect(markerColourCss({ type: "exit" })).toBe("var(--marker-exit)");
    expect(markerColourCss({ type: "exit", colour: "warning" })).toBe("var(--warning)");
    expect(markerColourCss({ colour: "#112233" })).toBe("#112233");
    expect(markerFlagStyle({})).toEqual({});
    expect(markerFlagStyle({ colour: "series-6" })).toEqual({ "--mc": "var(--series-6)" });
    expect(markerTitle({ name: "Drop", type: "cue", note: "Hit lands" }, "0:01.000")).toBe("Drop · 0:01.000 · Cue: the game is told when the playhead passes it\nHit lands");
    expect(markerTitle({ name: "Drop" }, "0:01.000")).toBe("Drop · 0:01.000 · Marker");
  });
});
