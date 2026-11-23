// The pose database tool's model (ADR 0373 "Pose database tool"; T55): the edits of a `*.posedb.json` document
// (`myco.posedb-source@1`, `engine/animation/poseDatabase.ts`): the clips and their tagged ranges, the feature schema
// (bone features, trajectory sample times and weights, custom features), the rate, the skeleton and the normalisation.
// Each edit is a pure refused-or-next result (ADR 0307, 0313); the view applies it with `applyToDocument`, so it is
// one labelled undo step of the document.
//
// **Validation is the source parse's** (`parsePoseDatabase`, which owns the limits and the lenient rules): an edit builds
// the database it asks for, writes it as JSON and parses it back; a problem the parse reports refuses the edit with that
// line, and an accepted edit is the parsed value (`same` itself when nothing changed). The edits fix up what they touch
// first, so only a real violation (a repeated clip, a tag that isn't a name, a range that ends before it starts) is refused.
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import {
  NORMALISATIONS,
  POSE_DATABASE_LIMITS,
  parsePoseDatabase,
  poseDatabaseToJson,
  type BoneFeature,
  type CustomFeature,
  type Normalisation,
  type PoseDatabaseSource,
  type PoseRange,
  type PoseSource,
} from "../../../../engine/animation/poseDatabase";
import { TRACK_LIMITS } from "../../../../engine/animation/tracks";

export type PoseDb = PoseDatabaseSource;

const L = POSE_DATABASE_LIMITS;
const TAG = /^[A-Za-z0-9_.-]+$/;

/** `next` through the parse rules: refused with the first problem, else the parsed value (`same` itself when nothing changed). */
export function validated(next: PoseDb, same: PoseDb): EditResult<PoseDb> {
  const read = parsePoseDatabase(JSON.parse(JSON.stringify(poseDatabaseToJson(next))));
  if (read.problems.length > 0) return refuse(read.problems[0]!);
  return accept(JSON.stringify(poseDatabaseToJson(read.value)) === JSON.stringify(poseDatabaseToJson(same)) ? same : read.value);
}

const withSource = (db: PoseDb, index: number, f: (s: PoseSource) => PoseSource): PoseDb => ({ ...db, sources: db.sources.map((s, i) => (i === index ? f(s) : s)) });
const missingClip = (i: number) => refuse(`there is no clip ${i + 1}.`);
const missingRange = (i: number, k: number) => refuse(`clip ${i + 1} has no range ${k + 1}.`);

/** The tag names in `text` (split on commas and spaces), once each, in order; `bad` holds the words that aren't tag names. */
export function parseTagList(text: string): { readonly tags: string[]; readonly bad: string[] } {
  const tags: string[] = [];
  const bad: string[] = [];
  for (const word of text.split(/[,\s]+/).filter((w) => w !== "")) {
    if (!TAG.test(word)) bad.push(word);
    else if (!tags.includes(word)) tags.push(word);
  }
  return { tags, bad };
}

// --- the database ------------------------------------------------------------------------------------------------------

/** The skeleton the features are measured on (null: the clips'). */
export const setSkeleton = (db: PoseDb, ref: string | null): EditResult<PoseDb> => validated({ ...db, skeleton: ref && ref.trim() !== "" ? ref.trim() : null }, db);

/** Frames baked per second. Refused outside the track rate limits. */
export function setRate(db: PoseDb, rate: number): EditResult<PoseDb> {
  if (!Number.isFinite(rate) || rate < TRACK_LIMITS.minRate || rate > TRACK_LIMITS.maxRate) return refuse(`the rate must be ${TRACK_LIMITS.minRate} to ${TRACK_LIMITS.maxRate} Hz.`);
  return validated({ ...db, rate }, db);
}

export function setNormalisation(db: PoseDb, mode: Normalisation): EditResult<PoseDb> {
  if (!NORMALISATIONS.includes(mode)) return refuse(`the normalisation is one of ${NORMALISATIONS.join(", ")}.`);
  return validated({ ...db, normalisation: mode }, db);
}

// --- clips and ranges --------------------------------------------------------------------------------------------------

/** A clip at the end, with no ranges (the whole clip, untagged). Refused when it is already in the database. */
export function addClip(db: PoseDb, clip: string): EditResult<PoseDb> {
  const ref = clip.trim();
  if (ref === "") return refuse("a clip needs a reference.");
  if (db.sources.some((s) => s.clip === ref)) return refuse(`${ref} is already in the database.`);
  if (db.sources.length >= L.sources) return refuse(`a database holds at most ${L.sources} clips.`);
  return validated({ ...db, sources: [...db.sources, { clip: ref, ranges: [], mirror: false }] }, db);
}

export function removeClip(db: PoseDb, index: number): EditResult<PoseDb> {
  if (!db.sources[index]) return missingClip(index);
  return validated({ ...db, sources: db.sources.filter((_, i) => i !== index) }, db);
}

