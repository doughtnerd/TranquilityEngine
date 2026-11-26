// The conformance harness's stand-in for the renderer's `animate` hook (ADR 0419 wave Y2), ported from Svelte's own test
// helper (tests/animation-helpers.js at 5.59.2), which stands in for `element.animate` in its DOM runs: keyframes are
// interpolated on the test's clock (`raf.tick(ms)`) and written to the node's inline style, so the fixtures' HTML checks
// (`style="opacity: 0.5;"`) read the same as against the DOM. The engine's own `animate` (keyframes on the UI animator,
// driven by engine frames) is tested through UIView in src/plugins/ui/runtime/uiViewTransitions.test.ts.
import { queue_micro_task } from "../../node_modules/svelte/src/internal/client/dom/task.js";

interface Styled {
  style: Record<string, unknown>;
}

/** The running stand-ins, updated on each `tick`. */
export const animations = new Set<StandInAnimation>();
/** The test clock, in ms. */
export const clock = { time: 0 };

export class StandInAnimation {
  private readonly keyframes: Record<string, string>[];
  private readonly duration: number;
  private readonly offset = clock.time;
  private readonly applied = new Set<string>();
  private finishFn: () => void = () => {};
  currentTime: number | null = 0;
  playState: "running" | "finished" | "idle" = "running";
  /** Svelte's `tick` transitions: called on each tick while running (the renderer hook's `onframe`). */
  onframe: (() => void) | null = null;

  constructor(
    private readonly target: Styled,
    keyframes: Record<string, string>[] | null,
    options: { duration?: number } | undefined,
  ) {
    this.keyframes = Array.isArray(keyframes) ? keyframes : [];
    this.duration = Math.round(+(options?.duration ?? 0));
  }

  _update(): void {
    if (this.playState !== "running") return;
    this.currentTime = clock.time - this.offset;
    if (this.currentTime < 0) return;
    this.apply(this.duration === 0 ? 1 : this.currentTime / this.duration);
    if (this.currentTime >= this.duration) {
      this.currentTime = this.duration;
      this.playState = "finished"; // fill: 'forwards': its styles stay until it's cancelled
      this.finishFn();
      return;
    }
    this.onframe?.();
  }

  private apply(t: number): void {
    if (this.keyframes.length === 0) return;
    const n = Math.min(1, Math.max(0, t)) * (this.keyframes.length - 1);
    const lower = this.keyframes[Math.floor(n)];
    const upper = this.keyframes[Math.ceil(n)];
    let frame = lower;
    if (lower !== upper) {
      frame = {};
      for (const key in lower) frame[key] = interpolate(lower[key], upper[key], n % 1);
    }
    for (const prop in frame) {
      this.applied.add(prop);
      this.target.style[prop] = frame[prop];
    }
  }

  cancel(): void {
    for (const prop of this.applied) this.target.style[prop] = null;
    this.applied.clear();
    this.currentTime = null;
    this.playState = "idle";
    animations.delete(this);
  }

  set onfinish(fn: () => void) {
    this.finishFn = () => {
      fn();
      this.finishFn = () => {};
    };
    if (this.playState === "finished") {
      queue_micro_task(() => {
        if (this.playState === "finished") this.finishFn();
      });
    }
  }
}

/** The stand-in `animate` hook. */
export function standInAnimate(node: unknown, keyframes: Record<string, string>[], options: { duration?: number }): StandInAnimation {
  const animation = new StandInAnimation(node as Styled, keyframes, options);
  animations.add(animation);
  animation._update();
  return animation;
}

function interpolate(a: string, b: string, p: number): string {
  if (a === b) return a;
  const fallback = p < 0.5 ? a : b;
  const am = a.match(/[\d.]+|[^\d.]+/g);
  const bm = b.match(/[\d.]+|[^\d.]+/g);
  if (!am || !bm || am.length !== bm.length) return fallback;
  let result = "";
  for (let i = 0; i < am.length; i += 2) {
    const x = parseFloat(am[i]);
    const y = parseFloat(bm[i]);
    result += x + (y - x) * p;
    if (am[i + 1] !== bm[i + 1]) return fallback;
    result += am[i + 1] ?? "";
  }
  return result;
}
