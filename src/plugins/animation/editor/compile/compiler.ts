// The editor's compile module (ADR 0370, 0371; T19, D79): `anim-editor-wasm`, a separate WebAssembly module from the
// runtime core, loaded by the editor's compile worker (`clipCompile.worker.ts`), by the in-thread fallback and by the
// exporters (Node). Games never load it. This wraps its exports in typed calls with plain arrays at the edges: no wasm
// type leaves this file.
//
// - `compressClip`: a raw `myco.anim@1` clip (`engine/animation/compile/rawClip.ts`) → the compressed clip and the
//   compressor's report (sizes, maximum errors: ADR 0371 "The compressor reports per-clip size and maximum error").
// - `compileSkeleton`: a `myco.skel@1` file re-written canonically, with roles and a profile when given.
// - `retargetCompressed`, `bakePoseDatabase`: the compressed retarget bake and the pose-database bake, for the
//   skeleton and pose-database tools (T54, T55).
// - `meterNodeModule`: a third-party node module validated and metered by `anim-meter` (T45t), for the node loader in
//   the editor (`runtime/features/nodes/loader.ts`) and the export step (`src/export/animationNodes.ts`).
//
// Internal to the Animation plugin.
import { curveKeyFloats, type CurveSampler } from "../../../../engine/animation/compile/curveKeys";
import type * as EditorWasm from "../../runtime/wasm/editor/myco_anim_editor.js";

/** @internal What the compressor measured for one clip (ADR 0371). Sizes in bytes; `maxError` in metres. */
export interface ClipReport {
  readonly rawSize: number;
  readonly compressedSize: number;
  readonly fileSize: number;
  /** Largest object-space bone error, metres. */
  readonly maxError: number;
  /** The bone and frame of `maxError`, or -1. */
  readonly worstBone: number;
  readonly worstFrame: number;
  /** Largest property-track error (track units) and its track, or -1. */
  readonly maxPropertyError: number;
  readonly worstTrack: number;
  /** Channels by mode: default, constant, animated. */
  readonly channels: readonly [number, number, number];
  /** Every error met its bound. */
  readonly withinBounds: boolean;
  readonly rotationFormat: "dropW" | "full";
}

/** @internal A compile's outcome. */
export type CompileOutcome = { readonly ok: true; readonly bytes: Uint8Array; readonly report: ClipReport } | { readonly ok: false; readonly error: string };

/** @internal One side of a retarget bake: a skeleton file, a profile (`encodeSkeletonProfile` bytes; empty: Humanoid) and its bone map. */
export interface RetargetSideInput {
  readonly skeleton: Uint8Array;
  readonly profile: Uint8Array;
  /** One bone per profile role, 0xFFFF unmapped. */
  readonly map: Uint16Array;
}

/** @internal A pose-database bake's clip: its file, its asset reference, and its tagged ranges (none: the whole clip, untagged). */
export interface PoseDbClipInput {
  readonly bytes: Uint8Array;
  readonly asset: string;
  readonly ranges: readonly { readonly start: number; readonly end: number; readonly tags: readonly string[] }[];
  /** T70: also bake a mirrored copy (through `PoseDbBakeSettings.mirror`). */
  readonly mirror?: boolean;
}

/** @internal T70: a custom feature, filled from each clip's curve track of its name (1–4 dims). */
export interface PoseDbCustomInput {
  readonly name: string;
  readonly dims: number;
  readonly weight: number;
}

/** @internal A pose-database bake's settings. */
export interface PoseDbBakeSettings {
  readonly skeletonName?: string;
  /** Sample rate, deviation floor, normalisation, KD-tree, leaf size, root bone (`posedb_bake`'s record). */
  readonly values?: readonly number[];
  /** T70: the mirror table for mirrored clips: the axis (0 X, 1 Y, 2 Z), then a `MIRROR`-node word per bone. */
  readonly mirror?: Uint32Array;
  /** T70: custom features, after the schema's. */
  readonly custom?: readonly PoseDbCustomInput[];
}

/** @internal A pose-database feature (`FeatureKind` id, bone or -1, weight, time offset). */
export interface PoseDbFeatureInput {
  readonly kind: number;
  readonly bone: number;
  readonly weight: number;
  readonly timeOffset: number;
}

/** @internal The compile module, loaded. */
export interface AnimationCompiler {
  /** The compiler version (`CLIP_COMPILER_VERSION` must equal it). */
  readonly version: number;
  /** The source hash the module was built from. */
  readonly sourceHash: string;
  compressClip(raw: Uint8Array, skeleton: Uint8Array, record: Float32Array): CompileOutcome;
  /**
   * T70: a source curve sampled at `frames` frames of `rate` Hz, frame `i` at `min(i / rate, end)` seconds, by the evaluator
   * the runtime core links (`CurveSampler`): what the raw clip's curve tracks hold, so the compiled clip matches the runtime
   * exactly. Zeros for an empty curve or one the module refuses (keys out of order, a non-finite number).
   */
  sampleCurve: CurveSampler;
  compileSkeleton(skeleton: Uint8Array, roles?: Uint16Array, profile?: string): { readonly bytes: Uint8Array } | { readonly error: string };
  retargetCompressed(source: RetargetSideInput, target: RetargetSideInput, options: { readonly alignChains: boolean; readonly rootAxes: number; readonly ikWeights: Float32Array; readonly record: Float32Array }, clip: Uint8Array): CompileOutcome;
  bakePoseDatabase(skeleton: Uint8Array, clips: readonly PoseDbClipInput[], schema: readonly PoseDbFeatureInput[], settings: PoseDbBakeSettings): { readonly bytes: Uint8Array } | { readonly error: string };
  /** A node module metered (fuel counter and checks, `anim-meter`), or why it was refused. */
  meterNodeModule(bytes: Uint8Array): { readonly bytes: Uint8Array } | { readonly error: string };
}

