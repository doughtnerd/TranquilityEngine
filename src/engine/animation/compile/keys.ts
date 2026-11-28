/**
 * What a compiled clip is named by (ADR 0371 "Assets", "Compression"; T19):
 *
 * - **Content keys** for the editor's cache (`.myco/anim/<key>.anim.bin`, content-keyed like thumbnails, ADR 0061): a
 *   SHA-256 over the compiler version, the raw clip's bytes (made from the source by `rawClip.ts`, so a model clip's key
 *   follows its model file and sidecar), its skeleton's bytes and the settings record. Paths aren't hashed: a renamed
 *   clip keeps its key, and the same inputs give the same key on any machine.
 * - **Build paths** (ADR 0371: "by exports beside the source, as 0090 bakes models"): an authored clip
 *   `clips/walk.anim.json` compiles to `clips/walk.anim.bin`; a model's clip `models/hero.glb#Anim/Run` to
 *   `models/hero.glb.anim/Run.anim.bin` and its skeleton `models/hero.glb#Skeleton` to `models/hero.glb.anim/Skeleton.skel.bin`.
 *   An authored clip with bone tracks binds to the Animator's skeleton (0371), so its build file carries the skeleton's
 *   tag: `clips/walk.<8 hex of the skeleton reference>.anim.bin`. The runtime computes the same paths and loads the file
 *   when the build lists it.
 * - **The settings record** the editor module's `compress_clip` reads (`anim-editor-wasm`'s `settings` table).
 *
 * Pure. Internal: not public API.
 */
import { normalizeAssetPath } from "../../scene/assetPath";
import { ANIM_SOURCE_SUFFIX } from "../animSource";
import { referencePath } from "../shared";
import { TIMELINE_SUFFIX } from "../timeline";
import { contentHash, fnv1aHex } from "./hash";
import type { ResolvedCompression } from "./settings";

/**
 * @internal The compiler's version: `anim-editor-wasm`'s `COMPILER_VERSION` (a test checks they agree). Bump both when
 * the same inputs would compile to other bytes.
 */
export const CLIP_COMPILER_VERSION = 1;

/** @internal A compiled clip's file ending. */
export const COMPILED_CLIP_SUFFIX = ".anim.bin";
/** @internal A compiled skeleton's file ending. */
export const COMPILED_SKELETON_SUFFIX = ".skel.bin";
/** @internal The folder beside a model that holds its compiled sub-assets. */
const MODEL_FOLDER_SUFFIX = ".anim";

const CLIP_SUB = "#Anim/";
const SKELETON_SUB = "#Skeleton";

/** @internal A model clip reference's model and clip name (`models/hero.glb#Anim/Run` → both), or null. */
export function modelClipOf(ref: string): { readonly model: string; readonly name: string } | null {
  const p = normalizeAssetPath(ref);
  const at = p.indexOf(CLIP_SUB);
  if (at <= 0 || at + CLIP_SUB.length >= p.length) return null;
  return { model: p.slice(0, at), name: p.slice(at + CLIP_SUB.length) };
}

/** @internal A model skeleton reference's model (`models/hero.glb#Skeleton` → `models/hero.glb`), or null. */
export function modelSkeletonOf(ref: string): string | null {
  const p = normalizeAssetPath(ref);
  return p.endsWith(SKELETON_SUB) && p.length > SKELETON_SUB.length ? p.slice(0, -SKELETON_SUB.length) : null;
}

/**
 * @internal What a clip reference names (ADR 0460), by its ending in any letter case: an authored clip (`*.anim.json`,
 * "source"), a timeline (`*.timeline.json`), a compiled clip (`*.anim.bin`), a model's clip (`model.glb#Anim/Run`,
 * "model"), or null for anything else. The editor and the runtime ask this one question.
 */
