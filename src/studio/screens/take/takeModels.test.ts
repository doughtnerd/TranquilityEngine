// ADR 0348 "The Take screen": the screen's pure models, through their interfaces: the timeline read from a take
// (instances per path with held parts, parameter lanes and labelled segments, marks), Playlists in this take, the
// notes edits (one labelled step each, refusals), the takes' files (tree, moves and deletes that carry the notes), the
// inspector's authored-versus-live rows and bus strips, and the replay slot's clock.
import { describe, expect, it } from "vitest";
import { TAKE_NOTES_LIMITS } from "../../../engine/audio/take/notes";
import { Take } from "../../../engine/audio/take/reader";
import { formatClock } from "../../components/replayControlsModel";
import { addMarker, addRegion, deleteNote, editNote, moveNote, noteColourCss, setRegionSpan } from "./notesEdits";
import { FIXTURE_DURATION, FIXTURE_NOTES, SURFACE_LABELS, fixtureTake } from "./takeFixture";
import { NO_TAKES, TAKES_FOLDER, takeDeletion, takeEmptyCopy, takeFiles, takeTree, whyNotTakeFile } from "./takeFiles";
import { busStrip, instanceParametersAt, mixerStripRows, parameterRows, playheadSummary, valueText } from "./takeInspectorModel";
import { findInstance, labelSegments, parameterText, pathLabel, pathTitle, playlistsInTake, takeInstances, takeTimeline } from "./takeTimeline";
import { frameIndexAt, pictureStrip, visibleFrames } from "../../components/filmstripModel";

const take = fixtureTake();
const labelsOf = (name: string, path: string | null) => (name === "Surface" && path === null ? SURFACE_LABELS : null);

