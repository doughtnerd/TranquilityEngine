// ADR 0162 D2b: compile, combine and cache of the occluder materials (§2.2, §1.5).
import { describe, expect, it } from "vitest";
import {
  BUILTIN_MATERIALS, COMBINED_FLOOR_DB, HitAccumulator, OccluderCache, colliderLabel, compileHit, occlusionNote,
  type HitCost, type OccluderParams, type ResolvedHit,
} from "./occlusionMaterials";

const row = (n: string) => BUILTIN_MATERIALS.find((m) => m.name === n)!;
const fresh = (): ResolvedHit => ({ transmissionDb: 0, cutoffHz: 0, wetOcclusion: 0, material: "" });

describe("compileHit", () => {
  it("is the material's row with no trims and a closed wall", () => {
    expect(compileHit(row("wood"), 0, 1, 0, fresh())).toMatchObject({ transmissionDb: -12, cutoffHz: 2500, wetOcclusion: 0.5 });
  });
  it("adds the dB trim and scales the cutoff", () => {
    expect(compileHit(row("wood"), -6, 0.5, 0, fresh())).toMatchObject({ transmissionDb: -18, cutoffHz: 1250, wetOcclusion: 0.5 });
  });
  it("clamps the trimmed dB to -80..0 and the scaled cutoff to 100..22000", () => {
    expect(compileHit(row("concrete"), -100, 1, 0, fresh()).transmissionDb).toBe(-80);
    expect(compileHit(row("cloth"), 20, 1, 0, fresh()).transmissionDb).toBe(0);
    expect(compileHit(row("concrete"), 0, 0.01, 0, fresh()).cutoffHz).toBe(100);
    expect(compileHit(row("cloth"), 0, 10, 0, fresh()).cutoffHz).toBe(22000);
  });
  it("none and an unknown material are transparent, trims ignored", () => {
    for (const m of [row("none"), undefined]) {
      expect(compileHit(m, -20, 0.1, 0, fresh())).toMatchObject({ transmissionDb: 0, cutoffHz: 22000, wetOcclusion: 0 });
    }
  });
  it("openness blends dB and wet linearly and the cutoff in log scale; 1 is transparent", () => {
    const half = compileHit(row("concrete"), 0, 1, 0.5, fresh());
    expect(half.transmissionDb).toBeCloseTo(-15);
    expect(half.wetOcclusion).toBeCloseTo(0.3);
    expect(half.cutoffHz).toBeCloseTo(Math.sqrt(800 * 22000), 3);
    const open = compileHit(row("concrete"), 0, 1, 1, fresh());
    expect(open.transmissionDb).toBeCloseTo(0);
    expect(open.wetOcclusion).toBeCloseTo(0);
    expect(open.cutoffHz).toBeCloseTo(22000);
    expect(compileHit(row("concrete"), 0, 1, 7, fresh()).cutoffHz).toBeCloseTo(22000);
  });
});

describe("HitAccumulator", () => {
  const hit = (transmissionDb: number, cutoffHz: number, wetOcclusion: number): HitCost => ({ transmissionDb, cutoffHz, wetOcclusion });
  it("two hits: dB add, the lowest cutoff, wet combines", () => {
    const a = new HitAccumulator().reset();
    a.add(compileHit(row("wood"), 0, 1, 0, fresh())).add(compileHit(row("glass"), 0, 1, 0, fresh()));
    expect(a.transmissionDb).toBe(-20);
    expect(a.cutoffHz).toBe(2500);
    expect(a.wetOcclusion).toBeCloseTo(1 - 0.5 * 0.6);
    expect(a.hits).toBe(2);
  });
  it("floors the sum at -60 dB", () => {
    const a = new HitAccumulator().reset();
    a.add(hit(-30, 800, 0.6)).add(hit(-30, 800, 0.6)).add(hit(-30, 800, 0.6));
    expect(a.transmissionDb).toBe(COMBINED_FLOOR_DB);
  });
  it("starts transparent and reset clears it", () => {
    const a = new HitAccumulator();
    expect(a).toMatchObject({ transmissionDb: 0, cutoffHz: 22000, wetOcclusion: 0, hits: 0 });
    a.add(hit(-5, 3000, 0.2)).reset();
    expect(a).toMatchObject({ transmissionDb: 0, cutoffHz: 22000, wetOcclusion: 0, hits: 0 });
  });
  it("a transparent hit (none) changes nothing", () => {
    const a = new HitAccumulator().reset();
    a.add(compileHit(row("none"), 0, 1, 0, fresh())).add(compileHit(row("wood"), 0, 1, 0, fresh()));
    expect(a).toMatchObject({ transmissionDb: -12, cutoffHz: 2500, wetOcclusion: 0.5 });
  });
});

