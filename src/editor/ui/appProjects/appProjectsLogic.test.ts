import { describe, expect, it } from "vitest";
import { openedWhen, searchRows, splitLatest } from "./appProjectsLogic";

const rows = [
  { name: "Flappy", where: "C:/games/flappy", t: 3 },
  { name: "Arena", where: "C:/work/arena", t: 9 },
  { name: "Sound Lab", where: "D:/audio/lab", t: 5 },
];
const text = (r: (typeof rows)[number]) => ({ name: r.name, where: r.where });

describe("searchRows", () => {
  it("keeps every row for an empty or blank query", () => {
    expect(searchRows(rows, "", text)).toEqual(rows);
    expect(searchRows(rows, "   ", text)).toEqual(rows);
  });
  it("matches the name or the location, ignoring case", () => {
    expect(searchRows(rows, "ARENA", text).map((r) => r.name)).toEqual(["Arena"]);
    expect(searchRows(rows, "audio", text).map((r) => r.name)).toEqual(["Sound Lab"]);
  });
  it("needs every word", () => {
    expect(searchRows(rows, "games flappy", text).map((r) => r.name)).toEqual(["Flappy"]);
    expect(searchRows(rows, "games arena", text)).toEqual([]);
  });
});

describe("splitLatest", () => {
  it("takes the newest as latest and keeps the rest newest first", () => {
    const { latest, rest } = splitLatest(rows, (r) => r.t);
    expect(latest?.name).toBe("Arena");
    expect(rest.map((r) => r.name)).toEqual(["Sound Lab", "Flappy"]);
  });
  it("has no latest for no rows", () => {
    expect(splitLatest([], () => 0)).toEqual({ latest: null, rest: [] });
  });
});

describe("openedWhen", () => {
  const now = new Date(2026, 10, 23, 15, 0).getTime();
  it("says today or yesterday with the time", () => {
    expect(openedWhen(new Date(2026, 10, 23, 9, 5).getTime(), now, "en-GB")).toBe("today, 09:05");
    expect(openedWhen(new Date(2026, 10, 22, 23, 59).getTime(), now, "en-GB")).toBe("yesterday, 23:59");
  });
  it("gives the date for older times", () => {
    expect(openedWhen(new Date(2026, 9, 1, 12, 0).getTime(), now, "en-GB")).toBe("01/10/2026");
  });
});