describe("the take timeline", () => {
  const tl = takeTimeline(take, labelsOf);

  it("spans the take's real duration and has a lane per path, in first-play order", () => {
    expect(tl.duration).toBe(FIXTURE_DURATION);
    expect(tl.lanes.map((l) => l.label)).toEqual(["engine", "boost", "jump", "brake", "land", "checkpoint"].sort((a, b) => order(a) - order(b)));
    // Playlists in this take reads as folder / name, never the file's extension.
    expect(playlistsInTake(tl).find((p) => p.path === "vehicles/engine.playlist.json")).toEqual({ path: "vehicles/engine.playlist.json", label: "vehicles / engine", count: 1 });
    expect(pathTitle("audio/events/engine-single.playlist.json")).toBe("events / engine-single");
    expect(pathTitle("click.playlist.json")).toBe("click");
  });

  it("labels instances by their lane and place, how long they were held and their first parameter, never by id", () => {
    const boost = tl.lanes.find((l) => l.label === "boost")!.spans[0]!;
    expect(boost.label).toBe("boost · instance 1 · held 1.8 s");
    const engine = tl.lanes.find((l) => l.label === "engine")!.spans[0]!;
    expect(engine.label).toBe("engine · instance 1 · Rpm 900");
    for (const l of tl.lanes) for (const s of l.spans) expect(s.label).not.toMatch(/#\d/);
  });

  it("holds a parameter set once across the span it applies to, so its lane draws a step", () => {
    // The landing sets Velocity once, at its PLAY (20.2 s); it stops at 21.4 s.
    const velocity = tl.parameters.find((p) => p.key === "impacts/land.playlist.json:Velocity")!;
    expect(velocity.points).toEqual([{ t: 20.2, v: 0.71 }, { t: 21.4, v: 0.71 }]);
    // A global's last value holds to the take's end.
    const speed = tl.parameters.find((p) => p.key === "global:Speed")!;
    expect(speed.points.at(-1)!.t).toBe(FIXTURE_DURATION);
  });

  it("draws each instance from its PLAY to its STOP, held up to its RELEASE", () => {
    const boost = tl.lanes.find((l) => l.label === "boost")!.spans[0]!;
    expect(boost).toMatchObject({ start: 5.6, end: 9.9, held: { start: 5.6, end: 7.4 }, status: "ok" });
    const checkpoint = tl.lanes.find((l) => l.label === "checkpoint")!.spans[0]!;
    expect(checkpoint.end).toBeNull(); // never stopped: to the end of the take
    expect(checkpoint.held).toBeNull();
    const land = tl.lanes.find((l) => l.label === "land")!;
    expect(land.spans[0]!.label).toBe("land · instance 1 · Velocity 0.71");
    expect(findInstance(tl, land.instances[0]!.key)?.path).toBe("impacts/land.playlist.json");
  });

  it("reads parameter lanes: globals first, labelled ones as merged segments", () => {
    const surface = tl.parameters.find((p) => p.key === "global:Surface")!;
    expect(surface.segments!.map((s) => s.label)).toEqual(["Dirt", "Rock", "Metal bridge", "Dirt"]);
    expect(surface.segments![1]).toMatchObject({ from: 12.3, to: 21.3 });
    expect(parameterText(surface, 15)).toBe("Rock");
    const speed = tl.parameters.find((p) => p.key === "global:Speed")!;
    expect(speed.segments).toBeNull();
    expect(Number(parameterText(speed, 20))).toBeGreaterThan(150);
    const rpm = tl.parameters.find((p) => p.name === "Rpm")!;
    expect(rpm).toMatchObject({ path: "vehicles/engine.playlist.json", label: "Rpm · engine" });
    expect(tl.parameters[0]!.path).toBeNull();
    expect(tl.marks.map((m) => m.text)).toEqual(["Canyon entry", "Bridge"]);
  });

  it("merges equal labels and ends the last segment at the take's end", () => {
    expect(labelSegments([{ t: 0, v: 0 }, { t: 1, v: 0 }, { t: 2, v: 1 }], ["A", "B"], 5)).toEqual([{ from: 0, to: 2, label: "A" }, { from: 2, to: 5, label: "B" }]);
    expect(labelSegments([{ t: 0, v: 7 }], ["A"], 1)).toEqual([{ from: 0, to: 1, label: "7" }]);
  });

  it("counts an instance alive at the first keyframe once, and gives reused ids their own keys", () => {
    const instances = takeInstances(take);
    expect(instances.filter((i) => i.path === "vehicles/engine.playlist.json")).toHaveLength(1);
    expect(new Set(instances.map((i) => i.key)).size).toBe(instances.length);
  });

  it("ends a one-shot the game never stopped at the first keyframe that no longer lists it, not at the take's end (journeys walk 2, J10.2)", () => {
    const meta = { ...take.meta, duration: 5 };
    const play = (t: number, instance: number) => ({ kind: "play" as const, t, instance, path: "sfx/step.playlist.json", emitter: null, options: {} });
    const listed = (t: number, ...started: number[]) => ({ type: "keyframe" as const, keyframe: { t, globals: {}, instances: started.map((s) => ({ instance: 1, path: "sfx/step.playlist.json", started: s, emitter: null, parameters: {} })) } });
    const short = new Take(meta, [
      { type: "request", requests: [play(0.2, 1)] },
      listed(0), listed(1), // played out within the first second
      { type: "request", requests: [play(1.5, 1)] }, // the id reused
      listed(2, 1.5), listed(3, 1.5), listed(4, 1.5), listed(5, 1.5), // still playing at the end
    ]);
    expect(takeInstances(short).map((i) => [i.start, i.end])).toEqual([[0.2, 1], [1.5, null]]);
  });

  it("thins pictures so thumbnails don't overlap, and names paths", () => {
    expect(visibleFrames([{ t: 0 }, { t: 0.5 }, { t: 2 }, { t: 3 }], (t) => t * 40, 64)).toEqual([0, 2]);
    expect(pathLabel("a/b/engine.playlist.json")).toBe("engine");
    expect(pathLabel("click")).toBe("click");
  });

  it("carries the take's pictures, and finds the one on screen at a time", () => {
    expect(tl.frames).toHaveLength(FIXTURE_DURATION);
    expect(tl.frames[0]).toMatchObject({ t: 0.02, width: 48, height: 27 });
    expect(takeTimeline(fixtureTake({ pictures: false })).frames).toEqual([]);
    const frames = [{ t: 0 }, { t: 1 }, { t: 2 }];
    expect([-1, 0, 0.5, 1, 1.99, 2, 9].map((t) => frameIndexAt(frames, t))).toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(frameIndexAt([], 3)).toBe(-1);
  });

  it("keeps the picture at the playhead on the strip, dropping a thumbnail it would overlap", () => {
    const frames = [{ t: 0 }, { t: 0.5 }, { t: 2 }, { t: 3 }];
    const x = (t: number) => t * 40;
    expect(pictureStrip(frames, x, 64, 2.2)).toEqual({ shown: [0, 2], current: 2 });
    expect(pictureStrip(frames, x, 64, 0.7)).toEqual({ shown: [1], current: 1 }); // 0.5 replaces 0 (20 px apart); 2 is 60 px from 0.5
    expect(pictureStrip([], x, 64, 1)).toEqual({ shown: [], current: -1 });
  });
});

const order = (label: string) => ["engine", "boost", "jump", "land", "brake", "checkpoint"].indexOf(label);

describe("notes edits (one step each)", () => {
  it("adds a marker at the playhead, clamped, with a fresh id", () => {
    const r = addMarker(FIXTURE_NOTES, 99, FIXTURE_DURATION, "late");
    if ("refused" in r) throw new Error(r.refused);
    expect(r.label).toBe("Add note marker");
    expect(r.next.markers.find((m) => m.id === r.id)).toMatchObject({ at: FIXTURE_DURATION, text: "late" });
  });

  it("adds a region, giving a point a default length that fits in the take", () => {
    const r = addRegion(FIXTURE_NOTES, 40.5, 40.5, FIXTURE_DURATION);
    if ("refused" in r) throw new Error(r.refused);
    const g = r.next.regions.find((x) => x.id === r.id)!;
    expect(g.to).toBe(FIXTURE_DURATION);
    expect(g.to - g.from).toBeCloseTo(2);
    expect("refused" in addRegion(FIXTURE_NOTES, 0, 0, 0)).toBe(true);
  });

  it("moves markers and regions (keeping a region's length), edits, recolours, resizes and deletes", () => {
    const moved = moveNote(FIXTURE_NOTES, "r1", 40, FIXTURE_DURATION);
    if ("refused" in moved) throw new Error(moved.refused);
    expect(moved.next.regions[0]).toMatchObject({ from: 37, to: 41 });
    const m = moveNote(FIXTURE_NOTES, "m2", 1, FIXTURE_DURATION);
    if ("refused" in m) throw new Error(m.refused);
    expect(m.next.markers.map((x) => x.id)).toEqual(["m2", "m1"]); // kept in time order
    const e = editNote(FIXTURE_NOTES, "m1", { text: "fixed" });
    expect("next" in e && e.next.markers[0]!.text).toBe("fixed");
    const c = editNote(FIXTURE_NOTES, "r1", { color: 0x123456 });
    expect("next" in c && c.label).toBe("Recolour note");
    const s = setRegionSpan(FIXTURE_NOTES, "r1", 30, 25, FIXTURE_DURATION);
    expect("next" in s && s.next.regions[0]).toMatchObject({ from: 25, to: 30 });
    const d = deleteNote(FIXTURE_NOTES, "m1");
    expect("next" in d && d.next.markers.map((x) => x.id)).toEqual(["m2"]);
    for (const r of [deleteNote(FIXTURE_NOTES, "zz"), moveNote(FIXTURE_NOTES, "zz", 1, 5), editNote(FIXTURE_NOTES, "zz", {}), setRegionSpan(FIXTURE_NOTES, "r1", 3, 3, 5)]) expect("refused" in r).toBe(true);
  });

  it("refuses past the limits and writes colours as CSS", () => {
    const full = { ...FIXTURE_NOTES, markers: Array.from({ length: TAKE_NOTES_LIMITS.markers }, (_, i) => ({ id: `m${i}`, at: 0, text: "", color: 0 })) };
    expect("refused" in addMarker(full, 1, 5)).toBe(true);
    expect(noteColourCss(0x56ccf2)).toBe("#56ccf2");
    expect(noteColourCss(0x0000ff)).toBe("#0000ff");
  });
});

describe("the takes' files", () => {
  const files = ["recordings/a.sporesample", "recordings/a.sporesample.notes.json", "recordings/old/b.sporesample", "recordings/c.sporesample", "audio.json"];

  it("lists every recording by folder (takes and captures share the extension, ADR 0409), never notes", () => {
    expect(takeFiles(files)).toEqual(["recordings/a.sporesample", "recordings/old/b.sporesample", "recordings/c.sporesample"]);
    const tree = takeTree(files);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: "folder", path: "recordings" });
    expect(TAKES_FOLDER).toBe("recordings");
    expect(NO_TAKES).toContain("F10");
    expect(NO_TAKES).toMatch(/^Record one with Record take on the editor/); // a sentence of its own under "No takes yet" (T4)
  });

  it("the empty centre says how to record a take in one short line (spec §1.3; journeys walk 2, J1.5)", () => {
    for (const has of [false, true]) {
      const { title, line } = takeEmptyCopy(has);
      expect(line).toContain("Record take on the editor's Play toolbar");
      expect(line.length).toBeLessThanOrEqual(90); // one line at the centre's width
      expect(line.split(". ").length).toBe(1);
      expect(title).toBe(has ? "No take open" : "No takes yet");
    }
  });

  it("a take's notes go with it", () => {
    expect(takeDeletion(files, "recordings/a.sporesample")).toEqual(["recordings/a.sporesample", "recordings/a.sporesample.notes.json"]);
    expect(whyNotTakeFile("run.wav")).toContain("isn't a take file");
    expect(whyNotTakeFile("run.sporesample")).toBeNull();
  });
});

