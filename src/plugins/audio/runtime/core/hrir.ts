// H2 (skeleton): the HRIR table as a lazily fetched asset, loaded into the core as a CLIP_BEGIN/CLIP_CHUNK format = 2
// clip under a reserved id (api-and-models 4.1 and 5). Voices stay equal-power until the core reports clip event 4.

/** The first reserved HRIR clip id (generation 0xFF, index 0xFF0000); the range is 0xFFFF0000..0xFFFF00FF. */
export const HRIR_CLIP_ID = 0xffff0000;

/** Header of the committed blob (all little-endian): `u32 elevations; u32 azimuths; u32 irLength; f32 rate`. */
export interface HrirHeader {
  readonly elevations: number;
  readonly azimuths: number;
  readonly irLength: number;
  readonly rate: number;
}

/** Reads the 16-byte header; throws on a short blob. */
export function readHrirHeader(_blob: ArrayBuffer): HrirHeader {
  throw new Error("H2: not implemented");
}

/** Resamples a blob at its own rate to `rate`: IRs by windowed sinc, ear delays scaled by the rate ratio. Returns a new blob. */
export function resampleHrir(_blob: ArrayBuffer, _rate: number): ArrayBuffer {
  throw new Error("H2: not implemented");
}

export interface HrirLoader {
  /** Starts the lazy fetch on the first spatial play; idempotent. */
  ensure(): void;
  /** True once the core reported clip event 4 (hrtfReady). */
  readonly ready: boolean;
  /** Feeds a clip event from the STATUS mirror. */
  applyClipEvent(id: number, code: number): void;
}

export function createHrirLoader(): HrirLoader {
  throw new Error("H2: not implemented");
}
