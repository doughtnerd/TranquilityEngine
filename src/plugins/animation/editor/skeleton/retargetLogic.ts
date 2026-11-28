// Retarget selection and bake (ADR 0373 "Skeleton and retarget tools", ADR 0372, D47, D122; T54).
//
// A retarget names a **source** (a model with a skeleton, its bone map and one of its clips) and a **target** (the model
// whose Import Settings are open, with its draft bone map and profile). "Bake retargeted clip" runs the editor compile
// module's `retarget_bake_compressed` (T19 `compiler.ts`): the source clip's raw form (`prepareClipJob`'s `myco.anim@1`)
// is retargeted through a map built from the two skeletons, profiles and bone maps (chain alignment on, D47), compressed
// for the target, and written beside the target model as a compiled clip, `<clip>.<target>.anim.bin` (the `compiledclip`
// kind), which an Animator plays as it plays any clip file.
//
// **Why `.anim.bin` and not `*.anim.json`:** the bake's output is the compressed clip; an authored `myco.anim-source@1`
// would need the compressed channels decoded back into keys, and no TypeScript decoder exists (the core is the only
// evaluator, ADR 0370). The compressed file is the finished clip, bound to the target skeleton by index.
//
// Everything the bake reads comes through `RetargetEnv`, so the tests give it fakes; the view wires the real project.
import type { ImportedSkeleton } from "../../../../engine/animation/import/skeleton";
import { encodeSkeletonProfile, type SkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import type { AnimationCompiler, ClipReport } from "../compile/compiler";
import type { BoneMap } from "./boneMapLogic";

const NO_BONE = 0xffff;

/** A model as a retarget side reads it. */
export interface RetargetModel {
  readonly skeleton: ImportedSkeleton;
  /** The skeleton as `myco.skel@1` bytes. */
  readonly bytes: Uint8Array;
  /** The sidecar's skeleton profile reference (null: Humanoid). */
  readonly profile: string | null;
  /** Role → bone as the model imported (the sidecar's, else the core's guess). */
  readonly boneMap: BoneMap;
  /** The model's clip names (`Anim/<name>` sub-assets). */
  readonly clips: readonly string[];
}

/** What a source clip compiles from (`prepareClipJob`'s fields the bake needs). */
export interface SourceClipJob {
  readonly raw: Uint8Array;
  readonly record: Float32Array;
  /** The root curve's axes as `anim-compress` flags. */
  readonly rootAxes: number;
}

/** What the bake reads and writes of the project and the editor. */
export interface RetargetEnv {
  /** A skeleton profile by reference (null: the built-in Humanoid); null when it can't be read. */
  profile(ref: string | null): Promise<SkeletonProfile | null>;
  /** The model at `path`, or null when it has no skeleton or can't load. */
  model(path: string): Promise<RetargetModel | null>;
  /** The raw form of `clip` (`models/hero.glb#Anim/Run`) bound to its model's skeleton, or why not. */
  sourceClip(clip: string): Promise<SourceClipJob | { readonly error: string }>;
  compiler(): Promise<AnimationCompiler>;
  /** A free project path in `folder` for `<stem><ext>`, else `<stem> 2<ext>`…: the editor's `freeFilePath` (ADR 0465). */
  freeFilePath(folder: string, stem: string, ext: string): string;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
}

/** One side of a retarget: a model, and the profile and bone map the bake maps it with. */
export interface RetargetTarget {
  readonly model: string;
  /** The profile reference to map with (null: Humanoid): the draft's. */
  readonly profile: string | null;
  /** The draft bone map. */
  readonly boneMap: BoneMap;
}

export interface RetargetRequest {
  /** The source model's path. */
  readonly source: string;
  /** The source clip's name (`Anim/<name>` of the source model). */
  readonly clip: string;
  readonly target: RetargetTarget;
}

export type BakeOutcome = { readonly ok: true; readonly path: string; readonly size: number; readonly report: ClipReport } | { readonly ok: false; readonly error: string };

/** The source clip's reference (`models/hero.glb#Anim/Run`). */
export const sourceClipRef = (model: string, clip: string): string => `${model}#Anim/${clip}`;

/** A bone map as the core's input: one bone index per role of `profile` (0xFFFF unmapped). */
export function boneMapIndices(profile: SkeletonProfile, boneMap: BoneMap, bones: readonly string[]): Uint16Array {
  const index = new Map(bones.map((b, i) => [b, i]));
  const out = new Uint16Array(profile.roles.length).fill(NO_BONE);
  profile.roles.forEach((r, i) => {
    const b = boneMap[r.name] === undefined ? undefined : index.get(boneMap[r.name]);
    if (b !== undefined) out[i] = b;
  });
  return out;
}

const stem = (path: string): string => {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.indexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
};

/** Where the bake writes: beside the target model as `<clip>.<target>.anim.bin`, the free path `free` gives for it. */
export function bakedClipPath(targetModel: string, clip: string, free: RetargetEnv["freeFilePath"]): string {
  const folder = targetModel.includes("/") ? targetModel.slice(0, targetModel.lastIndexOf("/")) : "";
  const safe = (s: string) => s.replace(/[\\/:*?"<>|#]+/g, "_").trim() || "clip";
  return free(folder, `${safe(clip)}.${safe(stem(targetModel))}`, ".anim.bin");
}

/** Why a side can't be baked yet (an empty bone map, a required role without a bone), or null. */
export function sideProblem(label: string, profile: SkeletonProfile, boneMap: BoneMap, bones: readonly string[]): string | null {
  const map = boneMapIndices(profile, boneMap, bones);
  if (!map.some((b) => b !== NO_BONE)) return `the ${label}'s bone map is empty: map its bones first.`;
  const missing = profile.roles.filter((r, i) => r.required && map[i] === NO_BONE).map((r) => r.name);
  return missing.length ? `the ${label} has no bone for the required role${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.` : null;
}

/** A retargeted clip's compiled bytes and compile report, or why not. */
export type RetargetedClip = { readonly ok: true; readonly bytes: Uint8Array; readonly report: ClipReport } | { readonly ok: false; readonly error: string };

/** Bake `request` and write the compiled clip (see the file comment). Never rejects. */
export async function bakeRetargetedClip(env: RetargetEnv, request: RetargetRequest): Promise<BakeOutcome> {
  const out = await retargetClipBytes(env, request);
  if (!out.ok) return out;
  try {
    const path = bakedClipPath(request.target.model, request.clip, (folder, s, ext) => env.freeFilePath(folder, s, ext));
    await env.writeBytes(path, out.bytes);
    return { ok: true, path, size: out.bytes.length, report: out.report };
  } catch (err) {
    return { ok: false, error: `the retarget bake failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The retargeted clip's compiled bytes without writing them (the bake's compile step; the side-by-side preview plays them
 * from memory, T18b). Never rejects.
 */
export async function retargetClipBytes(env: RetargetEnv, request: RetargetRequest): Promise<RetargetedClip> {
  try {
    const [source, target] = await Promise.all([env.model(request.source), env.model(request.target.model)]);
    if (!source) return { ok: false, error: `${request.source} has no skeleton to retarget from.` };
    if (!target) return { ok: false, error: `${request.target.model} has no skeleton to retarget to.` };
    const [sourceProfile, targetProfile] = await Promise.all([env.profile(source.profile), env.profile(request.target.profile)]);
    if (!sourceProfile) return { ok: false, error: `the source's skeleton profile ${source.profile} can't be read.` };
    if (!targetProfile) return { ok: false, error: `the target's skeleton profile ${request.target.profile} can't be read.` };
    if (!source.clips.includes(request.clip)) return { ok: false, error: `${request.source} has no clip "${request.clip}".` };
    const sourceBones = source.skeleton.bones.map((b) => b.name);
    const targetBones = target.skeleton.bones.map((b) => b.name);
    const problem = sideProblem("source", sourceProfile, source.boneMap, sourceBones) ?? sideProblem("target", targetProfile, request.target.boneMap, targetBones);
    if (problem) return { ok: false, error: problem };
    const encode = (profile: SkeletonProfile, ref: string | null): Uint8Array | { readonly error: string } => {
      if (ref === null) return new Uint8Array(0); // the Humanoid: the core's own
      const e = encodeSkeletonProfile(profile);
      return "bytes" in e ? e.bytes : { error: `the skeleton profile ${ref} can't be used: ${e.problem}` };
    };
    const sp = encode(sourceProfile, source.profile);
    const tp = encode(targetProfile, request.target.profile);
    if ("error" in sp) return { ok: false, error: sp.error };
    if ("error" in tp) return { ok: false, error: tp.error };
    const job = await env.sourceClip(sourceClipRef(request.source, request.clip));
    if ("error" in job) return { ok: false, error: job.error };
    const compiler = await env.compiler();
    const out = compiler.retargetCompressed(
      { skeleton: source.bytes, profile: sp, map: boneMapIndices(sourceProfile, source.boneMap, sourceBones) },
      { skeleton: target.bytes, profile: tp, map: boneMapIndices(targetProfile, request.target.boneMap, targetBones) },
      { alignChains: true, rootAxes: job.rootAxes, ikWeights: new Float32Array(0), record: job.record },
      job.raw,
    );
    if (!out.ok) return { ok: false, error: `the retarget bake failed: ${out.error}` };
    return { ok: true, bytes: out.bytes, report: out.report };
  } catch (err) {
    return { ok: false, error: `the retarget bake failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Whether `other` can wear this model's clips as they are, for the clip preview on "any profile-compatible character":
 * the same profile, and every required role of it mapped to a bone in both. `bones` are the models' bone names.
 */
export function profileCompatible(profile: SkeletonProfile, mine: { readonly profile: string | null; readonly boneMap: BoneMap; readonly bones: readonly string[] }, other: { readonly profile: string | null; readonly boneMap: BoneMap; readonly bones: readonly string[] }): boolean {
  if (mine.profile !== other.profile) return false;
  return sideProblem("model", profile, mine.boneMap, mine.bones) === null && sideProblem("model", profile, other.boneMap, other.bones) === null;
}