/** Whether the clip is baked mirrored too. */
export function setMirror(db: PoseDb, index: number, mirror: boolean): EditResult<PoseDb> {
  if (!db.sources[index]) return missingClip(index);
  return validated(withSource(db, index, (s) => ({ ...s, mirror })), db);
}

/** A range of a clip, seconds, with its tags. Refused when it ends before it starts. */
export function addRange(db: PoseDb, index: number, range: PoseRange): EditResult<PoseDb> {
  const s = db.sources[index];
  if (!s) return missingClip(index);
  const bad = rangeProblem(range.from, range.to);
  if (bad) return refuse(bad);
  if (s.ranges.length >= L.rangesPerSource) return refuse(`a clip holds at most ${L.rangesPerSource} ranges.`);
  return validated(withSource(db, index, (x) => ({ ...x, ranges: [...x.ranges, { from: range.from, to: range.to, tags: [...range.tags] }] })), db);
}

export function removeRange(db: PoseDb, index: number, range: number): EditResult<PoseDb> {
  const s = db.sources[index];
  if (!s) return missingClip(index);
  if (!s.ranges[range]) return missingRange(index, range);
  return validated(withSource(db, index, (x) => ({ ...x, ranges: x.ranges.filter((_, k) => k !== range) })), db);
}

function rangeProblem(from: number, to: number): string | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "a range needs a start and an end in seconds.";
  if (from < 0) return "a range can't start before the clip does.";
  if (to < from) return "a range can't end before it starts.";
  if (to > TRACK_LIMITS.duration) return `a range ends within ${TRACK_LIMITS.duration} s.`;
  return null;
}

/** A range's start and end. */
export function setRange(db: PoseDb, index: number, range: number, from: number, to: number): EditResult<PoseDb> {
  const s = db.sources[index];
  if (!s) return missingClip(index);
  if (!s.ranges[range]) return missingRange(index, range);
  const bad = rangeProblem(from, to);
  if (bad) return refuse(bad);
  return validated(withSource(db, index, (x) => ({ ...x, ranges: x.ranges.map((g, k) => (k === range ? { ...g, from, to } : g)) })), db);
}

/** A range's tags (names of letters, digits, `_ . -`; repeats dropped). */
export function setRangeTags(db: PoseDb, index: number, range: number, tags: readonly string[]): EditResult<PoseDb> {
  const s = db.sources[index];
  if (!s) return missingClip(index);
  if (!s.ranges[range]) return missingRange(index, range);
  const bad = tags.find((t) => !TAG.test(t));
  if (bad !== undefined) return refuse(`"${bad}" isn't a tag name: use letters, digits, _ . -`);
  const unique = [...new Set(tags)];
  if (unique.length > L.tagsPerRange) return refuse(`a range holds at most ${L.tagsPerRange} tags.`);
  return validated(withSource(db, index, (x) => ({ ...x, ranges: x.ranges.map((g, k) => (k === range ? { ...g, tags: unique } : g)) })), db);
}

// --- the feature schema ------------------------------------------------------------------------------------------------

const withBones = (db: PoseDb, f: (bones: readonly BoneFeature[]) => BoneFeature[]): PoseDb => ({ ...db, schema: { ...db.schema, bones: f(db.schema.bones) } });

/** A bone feature (position and velocity, weight 1) at the end. */
export function addBoneFeature(db: PoseDb, bone: string): EditResult<PoseDb> {
  const name = bone.trim();
  if (name === "") return refuse("a bone feature needs a bone.");
  if (db.schema.bones.some((b) => b.bone === name)) return refuse(`${name} is already a feature.`);
  if (db.schema.bones.length >= L.boneFeatures) return refuse(`a schema holds at most ${L.boneFeatures} bone features.`);
  return validated(withBones(db, (b) => [...b, { bone: name, position: true, velocity: true, weight: 1 }]), db);
}

export function removeBoneFeature(db: PoseDb, bone: string): EditResult<PoseDb> {
  if (!db.schema.bones.some((b) => b.bone === bone)) return refuse(`${bone} isn't a feature.`);
  return validated(withBones(db, (b) => b.filter((x) => x.bone !== bone)), db);
}

/** A bone feature's position and velocity switches and weight. A feature with neither measures nothing: refused. */
export function setBoneFeature(db: PoseDb, bone: string, patch: Partial<Pick<BoneFeature, "position" | "velocity" | "weight">>): EditResult<PoseDb> {
  const f = db.schema.bones.find((b) => b.bone === bone);
  if (!f) return refuse(`${bone} isn't a feature.`);
  const next = { ...f, ...patch };
  if (!next.position && !next.velocity) return refuse(`${bone} needs its position or its velocity (remove it to drop the feature).`);
  if (!Number.isFinite(next.weight) || next.weight < 0 || next.weight > 1000) return refuse("a weight is 0 to 1000.");
  return validated(withBones(db, (b) => b.map((x) => (x.bone === bone ? next : x))), db);
}

