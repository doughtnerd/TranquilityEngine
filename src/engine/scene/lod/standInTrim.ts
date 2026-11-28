/**
 * Import-time hole trimming of occluder stand-ins (ADR 0447 §3) over the occlusion core's editor module
 * (`native/visibility/crates/vis-editor-wasm`, committed in `render/visibility/occlusion/wasm/editor/`). Loaded by LOD
 * generation (`generate.ts`) in the editor's worker and the export, never by games (they read the baked result).
 * Browsers and workers fetch `myco_visibility_editor_bg.wasm`, which Vite bundles as an asset beside this module; Node
 * reads it from disk. Internal: not public API.
 */
import type * as EditorWasm from "../../render/visibility/occlusion/wasm/editor/myco_visibility_editor.js";

/** ADR 0447 §3: stand-in triangles whose own error exceeds this fraction of LOD0's diagonal are dropped. */
const TRIM_FRACTION = 0.005;
/** The sampling lattice's spacing, as a fraction of the diagonal (the spike's and the crate's default). */
const SPACING_FRACTION = 0.005;

/** A trimmed stand-in, its errors as fractions of the original's bounding-box diagonal. */
export interface TrimmedStandIn {
  /** The kept triangles, three indices each, into the stand-in's positions. */
  readonly indices: Uint32Array;
  /** Per kept triangle, its own sampled error as a fraction of the diagonal (raw: the runtime doubles it). */
  readonly triangleErrors: Float32Array;
  /** Per kept triangle, its 3 edge neighbours (indices into the kept triangles; 0xFFFFFFFF = boundary). */
  readonly neighbors: Uint32Array;
  /** The largest kept error, as a fraction of the diagonal. */
  readonly maxError: number;
  /** Triangles dropped as closed holes. */
  readonly dropped: number;
}

/** Trims `standIn` (indices into `positions`) against `original` (indices into the same positions). */
export type StandInTrimmer = (positions: Float32Array, original: Uint32Array, standIn: Uint32Array) => TrimmedStandIn;

/** The trimmer over the module's glue. */
function trimmerOver(glue: typeof EditorWasm): StandInTrimmer {
  return (positions, original, standIn) => {
    const result = glue.trim_standin(positions, original, positions, standIn, TRIM_FRACTION, SPACING_FRACTION);
    try {
      const diagonal = result.diagonal();
      const raw = result.errors();
      const triangleErrors = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) triangleErrors[i] = diagonal > 0 ? raw[i] / diagonal : 0;
      return { indices: result.indices(), triangleErrors, neighbors: result.neighbors(), maxError: diagonal > 0 ? result.max_error() / diagonal : 0, dropped: result.dropped() };
    } finally {
      result.free();
    }
  };
}

let loading: Promise<StandInTrimmer> | null = null;

/** The trimmer, its module loaded once per worker, page or Node process. Rejects when the module can't be loaded. */
export function loadStandInTrimmer(): Promise<StandInTrimmer> {
  loading ??= (async () => {
    const glue = await import("../../render/visibility/occlusion/wasm/editor/myco_visibility_editor.js");
    const url = new URL("../../render/visibility/occlusion/wasm/editor/myco_visibility_editor_bg.wasm", import.meta.url);
    let source: URL | Uint8Array = url;
    if (url.protocol === "file:") {
      // Node has no fetch for file URLs. A variable specifier keeps bundlers from pulling node:fs into web builds.
      const fsModule = "node:fs/promises";
      const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile(path: URL): Promise<Uint8Array> };
      source = await readFile(url);
    }
    await glue.default({ module_or_path: source });
    return trimmerOver(glue);
  })().catch((err: unknown) => {
    loading = null; // a failed fetch is tried again next time
    throw err;
  });
  return loading;
}
