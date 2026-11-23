/**
 * Pose database sources (ADR 0371 "Assets", 0372 "Motion matching"): parse and write `*.posedb.json`, format
 * `myco.posedb-source@1`. The bake (T42/T55) turns one into `*.posedb.bin` (`myco.posedb@1`): features of every frame of
 * the tagged clip ranges, normalised.
 *
 * ```jsonc
 * {
 *   "format": "myco.posedb-source@1",
 *   "skeleton": "asset:models/hero.glb#Skeleton",       // the skeleton the features are measured on (default none: the clips')
 *   "rate": 30,                                          // Hz, frames baked per second (default 30, 1..240)
 *   "sources": [
 *     { "clip": "asset:mocap/walk.anim.json",
 *       "ranges": [{ "from": 0, "to": 4.5, "tags": ["walk"] }, { "from": 4.5, "to": 5.2, "tags": ["stop"] }],   // seconds; default: the whole clip, untagged
 *       "mirror": true }                                 // bake a mirrored copy too (default false)
 *   ],
 *   "schema": {                                          // the feature schema (default below)
 *     "bones": [{ "bone": "LeftFoot", "position": true, "velocity": true, "weight": 1 }],   // position/velocity default true, weight 1
 *     "trajectory": { "times": [0.33, 0.66, 1.0], "position": 1, "direction": 1 },         // sample times (s; past < 0) and weights
 *     "custom": [{ "name": "speed", "dims": 1, "weight": 1 }]                               // features a bake hook fills
 *   },
 *   "normalisation": "feature"                           // "feature" (one deviation per feature, default), "dimension", "none"
 * }
 * ```
 *
 * - Tags are names (`[A-Za-z0-9_.-]+`); ranges have `0 ≤ from ≤ to`; a range's `to` past the clip's end is clamped by the
 *   bake (the source doesn't know the clip's length).
 * - The default schema is the common locomotion one: feet and hips positions and velocities, three future trajectory
 *   samples (Holden et al.).
 * - Limits (`POSE_DATABASE_LIMITS`), declared once.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import { TRACK_LIMITS } from "./tracks";
import { compact, isRecord, jsonText, LenientReader, limited, readRef, readRoot, referencePaths, withPath, type FormatParse, type JsonRecord } from "./shared";

/** @internal The format name. */
export const POSE_DATABASE_FORMAT = "myco.posedb-source@1";
/** @internal The file ending. */
export const POSE_DATABASE_SUFFIX = ".posedb.json";

/** @internal Limits of a pose database source, declared once (ADR 0306). */
export const POSE_DATABASE_LIMITS = Object.freeze({
  sources: 1024,
  rangesPerSource: 256,
  tagsPerRange: 32,
  /** Distinct tags over the database. */
  tags: 256,
  boneFeatures: 64,
  trajectorySamples: 16,
  customFeatures: 32,
  /** Dims of one custom feature. */
  customDims: 16,
});

/** @internal Normalisation modes. */
export const NORMALISATIONS = ["feature", "dimension", "none"] as const;
export type Normalisation = (typeof NORMALISATIONS)[number];

const TAG = /^[A-Za-z0-9_.-]+$/;

export interface PoseRange {
  readonly from: number;
  readonly to: number;
  readonly tags: readonly string[];
}
export interface PoseSource {
  readonly clip: string;
  /** Empty: the whole clip, untagged. */
  readonly ranges: readonly PoseRange[];
  readonly mirror: boolean;
}
export interface BoneFeature {
  readonly bone: string;
  readonly position: boolean;
  readonly velocity: boolean;
  readonly weight: number;
}
export interface TrajectoryFeature {
  readonly times: readonly number[];
  readonly position: number;
  readonly direction: number;
}
export interface CustomFeature {
  readonly name: string;
  readonly dims: number;
  readonly weight: number;
}
export interface PoseSchema {
  readonly bones: readonly BoneFeature[];
  readonly trajectory: TrajectoryFeature;
  readonly custom: readonly CustomFeature[];
}
/** @internal A pose database source. */
export interface PoseDatabaseSource {
  readonly format: typeof POSE_DATABASE_FORMAT;
  readonly skeleton: string | null;
  readonly rate: number;
  readonly sources: readonly PoseSource[];
  readonly schema: PoseSchema;
  readonly normalisation: Normalisation;
}

