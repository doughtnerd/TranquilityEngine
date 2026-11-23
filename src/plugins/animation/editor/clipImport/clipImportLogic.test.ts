// The clip import settings' model (ADR 0373; T54): take split edits, clip settings and their round trip through the
// sidecar (`clips.ts`, `myco.import@1`), the loop pose-match, and the compile report the card shows (a fake compile
// service: the compiler is T19's).
import { describe, expect, it } from "vitest";
import { refusalOf } from "../../../../editor/sdk";
import type { ImportedTake } from "../../../../engine/animation/import/channels";
import { clipsFromTakes, defaultModelAnimationSettings, type ModelAnimationSettings } from "../../../../engine/animation/import/clips";
import { defaultImportSettings, formatImportSettings, parseImportSettings } from "../../../../engine/scene/importSettings";
import type { ClipReport } from "../compile/compiler";
import type { ClipCompileResult } from "../compile/service";
import type { CompiledClipRequest } from "../../runtime/features/clipSources";
import {
  LOOP_TOLERANCE, addClip, allClipNames, clipReportOf, clipsOfTake, curveKey, describeReport, newEvent, newMarker, poseMatch, removeClip, renameClip, rootMotionWithAxis, setAdditive, setClipRange, setCompression, setCurves,
  setEvents, setLoop, setMarkers, setMirror, setRootMotion, splitClip, type ClipReportSource,
} from "./clipImportLogic";

const TAKES = [{ name: "Take 001", duration: 4 }, { name: "Dance", duration: 2 }];
const empty = (): ModelAnimationSettings => defaultModelAnimationSettings();
const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

/** What the sidecar holds after `a` is saved and read back (one model.glb.meta.json). */
function saved(a: ModelAnimationSettings): ModelAnimationSettings | null {
  const read = parseImportSettings(JSON.parse(formatImportSettings({ ...defaultImportSettings(), animation: a })), "model.glb.meta.json");
  expect(read.problems).toEqual([]);
  return read.settings.animation;
}

/** Splits Take 001 into Walk (0..1.5) and Run (1.5..end), as the sidecar of a typical import. */
function walkRun(): ModelAnimationSettings {
  const first = ok(renameClip(ok(setClipRange(empty(), TAKES, "Take 001", "Take 001", 0, 1.5)), TAKES, "Take 001", "Take 001", "Walk"));
  return ok(addClip(first, TAKES, "Take 001", "Run", 1.5, null));
}

