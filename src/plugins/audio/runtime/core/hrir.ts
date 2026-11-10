// H2: the HRIR table (IRCAM IRC_Composite_C as Chromium processed it) as a lazily fetched asset beside the wasm, loaded
// into the core as a CLIP_BEGIN/CLIP_CHUNK format = 2 clip under a reserved id (api-and-models 4.1 and 5). The clip
// registry keeps the blob, so a rebuild re-sends it with the other resident clips. Voices stay equal-power until the
// core reports clip event 4 (hrtfReady). The table isn't counted in clipMemoryMB.
//
// The asset is 10 x 24 responses of 256 frames at 44.1 kHz with their leading delay removed (tools/hrir/convert.mjs;
// layout: audio-dsp's hrtf/database.rs). At load the responses are resampled to the context rate and the ear delays
// scaled by the rate ratio, which is what the wire's format 2 asks for ("already at the context rate").

import type { ClipRegistry } from "./clipRegistry";

/** The reserved HRIR clip id (generation 0xFF, index 0xFF0000); the range is 0xFFFF0000..0xFFFF00FF. */
export const HRIR_CLIP_ID = 0xffff0000;

const HEADER_BYTES = 16;
const FORMAT_HRIR = 2;
/** Half-width of the resampling kernel in source frames (Hann-windowed sinc). */
const SINC_HALF_WIDTH = 16;

/** Header of the blob (all little-endian): `u32 elevations; u32 azimuths; u32 irLength; f32 rate`. */
export interface HrirHeader {
  readonly elevations: number;
  readonly azimuths: number;
  readonly irLength: number;
  readonly rate: number;
}

/** Reads the 16-byte header; throws on a short blob. */
export function readHrirHeader(blob: ArrayBuffer): HrirHeader {
  if (blob.byteLength < HEADER_BYTES) throw new Error("audio: the HRIR blob is shorter than its header");
  const view = new DataView(blob);
  return {
    elevations: view.getUint32(0, true),
    azimuths: view.getUint32(4, true),
    irLength: view.getUint32(8, true),
    rate: view.getFloat32(12, true),
  };
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/**
 * Resamples a blob at its own rate to `rate`: each response by Hann-windowed sinc (low-passed when going down), each ear
 * delay scaled by the rate ratio; the response length becomes round(irLength * ratio). Returns a new blob (the input
 * itself when the rates match). Throws on a blob that isn't the documented layout.
 */
export function resampleHrir(blob: ArrayBuffer, rate: number): ArrayBuffer {
  const head = readHrirHeader(blob);
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`audio: bad HRIR target rate ${rate}`);
  const directions = head.elevations * head.azimuths;
  const tableEnd = HEADER_BYTES + 8 * directions;
  const inLen = head.irLength;
  if (directions === 0 || inLen === 0 || blob.byteLength < tableEnd + 4 * directions * inLen) throw new Error("audio: the HRIR blob is truncated");
  if (Math.abs(head.rate - rate) < 0.5) return blob;
  const ratio = rate / head.rate;
  const outLen = Math.max(1, Math.round(inLen * ratio));
  const out = new ArrayBuffer(tableEnd + 4 * directions * outLen);
  const outView = new DataView(out);
  outView.setUint32(0, head.elevations, true);
  outView.setUint32(4, head.azimuths, true);
  outView.setUint32(8, outLen, true);
  outView.setFloat32(12, rate, true);
  const inView = new DataView(blob);
  for (let i = 0; i < directions * 2; i++) outView.setFloat32(HEADER_BYTES + i * 4, inView.getFloat32(HEADER_BYTES + i * 4, true) * ratio, true);

  const cutoff = Math.min(1, ratio);
  const reach = Math.ceil(SINC_HALF_WIDTH / cutoff);
  const source = new Float32Array(inLen);
  for (let d = 0; d < directions; d++) {
    for (let ear = 0; ear < 2; ear++) {
      const inBase = tableEnd + d * inLen * 4 + ear * 2;
      for (let i = 0; i < inLen; i++) source[i] = inView.getInt16(inBase + i * 4, true) / 32768;
      const outBase = tableEnd + d * outLen * 4 + ear * 2;
      for (let j = 0; j < outLen; j++) {
        const x = j / ratio;
        const center = Math.floor(x);
        let sum = 0;
        for (let i = Math.max(0, center - reach + 1); i <= Math.min(inLen - 1, center + reach); i++) {
          const t = x - i;
          const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (reach + 1));
          sum += source[i]! * cutoff * sinc(cutoff * t) * w;
        }
        outView.setInt16(outBase + j * 4, Math.max(-32768, Math.min(32767, Math.round(sum * 32768))), true);
      }
    }
  }
  return out;
}

/** Where the asset is served: beside this module in the dev server and the app builds, beside the bundle in the engine library. */
export function hrirUrl(): URL {
  return new URL("../wasm/myco_hrir.bin", import.meta.url);
}

export interface HrirLoaderDeps {
  /** The registry the table is loaded through (reserved id `HRIR_CLIP_ID`). */
  readonly clips: ClipRegistry;
  /** The context's sample rate. */
  readonly sampleRate: number;
  /** Fetches the asset (default: `fetch(hrirUrl())`). */
  readonly fetchBytes?: () => Promise<ArrayBuffer>;
  /** The single warning on failure (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

export interface HrirLoader {
  /** Starts the lazy fetch on the first spatial play; later calls do nothing (a failed load is not retried). */
  ensure(): void;
  /** True once the core reported hrtfReady for the table (clip event 4). */
  readonly ready: boolean;
  /**
   * A3.4c, a rebuild into a context at `sampleRate`: the table is resampled again from the original asset for the new
   * rate and the registry's kept blob replaced (`updateReserved`), so the rebuild's re-send carries it. A fetch still
   * under way resamples for the new rate when it lands. Optional so fakes satisfy it.
   */
  retarget?(sampleRate: number): void;
}

export function createHrirLoader(deps: HrirLoaderDeps): HrirLoader {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const fetchBytes =
    deps.fetchBytes ??
    (async () => {
      const response = await fetch(hrirUrl());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  let started = false;
  let rate = deps.sampleRate;
  /** The asset as fetched (at its own rate), kept for a rebuild at another rate (A3.4c). */
  let original: ArrayBuffer | null = null;
  const fail = (err: unknown): void => warn(`audio: the HRTF data failed to load, spatial voices stay equal-power (${err instanceof Error ? err.message : String(err)})`);
  return {
    ensure() {
      if (started) return;
      started = true;
      void (async () => {
        try {
          original = await fetchBytes();
          const bytes = resampleHrir(original, rate);
          deps.clips.acquireReserved(HRIR_CLIP_ID, { bytes, sampleRate: readHrirHeader(bytes).rate, format: FORMAT_HRIR });
        } catch (err) {
          original = null;
          fail(err);
        }
      })();
    },
    get ready() {
      return deps.clips.state(HRIR_CLIP_ID) === "ready";
    },
    retarget(sampleRate) {
      if (Math.abs(sampleRate - rate) < 0.5) return;
      rate = sampleRate;
      if (!original || deps.clips.state(HRIR_CLIP_ID) === "idle") return;
      try {
        const bytes = resampleHrir(original, rate);
        deps.clips.updateReserved?.(HRIR_CLIP_ID, { bytes, sampleRate: readHrirHeader(bytes).rate, format: FORMAT_HRIR });
      } catch (err) {
        fail(err);
      }
    },
  };
}
