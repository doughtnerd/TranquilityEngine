import { describe, expect, it } from "vitest";
import { BUILTIN_MATERIALS, MAX_MATERIALS, builtinMaterials, parseOccluderMaterials, resolveDefaultMaterial } from "../audio/occlusionMaterials";

// L-A6b. ADR 0162 api-and-models §2.2.
describe("occluder materials (ADR 0162 §2.2)", () => {
  it("the built-in table: none 0/22000/1, cloth -4/8000/0.3, glass -8/5000/0.4, wood -12/2500/0.5, metal -25/1200/0.6, concrete -30/800/0.6, in that order", () => {
    expect(BUILTIN_MATERIALS.map((m) => [m.name, m.transmissionDb, m.cutoffHz, m.wetOcclusion])).toEqual([
      ["none", 0, 22000, 1],
      ["cloth", -4, 8000, 0.3],
      ["glass", -8, 5000, 0.4],
      ["wood", -12, 2500, 0.5],
      ["metal", -25, 1200, 0.6],
      ["concrete", -30, 800, 0.6],
    ]);
  });

  it("builtinMaterials returns a fresh copy each call", () => {
    const a = builtinMaterials();
    a[1].transmissionDb = -99;
    a.pop();
    const b = builtinMaterials();
    expect(b).toHaveLength(6);
    expect(b[1].transmissionDb).toBe(-4);
    expect(b[1]).not.toBe(a[1]);
  });

  it("absent (undefined) gives the six built-ins with no problem", () => {
    const problems: string[] = [];
    expect(parseOccluderMaterials(undefined, "audio.occlusion.materials", problems)).toEqual(BUILTIN_MATERIALS);
    expect(problems).toEqual([]);
  });

  it("an authored name not built in is appended; one named like a built-in replaces it in place and keeps the built-in's other fields when omitted", () => {
    const problems: string[] = [];
    const table = parseOccluderMaterials(
      [
        { name: "brick", transmissionDb: -18, cutoffHz: 1500, wetOcclusion: 0.7, attackMs: 40 },
        { name: "wood", cutoffHz: 3000 },
      ],
      "audio.occlusion.materials",
      problems,
    );
    expect(problems).toEqual([]);
    expect(table.map((m) => m.name)).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete", "brick"]);
    expect(table[3]).toEqual({ name: "wood", transmissionDb: -12, cutoffHz: 3000, wetOcclusion: 0.5 });
    expect(table[6]).toEqual({ name: "brick", transmissionDb: -18, cutoffHz: 1500, wetOcclusion: 0.7, attackMs: 40 });
  });

  it("transmissionDb, cutoffHz, wetOcclusion clamp to their ranges with a problem each; attackMs and releaseMs clamp to 0..2000", () => {
    const problems: string[] = [];
    const table = parseOccluderMaterials(
      [{ name: "foil", transmissionDb: -120, cutoffHz: 50, wetOcclusion: 1.5, attackMs: 5000, releaseMs: -3 }],
      "audio.occlusion.materials",
      problems,
    );
    const foil = table.find((m) => m.name === "foil");
    expect(foil).toEqual({ name: "foil", transmissionDb: -80, cutoffHz: 100, wetOcclusion: 1, attackMs: 2000, releaseMs: 0 });
    expect(problems).toHaveLength(5);
    expect(problems.every((p) => p.startsWith("audio.occlusion.materials[0]."))).toBe(true);
    expect(problems[0]).toContain("transmissionDb");
    expect(problems[4]).toContain("releaseMs");
  });

  it("a non-number numeric field takes the built-in's (else concrete's) value plus a problem; a non-number attackMs is dropped plus a problem", () => {
    const problems: string[] = [];
    const table = parseOccluderMaterials(
      [
        { name: "cloth", transmissionDb: "loud", cutoffHz: null, wetOcclusion: 0.9 },
        { name: "paper", transmissionDb: NaN, cutoffHz: 4000, wetOcclusion: 0.2, attackMs: "fast" },
      ],
      "audio.occlusion.materials",
      problems,
    );
    expect(table[1]).toEqual({ name: "cloth", transmissionDb: -4, cutoffHz: 8000, wetOcclusion: 0.9 });
    expect(table[6]).toEqual({ name: "paper", transmissionDb: -30, cutoffHz: 4000, wetOcclusion: 0.2 });
    expect("attackMs" in table[6]).toBe(false);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain("using -4");
    expect(problems[2]).toContain("using -30");
    expect(problems[3]).toContain("dropped");
  });

  it("attackMs and releaseMs absent stay absent (the key is not on the object)", () => {
    const problems: string[] = [];
    const table = parseOccluderMaterials([{ name: "rubber" }], "audio.occlusion.materials", problems);
    const rubber = table.find((m) => m.name === "rubber")!;
    expect(Object.keys(rubber).sort()).toEqual(["cutoffHz", "name", "transmissionDb", "wetOcclusion"]);
    expect(problems).toEqual([]);
    for (const m of table) {
      expect("attackMs" in m).toBe(false);
      expect("releaseMs" in m).toBe(false);
    }
  });

  it("a duplicate name is dropped plus a problem and the first wins; a non-object entry or an empty or missing name is dropped plus a problem", () => {
    const problems: string[] = [];
    const table = parseOccluderMaterials(
      [
        { name: "brick", transmissionDb: -10, cutoffHz: 2000, wetOcclusion: 0.5 },
        { name: "brick", transmissionDb: -40, cutoffHz: 500, wetOcclusion: 0.9 },
        "glass",
        { name: "" },
        { transmissionDb: -5 },
        { name: "   " },
        null,
      ],
      "audio.occlusion.materials",
      problems,
    );
    expect(table.map((m) => m.name)).toEqual(["none", "cloth", "glass", "wood", "metal", "concrete", "brick"]);
    expect(table[6].transmissionDb).toBe(-10);
    expect(problems).toHaveLength(6);
    expect(problems[0]).toContain("[1]");
    expect(problems[0]).toContain('"brick"');
    expect(problems[1]).toContain("[2]");
    expect(problems[5]).toContain("[6]");
  });

  it("a duplicate of a built-in name counts once: the authored override wins and a second authored copy is dropped", () => {
    const problems: string[] = [];
    const table = parseOccluderMaterials(
      [
        { name: "metal", transmissionDb: -15 },
        { name: "metal", transmissionDb: -60 },
      ],
      "audio.occlusion.materials",
      problems,
    );
    expect(table).toHaveLength(6);
    expect(table[4]).toEqual({ name: "metal", transmissionDb: -15, cutoffHz: 1200, wetOcclusion: 0.6 });
    expect(problems).toHaveLength(1);
  });

  it("a non-list gives the built-ins plus a problem; more than 32 authored entries ignore the rest plus a problem; the effective table never exceeds 32", () => {
    const notList: string[] = [];
    expect(parseOccluderMaterials({ name: "x" }, "audio.occlusion.materials", notList)).toEqual(BUILTIN_MATERIALS);
    expect(notList).toHaveLength(1);

    const many: string[] = [];
    const authored = Array.from({ length: 40 }, (_, i) => ({ name: `m${i}`, transmissionDb: -1, cutoffHz: 1000, wetOcclusion: 0 }));
    const table = parseOccluderMaterials(authored, "audio.occlusion.materials", many);
    expect(table).toHaveLength(MAX_MATERIALS);
    expect(table[MAX_MATERIALS - 1].name).toBe("m25");
    expect(many.some((p) => p.includes("at most 32"))).toBe(true);

    const exact: string[] = [];
    const full = parseOccluderMaterials(
      Array.from({ length: MAX_MATERIALS - BUILTIN_MATERIALS.length }, (_, i) => ({ name: `n${i}` })),
      "audio.occlusion.materials",
      exact,
    );
    expect(full).toHaveLength(MAX_MATERIALS);
    expect(exact).toEqual([]);
  });

  it("resolveDefaultMaterial: undefined gives concrete, a known name is kept, an unknown or non-string gives concrete plus the problem text", () => {
    const table = builtinMaterials();
    const problems: string[] = [];
    expect(resolveDefaultMaterial(undefined, table, "audio.occlusion.defaultMaterial", problems)).toBe("concrete");
    expect(resolveDefaultMaterial("wood", table, "audio.occlusion.defaultMaterial", problems)).toBe("wood");
    expect(problems).toEqual([]);

    expect(resolveDefaultMaterial("mud", table, "audio.occlusion.defaultMaterial", problems)).toBe("concrete");
    expect(problems).toEqual(['audio.occlusion.defaultMaterial: unknown material "mud"; using "concrete".']);
    expect(resolveDefaultMaterial(42, table, "audio.occlusion.defaultMaterial", problems)).toBe("concrete");
    expect(problems[1]).toBe('audio.occlusion.defaultMaterial: unknown material "42"; using "concrete".');
  });

  it("resolveDefaultMaterial falls back to the first material when concrete is not in the table", () => {
    const problems: string[] = [];
    const table = builtinMaterials().filter((m) => m.name !== "concrete");
    expect(resolveDefaultMaterial(undefined, table, "k", problems)).toBe("none");
    expect(resolveDefaultMaterial("nope", table, "k", problems)).toBe("none");
    expect(problems).toHaveLength(1);
  });
});