describe("the inspector's values", () => {
  it("reads an instance's parameters at the playhead from its start and PARAM records", () => {
    const engine = takeInstances(take).find((i) => i.path.endsWith("engine.playlist.json"))!;
    const early = instanceParametersAt(take, engine, 0.1);
    const late = instanceParametersAt(take, engine, 10);
    expect(early.Rpm).toBe(900 + Math.round((6200 * 40) / 220));
    expect(late.Rpm).toBeGreaterThan(early.Rpm!);
  });

  it("puts recorded and live values side by side and flags a difference", () => {
    const rows = parameterRows({ Speed: 100, Gear: 2 }, (n) => (n === "Speed" ? 80 : undefined));
    expect(rows).toEqual([
      { name: "Gear", recorded: 2, live: null, differs: false },
      { name: "Speed", recorded: 100, live: 80, differs: true },
    ]);
    expect(parameterRows({ A: 1 }, null)[0]!.live).toBeNull();
    expect(valueText(-0.126)).toBe("−0.13");
    expect(valueText("Rock")).toBe("Rock");
    expect(valueText(null)).toBe("—");
  });

  it("shows a bus's authored and live level", () => {
    const s = busStrip({ name: "Music", authored: 0.5, runtime: 0.5, duck: 1, peak: 0.25 });
    expect(s.authoredDb).toBeCloseTo(-6.02, 1);
    expect(s.liveDb).toBeCloseTo(-12.04, 1);
    expect(s.text).toBe("−6.0 dB · live −12.0 dB");
    expect(busStrip({ name: "SFX", authored: 1, runtime: 1, duck: 1, peak: 0 })).toMatchObject({ text: "0.0 dB", peakDb: null });
  });

  describe("the Mixer strip's rows", () => {
    const live = { runtime: 1, duck: 1, peak: 0.5 };
    const recorded = { runtime: 0.5, duck: 0.5, peak: 0.25 };
    const buses = [
      { name: "Music", authored: 1, live, recorded },
      { name: "SFX", authored: 0.5, live, recorded: null },
      { name: "Voice", authored: 1, live: null, recorded: null },
    ];

    it("shows each bus as the take recorded it at the playhead", () => {
      const [music] = mixerStripRows(buses, true);
      expect(music).toMatchObject({ name: "Music", authoredDb: 0, recorded: true, text: "0.0 dB · take −12.0 dB" });
      expect(music!.liveDb).toBeCloseTo(-12.04, 1);
      expect(music!.peakDb).toBeCloseTo(-12.04, 1);
    });

    it("falls back to the runtime for a bus the take has no reading of, then to the authored level alone", () => {
      const [, sfx, voice] = mixerStripRows(buses, true);
      expect(sfx).toMatchObject({ recorded: false, text: "−6.0 dB" });
      expect(sfx!.peakDb).toBeCloseTo(-6.02, 1);
      expect(voice).toMatchObject({ recorded: false, liveDb: 0, peakDb: null, text: "0.0 dB" });
    });

    it("shows the runtime's levels away from the playhead (the replay playing)", () => {
      const rows = mixerStripRows(buses, false);
      expect(rows.map((r) => r.recorded)).toEqual([false, false, false]);
      expect(rows[0]).toMatchObject({ liveDb: 0, text: "0.0 dB" });
    });

    it("moves with the playhead: a later reading gives a later level", () => {
      const at = (gains: typeof recorded) => mixerStripRows([{ name: "Music", authored: 1, live, recorded: gains }], true)[0]!.liveDb;
      expect(at({ runtime: 1, duck: 1, peak: 0.5 })).toBe(0);
      expect(at({ runtime: 1, duck: 0.5, peak: 0.5 })).toBeCloseTo(-6.02, 1);
    });
  });
});

