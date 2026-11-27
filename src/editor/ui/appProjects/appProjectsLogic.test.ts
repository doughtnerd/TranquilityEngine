import { describe, expect, it } from "vitest";
import { RecentProjects } from "../../recentProjectList";
import { createToastQueue } from "../undoToastModel";
import { openedWhen, removeFromList, searchRows, splitLatest } from "./appProjectsLogic";

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

describe("removeFromList", () => {
  const setup = async () => {
    let text: string | null = null;
    const recent = new RecentProjects({ read: () => text, write: (t) => void (text = t) }, null);
    await recent.add({ name: "Old", path: "/games/old" }, 1);
    await recent.add({ name: "Latest", path: "/games/latest" }, 2);
    return { recent, toasts: createToastQueue() };
  };
  const latestOf = (recent: RecentProjects) => splitLatest(recent.list(), (e) => e.lastOpened).latest;

  it("takes the project off the list, so the next most recent is the one to continue, and says the folder stays", async () => {
    const { recent, toasts } = await setup();
    expect(await removeFromList(recent, latestOf(recent)!, toasts)).toBe(true);
    expect(latestOf(recent)?.name).toBe("Old");
    expect(toasts.toasts.value.map((t) => [t.text, t.undoLabel])).toEqual([["Removed Latest from the list. Its folder is still on disk.", "Undo"]]);
  });

  it("leaves nothing to continue once the last project goes", async () => {
    const { recent, toasts } = await setup();
    for (const e of recent.list()) await removeFromList(recent, e, toasts);
    expect(latestOf(recent)).toBeNull();
  });

  it("puts the project back where it was on Undo", async () => {
    const { recent, toasts } = await setup();
    await removeFromList(recent, latestOf(recent)!, toasts);
    expect(toasts.undo(toasts.toasts.value[0]!.id)).toBe(true);
    await new Promise((r) => setTimeout(r));
    expect(recent.list().map((e) => e.name)).toEqual(["Latest", "Old"]);
  });

  it("does nothing, and shows no toast, for an entry no longer on the list", async () => {
    const { recent, toasts } = await setup();
    expect(await removeFromList(recent, { id: "gone", name: "Gone" }, toasts)).toBe(false);
    expect(toasts.toasts.value).toEqual([]);
  });
});