describe("splitting takes", () => {
  it("a take with no entry is one clip over its whole length, written out by the first edit", () => {
    expect(clipsOfTake(empty(), "Dance")).toMatchObject([{ name: "Dance", from: 0, to: null }]);
    const a = ok(addClip(empty(), TAKES, "Dance", "Spin", 1, null));
    expect(clipsOfTake(a, "Dance").map((c) => c.name)).toEqual(["Dance", "Spin"]);
  });

  it("add, rename, retime and remove clips round-trip through the sidecar and cut the clips the importer makes", () => {
    let a = walkRun();
    a = ok(renameClip(a, TAKES, "Take 001", "Walk", "Stroll"));
    a = ok(setClipRange(a, TAKES, "Take 001", "Run", 1.25, 3.5));
    expect(saved(a)?.clips).toEqual({ "Take 001": [expect.objectContaining({ name: "Stroll", from: 0, to: 1.5 }), expect.objectContaining({ name: "Run", from: 1.25, to: 3.5 })] });
    const takes = TAKES.map((t) => ({ name: t.name, duration: t.duration, tracks: [] as ImportedTake["tracks"] }));
    const clips = clipsFromTakes(takes, saved(a)!, []);
    expect(clips.map((c) => [c.name, c.take, c.source.duration])).toEqual([["Stroll", "Take 001", 1.5], ["Run", "Take 001", 2.25], ["Dance", "Dance", 2]]);
    a = ok(removeClip(a, TAKES, "Take 001", "Stroll"));
    expect(clipsOfTake(a, "Take 001").map((c) => c.name)).toEqual(["Run"]);
    expect(allClipNames(a, TAKES)).toEqual(["Run", "Dance"]);
  });

  it("the last clip of a take can go (the take then makes none)", () => {
    const a = ok(removeClip(empty(), TAKES, "Dance", "Dance"));
    expect(saved(a)?.clips).toEqual({ Dance: [] });
    expect(clipsFromTakes(TAKES.map((t) => ({ ...t, tracks: [] })), saved(a)!, []).map((c) => c.name)).toEqual(["Take 001"]);
  });

  it("an end at the take's end is stored as the end (to absent)", () => {
    const a = ok(setClipRange(walkRun(), TAKES, "Take 001", "Run", 1.5, 4));
    expect(clipsOfTake(a, "Take 001")[1].to).toBeNull();
  });

  it("refuses a bad range, name or a repeated name, with the reason", () => {
    const a = walkRun();
    expect(refusalOf(addClip(a, TAKES, "Take 001", "Late", 5, null))).toMatch(/from must be within the take/);
    expect(refusalOf(addClip(a, TAKES, "Take 001", "Back", 2, 1))).toMatch(/to must be after from/);
    expect(refusalOf(addClip(a, TAKES, "Take 001", "Long", 0, 9))).toMatch(/no later than the take's end/);
    expect(refusalOf(addClip(a, TAKES, "Take 001", "Run", 0, 1))).toMatch(/already a clip/);
    expect(refusalOf(addClip(a, TAKES, "Dance", "Run", 0, 1))).toMatch(/already a clip/);
    expect(refusalOf(addClip(a, TAKES, "Take 001", "a/b", 0, 1))).toMatch(/name without/);
    expect(refusalOf(addClip(a, TAKES, "Take 001", "  ", 0, 1))).toMatch(/name without/);
    expect(refusalOf(addClip(a, TAKES, "Nope", "X", 0, 1))).toMatch(/no take "Nope"/);
    expect(refusalOf(setClipRange(a, TAKES, "Take 001", "Walk", Number.NaN, null))).toMatch(/must be numbers/);
    expect(refusalOf(removeClip(a, TAKES, "Take 001", "Nope"))).toMatch(/no clip "Nope"/);
    expect(refusalOf(renameClip(a, TAKES, "Take 001", "Run", "Walk"))).toMatch(/already a clip/);
  });

  it("splits a clip at a time into two, moving the markers and events after it and copying its settings", () => {
    let a = walkRun();
    a = ok(setRootMotion(a, TAKES, "Take 001", "Run", { bone: "Hips", axes: ["x", "z", "yaw"], bakeIntoPose: false }, ["Hips"]));
    a = ok(setMarkers(a, TAKES, "Take 001", "Run", [newMarker(0.5, "sync", "L"), newMarker(1.5, "sync", "R")]));
    a = ok(setEvents(a, TAKES, "Take 001", "Run", [newEvent(0.25, "step"), newEvent(2, "land")]));
    a = ok(setLoop(a, TAKES, "Take 001", "Run", true));
    const s = ok(splitClip(a, TAKES, "Take 001", "Run", 2.5));
    const [walk, run, run2] = clipsOfTake(s, "Take 001");
    expect([walk.name, run.name, run2.name]).toEqual(["Walk", "Run", "Run 2"]);
    expect([run.from, run.to, run2.from, run2.to]).toEqual([1.5, 2.5, 2.5, null]);
    expect(run.markers.map((m) => m.time)).toEqual([0.5]);
    expect(run2.markers.map((m) => m.time)).toEqual([0.5]); // 1.5 - (2.5 - 1.5)
    expect(run.events.map((e) => e.method)).toEqual(["step"]);
    expect(run2.events).toMatchObject([{ method: "land", time: 1 }]);
    expect(run2.rootMotion).toEqual(run.rootMotion);
    expect([run.loop, run2.loop]).toEqual([true, false]);
    expect(saved(s)?.clips["Take 001"]).toHaveLength(3);
  });

  it("refuses to split outside the clip", () => {
    const a = walkRun();
    expect(refusalOf(splitClip(a, TAKES, "Take 001", "Walk", 0))).toMatch(/split inside the clip/);
    expect(refusalOf(splitClip(a, TAKES, "Take 001", "Walk", 1.5))).toMatch(/split inside the clip/);
    expect(refusalOf(splitClip(a, TAKES, "Take 001", "Run", 1))).toMatch(/between 1.5 and 4/);
  });
});

describe("a clip's settings", () => {
  const base = () => walkRun();

  it("loop and mirror, one case per value", () => {
    for (const loop of [true, false]) expect(clipsOfTake(ok(setLoop(base(), TAKES, "Take 001", "Walk", loop)), "Take 001")[0].loop).toBe(loop);
    for (const mirror of [true, false]) expect(clipsOfTake(ok(setMirror(base(), TAKES, "Take 001", "Walk", mirror)), "Take 001")[0].mirror).toBe(mirror);
    const looping = ok(setLoop(base(), TAKES, "Take 001", "Walk", true));
    expect(ok(setLoop(looping, TAKES, "Take 001", "Walk", true))).toBe(looping); // no change: the same value
  });

  it("root motion: bone, axes (each toggled) and bake-into-pose round-trip; an unknown bone or no axis is refused", () => {
    const bones = ["Hips", "Root"];
    const rm = { bone: "Hips", axes: ["x", "z", "yaw"] as const, bakeIntoPose: false };
    let a = ok(setRootMotion(base(), TAKES, "Take 001", "Walk", { ...rm, axes: [...rm.axes] }, bones));
    for (const axis of ["x", "y", "z", "yaw"] as const) {
      for (const on of [true, false]) {
        const next = rootMotionWithAxis(clipsOfTake(a, "Take 001")[0].rootMotion!, axis, on);
        expect(next.axes.includes(axis)).toBe(on);
      }
    }
    a = ok(setRootMotion(a, TAKES, "Take 001", "Walk", { bone: "Root", axes: ["y"], bakeIntoPose: true }, bones));
    expect(saved(a)?.clips["Take 001"][0].rootMotion).toEqual({ bone: "Root", axes: ["y"], bakeIntoPose: true });
    expect(clipsOfTake(ok(setRootMotion(a, TAKES, "Take 001", "Walk", null, bones)), "Take 001")[0].rootMotion).toBeNull();
    expect(refusalOf(setRootMotion(base(), TAKES, "Take 001", "Walk", { ...rm, bone: "Nope", axes: [...rm.axes] }, bones))).toMatch(/no bone "Nope"/);
    expect(refusalOf(setRootMotion(base(), TAKES, "Take 001", "Walk", { bone: "Hips", axes: [], bakeIntoPose: false }, bones))).toMatch(/at least one axis/);
    expect(refusalOf(setRootMotion(base(), TAKES, "Take 001", "Walk", { bone: "", axes: ["x"], bakeIntoPose: false }, bones))).toMatch(/needs a bone/);
  });

  it("additive reference: first, a frame of another clip, or none; renaming that clip follows", () => {
    let a = ok(setAdditive(base(), TAKES, "Take 001", "Run", "first"));
    expect(saved(a)?.clips["Take 001"][1].additive).toEqual({ reference: "first" });
    a = ok(setAdditive(a, TAKES, "Take 001", "Run", "Walk#12"));
    a = ok(renameClip(a, TAKES, "Take 001", "Walk", "Stroll"));
    expect(clipsOfTake(a, "Take 001")[1].additive).toEqual({ reference: "Stroll#12" });
    expect(clipsOfTake(ok(setAdditive(a, TAKES, "Take 001", "Run", null)), "Take 001")[1].additive).toBeNull();
    expect(refusalOf(setAdditive(a, TAKES, "Take 001", "Run", "Ghost#3"))).toMatch(/no clip "Ghost"/);
    expect(refusalOf(setAdditive(a, TAKES, "Take 001", "Run", "Run#3"))).toMatch(/against itself/);
    expect(refusalOf(setAdditive(a, TAKES, "Take 001", "Run", "Stroll#x"))).toMatch(/"first" or "Clip#frame"/);
  });

  it("compression error and rate set, unset (inherit) and are range-checked", () => {
    let a = ok(setCompression(base(), TAKES, "Take 001", "Walk", { error: 0.5, maxRate: 30 }));
    expect(saved(a)?.clips["Take 001"][0].compression).toEqual({ error: 0.5, maxRate: 30 });
    a = ok(setCompression(a, TAKES, "Take 001", "Walk", { error: null }));
    expect(clipsOfTake(a, "Take 001")[0].compression).toEqual({ maxRate: 30 });
    a = ok(setCompression(a, TAKES, "Take 001", "Walk", { maxRate: null }));
    expect(saved(a)?.clips["Take 001"][0].compression).toEqual({}); // all inherited
    expect(refusalOf(setCompression(base(), TAKES, "Take 001", "Walk", { error: 0 }))).toMatch(/above 0/);
    expect(refusalOf(setCompression(base(), TAKES, "Take 001", "Walk", { maxRate: 1000 }))).toMatch(/Hz/);
  });

  it("markers, events and curves on the clip round-trip, sorted, and are limited to the clip's length", () => {
    let a = ok(setMarkers(base(), TAKES, "Take 001", "Walk", [newMarker(1, "hit"), newMarker(0.25, "sync", "L")]));
    a = ok(setEvents(a, TAKES, "Take 001", "Walk", [newEvent(0.5, "footstep", ["L"])]));
    a = ok(setCurves(a, TAKES, "Take 001", "Walk", [{ name: "FootIK", curve: [curveKey(1, 0), curveKey(0, 1)] }]));
    const walk = saved(a)!.clips["Take 001"][0];
    expect(walk.markers).toEqual([{ time: 0.25, kind: "sync", name: "L" }, { time: 1, kind: "hit" }]);
    expect(walk.events).toMatchObject([{ time: 0.5, method: "footstep", args: ["L"] }]);
    expect(walk.curves).toEqual([{ name: "FootIK", curve: [[0, 1], [1, 0]] }]);
    expect(refusalOf(setMarkers(a, TAKES, "Take 001", "Walk", [newMarker(2)]))).toMatch(/a marker needs a time inside the clip \(0 to 1.500 s\)/);
    expect(refusalOf(setMarkers(a, TAKES, "Take 001", "Walk", [{ time: 0, kind: "nope" as never }]))).toMatch(/kind/);
    expect(refusalOf(setEvents(a, TAKES, "Take 001", "Walk", [newEvent(0.1, " ")]))).toMatch(/method name/);
    expect(refusalOf(setEvents(a, TAKES, "Take 001", "Walk", [newEvent(-1, "x")]))).toMatch(/an event needs/);
    expect(refusalOf(setCurves(a, TAKES, "Take 001", "Walk", [{ name: "A", curve: [] }, { name: "A", curve: [] }]))).toMatch(/two curves named "A"/);
    expect(refusalOf(setCurves(a, TAKES, "Take 001", "Walk", [{ name: "", curve: [] }]))).toMatch(/needs a name/);
    expect(refusalOf(setCurves(a, TAKES, "Take 001", "Walk", [{ name: "A", curve: [curveKey(9, 0)] }]))).toMatch(/curve key needs/);
  });
});

// A take of two bones over 2 s: "Hips" bobs and returns; "Arm" swings and does not return when `open`.
function take(open: boolean): ImportedTake {
  const q = (deg: number) => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)] as const;
  return {
    name: "Take 001", duration: 2,
    tracks: [
      { kind: "bone", bone: "Hips", translation: [[0, 0, 0, 0], [1, 0, 0.2, 0], [2, 0, open ? 0 : 0, 0]], rotation: [], scale: [] },
      { kind: "bone", bone: "Arm", translation: [], rotation: [[0, ...q(0)], [1, ...q(60)], [2, ...q(open ? 30 : 0)]], scale: [] },
      { kind: "marker", keys: [] },
    ],
  };
}

