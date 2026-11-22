import { afterEach, describe, expect, it } from "vitest";
import { setLevel } from "./mixEdits";
import { mixerFixture } from "./mixerFixture";
import { fakeMixer, type FakeMixer } from "./mixerStoryData";

let open: FakeMixer[] = [];
const make = (...args: Parameters<typeof fakeMixer>) => {
  const f = fakeMixer(...args);
  open.push(f);
  return f;
};
afterEach(() => {
  for (const f of open) f.session.dispose();
  open = [];
});

describe("the Mixer session", () => {
  it("makes each edit one labelled step and reports refusals", () => {
    const f = make(mixerFixture());
    const s = f.session;
    s.commit(setLevel(s.project.peek(), "Music", -4, null), "Set level · Music", true);
    expect(f.steps).toEqual([{ label: "Set level · Music", coalesce: true }]);
    s.commit({ refused: "nope" }, "Re-route · Music");
    expect(f.reports).toEqual(["error: Can't re-route · Music: nope"]);
    s.select("Vehicles");
    s.newBus();
    expect(s.selected.peek()).toBe("New bus");
    expect(f.steps.at(-1)!.label).toBe("New bus · New bus");
    expect(s.project.peek().buses.find((b) => b.name === "New bus")!.parent).toBe("Vehicles");
  });

  it("asks before a delete, listing what goes, and selects the parent after", async () => {
    const f = make(mixerFixture(), { usersOf: () => ["music/theme.playlist.json"] });
    const s = f.session;
    s.select("Ambience");
    f.confirmWith(false);
    expect(await s.remove("Ambience")).toBe(false);
    expect(f.steps).toEqual([]);
    f.confirmWith(true);
    expect(await s.remove("Ambience")).toBe(true);
    expect(f.steps.at(-1)!.label).toBe("Delete bus · Ambience");
    expect(s.selected.peek()).toBe("Master");
  });

  it("renames, following the selection and the pins, and asks when files route to it", async () => {
    const f = make(mixerFixture(), { usersOf: (n) => (n === "Music" ? ["a.playlist.json"] : []) });
    const s = f.session;
    s.select("Music");
    f.confirmWith(false);
    expect(await s.rename("Music", "Score")).toBe(false);
    f.confirmWith(true);
    expect(await s.rename("Music", "Score")).toBe(true);
    expect(s.selected.peek()).toBe("Score");
    expect(s.pins.peek()).toContain("Score");
    expect(await s.rename("Score", "SFX")).toBe(false);
    expect(f.reports.at(-1)).toMatch(/taken/);
  });

  it("deletes a snapshot with an undo toast that puts it back where it was", () => {
    const f = make(mixerFixture());
    const s = f.session;
    s.editSnapshot("Underwater");
    s.removeSnapshot("Underwater");
    expect(s.editing.peek()).toBeNull();
    expect(f.toasts.at(-1)!.text).toBe("Deleted Underwater");
    f.toasts.at(-1)!.undo!();
    expect(s.project.peek().snapshots[1]!.name).toBe("Underwater");
    expect(f.steps.map((x) => x.label)).toEqual(["Delete snapshot · Underwater", "Restore snapshot · Underwater"]);
  });

  it("sends every document change to the running mixer, and Compare locks edits", () => {
    const f = make(mixerFixture(), { running: true });
    const s = f.session;
    s.commit(setLevel(s.project.peek(), "Music", -4, null), "Set level · Music");
    expect(f.applied).toEqual([{ op: "setBus", bus: "Music", key: "volume", value: expect.closeTo(Math.pow(10, -4 / 20), 6) }]);
    s.live!.compare.toggle();
    expect(s.commit(setLevel(s.project.peek(), "UI", -1, null), "Set level · UI")).toBe(false);
    expect(f.reports.at(-1)).toMatch(/Compare/);
  });

  it("pins at most 8 and solo needs the runtime", () => {
    const f = make(mixerFixture());
    const s = f.session;
    for (const n of ["Master", "Vehicles", "Engine", "Footsteps"]) s.togglePin(n);
    expect(s.pins.peek()).toHaveLength(8);
    s.togglePin("UI");
    expect(f.reports.at(-1)).toMatch(/at most 8/);
    s.toggleSolo("Music");
    expect(f.reports.at(-1)).toMatch(/Solo needs/);
  });
});