/** @internal The default feature schema: feet and hips, three future trajectory samples. */
export const defaultPoseSchema = (): PoseSchema => ({
  bones: ["LeftFoot", "RightFoot", "Hips"].map((bone) => ({ bone, position: true, velocity: true, weight: 1 })),
  trajectory: { times: [0.33, 0.66, 1], position: 1, direction: 1 },
  custom: [],
});

/** @internal A new pose database source: no clips, the default schema. */
export const emptyPoseDatabase = (): PoseDatabaseSource => ({ format: POSE_DATABASE_FORMAT, skeleton: null, rate: 30, sources: [], schema: defaultPoseSchema(), normalisation: "feature" });

const L = POSE_DATABASE_LIMITS;

function readSchema(r: LenientReader, raw: unknown): PoseSchema {
  const o = r.record(raw, "schema");
  if (!o) return defaultPoseSchema();
  const def = defaultPoseSchema();
  const bones: BoneFeature[] = [];
  const boneList = o.bones === undefined ? def.bones : limited(r, o.bones, "schema.bones", L.boneFeatures, "bone features");
  boneList.forEach((b, i) => {
    const at = `schema.bones[${i}]`;
    if (!isRecord(b) || typeof b.bone !== "string" || b.bone === "") return r.problem(at, "a bone feature must name a bone; dropped.");
    if (bones.some((x) => x.bone === b.bone)) return r.problem(at, `bone "${b.bone}" is already a feature; dropped.`);
    bones.push({ bone: b.bone, position: r.bool(b.position, `${at}.position`, true), velocity: r.bool(b.velocity, `${at}.velocity`, true), weight: r.num(b.weight, `${at}.weight`, 1, 0, 1000) });
  });
  let trajectory = def.trajectory;
  const t = r.record(o.trajectory, "schema.trajectory");
  if (t) {
    let times = def.trajectory.times;
    if (t.times !== undefined) {
      const list = limited(r, t.times, "schema.trajectory.times", L.trajectorySamples, "samples");
      const nums = list.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v !== 0 && Math.abs(v) <= 10);
      if (nums.length !== list.length) r.problem("schema.trajectory.times", "each sample time must be a non-zero number of seconds in -10..10; the others are dropped.");
      const sorted = [...new Set(nums)].sort((a, b) => a - b);
      if (sorted.length !== nums.length || sorted.some((v, i) => v !== nums[i])) r.problem("schema.trajectory.times", "sample times must be distinct and ascending; sorted.");
      times = sorted;
    }
    trajectory = { times, position: r.num(t.position, "schema.trajectory.position", 1, 0, 1000), direction: r.num(t.direction, "schema.trajectory.direction", 1, 0, 1000) };
  }
  const custom: CustomFeature[] = [];
  limited(r, o.custom, "schema.custom", L.customFeatures, "custom features").forEach((c, i) => {
    const at = `schema.custom[${i}]`;
    if (!isRecord(c) || typeof c.name !== "string" || c.name === "") return r.problem(at, "a custom feature must have a name; dropped.");
    if (custom.some((x) => x.name === c.name)) return r.problem(at, `custom feature "${c.name}" is already defined; dropped.`);
    custom.push({ name: c.name, dims: r.int(c.dims, `${at}.dims`, 1, 1, L.customDims), weight: r.num(c.weight, `${at}.weight`, 1, 0, 1000) });
  });
  return { bones, trajectory, custom };
}

