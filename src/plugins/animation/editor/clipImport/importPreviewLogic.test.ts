// The clip import preview's source (ADR 0373, T18b): the selected clip as the draft cuts it, with its range, loop and root
// motion settings, played from the playhead's normalised time (`normalizedTimeAt`).
import { describe, expect, it } from "vitest";
import type { ImportedTake } from "../../../../engine/animation/import/channels";
import { defaultClipSettings, defaultModelAnimationSettings, type ModelAnimationSettings } from "../../../../engine/animation/import/clips";
import { normalizedTimeAt } from "../scene/posedPreviewLogic";
import { draftClipSource } from "./importPreviewLogic";

const takes: ImportedTake[] = [
  { name: "Take 001", duration: 4, tracks: [] },
  { name: "Dance", duration: 2, tracks: [] },
];

const settings = (): ModelAnimationSettings => ({
  ...defaultModelAnimationSettings(),
  clips: {
    "Take 001": [
      { ...defaultClipSettings("Walk"), from: 0, to: 1.5, loop: true },
      { ...defaultClipSettings("Run"), from: 1.5, to: null, rootMotion: { bone: "Hips", axes: ["x", "z"], bakeIntoPose: false } },
    ],
  },
});

describe("the clip the import preview plays", () => {
  it("is a split range cut out of its take, starting at 0", () => {
    expect(draftClipSource(takes, settings(), "Take 001", "Walk")).toMatchObject({ name: "Walk", duration: 1.5, loop: true });
    expect(draftClipSource(takes, settings(), "Take 001", "Run")).toMatchObject({ name: "Run", duration: 2.5, loop: false });
  });

  it("carries the draft's loop and root-motion settings", () => {
    const run = draftClipSource(takes, settings(), "Take 001", "Run")!;
    expect(run.rootMotion).toEqual({ bone: "Hips", axes: ["x", "z"], bakeIntoPose: false });
    expect(draftClipSource(takes, settings(), "Take 001", "Walk")!.rootMotion).toBeNull();
  });

  it("is the whole take for a take with no entries, under the take's name", () => {
    expect(draftClipSource(takes, settings(), "Dance", "Dance")).toMatchObject({ name: "Dance", duration: 2, loop: false });
  });

  it("follows the draft: a moved range is a different clip", () => {
    const moved = { ...settings(), clips: { "Take 001": [{ ...defaultClipSettings("Walk"), from: 1, to: 2 }] } };
    expect(draftClipSource(takes, moved, "Take 001", "Walk")).toMatchObject({ duration: 1 });
  });

  it("is null for a clip or take the draft doesn't have", () => {
    expect(draftClipSource(takes, settings(), "Take 001", "Jump")).toBeNull();
    expect(draftClipSource(takes, settings(), "Gone", "Gone")).toBeNull();
  });

  it("plays at the playhead's place in the cut clip, which is the range's place in the take when the take is played whole", () => {
    const walk = draftClipSource(takes, settings(), "Take 001", "Walk")!;
    // Cut: the clip is the range, so the playhead maps straight onto it.
    expect(normalizedTimeAt(0.75, walk.duration)).toBe(0.5);
    // Whole take with the range: the same instant of the take (1.5 s range of a 4 s take starting at 0).
    expect(normalizedTimeAt(0.75, 4, { from: 0, to: 1.5 })).toBe(0.1875);
    // The Run range of the take (1.5..4): its first frame is 1.5 / 4 into the take.
    expect(normalizedTimeAt(0, 4, { from: 1.5, to: 4 })).toBe(0.375);
    expect(normalizedTimeAt(2.5, 4, { from: 1.5, to: 4 })).toBe(1);
  });
});
