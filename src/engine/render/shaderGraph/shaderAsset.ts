/**
 * Hand-written shader assets compiled for the material plugin (ADR 0106). A shader asset becomes the
 * same `CompiledShaderGraph` a graph does, so the graph material plugin draws it (lights, shadows,
 * fog, per-renderer overrides, warm-up), with a GLSL block besides the WGSL one when the asset ships
 * GLSL. Pure TypeScript, no Babylon.js.
 *
 * The code's contract. Only `surface` is required.
 *
 * WGSL (WebGPU):
 * ```wgsl
 * struct MycoVertex { position: vec3f, normal: vec3f, uv: vec2f, time: f32 }                       // object space
 * struct MycoSurfaceInput { uv: vec2f, position: vec3f, normal: vec3f, viewDir: vec3f, time: f32 } // world space
 * struct MycoSurface { baseColor: vec3f, alpha: f32, metalness: f32, roughness: f32, emission: vec3f, normal: vec3f }
 * fn vertexOffset(v: MycoVertex) -> vec3f { … }                        // optional: object-space offset
 * fn surface(s: MycoSurfaceInput, out: ptr<function, MycoSurface>) { … }
 * ```
 * Properties are `uniforms.<Name>`; a texture property `Name` is `Name` with its sampler `NameSampler`.
 *
 * GLSL ES 3.0 (WebGL2): the same structs and
 * ```glsl
 * vec3 vertexOffset(MycoVertex v) { … }
 * void surface(MycoSurfaceInput s, inout MycoSurface o) { … }
 * ```
 * Properties are bare names (`Tint`); a texture property is a `sampler2D` of its name.
 *
 * `MycoSurface` starts as white, opaque, metalness 0, roughness 0.5, no emission and the unchanged
 * normal `(0, 0, 1)` (tangent space). Colour properties arrive linear. Keywords are `#ifdef KW_NAME`.
 */
import type { ShaderAsset } from "../../scene/shaderAsset";
import { hash, PROPERTY_UNIFORM, SHARED_UNIFORMS, type CompiledShaderGraph, type CompiledUniform } from "./compile";
import { textureDeclarationsWgsl } from "./wgsl";

/** The source text of each language the asset has, read by the caller (files through `Assets`). */
export interface ShaderAssetSources {
  wgsl?: string;
  glsl?: string;
}

const STRUCTS_WGSL = `struct MycoVertex { position: vec3f, normal: vec3f, uv: vec2f, time: f32 }
struct MycoSurfaceInput { uv: vec2f, position: vec3f, normal: vec3f, viewDir: vec3f, time: f32 }
struct MycoSurface { baseColor: vec3f, alpha: f32, metalness: f32, roughness: f32, emission: vec3f, normal: vec3f }`;

const STRUCTS_GLSL = `struct MycoVertex { vec3 position; vec3 normal; vec2 uv; float time; };
struct MycoSurfaceInput { vec2 uv; vec3 position; vec3 normal; vec3 viewDir; float time; };
struct MycoSurface { vec3 baseColor; float alpha; float metalness; float roughness; vec3 emission; vec3 normal; };`;

/**
 * A world-space tangent frame from screen derivatives (GLSL), for tangent-space normals; the WGSL one is
 * the plugin's. Crosses in left-handed order (ADR 0164), as there.
 */
export const TANGENT_FRAME_GLSL = `mat3 mycoBabylonTangentFrame(vec3 n, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p); vec3 dp2 = dFdy(p); vec2 duv1 = dFdx(uv); vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(n, dp2); vec3 dp1perp = cross(dp1, n);
  vec3 t = dp2perp * duv1.x + dp1perp * duv2.x; vec3 b = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
  return mat3(t * invmax, b * invmax, n);
}`;

/** The surface variable the generated code fills and the plugin's outputs read. */
const S = "mycoS";

/** Whether code defines a function of this name (WGSL `fn name(` or GLSL `type name(`). */
const defines = (code: string, name: string, wgsl: boolean): boolean => (wgsl ? new RegExp(`\\bfn\\s+${name}\\s*\\(`) : new RegExp(`\\b[A-Za-z_][A-Za-z0-9_]*\\s+${name}\\s*\\(`)).test(stripComments(code));
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * A shader asset compiled for the material plugin: `sources` holds the code of each language present.
 * Problems (no code, no `surface` function) are reported, never thrown: the asset then draws plain.
 */
