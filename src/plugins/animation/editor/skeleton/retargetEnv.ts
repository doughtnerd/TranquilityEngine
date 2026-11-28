// The retarget bake's environment over the open project (ADR 0373; T54): the real `RetargetEnv` (`retargetLogic.ts`) the
// card hands the bake: models and profiles through the importer and `Assets`, the source clip's raw form through T19's
// `prepareClipJob`, the editor compile module (in this thread: a bake is one clip, run on a click), and the project's writer.
import { rootMotionAxes } from "../../../../engine/animation/compile/rawClip";
import { animationSettingsOf } from "../../../../engine/animation/compile/settings";
import { encodeSkeleton } from "../../../../engine/animation/import/skeletonBinary";
import { Assets } from "../../../../engine/scene/Assets";
import { loadModel } from "../../../../engine/scene/models";
import { editor, type EditorProject } from "../../../../editor/sdk";
import { loadClipSource } from "../../runtime/features/clipSources";
import { loadAnimationCompiler } from "../compile/compiler";
import { prepareClipJob } from "../compile/jobs";
import { readProfile } from "./modelAnimation";
import type { RetargetEnv } from "./retargetLogic";

/** The bake's environment for `project`. */
export function projectRetargetEnv(project: EditorProject): RetargetEnv {
  const settings = () => {
    try {
      return animationSettingsOf(JSON.parse(project.textOf("project.json") ?? "{}"));
    } catch {
      return animationSettingsOf(project.settings);
    }
  };
  return {
    profile: async (ref) => readProfile(ref),
    model: async (path) => {
      const a = (await loadModel(`asset:${path}`).catch(() => null))?.animation;
      if (!a?.skeleton) return null;
      return { skeleton: a.skeleton, bytes: encodeSkeleton(a.skeleton), profile: a.skeleton.profile, boneMap: a.boneMap, clips: a.clips.map((c) => c.name) };
    },
    sourceClip: async (clip) => {
      const job = await prepareClipJob(clip, null, Assets.platform, settings());
      if ("error" in job) return job;
      const data = await loadClipSource(clip);
      return { raw: job.raw, record: job.record, rootAxes: data ? rootMotionAxes(data.source.rootMotion) : 0 };
    },
    compiler: loadAnimationCompiler,
    freeFilePath: (folder, stem, ext) => editor.project.freeFilePath(project, folder, stem, ext),
    writeBytes: (path, bytes) => project.writeBinary(path, bytes),
  };
}
