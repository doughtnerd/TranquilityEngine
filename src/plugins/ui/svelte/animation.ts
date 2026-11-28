/**
 * The engine renderer's `animate` and `measure` hooks (ADR 0423, `docs/architecture/svelte-patch.md`): what Svelte's
 * `transition:`, `in:`, `out:` and `animate:` run through under the custom renderer.
 *
 * - **`animate(node, keyframes, { duration })`** plays the keyframes on the hosted element's UI animator (ADR 0422
 *   wave 4: per-segment tweens on the tween backend, unscaled time, starting in the frame it's called in), converting
 *   each keyframe's CSS as a stylesheet's values convert. The handle is the part of the DOM's `Animation` Svelte uses:
 *   `currentTime` (ms), `playState`, `onfinish` (once, at the end), `onframe` (each frame it plays: `tick` transitions)
 *   and `cancel()`, which puts the cascade's values back. A node not shown (outside a mounted view) has nothing to
 *   animate: it finishes at once.
 * - **`measure(node)`**: the node's box after transforms (its `getBoundingClientRect`, which lays the UI out first
 *   when the view changed), its inner size, and its computed style (`UIHostElement.computedStyle`) by camel-case name,
 *   with `getPropertyValue`; properties UI elements don't have read as "".
 *
 * ADR 0430: `blur` animates the filter fields like any other keyframes. A shape inside an `<svg>` (what `draw` animates)
 * isn't a UI element: its keyframes (`stroke-dasharray`, `stroke-dashoffset`) are sampled each frame (`animateSvgNode`,
 * on its `<svg>`'s animator clock) and written into the `<svg>`'s document, and its computed style comes from its SVG
 * paint (`measureNode`'s `values`).
 */
import type { UIHostElement } from "../../../engine/ui/host/UIHost";
import type { UIPlayback, UIPlayHooks } from "../../../engine/ui/animation/UIAnimator";
import { frameNow } from "./timing";

/** The renderer nodes the hooks get: an element shown through its hosted UI element. */
interface AnimatedNode {
  readonly element: UIHostElement | null;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

/** What the `animate` hook returns (the patch's `RendererAnimation`). */
export class NodeAnimation {
  /** Called once when it reaches its end. */
  onfinish: (() => void) | null = null;
  /** Set by Svelte for a `tick` transition: called each frame it plays. */
  onframe: (() => void) | null = null;
  private state: "running" | "finished" | "idle" = "running";
  /** Svelte's clock when it started. */
  private readonly startedAt = frameNow();
  private playback: UIPlayback | null = null;
  /** What the UI animator calls (`onFrame` only while Svelte wants frames). */
  readonly hooks: UIPlayHooks;

  constructor(
    private readonly duration: number,
    /** Called by `cancel()` beside stopping the playback (a shape's written CSS taken away). */
    private readonly onCancel: (() => void) | null = null,
  ) {
    const self = this;
    this.hooks = {
      get onFrame() {
        return self.onframe ? () => self.state === "running" && self.onframe?.() : null;
      },
      onEnd: () => this.end(),
    };
  }

  /**
   * Milliseconds since it started, on Svelte's clock (`timing.ts`: the frame's unscaled time), up to its duration; null
   * once cancelled. Svelte's `tick` transitions read it in the frame's Svelte callbacks, before the UI animator moves its
   * playback on for that frame: the playback started in a frame shows its time `t` in the frame `t` after, which is the
   * clock's difference then too.
   */
  get currentTime(): number | null {
    if (this.state === "idle") return null;
    if (this.state === "finished") return this.duration * 1000;
    return Math.min(this.duration * 1000, Math.max(0, frameNow() - this.startedAt));
  }

  get playState(): "running" | "finished" | "idle" {
    return this.state;
  }

  /** Stops it: the element's fields go back to the cascade's values. */
  cancel(): void {
    this.state = "idle";
    this.playback?.stop();
    this.onCancel?.();
  }

  /** @internal Plays on a playback made elsewhere (a shape's, on its <svg>'s clock). */
  _attach(playback: UIPlayback): void {
    this.playback = playback;
  }

  /** @internal */
  _play(el: UIHostElement, keyframes: readonly Readonly<Record<string, string>>[]): void {
    this.playback = el.animate(keyframes, this.duration, this.hooks);
  }

  /** @internal Nothing to animate: it finishes once the call that made it has returned. */
  _finishSoon(): void {
    queueMicrotask(() => this.end());
  }

