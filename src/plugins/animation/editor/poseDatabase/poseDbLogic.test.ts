// The pose database tool's edits (ADR 0373; T55), each validated by the source parse's rules. Every accepted result survives the
// document round trip through the engine's own writer and parser (`formatPoseDatabase`, `parsePoseDatabase`) unchanged and
// with no problem; every refusal names the rule and changes nothing.
import { describe, expect, it } from "vitest";
import { refusalOf } from "../../../../editor/sdk";
import { emptyPoseDatabase, formatPoseDatabase, parsePoseDatabase, POSE_DATABASE_LIMITS, type PoseDatabaseSource } from "../../../../engine/animation/poseDatabase";
import {
  addBoneFeature, addClip, addCustomFeature, addRange, featureDimensions, missingBones, parseTagList, removeBoneFeature, removeClip, removeCustomFeature, removeRange, setBoneFeature, setCustomFeature, setMirror, setNormalisation, setRange, setRangeTags, setRate,
  setSkeleton, setTrajectoryTimes, setTrajectoryWeights, tagStats,
} from "./poseDbLogic";

const ok = (r: { next: PoseDatabaseSource } | { refused: string }): PoseDatabaseSource => {
  if ("refused" in r) throw new Error(r.refused);
  // Every accepted database round-trips through the document format with no problem.
  const read = parsePoseDatabase(JSON.parse(formatPoseDatabase(r.next)));
  expect(read.problems).toEqual([]);
  expect(read.value).toEqual(r.next);
  return r.next;
};

/** Two clips: walk with two tagged ranges, idle untagged. */
function sample(): PoseDatabaseSource {
  let db = ok(addClip(emptyPoseDatabase(), "asset:clips/walk.anim.json"));
  db = ok(addClip(db, "asset:clips/idle.anim.json"));
  db = ok(addRange(db, 0, { from: 0, to: 4.5, tags: ["walk"] }));
  db = ok(addRange(db, 0, { from: 4.5, to: 5.2, tags: ["stop", "walk"] }));
  return db;
}

describe("the database", () => {
  it("sets the skeleton, and clears it with an empty reference", () => {
    const db = ok(setSkeleton(emptyPoseDatabase(), " asset:models/hero.glb#Skeleton "));
    expect(db.skeleton).toBe("asset:models/hero.glb#Skeleton");
    expect(ok(setSkeleton(db, "")).skeleton).toBeNull();
  });

  it("sets the rate within the track limits and refuses the rest", () => {
    expect(ok(setRate(emptyPoseDatabase(), 60)).rate).toBe(60);
    expect(refusalOf(setRate(emptyPoseDatabase(), 0))).toMatch(/1 to 240/);
    expect(refusalOf(setRate(emptyPoseDatabase(), 500))).toMatch(/1 to 240/);
    expect(refusalOf(setRate(emptyPoseDatabase(), NaN))).toMatch(/Hz/);
  });

  it("gives back the same object when nothing changes", () => {
    const db = emptyPoseDatabase();
    expect(ok(setRate(db, 30))).toBe(db);
    expect(ok(setNormalisation(db, "feature"))).toBe(db);
  });

  it("sets each normalisation", () => {
    for (const mode of ["feature", "dimension", "none"] as const) expect(ok(setNormalisation(emptyPoseDatabase(), mode)).normalisation).toBe(mode);
    expect(refusalOf(setNormalisation(emptyPoseDatabase(), "sphere" as never))).toMatch(/one of/);
  });
});

describe("clips", () => {
  it("adds a clip with no ranges and refuses a repeat, an empty reference and too many", () => {
    const db = ok(addClip(emptyPoseDatabase(), "asset:clips/walk.anim.json"));
    expect(db.sources).toEqual([{ clip: "asset:clips/walk.anim.json", ranges: [], mirror: false }]);
    expect(refusalOf(addClip(db, "asset:clips/walk.anim.json"))).toMatch(/already in the database/);
    expect(refusalOf(addClip(db, "  "))).toMatch(/needs a reference/);
    const full = { ...db, sources: Array.from({ length: POSE_DATABASE_LIMITS.sources }, (_, i) => ({ clip: `c${i}`, ranges: [], mirror: false })) };
    expect(refusalOf(addClip(full, "more"))).toMatch(/at most 1024/);
  });

  it("removes a clip, and refuses one that isn't there", () => {
    const db = ok(removeClip(sample(), 0));
    expect(db.sources.map((s) => s.clip)).toEqual(["asset:clips/idle.anim.json"]);
    expect(refusalOf(removeClip(db, 3))).toMatch(/no clip 4/);
  });

  it("sets a clip mirrored and back", () => {
    const db = ok(setMirror(sample(), 1, true));
    expect(db.sources[1]!.mirror).toBe(true);
    expect(ok(setMirror(db, 1, false)).sources[1]!.mirror).toBe(false);
    expect(refusalOf(setMirror(db, 9, true))).toMatch(/no clip 10/);
  });
});

