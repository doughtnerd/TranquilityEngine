// Types for convert.mjs (so the TypeScript tests can import it under strict mode).

export const CHROMIUM_COMMIT: string;
export const URL_PATTERN: string;
export const MIRROR_URL_PATTERN: string;
/** Bytes in the asset: the 16-byte header, then 240 x 256 stereo int16 frames. */
export const ASSET_BYTES: number;

/** The 240 file names, azimuth-major (T 000..345, P 315,330,345,000..090). */
export function sourceNames(): string[];

/** Direction index d = azIdx * 10 + elIdx, from a file name. */
export function directionIndex(name: string): number;

/** Parses a RIFF PCM16 stereo 44.1 kHz 256-frame WAV; samples as stored, peak as a fraction of full scale. */
export function parseWav(bytes: Uint8Array, name?: string): { left: Int16Array; right: Int16Array; peak: number };

/** The asset (header, then the responses as stored, delays in) from the 240 WAVs. */
export function convert(wavs: Map<string, Uint8Array>): { blob: Uint8Array; peak: number };
