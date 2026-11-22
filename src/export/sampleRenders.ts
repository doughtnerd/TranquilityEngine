// Baked samples in a build (ADR 0328: "`npm run export` renders and ships the result"). A sample whose edits hold an
// effect chain plays its effects only through a render (the runtime applies trim, loops and normalisation live, never
// the chain), so a build renders every sample with enabled baked effects that has no render in the project (no
// `sample.source`, or one that names a missing file) and ships the render: `<stem>.render-<hash>.wav` beside the source
// audio, the sidecar (or derived sample) in the build pointing at it with `sample.source`. The project isn't changed.
//
// The render is the Studio's (`renderSample`, the Rust kernels) on the source decoded from WAV (`decodeWavPcm`); a render
// the Studio already cached in `.myco/cache/samples/` under the same content hash is shipped as it is. A source that
// isn't a WAV can't be decoded here: it ships without its effects, said through `log` (Flatten it in the Studio).
import { isDerivedSamplePath } from "../engine/audio/sample/format";
import type { OfflineEffectHost } from "../engine/audio/sample/offlinePlugins";
import { cachedRender, type RenderStore } from "../engine/audio/sample/renderCache";
import { resolveSample, type SampleReader } from "../engine/audio/sample/resolve";
import { needsRender, renderSample } from "../engine/audio/sample/sampleRender";
import { decodeWavPcm } from "../engine/audio/sample/wavPcm";
import { isSidecarPath, parseImportSettings, sidecarPath } from "../engine/scene/importSettings";
import { MANIFEST_FILE, type GameManifest } from "./format";
import { copiedPath, type WebBuildPlan } from "./webBuild";

/** How the render step reads the project: any project path, `.myco/` included (rejects when it isn't there). */
export type ReadProjectFile = (path: string) => Promise<string | Uint8Array>;

const decoder = new TextDecoder();
const textOf = (v: string | Uint8Array) => (typeof v === "string" ? v : decoder.decode(v));
const bytesOf = (v: string | Uint8Array) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
const isWav = (p: string) => /\.wave?$/i.test(p);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The build's file for a render of `source` with content hash `key`. */
export const exportRenderPath = (source: string, key: string): string => `${source.replace(/\.[^./]+$/, "")}.render-${key.slice(0, 12)}.wav`;

/** The plan with every baked sample that needs it rendered (see the file header). */
export async function withRenderedSamples(
  plan: WebBuildPlan,
  read: ReadProjectFile,
  log: (line: string) => void = () => {},
  /** ADR 0338 §7: where plugin effects render, the build's own modules (`withAudioEffects`); null: they pass through. */
  plugins: OfflineEffectHost | null = null,
): Promise<WebBuildPlan> {
  const files = new Set(plan.copies);
  const json = new Map<string, unknown>();
  const readJson = async (path: string): Promise<unknown> => {
    if (!json.has(path)) {
      let value: unknown;
      try {
        value = JSON.parse(textOf(await read(path)));
      } catch {
        value = undefined;
      }
      json.set(path, value);
    }
    return json.get(path);
  };
  // Every sample that may need a render: audio files with a sidecar, and derived samples.
  const samples = plan.copies.filter((p) => isDerivedSamplePath(p) || (isSidecarPath(p) && files.has(p.slice(0, -".meta.json".length)))).map((p) => (isDerivedSamplePath(p) ? p : p.slice(0, -".meta.json".length)));
  if (samples.length === 0) return plan;
  for (const p of samples) await readJson(isDerivedSamplePath(p) ? p : sidecarPath(p));
  for (const p of plan.copies) if (isDerivedSamplePath(p)) await readJson(p);
  const reader: SampleReader = {
    has: (p) => files.has(p),
    json: (p) => json.get(p),
    sidecar: (p) => {
      const raw = json.get(sidecarPath(p));
      const s = parseImportSettings(raw === undefined ? null : raw, sidecarPath(p)).settings;
      return { sample: s.sample, loopStart: s.loopStart, loopEnd: s.loopEnd };
    },
  };
  // The Studio's cache, read only: the build never writes into the project.
  const store: RenderStore = { read: (path) => read(path).then(bytesOf, () => null), write: async () => undefined };

  const binaries = new Map(plan.binaries ?? []);
  const generated = new Map(plan.generated);
  const added: string[] = [];
  for (const path of samples) {
    let r;
    try {
      r = resolveSample(path, reader);
    } catch {
      continue;
    }
    if (!r.edits || !needsRender(r.edits) || r.render !== null || r.source === "") continue;
    if (!isWav(r.source)) {
      log(`${path}: its baked effects can't be rendered by the export (${r.source} isn't a WAV); it ships without them. Flatten it in the Studio first.`);
      continue;
    }
    let source: Uint8Array;
    try {
      source = bytesOf(await read(r.source));
    } catch {
      continue;
    }
    const edits = { ...r.edits };
    delete edits.source;
    let out;
    try {
      out = await cachedRender(store, source, edits, async () => {
        const pcm = decodeWavPcm(source);
        if (!pcm) throw new Error(`${r.source} isn't a WAV the export can read`);
        return pcm;
      }, (p, e) => renderSample(p, e, { plugins }), plugins);
    } catch (err) {
      log(`${path}: its baked effects couldn't be rendered (${(err as Error)?.message ?? err}); it ships without them.`);
      continue;
    }
    for (const w of out.warnings) log(`${path}: ${w}`);
    const render = exportRenderPath(r.source, out.key);
    if (!binaries.has(copiedPath(render))) {
      binaries.set(copiedPath(render), out.bytes);
      added.push(render);
    }
    // Point the sample at the render in the build: the sidecar's block, or the derived sample's own.
    const file = isDerivedSamplePath(path) ? path : sidecarPath(path);
    const raw = json.get(file);
    const doc: Record<string, unknown> = isRecord(raw) ? { ...raw } : { format: "myco.import@1" };
    doc.sample = { ...(isRecord(doc.sample) ? doc.sample : {}), source: render };
    generated.set(copiedPath(file), `${JSON.stringify(doc, null, 2)}\n`);
    log(`${path}: rendered its baked effects${out.hit ? " (from the Studio's render cache)" : ""} into ${render}.`);
  }
  if (!added.length && generated.size === plan.generated.size) return plan;
  const manifest: GameManifest = { ...plan.manifest, files: [...plan.manifest.files, ...added].sort() };
  generated.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...plan, manifest, generated, binaries };
}
