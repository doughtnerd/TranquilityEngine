// The pose database bake (ADR 0371 "Assets", 0372 "Motion matching", 0373 "Pose database tool", D124; T55).
//
// "Bake" turns a `*.posedb.json` source into the `*.posedb.bin` beside it (`bakedPathOf`) with the editor module's
// `posedb_bake` (T19's `compiler.ts`, `bakePoseDatabase`): the source's clips (each compiled as an export compiles it,
// bound to the database's skeleton), the tagged ranges, the feature schema and the bake's settings. `buildBakeJob` is the
// pure step from a source and what was read of the project to the module's inputs; `bakePoseDatabaseSource` is the whole
// run over a `PoseDbBakeEnv` (so the tests give it fakes and the view wires the real project, `poseDbEnv.ts`), with
// progress by stage and every failure as a message, never a throw.
//
// T70: `mirror: true` bakes a mirrored copy of the clip too, through the skeleton's mirror table (its profile's mirror
// roles, `PoseDbBakeEnv.mirrorTable`), as a clip entry the runtime plays mirrored. Custom features are filled from each
// clip's curve track of the feature's name (its first 1–4 components; a clip without the curve reads 0), the bake hook
// the editor has.
//
// What the source has that the bake cannot do (each is one warning on the result, not an error):
// - a custom feature of more than 4 dims (a curve has at most 4 components): left out;
// - `normalisation: "none"`: the bake has the two standard-deviation modes only; "none" bakes per dimension with a
//   deviation floor of 1, which leaves features measured in metres (deviation below 1) unscaled.
import type { PoseDatabaseSource } from "../../../../engine/animation/poseDatabase";
import type { AnimationCompiler, PoseDbClipInput, PoseDbCustomInput, PoseDbFeatureInput } from "../compile/compiler";
import { readClipInfo, readSkeletonInfo } from "../../runtime/assetInfo";
import { readPoseDbSummary, type PoseDbSummary } from "./summaryLogic";
import { bakedPathOf } from "./poseDbLogic";

/** The `FeatureKind` ids `posedb_bake`'s schema record takes (`anim-format`'s `FeatureKind`). */
export const FEATURE_KIND = { bonePosition: 0, boneVelocity: 1, trajectoryPosition: 2, trajectoryDirection: 3 } as const;

/** What `posedb_bake` runs on: plain data, so it can go to a worker. */
export interface PoseDbBakeJob {
  readonly skeleton: Uint8Array;
  readonly clips: readonly PoseDbClipInput[];
  readonly schema: readonly PoseDbFeatureInput[];
  readonly settings: {
    readonly skeletonName?: string;
    readonly values: readonly number[];
    /** T70: the mirror table mirrored clips bake through (axis, then a word per bone); absent with no mirrored clip. */
    readonly mirror?: Uint32Array;
    /** T70: custom features, filled from the clips' curves of their names. */
    readonly custom?: readonly PoseDbCustomInput[];
  };
}

/** A bake's outcome. */
export type PoseDbBakeResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: string };

/** Runs one bake. */
export type PoseDbBakeRunner = (job: PoseDbBakeJob) => Promise<PoseDbBakeResult>;

/** The bake over a loaded compile module (the worker's and this thread's). */
export function bakeWith(compiler: AnimationCompiler, job: PoseDbBakeJob): PoseDbBakeResult {
  const out = compiler.bakePoseDatabase(job.skeleton, job.clips, job.schema, job.settings);
  return "bytes" in out ? { ok: true, bytes: out.bytes } : { ok: false, error: out.error };
}

/** A clip as the bake reads it: its reference as the source writes it, and its compiled bytes. */
export interface BakeClip {
  readonly ref: string;
  readonly bytes: Uint8Array;
}

/** The most dims a custom feature bakes with (a curve's components). */
export const CUSTOM_BAKE_DIMS = 4;

/** The deviation floor the bake uses (its default), and the one that stands for `"none"`. */
const STD_FLOOR = 0.01;
const STD_FLOOR_NONE = 1;
const KD_LEAF_SIZE = 16;

/** The settings record `posedb_bake` takes: sample rate, deviation floor, normalisation (0 per dimension, 1 per feature), KD-tree, leaf size. */
export function bakeSettingsValues(db: PoseDatabaseSource): number[] {
  return [db.rate, db.normalisation === "none" ? STD_FLOOR_NONE : STD_FLOOR, db.normalisation === "feature" ? 1 : 0, 1, KD_LEAF_SIZE];
}