describe("the loop pose-match", () => {
  it("matches a take whose last pose is its first, and compares only the bone tracks", () => {
    const m = poseMatch(take(false), 0, null);
    expect(m).toMatchObject({ matches: true, bones: 2, translation: 0 });
    expect(m.rotationDeg).toBeLessThan(1e-3);
  });

  it("measures how far a take that doesn't close is off, and names the worst bone", () => {
    const m = poseMatch(take(true), 0, null);
    expect(m.matches).toBe(false);
    expect(m.rotationDeg).toBeCloseTo(30, 3);
    expect(m.worstBone).toBe("Arm");
  });

  it("measures the clip's own range: a cut that ends where it began matches, one that ends elsewhere doesn't", () => {
    expect(poseMatch(take(true), 0, 2).matches).toBe(false);
    expect(poseMatch(take(true), 0, 0.001).matches).toBe(true);
    expect(poseMatch(take(true), 1, 1.001).matches).toBe(true);
    expect(poseMatch(take(true), 0, 1).rotationDeg).toBeCloseTo(60, 3);
    expect(poseMatch(take(true), 0, 1).translation).toBeCloseTo(0.2, 6);
  });

  it("leaves out the extracted channels of the root-motion bone", () => {
    const t: ImportedTake = { name: "Run", duration: 1, tracks: [{ kind: "bone", bone: "Hips", translation: [[0, 0, 0, 0], [1, 0, 0, 3]], rotation: [], scale: [] }] };
    expect(poseMatch(t, 0, null).matches).toBe(false);
    expect(poseMatch(t, 0, null, { bone: "Hips", axes: ["x", "z", "yaw"], bakeIntoPose: false }).bones).toBe(0);
    expect(poseMatch(t, 0, null, { bone: "Hips", axes: ["yaw"], bakeIntoPose: false }).matches).toBe(false); // yaw only: its translation still counts
  });

  it("a take with no bone tracks never claims a match, and the tolerance is the declared one", () => {
    expect(poseMatch({ name: "x", duration: 1, tracks: [] }, 0, null)).toMatchObject({ matches: false, bones: 0, worstBone: null });
    const edge: ImportedTake = { name: "e", duration: 1, tracks: [{ kind: "bone", bone: "B", translation: [[0, 0, 0, 0], [1, LOOP_TOLERANCE.translation * 0.9, 0, 0]], rotation: [], scale: [] }] };
    expect(poseMatch(edge, 0, null).matches).toBe(true);
  });
});

