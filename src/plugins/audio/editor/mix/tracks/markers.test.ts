// ADR 0171/0172 (Pf3d; api-and-models §7): the marker track over markers recorded through the real `EventSink`. The ticks
// sit where the cursor's own previous and next marker steps land; the tooltip is the text with its time.
import { describe, expect, it } from "vitest";
import { CURSOR_COLUMNS, CursorModel, cursorTargets } from "../cursorModel";
import { statusColumns } from "../profilerSource";
import { markerTracks } from "./markers";
import type { HoverTrackModule } from "./events";
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
  const [markers] = markerTracks({ source, names: { clip: () => undefined, bus: () => undefined, event: () => undefined } }) as [HoverTrackModule];
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

  it("the tooltip is the text with its time; neighbours inside the reach are listed together", async () => {
    const { source, markers, marks } = await open();
    const t = viewportTime(source, marks.boss!);
    markers.tolerance = 0.01;
    expect(markers.tooltipAt!(t)).toBe(`${t.toFixed(3)} s  Boss spawned`);
    expect(markers.tooltipAt!(t + 0.2)).toBeNull();
    markers.tolerance = 0.1;
    const t2 = viewportTime(source, marks.hit!);
    expect(markers.tooltipAt!(t2)!.split("\n")).toEqual([`${t2.toFixed(3)} s  Player hit`, `${viewportTime(source, marks.hit2!).toFixed(3)} s  Player hit again`]);
    source.close();
  });

  it("the cursor's marker steps land on the ticks", async () => {
    const { source, cursor, marks } = await open();
    expect(cursor.mode).toBe("live");
    const at = viewportTime(source, marks.hit!);
    cursor.seekTo(at);
    expect([cursor.mode, cursor.time]).toEqual(["paused", at]);
    expect(cursor.find("marker", "previous")).toBe(viewportTime(source, marks.boss!));
    expect(cursor.find("marker", "next")).toBe(viewportTime(source, marks.hit2!));
    source.close();
  });

  it("a capture with no markers has no data and no tooltip", async () => {
    const source = await recordScene((s) => s.advance(1));
    const [m] = markerTracks({ source, names: { clip: () => undefined, bus: () => undefined, event: () => undefined } }) as [HoverTrackModule];
    await m.refresh();
    expect([m.data(), m.tooltipAt!(0.5)]).toEqual([undefined, null]);
    source.close();
  });
});
