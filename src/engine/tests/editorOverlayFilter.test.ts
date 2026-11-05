import { describe, expect, it } from "vitest";
import { addEditorOverlay, removeEditorOverlay, setEditorOverlay, setEditorOverlayFilter, shownEditorOverlays, type EditorOverlay } from "../editor";
import type { World } from "../core/World";

/** A World with a render backend that records the provider it was given. */
function fakeWorld() {
  const state: { provider: (() => EditorOverlay) | null } = { provider: null };
  const world = { render: { setOverlayProvider: (p: (() => EditorOverlay) | null) => (state.provider = p) } } as unknown as World;
  return { world, state };
}
const line = (color: number): EditorOverlay["lines"][number] => ({ points: [[0, 0, 0], [1, 0, 0]], closed: false, color });
const colors = (state: { provider: (() => EditorOverlay) | null }) => state.provider?.().lines.map((l) => l.color) ?? null;

describe("editor overlay kinds and the per-World filter", () => {
  it("draws every kind without a filter, and an overlay added without a kind is \"other\"", () => {
    const { world, state } = fakeWorld();
    addEditorOverlay(world, "nav", () => ({ lines: [line(1)], handles: [] }), "navigation");
    addEditorOverlay(world, "col", () => ({ lines: [line(2)], handles: [] }), "colliders");
    addEditorOverlay(world, "game", () => ({ lines: [line(3)], handles: [] }));
    expect(colors(state)).toEqual([1, 2, 3]);
    setEditorOverlayFilter(world, (kind) => kind === "other");
    expect(colors(state)).toEqual([3]);
    expect(shownEditorOverlays(world)).toEqual(["game"]);
  });

  it("filters overlays added after the filter was set, and clearing the filter shows them all again", () => {
    const { world, state } = fakeWorld();
    setEditorOverlayFilter(world, (kind) => kind !== "navigation");
    addEditorOverlay(world, "nav", () => ({ lines: [line(1)], handles: [] }), "navigation");
    expect(state.provider).toBeNull(); // nothing shown: no provider, so the backend clears what it drew
    setEditorOverlay(world, () => ({ lines: [line(4)], handles: [] }));
    expect(colors(state)).toEqual([4]);
    setEditorOverlayFilter(world, null);
    expect(colors(state)).toEqual([1, 4]);
    expect(shownEditorOverlays(world)).toEqual(["nav", "default"]);
  });

  it("hides everything when the filter rejects every kind, and removal still works under a filter", () => {
    const { world, state } = fakeWorld();
    addEditorOverlay(world, "a", () => ({ lines: [line(1)], handles: [] }), "navigation");
    addEditorOverlay(world, "b", () => ({ lines: [line(2)], handles: [] }));
    setEditorOverlayFilter(world, () => false);
    expect(state.provider).toBeNull();
    expect(shownEditorOverlays(world)).toEqual([]);
    removeEditorOverlay(world, "a");
    setEditorOverlayFilter(world, () => true);
    expect(colors(state)).toEqual([2]);
  });

  it("keeps a filter per World", () => {
    const a = fakeWorld(), b = fakeWorld();
    for (const { world } of [a, b]) addEditorOverlay(world, "nav", () => ({ lines: [line(1)], handles: [] }), "navigation");
    setEditorOverlayFilter(a.world, () => false);
    expect(a.state.provider).toBeNull();
    expect(colors(b.state)).toEqual([1]);
  });
});
