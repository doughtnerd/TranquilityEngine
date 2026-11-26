import { afterEach, describe, expect, it } from "vitest";
import { signal } from "@preact/signals";
import { setLevel } from "./mixEdits";
import { createMixerSession } from "./mixerScreen";
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
    expect(f.steps.at(-1)!.label).toBe("New bus");
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

  it("counts the edits made while the game session is live, keeps the count after it stops, and starts again at 0", () => {
    let live = false;
    const f = make(mixerFixture(), { extra: { sessionLive: () => live } });
    const s = f.session;
    s.commit(setLevel(s.project.peek(), "Music", -4, null), "Set level · Music");
    expect(s.liveEdits.peek()).toBe(0);
    live = true;
    expect(s.sessionLive()).toBe(true);
    // A drag is one edit however many moves it makes.
    for (const db of [-5, -6, -7]) s.commit(setLevel(s.project.peek(), "Music", db, null), "Set level · Music", true);
    s.commit(setLevel(s.project.peek(), "UI", -1, null), "Set level · UI");
    expect(s.liveEdits.peek()).toBe(2);
    live = false;
    expect(s.sessionLive()).toBe(false);
    expect(s.liveEdits.peek()).toBe(2);
    live = true;
    s.sessionLive();
    expect(s.liveEdits.peek()).toBe(0);
  });

  it("holds the meter and loudness readings while a take replay is paused, and moves them again on play", () => {
    let replay: { take: string; duration: number; time: number; playing: boolean } | null = { take: "t", duration: 10, time: 2, playing: true };
    let level = 0.5;
    const f = make(mixerFixture(), {
      extra: {
        takeReplay: () => replay,
        readBus: () => ({ volume: 1, duckGain: 1, peak: level, activeVoices: 1 }),
        readLoudness: () => ({ momentary: level, shortTerm: level, integrated: level, lra: 0, maxTruePeak: level, tainted: false }),
      },
    });
    const s = f.session;
    const bus = () => s.deps.readBus!("Music")!.peak;
    const lufs = () => s.deps.readLoudness!("Music")!.shortTerm;
    expect([bus(), lufs()]).toEqual([0.5, 0.5]);
    expect(s.levelsHeld()).toBe(false);
    replay = { ...replay!, playing: false };
    level = 0;
    expect(s.levelsHeld()).toBe(true);
    expect([bus(), lufs()]).toEqual([0.5, 0.5]);
    replay = { ...replay!, playing: true };
    level = 0.25;
    expect([bus(), lufs()]).toEqual([0.25, 0.25]);
    // Stopped at the start (or no take open): the readings fall as the runtime reports them.
    replay = { ...replay!, playing: false };
    level = 0.1;
    expect(bus()).toBe(0.25);
    replay = { ...replay!, time: 0 };
    expect(s.levelsHeld()).toBe(false);
    expect(bus()).toBe(0.1);
    replay = null;
    expect(bus()).toBe(0.1);
  });

  it("shows what the take recorded at the playhead while its replay is paused, so a scrub moves the meters", () => {
    let replay: { take: string; duration: number; time: number; playing: boolean } | null = { take: "t", duration: 10, time: 2, playing: true };
    const recorded = new Map<number, number>([[0, 0.05], [2, 0.3], [6, 0.8]]);
    const f = make(mixerFixture(), {
      extra: {
        takeReplay: () => replay,
        readBus: () => ({ volume: 1, duckGain: 1, peak: 0.5, activeVoices: 1 }),
        recordedBus: (name: string) => (name === "Music" && replay && recorded.has(replay.time) ? { volume: 1, duckGain: 1, peak: recorded.get(replay.time)!, activeVoices: 0 } : null),
      },
    });
    const bus = (name = "Music") => f.session.deps.readBus!(name)!.peak;
    expect(bus()).toBe(0.5); // playing: the runtime's reading
    replay = { ...replay!, playing: false };
    expect(bus()).toBe(0.3);
    replay = { ...replay!, time: 6 }; // a scrub while paused
    expect(bus()).toBe(0.8);
    replay = { ...replay!, time: 0 }; // at the start too
    expect(bus()).toBe(0.05);
    // A bus the take's profile can't say keeps the held reading.
    expect(bus("SFX")).toBe(0.5);
  });

  it("makes snapshot folders as steps of the file, so Undo takes an empty folder away", () => {
    const f = make(mixerFixture());
    const s = f.session;
    expect(s.newFolder("States")).toBe("States/New folder");
    expect(s.project.peek().snapshotFolders).toEqual(["States/New folder"]);
    expect(f.steps.at(-1)!.label).toBe("New folder");
  });

  it("names a new bus, return, VCA, snapshot or folder step by what it made, once", () => {
    const f = make(mixerFixture());
    const s = f.session;
    expect(s.newReturn()).toBe("New return");
    expect(s.newVca()).toBe("New VCA");
    expect(s.newSnapshot("")).toBe("New snapshot");
    expect(f.steps.map((x) => x.label).slice(-3)).toEqual(["New return", "New VCA", "New snapshot"]);
  });

  it("cancels a snapshot made just now (Escape on its first name): its step is undone, not followed by a delete", () => {
    const f = make(mixerFixture());
    const s = f.session;
    const before = s.project.peek();
    const name = s.newSnapshot("")!;
    s.cancelNewSnapshot(name);
    expect(s.project.peek()).toBe(before);
    expect(f.steps.map((x) => x.label)).not.toContain("New snapshot");
    expect(s.editing.peek()).toBeNull();
  });

  it("starts with nothing pinned to the live board, and a new bus isn't pinned by its name (J1.3, J8.1)", () => {
    const value = signal(mixerFixture());
    const s = createMixerSession({ doc: { value, readOnly: false, edit: (next) => void (value.value = next) }, confirm: async () => true, toast: () => {}, report: () => {} });
    expect(s.pins.peek()).toEqual([]);
    s.select("Master");
    s.newBus();
    s.rename("New bus", "Music 2");
    expect(s.pins.peek()).toEqual([]);
    s.dispose();
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