/**
 * The bake's inputs for `db`: features by schema order (each bone's position then velocity, then each trajectory sample's
 * position and direction), ranges clamped into each clip's duration, and the warnings above. Returns why not when the
 * schema names a bone the skeleton lacks, a clip can't be read, no frame would be baked, or a clip is mirrored without a
 * `mirror` table.
 */
export function buildBakeJob(
  db: PoseDatabaseSource,
  skeleton: Uint8Array,
  skeletonRef: string | null,
  clips: readonly BakeClip[],
  mirror: Uint32Array | null = null,
): { readonly job: PoseDbBakeJob; readonly warnings: string[] } | { readonly error: string } {
  const info = readSkeletonInfo(skeleton);
  if (!info) return { error: "the skeleton file can't be read." };
  const warnings: string[] = [];
  const schema: PoseDbFeatureInput[] = [];
  const missing: string[] = [];
  for (const b of db.schema.bones) {
    const bone = info.indexOf(b.bone);
    if (bone < 0) {
      missing.push(b.bone);
      continue;
    }
    if (b.position) schema.push({ kind: FEATURE_KIND.bonePosition, bone, weight: b.weight, timeOffset: 0 });
    if (b.velocity) schema.push({ kind: FEATURE_KIND.boneVelocity, bone, weight: b.weight, timeOffset: 0 });
  }
  if (missing.length) return { error: `the skeleton has no bone ${missing.map((m) => `"${m}"`).join(", ")}: the schema's bone features name bones of it.` };
  const t = db.schema.trajectory;
  for (const time of t.times) {
    schema.push({ kind: FEATURE_KIND.trajectoryPosition, bone: -1, weight: t.position, timeOffset: time });
    schema.push({ kind: FEATURE_KIND.trajectoryDirection, bone: -1, weight: t.direction, timeOffset: time });
  }
  if (schema.length === 0) return { error: "the schema has no features." };
  const custom: PoseDbCustomInput[] = [];
  for (const c of db.schema.custom) {
    if (c.dims > CUSTOM_BAKE_DIMS) warnings.push(`the custom feature "${c.name}" has ${c.dims} dims: the bake fills custom features from a curve, which has at most ${CUSTOM_BAKE_DIMS} components; it is left out.`);
    else custom.push({ name: c.name, dims: c.dims, weight: c.weight });
  }
  if (db.normalisation === "none") warnings.push("normalisation none: the bake scales by deviation only, so it baked per dimension with a deviation floor of 1, which leaves features in metres unscaled.");
  const mirrors = db.sources.some((s) => s.mirror);
  if (mirrors && !mirror) return { error: "a clip is mirrored, but the skeleton has no mirror table." };

  const inputs: PoseDbClipInput[] = [];
  let ranges = 0;
  db.sources.forEach((s, i) => {
    const clip = clips[i]!;
    const duration = readClipInfo(clip.bytes)?.duration ?? Infinity;
    const kept: { start: number; end: number; tags: readonly string[] }[] = [];
    for (const g of s.ranges) {
      if (g.from > duration) {
        warnings.push(`${s.clip}: the range ${g.from}–${g.to} s starts after the clip ends (${duration.toFixed(2)} s); left out.`);
        continue;
      }
      if (g.to > duration) warnings.push(`${s.clip}: the range ${g.from}–${g.to} s runs past the clip's end (${duration.toFixed(2)} s); it ends there.`);
      kept.push({ start: g.from, end: Math.min(g.to, duration), tags: g.tags });
    }
    // A source with ranges that all fell away would bake as the whole clip: leave the clip out instead.
    if (s.ranges.length > 0 && kept.length === 0) return;
    ranges += kept.length;
    inputs.push({ bytes: clip.bytes, asset: clip.ref, ranges: kept, mirror: s.mirror || undefined });
  });
  if (inputs.length === 0) return { error: db.sources.length === 0 ? "the database has no clips: add some first." : "none of the clips has a range left to bake." };
  return {
    job: {
      skeleton,
      clips: inputs,
      schema,
      settings: { skeletonName: skeletonRef ?? undefined, values: bakeSettingsValues(db), mirror: mirrors && mirror ? mirror : undefined, custom: custom.length ? custom : undefined },
    },
    warnings,
  };
}