describe("the take at the playhead (ADR 0408)", () => {
  it("lists what sounds, how far along the take is, the markers either side and the time of day", () => {
    const timeline = takeTimeline(take, () => null);
    const at = playheadSummary(timeline, take.meta, 18);
    const all = timeline.lanes.reduce((n, l) => n + l.instances.length, 0);
    expect(at.total).toBe(all);
    expect(at.started).toBeGreaterThan(0);
    expect(at.started).toBeLessThanOrEqual(all);
    for (const p of at.playing) {
      const i = timeline.lanes.flatMap((l) => l.instances).find((x) => x.key === p.key)!;
      expect(i.start).toBeLessThanOrEqual(18);
      expect(i.end === null || i.end > 18).toBe(true);
      expect(p.playingFor).toBeCloseTo(18 - i.start, 6);
      if (i.emitter !== null) expect(p.emitter).toBe(take.meta.emitters[i.emitter] ?? null);
    }
    expect(at.playing.map((p) => p.playingFor)).toEqual([...at.playing.map((p) => p.playingFor)].sort((a, b) => a - b));
    expect(at.lastMark).toEqual({ t: 14, text: "Canyon entry" });
    expect(at.nextMark).toEqual({ t: 22, text: "Bridge" });
    expect(at.wallClock?.getTime()).toBe(Date.parse(take.meta.started) + 18_000);
    expect(playheadSummary(timeline, take.meta, 0).lastMark).toBeNull();
  });
});

describe("the replay clock", () => {
  it("writes take time as timecode, mm:ss.mmm (spec §3.14)", () => {
    expect(formatClock(0)).toBe("00:00.000");
    expect(formatClock(20.48)).toBe("00:20.480");
    expect(formatClock(59.9996)).toBe("01:00.000");
    expect(formatClock(65.25)).toBe("01:05.250");
    expect(formatClock(-3)).toBe("00:00.000");
  });
});
