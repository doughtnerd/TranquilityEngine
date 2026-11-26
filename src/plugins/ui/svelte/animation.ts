/**
 * The engine renderer's `animate` and `measure` hooks (ADR 0419, `docs/architecture/svelte-patch.md`): what Svelte's
 * `transition:`, `in:`, `out:` and `animate:` run through under the custom renderer.
 *
 * - **`animate(node, keyframes, { duration })`** plays the keyframes on the hosted element's UI animator (ADR 0418
 *   wave 4: per-segment tweens on the tween backend, unscaled time, starting in the frame it's called in), converting
 *   each keyframe's CSS as a stylesheet's values convert. The handle is the part of the DOM's `Animation` Svelte uses:
 *   `currentTime` (ms), `playState`, `onfinish` (once, at the end), `onframe` (each frame it plays: `tick` transitions)
 *   and `cancel()`, which puts the cascade's values back. A node not shown (outside a mounted view) has nothing to
 *   animate: it finishes at once.
 * - **`measure(node)`**: the node's box after transforms (its `getBoundingClientRect`, which lays the UI out first
 *   when the view changed), its inner size, and its computed style (`UIHostElement.computedStyle`) by camel-case name,
 *   with `getPropertyValue`; properties UI elements don't have read as "".
 *
 * `blur` (a `filter`) and `draw` (SVG stroke dashes) have nothing to draw them until ADR 0426: what they animate is
 * warned about once and left out, so `blur` fades and `draw` shows the element as it is.
 */
import type { UIHostElement } from "../../../engine/ui/host/UIHost";
import type { UIPlayback, UIPlayHooks } from "../../../engine/ui/animation/UIAnimator";

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
  private playback: UIPlayback | null = null;
  /** What the UI animator calls (`onFrame` only while Svelte wants frames). */
  readonly hooks: UIPlayHooks;

  constructor(private readonly duration: number) {
    const self = this;
    this.hooks = {
      get onFrame() {
        return self.onframe ? () => self.state === "running" && self.onframe?.() : null;
      },
      onEnd: () => this.end(),
    };
  }

  /** Milliseconds since it started; null once cancelled. */
  get currentTime(): number | null {
    if (this.state === "idle") return null;
    return (this.playback ? this.playback.time : this.state === "finished" ? this.duration : 0) * 1000;
  }

  get playState(): "running" | "finished" | "idle" {
    return this.state;
  }

  /** Stops it: the element's fields go back to the cascade's values. */
  cancel(): void {
    this.state = "idle";
    this.playback?.stop();
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

/** `paddingTop` for `padding-top` (custom properties stay). */
const camel = (name: string) => (name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));

/** Computed values read as a `CSSStyleDeclaration` is: by camel-case property or `getPropertyValue(kebab-case)`, "" when unknown. */
function declaration(values: Readonly<Record<string, string>>): Record<string, string> {
  const getPropertyValue = (name: string) => values[camel(name)] ?? "";
  return new Proxy(values as Record<string, string>, {
    get: (target, key) => (typeof key !== "string" ? undefined : key === "getPropertyValue" ? getPropertyValue : (target[key] ?? "")),
  });
}

/** The `measure` hook. */
export function measureNode(node: AnimatedNode): {
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
  const values = node.element?.computedStyle() ?? {};
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
