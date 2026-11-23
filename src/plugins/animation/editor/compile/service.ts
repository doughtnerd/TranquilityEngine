// The editor's clip compile service (ADR 0370, 0371; T19): one per open project, over its compile cache
// (`cache.ts`). It is the runtime's compiled-clip source while the project is open (`setCompiledClipSource`): an
// Animator asks for a clip, gets the compiled bytes when they are cached, and otherwise plays the raw form while the
// clip compiles in the worker. Clips compile again when their file changes (`refresh`, from `Assets.onChanged`).
//
// The small API for the Asset Inspector (0373, T54): `compileClip` (compile now, with the report) and `clipReport`
// (the report of the clip's current compile, if made).
import { Assets } from "../../../../engine/scene/Assets";
import type { ImportPlatform } from "../../../../engine/scene/importSettings";
import { sidecarPath } from "../../../../engine/scene/importSettings";
import { clipPathOf, modelClipOf } from "../../../../engine/animation/compile/keys";
import { referencePath } from "../../../../engine/animation/shared";
import type { AnimationProjectSettings } from "../../../../engine/animation/compile/settings";
import type { CompiledClipRequest, CompiledClipSource } from "../../runtime/features/clipSources";
import type { ClipCompileCache, CompiledClip } from "./cache";
import type { ClipReport } from "./compiler";
import { prepareClipJob } from "./jobs";

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

const requestId = (platform: ImportPlatform, r: CompiledClipRequest) => `${platform}\n${clipPathOf(r.clip)}\n${r.skeleton ? clipPathOf(r.skeleton) : ""}`;

export class ClipCompileService implements CompiledClipSource {
  /** Requests asked for this session, by id: what `refresh` compiles again. */
  private readonly known = new Map<string, CompiledClipRequest>();

  constructor(
    readonly cache: ClipCompileCache,
    private readonly env: ClipCompileEnv,
  ) {}

  /** The runtime's question (`CompiledClipSource`): the compiled bytes if cached; otherwise null, and the compile starts. */
  async compiled(request: CompiledClipRequest): Promise<Uint8Array | null> {
    const platform = this.env.platform();
    this.known.set(requestId(platform, request), request);
    const job = await prepareClipJob(request.clip, request.skeleton, platform, this.env.settings()).catch(() => null);
    if (!job || "error" in job) return null;
    const cached = await this.cache.cached(job.key);
    if (cached) {
      void this.cache.get({ request: requestId(platform, request), ...job }); // keeps the index current; a hit
      return cached.bytes;
    }
    void this.cache.get({ request: requestId(platform, request), ...job }, (e) => this.env.warn(`[myco] ${request.clip}: couldn't compile (${e}); it plays uncompressed.`));
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
   * sidecar, the skeleton they bind, `project.json`'s settings) compile again in the background.
   */
  refresh(changed: string): Promise<void> {
    const path = clipPathOf(changed);
    const touches = (r: CompiledClipRequest) => {
      if (path === "project.json") return true;
      const model = modelClipOf(r.clip);
      const file = model ? model.model : referencePath(r.clip);
      const skeleton = r.skeleton ? referencePath(r.skeleton) : null;
      return path === file || path === sidecarPath(file) || path === skeleton || (skeleton !== null && path === sidecarPath(skeleton));
    };
    const again = [...this.known.values()].filter(touches);
    return Promise.all(again.map((r) => this.compileClip(r))).then(() => undefined);
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
