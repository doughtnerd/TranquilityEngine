import { describe, expect, it } from "vitest";
import { clampBorder, spriteFrame, spriteMeshData, SPRITE_GRID_INDICES } from "../render/spriteFrame";
import { defaultImportSettings, importSettingsJSON, parseImportSettings } from "../scene/importSettings";

const frameOf = (border: [number, number, number, number] | undefined, size?: { x: number; y: number }) => {
  const settings = defaultImportSettings();
  settings.sprites.push({ name: "panel", rect: [8, 8, 32, 16], pivot: [0.5, 0.5], ...(border ? { border } : {}) });
  return spriteFrame(settings, "panel", 64, 64, { component: 0, project: 16 }, size);
};

describe("9-slice sprite meshes", () => {
  it("has no border without one, and draws the plain quad", () => {
    const f = frameOf(undefined);
    expect(f.border).toBeNull();
    const m = spriteMeshData(f, 64, 64);
    expect(m.positions).toHaveLength(48);
    expect(m.uvs).toHaveLength(32);
    // Corners of the grid are the unit quad's corners; UVs span the slice.
    expect(m.positions.slice(0, 3)).toEqual([-0.5, -0.5, 0]);
    expect(m.positions.slice(45, 48)).toEqual([0.5, 0.5, 0]);
    expect(m.uvs.slice(0, 2)).toEqual([8 / 64, 1 - 24 / 64]);
    expect(m.uvs.slice(30, 32)).toEqual([40 / 64, 1 - 8 / 64]);
  });

  it("keeps corners fixed in pixels and stretches the middle", () => {
    // 32 × 16 px slice at 16 px/unit = 2 × 1 units, drawn 4 × 2 units; border 4 px = 0.25 units.
    const f = frameOf([4, 2, 4, 2], { x: 4, y: 2 });
    const m = spriteMeshData(f, 64, 64);
    const x = (col: number) => m.positions[col * 3];
    const y = (row: number) => m.positions[row * 4 * 3 + 1];
    expect(x(1) + 0.5).toBeCloseTo(0.25 / 4);
    expect(x(2) + 0.5).toBeCloseTo(1 - 0.25 / 4);
    expect(y(1) + 0.5).toBeCloseTo(0.125 / 2);
    expect(y(2) + 0.5).toBeCloseTo(1 - 0.125 / 2);
    const u = (col: number) => m.uvs[col * 2];
    expect(u(1)).toBeCloseTo((8 + 4) / 64);
    expect(u(2)).toBeCloseTo((40 - 4) / 64);
    const v = (row: number) => m.uvs[row * 8 + 1];
    expect(v(0)).toBeCloseTo(1 - 24 / 64);
    expect(v(1)).toBeCloseTo(1 - 24 / 64 + 2 / 64);
    expect(v(2)).toBeCloseTo(1 - 8 / 64 - 2 / 64);
  });

  it("shrinks opposite corners together when the sprite is smaller than they are", () => {
    const f = frameOf([8, 0, 8, 0], { x: 0.5, y: 1 }); // corners want 0.5 + 0.5 units, sprite is 0.5 wide
    const m = spriteMeshData(f, 64, 64);
    expect(m.positions[3] + 0.5).toBeCloseTo(0.5);
    expect(m.positions[6] + 0.5).toBeCloseTo(0.5);
  });

  it("clamps borders inside the slice", () => {
    expect(clampBorder([-3, 0, 30, 0], 32, 16)).toEqual([0, 0, 30, 0]);
    const [l, , r] = clampBorder([20, 0, 20, 0], 32, 16);
    expect(l + r).toBeCloseTo(32);
    expect(frameOf([0, 0, 0, 0]).border).toBeNull();
  });

  it("indexes nine cells of two triangles", () => {
    expect(SPRITE_GRID_INDICES).toHaveLength(54);
    expect(Math.max(...SPRITE_GRID_INDICES)).toBe(15);
    expect(SPRITE_GRID_INDICES.slice(0, 6)).toEqual([0, 1, 5, 0, 5, 4]);
  });
});

describe("tiled 9-slice meshes", () => {
  const tiled = (border: [number, number, number, number] | undefined, size: { x: number; y: number }) => {
    const settings = defaultImportSettings();
    settings.sprites.push({ name: "panel", rect: [0, 0, 32, 16], pivot: [0.5, 0.5], fill: "tile", ...(border ? { border } : {}) });
    return spriteFrame(settings, "panel", 32, 16, { component: 0, project: 16 }, size);
  };
  const quads = (m: ReturnType<typeof spriteMeshData>) => m.positions.length / 12;

  it("defaults to stretch and parses fill leniently", () => {
    expect(frameOf(undefined).fill).toBe("stretch");
    expect(tiled(undefined, { x: 2, y: 1 }).fill).toBe("tile");
    const parsed = parseImportSettings({ format: "myco.import@1", sprites: [{ name: "a", rect: [0, 0, 4, 4], fill: "tile" }, { name: "b", rect: [0, 0, 4, 4], fill: "weird" }] }, "x.png");
    expect(parsed.settings.sprites.map((s) => s.fill)).toEqual(["tile", undefined]);
    expect(parsed.problems).toHaveLength(1);
    const out = importSettingsJSON(parsed.settings) as { sprites: { fill?: string }[] };
    expect(out.sprites.map((s) => s.fill)).toEqual(["tile", undefined]);
  });

  it("repeats the centre at its pixel size and crops the last tile", () => {
    // 32x16 px at 16 ppu: tile is 2 x 1 units (no border). Draw 5 x 1: two full tiles and a half.
    const m = spriteMeshData(tiled(undefined, { x: 5, y: 1 }), 32, 16);
    expect(quads(m)).toBe(3);
    expect(m.indices).toHaveLength(18);
    // Third quad spans x 0.8..1 of the unit quad and half the texture's u range.
    expect(m.positions[2 * 12]).toBeCloseTo(0.8 - 0.5);
    expect(m.uvs[2 * 8 + 2]).toBeCloseTo(0.5);
    expect(m.uvs[2 * 8]).toBe(0);
  });

  it("keeps corners and tiles only the middle", () => {
    // border 4 px = .25 unit; middle 24 px = 1.5 units; draw 4 wide: middle 3.5 -> 3 tiles (last cropped); 1 tall with no vertical border.
    const m = spriteMeshData(tiled([4, 0, 4, 0], { x: 4, y: 1 }), 32, 16);
    expect(quads(m)).toBe(2 + 3);
    // left corner quad is 0.25/4 wide and uses u 0..4/32
    expect(m.positions[3] - m.positions[0]).toBeCloseTo(0.25 / 4);
    expect(m.uvs[2]).toBeCloseTo(4 / 32);
  });

  it("falls back to stretch and flags it past the tile cap", () => {
    const m = spriteMeshData(tiled(undefined, { x: 2000, y: 1000 }), 32, 16);
    expect(m.tileCapped).toBe(true);
    expect(m.positions).toHaveLength(48);
  });
});