describe("ranges and tags", () => {
  it("adds ranges with their tags, in order", () => {
    const db = sample();
    expect(db.sources[0]!.ranges).toEqual([{ from: 0, to: 4.5, tags: ["walk"] }, { from: 4.5, to: 5.2, tags: ["stop", "walk"] }]);
  });

  it("refuses a range that ends before it starts, starts before zero or runs past the duration limit", () => {
    const db = sample();
    expect(refusalOf(addRange(db, 0, { from: 2, to: 1, tags: [] }))).toMatch(/end before it starts/);
    expect(refusalOf(addRange(db, 0, { from: -1, to: 1, tags: [] }))).toMatch(/before the clip does/);
    expect(refusalOf(addRange(db, 0, { from: 0, to: 5000, tags: [] }))).toMatch(/3600/);
    expect(refusalOf(addRange(db, 0, { from: NaN, to: 1, tags: [] }))).toMatch(/start and an end/);
    expect(refusalOf(addRange(db, 5, { from: 0, to: 1, tags: [] }))).toMatch(/no clip 6/);
  });

  it("refuses a range with a tag that isn't a name", () => {
    expect(refusalOf(addRange(sample(), 0, { from: 0, to: 1, tags: ["run fast"] }))).toBeTruthy();
  });

  it("moves a range's ends and removes a range", () => {
    let db = ok(setRange(sample(), 0, 1, 4, 5.5));
    expect(db.sources[0]!.ranges[1]).toMatchObject({ from: 4, to: 5.5 });
    expect(refusalOf(setRange(db, 0, 1, 6, 5))).toMatch(/end before it starts/);
    expect(refusalOf(setRange(db, 0, 7, 0, 1))).toMatch(/no range 8/);
    db = ok(removeRange(db, 0, 0));
    expect(db.sources[0]!.ranges).toHaveLength(1);
    expect(refusalOf(removeRange(db, 0, 4))).toMatch(/no range 5/);
  });

  it("sets a range's tags: repeats dropped, bad names refused", () => {
    const db = ok(setRangeTags(sample(), 0, 0, ["walk", "loop", "walk"]));
    expect(db.sources[0]!.ranges[0]!.tags).toEqual(["walk", "loop"]);
    expect(refusalOf(setRangeTags(db, 0, 0, ["a b"]))).toMatch(/isn't a tag name/);
    expect(refusalOf(setRangeTags(db, 0, 0, Array.from({ length: 33 }, (_, i) => `t${i}`)))).toMatch(/at most 32 tags/);
    expect(ok(setRangeTags(db, 0, 0, [])).sources[0]!.ranges[0]!.tags).toEqual([]);
  });

  it("counts the seconds each tag covers", () => {
    expect(tagStats(sample())).toEqual([
      { tag: "walk", ranges: 2, seconds: 4.5 + 0.7000000000000002 },
      { tag: "stop", ranges: 1, seconds: 0.7000000000000002 },
    ]);
  });

  it("reads tag lists split on commas and spaces", () => {
    expect(parseTagList("walk, stop  loop,walk")).toEqual({ tags: ["walk", "stop", "loop"], bad: [] });
    expect(parseTagList("walk $x")).toEqual({ tags: ["walk"], bad: ["$x"] });
    expect(parseTagList("")).toEqual({ tags: [], bad: [] });
  });
});

describe("the feature schema", () => {
  it("adds and removes bone features, refusing repeats and empty names", () => {
    let db = ok(addBoneFeature(emptyPoseDatabase(), "LeftHand"));
    expect(db.schema.bones.map((b) => b.bone)).toEqual(["LeftFoot", "RightFoot", "Hips", "LeftHand"]);
    expect(refusalOf(addBoneFeature(db, "LeftHand"))).toMatch(/already a feature/);
    expect(refusalOf(addBoneFeature(db, ""))).toMatch(/needs a bone/);
    db = ok(removeBoneFeature(db, "Hips"));
    expect(db.schema.bones.map((b) => b.bone)).toEqual(["LeftFoot", "RightFoot", "LeftHand"]);
    expect(refusalOf(removeBoneFeature(db, "Hips"))).toMatch(/isn't a feature/);
  });

  it("switches a bone's position and velocity and sets its weight, refusing a feature that measures nothing", () => {
    let db = ok(setBoneFeature(emptyPoseDatabase(), "Hips", { velocity: false, weight: 2.5 }));
    expect(db.schema.bones.find((b) => b.bone === "Hips")).toEqual({ bone: "Hips", position: true, velocity: false, weight: 2.5 });
    expect(refusalOf(setBoneFeature(db, "Hips", { position: false }))).toMatch(/position or its velocity/);
    expect(refusalOf(setBoneFeature(db, "Hips", { weight: -1 }))).toMatch(/0 to 1000/);
    expect(refusalOf(setBoneFeature(db, "Nose", { weight: 1 }))).toMatch(/isn't a feature/);
    db = ok(setBoneFeature(db, "Hips", { velocity: true, weight: 1 }));
    expect(db.schema.bones.find((b) => b.bone === "Hips")).toEqual({ bone: "Hips", position: true, velocity: true, weight: 1 });
  });

  it("sets the trajectory sample times sorted, refusing zero, repeats, none and too many", () => {
    const db = ok(setTrajectoryTimes(emptyPoseDatabase(), [1, -0.5, 0.25]));
    expect(db.schema.trajectory.times).toEqual([-0.5, 0.25, 1]);
    expect(refusalOf(setTrajectoryTimes(db, []))).toMatch(/at least one/);
    expect(refusalOf(setTrajectoryTimes(db, [0, 1]))).toMatch(/non-zero/);
    expect(refusalOf(setTrajectoryTimes(db, [11]))).toMatch(/within -10 to 10/);
    expect(refusalOf(setTrajectoryTimes(db, [1, 1]))).toMatch(/distinct/);
    expect(refusalOf(setTrajectoryTimes(db, Array.from({ length: 17 }, (_, i) => i + 1)))).toMatch(/at most 16/);
  });

  it("sets the trajectory weights", () => {
    const db = ok(setTrajectoryWeights(emptyPoseDatabase(), { position: 2, direction: 0.5 }));
    expect(db.schema.trajectory).toMatchObject({ position: 2, direction: 0.5 });
    expect(refusalOf(setTrajectoryWeights(db, { position: -1 }))).toMatch(/0 to 1000/);
  });

  it("adds, changes and removes custom features", () => {
    let db = ok(addCustomFeature(emptyPoseDatabase(), "speed"));
    expect(db.schema.custom).toEqual([{ name: "speed", dims: 1, weight: 1 }]);
    db = ok(setCustomFeature(db, "speed", { dims: 3, weight: 2 }));
    expect(db.schema.custom[0]).toEqual({ name: "speed", dims: 3, weight: 2 });
    expect(refusalOf(addCustomFeature(db, "speed"))).toMatch(/already a custom feature/);
    expect(refusalOf(addCustomFeature(db, "wide", 17))).toMatch(/1 to 16/);
    expect(refusalOf(setCustomFeature(db, "speed", { dims: 0 }))).toMatch(/1 to 16/);
    expect(refusalOf(setCustomFeature(db, "gone", { weight: 1 }))).toMatch(/isn't a custom feature/);
    expect(ok(removeCustomFeature(db, "speed")).schema.custom).toEqual([]);
    expect(refusalOf(removeCustomFeature(db, "speed2"))).toMatch(/isn't a custom feature/);
  });

  it("counts the baked dimensions: 3 per bone position and velocity, 4 per trajectory sample", () => {
    expect(featureDimensions(emptyPoseDatabase())).toBe(3 * 6 + 3 * 4); // three bones with both, three samples
    const db = ok(setBoneFeature(emptyPoseDatabase(), "Hips", { velocity: false }));
    expect(featureDimensions(db)).toBe(3 * 5 + 12);
  });

  it("lists the bone features a skeleton lacks", () => {
    expect(missingBones(emptyPoseDatabase(), ["Hips", "LeftFoot"])).toEqual(["RightFoot"]);
    expect(missingBones(emptyPoseDatabase(), ["Hips", "LeftFoot", "RightFoot"])).toEqual([]);
  });
});
