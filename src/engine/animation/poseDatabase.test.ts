// Pose database sources (`myco.posedb-source@1`, ADR 0372 "Motion matching") through their parse and write.
import { describe, expect, it } from "vitest";
import { defaultPoseSchema, emptyPoseDatabase, formatPoseDatabase, parsePoseDatabase, POSE_DATABASE_LIMITS, poseDatabaseReferences, poseDatabaseToJson, type PoseDatabaseSource } from "./poseDatabase";

const db = (): PoseDatabaseSource => ({
  format: "myco.posedb-source@1",
  skeleton: "asset:models/hero.glb#Skeleton",
  rate: 60,
  sources: [
    { clip: "asset:mocap/walk.anim.json", ranges: [{ from: 0, to: 4.5, tags: ["walk"] }, { from: 4.5, to: 5.2, tags: ["stop", "walk"] }], mirror: true },
    { clip: "asset:models/hero.glb#Anim/Idle", ranges: [], mirror: false },
  ],
  schema: {
    bones: [{ bone: "LeftFoot", position: true, velocity: false, weight: 2 }, { bone: "Hips", position: false, velocity: true, weight: 1 }],
    trajectory: { times: [-0.33, 0.33, 0.66], position: 1.5, direction: 1 },
    custom: [{ name: "speed", dims: 1, weight: 0.5 }],
  },
  normalisation: "dimension",
});

describe("pose database sources (myco.posedb-source@1)", () => {
  it("round-trip", () => {
    expect(parsePoseDatabase(JSON.parse(formatPoseDatabase(db())))).toEqual({ value: db(), problems: [] });
  });

  it("write only what differs from the defaults (the default schema is left out)", () => {
    expect(poseDatabaseToJson(emptyPoseDatabase())).toEqual({ format: "myco.posedb-source@1", sources: [] });
    expect(parsePoseDatabase(poseDatabaseToJson(emptyPoseDatabase()))).toEqual({ value: emptyPoseDatabase(), problems: [] });
    expect(emptyPoseDatabase().schema).toEqual(defaultPoseSchema());
    const noBones = { ...emptyPoseDatabase(), schema: { ...defaultPoseSchema(), bones: [] } };
    expect(parsePoseDatabase(poseDatabaseToJson(noBones)).value).toEqual(noBones);
  });

  const one = (extra: Record<string, unknown>) => parsePoseDatabase({ format: "myco.posedb-source@1", ...extra });

  it.each<[string, Record<string, unknown>, string]>([
    ["a source without a clip", { sources: [{}] }, "sources[0].clip: a source must name a clip; dropped."],
    ["a range backwards", { sources: [{ clip: "a.anim.json", ranges: [{ from: 2, to: 1 }] }] }, "sources[0].ranges[0]: from was after to; swapped."],
    ["a bad tag", { sources: [{ clip: "a.anim.json", ranges: [{ from: 0, to: 1, tags: ["has space"] }] }] }, "sources[0].ranges[0].tags[0]: a tag is a name of letters, digits, _ . -; dropped."],
    ["an unknown normalisation", { normalisation: "zscore" }, 'normalisation: must be one of feature, dimension, none; using "feature".'],
    ["a bone feature without a bone", { schema: { bones: [{}] } }, "schema.bones[0]: a bone feature must name a bone; dropped."],
    ["trajectory times out of order", { schema: { trajectory: { times: [0.5, 0.25] } } }, "schema.trajectory.times: sample times must be distinct and ascending; sorted."],
    ["a zero trajectory time", { schema: { trajectory: { times: [0, 0.5] } } }, "schema.trajectory.times: each sample time must be a non-zero number of seconds in -10..10; the others are dropped."],
    ["custom dims out of range", { schema: { custom: [{ name: "x", dims: 99 }] } }, "schema.custom[0].dims: 99 is outside 1..16; using 16."],
    ["rate out of range", { rate: 0 }, "rate: 0 is outside 1..240; using 1."],
  ])("fall back on a bad value: %s", (_label, extra, problem) => {
    expect(one(extra).problems).toEqual([problem]);
  });

  it("hold the source and tag limits", () => {
    const sources = Array.from({ length: POSE_DATABASE_LIMITS.sources + 1 }, () => ({ clip: "a.anim.json" }));
    const many = one({ sources });
    expect(many.value.sources).toHaveLength(POSE_DATABASE_LIMITS.sources);
    expect(many.problems).toEqual([`sources: at most ${POSE_DATABASE_LIMITS.sources} sources; the rest are dropped.`]);
    const tags = Array.from({ length: POSE_DATABASE_LIMITS.tags + 1 }, (_, i) => ({ from: 0, to: 1, tags: [`t${i}`] }));
    const tagged = one({ sources: [{ clip: "a.anim.json", ranges: tags.slice(0, 200) }, { clip: "b.anim.json", ranges: tags.slice(200) }] });
    expect(new Set(tagged.value.sources.flatMap((s) => s.ranges.flatMap((r) => r.tags))).size).toBe(POSE_DATABASE_LIMITS.tags);
    expect(tagged.problems).toEqual([`sources[1].ranges[56].tags[0]: at most ${POSE_DATABASE_LIMITS.tags} tags in a database; dropped.`]);
  });

  it("name their skeleton's file and their clips", () => {
    expect(poseDatabaseReferences(db())).toEqual(["models/hero.glb", "mocap/walk.anim.json"]);
  });
});
