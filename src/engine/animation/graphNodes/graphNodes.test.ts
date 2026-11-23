// The node catalogue (ADR 0372 "One node catalogue", T30): every node kind the Rust core implements has exactly one
// entry, with the core's u16 kind id, read from the family modules' `kind` tables in `native/anim/crates/anim-graph`;
// the registry follows `GRAPH_FAMILIES` / `GRAPH_NODE_KINDS`; every parameter's schema is well-formed (kinds, `ParamType`
// ids, the plugin SDK's unit ids, ranges holding their defaults, enum defaults among their choices, asset kinds).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GRAPH_FAMILIES, GRAPH_NODE_KINDS } from "../animGraph";
import { familyId, NODE_CATALOGUE, nodeKindSchema, PARAM_UNITS, VALUE_KIND_TYPES } from "./index";

const RUST_FILES: Record<string, string> = {
  sources: "sources.rs", logic: "logic.rs", mixing: "mixing.rs", slots: "slots.rs", sync: "sync.rs",
  rig: "rig/mod.rs", retarget: "retarget.rs", matching: "matching.rs", physics: "physics.rs", plugin: "plugin.rs",
};
const rust = (path: string) => readFileSync(new URL(`../../../../native/anim/crates/${path}`, import.meta.url), "utf8");

/** A Rust family module's `pub mod kind { pub const NAME: u16 = N; … }`, as (normalised name, id). */
function rustKinds(file: string): [string, number][] {
  const src = rust(`anim-graph/src/${file}`);
  const block = /pub mod kind \{([\s\S]*?)\n\}/.exec(src)![1];
  return [...block.matchAll(/pub const ([A-Z0-9_]+): u16 = (\d+);/g)].map((m) => [m[1].replace(/_/g, "").toLowerCase(), Number(m[2])]);
}

describe("node catalogue", () => {
  it("has one family file per family, in family id order", () => {
    expect(NODE_CATALOGUE.map((f) => f.family)).toEqual([...GRAPH_FAMILIES]);
    // anim-format's family ids.
    const ids = rust("anim-format/src/graph.rs");
    for (const [i, f] of GRAPH_FAMILIES.entries()) {
      expect(familyId(f)).toBe(i);
      expect(ids).toMatch(new RegExp(`pub const ${f.toUpperCase()}: u8 = ${i};`));
    }
  });

  it("declares every kind the Rust core implements, with its u16 id, and nothing else", () => {
    for (const fam of NODE_CATALOGUE) {
      const want = rustKinds(RUST_FILES[fam.family]);
      expect(fam.kinds.map((k) => k.id), fam.family).toEqual(want.map(([, id]) => id));
      expect(fam.kinds.map((k) => k.id)).toEqual(fam.kinds.map((_, i) => i));
      // Names match the Rust constants (the plugin family's PLUGIN_NODE is "plugin" in the text format).
      expect(fam.kinds.map((k) => k.kind.toLowerCase()), fam.family).toEqual(want.map(([n]) => (n === "pluginnode" ? "plugin" : n)));
      expect(fam.kinds.map((k) => k.kind)).toEqual([...GRAPH_NODE_KINDS[fam.family]]);
      for (const k of fam.kinds) expect(nodeKindSchema(fam.family, k.kind)).toBe(k);
    }
    expect(nodeKindSchema("sources", "nope")).toBeUndefined();
  });

  it("gives every parameter a well-formed schema", () => {
    for (const fam of NODE_CATALOGUE) {
      for (const k of fam.kinds) {
        const where = `${fam.family}/${k.kind}`;
        expect(k.family).toBe(fam.family);
        expect(k.doc.length, where).toBeGreaterThan(0);
        expect(k.inputs.min).toBeLessThanOrEqual(k.inputs.max);
        expect(new Set(k.params.map((p) => p.name)).size, where).toBe(k.params.length);
        for (const p of k.params) {
          const at = `${where}.${p.name}`;
          expect(PARAM_UNITS, at).toContain(p.unit);
          expect(p.doc.length, at).toBeGreaterThan(0);
          if (p.kind in VALUE_KIND_TYPES) expect(p.type, at).toBe(VALUE_KIND_TYPES[p.kind as keyof typeof VALUE_KIND_TYPES]);
          if (p.kind === "enum") {
            expect(p.type, at).toBe(VALUE_KIND_TYPES.int);
            expect(p.choices, at).toContain(p.default);
          }
          if (p.kind === "asset") expect(p.asset, at).toBeDefined();
          if (p.kind === "parameter" || p.animatable) expect(p.parameterTypes?.length, at).toBeGreaterThan(0);
          if (typeof p.default === "number") {
            expect(p.default, at).toBeGreaterThanOrEqual(p.min ?? -Infinity);
            expect(p.default, at).toBeLessThanOrEqual(p.max ?? Infinity);
          }
          if (Array.isArray(p.default)) expect(p.default.length, at).toBe({ vec2: 2, vec3: 3, quat: 4 }[p.kind as "vec2"]);
        }
      }
    }
  });

  it("uses the plugin SDK's unit ids", () => {
    const sdk = rust("anim-plugin-sdk/src/descriptor.rs");
    const block = /pub enum Unit \{([\s\S]*?)\n\}/.exec(sdk)![1];
    const units = [...block.matchAll(/^\s*([A-Za-z]+) = (\d+),/gm)].map((m) => [m[1][0].toLowerCase() + m[1].slice(1), Number(m[2])]);
    expect(units).toEqual(PARAM_UNITS.map((u, i) => [u, i]));
  });

  it("marks the names the core matches by FNV-1a hash", () => {
    const hashed = NODE_CATALOGUE.flatMap((f) => f.kinds.flatMap((k) => k.params.filter((p) => p.hashed).map((p) => `${k.kind}.${p.name}`)));
    expect(hashed).toContain("motionWarp.startMarker");
    expect(hashed).toContain("distanceMatch.marker");
    expect(hashed).toContain("twoBoneIk.weightCurve");
    expect(NODE_CATALOGUE.flatMap((f) => f.kinds.flatMap((k) => k.params.filter((p) => p.hashed && p.kind !== "name")))).toEqual([]);
  });
});
