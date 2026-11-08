import { describe, expect, it } from "vitest";
import { addEditorOverlay, mergeOverlays, navigationOf, removeEditorOverlay, setEditorOverlay, type EditorOverlay } from "../editor";
import type { World } from "../core/World";
import { FakeRenderSurface } from "../render/fakeViewport";
import {
  LINE_KIND,
  NAV_DEBUG_CAPS,
  RuntimeNavOverlay,
  chunkIdsOf,
  leafSegments,
  navmeshLineSegments,
  readNavDebugFlags,
  rowSegments,
  type NavDebugColors,
  type NavDebugSource,
} from "../nav/debugGeometry";

const colors: NavDebugColors = { outline: 1, shared: 2, fold: 3, jump: 4, chunkFace: 5, volume: 6, landing: 7, seam: 8, path: 9, costly: 10, cheap: 11, excluded: 12 };

/** A World with a fake render surface (ADR 0128) whose viewport records the overlay provider it was given. */
function fakeWorld() {
  const surface = new FakeRenderSurface();
  const world = { render: surface } as unknown as World;
  const state = { get provider(): (() => EditorOverlay) | null { return surface.adapter.overlay; } };
  return { world, state };
}
const line = (color: number): EditorOverlay["lines"][number] => ({ points: [[0, 0, 0], [1, 0, 0]], closed: false, color });

describe("composable editor overlays", () => {
  it("merges several providers in the order added, and a repeated id replaces", () => {
    const { world, state } = fakeWorld();
    addEditorOverlay(world, "a", () => ({ lines: [line(1)], handles: [] }));
    addEditorOverlay(world, "b", () => ({ lines: [line(2)], handles: [{ id: "h", position: [0, 0, 0], color: 3 }], segments: [{ positions: new Float32Array(6), color: 4 }] }));
    const merged = state.provider!();
    expect(merged.lines.map((l) => l.color)).toEqual([1, 2]);
    expect(merged.handles).toHaveLength(1);
    expect(merged.segments).toHaveLength(1);
    addEditorOverlay(world, "a", () => ({ lines: [line(9)], handles: [] }));
    expect(state.provider!().lines.map((l) => l.color)).toEqual([9, 2]);
  });

  it("removes one by id and clears the backend when none are left", () => {
    const { world, state } = fakeWorld();
    addEditorOverlay(world, "a", () => ({ lines: [line(1)], handles: [] }));
    addEditorOverlay(world, "b", () => ({ lines: [line(2)], handles: [] }));
    removeEditorOverlay(world, "a");
    expect(state.provider!().lines.map((l) => l.color)).toEqual([2]);
    removeEditorOverlay(world, "b");
    expect(state.provider).toBeNull();
    removeEditorOverlay(world, "never-added"); // harmless
  });

  it("keeps setEditorOverlay working beside other overlays", () => {
    const { world, state } = fakeWorld();
    addEditorOverlay(world, "nav", () => ({ lines: [line(5)], handles: [] }));
    setEditorOverlay(world, () => ({ lines: [line(6)], handles: [] }));
    expect(state.provider!().lines.map((l) => l.color)).toEqual([5, 6]);
    setEditorOverlay(world, null);
    expect(state.provider!().lines.map((l) => l.color)).toEqual([5]);
  });

  it("merges nothing into an empty overlay with no segments key", () => {
    expect(mergeOverlays([])).toEqual({ lines: [], handles: [] });
  });

  it("reads a World's navigation defensively", () => {
    expect(navigationOf({} as World)).toBeNull();
    expect(navigationOf({ navigation: null } as unknown as World)).toBeNull();
    const nav = { runtime: {} };
    expect(navigationOf({ navigation: nav } as unknown as World)).toBe(nav);
  });
});