const REPORT: ClipReport = { rawSize: 48000, compressedSize: 12000, fileSize: 12400, maxError: 0.000042, worstBone: 2, worstFrame: 11, maxPropertyError: 0, worstTrack: -1, channels: [1, 2, 3], withinBounds: true, rotationFormat: "dropW" };

describe("the compile report", () => {
  function fake(report: ClipReport | null = REPORT): { service: ClipReportSource; asked: CompiledClipRequest[] } {
    const asked: CompiledClipRequest[] = [];
    const service: ClipReportSource = {
      clipReport: async (r) => (asked.push(r), report),
      compileClip: async (r): Promise<ClipCompileResult> => (asked.push(r), r.clip.endsWith("Bad") ? { error: `${r.clip}: the compile failed` } : { clip: { key: "k", bytes: new Uint8Array(3), report: REPORT } as never, problems: ["a bone track was dropped"] }),
    };
    return { service, asked };
  }

  it("reads the report of the model's clip as saved, without compiling", async () => {
    const { service, asked } = fake();
    expect(await clipReportOf(service, "models/hero.glb", "Walk")).toEqual({ state: "ready", report: REPORT, problems: [] });
    expect(asked).toEqual([{ clip: "models/hero.glb#Anim/Walk", skeleton: null }]);
    expect(await clipReportOf(fake(null).service, "models/hero.glb", "Walk")).toEqual({ state: "none" });
    expect(await clipReportOf(null, "models/hero.glb", "Walk")).toEqual({ state: "none" });
  });

  it("compiles on demand and shows the compile's problems, or why it failed", async () => {
    const { service } = fake();
    expect(await clipReportOf(service, "models/hero.glb", "Walk", true)).toEqual({ state: "ready", report: REPORT, problems: ["a bone track was dropped"] });
    expect(await clipReportOf(service, "models/hero.glb", "Bad", true)).toEqual({ state: "failed", error: "models/hero.glb#Anim/Bad: the compile failed" });
    const throwing: ClipReportSource = { clipReport: async () => { throw new Error("cache unreadable"); }, compileClip: async () => ({ error: "x" }) };
    expect(await clipReportOf(throwing, "m.glb", "A")).toEqual({ state: "failed", error: "cache unreadable" });
  });

  it("describes the size and the maximum error in the card's units", () => {
    expect(describeReport(REPORT)).toEqual({ size: "12.1 KB", raw: "raw 46.9 KB", ratio: "25%", maxError: "0.042 mm", withinBounds: true });
    expect(describeReport({ ...REPORT, maxError: 0, fileSize: 90, rawSize: 0 })).toMatchObject({ size: "90 B", ratio: "-", maxError: "0.000 mm" });
    expect(describeReport({ ...REPORT, maxError: 0.0123, withinBounds: false })).toMatchObject({ maxError: "12.30 mm", withinBounds: false });
    expect(describeReport({ ...REPORT, maxError: 0.0000001 }).maxError).toBe("<0.001 mm");
  });
});
