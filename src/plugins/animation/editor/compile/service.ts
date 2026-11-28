// The editor's clip compile service (ADR 0370, 0371; T19): one per open project, over its compile cache
// (`cache.ts`). It is the runtime's compiled-clip source while the project is open (`setCompiledClipSource`): an
// Animator asks for a clip, gets the compiled bytes when they are cached, and otherwise plays the raw form while the
// clip compiles in the worker. Clips compile again when their file changes (`refresh`, from `Assets.onChanged`).
//
// The small API for the Asset Inspector (0373, T54): `compileClip` (compile now, with the report) and `clipReport`
// (the report of the clip's current compile, if made).
import { Assets } from "../../../../engine/scene/Assets";
import type { ImportPlatform } from "../../../../engine/scene/importSettings";
import { SIDECAR_SUFFIX, sidecarPath } from "../../../../engine/scene/importSettings";
import { isModelPath, loadModel } from "../../../../engine/scene/models";
import { ANIM_SOURCE_SUFFIX } from "../../../../engine/animation/animSource";
import { usesBones } from "../../../../engine/animation/compile/rawClip";
import { modelClipOf } from "../../../../engine/animation/compile/keys";
import { referencePath } from "../../../../engine/animation/shared";
import type { AnimationProjectSettings } from "../../../../engine/animation/compile/settings";
import { loadClipSource, type CompiledClipRequest, type CompiledClipSource } from "../../runtime/features/clipSources";
import type { ClipCompileCache, CompiledClip } from "./cache";
import type { ClipReport } from "./compiler";
import { prepareClipJob } from "./jobs";
import { normalizeAssetPath } from "../../../../engine/scene/assetPath";

/** @internal What the service reads of the open project. */
export interface ClipCompileEnv {
  /** The platform the editor compiles for (`Assets.platform`). */
  platform(): ImportPlatform;
  /** `project.json`'s `animation` section, parsed. */
  settings(): AnimationProjectSettings;
  /** Where compile problems go (`console.warn` in the editor). */
  warn(message: string): void;
}

/** @internal A compile's result: the compiled clip with its report, or why it couldn't compile. */
export type ClipCompileResult = { readonly clip: CompiledClip; readonly problems: readonly string[] } | { readonly error: string };

const CLIP_SUB = "#Anim/";
const requestId = (platform: ImportPlatform, r: CompiledClipRequest) => `${platform}\n${normalizeAssetPath(r.clip)}\n${r.skeleton ? normalizeAssetPath(r.skeleton) : ""}`;

export class ClipCompileService implements CompiledClipSource {
  /** Requests asked for this session, by id: what `refresh` compiles again. */
  private readonly known = new Map<string, CompiledClipRequest>();

  constructor(
    readonly cache: ClipCompileCache,
    private readonly env: ClipCompileEnv,
  ) {}

  /**
   * The runtime's question (`CompiledClipSource`): the compiled bytes if cached; otherwise null, and the compile starts,
   * and `onCompiled` gets its bytes when it finishes (the runtime swaps its raw clip for them in place, T70).
   */
  async compiled(request: CompiledClipRequest, onCompiled?: (bytes: Uint8Array) => void): Promise<Uint8Array | null> {
    const platform = this.env.platform();
    this.known.set(requestId(platform, request), request);
    const job = await prepareClipJob(request.clip, request.skeleton, platform, this.env.settings()).catch(() => null);
    if (!job || "error" in job) return null;
    const cached = await this.cache.cached(job.key);
    if (cached) {
      void this.cache.get({ request: requestId(platform, request), ...job }); // keeps the index current; a hit
      return cached.bytes;
    }
    void this.cache
      .get({ request: requestId(platform, request), ...job }, (e) => this.env.warn(`[myco] ${request.clip}: couldn't compile (${e}); it plays uncompressed.`))
      .then((clip) => {
        if (clip) onCompiled?.(clip.bytes);
      })
      .catch(() => {});
    return null;
  }

  /** Compiles a clip now (or finds it compiled): the compiled clip and its report, or why not. */
  async compileClip(request: CompiledClipRequest): Promise<ClipCompileResult> {
    const platform = this.env.platform();
    this.known.set(requestId(platform, request), request);
    const job = await prepareClipJob(request.clip, request.skeleton, platform, this.env.settings());
    if ("error" in job) return job;
    let error = "the compile failed";
    const clip = await this.cache.get({ request: requestId(platform, request), ...job }, (e) => (error = e));
    return clip ? { clip, problems: job.problems } : { error: `${request.clip}: ${error}` };
  }

  /** The report of the clip's current compile when it is made (none: null; nothing is compiled). */
  async clipReport(request: CompiledClipRequest): Promise<ClipReport | null> {
    const job = await prepareClipJob(request.clip, request.skeleton, this.env.platform(), this.env.settings()).catch(() => null);
    if (!job || "error" in job) return null;
    return (await this.cache.cached(job.key))?.report ?? null;
  }

  /**
   * A project file changed: the clips this session asked for that depend on it (the clip file, its model, the model's
   * sidecar, the skeleton they bind, `project.json`'s settings) compile again in the background, and so does a changed
   * clip source itself where its skeleton is known (`compileChangedSource`).
   */
  refresh(changed: string): Promise<void> {
    const path = normalizeAssetPath(changed);
    const touches = (r: CompiledClipRequest) => {
      if (path === "project.json") return true;
      const model = modelClipOf(r.clip);
      const file = model ? model.model : referencePath(r.clip);
      const skeleton = r.skeleton ? referencePath(r.skeleton) : null;
      return path === file || path === sidecarPath(file) || path === skeleton || (skeleton !== null && path === sidecarPath(skeleton));
    };
    const again = [...this.known.values()].filter(touches);
    return Promise.all([...again.map((r) => this.compileClip(r)), this.compileChangedSource(path, again)]).then(() => undefined);
  }

  /**
   * A changed clip source nothing has asked for yet compiles too, where its skeleton is known: an authored clip without
   * bone tracks, and every clip of a changed model (or model sidecar), which binds its model's skeleton.
   */
  private async compileChangedSource(path: string, done: readonly CompiledClipRequest[]): Promise<void> {
    const model = path.endsWith(SIDECAR_SUFFIX) ? path.slice(0, -SIDECAR_SUFFIX.length) : path;
    const clips: string[] = [];
    if (path.toLowerCase().endsWith(ANIM_SOURCE_SUFFIX)) {
      const data = await loadClipSource(path);
      if (data && !usesBones(data.source)) clips.push(path);
    } else if (isModelPath(model) && Assets.has(model)) {
      const a = await loadModel(model).then((m) => m.animation, () => undefined);
      for (const c of a?.clips ?? []) clips.push(`${model}${CLIP_SUB}${c.name}`);
    }
    const fresh = clips.filter((clip) => !done.some((r) => normalizeAssetPath(r.clip) === clip && r.skeleton === null));
    await Promise.all(fresh.map((clip) => this.compileClip({ clip, skeleton: null })));
  }

  /** Removes cached clips no current request names, and requests whose clip file is gone. Returns the files removed. */
  prune(): Promise<number> {
    return this.cache.prune((id) => {
      const clip = id.split("\n")[1] ?? "";
      const model = modelClipOf(clip);
      return Assets.has(model ? model.model : referencePath(clip));
    });
  }
}
