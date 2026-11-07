import { describe, expect, it } from "vitest";
import { BLOCKS, blockDef, blocksFor, defaultBlock } from "../scene/particleBlocks";
import { CONTEXT_KINDS } from "../scene/particleGraph";
import { parseParticleGraph, formatParticleGraph, emptyParticleGraph } from "../scene/particleGraphFormat";
import { BEHAVIOR_TYPES, SHAPE_TYPES } from "../scene/particles";

describe("particle block registry (ADR 0060)", () => {
  it("has unique types that name a known context", () => {
    const types = BLOCKS.map((b) => b.type);
    expect(new Set(types).size).toBe(types.length);
    for (const b of BLOCKS) {
      expect(b.contexts.length).toBeGreaterThan(0);
      for (const c of b.contexts) expect(CONTEXT_KINDS).toContain(c);
      // Set Attribute blocks (ADR 0095) fit several contexts and share the "attribute." prefix.
      expect(b.type.startsWith("attribute.") || b.type.startsWith({ spawn: "spawn.", initialize: "init.", update: "update.", output: "output." }[b.contexts[0]])).toBe(true);
      expect(b.label).not.toBe("");
      expect(b.description).not.toBe("");
    }
  });

  it("covers every @1 shape and behaviour", () => {
    for (const s of SHAPE_TYPES) expect(blockDef(`init.position${s[0].toUpperCase()}${s.slice(1)}`)).toBeDefined();
    for (const t of BEHAVIOR_TYPES) expect(blockDef(t === "widthOverLength" ? "output.widthOverLength" : `update.${t}`)).toBeDefined();
    expect(blockDef("update.triggerEvent")?.event).toBe(true);
  });

  it("has unique input names and valid defaults", () => {
    for (const b of BLOCKS) {
      const names = b.inputs.map((i) => i.name);
      expect(new Set(names).size, b.type).toBe(names.length);
      for (const i of b.inputs) {
        if (i.type === "enum") expect(i.choices).toContain(i.default);
        if (i.type === "vector2") expect((i.default as number[]).length).toBe(2);
        if (i.type === "vector3") expect((i.default as number[]).length).toBe(3);
        if (i.type === "bool") expect(typeof i.default).toBe("boolean");
        if (i.type === "number" || i.type === "color") expect(i.forms?.length).toBeGreaterThan(0);
      }
    }
  });

  it("round-trips every default block through parse unchanged", () => {
    for (const b of BLOCKS) {
      const graph = emptyParticleGraph();
      const kind = b.contexts[0];
      const block = defaultBlock(b.type, "b1");
      graph.systems.push({
        id: "s1",
        name: "S",
        position: [0, 0],
        settings: { space: "world", capacity: 100 },
        spawn: { settings: { duration: 5, looping: true, startDelay: 0, prewarm: false }, blocks: kind === "spawn" ? [block] : [] },
        initialize: { blocks: kind === "initialize" ? [block] : [] },
        update: { blocks: kind === "update" ? [block] : [] },
        output: { type: "quad", settings: { material: "", texture: "", blending: "additive", renderOrder: 0, mesh: "builtin:cube", speedScale: 0, lengthScale: 1, trailLength: 20 }, blocks: kind === "output" ? [block] : [] },
      });
      const { graph: back, problems } = parseParticleGraph(JSON.parse(formatParticleGraph(graph)));
      expect(problems, b.type).toEqual([]);
      expect(back, b.type).toEqual(graph);
    }
  });

  it("looks blocks up and filters them by context", () => {
    expect(blockDef("nope")).toBeUndefined();
    expect(blocksFor("spawn").map((b) => b.type)).toEqual(["spawn.rate", "spawn.rateOverDistance", "spawn.burst", "spawn.periodicBurst"]);
    expect(blocksFor("output").map((b) => b.type)).toEqual(["attribute.color", "attribute.alpha", "attribute.size", "output.flipbook", "output.widthOverLength"]);
    expect(blocksFor("initialize").length).toBe(20);
    expect(blocksFor("update").filter((b) => b.type.startsWith("attribute.")).map((b) => b.type)).toEqual([
      "attribute.position",
      "attribute.velocity",
      "attribute.color",
      "attribute.alpha",
      "attribute.size",
      "attribute.rotation",
    ]);
  });

  it("gives each default block its own copy of the defaults", () => {
    const a = defaultBlock("init.positionCone", "b1");
    (a.inputs.offset as number[])[0] = 9;
    expect(defaultBlock("init.positionCone", "b2").inputs.offset).toEqual([0, 0, 0]);
  });
});
