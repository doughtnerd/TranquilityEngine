// Where an Animator's clip and a Skeleton's skeleton come from (ADR 0370, 0371; T19). A clip reference names an authored
// clip (`clips/walk.anim.json`), a model's clip (`models/hero.glb#Anim/Run`) or a compiled file (`*.anim.bin`); a
// skeleton reference a `myco.skel@1` file or a model's skeleton (`models/hero.glb#Skeleton`). The first of these wins:
//
// 1. **A compiled file the build ships** (`engine/animation/compile/keys.ts`'s build paths: exports compile every
//    referenced clip and skeleton beside its source, as 0090 bakes models): loaded by path like any file.
// 2. **The editor's compiled clip** (`setCompiledClipSource`: the editor's compile cache, `.myco/anim/`): its bytes,
//    when that clip has been compiled already. Asking starts the compile in the editor's worker otherwise.
// 3. **The raw form, made here** (`compileRawClip`; a model's skeleton through `encodeSkeleton`): a `myco.anim@1` raw
//    clip plays directly in the core, so the clip plays raw until its compile is ready (ADR 0371: "the raw clip plays
//    until it finishes"). A play uses what was ready when its clip was first acquired; the next acquisition (another
//    play session, another Animator) picks up the compiled clip.
//
// Authored clips with bone tracks bind to the Animator's skeleton by name (ADR 0371), so they resolve per skeleton; a
// model's clip binds its own model's skeleton. Never throws: what can't be read resolves to null (the caller warns).
import { parseAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { fnv1aHex } from "../../../../engine/animation/compile/hash";
import { compiledClipPath, compiledSkeletonPath, isClipSource, modelClipOf, modelSkeletonOf } from "../../../../engine/animation/compile/keys";
import { compileRawClip, importedClipSkeleton, usesBones, type ClipSkeleton } from "../../../../engine/animation/compile/rawClip";
import type { CompressionLevel } from "../../../../engine/animation/compile/settings";
import { encodeSkeleton } from "../../../../engine/animation/import/skeletonBinary";
import { Assets, normalizeAssetPath } from "../../../../engine/scene/Assets";
import { loadModel } from "../../../../engine/scene/models";

/** @internal A clip or skeleton to load: a file by project path, or bytes made here (`key` names them in the core). */
export type ResolvedAsset = { readonly path: string } | { readonly key: string; readonly bytes: Uint8Array };

/** @internal A compile request: a clip source and, for an authored clip with bone tracks, the skeleton it binds to. */
export interface CompiledClipRequest {
  readonly clip: string;
  readonly skeleton: string | null;
}

/** @internal Where compiled clips come from in the editor (its compile cache). */
export interface CompiledClipSource {
  /** The compiled clip's bytes if it is compiled already, else null (and its compile starts). Never rejects. */
  compiled(request: CompiledClipRequest): Promise<Uint8Array | null>;
}

let compiledSource: CompiledClipSource | null = null;

/** @internal The editor sets its compile cache here while a project is open (null: none, as in a game). */
export function setCompiledClipSource(source: CompiledClipSource | null): void {
  compiledSource = source;
}

/** @internal A clip source's track model and compile inputs, read through `Assets`. */
export interface ClipSourceData {
  readonly source: AnimSource;
  /** The model clip's sidecar `compression` (T14), or null. */
  readonly sidecar: CompressionLevel | null;
  /** The path folder rules match: the clip's file, or its model's. */
  readonly settingsPath: string;
  /** The skeleton reference it binds to: its model's for a model clip, else null (the Animator's, when it has bone tracks). */
  readonly ownSkeleton: string | null;
}

const keyOf = (bytes: Uint8Array) => `${fnv1aHex(bytes)}:${bytes.length}`;

/** @internal The clip source `clipRef` names (an authored clip or a model's clip), or null when it can't be read. */
export async function loadClipSource(clipRef: string): Promise<ClipSourceData | null> {
  try {
    const model = modelClipOf(clipRef);
    if (model) {
      const clip = (await loadModel(model.model)).animation?.clips.find((c) => c.name === model.name);
      return clip ? { source: clip.source, sidecar: clip.settings.compression, settingsPath: model.model, ownSkeleton: `${model.model}#Skeleton` } : null;
    }
    const path = normalizeAssetPath(clipRef);
    if (!Assets.has(path)) return null;
    const { value, problems } = parseAnimSource(Assets.json(path), path);
    for (const p of problems) console.warn(`[myco] ${p}`);
    return { source: value, sidecar: null, settingsPath: path, ownSkeleton: null };
  } catch {
    return null;
  }
}

/** @internal The skeleton reference a clip compiles against: its own model's, the Animator's for bone tracks, else none. */
export const skeletonFor = (data: ClipSourceData, animatorSkeleton: string | null): string | null =>
  data.ownSkeleton ?? (usesBones(data.source) ? animatorSkeleton : null);

/** @internal The `myco.skel@1` bytes of a skeleton reference (a build's compiled file, a model's skeleton, or a file), or null. */
export async function loadSkeletonBytes(skeletonRef: string): Promise<Uint8Array | null> {
  try {
    const resolved = await resolveSkeleton(skeletonRef);
    if (!resolved) return null;
    return "bytes" in resolved ? resolved.bytes : await Assets.bytes(resolved.path);
  } catch {
    return null;
  }
}

/** @internal Where a skeleton reference loads from: the build's compiled file, a model's skeleton encoded here, or the file itself. */
export async function resolveSkeleton(skeletonRef: string): Promise<ResolvedAsset | null> {
  const model = modelSkeletonOf(skeletonRef);
  if (!model) return { path: normalizeAssetPath(skeletonRef) };
  const built = compiledSkeletonPath(skeletonRef);
  if (built && Assets.has(built)) return { path: built };
  try {
    const skeleton = (await loadModel(model)).animation?.skeleton;
    if (!skeleton) return null;
    const bytes = encodeSkeleton(skeleton);
    return { key: `skeleton:${keyOf(bytes)}`, bytes };
  } catch {
    return null;
  }
}

/** @internal An Animator's skeleton as a clip binds it: its reference and, once loaded, its bone names and rest pose. */
export interface AnimatorSkeleton {
  readonly ref: string;
  readonly bones: ClipSkeleton | null;
}

/** The bones a model clip's raw form binds: its model's skeleton. */
async function modelBones(model: string): Promise<ClipSkeleton | null> {
  const skeleton = (await loadModel(model)).animation?.skeleton;
  return skeleton ? importedClipSkeleton(skeleton) : null;
}

/**
 * @internal Where an Animator's clip `clipRef` loads from (see the file header), bound to `skeleton` (the Animator's,
 * or null when it has none). Null when the clip can't be read.
 */
export async function resolveClip(clipRef: string, skeleton: AnimatorSkeleton | null): Promise<ResolvedAsset | null> {
  if (!isClipSource(clipRef)) return { path: normalizeAssetPath(clipRef) };
  const data = await loadClipSource(clipRef);
  if (!data) return null;
  const skeletonRef = skeletonFor(data, skeleton?.ref ?? null);
  const built = compiledClipPath(clipRef, data.ownSkeleton ? null : skeletonRef);
  if (Assets.has(built)) return { path: built };
  if (compiledSource) {
    const bytes = await compiledSource.compiled({ clip: clipRef, skeleton: data.ownSkeleton ? null : skeletonRef }).catch(() => null);
    if (bytes) return { key: `clip:${keyOf(bytes)}`, bytes };
  }
  try {
    const bones = data.ownSkeleton ? await modelBones(modelClipOf(clipRef)!.model) : skeletonRef ? skeleton?.bones ?? null : null;
    const raw = compileRawClip(data.source, bones);
    for (const p of raw.problems) console.warn(`[myco] ${clipRef}: ${p}`);
    return { key: `clip:${keyOf(raw.bytes)}`, bytes: raw.bytes };
  } catch (err) {
    console.warn(`[myco] ${clipRef}: couldn't make its raw form:`, err);
    return null;
  }
}