/** @internal A `*.posedb.json` value, leniently: never throws; problem lines start with `path` when given. */
export function parsePoseDatabase(raw: unknown, path?: string): FormatParse<PoseDatabaseSource> {
  const problems: string[] = [];
  const o = readRoot(raw, POSE_DATABASE_FORMAT, "a pose database", problems);
  const r = new LenientReader(problems);
  const allTags = new Set<string>();
  const sources: PoseSource[] = [];
  limited(r, o.sources, "sources", L.sources, "sources").forEach((s, i) => {
    const at = `sources[${i}]`;
    if (!isRecord(s)) return r.problem(at, "a source must be an object; dropped.");
    const clip = readRef(r, s.clip, `${at}.clip`);
    if (clip === null) return r.problem(`${at}.clip`, "a source must name a clip; dropped.");
    const ranges: PoseRange[] = [];
    limited(r, s.ranges, `${at}.ranges`, L.rangesPerSource, "ranges").forEach((g, k) => {
      const ra = `${at}.ranges[${k}]`;
      if (!isRecord(g)) return r.problem(ra, "a range must be an object; dropped.");
      let from = r.num(g.from, `${ra}.from`, 0, 0, TRACK_LIMITS.duration);
      let to = r.num(g.to, `${ra}.to`, from, 0, TRACK_LIMITS.duration);
      if (from > to) {
        r.problem(ra, "from was after to; swapped.");
        [from, to] = [to, from];
      }
      const tags: string[] = [];
      limited(r, g.tags, `${ra}.tags`, L.tagsPerRange, "tags").forEach((tag, n) => {
        if (typeof tag !== "string" || !TAG.test(tag)) return r.problem(`${ra}.tags[${n}]`, "a tag is a name of letters, digits, _ . -; dropped.");
        if (tags.includes(tag)) return;
        if (!allTags.has(tag) && allTags.size >= L.tags) return r.problem(`${ra}.tags[${n}]`, `at most ${L.tags} tags in a database; dropped.`);
        allTags.add(tag);
        tags.push(tag);
      });
      ranges.push({ from, to, tags });
    });
    sources.push({ clip, ranges, mirror: r.bool(s.mirror, `${at}.mirror`, false) });
  });
  const value: PoseDatabaseSource = {
    format: POSE_DATABASE_FORMAT,
    skeleton: readRef(r, o.skeleton, "skeleton"),
    rate: r.num(o.rate, "rate", 30, TRACK_LIMITS.minRate, TRACK_LIMITS.maxRate),
    sources,
    schema: readSchema(r, o.schema),
    normalisation: r.pick(o.normalisation, "normalisation", NORMALISATIONS, "feature"),
  };
  return { value, problems: withPath(problems, path) };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** @internal A pose database source as canonical JSON (defaults left out). */
export function poseDatabaseToJson(db: PoseDatabaseSource): JsonRecord {
  const def = defaultPoseSchema();
  const s = db.schema;
  const schema = compact({
    bones: sameJson(s.bones, def.bones) ? undefined : s.bones.map((b) => compact({ bone: b.bone, position: b.position ? undefined : false, velocity: b.velocity ? undefined : false, weight: b.weight === 1 ? undefined : b.weight })),
    trajectory: sameJson(s.trajectory, def.trajectory)
      ? undefined
      : compact({ times: sameJson(s.trajectory.times, def.trajectory.times) ? undefined : [...s.trajectory.times], position: s.trajectory.position === 1 ? undefined : s.trajectory.position, direction: s.trajectory.direction === 1 ? undefined : s.trajectory.direction }),
    custom: s.custom.length ? s.custom.map((c) => compact({ name: c.name, dims: c.dims === 1 ? undefined : c.dims, weight: c.weight === 1 ? undefined : c.weight })) : undefined,
  });
  return compact({
    format: POSE_DATABASE_FORMAT,
    skeleton: db.skeleton ?? undefined,
    rate: db.rate === 30 ? undefined : db.rate,
    sources: db.sources.map((x) => compact({ clip: x.clip, ranges: x.ranges.length ? x.ranges.map((g) => compact({ from: g.from, to: g.to, tags: g.tags.length ? [...g.tags] : undefined })) : undefined, mirror: x.mirror || undefined })),
    schema: Object.keys(schema).length ? schema : undefined,
    normalisation: db.normalisation === "feature" ? undefined : db.normalisation,
  });
}

/** @internal A pose database source's file text. */
export const formatPoseDatabase = (db: PoseDatabaseSource): string => jsonText(poseDatabaseToJson(db));

/** @internal The project files a pose database names (its skeleton's file and its clips), once each. */
export const poseDatabaseReferences = (db: PoseDatabaseSource): string[] => referencePaths([db.skeleton, ...db.sources.map((s) => s.clip)]);
