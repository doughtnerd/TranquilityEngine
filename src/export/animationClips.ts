// Compiled clips and skeletons in game builds (ADR 0371: "Exports bake every referenced clip to `*.anim.bin`", beside
// the source as 0090 bakes models; T19). After models are baked, the build writer (0296) compiles every clip the
// project's scenes, prefabs and other JSON assets reference, for the build's platform, and every model skeleton they
// use, and lists the files in the manifest; the runtime then loads those (`runtime/features/clipSources.ts`) instead of
// making raw clips.
//
// - **Which clips:** every string in the build's JSON files that names a clip source (`*.anim.json`,
//   `model#Anim/<name>`). A model clip binds its model's skeleton; an authored clip with bone tracks binds the
//   Animator's skeleton (ADR 0371), which a build can't know in general, so it compiles once for each skeleton the build
//   references (`skeleton` fields and `model#Skeleton` strings), the runtime picking the one its Animator uses.
// - **Where:** `engine/animation/compile/keys.ts`'s build paths. A path the project already has a file at is left alone
//   (logged), as a model's baked file is.
// - **Settings** resolve per clip for the platform (project → folder rule → sidecar → platform), and each clip's size
//   and maximum error go to the log. A clip that can't compile is logged and plays its raw form.
//
// Runs while `Assets` serves the project (both exporters hold a project context during the build).
import { compiledClipPath, compiledSkeletonPath, isClipSource, modelClipOf, modelSkeletonOf } from "../engine/animation/compile/keys";
import { usesBones } from "../engine/animation/compile/rawClip";
import { animationSettingsOf } from "../engine/animation/compile/settings";
import type { ImportPlatform } from "../engine/scene/importSettings";
import type { AnimationCompiler } from "../plugins/animation/editor/compile/compiler";
import { prepareClipJob } from "../plugins/animation/editor/compile/jobs";
import { loadClipSource, loadSkeletonBytes } from "../plugins/animation/runtime/features/clipSources";
import { MANIFEST_FILE } from "./format";
import { copiedPath, type WebBuildPlan } from "./webBuild";
import { normalizeAssetPath } from "../engine/scene/assetPath";

export interface CompileClipsOptions {
  readonly platform: ImportPlatform;
  /** A project file's contents (text where the source holds it as text). */
  read(path: string): Promise<string | Uint8Array>;
  /** The editor's compile module (`loadAnimationCompiler`), loaded only when the build has a clip. */
  compiler(): Promise<AnimationCompiler>;
  log?(line: string): void;
}

const dec = new TextDecoder();
const ANIMATION_PLUGIN = "myco.animation";

/** Every string in a JSON value, with the key it sits under. */
function walkStrings(v: unknown, key: string, out: (s: string, key: string) => void): void {
  if (typeof v === "string") out(v, key);
  else if (Array.isArray(v)) for (const x of v) walkStrings(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walkStrings(x, k, out);
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** The build's clips compiled to `*.anim.bin` and its model skeletons to `*.skel.bin` (see the file header). */
export async function withCompiledClips(plan: WebBuildPlan, options: CompileClipsOptions): Promise<WebBuildPlan> {
  const log = options.log ?? (() => {});
  const readJson = async (path: string): Promise<unknown> => {
    try {
      const v = await options.read(path);
      return JSON.parse(typeof v === "string" ? v : dec.decode(v));
    } catch {
      return undefined;
    }
  };
  const projectJson = await readJson("project.json");
  const disabled = (projectJson as { plugins?: { disabled?: unknown } } | undefined)?.plugins?.disabled;
  if (Array.isArray(disabled) && disabled.includes(ANIMATION_PLUGIN)) return plan;

  const clips = new Set<string>();
  const skeletons = new Set<string>();
  for (const path of plan.copies) {
    if (!path.toLowerCase().endsWith(".json") || path === "project.json") continue;
    walkStrings(await readJson(path), "", (s, key) => {
      if (isClipSource(s)) clips.add(normalizeAssetPath(s));
      else if (modelSkeletonOf(s) !== null || (key === "skeleton" && s !== "")) skeletons.add(normalizeAssetPath(s));
    });
  }
  if (!clips.size && !skeletons.size) return plan;

  const settings = animationSettingsOf(projectJson);
  const binaries = new Map(plan.binaries ?? []);
  const added: string[] = [];
  const has = new Set(plan.copies);
  let compiler: AnimationCompiler | null = null;
  const getCompiler = async () => (compiler ??= await options.compiler());
  const place = (path: string, bytes: Uint8Array) => {
    if (has.has(path) || added.includes(path)) {
      if (has.has(path)) log(`${path} is already a project file; the build keeps it instead of the compiled one.`);
      return false;
    }
    binaries.set(copiedPath(path), bytes);
    added.push(path);
    return true;
  };

  for (const clip of clips) {
    const model = modelClipOf(clip);
    if (model) skeletons.add(`${model.model}#Skeleton`);
  }
  for (const clip of [...clips].sort()) {
    const data = await loadClipSource(clip);
    if (!data) {
      log(`${clip}: the clip can't be read; it isn't compiled.`);
      continue;
    }
    const binds = !data.ownSkeleton && usesBones(data.source);
    const targets: (string | null)[] = binds ? [...skeletons].sort() : [null];
    if (binds && !targets.length) log(`${clip}: its bone tracks bind an Animator's skeleton, and the build references none; it plays its raw form.`);
    for (const skeleton of targets) {
      const job = await prepareClipJob(clip, skeleton, options.platform, settings);
      if ("error" in job) {
        log(`${job.error} It plays its raw form.`);
        continue;
      }
      const out = (await getCompiler()).compressClip(job.raw, job.skeleton, job.record);
      if (!out.ok) {
        log(`${clip}${skeleton ? ` (for ${skeleton})` : ""} couldn't be compiled (${out.error}); it plays its raw form.`);
        continue;
      }
      const path = compiledClipPath(clip, data.ownSkeleton ? null : skeleton);
      if (!place(path, out.bytes)) continue;
      const r = out.report;
      log(`${clip}${skeleton ? ` (for ${skeleton})` : ""}: ${kb(r.rawSize)} raw → ${kb(r.fileSize)}, max error ${(r.maxError * 1000).toFixed(3)} mm${r.withinBounds ? "" : " (over its bound)"} → ${path}`);
    }
  }

  for (const skeleton of [...skeletons].sort()) {
    const path = compiledSkeletonPath(skeleton);
    if (!path) continue; // a skeleton file ships as it is
    const bytes = await loadSkeletonBytes(skeleton);
    if (!bytes) {
      log(`${skeleton}: the skeleton can't be read; it isn't compiled.`);
      continue;
    }
    const out = (await getCompiler()).compileSkeleton(bytes);
    if ("error" in out) log(`${skeleton} couldn't be compiled (${out.error}); the game reads it from its model.`);
    else place(path, out.bytes);
  }

  if (!added.length) return plan;
  const manifest = { ...plan.manifest, files: [...plan.manifest.files, ...added].sort() };
  const generated = new Map(plan.generated);
  generated.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...plan, manifest, generated, binaries };
}
