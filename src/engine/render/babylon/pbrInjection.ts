/**
 * The places this engine patches Babylon's PBR shaders (ADR 0222), in one module.
 *
 * Babylon's material plugins take custom code by injection point. Most are Babylon's own named
 * points (`CUSTOM_FRAGMENT_DEFINITIONS`...), which callers spell themselves. The rest are not in the
 * shader, so the code goes where a regular expression matches the include-expanded source (a key
 * starting with "!"; Babylon replaces every match, and the replacement replaces the matched text).
 * Babylon expands its includes before plugin code goes in, so `#include<pbrBlockNormalFinal>` and
 * the like are no longer there to match: the points here are statements and calls of the expanded
 * shader, in WGSL and in GLSL.
 *
 * A point is asked for by name (`PBR_POINTS`) and the module owns three things the callers used to
 * repeat: the pattern per shader language, the rule that a replacement re-declares what it replaced
 * (the matched statement or call head comes back out, so the caller writes only what it adds), and
 * the key/replacement entries Babylon takes (`pbrInjections`). Callers never see a pattern.
 *
 * How a point takes code:
 * - "statement": code goes before Babylon's statement, which the module then re-declares; the
 *   point also takes `{ before, after }` to add code after it (the vertex `worldPos`, for the
 *   varyings that read it);
 * - "after": Babylon's matched lines come back first, then the code;
 * - "argument": the code is the call's argument, the module writes the call's head;
 * - "value": the code is the value of a variable, the module writes its declaration;
 * - "read": the code replaces every read of one of Babylon's PBR uniforms (WGSL only: GLSL passes
 *   them as function parameters, which a replacement would break).
 */
/** The shader languages Babylon's PBR material ships in: WGSL on WebGPU, GLSL on WebGL2. */
export type PbrLanguage = "wgsl" | "glsl";

/** The PBR shader a point is in. */
export type PbrStage = "vertex" | "fragment";

/** Every named point, and the shader it is in. */
export const PBR_POINTS = {
  /** Vertex: where the world position is computed; code before it moves the vertex. */
  worldPosition: "vertex",
  /** Fragment: the albedo block's declaration, just after the normal is final (code here may change `normalW`). */
  albedoBlock: "fragment",
  /** Fragment: the first argument of `reflectivityBlock` (a vec4: metallic, roughness, IOR, F0). */
  reflectivity: "fragment",
  /** Fragment: the normal handed to the clear coat block, in place of the geometric normal. */
  clearcoatNormal: "fragment",
  /** Fragment: the metallic workflow's reflectance factors (a vec4: F0 tint, factor in alpha); the code is the value. */
  reflectanceFactors: "fragment",
  /** Fragment: after Babylon computes the primary probe's reflection. */
  probeReflection: "fragment",
  /** Fragment, WGSL only: reads of the clear coat's (intensity, roughness). */
  clearcoatParams: "fragment",
  /** Fragment, WGSL only: reads of the sheen's (colour, intensity). */
  sheenColor: "fragment",
  /** Fragment, WGSL only: reads of the sheen's roughness. */
  sheenRoughness: "fragment",
  /** Fragment, WGSL only: reads of the sub-surface block's (refraction, translucency, ...) intensities. */
  subSurfaceIntensity: "fragment",
  /** Fragment, WGSL only: reads of the sub-surface block's thickness parameters. */
  thicknessParam: "fragment",
  /** Fragment, WGSL only: reads of the refraction's infos (y holds 1 / IOR). */
  refractionInfos: "fragment",
  /** Fragment, WGSL only: reads of the iridescence's (intensity, IOR, minimum and maximum thickness). */
  iridescenceParams: "fragment",
  /** Fragment, WGSL only: reads of the anisotropy's (direction, strength). */
  anisotropy: "fragment",
} as const satisfies Record<string, PbrStage>;

/** A point's name. */
export type PbrPoint = keyof typeof PBR_POINTS;

/** What a point is given: code, or for the "statement" points code before and after the re-declared statement. */
export type PbrCode = string | { before?: string; after?: string };

type Spelling = { match: string; restate: string };

type Definition =
  | { kind: "statement"; wgsl: Spelling; glsl: Spelling }
  | { kind: "after"; wgsl: Spelling; glsl: Spelling }
  | { kind: "argument"; wgsl: Spelling; glsl: Spelling }
  | { kind: "value"; wgsl: Spelling & { head: string; tail: string }; glsl: Spelling & { head: string; tail: string } }
  | { kind: "read"; wgsl: string };

/** A point matched by `match` (Babylon's "!" key form) and re-declared as `restate`. */
const statement = (match: string, restate: string): Spelling => ({ match, restate });

/** A uniform read in WGSL: the member of the `uniforms` block, as a whole word. */
const uniformRead = (name: string): Definition => ({ kind: "read", wgsl: `!uniforms\\.${name}\\b` });