  private end(): void {
    if (this.state !== "running") return;
    this.state = "finished";
    this.onfinish?.();
  }
}

/** The `animate` hook. */
export function animateNode(node: AnimatedNode, keyframes: readonly Readonly<Record<string, string>>[], options: { duration?: number }): NodeAnimation {
  const animation = new NodeAnimation(Math.max(0, Number(options?.duration) || 0) / 1000);
  const el = node.element;
  if (el?.isValid) animation._play(el, keyframes);
  else animation._finishSoon();
  return animation;
}

/** A keyframe's property as CSS's kebab-case name. */
const kebab = (name: string) => (name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

const NUMBER_UNIT = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-z%]*)$/i;

/** Keyframes (evenly spaced, as Svelte samples them) at progress `p`: numbers with the same unit mixed, others stepping. */
function sampleKeyframes(frames: readonly Readonly<Record<string, string>>[], p: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!frames.length) return out;
  const n = frames.length;
  const x = n === 1 ? 0 : Math.min(1, Math.max(0, p)) * (n - 1);
  const i = Math.min(n - 1, Math.floor(x)), f = x - i;
  const a = frames[i], b = frames[Math.min(n - 1, i + 1)];
  for (const [k, va] of Object.entries(a)) {
    const vb = b[k];
    const ma = NUMBER_UNIT.exec(String(va).trim()), mb = vb === undefined ? null : NUMBER_UNIT.exec(String(vb).trim());
    if (ma && mb && ma[2] === mb[2] && f > 0) out[k] = `${Math.round((parseFloat(ma[1]) * (1 - f) + parseFloat(mb[1]) * f) * 1e4) / 1e4}${ma[2]}`;
    else out[k] = String(f >= 0.5 && vb !== undefined ? vb : va).trim();
  }
  return out;
}

/**
 * ADR 0430: the `animate` hook for a shape inside an `<svg>`: its keyframes sampled each frame of a playback on the
 * `<svg>`'s hosted element (the UI animator's clock, unscaled time) and handed to `write`, which puts them into the
 * `<svg>`'s document; the last keyframe's values stay until `cancel()` (which writes null). No `<svg>` shown: it
 * finishes at once.
 */
export function animateSvgNode(clock: UIHostElement | null, keyframes: readonly Readonly<Record<string, string>>[], options: { duration?: number }, write: (style: Readonly<Record<string, string>> | null) => void): NodeAnimation {
  const duration = Math.max(0, Number(options?.duration) || 0) / 1000;
  const animation = new NodeAnimation(duration, () => write(null));
  if (!clock?.isValid) {
    animation._finishSoon();
    return animation;
  }
  const frames = keyframes.map((k) => Object.fromEntries(Object.entries(k).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "").map(([p, v]) => [kebab(p), String(v)])));
  write(sampleKeyframes(frames, 0));
  let playback: UIPlayback | null = null;
  const hooks: UIPlayHooks = {
    get onFrame() {
      return () => {
        write(sampleKeyframes(frames, duration > 0 && playback ? playback.time / duration : 1));
        animation.hooks.onFrame?.();
      };
    },
    onEnd: () => {
      write(sampleKeyframes(frames, 1));
      animation.hooks.onEnd?.();
    },
  };
  playback = clock.animate([], duration, hooks);
  animation._attach(playback);
  return animation;
}

/** `paddingTop` for `padding-top` (custom properties stay). */
const camel = (name: string) => (name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));

/** Computed values read as a `CSSStyleDeclaration` is: by camel-case property or `getPropertyValue(kebab-case)`, "" when unknown. */
function declaration(values: Readonly<Record<string, string>>): Record<string, string> {
  const getPropertyValue = (name: string) => values[camel(name)] ?? "";
  return new Proxy(values as Record<string, string>, {
    get: (target, key) => (typeof key !== "string" ? undefined : key === "getPropertyValue" ? getPropertyValue : (target[key] ?? "")),
  });
}

/** The `measure` hook. `values` stands in for the computed style (an SVG shape's paint, ADR 0430). */
export function measureNode(node: AnimatedNode, values?: Readonly<Record<string, string>>): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  style: Record<string, string>;
} {
  const box = node.getBoundingClientRect(); // lays the UI out first when the view changed
  values ??= node.element?.computedStyle() ?? {};
  const px = (key: string) => parseFloat(values[key] ?? "") || 0;
  return {
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    width: box.width,
    height: box.height,
    clientWidth: Math.max(0, px("width") - px("borderLeftWidth") - px("borderRightWidth")),
    clientHeight: Math.max(0, px("height") - px("borderTopWidth") - px("borderBottomWidth")),
    style: declaration(values),
  };
}
