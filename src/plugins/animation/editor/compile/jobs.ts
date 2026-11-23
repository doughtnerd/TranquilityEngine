// A clip compile job (ADR 0371; T19): what the editor's compile cache and the exporters compile one clip from. Both read
// the project through `Assets` (the editor's project; the Node exporter's project context), so a clip compiles the same
// way in both: the clip source's raw form (`compileRawClip`) bound to its skeleton, the skeleton's `myco.skel@1` bytes,
// the settings resolved for the platform (project → folder rule → sidecar → platform) as the editor module's record,
// and the content key over all of them.
import type { ImportPlatform } from "../../../../engine/scene/importSettings";
import { clipContentKey, compressionRecord } from "../../../../engine/animation/compile/keys";
import { compileRawClip, rootMotionAxes } from "../../../../engine/animation/compile/rawClip";
import { resolveCompression, type AnimationProjectSettings, type ResolvedCompression } from "../../../../engine/animation/compile/settings";
import { loadAnimationCompiler } from "./compiler";
import { readSkeletonInfo } from "../../runtime/assetInfo";
import { loadClipSource, loadSkeletonBytes, skeletonFor } from "../../runtime/features/clipSources";

/** @internal One clip to compile. */
export interface ClipJob {
  /** The clip source (`clips/walk.anim.json`, `models/hero.glb#Anim/Run`). */
  readonly clip: string;
  /** The skeleton it binds: its model's for a model clip, the Animator's for an authored clip with bone tracks, else null. */
  readonly skeletonRef: string | null;
  readonly key: string;
  readonly raw: Uint8Array;
  /** The skeleton's file bytes (empty without one). */
  readonly skeleton: Uint8Array;
  readonly record: Float32Array;
  readonly settings: ResolvedCompression;
  /** What the raw form dropped. */
  readonly problems: readonly string[];
}

/**
 * @internal The job for `clip` on `platform` (`animatorSkeleton`: the skeleton an authored clip with bone tracks binds
 * to; ignored for a model clip and a clip without bone tracks), or an error when the clip or its skeleton can't be read.
 */
export async function prepareClipJob(clip: string, animatorSkeleton: string | null, platform: ImportPlatform, project: AnimationProjectSettings): Promise<ClipJob | { readonly error: string }> {
  const data = await loadClipSource(clip);
  if (!data) return { error: `${clip}: the clip can't be read.` };
  const skeletonRef = skeletonFor(data, animatorSkeleton);
  let skeleton: Uint8Array = new Uint8Array(0);
  let bones = null;
  if (skeletonRef) {
    const bytes = await loadSkeletonBytes(skeletonRef);
    const info = bytes ? readSkeletonInfo(bytes) : null;
    if (!bytes || !info) return { error: `${clip}: its skeleton "${skeletonRef}" can't be read.` };
    skeleton = bytes;
    bones = info;
  }
  // Source curves are sampled by the editor module, the evaluator the runtime core links, so the compile matches the runtime.
  const compiler = await loadAnimationCompiler();
  const raw = compileRawClip(data.source, bones, "", compiler.sampleCurve);
  const { settings } = resolveCompression({ path: data.settingsPath, sidecar: data.sidecar }, platform, project);
  const record = compressionRecord(settings, data.source.rate, raw.rootBone, rootMotionAxes(data.source.rootMotion));
  // A clip that binds no bones compiles without its skeleton (the compressor reads it only for bone tracks).
  const skeletonInput = raw.boneCount > 0 ? skeleton : new Uint8Array(0);
  const key = await clipContentKey({ raw: raw.bytes, skeleton: skeletonInput, record });
  return { clip, skeletonRef, key, raw: raw.bytes, skeleton: skeletonInput, record, settings, problems: raw.problems };
}
