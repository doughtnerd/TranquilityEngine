// ADR 0222: the points where this engine patches Babylon's PBR shaders. Every named point must match
// the shipped, include-expanded PBR shader exactly where the module says it does, in both languages;
// a Babylon upgrade that moves one fails here and not as a plain-PBR material at run time.
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Scene } from "@babylonjs/core/scene.js";
import { beforeAll, describe, expect, it } from "vitest";
import { PBR_POINTS, pbrInjections, type PbrLanguage, type PbrPoint } from "../render/babylon/pbrInjection";
import { nullEngine, shaderText, type ShaderText } from "./pbrShaderSource";

/** Babylon's PBR shaders of `language` as plugin code meets them: a plain PBR material's, includes expanded (ADR 0225). */
async function expanded(language: PbrLanguage): Promise<ShaderText> {
  const engine = nullEngine(language);
  const scene = new Scene(engine);
  try {
    const text = await shaderText(new PBRMaterial("plain", scene));
    expect(text.vertex.length).toBeGreaterThan(1000);
    expect(text.fragment.length).toBeGreaterThan(1000);
    expect(text.fragment).not.toContain("#include<");
    return text;
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

const noSpace = (s: string): string => s.replace(/\s+/g, "");
const points = Object.keys(PBR_POINTS) as PbrPoint[];
const READS: PbrPoint[] = ["clearcoatParams", "sheenColor", "sheenRoughness", "subSurfaceIntensity", "thicknessParam", "refractionInfos", "iridescenceParams", "anisotropy"];

/** The one entry a point makes, as Babylon takes it: a regular expression key and its replacement. */
function entry(language: PbrLanguage, point: PbrPoint, code = "CODE"): [RegExp, string] {
  const entries = Object.entries(pbrInjections(language, PBR_POINTS[point], { [point]: code }));
  expect(entries).toHaveLength(1);
  const [key, replacement] = entries[0];
  expect(key.startsWith("!")).toBe(true);
  return [new RegExp(key.slice(1), "g"), replacement];
}

describe("PBR injection points match Babylon's shipped shaders (ADR 0222)", () => {
  for (const language of ["wgsl", "glsl"] as const) {
    describe(language, () => {
      const source = { vertex: "", fragment: "" };
      beforeAll(async () => {
        ({ vertex: source.vertex, fragment: source.fragment } = await expanded(language));
      });

      for (const point of points) {
        if (language === "glsl" && READS.includes(point)) {
          it(`${point} has no GLSL spelling and says so`, () => {
            expect(() => pbrInjections("glsl", PBR_POINTS[point], { [point]: "x" })).toThrow(/no GLSL spelling/);
          });
          continue;
        }
        it(`${point} matches ${READS.includes(point) ? "its reads" : "exactly once"} in the ${PBR_POINTS[point]} shader and re-declares what it replaced`, () => {
          const [regex, replacement] = entry(language, point);
          const matches = [...source[PBR_POINTS[point]].matchAll(regex)];
          if (READS.includes(point)) expect(matches.length).toBeGreaterThan(0);
          else expect(matches).toHaveLength(1);
          // With no code of its own the replacement is what the module re-declares (a value is assigned after its declaration, so its closing ";" is left out): it begins like the text it replaced.
          const [, restated] = entry(language, point, "");
          expect(noSpace(matches[0][0]).startsWith(noSpace(restated).replace(/;$/, ""))).toBe(true);
          expect(replacement).toContain("CODE");
        });
      }
    });
  }
});

describe("pbrInjections", () => {
  it("puts a statement point's code before the re-declared statement and its `after` code behind it", () => {
    for (const language of ["wgsl", "glsl"] as const) {
      const entries = pbrInjections(language, "vertex", { worldPosition: { before: "BEFORE", after: "AFTER" } });
      const [replacement] = Object.values(entries);
      expect(replacement.split("\n")[0]).toBe("BEFORE");
      expect(replacement).toMatch(/worldPos[^\n]*finalWorld[^\n]*\nAFTER$/);
    }
    expect(Object.values(pbrInjections("wgsl", "fragment", { albedoBlock: "NORMAL;" }))[0]).toBe("NORMAL;\nvar albedoOpacityOut: albedoOpacityOutParams;");
    expect(Object.values(pbrInjections("glsl", "fragment", { albedoBlock: "NORMAL;" }))[0]).toBe("NORMAL;\nalbedoOpacityOutParams albedoOpacityOut;");
  });

  it("puts a point's code where its kind says: after the matched lines, as the call's argument, as a variable's value", () => {
    expect(Object.values(pbrInjections("wgsl", "fragment", { probeReflection: "CODE" }))[0]).toBe("#define CUSTOM_REFLECTION\n#endif\n#endif\nCODE");
    expect(Object.values(pbrInjections("wgsl", "fragment", { reflectivity: "vec4f(1.0)" }))[0]).toBe("reflectivityBlock(vec4f(1.0)");
    expect(Object.values(pbrInjections("glsl", "fragment", { clearcoatNormal: "n" }))[0]).toBe("clearcoatOut = clearcoatBlock(vPositionW, n");
    expect(Object.values(pbrInjections("wgsl", "fragment", { reflectanceFactors: "vec4f(1.0)" }))[0]).toBe("var metallicReflectanceFactors: vec4f = vec4f(1.0);");
    expect(Object.values(pbrInjections("glsl", "fragment", { reflectanceFactors: "vec4(1.0)" }))[0]).toBe("vec4 metallicReflectanceFactors = vec4(1.0);");
  });

  it("makes one entry per point and none for a point left undefined", () => {
    expect(Object.keys(pbrInjections("wgsl", "fragment", { albedoBlock: "a", reflectivity: "b", sheenColor: undefined }))).toHaveLength(2);
    expect(pbrInjections("wgsl", "fragment", {})).toEqual({});
  });

  it("refuses a point in the other shader, and a before/after pair where a point takes plain code", () => {
    expect(() => pbrInjections("wgsl", "fragment", { worldPosition: "x" })).toThrow(/vertex shader/);
    expect(() => pbrInjections("wgsl", "vertex", { albedoBlock: "x" })).toThrow(/fragment shader/);
    expect(() => pbrInjections("wgsl", "fragment", { reflectivity: { before: "x" } })).toThrow(/plain code/);
  });
});
