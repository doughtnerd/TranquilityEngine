// The tile animation editor's model (ADR 0437): frames from the tile's image only, durations above 0, the field left
// out when the last frame goes, and the preview's frame at a time.
import { describe, expect, it } from "vitest";
import type { TileAnimation } from "../runtime/tileset";
import { addFrame, frameAt, frameProblem, loopDuration, moveFrame, removeFrame, setFrameDuration, setFrameSprite, setStart, spriteImage, type AnimationEdit } from "./tileAnimationLogic";

const TILE = "asset:images/water.png#water_0";
const f = (n: number, duration = 0.15) => ({ sprite: `asset:images/water.png#water_${n}`, duration });
const ok = (edit: AnimationEdit): TileAnimation | undefined => {
  if ("problem" in edit) throw new Error(edit.problem);
  return edit.animation;
};

describe("tile animation frames", () => {
  it("adds frames of the tile's image, each lasting as long as the last", () => {
    const one = ok(addFrame(undefined, TILE, f(0).sprite));
    expect(one).toEqual({ frames: [{ sprite: f(0).sprite, duration: 0.1 }] });
    const two = ok(addFrame({ frames: [f(0, 0.3)] }, TILE, f(1).sprite));
    expect(two).toEqual({ frames: [f(0, 0.3), f(1, 0.3)] });
    // The whole image is the same image.
    expect(frameProblem(TILE, "asset:images/water.png")).toBeNull();
  });

  it("refuses a frame of another image, or a tile without a sprite", () => {
    const edit = addFrame({ frames: [f(0)] }, TILE, "asset:images/lava.png#lava_0");
    expect(edit).toEqual({ problem: expect.stringContaining("images/water.png") });
    expect("problem" in addFrame(undefined, "", f(0).sprite)).toBe(true);
    expect("problem" in setFrameSprite({ frames: [f(0)] }, 0, TILE, "images/lava.png#a")).toBe(true);
    expect(ok(setFrameSprite({ frames: [f(0)] }, 0, TILE, f(2).sprite))).toEqual({ frames: [f(2)] });
  });

  it("removing the last frame removes the animation; start is kept otherwise", () => {
    expect(ok(removeFrame({ frames: [f(0)], start: "random" }, 0))).toBeUndefined();
    expect(ok(removeFrame({ frames: [f(0), f(1)], start: "random" }, 0))).toEqual({ frames: [f(1)], start: "random" });
    expect("problem" in removeFrame({ frames: [f(0)] }, 3)).toBe(true);
  });

  it("reorders frames, refusing moves past either end", () => {
    const a = { frames: [f(0), f(1), f(2)] };
    expect(ok(moveFrame(a, 0, 1))).toEqual({ frames: [f(1), f(0), f(2)] });
    expect(ok(moveFrame(a, 2, -1))).toEqual({ frames: [f(0), f(2), f(1)] });
    expect("problem" in moveFrame(a, 0, -1)).toBe(true);
    expect("problem" in moveFrame(a, 2, 1)).toBe(true);
    expect(a.frames).toEqual([f(0), f(1), f(2)]);
  });

  it("durations must be seconds above 0", () => {
    expect(ok(setFrameDuration({ frames: [f(0)] }, 0, 0.5))).toEqual({ frames: [f(0, 0.5)] });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect("problem" in setFrameDuration({ frames: [f(0)] }, 0, bad)).toBe(true);
  });

  it("start: together is left out, random is written", () => {
    expect(ok(setStart({ frames: [f(0)] }, "random"))).toEqual({ frames: [f(0)], start: "random" });
    expect(ok(setStart({ frames: [f(0)], start: "random" }, "together"))).toEqual({ frames: [f(0)] });
    expect("problem" in setStart(undefined, "random")).toBe(true);
  });
});

describe("the preview's frame", () => {
  const a = { frames: [f(0, 0.1), f(1, 0.1), f(2, 0.3)] };
  it("walks the durations and loops", () => {
    expect(loopDuration(a)).toBeCloseTo(0.5);
    expect(frameAt(a, 0)).toBe(0);
    expect(frameAt(a, 0.15)).toBe(1);
    expect(frameAt(a, 0.45)).toBe(2);
    expect(frameAt(a, 0.55)).toBe(0);
    expect(frameAt(undefined, 1)).toBe(-1);
  });

  it("names a sprite's image", () => {
    expect(spriteImage(TILE)).toBe("images/water.png");
    expect(spriteImage("images/water.png")).toBe("images/water.png");
  });
});
