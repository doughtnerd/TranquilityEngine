/**
 * Automatic graphics quality (ADR 0055): a first guess at the quality tier from what the
 * platform says about the machine, and a frame-time monitor that steps down when the game runs
 * slowly. Pure (no DOM or WebGL access here; callers pass the data in), so the rules are
 * unit-tested without a browser.
 */

/** What the platform tells us about the machine (any may be missing). */
export interface DeviceInfo {
  /** The GPU renderer string (`WEBGL_debug_renderer_info`), where the browser exposes it. */
  gpu?: string;
  /** `navigator.hardwareConcurrency`. */
  cores?: number;
  /** `navigator.deviceMemory` (Chromium), in GB. */
  memoryGB?: number;
  /** Screen width times height in device pixels. Not used by the current rules. */
  screenPixels?: number;
}

/** A position among the project's tiers: lowest, the one above it, the project's default, or highest. */
export type TierGuess = "lowest" | "low" | "default" | "highest";

const SOFTWARE = ["swiftshader", "llvmpipe", "softpipe", "microsoft basic render", "software"];
const INTEGRATED = ["intel", "uhd", "iris", "hd graphics", "mali", "adreno", "powervr"];
const DISCRETE = ["nvidia", "geforce", "rtx", "gtx", "radeon rx", "radeon pro"];
/** `Apple M1` through `Apple M4` (and later): `apple m` plus a digit. */
const APPLE_M = /apple m\d/;
const APPLE_BIG = /\b(pro|max|ultra)\b/;

function hasAny(s: string, words: readonly string[]): boolean {
  return words.some((w) => s.includes(w));
}

/** Guess a tier from the device: software renderers lowest, integrated low, discrete default (highest when strong). */
export function guessTier(info: DeviceInfo): { guess: TierGuess; reason: string } {
  const gpu = (info.gpu ?? "").trim().toLowerCase();
  const { cores, memoryGB } = info;
  if (gpu === "") {
    if (cores !== undefined && cores <= 2) return { guess: "lowest", reason: `GPU unknown and only ${cores} cores` };
    return { guess: "default", reason: "GPU unknown" };
  }
  if (hasAny(gpu, SOFTWARE)) return { guess: "lowest", reason: "software renderer" };
  const apple = gpu.includes("apple");
  const appleBig = apple && APPLE_M.test(gpu) && APPLE_BIG.test(gpu);
  if (!appleBig && (hasAny(gpu, INTEGRATED) || gpu.includes("apple gpu") || (apple && APPLE_M.test(gpu)))) {
    if (memoryGB !== undefined && memoryGB < 4) return { guess: "lowest", reason: `integrated or mobile GPU with ${memoryGB} GB memory` };
    return { guess: "low", reason: "integrated or mobile GPU" };
  }
  if (appleBig || hasAny(gpu, DISCRETE)) {
    const strong = memoryGB !== undefined ? (cores ?? 0) >= 8 && memoryGB >= 8 : (cores ?? 0) >= 12;
    if (strong) return { guess: "highest", reason: "high-end GPU with plenty of cores and memory" };
    return { guess: "default", reason: "discrete or high-end GPU" };
  }
  if (cores !== undefined && cores <= 2) return { guess: "lowest", reason: `GPU not recognised and only ${cores} cores` };
  return { guess: "default", reason: "GPU not recognised" };
}

/**
 * Map a guess onto the project's tier names (lowest first) and its default tier name. With few
 * tiers the positions collapse: "low" is the second tier (or the lowest if there is one tier).
 */
export function tierForGuess(guess: TierGuess, tiers: readonly string[], defaultTier: string): string {
  if (tiers.length === 0) return defaultTier;
  switch (guess) {
    case "lowest":
      return tiers[0];
    case "low":
      return tiers[Math.min(1, tiers.length - 1)];
    case "highest":
      return tiers[tiers.length - 1];
    default:
      return defaultTier;
  }
}

export interface FrameMonitorOptions {
  /** The frame rate the game aims for (60 by default in the project's `targetFrameRate`). */
  targetFps: number;
  /** Seconds of watching after the initial settle (default 10). */
  watchSeconds?: number;
  /** Seconds to wait before judging, at the start and after each step down (default 3). */
  settleSeconds?: number;
  /** Median frame time above this many times the target's frame time means too slow (default 1.4). */
  slowFactor?: number;
  /** Frames longer than this many seconds are load hitches and ignored (default 0.25). */
  hitchSeconds?: number;
}

/** How much recent frame time the median is taken over, and the least data needed to judge. */
const WINDOW_SECONDS = 1;
const MIN_WINDOW_SECONDS = 0.5;

/** Watches frame times after the first scene loads; says when to step down a tier (never up). */
export class FrameMonitor {
  private readonly threshold: number;
  private readonly watchSeconds: number;
  private readonly settleSeconds: number;
  private readonly hitchSeconds: number;
  private settleLeft: number;
  private budgetLeft: number;
  private window: number[] = [];
  private windowSum = 0;
  private atLowest = false;
  private finished = false;

  constructor(options: FrameMonitorOptions) {
    this.watchSeconds = options.watchSeconds ?? 10;
    this.settleSeconds = options.settleSeconds ?? 3;
    this.hitchSeconds = options.hitchSeconds ?? 0.25;
    this.threshold = (options.slowFactor ?? 1.4) / Math.max(options.targetFps, 1);
    this.settleLeft = this.settleSeconds;
    this.budgetLeft = this.watchSeconds;
  }

  /** Feed one frame's duration in seconds; returns "stepDown" when the tier should drop now, "done" once watching is over, else "watching". */
  frame(dt: number): "watching" | "stepDown" | "done" {
    if (this.finished) return "done";
    if (!(dt > 0) || dt > this.hitchSeconds) return "watching"; // a load hitch (or a bad value): not counted
    if (this.settleLeft > 0) {
      this.settleLeft -= dt;
      return "watching";
    }
    this.budgetLeft -= dt;
    if (this.budgetLeft <= 0) {
      this.finished = true;
      return "done";
    }
    this.window.push(dt);
    this.windowSum += dt;
    while (this.window.length > 1 && this.windowSum - this.window[0] >= WINDOW_SECONDS) this.windowSum -= this.window.shift()!;
    if (this.atLowest || this.windowSum < MIN_WINDOW_SECONDS) return "watching";
    return median(this.window) > this.threshold ? "stepDown" : "watching";
  }

  /** Call after stepping down: restarts a settle period, then watches again (the total watching budget continues, extended by the settle). */
  steppedDown(): void {
    this.settleLeft = this.settleSeconds;
    this.budgetLeft += this.settleSeconds;
    this.window = [];
    this.windowSum = 0;
  }

  /** True when there's nowhere lower to go: `frame()` then never asks to step down, and just runs out the budget. */
  setAtLowest(atLowest: boolean): void {
    this.atLowest = atLowest;
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
