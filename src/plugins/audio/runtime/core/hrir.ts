// The spatial assets' loaders: the HRIR table (ADR 0157 H2, H5) and the MagLS bed filters (ADR 0162 A3), each fetched
// lazily, prepared for the context rate by the decoder worker (ADR 0331) and loaded into the core through the clip
// registry under a reserved id.
//
// H2: the HRIR table (IRCAM IRC_Composite_C, Chromium's `Composite.flac`) as a lazily fetched asset beside the wasm,
// loaded into the core as a CLIP_BEGIN/CLIP_CHUNK format = 2 clip under a reserved id (api-and-models 4.1 and 5). The clip
// registry keeps the blob, so a rebuild re-sends it with the other resident clips. Voices stay equal-power until the
// core reports clip event 4 (hrtfReady). The table isn't counted in clipMemoryMB.
//
// H5: the asset is the 10 x 24 responses of 256 frames at 44.1 kHz as Chromium decodes them, leading delays still in
// (tools/hrir/convert.mjs). At load the decoder worker runs each response through Chromium's own pipeline for the
// context rate (`myco_hrir_prepare`, native/audio/crates/audio-decode/src/spatial.rs: media's `SincResampler`, the
// zero-padding to `fft_size / 2`, `ExtractAverageGroupDelay`). The result is the wire's format 2 ("already at the context
// rate"; layout: audio-dsp's hrtf/database.rs): `fft_size / 2` frames per response and the delays at the context rate.
//
// ADR 0162 A3: the MagLS asset `src/engine/audio/magls-o3.bin` (made by `native/audio/tools/bake-magls`, designed from the
// HRIR set above, so the IRCAM licence carries over) is the 32-byte `MaglsHeader` ("MYBD", version 1, order 3, taps 256,
// the HRIR's rate 44.1 kHz, 12 reserved bytes) then f32 time responses `[16 channels][2 ears][taps]` (api-and-models
// 4.5, contract C6): 32,800 B. The worker prepares it for the context rate as it does the HRIR (`myco_magls_prepare`;
// C6: 256 taps up to 48 kHz, 512 from 88.2 kHz) and it loads through the clip registry as CLIP_BEGIN format 4 under
// `MAGLS_CLIP_ID` (0xFFFF0100), `channels` 1, `frames` = bytes / 4 (header included), on the first bed use; the
// registry keeps the blob so a rebuild re-sends it (S5). Until the core reports it resident, or if it fails to load,
// beds decode through the baked 16 -> 2 matrix (R9). `audio.spatial: "equalPower"` never fetches either asset.

import { sharedDecoderClient } from "../decoder/decoderClient";
import type { SpatialAssetKind } from "../decoder/protocol";
import { HRIR_CLIP_ID_FIRST, MAGLS_CLIP_ID, readMaglsHeader } from "../wire.generated";
import type { ClipRegistry, ReservedClipData } from "./clipRegistry";

export { MAGLS_CLIP_ID };

/**
 * ADR 0331: prepares a spatial asset (as fetched, at its own rate) for a context at `rate`: the HRIR table as clip format
 * 2, the MagLS filters as format 4. The default is the page's decoder worker (`DecoderClient.prepareSpatial`).
 */
export type SpatialPrepare = (kind: SpatialAssetKind, asset: ArrayBuffer, rate: number) => Promise<ArrayBuffer>;

const workerPrepare: SpatialPrepare = (kind, asset, rate) => sharedDecoderClient("default").prepareSpatial(kind, asset, rate);

/** Where the HRIR asset is served: beside this module in the dev server and the app builds, beside the bundle in the engine library. */
export function hrirUrl(): URL {
  return new URL("../wasm/myco_hrir.bin", import.meta.url);
}

/** Where the MagLS asset is served from (`src/engine/audio/magls-o3.bin`, resolved from this module). */
function maglsUrl(): URL {
  return new URL("../../../../engine/audio/magls-o3.bin", import.meta.url);
}

interface LoaderDeps {
  /** The registry the blob is loaded through (its reserved id). */
  readonly clips: ClipRegistry;
  /** The context's sample rate. */
  readonly sampleRate: number;
  /** Fetches the asset (default: `fetch` of its URL). */
  readonly fetchBytes?: () => Promise<ArrayBuffer>;
  /** Prepares the asset for a rate (default: the page's decoder worker). */
  readonly prepare?: SpatialPrepare;
  /** The single warning on failure (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

export type HrirLoaderDeps = LoaderDeps;
export type MaglsLoaderDeps = LoaderDeps;

export interface HrirLoader {
  /** Starts the lazy fetch on the first spatial play; later calls do nothing (a failed load is not retried). */
  ensure(): void;
  /** True once the core reported hrtfReady for the table (clip event 4). */
  readonly ready: boolean;
  /** H3: true once the fetch (or the preparation) failed: STATUS-style `hrtfLoadFailure` 1 on main. Optional so fakes satisfy it. */
  readonly failed?: boolean;
  /** H3: true once `ensure` started the load (`audio.spatial: "equalPower"` never starts it). Optional so fakes satisfy it. */
  readonly started?: boolean;
  /**
   * A3.4c, a rebuild into a context at `sampleRate`: the table is prepared again from the original asset for the new rate
   * and handed to the registry (`updateReserved`), which sends it to the rebuilt core when it lands. A load still under way
   * prepares for the new rate. A change under 0.5 Hz does nothing. Optional so fakes satisfy it.
   */
  retarget?(sampleRate: number): void;
}

