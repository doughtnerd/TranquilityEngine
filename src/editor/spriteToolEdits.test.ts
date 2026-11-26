// A Sprite Editor tool's changes as steps of the editor's history (ADR 0373; T56): skins by slice name, flipbooks as a
// whole, one undo step each, and slice renames followed through the flipbooks.
import { describe, expect, it } from "vitest";
import type { SliceSkin } from "../engine/animation/sprites/sidecar";
import { createHistory, pushHistory, undo } from "./spriteHistory";
import { applyToolChange, renameInFlipbooks, type ToolState } from "./spriteToolEdits";

const skin: SliceSkin = { bones: [{ name: "hip", parent: null, position: [1, 2], rotation: 0, length: 5 }], mesh: null, weights: null };
const state = (): ToolState<{ name: string; skin?: SliceSkin }> => ({ slices: [{ name: "a" }, { name: "b", skin }], flipbooks: { run: { slices: ["a", "b"], fps: 12, loop: true } }, secondary: { textures: {}, normalMapGreen: "up" } });

describe("a tool's change", () => {
  it("sets a skin on the slice it names and leaves the others", () => {
    const next = applyToolChange(state(), { skins: { a: skin } });
    expect(next.slices[0]!.skin).toBe(skin);
    expect(next.slices[1]!.skin).toBe(skin);
    expect(next.flipbooks).toEqual(state().flipbooks);
  });

  it("drops a skin for null and ignores a slice that isn't there", () => {
    const next = applyToolChange(state(), { skins: { b: null, gone: skin } });
    expect(next.slices.map((s) => s.skin)).toEqual([undefined, undefined]);
    expect(next.slices).toHaveLength(2);
  });

  it("replaces the flipbooks as a whole, and changes nothing for an empty change", () => {
    const s = state();
    expect(applyToolChange(s, { flipbooks: { hop: { slices: ["a"], fps: 6, loop: false } } }).flipbooks).toEqual({ hop: { slices: ["a"], fps: 6, loop: false } });
    const same = applyToolChange(s, {});
    expect(same.slices).toBe(s.slices);
    expect(same.flipbooks).toBe(s.flipbooks);
  });

  it("is one undo step on the editor's history, and steps sharing a key are one", () => {
    const equal = (a: ToolState<{ name: string }>, b: ToolState<{ name: string }>) => JSON.stringify(a) === JSON.stringify(b);
    let h = createHistory(state());
    h = pushHistory(h, applyToolChange(h.present, { skins: { a: skin } }), { equal });
    expect(h.past).toHaveLength(1);
    for (const x of [3, 4, 5]) h = pushHistory(h, applyToolChange(h.present, { skins: { a: { ...skin, bones: [{ ...skin.bones[0]!, length: x }] } } }), { key: "drag", equal });
    expect(h.past).toHaveLength(2); // the drag is one step
    expect(undo(h).present.slices[0]!.skin?.bones[0]!.length).toBe(5);
    expect(undo(undo(h)).present.slices[0]!.skin).toBeUndefined();
  });
});

describe("renaming a slice", () => {
  it("follows the flipbooks that show it", () => {
    const flipbooks = { run: { slices: ["a", "b", "a"], fps: 12, loop: true }, idle: { slices: ["c"], fps: 6, loop: true } };
    const next = renameInFlipbooks(flipbooks, [["a", "a2"]]);
    expect(next.run!.slices).toEqual(["a2", "b", "a2"]);
    expect(next.idle).toBe(flipbooks.idle);
    expect(renameInFlipbooks(flipbooks, []).run).toBe(flipbooks.run);
  });
});

describe("the Lights 2D tools' changes (ADR 0414)", () => {
  const lit = (): ToolState<{ name: string; outline?: [number, number][][] }> => ({ slices: [{ name: "a" }, { name: "b" }], flipbooks: {}, secondary: { textures: { maskMap: "asset:m.png" }, normalMapGreen: "up" } });
  it("sets and drops slice outlines by name", () => {
    const next = applyToolChange(lit(), { outlines: { a: [[[0, 0], [4, 0], [2, 3]]], gone: [] } });
    expect(next.slices[0]!.outline).toEqual([[[0, 0], [4, 0], [2, 3]]]);
    expect(next.slices[1]!.outline).toBeUndefined();
    expect(applyToolChange(next, { outlines: { a: null } }).slices[0]!.outline).toBeUndefined();
  });

  it("replaces the secondary textures as a whole, dropping empty ones, and sets the green channel", () => {
    const next = applyToolChange(lit(), { secondaryTextures: { normalMap: "asset:n.png", maskMap: "" }, normalMapGreen: "down" });
    expect(next.secondary).toEqual({ textures: { normalMap: "asset:n.png" }, normalMapGreen: "down" });
    expect(applyToolChange(lit(), {}).secondary).toEqual(lit().secondary);
  });
});
