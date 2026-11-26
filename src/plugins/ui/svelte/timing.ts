/**
 * The engine renderer's `requestAnimationFrame` and `now` hooks (ADR 0419, `docs/architecture/svelte-patch.md`): Svelte's
 * frames and clock under the custom renderer, so `svelte/motion` (`Tween`, `Spring`, `tweened`, `spring`), `tick`
 * transitions and everything else on Svelte's frame loop run on engine frames, in a browser and headless alike (no
 * `requestAnimationFrame`: `engine.step` drives them).
 *
 * - **The clock** (`now`) is milliseconds of the active World's unscaled time (a paused game's UI still moves), summed
 *   frame by frame, so it never goes back when another World becomes active (the editor's Play). It's the time of the
 *   current frame: everything read in one frame reads the same time.
 * - **The frames.** A callback asked for (`requestAnimationFrame`) runs once, in the next frame of the active World in
 *   play, in the UI step right after the frame's UI events (`onUIHostFrame`, before behaviors' update and long before
 *   the UI's late sync), so what it changes (a tween's value written through `style:`, a `tick` transition's text or
 *   inline style) shows in that frame. Nothing runs in a scene being edited.
 */
import { World } from "../../../engine/core/World";
import { onUIHostFrame } from "../../../engine/ui/host/UIHost";

/** Svelte's clock, in milliseconds. */
let clock = 0;
/** The frame the clock last advanced in. */
let last: { world: World; frame: number } | null = null;
let pending: ((time: number) => void)[] = [];

function frame(world: World): void {
  const active = World.active;
  if (active && active !== world) return;
  const n = world.time.frameCount;
  if (last && last.world === world && last.frame === n) return;
  last = { world, frame: n };
  clock += Math.max(0, world.time.unscaledDeltaTime) * 1000;
  if (pending.length === 0) return;
  const due = pending;
  pending = [];
  for (const callback of due) {
    try {
      callback(clock);
    } catch (err) {
      console.error("[myco] a Svelte frame callback threw:", err);
    }
  }
}

onUIHostFrame(frame);

/** The `requestAnimationFrame` hook: `callback` runs once, in the next UI frame. */
export function requestFrame(callback: (time: number) => void): void {
  if (typeof callback === "function") pending.push(callback);
}

/** The `now` hook: the current frame's time on Svelte's clock, in milliseconds. */
export function frameNow(): number {
  return clock;
}