export interface MaglsLoader {
  /** Starts the lazy fetch on the first bed use; later calls do nothing (a failed load is not retried). */
  ensure(): void;
  /** True once the core reported the filters resident (the registry's state for `MAGLS_CLIP_ID` is "ready"). */
  readonly ready: boolean;
  /** True once the fetch or the preparation failed (beds stay on the matrix decode). */
  readonly failed: boolean;
  /** True once `ensure` started the load. */
  readonly started: boolean;
  /** As `HrirLoader.retarget`, for the filters. */
  retarget(sampleRate: number): void;
}

interface AssetSpec {
  readonly kind: SpatialAssetKind;
  readonly id: number;
  readonly format: 2 | 4;
  readonly url: () => URL;
  /** The rate the blob's responses are at, read back from its header. */
  readonly rateOf: (blob: ArrayBuffer) => number;
  readonly failure: string;
}

/**
 * One loader's lifecycle: `ensure` fetches once, has the asset prepared for the current rate and calls
 * `clips.acquireReserved(id, { bytes, sampleRate, format })`; a failure sets `failed`, drops the kept asset and warns once
 * (`<failure> (<message>)`). `retarget` prepares the kept asset again and hands the pending blob to `updateReserved`.
 */
function createLoader(spec: AssetSpec, deps: LoaderDeps): MaglsLoader {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const prepare = deps.prepare ?? workerPrepare;
  const fetchBytes =
    deps.fetchBytes ??
    (async () => {
      const response = await fetch(spec.url());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  let started = false;
  let failed = false;
  let rate = deps.sampleRate;
  /** The asset as fetched (at its own rate), kept for a rebuild at another rate (A3.4c). */
  let original: ArrayBuffer | null = null;
  const fail = (err: unknown): void => warn(`${spec.failure} (${err instanceof Error ? err.message : String(err)})`);
  /** The blob for the current rate; prepared again when a retarget moved the rate while the worker was at it. */
  const blobFor = async (asset: ArrayBuffer): Promise<ReservedClipData> => {
    for (;;) {
      const at = rate;
      const bytes = await prepare(spec.kind, asset, at);
      if (at === rate) return { bytes, sampleRate: spec.rateOf(bytes), format: spec.format };
    }
  };
  return {
    ensure() {
      if (started) return;
      started = true;
      void (async () => {
        try {
          original = await fetchBytes();
          deps.clips.acquireReserved(spec.id, await blobFor(original));
        } catch (err) {
          original = null;
          failed = true;
          fail(err);
        }
      })();
    },
    get ready() {
      return deps.clips.state(spec.id) === "ready";
    },
    get failed() {
      return failed;
    },
    get started() {
      return started;
    },
    retarget(sampleRate) {
      if (Math.abs(sampleRate - rate) < 0.5) return;
      rate = sampleRate;
      // Not loaded yet: the load under way prepares for the new rate.
      if (!original || deps.clips.state(spec.id) === "idle") return;
      const next = blobFor(original);
      next.catch(fail);
      deps.clips.updateReserved?.(spec.id, next);
    },
  };
}

/** The HRIR loader: the table under the reserved id `HRIR_CLIP_ID_FIRST`, format 2. */
export function createHrirLoader(deps: HrirLoaderDeps): HrirLoader {
  return createLoader(
    {
      kind: "hrir",
      id: HRIR_CLIP_ID_FIRST,
      format: 2,
      url: hrirUrl,
      rateOf: (blob) => new DataView(blob).getFloat32(12, true),
      failure: "audio: the HRTF data failed to load, spatial voices stay equal-power",
    },
    deps,
  );
}

/** The MagLS loader: the bed filters under `MAGLS_CLIP_ID`, format 4. */
export function createMaglsLoader(deps: MaglsLoaderDeps): MaglsLoader {
  return createLoader(
    {
      kind: "magls",
      id: MAGLS_CLIP_ID,
      format: 4,
      url: maglsUrl,
      rateOf: (blob) => readMaglsHeader(new DataView(blob), 0).sampleRate,
      failure: "audio: the MagLS bed filters failed to load, beds decode through the equal-power matrix",
    },
    deps,
  );
}