interface N { name: string; parent: N | null; occ?: OccluderParams }
const node = (name: string, parent: N | null = null, occ?: OccluderParams): N => ({ name, parent, occ });
const nearest = (n: N): OccluderParams | null => {
  for (let x: N | null = n; x; x = x.parent) if (x.occ) return x.occ;
  return null;
};
const occ = (material = "", transmissionTrimDb = 0, cutoffScale = 1, openness = 0): OccluderParams => ({ material, transmissionTrimDb, cutoffScale, openness });

describe("OccluderCache", () => {
  it("uses the project's default material for a collider with no occluder", () => {
    const c = new OccluderCache(nearest);
    expect(c.resolve(node("wall"), fresh())).toMatchObject({ material: "concrete", transmissionDb: -30, cutoffHz: 800 });
    c.configure(BUILTIN_MATERIALS, "cloth");
    expect(c.resolve(node("wall"), fresh())).toMatchObject({ material: "cloth", transmissionDb: -4 });
  });
  it("applies the nearest occluder up the parent chain, with its trims", () => {
    const c = new OccluderCache(nearest);
    const root = node("house", null, occ("glass"));
    const door = node("door", root, occ("wood", -3, 0.5));
    const panel = node("panel", door);
    const win = node("window", root);
    expect(c.resolve(panel, fresh())).toMatchObject({ material: "wood", transmissionDb: -15, cutoffHz: 1250 });
    expect(c.resolve(win, fresh())).toMatchObject({ material: "glass", transmissionDb: -8 });
  });
  it("none is transparent; an empty or unknown occluder material is the default", () => {
    const c = new OccluderCache(nearest);
    expect(c.resolve(node("a", null, occ("none", -9)), fresh())).toMatchObject({ material: "none", transmissionDb: 0, cutoffHz: 22000, wetOcclusion: 0 });
    expect(c.resolve(node("b", null, occ("")), fresh()).material).toBe("concrete");
    expect(c.resolve(node("c", null, occ("unobtainium")), fresh()).material).toBe("concrete");
  });
  it("applies openness live and notices edits to material, trims and scale", () => {
    const c = new OccluderCache(nearest);
    const o = occ("wood");
    const n = node("door", null, o);
    const out = fresh();
    expect(c.resolve(n, out).transmissionDb).toBe(-12);
    o.openness = 0.5;
    expect(c.resolve(n, out).transmissionDb).toBeCloseTo(-6);
    o.openness = 1;
    c.resolve(n, out);
    expect(out.transmissionDb).toBeCloseTo(0);
    expect(out.wetOcclusion).toBeCloseTo(0);
    expect(out.cutoffHz).toBeCloseTo(22000);
    o.openness = 0;
    o.material = "metal";
    o.transmissionTrimDb = -5;
    expect(c.resolve(n, out)).toMatchObject({ material: "metal", transmissionDb: -30, cutoffHz: 1200 });
  });
  it("matches compileHit for the same inputs", () => {
    const c = new OccluderCache(nearest);
    const out = c.resolve(node("w", null, occ("glass", -2, 0.7, 0.3)), fresh());
    const direct = compileHit(row("glass"), -2, 0.7, 0.3, fresh());
    expect(out.transmissionDb).toBeCloseTo(direct.transmissionDb);
    expect(out.cutoffHz).toBeCloseTo(direct.cutoffHz);
    expect(out.wetOcclusion).toBeCloseTo(direct.wetOcclusion);
  });
  it("caches per node and looks the occluder up once; invalidate and configure drop entries", () => {
    let finds = 0;
    const c = new OccluderCache((n) => (finds++, nearest(n as N)));
    const n = node("w", null, occ("glass"));
    c.resolve(n, fresh());
    c.resolve(n, fresh());
    expect([finds, c.size]).toEqual([1, 1]);
    n.occ = undefined; // an occluder removed: stale until invalidated
    expect(c.resolve(n, fresh()).material).toBe("glass");
    c.invalidate();
    expect(c.size).toBe(0);
    expect(c.resolve(n, fresh()).material).toBe("concrete");
    c.configure([{ name: "concrete", transmissionDb: -40, cutoffHz: 500, wetOcclusion: 1 }], "concrete");
    expect(c.size).toBe(0);
    expect(c.resolve(n, fresh())).toMatchObject({ transmissionDb: -40, cutoffHz: 500 });
  });
});

describe("debug helpers", () => {
  it("labels a collider by its node name", () => {
    expect(colliderLabel(node("Door"))).toBe("Door");
    expect(colliderLabel(node(""))).toBe("(unnamed)");
    expect(colliderLabel(null)).toBeNull();
  });
  it("says why occlusion is inert", () => {
    expect(occlusionNote(true, false)).toBe("");
    expect(occlusionNote(false, true)).toBe("2D world");
    expect(occlusionNote(false, false)).toBe("no 3D physics service");
  });
});