export function compileShaderAsset(shader: ShaderAsset, sources: ShaderAssetSources, dependencies: string[] = []): CompiledShaderGraph {
  const problems: string[] = [];
  const uniforms: CompiledUniform[] = shader.properties.map((p) => ({ name: p.name, type: PROPERTY_UNIFORM[p.type], property: p.name, propertyType: p.type, value: p.value }));
  const textures = uniforms.filter((u) => u.type === "sampler2D").map((u) => u.name);
  const lit = shader.target === "lit";

  const wgslCode = sources.wgsl ?? "";
  const glslCode = sources.glsl;
  if (!sources.wgsl && !glslCode) problems.push("the shader has no code; it draws as the default material");
  if (sources.wgsl !== undefined && !defines(wgslCode, "surface", true)) problems.push("the WGSL code has no `fn surface(s: MycoSurfaceInput, out: ptr<function, MycoSurface>)`");
  if (glslCode !== undefined && !defines(glslCode, "surface", false)) problems.push("the GLSL code has no `void surface(MycoSurfaceInput s, inout MycoSurface o)`");
  const usesNormal = (code: string) => /\.normal\s*=[^=]/.test(stripComments(code));

  // --- WGSL -------------------------------------------------------------------------------------------
  const hasVertexW = !!sources.wgsl && defines(wgslCode, "vertexOffset", true);
  const normalW = !!sources.wgsl && lit && usesNormal(wgslCode);
  const texDeclW = textures.flatMap(textureDeclarationsWgsl);
  const varyingW = "varying vMycoUv: vec2f;";
  const okW = !!sources.wgsl && defines(wgslCode, "surface", true);
  const vertexW: CompiledShaderGraph["vertex"] = {
    declarations: ["// Myco shader asset", STRUCTS_WGSL, varyingW, ...(hasVertexW ? [...texDeclW, wgslCode] : [])].join("\n"),
    body: hasVertexW ? `let mycoOffset: vec3f = vertexOffset(MycoVertex(mycoVPos, mycoVNormal, mycoVUv, uniforms.${SHARED_UNIFORMS.time}));` : "",
    offset: hasVertexW ? "mycoOffset" : null,
    varyings: "vertexOutputs.vMycoUv = mycoVUv;",
  };
  const fragmentW: CompiledShaderGraph["fragment"] = {
    declarations: ["// Myco shader asset", STRUCTS_WGSL, varyingW, ...texDeclW, okW ? wgslCode : ""].join("\n"),
    body: okW
      ? [
          `var ${S}: MycoSurface = MycoSurface(vec3f(1.0), 1.0, 0.0, 0.5, vec3f(0.0), vec3f(0.0, 0.0, 1.0));`,
          `surface(MycoSurfaceInput(fragmentInputs.vMycoUv, fragmentInputs.vPositionW, normalize(fragmentInputs.vNormalW), normalize(scene.vEyePosition.xyz - fragmentInputs.vPositionW), uniforms.${SHARED_UNIFORMS.time}), &${S});`,
        ].join("\n")
      : `var ${S}_unused: f32 = 0.0;`,
    baseColor: okW ? `${S}.baseColor` : "vec3f(1.0)",
    alpha: okW ? `${S}.alpha` : "1.0",
    metalness: lit && okW ? `${S}.metalness` : null,
    roughness: lit && okW ? `${S}.roughness` : null,
    emission: lit && okW ? `${S}.emission` : null,
    normal: normalW && okW ? `${S}.normal` : null,
    physical: null,
    alphaClip: null,
  };

  // --- GLSL -------------------------------------------------------------------------------------------
  let glsl: CompiledShaderGraph["glsl"];
  if (glslCode !== undefined) {
    const okG = defines(glslCode, "surface", false);
    const hasVertexG = defines(glslCode, "vertexOffset", false);
    const normalG = lit && okG && usesNormal(glslCode);
    const texDeclG = textures.map((t) => `uniform sampler2D ${t};`);
    const varyingG = "varying vec2 vMycoUv;";
    glsl = {
      vertex: {
        declarations: ["// Myco shader asset", STRUCTS_GLSL, varyingG, ...(hasVertexG ? [...texDeclG, glslCode] : [])].join("\n"),
        body: hasVertexG ? `vec3 mycoOffset = vertexOffset(MycoVertex(mycoVPos, mycoVNormal, mycoVUv, ${SHARED_UNIFORMS.time}));` : "",
        offset: hasVertexG ? "mycoOffset" : null,
        varyings: "vMycoUv = mycoVUv;",
      },
      fragment: {
        declarations: ["// Myco shader asset", STRUCTS_GLSL, varyingG, ...texDeclG, okG ? glslCode : "", normalG ? TANGENT_FRAME_GLSL : ""].join("\n"),
        body: okG
          ? [
              `MycoSurface ${S} = MycoSurface(vec3(1.0), 1.0, 0.0, 0.5, vec3(0.0), vec3(0.0, 0.0, 1.0));`,
              "#ifdef NORMAL",
              `vec3 mycoN = normalize(vNormalW);`,
              "#else",
              `vec3 mycoN = vec3(0.0, 1.0, 0.0);`,
              "#endif",
              `surface(MycoSurfaceInput(vMycoUv, vPositionW, mycoN, normalize(vEyePosition.xyz - vPositionW), ${SHARED_UNIFORMS.time}), ${S});`,
            ].join("\n")
          : "",
        baseColor: okG ? `${S}.baseColor` : "vec3(1.0)",
        alpha: okG ? `${S}.alpha` : "1.0",
        metalness: lit && okG ? `${S}.metalness` : null,
        roughness: lit && okG ? `${S}.roughness` : null,
        emission: lit && okG ? `${S}.emission` : null,
        normal: normalG ? `${S}.normal` : null,
        physical: null,
        alphaClip: null,
      },
    };
  }

  const key = hash(["shader", shader.target, shader.surface, shader.doubleSided, JSON.stringify(uniforms.map((u) => [u.name, u.type])), vertexW.declarations, vertexW.body, fragmentW.declarations, fragmentW.body, fragmentW.normal, glsl ? JSON.stringify(glsl) : ""].join("\u0000"));
  return {
    target: shader.target,
    surface: shader.surface,
    doubleSided: shader.doubleSided,
    vertex: vertexW,
    fragment: fragmentW,
    uniforms,
    problems,
    nodeProblems: {},
    portTypes: {},
    dynamicTypes: {},
    dependencies,
    usesShaderLevel: false,
    key,
    keywords: shader.keywords,
    ...(glsl ? { glsl } : {}),
    ...(okW ? {} : { noWgsl: true }),
  };
}
