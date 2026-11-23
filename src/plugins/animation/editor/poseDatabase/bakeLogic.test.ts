// The pose database bake's inputs and run (ADR 0373; T55), with a fake bake in place of the editor module: what `posedb_bake` is
// given for a source (features in schema order with their bone indices, weights and time offsets; ranges clamped into the
// clip; the settings record; the warnings for what the bake can't do), where the file is written, the progress stages, and
// every failure as a message. The real module's result is `bake.node.test.ts`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyPoseDatabase, type PoseDatabaseSource } from "../../../../engine/animation/poseDatabase";
import { readClipInfo, readSkeletonInfo } from "../../runtime/assetInfo";
import { FEATURE_KIND, bakePoseDatabaseSource, bakeSettingsValues, buildBakeJob, progressFraction, type BakeProgress, type PoseDbBakeEnv, type PoseDbBakeJob } from "./bakeLogic";
import { addBoneFeature, addClip, addCustomFeature, addRange, removeBoneFeature, setBoneFeature, setMirror, setNormalisation, setRate, setSkeleton, setTrajectoryTimes, setTrajectoryWeights } from "./poseDbLogic";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../runtime/wasm/fixtures/${name}`, import.meta.url)));
const SKELETON = fixture("small.skel");
const WALK = fixture("walk.anim");
const WALK_SECONDS = readClipInfo(WALK)!.duration;
const BONES = readSkeletonInfo(SKELETON)!;

const ok = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

/** A source over the fixture skeleton: bones bone2 (both) and bone5 (position only, weight 2), trajectory at 0.25 and 0.5 s. */
function source(): PoseDatabaseSource {
  let db = ok(setSkeleton(emptyPoseDatabase(), "asset:rigs/small.skel"));
  for (const bone of ["LeftFoot", "RightFoot", "Hips"]) db = ok(removeBoneFeature(db, bone));
  db = ok(addBoneFeature(db, "bone2"));
  db = ok(addBoneFeature(db, "bone5"));
  db = ok(setBoneFeature(db, "bone5", { velocity: false, weight: 2 }));
  db = ok(setTrajectoryTimes(db, [0.25, 0.5]));
  db = ok(setTrajectoryWeights(db, { position: 3, direction: 0.5 }));
  return ok(addClip(db, "asset:clips/walk.anim"));
}

/** A fake bake environment: records the job and what is written, answers with the bytes given. */
function fake(options: { bake?: Uint8Array; fail?: string } = {}) {
  const seen = { jobs: [] as PoseDbBakeJob[], written: new Map<string, Uint8Array>(), clipRequests: [] as [string, string | null][], skeletonRequests: [] as string[] };
  const env: PoseDbBakeEnv = {
    clipSkeleton: async () => "asset:rigs/small.skel",
    skeleton: async (ref) => {
      seen.skeletonRequests.push(ref);
      return ref === "asset:rigs/small.skel" ? SKELETON : null;
    },
    clip: async (ref, skeletonRef) => {
      seen.clipRequests.push([ref, skeletonRef]);
      return ref === "asset:clips/walk.anim" ? { bytes: WALK } : { error: `${ref}: the clip can't be read.` };
    },
    run: async (job) => {
      seen.jobs.push(job);
      return options.fail ? { ok: false, error: options.fail } : { ok: true, bytes: options.bake ?? new Uint8Array([1, 2, 3]) };
    },
    writeBytes: async (path, bytes) => void seen.written.set(path, bytes),
  };
  return { env, seen };
}

const built = (db: PoseDatabaseSource, clips = [{ ref: "asset:clips/walk.anim", bytes: WALK }]) => {
  const out = buildBakeJob(db, SKELETON, db.skeleton, clips);
  if ("error" in out) throw new Error(out.error);
  return out;
};

