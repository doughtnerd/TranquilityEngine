// Flipbooks from slices (ADR 0371, 0373; T56): frames ordered by name and number, every edit refused with a reason or
// accepted, and the sidecar round trip (`myco.import@1`) of what the edits make.
import { describe, expect, it } from "vitest";
import { refusalOf } from "../../../../editor/sdk";
import { SPRITE_2D_LIMITS, type SpriteFlipbook } from "../../../../engine/animation/sprites/sidecar";
import { defaultImportSettings, formatImportSettings, parseImportSettings } from "../../../../engine/scene/importSettings";
import {
  addFrame,
  createFlipbook,
  editFlipbook,
  flipbookDuration,
  frameCrop,
  frameSeconds,
  framesOf,
  moveFrame,
  naturalCompare,
  orderByName,
  removeFlipbook,
  removeFrame,
  renameFlipbook,
  setFps,
  setHold,
  setLoop,
  sliceAt,
  suggestFlipbookName,
  type Flipbooks,
} from "./flipbookLogic";

const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};
const SLICES = ["run_0", "run_1", "run_2", "run_10", "idle_0", "jump"];
const run: SpriteFlipbook = { slices: ["run_0", "run_1", "run_2"], fps: 10, loop: true };

describe("ordering by name and number", () => {
  it("puts run_2 before run_10, ignores case and keeps equal stems together", () => {
    expect(orderByName(["run_10", "run_2", "run_1", "Run_0", "idle_3"])).toEqual(["idle_3", "Run_0", "run_1", "run_2", "run_10"]);
    expect(naturalCompare("a", "a")).toBe(0);
    expect(naturalCompare("frame9", "frame10")).toBeLessThan(0);
    expect(naturalCompare("a1", "a")).toBeGreaterThan(0);
  });
});

