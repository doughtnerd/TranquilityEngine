// T55 (ADR 0371, 0372, 0373, D124): the pose database tool's bake through the real editor compile module in Node: a source over
// the fixture skeleton and clips bakes to a `myco.posedb@1` file whose header (read by `readPoseDbSummary`, the same reader
// the tool shows) matches what was asked for: the frames of the tagged ranges at the source's rate, the features of its
// schema, the clips listed, the tags with the frames that carry them. The bake runs the way the worker runs it (`bakeWith`
// over the loaded module); the worker's message passing itself needs a browser.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyPoseDatabase, type PoseDatabaseSource } from "../../../../engine/animation/poseDatabase";
import { readClipInfo } from "../../runtime/assetInfo";
import { loadAnimationCompiler } from "../compile/compiler";
import { bakePoseDatabaseSource, type PoseDbBakeEnv } from "./bakeLogic";
import { inThreadBakeRunner } from "./bakeRunner";
import { addBoneFeature, addClip, addRange, removeBoneFeature, setRate, setTrajectoryTimes } from "./poseDbLogic";
import { readPoseDbSummary } from "./summaryLogic";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../runtime/wasm/fixtures/${name}`, import.meta.url)));
const FILES: Record<string, Uint8Array> = { "rigs/small.skel": fixture("small.skel"), "clips/walk.anim": fixture("walk.anim"), "clips/run.anim": fixture("run.anim") };

const ok = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

/** The environment over the fixtures, with the real bake. `written` collects what the bake writes. */
function env(written: Map<string, Uint8Array>): PoseDbBakeEnv {
  return {
    clipSkeleton: async () => null,
    skeleton: async (ref) => FILES[ref.replace(/^asset:/, "")] ?? null,
    clip: async (ref) => {
      const bytes = FILES[ref.replace(/^asset:/, "")];
      return bytes ? { bytes } : { error: `${ref}: the clip can't be read.` };
    },
    run: inThreadBakeRunner,
    writeBytes: async (path, bytes) => void written.set(path, bytes),
  };
}

function source(): PoseDatabaseSource {
  let db = { ...emptyPoseDatabase(), skeleton: "asset:rigs/small.skel" };
  for (const bone of ["LeftFoot", "RightFoot", "Hips"]) db = ok(removeBoneFeature(db, bone));
  for (const bone of ["bone3", "bone7"]) db = ok(addBoneFeature(db, bone));
  db = ok(setTrajectoryTimes(db, [0.25, 0.5]));
  db = ok(addClip(db, "asset:clips/walk.anim"));
  db = ok(addClip(db, "asset:clips/run.anim"));
  return db;
}

describe("the pose database bake", () => {
  it("bakes the tagged ranges of two clips and writes the file beside the source", async () => {
    const walk = readClipInfo(FILES["clips/walk.anim"]!)!;
    const run = readClipInfo(FILES["clips/run.anim"]!)!;
    let db = source();
    db = ok(addRange(db, 0, { from: 0, to: walk.duration / 2, tags: ["walk"] }));
    db = ok(addRange(db, 0, { from: walk.duration / 2, to: walk.duration, tags: ["walk", "late"] }));
    db = ok(addRange(db, 1, { from: 0, to: run.duration, tags: ["run"] }));
    const written = new Map<string, Uint8Array>();
    const stages: string[] = [];
    const out = await bakePoseDatabaseSource(env(written), "animation/loco.posedb.json", db, (p) => stages.push(p.stage));
    if (!out.ok) throw new Error(out.error);
    expect(out.path).toBe("animation/loco.posedb.bin");
    expect([...written.keys()]).toEqual(["animation/loco.posedb.bin"]);
    expect([...new Set(stages)]).toEqual(["skeleton", "clips", "bake", "write"]);
    expect(out.warnings).toEqual([]);

    const summary = readPoseDbSummary(written.get(out.path)!)!;
    expect(summary).toEqual(out.summary);
    expect(summary.size).toBe(written.get(out.path)!.byteLength);
    expect(summary.rate).toBe(30);
    expect(summary.skeleton).toBe("asset:rigs/small.skel");
    // 2 bones with position and velocity (3 + 3 each) and 2 trajectory samples with position and direction (2 + 2 each).
    expect(summary.dims).toBe(2 * 6 + 2 * 4);
    expect(summary.features).toEqual([{ kind: "bone position", count: 2 }, { kind: "bone velocity", count: 2 }, { kind: "trajectory position", count: 2 }, { kind: "trajectory direction", count: 2 }]);
    expect(summary.clips.map((c) => c.asset)).toEqual(["asset:clips/walk.anim", "asset:clips/run.anim"]);
    expect(summary.frames).toBe(summary.clips[0]!.frames + summary.clips[1]!.frames);
    // About one frame per 1/30 s of each clip (a range's ends are inclusive, so one more at most).
    expect(summary.clips[0]!.frames).toBeGreaterThanOrEqual(Math.floor(walk.duration * 30));
    expect(summary.clips[0]!.frames).toBeLessThanOrEqual(Math.ceil(walk.duration * 30) + 2);
    expect(summary.clips[1]!.frames).toBeGreaterThanOrEqual(Math.floor(run.duration * 30));
    expect(Object.fromEntries(summary.tags.map((t) => [t.name, t.frames > 0]))).toEqual({ walk: true, late: true, run: true });
    const tag = (n: string) => summary.tags.find((t) => t.name === n)!.frames;
    expect(tag("walk")).toBe(summary.clips[0]!.frames); // both walk ranges carry it
    expect(tag("late")).toBeLessThan(tag("walk"));
    expect(tag("run")).toBe(summary.clips[1]!.frames);
  });

  it("bakes at the source's rate", async () => {
    const written = new Map<string, Uint8Array>();
    const db = ok(setRate(source(), 15));
    const out = await bakePoseDatabaseSource(env(written), "loco.posedb.json", db);
    if (!out.ok) throw new Error(out.error);
    expect(out.summary!.rate).toBe(15);
    const walk = readClipInfo(FILES["clips/walk.anim"]!)!;
    expect(out.summary!.clips[0]!.frames).toBeLessThanOrEqual(Math.ceil(walk.duration * 15) + 2);
  });

  it("reports a bone the skeleton lacks, without writing", async () => {
    const written = new Map<string, Uint8Array>();
    const db = ok(addBoneFeature(source(), "Tail"));
    const out = await bakePoseDatabaseSource(env(written), "loco.posedb.json", db);
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/no bone "Tail"/) });
    expect(written.size).toBe(0);
  });

  it("loads the same module the worker loads", async () => {
    const compiler = await loadAnimationCompiler();
    expect(compiler.bakePoseDatabase).toBeTypeOf("function");
  });
});