/** Trajectory sample times in seconds: non-zero, within ±10 s, distinct (sorted here); at least one. */
export function setTrajectoryTimes(db: PoseDb, times: readonly number[]): EditResult<PoseDb> {
  if (times.length === 0) return refuse("the trajectory needs at least one sample time.");
  if (times.length > L.trajectorySamples) return refuse(`a trajectory holds at most ${L.trajectorySamples} samples.`);
  if (times.some((t) => !Number.isFinite(t) || t === 0 || Math.abs(t) > 10)) return refuse("a sample time is a non-zero number of seconds within -10 to 10.");
  if (new Set(times).size !== times.length) return refuse("sample times must be distinct.");
  return validated({ ...db, schema: { ...db.schema, trajectory: { ...db.schema.trajectory, times: [...times].sort((a, b) => a - b) } } }, db);
}

/** The trajectory's position and direction weights (0 to 1000). */
export function setTrajectoryWeights(db: PoseDb, patch: { readonly position?: number; readonly direction?: number }): EditResult<PoseDb> {
  const t = { ...db.schema.trajectory, ...patch };
  if (![t.position, t.direction].every((w) => Number.isFinite(w) && w >= 0 && w <= 1000)) return refuse("a weight is 0 to 1000.");
  return validated({ ...db, schema: { ...db.schema, trajectory: t } }, db);
}

const withCustom = (db: PoseDb, f: (c: readonly CustomFeature[]) => CustomFeature[]): PoseDb => ({ ...db, schema: { ...db.schema, custom: f(db.schema.custom) } });

/** A custom feature (dims and weight), which a bake hook fills. */
export function addCustomFeature(db: PoseDb, name: string, dims = 1): EditResult<PoseDb> {
  const n = name.trim();
  if (n === "") return refuse("a custom feature needs a name.");
  if (db.schema.custom.some((c) => c.name === n)) return refuse(`${n} is already a custom feature.`);
  if (!Number.isInteger(dims) || dims < 1 || dims > L.customDims) return refuse(`a custom feature has 1 to ${L.customDims} dimensions.`);
  if (db.schema.custom.length >= L.customFeatures) return refuse(`a schema holds at most ${L.customFeatures} custom features.`);
  return validated(withCustom(db, (c) => [...c, { name: n, dims, weight: 1 }]), db);
}

export function removeCustomFeature(db: PoseDb, name: string): EditResult<PoseDb> {
  if (!db.schema.custom.some((c) => c.name === name)) return refuse(`${name} isn't a custom feature.`);
  return validated(withCustom(db, (c) => c.filter((x) => x.name !== name)), db);
}

export function setCustomFeature(db: PoseDb, name: string, patch: Partial<Pick<CustomFeature, "dims" | "weight">>): EditResult<PoseDb> {
  const f = db.schema.custom.find((c) => c.name === name);
  if (!f) return refuse(`${name} isn't a custom feature.`);
  const next = { ...f, ...patch };
  if (!Number.isInteger(next.dims) || next.dims < 1 || next.dims > L.customDims) return refuse(`a custom feature has 1 to ${L.customDims} dimensions.`);
  if (!Number.isFinite(next.weight) || next.weight < 0 || next.weight > 1000) return refuse("a weight is 0 to 1000.");
  return validated(withCustom(db, (c) => c.map((x) => (x.name === name ? next : x))), db);
}

// --- reading -----------------------------------------------------------------------------------------------------------

/** The distinct tags of the database, in order of first use, each with its range count and the seconds it tags. */
export function tagStats(db: PoseDb): { readonly tag: string; readonly ranges: number; readonly seconds: number }[] {
  const stats = new Map<string, { ranges: number; seconds: number }>();
  for (const s of db.sources) {
    for (const g of s.ranges) {
      for (const tag of g.tags) {
        const t = stats.get(tag) ?? { ranges: 0, seconds: 0 };
        t.ranges++;
        t.seconds += g.to - g.from;
        stats.set(tag, t);
      }
    }
  }
  return [...stats].map(([tag, t]) => ({ tag, ...t }));
}

/** The dimensions of the baked feature vector: 3 per bone position and velocity, 2 per trajectory position and direction sample. */
export function featureDimensions(db: PoseDb): number {
  const { bones, trajectory } = db.schema;
  const perBone = bones.reduce((n, b) => n + (b.position ? 3 : 0) + (b.velocity ? 3 : 0), 0);
  return perBone + trajectory.times.length * 4;
}

/** The names of the bones a `skeleton` lacks of the schema's bone features. */
export const missingBones = (db: PoseDb, skeletonBones: readonly string[]): string[] => db.schema.bones.map((b) => b.bone).filter((b) => !skeletonBones.includes(b));

/** The path of the baked file beside a source: `x.posedb.json` → `x.posedb.bin`. */
export const bakedPathOf = (sourcePath: string): string => sourcePath.replace(/\.posedb\.json$/i, ".posedb.bin");
