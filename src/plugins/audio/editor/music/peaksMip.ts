// Ed1 (api-and-models §7): the pure half of the waveform peaks service. The decoder worker answers a `computePeaks` with
// one base level (int16 `[min, max]` pairs per `binFrames` frames per channel); this module builds the coarser mip
// levels from it and picks the level to draw for a visible span, so the segment view reads about one bin per pixel
// however far it is zoomed out. No DOM, no worker, no imports from other plugins.

/**
 * One resolution of a clip's peaks. `data` holds int16 `[min, max]` pairs, channel-major: every bin of channel 0, then
 * channel 1, and so on, `channels * bins * 2` values. Bin `i` of a channel covers frames `[i * binFrames, (i + 1) * binFrames)`;
 * the last bin may cover fewer.
 */
export interface PeakLevel {
  /** Frames per bin: the base level's (the request's `binFrames`), doubled for each mip. */
  readonly binFrames: number;
  /** Bins per channel. */
  readonly bins: number;
  readonly channels: number;
  readonly data: Int16Array;
}

/** A clip's whole peaks pyramid: `levels[0]` is the base level the worker sent; each next level has half the bins (rounded up). */
export interface PeakMips {
  readonly rate: number;
  readonly channels: number;
  /** Frames in the clip. */
  readonly frames: number;
  readonly levels: readonly PeakLevel[];
}

/** A run of bins `[first, end)` of one level (end exclusive), clamped to the level. */
export interface BinSpan {
  readonly first: number;
  readonly end: number;
}

export interface BuildMipsOptions {
  /** Stop adding levels once a level has this many bins or fewer. Default 1 (the whole clip in one bin). */
  readonly minBins?: number;
}

/**
 * Builds the mip levels above `base` (§7: "computed into mip levels"). Returns `[base, level 1, level 2, ...]` where
 * `base` is the same object as given. Level `n + 1` has `ceil(bins / 2)` bins of twice the `binFrames`; each bin is the
 * min of the two mins and the max of the two maxes under it, and an odd last bin is copied. Channels reduce
 * independently and stay channel-major. Stops at the first level with `minBins` bins or fewer (default 1). An empty base
 * (`bins` 0) returns `[base]`. Pure: `base.data` is not changed.
 */
export function buildMips(base: PeakLevel, options?: BuildMipsOptions): PeakLevel[] {
  // L-Ed1a
  void base;
  void options;
  throw new Error("L-Ed1a: buildMips is not implemented");
}

/**
 * Picks the level to draw for the visible span `[startFrame, endFrame)` over `widthPx` pixels: the coarsest level whose
 * `binFrames` is at most the frames per pixel (`(endFrame - startFrame) / widthPx`), so a pixel never covers less than
 * one bin and the view never reads more than about one bin per pixel. Zoomed in past the base level (frames per pixel
 * below `levels[0].binFrames`) it is level 0. A span that is empty or has a width below 1 gives 0. Returns an index into
 * `levels`. `levels` is non-empty and ordered finest first, as `buildMips` returns it.
 */
export function pickLevel(levels: readonly PeakLevel[], startFrame: number, endFrame: number, widthPx: number): number {
  // L-Ed1a
  void levels;
  void startFrame;
  void endFrame;
  void widthPx;
  throw new Error("L-Ed1a: pickLevel is not implemented");
}

/**
 * The bins of `level` that overlap the frames `[startFrame, endFrame)`: `first = floor(startFrame / binFrames)`,
 * `end = ceil(endFrame / binFrames)`, both clamped to `[0, level.bins]`; an empty or inverted span, or one outside the
 * clip, gives `{ first: n, end: n }` for some `n` (an empty run). The view draws only these.
 */
export function binSpan(level: PeakLevel, startFrame: number, endFrame: number): BinSpan {
  // L-Ed1a
  void level;
  void startFrame;
  void endFrame;
  throw new Error("L-Ed1a: binSpan is not implemented");
}

/** The `[min, max]` of bin `bin` of `channel` in `level`: a reading helper (`data[(channel * bins + bin) * 2]` and the next value). Out-of-range indexes are the caller's error. */
export function binAt(level: PeakLevel, channel: number, bin: number): { readonly min: number; readonly max: number } {
  const at = (channel * level.bins + bin) * 2;
  return { min: level.data[at], max: level.data[at + 1] };
}
