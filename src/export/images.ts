// Image processing for game builds (ADR 0119): an image whose sidecar, resolved for the build's
// platform, sets `maxSize` or a `compression` is shipped resized and/or re-encoded. The planner
// here is pure; the codec comes in as an `ImageTranscoder` (sharp in Node: imagesNode.ts; the
// browser's own in the editor: imagesBrowser.ts), and the files come in through callbacks.
import { IMPORT_FORMAT, SIDECAR_SUFFIX, parseImportSettings, resolveImportSettings, type ImportPlatform, type TextureCompression } from "../engine/scene/importSettings";
import { copiedPath, type WebBuildPlan } from "./webBuild";

/** Image files a build can resize and re-encode. */
const PROCESSED = /\.(png|jpe?g|webp)$/i;

/** WebP quality for each compression level (`none` keeps the file's format). */
export const COMPRESSION_QUALITY: Readonly<Record<Exclude<TextureCompression, "none">, number>> = { low: 90, normal: 75, high: 50 };

/** What to do to one image. */
export interface TranscodeRequest {
  /** Longest side to fit in, 0 = keep the size. */
  maxSize: number;
  /** Re-encode as WebP (`lossless` for point-filtered images), or null to keep the file's own format. */
  webp: { quality: number; lossless: boolean } | null;
  /** Resize without smoothing (point-filtered pixel art). */
  nearest: boolean;
  /** The file's extension, lower case, no dot (`png`). */
  ext: string;
}

export interface TranscodeResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** The decoded image's size before resizing. */
  sourceWidth: number;
  sourceHeight: number;
}

export type ImageTranscoder = (bytes: Uint8Array, request: TranscodeRequest) => Promise<TranscodeResult>;

/** The request for an image whose settings resolved for a platform are `s`, or null when they leave it alone. */
export function transcodeRequest(path: string, s: { maxSize: number; compression: TextureCompression; filter: "linear" | "point" }): TranscodeRequest | null {
  if (s.maxSize <= 0 && s.compression === "none") return null;
  const quality = s.compression === "none" ? null : COMPRESSION_QUALITY[s.compression];
  return {
    maxSize: s.maxSize,
    webp: quality === null ? null : { quality, lossless: s.filter === "point" },
    nearest: s.filter === "point",
    ext: path.slice(path.lastIndexOf(".") + 1).toLowerCase(),
  };
}

export interface ProcessImagesOptions {
  /** The platform the build is for: its overrides win in each sidecar. */
  platform: ImportPlatform;
  /** A project file's text (a sidecar), or undefined. */
  readText: (path: string) => Promise<string | undefined> | string | undefined;
  /** A project file's bytes. */
  readBytes: (path: string) => Promise<Uint8Array>;
  transcode: ImageTranscoder;
  log?: (line: string) => void;
}

/**
 * Process the plan's images: each image its sidecar says to resize or compress gets a processed
 * file at the same path (written over the copy), and, if it was resized, a `sourceSize` in its
 * sidecar so the game still measures it at its authored size. Images that can't be processed
 * (undecodable, or no smaller) are shipped as they are, with a line in `log` for the first.
 */
export async function processImages(plan: WebBuildPlan, options: ProcessImagesOptions): Promise<WebBuildPlan> {
  const log = options.log ?? (() => {});
  const binaries = new Map(plan.binaries ?? []);
  const generated = new Map(plan.generated);
  let before = 0, after = 0, count = 0;
  for (const path of plan.copies) {
    if (!PROCESSED.test(path)) continue;
    const sidecar = path + SIDECAR_SUFFIX;
    if (!plan.copies.includes(sidecar)) continue;
    const text = await options.readText(sidecar);
    if (text === undefined) continue;
    let raw: Record<string, unknown>;
    let request: TranscodeRequest | null;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
      const { settings } = parseImportSettings(raw, sidecar);
      request = transcodeRequest(path, resolveImportSettings(settings, options.platform));
    } catch {
      continue; // a bad sidecar loads as defaults in the game too
    }
    if (!request) continue;
    try {
      const original = await options.readBytes(path);
      const result = await options.transcode(original, request);
      const resized = result.width !== result.sourceWidth || result.height !== result.sourceHeight;
      if (!resized && result.bytes.length >= original.length) continue; // no gain: keep the original
      binaries.set(copiedPath(path), result.bytes);
      if (resized) generated.set(copiedPath(sidecar), `${JSON.stringify({ ...raw, format: raw.format ?? IMPORT_FORMAT, sourceSize: [result.sourceWidth, result.sourceHeight] }, null, 2)}\n`);
      before += original.length;
      after += result.bytes.length;
      count++;
    } catch (err) {
      log(`${path} couldn't be processed (${(err as Error)?.message ?? err}); the game gets the original.`);
    }
  }
  if (count) log(`Processed ${count} image${count === 1 ? "" : "s"} for ${options.platform}: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB.`);
  return count ? { ...plan, generated, binaries } : plan;
}
