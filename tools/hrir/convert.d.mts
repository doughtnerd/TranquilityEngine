// Types for convert.mjs (so the TypeScript tests can import it under strict mode).

export const CHROMIUM_COMMIT: string;
export const URL_PATTERN: string;

/** The 240 file names, azimuth-major (T 000..345, P 315,330,345,000..090). */
export function sourceNames(): string[];

/** Direction index d = azIdx * 10 + elIdx, from a file name. */
export function directionIndex(name: string): number;

/** ExtractAverageGroupDelay on a 256-frame response; modifies `ir` in place and returns the removed delay in frames. */
export function extractAverageGroupDelay(ir: Float64Array): number;

/** Parses a RIFF PCM16 stereo 44.1 kHz 256-frame WAV; samples are s / 32768. */
export function parseWav(bytes: Uint8Array, name?: string): { left: Float64Array; right: Float64Array; peak: number };

export function convert(wavs: Map<string, Uint8Array>): {
  blob: Uint8Array;
  peak: number;
  delays: Float32Array;
  rawPeak: number;
  delayRemovedPeak: number;
  scale: number;
};