describe("creating a flipbook from slices", () => {
  it("orders the frames by name and number whatever the selection order", () => {
    const made = ok(createFlipbook({}, SLICES, ["run_10", "run_2", "run_0", "run_1"]));
    expect(made.name).toBe("run");
    expect(made.flipbooks.run).toEqual({ slices: ["run_0", "run_1", "run_2", "run_10"], fps: 12, loop: true });
  });

  it("names it after the slices' common stem, else flipbook, and avoids taken names", () => {
    expect(suggestFlipbookName(["hero_walk_0", "hero_walk_1"], {})).toBe("hero_walk");
    expect(suggestFlipbookName(["a", "b"], {})).toBe("flipbook");
    const taken: Flipbooks = { run: run, run_2: run };
    expect(suggestFlipbookName(["run_0", "run_1"], taken)).toBe("run_3");
  });

  it("takes a name, a rate and loop from the options", () => {
    const made = ok(createFlipbook({}, SLICES, ["jump"], { name: "hop", fps: 24, loop: false }));
    expect(made.flipbooks.hop).toEqual({ slices: ["jump"], fps: 24, loop: false });
  });

  it("refuses with a reason", () => {
    expect(refusalOf(createFlipbook({}, SLICES, []))).toMatch(/select at least one slice/);
    expect(refusalOf(createFlipbook({}, SLICES, ["nope"]))).toMatch(/no slice named "nope"/);
    expect(refusalOf(createFlipbook({}, SLICES, ["jump"], { name: "a/b" }))).toMatch(/can't contain/);
    expect(refusalOf(createFlipbook({}, SLICES, ["jump"], { name: " " }))).toMatch(/can't be empty/);
    expect(refusalOf(createFlipbook({ run }, SLICES, ["jump"], { name: "run" }))).toMatch(/already a flipbook named "run"/);
    expect(refusalOf(createFlipbook({}, SLICES, ["jump"], { fps: 0 }))).toMatch(/above 0/);
    expect(refusalOf(createFlipbook({}, SLICES, ["jump"], { fps: SPRITE_2D_LIMITS.maxFps + 1 }))).toMatch(/at most 240/);
    const many = Array.from({ length: SPRITE_2D_LIMITS.framesPerFlipbook + 1 }, (_, i) => `f_${i}`);
    expect(refusalOf(createFlipbook({}, many, many))).toMatch(/at most 1024 frames/);
  });
});

describe("editing frames", () => {
  it("reorders, holds, adds and removes frames", () => {
    expect(ok(moveFrame(run, 0, 2)).slices).toEqual(["run_1", "run_2", "run_0"]);
    expect(ok(moveFrame(run, 1, 1))).toBe(run);
    const held = ok(setHold(run, 1, 3));
    expect(held.slices).toEqual(["run_0", "run_1", "run_1", "run_1", "run_2"]);
    expect(framesOf(held)).toEqual([{ slice: "run_0", hold: 1 }, { slice: "run_1", hold: 3 }, { slice: "run_2", hold: 1 }]);
    // A hold moves with its frame.
    expect(ok(moveFrame(held, 1, 0)).slices).toEqual(["run_1", "run_1", "run_1", "run_0", "run_2"]);
    expect(ok(addFrame(run, "jump", SLICES, 1)).slices).toEqual(["run_0", "jump", "run_1", "run_2"]);
    expect(ok(addFrame(run, "jump", SLICES)).slices.at(-1)).toBe("jump");
    expect(ok(removeFrame(run, 1)).slices).toEqual(["run_0", "run_2"]);
  });

  it("a frame's duration is its hold over the rate", () => {
    const held = ok(setHold(run, 0, 4));
    expect(frameSeconds(held, 4)).toBeCloseTo(0.4, 12);
    expect(flipbookDuration(held)).toBeCloseTo(0.6, 12);
  });

  it("refuses with a reason", () => {
    expect(refusalOf(moveFrame(run, 5, 0))).toMatch(/no frame 6/);
    expect(refusalOf(moveFrame(run, 0, 3))).toMatch(/no position 4/);
    expect(refusalOf(setHold(run, 0, 0))).toMatch(/at least 1/);
    expect(refusalOf(setHold(run, 9, 1))).toMatch(/no frame 10/);
    expect(refusalOf(setHold(run, 0, SPRITE_2D_LIMITS.framesPerFlipbook))).toMatch(/at most 1024 frames/);
    expect(refusalOf(addFrame(run, "nope", SLICES))).toMatch(/no slice named "nope"/);
    expect(refusalOf(removeFrame({ ...run, slices: ["run_0"] }, 0))).toMatch(/at least one frame/);
    expect(refusalOf(removeFrame(run, -1))).toMatch(/no frame 0/);
  });
});

describe("flipbook settings and the list", () => {
  it("sets the rate and loop, refusing a bad rate", () => {
    expect(ok(setFps(run, 24)).fps).toBe(24);
    expect(ok(setFps(run, 10))).toBe(run);
    expect(refusalOf(setFps(run, -1))).toMatch(/above 0/);
    expect(refusalOf(setFps(run, Number.NaN))).toMatch(/above 0/);
    expect(ok(setLoop(run, false)).loop).toBe(false);
    expect(ok(setLoop(run, true))).toBe(run);
  });

  it("renames in place, removes, and edits one by name", () => {
    const all: Flipbooks = { run, idle: { slices: ["idle_0"], fps: 6, loop: true } };
    expect(Object.keys(ok(renameFlipbook(all, "run", "sprint")))).toEqual(["sprint", "idle"]);
    expect(ok(renameFlipbook(all, "run", "run"))).toBe(all);
    expect(refusalOf(renameFlipbook(all, "run", "idle"))).toMatch(/already a flipbook named "idle"/);
    expect(refusalOf(renameFlipbook(all, "run", "a#b"))).toMatch(/can't contain/);
    expect(refusalOf(renameFlipbook(all, "walk", "x"))).toMatch(/no flipbook named "walk"/);
    expect(Object.keys(ok(removeFlipbook(all, "run")))).toEqual(["idle"]);
    expect(refusalOf(removeFlipbook(all, "walk"))).toMatch(/no flipbook named "walk"/);
    expect(ok(editFlipbook(all, "idle", (f) => setFps(f, 8))).idle!.fps).toBe(8);
    expect(ok(editFlipbook(all, "idle", (f) => setFps(f, 6)))).toBe(all);
    expect(refusalOf(editFlipbook(all, "walk", (f) => setFps(f, 8)))).toMatch(/no flipbook named "walk"/);
    expect(refusalOf(editFlipbook(all, "idle", (f) => setFps(f, 0)))).toMatch(/above 0/);
  });
});

describe("the preview plays as the runtime does", () => {
  it("shows entry floor(t × fps), wrapping or holding the last", () => {
    const f: SpriteFlipbook = { slices: ["a", "b", "c"], fps: 10, loop: true };
    expect([0, 0.05, 0.1, 0.25, 0.3, 0.45].map((t) => sliceAt(f, t))).toEqual(["a", "a", "b", "c", "a", "b"]);
    expect([0.25, 0.3, 5].map((t) => sliceAt({ ...f, loop: false }, t))).toEqual(["c", "c", "c"]);
    expect(sliceAt({ ...f, slices: [] }, 1)).toBeNull();
    expect(sliceAt(f, 0.3)).toBe("a"); // 0.3 × 10 is 3.0000000000000004 or 2.9999…: still entry 3
  });
});

describe("the preview's crop", () => {
  it("scales the longer side of the slice to the box and offsets the image behind it", () => {
    expect(frameCrop([16, 8, 32, 16], [128, 64], 64)).toEqual({ width: 64, height: 32, backgroundSize: "256px 128px", backgroundPosition: "-32px -16px" });
    expect(frameCrop([0, 0, 1, 1], [4, 4], 8).width).toBe(8);
  });
});

describe("the sidecar round trip", () => {
  it("what the edits make is what a parse reads back from the formatted sidecar", () => {
    const base = defaultImportSettings();
    const sprites = SLICES.map((name, i) => ({ name, rect: [i * 8, 0, 8, 8] as [number, number, number, number], pivot: [0.5, 0.5] as [number, number] }));
    let flipbooks: Flipbooks = ok(createFlipbook({}, SLICES, ["run_10", "run_2", "run_0", "run_1"])).flipbooks;
    flipbooks = ok(editFlipbook(flipbooks, "run", (f) => setHold(f, 1, 2)));
    flipbooks = ok(editFlipbook(flipbooks, "run", (f) => setFps(f, 24)));
    flipbooks = ok(editFlipbook(flipbooks, "run", (f) => setLoop(f, false)));
    flipbooks = ok(createFlipbook(flipbooks, SLICES, ["jump"], { name: "hop" })).flipbooks;
    const text = formatImportSettings({ ...base, sprites, flipbooks: { ...flipbooks } });
    const read = parseImportSettings(JSON.parse(text), "sheet.png.meta.json");
    expect(read.problems).toEqual([]);
    expect(read.settings.flipbooks).toEqual(flipbooks);
    // Written again it is the same text.
    expect(formatImportSettings(read.settings)).toBe(text);
  });
});