/** @internal The report record (`anim-editor-wasm`'s `report` table) as a `ClipReport`. */
function readReport(r: Float64Array): ClipReport {
  return {
    rawSize: r[0], compressedSize: r[1], fileSize: r[2], maxError: r[3], worstBone: r[4], worstFrame: r[5], maxPropertyError: r[6], worstTrack: r[7],
    channels: [r[8], r[9], r[10]], withinBounds: r[11] === 1, rotationFormat: r[12] === 1 ? "full" : "dropW",
  };
}

/** @internal The compile calls over an instantiated glue module. */
function compilerOver(glue: typeof EditorWasm): AnimationCompiler {
  const outcome = (bytes: Uint8Array): CompileOutcome => (bytes.length ? { ok: true, bytes, report: readReport(glue.last_report()) } : { ok: false, error: glue.last_error() || "the compile failed" });
  const plain = (bytes: Uint8Array) => (bytes.length ? { bytes } : { error: glue.last_error() || "the compile failed" });
  return {
    version: glue.compiler_version(),
    sourceHash: glue.source_hash(),
    compressClip: (raw, skeleton, record) => outcome(glue.compress_clip(raw, skeleton, record)),
    sampleCurve(curve, rate, end, frames) {
      if (curve.length === 0) return new Float32Array(frames);
      const out = glue.curve_sample(curveKeyFloats(curve), rate, end, frames);
      return out.length === frames ? out : new Float32Array(frames);
    },
    compileSkeleton: (skeleton, roles = new Uint16Array(0), profile = "") => plain(glue.skeleton_compile(skeleton, roles, profile)),
    meterNodeModule: (bytes) => plain(glue.meter_node_module(bytes)),
    retargetCompressed: (s, t, o, clip) => outcome(glue.retarget_bake_compressed(s.skeleton, s.profile, s.map, t.skeleton, t.profile, t.map, o.alignChains ? 1 : 0, clip, o.rootAxes, o.ikWeights, o.record)),
    bakePoseDatabase(skeleton, clips, schema, settings) {
      const total = clips.reduce((n, c) => n + c.bytes.length, 0);
      const all = new Uint8Array(total);
      let at = 0;
      for (const c of clips) {
        all.set(c.bytes, at);
        at += c.bytes.length;
      }
      const ranges: number[] = [];
      const tags: string[] = [];
      clips.forEach((c, i) => c.ranges.forEach((r) => {
        ranges.push(i, r.start, r.end, r.tags.length);
        tags.push(...r.tags);
      }));
      const features = schema.flatMap((f) => [f.kind, f.bone, f.weight, f.timeOffset]);
      const flags = clips.some((c) => c.mirror) ? Uint32Array.from(clips.map((c) => (c.mirror ? 1 : 0))) : new Uint32Array(0);
      const custom = settings.custom ?? [];
      return plain(
        glue.posedb_bake(
          skeleton,
          settings.skeletonName ?? "",
          all,
          Uint32Array.from(clips.map((c) => c.bytes.length)),
          clips.map((c) => c.asset).join("\n"),
          Float32Array.from(ranges),
          tags.join("\n"),
          Float32Array.from(features),
          Float32Array.from(settings.values ?? []),
          flags,
          settings.mirror ?? new Uint32Array(0),
          Float32Array.from(custom.flatMap((c) => [c.dims, c.weight])),
          custom.map((c) => c.name).join("\n"),
        ),
      );
    },
  };
}

let loading: Promise<AnimationCompiler> | null = null;

/** @internal The compile module, loaded once per page, worker or Node process (fetched in browsers, read from disk in Node). */
export function loadAnimationCompiler(): Promise<AnimationCompiler> {
  loading ??= (async () => {
    const glue = await import("../../runtime/wasm/editor/myco_anim_editor.js");
    const url = new URL("../../runtime/wasm/editor/myco_anim_editor_bg.wasm", import.meta.url);
    let source: URL | Uint8Array = url;
    if (url.protocol === "file:") {
      // Node has no fetch for file URLs. A variable specifier keeps bundlers from pulling node:fs into web builds.
      const fsModule = "node:fs/promises";
      const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile(path: URL): Promise<Uint8Array> };
      source = await readFile(url);
    }
    await glue.default({ module_or_path: source });
    return compilerOver(glue);
  })().catch((err: unknown) => {
    loading = null; // a failed fetch is tried again next time
    throw err;
  });
  return loading;
}