describe("buildBakeJob", () => {
  it("lists the features in schema order with the skeleton's bone indices, weights and time offsets", () => {
    const { job } = built(source());
    expect(job.schema).toEqual([
      { kind: FEATURE_KIND.bonePosition, bone: BONES.indexOf("bone2"), weight: 1, timeOffset: 0 },
      { kind: FEATURE_KIND.boneVelocity, bone: BONES.indexOf("bone2"), weight: 1, timeOffset: 0 },
      { kind: FEATURE_KIND.bonePosition, bone: BONES.indexOf("bone5"), weight: 2, timeOffset: 0 },
      { kind: FEATURE_KIND.trajectoryPosition, bone: -1, weight: 3, timeOffset: 0.25 },
      { kind: FEATURE_KIND.trajectoryDirection, bone: -1, weight: 0.5, timeOffset: 0.25 },
      { kind: FEATURE_KIND.trajectoryPosition, bone: -1, weight: 3, timeOffset: 0.5 },
      { kind: FEATURE_KIND.trajectoryDirection, bone: -1, weight: 0.5, timeOffset: 0.5 },
    ]);
    expect(BONES.indexOf("bone2")).toBeGreaterThanOrEqual(0);
  });

  it("hands over the clip's bytes and asset reference with its ranges and tags, and the skeleton's name", () => {
    let db = ok(addRange(source(), 0, { from: 0.1, to: 0.4, tags: ["walk", "start"] }));
    db = ok(addRange(db, 0, { from: 0.4, to: 0.8, tags: [] }));
    const { job, warnings } = built(db);
    expect(warnings).toEqual([]);
    expect(job.skeleton).toBe(SKELETON);
    expect(job.settings.skeletonName).toBe("asset:rigs/small.skel");
    expect(job.clips).toEqual([{ bytes: WALK, asset: "asset:clips/walk.anim", ranges: [{ start: 0.1, end: 0.4, tags: ["walk", "start"] }, { start: 0.4, end: 0.8, tags: [] }] }]);
  });

  it("gives a clip with no ranges no ranges (the bake takes the whole clip)", () => {
    expect(built(source()).job.clips[0]!.ranges).toEqual([]);
  });

  it("clamps a range that runs past the clip's end, and leaves out one that starts after it, with a warning each", () => {
    let db = ok(addRange(source(), 0, { from: 0, to: WALK_SECONDS + 5, tags: ["a"] }));
    db = ok(addRange(db, 0, { from: WALK_SECONDS + 1, to: WALK_SECONDS + 2, tags: ["b"] }));
    const { job, warnings } = built(db);
    expect(job.clips[0]!.ranges).toEqual([{ start: 0, end: WALK_SECONDS, tags: ["a"] }]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/runs past the clip's end/);
    expect(warnings[1]).toMatch(/starts after the clip ends/);
  });

  it("leaves a clip out whose ranges all fall away, rather than baking it whole", () => {
    const db = ok(addRange(source(), 0, { from: WALK_SECONDS + 1, to: WALK_SECONDS + 2, tags: [] }));
    const out = buildBakeJob(db, SKELETON, db.skeleton, [{ ref: "asset:clips/walk.anim", bytes: WALK }]);
    expect(out).toEqual({ error: "none of the clips has a range left to bake." });
  });

  it("refuses a schema bone the skeleton lacks, naming it", () => {
    const db = ok(addBoneFeature(source(), "Tail"));
    expect(buildBakeJob(db, SKELETON, db.skeleton, [{ ref: "asset:clips/walk.anim", bytes: WALK }])).toEqual({ error: expect.stringContaining('no bone "Tail"') });
  });

  it("refuses a skeleton file that isn't one", () => {
    expect(buildBakeJob(source(), new Uint8Array(4), null, [{ ref: "asset:clips/walk.anim", bytes: WALK }])).toEqual({ error: "the skeleton file can't be read." });
  });

  it("warns for what the bake can't do: mirrored copies, custom features, normalisation none", () => {
    let db = ok(setMirror(source(), 0, true));
    db = ok(addCustomFeature(db, "speed"));
    db = ok(setNormalisation(db, "none"));
    const { warnings, job } = built(db);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toMatch(/custom features \(speed\)/);
    expect(warnings.join("\n")).toMatch(/normalisation none/);
    expect(warnings.join("\n")).toMatch(/mirrored copies/);
    expect(job.schema.some((f) => f.kind === 4)).toBe(false); // no custom feature reaches the bake
  });

  it("writes the settings record: rate, deviation floor, normalisation, KD-tree, leaf size", () => {
    const db = source();
    expect(bakeSettingsValues(db)).toEqual([30, 0.01, 1, 1, 16]);
    expect(bakeSettingsValues(ok(setNormalisation(ok(setRate(db, 60)), "dimension")))).toEqual([60, 0.01, 0, 1, 16]);
    expect(bakeSettingsValues(ok(setNormalisation(db, "none")))).toEqual([30, 1, 0, 1, 16]);
  });
});

describe("bakePoseDatabaseSource", () => {
  it("bakes and writes the file beside the source, reporting each stage in order", async () => {
    const { env, seen } = fake();
    const progress: BakeProgress[] = [];
    const out = await bakePoseDatabaseSource(env, "animation/loco.posedb.json", source(), (p) => progress.push(p));
    expect(out).toMatchObject({ ok: true, path: "animation/loco.posedb.bin", warnings: [] });
    expect([...seen.written.keys()]).toEqual(["animation/loco.posedb.bin"]);
    expect(seen.written.get("animation/loco.posedb.bin")).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen.jobs).toHaveLength(1);
    expect(seen.clipRequests).toEqual([["asset:clips/walk.anim", "asset:rigs/small.skel"]]);
    expect(progress.map((p) => p.stage)).toEqual(["skeleton", "clips", "bake", "write", "write"]);
    const fractions = progress.map(progressFraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions[0]).toBe(0);
    expect(fractions.at(-1)).toBe(1);
  });

  it("uses the clips' skeleton when the source names none", async () => {
    const { env, seen } = fake();
    const db = ok(setSkeleton(source(), null));
    const out = await bakePoseDatabaseSource(env, "loco.posedb.json", db);
    expect(out.ok).toBe(true);
    expect(seen.skeletonRequests).toEqual(["asset:rigs/small.skel"]);
    expect(seen.jobs[0]!.settings.skeletonName).toBe("asset:rigs/small.skel");
  });

  it("reports each way it can fail, writes nothing, and never throws", async () => {
    const noClips = ok(setSkeleton(emptyPoseDatabase(), "asset:rigs/small.skel"));
    expect(await bakePoseDatabaseSource(fake().env, "a.posedb.json", noClips)).toEqual({ ok: false, error: expect.stringMatching(/no clips/) });

    const noSkeleton = fake();
    noSkeleton.env.clipSkeleton = async () => null;
    expect(await bakePoseDatabaseSource(noSkeleton.env, "a.posedb.json", ok(setSkeleton(source(), null)))).toEqual({ ok: false, error: expect.stringMatching(/no skeleton/) });

    expect(await bakePoseDatabaseSource(fake().env, "a.posedb.json", ok(setSkeleton(source(), "asset:rigs/gone.skel")))).toEqual({ ok: false, error: 'the skeleton "asset:rigs/gone.skel" can\'t be read.' });

    const missingClip = ok(addClip(source(), "asset:clips/gone.anim"));
    const clipFail = fake();
    expect(await bakePoseDatabaseSource(clipFail.env, "a.posedb.json", missingClip)).toEqual({ ok: false, error: "asset:clips/gone.anim: the clip can't be read." });
    expect(clipFail.seen.jobs).toHaveLength(0);

    const bakeFail = fake({ fail: "feature 3 is out of range" });
    expect(await bakePoseDatabaseSource(bakeFail.env, "a.posedb.json", source())).toEqual({ ok: false, error: "the bake failed: feature 3 is out of range" });
    expect(bakeFail.seen.written.size).toBe(0);

    const throwing = fake();
    throwing.env.writeBytes = async () => {
      throw new Error("disk full");
    };
    expect(await bakePoseDatabaseSource(throwing.env, "a.posedb.json", source())).toEqual({ ok: false, error: "disk full" });
  });

  it("returns the buildBakeJob warnings with a successful bake", async () => {
    const out = await bakePoseDatabaseSource(fake().env, "loco.posedb.json", ok(setMirror(source(), 0, true)));
    expect(out).toMatchObject({ ok: true, warnings: [expect.stringMatching(/mirrored copies/)] });
  });
});
