// ADR 0460 §3: where the stand-in trimming module can't load, LOD generation still makes the levels but no occluder
// stand-in (an untrimmed one isn't conservative), and says so once. The module's loader is mocked to fail.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LOD_SETTINGS } from "./types";
import { generateLods, type LodSource } from "./generate";

vi.mock("./standInTrim", () => ({ loadStandInTrimmer: () => Promise.reject(new Error("no wasm here")) }));

/** A gently bumped sheet, 40×40 cells. */
function sheet(): LodSource {
  const N = 40;
  const positions: number[] = [], indices: number[] = [];
  for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) positions.push(x / N, y / N, 0.0005 * Math.sin(x) * Math.cos(y));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * (N + 1) + x;
    indices.push(i, i + 1, i + N + 1, i + 1, i + N + 2, i + N + 1);
  }
  return {
    streams: { positions: new Float32Array(positions), normals: null, uvs: null, uvs2: null, colors: null, tangents: null, joints: null, weights: null, influences: 0, morphs: [] },
    indices: new Uint32Array(indices),
    groups: [],
  };
}

describe("LOD generation without the trimming module", () => {
  it("makes the levels but no occluder stand-in, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = await generateLods(sheet(), DEFAULT_LOD_SETTINGS, "auto");
      const b = await generateLods(sheet(), DEFAULT_LOD_SETTINGS, "lod");
      expect(a.levels).toHaveLength(4);
      expect(a.occluder).toBeNull();
      expect(b.occluder).toBeNull();
      expect(warn.mock.calls.filter((c) => /occluder trimming module/.test(String(c[0])))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});
