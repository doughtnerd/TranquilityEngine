/**
 * The WGSL side of the shader graph compiler (ADR 0047, ADR 0075): type names, varyings and
 * built-in expressions for Babylon.js's WGSL dialect, where the graph runs inside the PBR material
 * through a material plugin. Pure TypeScript with no Babylon.js.
 *
 * The contract with the plugin:
 *  - graph uniforms (and the shared time and resolution) are read as `uniforms.<name>`; the plugin
 *    registers them, so no declarations are emitted;
 *  - textures are declared by the compiler as `var <name>: texture_2d<f32>;` and
 *    `var <name>Sampler: sampler;` (all of them in the fragment stage, those a vertex node samples in
 *    the vertex stage too);
 *  - the vertex stage defines `mycoVUv`, `mycoVPos` and `mycoVNormal` before the graph's body runs.
 */
import type { Builtin, ShaderStage, ValueType } from "./nodes";

const WGSL_TYPES: Record<Exclude<ValueType, "texture">, string> = { float: "f32", vec2: "vec2f", vec3: "vec3f", vec4: "vec4f" };

/** A value type's WGSL name (`float` is `f32`, `vec3` is `vec3f`); a texture is `texture_2d<f32>`. */
export const wgslType = (t: ValueType): string => (t === "texture" ? "texture_2d<f32>" : WGSL_TYPES[t]);

/**
 * The graph's own varyings. Babylon's PBR shader already uses most of WebGPU's 16 vertex outputs,
 * so only those the fragment stage reads are declared, and world position and normal reuse
 * Babylon's `vPositionW` and `vNormalW` instead.
 */
export const VARYINGS_WGSL = { vMycoUv: "vec2f", vMycoObjPos: "vec3f", vMycoObjNormal: "vec3f" } as const;
export type VaryingWgsl = keyof typeof VARYINGS_WGSL;

/** What the shared uniforms read as in WGSL. */
export const SHARED_UNIFORM_EXPR = { time: "uniforms.uMycoTime", resolution: "uniforms.uMycoResolution" } as const;

export const BUILTINS_WGSL: Record<ShaderStage, Record<Builtin, string>> = {
  vertex: {
    uv: "mycoVUv",
    objectPosition: "mycoVPos",
    worldPosition: "(finalWorld * vec4f(mycoVPos, 1.0)).xyz",
    viewPosition: "(scene.view * (finalWorld * vec4f(mycoVPos, 1.0))).xyz",
    objectNormal: "normalize(mycoVNormal)",
    worldNormal: "normalize((finalWorld * vec4f(mycoVNormal, 0.0)).xyz)",
    viewNormal: "normalize((scene.view * (finalWorld * vec4f(mycoVNormal, 0.0))).xyz)",
    viewDirection: "normalize(scene.vEyePosition.xyz - (finalWorld * vec4f(mycoVPos, 1.0)).xyz)",
  },
  fragment: {
    uv: "fragmentInputs.vMycoUv",
    objectPosition: "fragmentInputs.vMycoObjPos",
    worldPosition: "fragmentInputs.vPositionW",
    viewPosition: "(scene.view * vec4f(fragmentInputs.vPositionW, 1.0)).xyz",
    objectNormal: "mycoFaceNormal(fragmentInputs.vMycoObjNormal)",
    worldNormal: "mycoFaceNormal(fragmentInputs.vNormalW)",
    viewNormal: "normalize((scene.view * vec4f(mycoFaceNormal(fragmentInputs.vNormalW), 0.0)).xyz)",
    viewDirection: "normalize(scene.vEyePosition.xyz - fragmentInputs.vPositionW)",
  },
};

/** The fragment stage's face-normal helper. WGSL has no front-facing flip here, so it only normalizes. */
export const FACE_NORMAL_WGSL = "fn mycoFaceNormal(n: vec3f) -> vec3f { return normalize(n); }";

/** The varyings a fragment stage's code reads (`fragmentInputs.<name>`); a Normal output also needs the UV. */
export function usedVaryings(fragmentCode: string, needsUv: boolean): VaryingWgsl[] {
  return (Object.keys(VARYINGS_WGSL) as VaryingWgsl[]).filter((v) => (v === "vMycoUv" && needsUv) || fragmentCode.includes(`fragmentInputs.${v}`));
}

/** The varyings' declarations. */
export const varyingDeclarationsWgsl = (used: VaryingWgsl[]): string[] => used.map((v) => `varying ${v}: ${VARYINGS_WGSL[v]};`);

/** The vertex stage's varyings statements, for the used varyings only; `mycoTransformed` is the object-space position with the vertex offset applied. */
export function varyingsWgsl(offset: string | null, used: VaryingWgsl[]): string {
  return [
    ...(used.includes("vMycoObjPos") ? [`var mycoTransformed: vec3f = ${offset ? `mycoVPos + ${offset}` : "mycoVPos"};`] : []),
    ...(used.includes("vMycoUv") ? ["vertexOutputs.vMycoUv = mycoVUv;"] : []),
    ...(used.includes("vMycoObjPos") ? ["vertexOutputs.vMycoObjPos = mycoTransformed;"] : []),
    ...(used.includes("vMycoObjNormal") ? ["vertexOutputs.vMycoObjNormal = mycoVNormal;"] : []),
  ].join("\n");
}

/** A texture uniform's declarations: the texture and its sampler. */
export const textureDeclarationsWgsl = (name: string): string[] => [`var ${name}: texture_2d<f32>;`, `var ${name}Sampler: sampler;`];

/** A texture sample. The vertex stage can't take implicit derivatives, so it samples mip level 0. */
export const sampleWgsl = (texture: string, uv: string, stage: ShaderStage): string =>
  stage === "vertex" ? `textureSampleLevel(${texture}, ${texture}Sampler, ${uv}, 0.0)` : `textureSample(${texture}, ${texture}Sampler, ${uv})`;