/** Where the bake is: a stage, and how far through it (clips read of those to read; the bake and the write have one step each). */
export interface BakeProgress {
  readonly stage: "skeleton" | "clips" | "bake" | "write";
  readonly done: number;
  readonly total: number;
  readonly label: string;
}

/** What the bake reads and writes of the project and the editor (the view wires the real one, `poseDbEnv.ts`). */
export interface PoseDbBakeEnv {
  /** The skeleton a clip binds when the source names none (the model clip's own), or null. */
  clipSkeleton(clip: string): Promise<string | null>;
  /** The `myco.skel@1` bytes of a skeleton reference, or null when it can't be read. */
  skeleton(ref: string): Promise<Uint8Array | null>;
  /** The clip compiled for `skeletonRef`, or why not. */
  clip(ref: string, skeletonRef: string | null): Promise<{ readonly bytes: Uint8Array } | { readonly error: string }>;
  /**
   * T70: the mirror table of a skeleton (its mirror axis, then the graph `MIRROR` node's word per bone, from its profile's
   * mirror roles), or why not. Asked only when a clip is mirrored.
   */
  mirrorTable(skeletonRef: string, skeleton: Uint8Array): Promise<Uint32Array | { readonly error: string }>;
  /** Runs `posedb_bake` (the bake worker, or this thread where there are none). */
  run: PoseDbBakeRunner;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
}

export type PoseDbBakeOutcome = { readonly ok: true; readonly path: string; readonly summary: PoseDbSummary | null; readonly warnings: readonly string[] } | { readonly ok: false; readonly error: string };

/** Bake the source at `sourcePath` and write `x.posedb.bin` beside it (see the file comment). Never rejects. */
export async function bakePoseDatabaseSource(env: PoseDbBakeEnv, sourcePath: string, db: PoseDatabaseSource, onProgress: (p: BakeProgress) => void = () => {}): Promise<PoseDbBakeOutcome> {
  try {
    if (db.sources.length === 0) return { ok: false, error: "the database has no clips: add some first." };
    onProgress({ stage: "skeleton", done: 0, total: 1, label: "Reading the skeleton" });
    const skeletonRef = db.skeleton ?? (await env.clipSkeleton(db.sources[0]!.clip));
    if (!skeletonRef) return { ok: false, error: "no skeleton: name the skeleton the features are measured on (the clips' model gave none)." };
    const skeleton = await env.skeleton(skeletonRef);
    if (!skeleton) return { ok: false, error: `the skeleton "${skeletonRef}" can't be read.` };
    const clips: BakeClip[] = [];
    for (const [i, s] of db.sources.entries()) {
      onProgress({ stage: "clips", done: i, total: db.sources.length, label: `Preparing ${s.clip}` });
      const read = await env.clip(s.clip, skeletonRef);
      if ("error" in read) return { ok: false, error: read.error };
      clips.push({ ref: s.clip, bytes: read.bytes });
    }
    let mirror: Uint32Array | null = null;
    if (db.sources.some((s) => s.mirror)) {
      const table = await env.mirrorTable(skeletonRef, skeleton);
      if (!(table instanceof Uint32Array)) return { ok: false, error: `mirrored clips can't be baked: ${table.error}` };
      mirror = table;
    }
    const built = buildBakeJob(db, skeleton, skeletonRef, clips, mirror);
    if ("error" in built) return { ok: false, error: built.error };
    onProgress({ stage: "bake", done: 0, total: 1, label: "Baking the frames" });
    const out = await env.run(built.job);
    if (!out.ok) return { ok: false, error: `the bake failed: ${out.error}` };
    const path = bakedPathOf(sourcePath);
    onProgress({ stage: "write", done: 0, total: 1, label: `Writing ${path}` });
    await env.writeBytes(path, out.bytes);
    onProgress({ stage: "write", done: 1, total: 1, label: "Done" });
    return { ok: true, path, summary: readPoseDbSummary(out.bytes), warnings: built.warnings };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A progress as a fraction 0..1 over the four stages (skeleton 5 %, clips 55 %, bake 35 %, write 5 %). */
export function progressFraction(p: BakeProgress): number {
  const share = p.total > 0 ? p.done / p.total : 0;
  switch (p.stage) {
    case "skeleton": return 0.05 * share;
    case "clips": return 0.05 + 0.55 * share;
    case "bake": return 0.6 + 0.35 * share;
    case "write": return 0.95 + 0.05 * share;
  }
}
