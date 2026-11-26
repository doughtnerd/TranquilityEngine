// The tile animation editor's model (ADR 0421 "Animated tiles"): what the tileset inspector's Animation section edits,
// as pure functions over a tile's `animation` (`runtime/tileset.ts`). Every frame must come from the tile sprite's
// image, so an animated tile never changes batch: a frame of another image is refused with a problem the inspector
// shows. Durations are seconds, > 0. Removing the last frame removes the animation (the field is left out), and the
// default start, "together", is left out too. `TilesetInspector.tsx` draws it; each change is one tileset edit.
import type { TileAnimation, TileFrameDef } from "../runtime/tileset";

/** An edit's result: the tile's next `animation` (undefined: the field is removed), or why it was refused. */
export type AnimationEdit = { animation: TileAnimation | undefined } | { problem: string };

/** The duration a frame gets when none is known yet: 0.1 s. */
export const DEFAULT_FRAME_DURATION = 0.1;

/** The image a sprite reference draws from: `asset:images/water.png#water_0` and `images/water.png` are `images/water.png`. */
export function spriteImage(sprite: string): string {
  const ref = sprite.replace(/^asset:/, "");
  const hash = ref.indexOf("#");
  return hash >= 0 ? ref.slice(0, hash) : ref;
}

/** Why a frame can't be used in a tile with sprite `tileSprite`, or null if it can. */
export function frameProblem(tileSprite: string, frameSprite: string): string | null {
  if (!frameSprite) return "A frame needs a sprite.";
  const image = spriteImage(tileSprite);
  if (!image) return "Give the tile a sprite before animating it.";
  if (spriteImage(frameSprite) !== image) return `Every frame must come from the tile's image (${image}); ${spriteImage(frameSprite)} is another image.`;
  return null;
}

/** The animation with these frames and start, normalized: no frames is no animation; "together" is left out. */
function animationOf(frames: TileFrameDef[], start: TileAnimation["start"]): TileAnimation | undefined {
  if (frames.length === 0) return undefined;
  return start === "random" ? { frames, start: "random" } : { frames };
}

const framesOf = (animation: TileAnimation | undefined): TileFrameDef[] => (animation?.frames ?? []).map((f) => ({ sprite: f.sprite, duration: f.duration }));

/** A frame of `sprite` appended, lasting as long as the last frame (or `DEFAULT_FRAME_DURATION`). */
export function addFrame(animation: TileAnimation | undefined, tileSprite: string, sprite: string): AnimationEdit {
  const problem = frameProblem(tileSprite, sprite);
  if (problem) return { problem };
  const frames = framesOf(animation);
  frames.push({ sprite, duration: frames[frames.length - 1]?.duration ?? DEFAULT_FRAME_DURATION });
  return { animation: animationOf(frames, animation?.start) };
}

/** Frame `index` removed; removing the last one removes the animation. */
export function removeFrame(animation: TileAnimation | undefined, index: number): AnimationEdit {
  const frames = framesOf(animation);
  if (index < 0 || index >= frames.length) return { problem: `There is no frame ${index + 1}.` };
  frames.splice(index, 1);
  return { animation: animationOf(frames, animation?.start) };
}

/** Frame `index` moved `by` places (-1 earlier, 1 later); refused past either end. */
export function moveFrame(animation: TileAnimation | undefined, index: number, by: number): AnimationEdit {
  const frames = framesOf(animation);
  const to = index + by;
  if (index < 0 || index >= frames.length || to < 0 || to >= frames.length) return { problem: "The frame can't move further." };
  const [frame] = frames.splice(index, 1);
  frames.splice(to, 0, frame);
  return { animation: animationOf(frames, animation?.start) };
}

/** Frame `index` drawn from another slice of the tile's image. */
export function setFrameSprite(animation: TileAnimation | undefined, index: number, tileSprite: string, sprite: string): AnimationEdit {
  const frames = framesOf(animation);
  if (index < 0 || index >= frames.length) return { problem: `There is no frame ${index + 1}.` };
  const problem = frameProblem(tileSprite, sprite);
  if (problem) return { problem };
  frames[index] = { ...frames[index], sprite };
  return { animation: animationOf(frames, animation?.start) };
}

/** Frame `index` lasting `seconds`, which must be a number above 0. */
export function setFrameDuration(animation: TileAnimation | undefined, index: number, seconds: number): AnimationEdit {
  const frames = framesOf(animation);
  if (index < 0 || index >= frames.length) return { problem: `There is no frame ${index + 1}.` };
  if (!Number.isFinite(seconds) || seconds <= 0) return { problem: "A frame's duration must be more than 0 seconds." };
  frames[index] = { ...frames[index], duration: seconds };
  return { animation: animationOf(frames, animation?.start) };
}

/** How the cells' animations start: "together" (the default, left out of the file) or "random". */
export function setStart(animation: TileAnimation | undefined, start: "together" | "random"): AnimationEdit {
  if (!animation) return { problem: "Add a frame first." };
  return { animation: animationOf(framesOf(animation), start) };
}

/** One loop's length in seconds (0 without frames). */
export const loopDuration = (animation: TileAnimation | undefined) => (animation?.frames ?? []).reduce((sum, f) => sum + f.duration, 0);

/** The frame showing `seconds` into the animation, looping; -1 without frames. */
export function frameAt(animation: TileAnimation | undefined, seconds: number): number {
  const frames = animation?.frames ?? [];
  const loop = loopDuration(animation);
  if (frames.length === 0 || !(loop > 0)) return frames.length ? 0 : -1;
  let t = ((seconds % loop) + loop) % loop;
  for (let i = 0; i < frames.length; i++) {
    if (t < frames[i].duration) return i;
    t -= frames[i].duration;
  }
  return frames.length - 1;
}