const DEFINITIONS: { [P in PbrPoint]: Definition } = {
  worldPosition: {
    kind: "statement",
    wgsl: statement("!var\\s+worldPos\\s*:\\s*vec4f\\s*=\\s*finalWorld\\s*\\*\\s*vec4f\\(\\s*positionUpdated\\s*,\\s*1\\.0\\s*\\)\\s*;", "var worldPos: vec4f = finalWorld * vec4f(positionUpdated, 1.0);"),
    glsl: statement("!vec4\\s+worldPos\\s*=\\s*finalWorld\\s*\\*\\s*vec4\\(\\s*positionUpdated\\s*,\\s*1\\.0\\s*\\)\\s*;", "vec4 worldPos = finalWorld * vec4(positionUpdated, 1.0);"),
  },
  albedoBlock: {
    kind: "statement",
    wgsl: statement("!var\\s+albedoOpacityOut\\s*:\\s*albedoOpacityOutParams\\s*;", "var albedoOpacityOut: albedoOpacityOutParams;"),
    glsl: statement("!albedoOpacityOutParams\\s+albedoOpacityOut\\s*;", "albedoOpacityOutParams albedoOpacityOut;"),
  },
  reflectivity: {
    kind: "argument",
    wgsl: statement("!reflectivityBlock\\(\\s*uniforms\\.vReflectivityColor", "reflectivityBlock("),
    glsl: statement("!reflectivityBlock\\(\\s*vReflectivityColor", "reflectivityBlock("),
  },
  clearcoatNormal: {
    kind: "argument",
    wgsl: statement("!clearcoatOut\\s*=\\s*clearcoatBlock\\(\\s*fragmentInputs\\.vPositionW\\s*,\\s*geometricNormalW", "clearcoatOut = clearcoatBlock(fragmentInputs.vPositionW, "),
    glsl: statement("!clearcoatOut\\s*=\\s*clearcoatBlock\\(\\s*vPositionW\\s*,\\s*geometricNormalW", "clearcoatOut = clearcoatBlock(vPositionW, "),
  },
  reflectanceFactors: {
    kind: "value",
    wgsl: { match: "!var\\s+metallicReflectanceFactors\\s*:\\s*vec4f\\s*=\\s*uniforms\\.vMetallicReflectanceFactors\\s*;", restate: "", head: "var metallicReflectanceFactors: vec4f = ", tail: ";" },
    glsl: { match: "!vec4\\s+metallicReflectanceFactors\\s*=\\s*vMetallicReflectanceFactors\\s*;", restate: "", head: "vec4 metallicReflectanceFactors = ", tail: ";" },
  },
  probeReflection: {
    kind: "after",
    wgsl: statement("!#define CUSTOM_REFLECTION\\s*#endif\\s*#endif", "#define CUSTOM_REFLECTION\n#endif\n#endif"),
    glsl: statement("!#define CUSTOM_REFLECTION\\s*#endif\\s*#endif", "#define CUSTOM_REFLECTION\n#endif\n#endif"),
  },
  clearcoatParams: uniformRead("vClearCoatParams"),
  sheenColor: uniformRead("vSheenColor"),
  sheenRoughness: uniformRead("vSheenRoughness"),
  subSurfaceIntensity: uniformRead("vSubSurfaceIntensity"),
  thicknessParam: uniformRead("vThicknessParam"),
  refractionInfos: uniformRead("vRefractionInfos"),
  iridescenceParams: uniformRead("vIridescenceParams"),
  anisotropy: uniformRead("vAnisotropy"),
};

const join = (...parts: (string | undefined)[]): string => parts.filter((p) => p).join("\n");

/**
 * The entries for Babylon's `getCustomCode` that put `points`' code in the PBR `shader` of `language`:
 * spread them beside Babylon's own `CUSTOM_*` points. A point in the other shader, or one the language
 * has no spelling of, throws: that is a bug in the caller, and a silent miss would draw plain PBR.
 */
export function pbrInjections(language: PbrLanguage, shader: PbrStage, points: { [P in PbrPoint]?: PbrCode }): { [key: string]: string } {
  const entries: { [key: string]: string } = {};
  for (const name of Object.keys(points) as PbrPoint[]) {
    const code = points[name];
    if (code === undefined) continue;
    if (PBR_POINTS[name] !== shader) throw new Error(`PBR point "${name}" is in the ${PBR_POINTS[name]} shader, not the ${shader} shader`);
    const def = DEFINITIONS[name];
    if (def.kind === "read") {
      if (language !== "wgsl") throw new Error(`PBR point "${name}" has no GLSL spelling`);
      if (typeof code !== "string") throw new Error(`PBR point "${name}" takes plain code`);
      entries[def.wgsl] = code;
      continue;
    }
    if (typeof code !== "string" && def.kind !== "statement") throw new Error(`PBR point "${name}" takes plain code`);
    const { before, after } = typeof code === "string" ? { before: code, after: undefined } : code;
    switch (def.kind) {
      case "statement":
        entries[def[language].match] = join(before, def[language].restate, after);
        break;
      case "after":
        entries[def[language].match] = join(def[language].restate, before);
        break;
      case "argument":
        entries[def[language].match] = `${def[language].restate}${before ?? ""}`;
        break;
      case "value":
        entries[def[language].match] = `${def[language].head}${before ?? ""}${def[language].tail}`;
        break;
    }
  }
  return entries;
}