describe("debug buffers to segments", () => {
  // stride 7: a xyz, b xyz, kind
  const lines = Float32Array.from([
    0, 0, 0, 1, 0, 0, LINE_KIND.outline,
    1, 0, 0, 1, 0, 1, LINE_KIND.shared,
    0, 0, 0, 0, 1, 0, LINE_KIND.fold,
    0, 0, 0, 4, 0, 0, LINE_KIND.jump,
    5, 0, 0, 5, 0, 1, LINE_KIND.chunkFace,
  ]);
  const byColor = (segs: { positions: Float32Array; color: number }[]) => Object.fromEntries(segs.map((s) => [s.color, s.positions.length / 6]));

  it("colours each kind and splits them between the Navmesh and Links toggles", () => {
    expect(byColor(navmeshLineSegments(lines, { navmesh: true, links: false }, colors))).toEqual({ 1: 1, 2: 1, 5: 1 });
    expect(byColor(navmeshLineSegments(lines, { navmesh: false, links: true }, colors, 100, 1))).toEqual({ 3: 1, 4: 1 });
    expect(navmeshLineSegments(lines, { navmesh: false, links: false }, colors)).toEqual([]);
  });

  it("draws jump links as arcs that rise and end where the link does", () => {
    const [jump] = navmeshLineSegments(lines, { navmesh: false, links: true }, colors, 100, 8).filter((s) => s.color === colors.jump);
    expect(jump.positions.length / 6).toBe(8);
    const ys = Array.from({ length: 8 }, (_, i) => jump.positions[i * 6 + 4]);
    expect(Math.max(...ys)).toBeGreaterThan(0.5);
    expect([...jump.positions.slice(-3)]).toEqual([4, 0, 0]);
  });

  it("caps the segment count", () => {
    const many = new Float32Array(7 * 1000);
    for (let i = 0; i < 1000; i++) many.set([i, 0, 0, i + 1, 0, 0, LINE_KIND.outline], i * 7);
    const out = navmeshLineSegments(many, { navmesh: true, links: true }, colors, 100);
    expect(out.reduce((n, s) => n + s.positions.length / 6, 0)).toBe(100);
    expect(rowSegments(new Float32Array(7 * 500), 7, 9, 50)[0].positions.length / 6).toBe(50);
  });

  it("draws flight leaves as 12 cube edges each and thins them past the cap", () => {
    expect(leafSegments(Float32Array.from([0, 0, 0, 2, 8]), colors.volume)[0].positions.length / 6).toBe(12);
    const leaves = new Float32Array(5 * 10_000);
    for (let i = 0; i < 10_000; i++) leaves.set([i, 0, 0, 1, 1], i * 5);
    const drawn = leafSegments(leaves, colors.volume)[0].positions.length / 6 / 12;
    expect(drawn).toBeLessThanOrEqual(NAV_DEBUG_CAPS.leaves);
    expect(drawn).toBeGreaterThan(NAV_DEBUG_CAPS.leaves / 2);
  });

  it("reads flags tolerantly", () => {
    expect(readNavDebugFlags(undefined)).toMatchObject({ navmesh: false, paths: false });
    expect(readNavDebugFlags(true)).toMatchObject({ navmesh: true, links: true, volume: false, paths: true });
    expect(readNavDebugFlags({ navmesh: true, links: "yes" })).toMatchObject({ navmesh: true, links: false });
  });

  it("finds chunk ids in whatever the world lists", () => {
    expect(chunkIdsOf(["a", { id: "b" }, { chunkId: "c" }, 3, null])).toEqual(["a", "b", "c"]);
    expect(chunkIdsOf(new Map([["x", {}]]))).toEqual(["x"]);
    expect(chunkIdsOf(undefined)).toEqual([]);
  });
});

describe("the live runtime overlay", () => {
  it("draws what the flags ask for and refreshes slow and fast geometry on their own clocks", () => {
    let navmeshCalls = 0, pathCalls = 0;
    const source: NavDebugSource = {
      debugNavmeshLines: () => (navmeshCalls++, Float32Array.from([0, 0, 0, 1, 0, 0, LINE_KIND.outline])),
      debugVolumeLeaves: () => new Float32Array(0),
      debugLandingLinks: () => new Float32Array(0),
      debugSeams: () => new Float32Array(0),
      debugAgentPaths: () => (pathCalls++, Float32Array.from([0, 0, 0, 1, 1, 1, 0])),
    };
    let now = 0;
    let flags = readNavDebugFlags({ navmesh: true, paths: true });
    const overlay = new RuntimeNavOverlay(source, () => ["c1", "c2"], () => ["walker"], () => flags, () => colors, () => now);
    const first = overlay.segments();
    expect(first.map((s) => s.color).sort()).toEqual([1, 1, 9]); // two chunks' outlines, one path set
    now = 50;
    overlay.segments();
    expect(navmeshCalls).toBe(2);
    expect(pathCalls).toBe(1);
    now = 150;
    overlay.segments();
    expect(navmeshCalls).toBe(2);
    expect(pathCalls).toBe(2);
    now = 700;
    overlay.segments();
    expect(navmeshCalls).toBe(4);
    flags = readNavDebugFlags({});
    expect(overlay.segments()).toEqual([]);
  });
});
