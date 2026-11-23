// The pose database bake's environment over the open project (ADR 0373; T55): the real `PoseDbBakeEnv` (`bakeLogic.ts`) the
// tool hands the bake. Clips come through T19's compile service when the project has one (its cache: a clip compiled
// once is not compiled again), else compiled in this thread by the editor module as an export compiles them; skeletons
// through `loadSkeletonBytes` (a file, or a model's skeleton encoded); the bake in the bake worker (`bakeRunner.ts`);
// files written through the project.
import { Assets } from "../../../../engine/scene/Assets";
import { animationSettingsOf } from "../../../../engine/animation/compile/settings";
import type { EditorProject } from "../../../../editor/sdk";
import { loadClipSource, loadSkeletonBytes, skeletonFor } from "../../runtime/features/clipSources";
import { loadAnimationCompiler } from "../compile/compiler";
import { prepareClipJob } from "../compile/jobs";
import { clipCompileService } from "../compile/register";
import type { PoseDbBakeEnv } from "./bakeLogic";
import { workerBakeRunner } from "./bakeRunner";

/** The bake's environment for `project`. */
export function projectPoseDbEnv(project: EditorProject): PoseDbBakeEnv {
  const settings = () => {
    try {
      return animationSettingsOf(JSON.parse(project.textOf("project.json") ?? "{}"));
    } catch {
      return animationSettingsOf(project.settings);
    }
  };
  return {
    clipSkeleton: async (clip) => (await loadClipSource(clip))?.ownSkeleton ?? null,
    skeleton: (ref) => loadSkeletonBytes(ref),
    clip: async (ref, skeletonRef) => {
      const data = await loadClipSource(ref);
      if (!data) return { error: `${ref}: the clip can't be read.` };
      const bound = skeletonFor(data, skeletonRef);
      const service = clipCompileService();
      if (service) {
        const made = await service.compileClip({ clip: ref, skeleton: data.ownSkeleton ? null : bound });
        return "error" in made ? { error: made.error } : { bytes: made.clip.bytes };
      }
      const job = await prepareClipJob(ref, skeletonRef, Assets.platform, settings());
      if ("error" in job) return { error: job.error };
      const out = (await loadAnimationCompiler()).compressClip(job.raw, job.skeleton, job.record);
      return out.ok ? { bytes: out.bytes } : { error: `${ref}: ${out.error}` };
    },
    run: workerBakeRunner,
    writeBytes: (path, bytes) => project.writeBinary(path, bytes),
  };
}
