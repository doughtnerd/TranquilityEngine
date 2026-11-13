// ADR 0171/0172 (Pf3d; api-and-models §7): the marker track over markers recorded through the real `EventSink`. A click on a
// marker asks the cursor to jump: it lands paused on the marker's time (a live cursor stops following), the time the cursor's
// own previous and next marker give, and the tooltip is `markerTooltip`'s string.
import { describe, expect, it } from "vitest";
import { CURSOR_COLUMNS, CursorModel, cursorTargets } from "../cursorModel";
import { statusColumns } from "../profilerSource";
import { jumpToMarker, markerNear, markerTicks, markerTooltip, markerTracks, type MarkerTrackModule } from "./markers";
import { recordScene, viewportTime } from "./recordScene";

async function open() {
  const marks: Record<string, number> = {};
  const source = await recordScene((s) => {
    s.advance(0.5);
    marks.boss = s.frame();
    s.sink.marker("Boss spawned");
    s.advance(1.5);
    marks.hit = s.frame();
    s.sink.marker("Player hit");
    s.advance(1.52);
    marks.hit2 = s.frame();
    s.sink.marker("Player hit again");
    s.advance(3);
  });
  const [markers] = markerTracks({ source, names: { clip: () => undefined, bus: () => undefined, event: () => undefined } }) as [MarkerTrackModule];
  await markers.refresh();
  const cursor = new CursorModel({ live: true });
  cursor.setDuration(source.duration);
  cursor.setTargets(cursorTargets(await statusColumns(source, CURSOR_COLUMNS), source.markers, source.startSeconds));
  return { source, markers, cursor, marks };
}

describe("markers through the real EventSink", () => {
  it("markers are ticks at their times, coloured by theme key", async () => {
    const { source, markers, marks } = await open();
    expect(Array.from(markers.data()!.ticks!)).toEqual([marks.boss, marks.hit, marks.hit2].map((f) => viewportTime(source, f!)));
    expect(markers.data()!.tickColor).toBe("warning");
    expect(markers.track).toMatchObject({ id: "markers.markers", kind: "ticks" });
    source.close();
  });

  it("the tooltip is the model's string: the text with its time; neighbours inside the reach are listed together", async () => {
    const { source, markers, marks } = await open();
    const t = viewportTime(source, marks.boss!);
    markers.tolerance = 0.01;
    const ticks = markerTicks(source.markers, source.startSeconds);
    expect(markers.tooltipAt!(t)).toBe(markerTooltip(ticks, t, 0.01));
    expect(markers.tooltipAt!(t)).toBe(`${t.toFixed(3)} s  Boss spawned`);
    expect(markers.tooltipAt!(t + 0.2)).toBeNull();
    markers.tolerance = 0.1;
    const t2 = viewportTime(source, marks.hit!);
    expect(markers.tooltipAt!(t2)!.split("\n")).toEqual([`${t2.toFixed(3)} s  Player hit`, `${viewportTime(source, marks.hit2!).toFixed(3)} s  Player hit again`]);
    source.close();
  });

  it("a click on a marker jumps the cursor onto it, live to paused", async () => {
    const { source, markers, cursor, marks } = await open();
    expect(cursor.mode).toBe("live");
    const at = viewportTime(source, marks.hit!);
    const hit = markers.markerAt(at + 0.004, 0.01);
    expect(hit).toEqual({ time: at, text: "Player hit" });
    expect(jumpToMarker(cursor, hit)).toBe(true);
    expect([cursor.mode, cursor.time]).toEqual(["paused", at]);
    // The cursor's own marker steps agree with where the click landed.
    expect(cursor.find("marker", "previous")).toBe(viewportTime(source, marks.boss!));
    expect(cursor.find("marker", "next")).toBe(viewportTime(source, marks.hit2!));
    source.close();
  });

  it("a click away from every marker finds none and leaves the cursor alone", async () => {
    const { source, markers, cursor, marks } = await open();
    const far = viewportTime(source, marks.boss!) + 0.2;
    expect(markers.markerAt(far, 0.01)).toBeNull();
    expect(jumpToMarker(cursor, markers.markerAt(far, 0.01))).toBe(false);
    expect(cursor.mode).toBe("live");
    source.close();
  });

  it("the nearest of two markers in reach wins, and the default reach is the module's tolerance", async () => {
    const { source, markers, marks } = await open();
    const a = viewportTime(source, marks.hit!);
    const b = viewportTime(source, marks.hit2!);
    expect(markers.markerAt((a + b) / 2 + 0.001, 1)?.text).toBe("Player hit again");
    expect(markers.markerAt(a - 0.001, 1)?.text).toBe("Player hit");
    markers.tolerance = 0.002;
    expect(markers.markerAt(a + 0.001)?.text).toBe("Player hit");
    expect(markers.markerAt(a + 0.01)).toBeNull();
    source.close();
  });

  it("a capture with no markers has no data and no hit", async () => {
    const source = await recordScene((s) => s.advance(1));
    const [m] = markerTracks({ source, names: { clip: () => undefined, bus: () => undefined, event: () => undefined } }) as [MarkerTrackModule];
    await m.refresh();
    expect([m.data(), m.tooltipAt!(0.5), m.markerAt(0.5, 1)]).toEqual([undefined, null, null]);
    source.close();
  });
});

describe("the pure models", () => {
  it("markerNear on an empty list is null; ticks are rebased by the start and sorted", () => {
    expect(markerNear([], 1, 1)).toBeNull();
    expect(markerTicks([{ seq: 2, seconds: 5, text: "b" }, { seq: 1, seconds: 3, text: "a" }], 2)).toEqual([{ time: 1, text: "a" }, { time: 3, text: "b" }]);
  });
});
