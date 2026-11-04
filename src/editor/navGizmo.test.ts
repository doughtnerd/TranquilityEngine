import { describe, expect, it } from "vitest";
import { LINE_KIND } from "../engine/nav/debugGeometry";
import { NavBakeOverlay, bakePathsOf, cleanNavOverlay, navDebugColors, type NavOverlaySettings } from "./navGizmo";
import { PRESETS, resolveTheme } from "./theme";

const tick = () => new Promise((r) => setTimeout(r, 0));
const colors = navDebugColors(resolveTheme(PRESETS[0]));

describe("the scene view's navigation overlay", () => {
  it("finds the baked assets of a scene's NavChunk nodes", () => {
    const doc = {
      nodes: [
        { components: [{ type: "engine.NavChunk", data: { bake: "asset:scenes/main.nav.bin" } }] },
        { components: [{ type: "engine.NavChunk", data: { bake: { path: "./scenes/main.nav.bin" } } }] },
        { components: [{ type: "engine.NavChunk", data: { bake: "" } }, { type: "engine.Other", data: { bake: "asset:x" } }] },
      ],
    };
    expect(bakePathsOf(doc)).toEqual(["scenes/main.nav.bin"]);
  });

  it("cleans stored settings", () => {
    expect(cleanNavOverlay({ navmesh: true, group: -1 } as Partial<NavOverlaySettings>)).toMatchObject({ navmesh: true, links: false, group: 0 });
    expect(cleanNavOverlay(null).group).toBe(0);
  });

  it("takes its colours from the theme, each kind distinct", () => {
    expect(new Set(Object.values(colors)).size).toBeGreaterThanOrEqual(7);
  });

  it("loads a bake once, draws by toggle and group, and re-reads when the asset changes", async () => {
    let settings: NavOverlaySettings = { ...cleanNavOverlay({}), navmesh: true, links: true };
    let url = "blob:1";
    let reads = 0, now = 0;
    // Two segments (outline, fold) whose x is shifted by the group, so the group is visible in the result.
    const linesFor = async (_bytes: Uint8Array, group: number) =>
      Float32Array.from([group, 0, 0, group + 1, 0, 0, LINE_KIND.outline, group, 0, 0, group, 1, 0, LINE_KIND.fold]);
    const overlay = new NavBakeOverlay(
      () => settings,
      () => colors,
      () => now,
      async () => (reads++, new Uint8Array([1])),
      linesFor,
      async () => Float32Array.from([0, 0, 0, 1, 1]),
      () => ({ paths: ["scenes/main.nav.bin"], urlOf: () => url, token: "scene", version: 1 }),
    );
    expect(overlay.segments()).toEqual([]); // loading
    await tick();
    const drawn = overlay.segments();
    expect(overlay.stats).toMatchObject({ bakes: 1, loaded: 1, segments: 2 });
    expect(drawn.map((s) => s.color).sort()).toEqual([colors.outline, colors.fold].sort());
    expect(overlay.segments()).toBe(drawn); // memoised
    expect(reads).toBe(1);

    settings = { ...settings, links: false };
    expect(overlay.segments().map((s) => s.color)).toEqual([colors.outline]);

    settings = { ...settings, volume: true };
    overlay.segments();
    await tick();
    expect(overlay.segments().some((s) => s.color === colors.volume)).toBe(true);

    settings = { ...settings, group: 2 };
    overlay.segments();
    await tick();
    expect(overlay.segments().find((s) => s.color === colors.outline)!.positions[0]).toBe(2);

    const before = reads;
    url = "blob:2"; // the bake was written again; noticed within a second
    now = 2000;
    overlay.segments();
    await tick();
    expect(overlay.segments().length).toBeGreaterThan(0);
    expect(reads).toBeGreaterThan(before);
  });

  it("draws nothing with every toggle off, and reports a bake that does not read", async () => {
    const off = new NavBakeOverlay(() => cleanNavOverlay({}), () => colors);
    expect(off.segments()).toEqual([]);
    const broken = new NavBakeOverlay(
      () => ({ ...cleanNavOverlay({}), navmesh: true }),
      () => colors,
      () => 0,
      async () => {
        throw new Error("404");
      },
      async () => new Float32Array(0),
      async () => new Float32Array(0),
      () => ({ paths: ["a.nav.bin"], urlOf: () => "blob:x", token: 1, version: 1 }),
    );
    broken.segments();
    await tick();
    broken.segments();
    expect(broken.stats.failed).toEqual(["404"]);
  });
});