export function clipRefKind(ref: string): "source" | "timeline" | "compiled" | "model" | null {
  if (modelClipOf(ref)) return "model";
  const p = normalizeAssetPath(ref).toLowerCase();
  if (p.endsWith(ANIM_SOURCE_SUFFIX)) return "source";
  if (p.endsWith(TIMELINE_SUFFIX)) return "timeline";
  if (p.endsWith(COMPILED_CLIP_SUFFIX)) return "compiled";
  return null;
}

/** @internal Whether a clip reference names a clip source the pipeline compiles: an authored clip or a model's clip. */
export const isClipSource = (ref: string): boolean => {
  const kind = clipRefKind(ref);
  return kind === "source" || kind === "model";
};

const encodeName = (name: string): string => encodeURIComponent(name).replace(/\./g, "%2E");

/**
 * @internal Where a build holds the compiled clip of `clipRef` (a clip source), bound to `skeletonRef` when it is an
 * authored clip with bone tracks (null otherwise; a model's clip always binds its model's skeleton).
 */
export function compiledClipPath(clipRef: string, skeletonRef: string | null): string {
  const model = modelClipOf(clipRef);
  if (model) return `${model.model}${MODEL_FOLDER_SUFFIX}/${encodeName(model.name)}${COMPILED_CLIP_SUFFIX}`;
  const path = referencePath(clipRef);
  const base = path.toLowerCase().endsWith(ANIM_SOURCE_SUFFIX) ? path.slice(0, -ANIM_SOURCE_SUFFIX.length) : path;
  const tag = skeletonRef ? `.${fnv1aHex(normalizeAssetPath(skeletonRef))}` : "";
  return `${base}${tag}${COMPILED_CLIP_SUFFIX}`;
}

/** @internal Where a build holds a model skeleton's compiled file (`model#Skeleton`), or null for another reference. */
export function compiledSkeletonPath(skeletonRef: string): string | null {
  const model = modelSkeletonOf(skeletonRef);
  return model ? `${model}${MODEL_FOLDER_SUFFIX}/Skeleton${COMPILED_SKELETON_SUFFIX}` : null;
}

/** @internal Settings record length (`anim-editor-wasm`'s `SETTINGS_LEN`). */
export const SETTINGS_RECORD_LEN = 8;

/**
 * @internal The settings record for `compress_clip`: the error in metres, the property error, the resample rate (the
 * resolved `maxRate` when the clip is faster, else 0), the highest bit rate (32), the default segment length, the
 * root-motion bone (-1: none) and its axes, and no raw form kept.
 */
export function compressionRecord(s: ResolvedCompression, clipRate: number, rootBone: number, rootAxes: number): Float32Array {
  const resample = s.maxRate !== null && s.maxRate < clipRate ? s.maxRate : 0;
  return Float32Array.from([s.error / 1000, s.propertyError, resample, 32, 0, rootBone >= 0 && rootAxes ? rootBone : -1, rootAxes, 0]);
}

/** @internal What a compiled clip is made from. */
export interface ClipCompileInputs {
  /** The raw clip (`compileRawClip`). */
  readonly raw: Uint8Array;
  /** Its skeleton's `myco.skel@1` bytes (empty for a clip without bone tracks). */
  readonly skeleton: Uint8Array;
  readonly record: Float32Array;
}

/** @internal A compiled clip's content key: 20 hex characters (see the module comment). */
export function clipContentKey(inputs: ClipCompileInputs): Promise<string> {
  const record = new Uint8Array(inputs.record.buffer, inputs.record.byteOffset, inputs.record.byteLength);
  return contentHash([`myco-anim/${CLIP_COMPILER_VERSION}`, inputs.raw, inputs.skeleton, record]);
}

/** @internal A cache file's key, or null for files that aren't cached clips (`<20 hex>.anim.bin` or `.report.json`). */
export function keyOfCacheFile(name: string): string | null {
  const m = /^([0-9a-f]{20})\.(anim\.bin|report\.json)$/.exec(name);
  return m ? m[1] : null;
}
