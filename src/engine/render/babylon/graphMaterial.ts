/**
 * Shader graph materials on the Babylon backend (ADR 0047, 0049, 0075 stage 4). A graph compiled to
 * WGSL (`compileShaderGraph(graph, { language: "wgsl" })`) is spliced into Babylon's PBR material
 * by a material plugin, so graphs keep Babylon's lights, shadows, environment and the frame graph's
 * effects. Lit and physical graphs set the surface (base colour, alpha, metalness, roughness,
 * emission, normal); unlit graphs draw their colour directly.
 *
 * Where the code goes in Babylon's PBR WGSL shaders:
 * - vertex: the graph's declarations at CUSTOM_VERTEX_DEFINITIONS; its inputs (`mycoVPos`,
 *   `mycoVNormal`, `mycoVUv`), body, offset and varyings just before `worldPos` is computed;
 * - fragment: declarations at CUSTOM_FRAGMENT_DEFINITIONS, the body at the start of `main`, base
 *   colour and alpha (and the alpha clip) at CUSTOM_FRAGMENT_UPDATE_ALPHA, metalness and roughness
 *   into `reflectivityBlock`'s first argument, the normal just before the albedo block, emission
 *   before the final colour is composed.
 *
 * Shadows: a graph with a vertex offset gives its material a `ShadowDepthWrapper`, so shadow maps draw
 * the displaced mesh, as the three.js backend's depth and distance materials do. The wrapper is
 * standalone over a second, unlit PBR material carrying the graph's vertex code only (no surface code),
 * and Babylon splices its shadow-map code into that material's shaders: plain, cascaded and point-light
 * (cube) maps alike. Graphs without an offset draw their shadows with Babylon's own shadow shader.
 * Like three.js, shadows ignore the graph's alpha clip.
 *
 * WebGPU only: on the WebGL2 fallback the plugin turns itself off and the material draws as plain PBR
 * (with plain shadows).
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { DrawWrapper } from "@babylonjs/core/Materials/drawWrapper.js";
import type { Effect } from "@babylonjs/core/Materials/effect.js";
import { Material } from "@babylonjs/core/Materials/material.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import { checkPropertyValue, type GraphValue } from "../../scene/shaderGraph";
import { linearColor, SHARED_UNIFORMS, srgbToLinear, type CompiledShaderGraph, type CompiledUniform } from "../shaderGraph/compile";

/** Values every graph material reads, owned by the renderer and updated each frame. */
export interface GraphShared {
  time: number;
  resolution: [number, number];
  /** The main light for Main Light nodes (`BabylonLighting.mainLight`); previews without one get (0.4, 1, 0.6) and white. */
  mainLight?: { readonly direction: readonly number[]; readonly color: readonly number[] };
}

/** Uniforms the WGSL Main Light helpers read (`nodes.ts`), bound from `GraphShared.mainLight`. */
export const MAIN_LIGHT_UNIFORMS = { direction: "uMycoMainLightDir", color: "uMycoMainLightColor" } as const;
const FALLBACK_LIGHT_DIR = [0.4, 1, 0.6].map((v) => v / Math.hypot(0.4, 1, 0.6));

/** Load a texture asset; `linear` asks for data (normal maps) rather than sRGB colour. */
export type LoadGraphTexture = (path: string, linear: boolean) => Promise<BaseTexture>;

/** A graph material and how to change its property values without recompiling (ADR 0049). */
export interface BabylonGraphMaterial {
  material: PBRMaterial;
  compiled: CompiledShaderGraph;
  /** Its uniform values and textures (what the plugin binds). */
  state: GraphState;
  /** The property values it was made with (a material's, over the graph's defaults). */
  properties: Record<string, GraphValue>;
  setProperties(values: Record<string, GraphValue>): void;
  dispose(): void;
}

/**
 * Where code needing the final normal goes (a regular-expression key): Babylon's albedo block
 * declaration, which follows it in the PBR fragment shader. Babylon expands its includes before
 * plugin code goes in, so `#include<pbrBlockNormalFinal>` itself is no longer there to match.
 * The replacement must end by re-declaring `var albedoOpacityOut: albedoOpacityOutParams;`.
 */
export const ALBEDO_ANCHOR = "!var\\s+albedoOpacityOut\\s*:\\s*albedoOpacityOutParams\\s*;";

const UBO_SIZE ={ float: 1, vec2: 2, vec3: 3, vec4: 4 } as const;

/** A world-space tangent frame from screen derivatives, for tangent-space graph normals. */
const TANGENT_FRAME = /* wgsl */ `
fn mycoBabylonTangentFrame(n: vec3f, p: vec3f, uv: vec2f) -> mat3x3f {
  let dp1 = dpdx(p);
  let dp2 = dpdy(p);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let t = dp2perp * duv1.x + dp1perp * duv2.x;
  let b = dp2perp * duv1.y + dp1perp * duv2.y;
  let invmax = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
  return mat3x3f(t * invmax, b * invmax, n);
}
`;

/** A property's value for a uniform, as numbers (linear for colours): the material's override if it suits the type, else the graph's default. */
function uniformNumbers(u: CompiledUniform, overrides: Record<string, GraphValue>): number[] {
  let v: GraphValue = u.value;
  const own = u.property ? overrides[u.property] : undefined;
  if (u.propertyType === "color" && Array.isArray(own) && own.length >= 3) return [srgbToLinear(own[0]), srgbToLinear(own[1]), srgbToLinear(own[2]), own[3] ?? 1];
  if (u.property && u.propertyType && own !== undefined) v = checkPropertyValue(u.propertyType, own) ?? u.value;
  if (u.propertyType === "color") return linearColor(String(v));
  if (u.type === "float") return [typeof v === "number" ? v : 0];
  const a = Array.isArray(v) ? v : [];
  const n = UBO_SIZE[u.type as keyof typeof UBO_SIZE] ?? 4;
  return Array.from({ length: n }, (_, i) => a[i] ?? 0);
}

/** The texture path a texture uniform reads ("" for white). */
function texturePath(u: CompiledUniform, overrides: Record<string, GraphValue>): string {
  const own = u.property ? overrides[u.property] : undefined;
  const v = typeof own === "string" ? own : u.value;
  return typeof v === "string" ? v.replace(/^asset:/, "") : "";
}

/**
 * @internal Where a compiled graph's WGSL goes in Babylon's PBR shaders, by injection point (keys starting
 * with "!" are regular expressions Babylon replaces; see the file's header).
 */
export function graphCustomCode(c: CompiledShaderGraph, shaderType: string): { [point: string]: string } {
  if (shaderType === "vertex") {
    const v = c.vertex;
    return {
      CUSTOM_VERTEX_DEFINITIONS: v.declarations,
      // Replaces the world position's computation, so the offset moves the vertex before it.
      "!var\\s+worldPos\\s*:\\s*vec4f\\s*=\\s*finalWorld\\s*\\*\\s*vec4f\\(\\s*positionUpdated\\s*,\\s*1\\.0\\s*\\)\\s*;": [
        // The position before the offset: the compiler's varyings add the offset themselves.
        "let mycoVPos: vec3f = positionUpdated;",
        "#ifdef NORMAL",
        "let mycoVNormal: vec3f = normalUpdated;",
        "#else",
        "let mycoVNormal: vec3f = vec3f(0.0, 1.0, 0.0);",
        "#endif",
        "#ifdef UV1",
        "let mycoVUv: vec2f = uvUpdated;",
        "#else",
        "let mycoVUv: vec2f = vec2f(0.0);",
        "#endif",
        v.body,
        v.offset ? `positionUpdated = positionUpdated + (${v.offset});` : "",
        "var worldPos: vec4f = finalWorld * vec4f(positionUpdated, 1.0);",
        v.varyings,
      ].join("\n"),
    };
  }
  const f = c.fragment;
  const code: { [point: string]: string } = {
    CUSTOM_FRAGMENT_DEFINITIONS: `${f.declarations}\n${f.normal ? TANGENT_FRAME : ""}`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: f.body,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: [`surfaceAlbedo = ${f.baseColor};`, `alpha = ${f.alpha};`, f.alphaClip ? `if (alpha < ${f.alphaClip}) { discard; }` : ""].join("\n"),
  };
  if (c.target !== "unlit") {
    if (f.metalness || f.roughness) {
      // vReflectivityColor holds metallic, roughness, IOR and F0 in the metallic workflow.
      code["!reflectivityBlock\\(\\s*uniforms\\.vReflectivityColor"] = `reflectivityBlock(vec4f(${f.metalness ?? "uniforms.vReflectivityColor.x"}, ${f.roughness ?? "uniforms.vReflectivityColor.y"}, uniforms.vReflectivityColor.zw)`;
    }
    if (f.emission) code.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION = `finalEmissive = ${f.emission};`;
    if (f.normal) code[ALBEDO_ANCHOR] = `normalW = normalize(mycoBabylonTangentFrame(normalW, fragmentInputs.vPositionW, fragmentInputs.vMycoUv) * (${f.normal}));\nvar albedoOpacityOut: albedoOpacityOutParams;`;
  }
  return code;
}

/**
 * @internal The graph's code in the shadow-depth material (graphs with a vertex offset): the vertex code
 * as the material draws it, and on the fragment side only the declarations its varyings and textures
 * need, so the shadow pass runs no surface code.
 */
export function graphShadowCustomCode(c: CompiledShaderGraph, shaderType: string): { [point: string]: string } {
  return shaderType === "vertex" ? graphCustomCode(c, "vertex") : { CUSTOM_FRAGMENT_DEFINITIONS: c.fragment.declarations };
}

/**
 * @internal Names Babylon's injected shadow-map vertex code reads, remapped to the PBR vertex shader's:
 * its world normal is the varying (`worldPos` is already a `var` of that name).
 */
export const SHADOW_REMAPPED_VARIABLES = ["vNormalW", "vertexOutputs.vNormalW"];

/** A graph material's values: each uniform's numbers and each texture slot's texture, refreshed by `setProperties`. */
export interface GraphState {
  numbers: Map<string, number[]>;
  textures: Map<string, BaseTexture>;
}

/** @internal The plugin's uniform buffer entries: the shared time and resolution, then the graph's non-texture uniforms. */
export function graphUniformBuffer(c: CompiledShaderGraph): { name: string; size: number; type: string }[] {
  const ubo: { name: string; size: number; type: string }[] = [
    { name: SHARED_UNIFORMS.time, size: 1, type: "float" },
    { name: SHARED_UNIFORMS.resolution, size: 2, type: "vec2" },
    { name: MAIN_LIGHT_UNIFORMS.direction, size: 3, type: "vec3" },
    { name: MAIN_LIGHT_UNIFORMS.color, size: 3, type: "vec3" },
  ];
  for (const u of c.uniforms) if (u.type !== "sampler2D") ubo.push({ name: u.name, size: UBO_SIZE[u.type], type: u.type });
  return ubo;
}

/** The material plugin carrying one compiled graph (WGSL materials only). */
class MycoGraphPlugin extends MaterialPluginBase {
  constructor(
    material: PBRMaterial,
    private readonly compiled: CompiledShaderGraph,
    private readonly shared: GraphShared,
    private readonly state: GraphState,
    /** The shadow-depth material's plugin: vertex code only (`graphShadowCustomCode`). */
    private readonly depth = false,
  ) {
    // A define per graph, so materials with different graphs never share a compiled program (Babylon
    // caches effects by defines, not by plugin code: the depth variant needs a define of its own too).
    // Registered after the fields are set: registering reads the plugin's code, which needs `compiled`.
    super(material, "MycoGraph", 200, { [`MYCO_GRAPH_${depth ? "DEPTH_" : ""}${compiled.key.replace(/[^A-Za-z0-9_]/g, "_")}`]: true }, false);
    (this._pluginManager as unknown as { _addPlugin(p: MaterialPluginBase): boolean })._addPlugin(this);
    this._enable(true);
  }

  override getClassName(): string {
    return "MycoGraphPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.WGSL;
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[] } {
    return { ubo: graphUniformBuffer(this.compiled) };
  }

  override getSamplers(samplers: string[]): void {
    for (const u of this.compiled.uniforms) if (u.type === "sampler2D") samplers.push(u.name);
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    ubo.updateFloat(SHARED_UNIFORMS.time, this.shared.time);
    ubo.updateFloat2(SHARED_UNIFORMS.resolution, this.shared.resolution[0], this.shared.resolution[1]);
    const d = this.shared.mainLight?.direction ?? FALLBACK_LIGHT_DIR;
    const c = this.shared.mainLight?.color;
    ubo.updateFloat3(MAIN_LIGHT_UNIFORMS.direction, d[0], d[1], d[2]);
    ubo.updateFloat3(MAIN_LIGHT_UNIFORMS.color, c ? c[0] : 1, c ? c[1] : 1, c ? c[2] : 1);
    for (const u of this.compiled.uniforms) {
      if (u.type === "sampler2D") {
        const t = this.state.textures.get(u.name);
        if (t) ubo.setTexture(u.name, t);
        continue;
      }
      const n = this.state.numbers.get(u.name) ?? [0, 0, 0, 0];
      if (u.type === "float") ubo.updateFloat(u.name, n[0] ?? 0);
      else if (u.type === "vec2") ubo.updateFloat2(u.name, n[0] ?? 0, n[1] ?? 0);
      else if (u.type === "vec3") ubo.updateFloat3(u.name, n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
      else ubo.updateFloat4(u.name, n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0);
    }
  }

  override getActiveTextures(active: BaseTexture[]): void {
    active.push(...this.state.textures.values());
  }

  override hasTexture(texture: BaseTexture): boolean {
    return [...this.state.textures.values()].includes(texture);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    if (shaderLanguage !== ShaderLanguage.WGSL) return null;
    return this.depth ? graphShadowCustomCode(this.compiled, shaderType) : graphCustomCode(this.compiled, shaderType);
  }
}

let whiteCache = new WeakMap<Scene, RawTexture>();

/** A 1×1 white texture: what an empty texture slot reads. */
function white(scene: Scene): RawTexture {
  let t = whiteCache.get(scene);
  if (!t || t.getScene() !== scene) {
    t = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    whiteCache.set(scene, t);
  }
  return t;
}

/** @internal Forget cached textures (tests). */
export function _resetGraphTextures(): void {
  whiteCache = new WeakMap();
}

/**
 * A Babylon material for a graph compiled to WGSL. `overrides` are a material's property values;
 * `loadTexture` fetches texture assets (slots read white until they load).
 */
export function createGraphMaterial(scene: Scene, name: string, c: CompiledShaderGraph, overrides: Record<string, GraphValue>, shared: GraphShared, loadTexture: LoadGraphTexture): BabylonGraphMaterial {
  if (c.language !== "wgsl") throw new Error(`shader graph: the Babylon backend needs a graph compiled to WGSL, not ${c.language}`);
  const material = new PBRMaterial(name, scene);
  material.sideOrientation = Material.CounterClockWiseSideOrientation;
  material.maxSimultaneousLights = 8;
  material.albedoColor.set(1, 1, 1);
  material.metallic = 0;
  material.roughness = 1;
  material.unlit = c.target === "unlit";
  material.backFaceCulling = !c.doubleSided;
  material.twoSidedLighting = c.doubleSided;
  if (c.surface === "transparent") material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  if (c.target === "physical") {
    // The plugin sets the base surface; physical layers keep their PBR defaults until the graph drives them.
    material.clearCoat.isEnabled = !!c.fragment.physical?.clearcoat;
    material.sheen.isEnabled = !!c.fragment.physical?.sheenColor;
  }
  const state: GraphState = { numbers: new Map(), textures: new Map() };
  // Babylon refuses a WGSL-only plugin on a GLSL material: the WebGL2 fallback draws plain PBR.
  const wgsl = material.shaderLanguage === ShaderLanguage.WGSL;
  if (wgsl) new MycoGraphPlugin(material, c, shared, state);
  const shadow = wgsl && c.vertex.offset ? graphShadowDepth(scene, name, c, shared, state, material) : null;
  let disposed = false;
  const slotPaths = new Map<string, string>();
  const apply = (values: Record<string, GraphValue>) => {
    for (const u of c.uniforms) {
      if (u.type !== "sampler2D") {
        state.numbers.set(u.name, uniformNumbers(u, values));
        continue;
      }
      const path = texturePath(u, values);
      if (slotPaths.get(u.name) === path && state.textures.has(u.name)) continue;
      slotPaths.set(u.name, path);
      state.textures.set(u.name, white(scene));
      if (!path) continue;
      loadTexture(path, !!u.linear)
        .then((t) => {
          if (disposed || slotPaths.get(u.name) !== path) return;
          state.textures.set(u.name, t);
        })
        .catch((err) => console.error(`[myco] shader graph texture "${path}" failed to load:`, err));
    }
  };
  apply(overrides);
  const result: BabylonGraphMaterial = {
    material,
    state,
    compiled: c,
    properties: { ...overrides },
    setProperties(values) {
      result.properties = { ...values };
      apply(values);
    },
    dispose() {
      disposed = true;
      shadow?.wrapper.dispose();
      shadow?.depth.dispose();
      material.dispose();
    },
  };
  return result;
}

/**
 * A graph material's shadow-depth wrapper (graphs with a vertex offset): standalone over an unlit PBR
 * material with the graph's vertex code, sharing the material's uniform values and textures. The
 * shadow generator draws with the wrapper's effect and binds this material, so its uniforms follow
 * the graph material's property changes and the shared time with no extra per-frame work.
 */
function graphShadowDepth(scene: Scene, name: string, c: CompiledShaderGraph, shared: GraphShared, state: GraphState, material: PBRMaterial): { depth: PBRMaterial; wrapper: ShadowDepthWrapper } {
  const depth = new PBRMaterial(`${name}:shadow`, scene);
  depth.doNotSerialize = true;
  depth.unlit = true;
  depth.disableLighting = true;
  new MycoGraphPlugin(depth, c, shared, state, true);
  const wrapper = new ShadowDepthWrapper(depth, scene, { standalone: true, remappedVariables: SHADOW_REMAPPED_VARIABLES });
  shareShadowEffects(wrapper);
  material.shadowDepthWrapper = wrapper;
  return { depth, wrapper };
}

/** The parts of Babylon 9's `ShadowDepthWrapper` that `shareShadowEffects` works with. */
interface WrapperInternals {
  _scene: Scene;
  _subMeshToEffect: Map<SubMesh, [Effect, number]>;
  _subMeshToDepthWrapper: { mm: Map<SubMesh, Map<object, unknown>>; set(subMesh: SubMesh, generator: object, params: unknown): void };
  _makeEffect(subMesh: SubMesh, defines: string[], generator: object, passId: number): Effect | null;
}

/**
 * @internal Make a wrapper's submeshes share their shadow effects. Babylon gives each submesh and
 * shadow generator a random token, so it compiles a shadow program per mesh (a hitch for each new mesh,
 * which the warm-up can't prevent) and per shadow generator (the frame graph makes new ones when it
 * rebuilds, on a resize), and with `Effect.PersistentMode` keeps them all. The program follows from
 * the base material's effect and the generator's defines, so the token is the effect's id instead,
 * and the engine's effect cache hands every submesh the same program. Entries for disposed shadow
 * generators are dropped when a submesh meets a new one. Work only when a submesh meets a generator.
 */
export function shareShadowEffects(wrapper: ShadowDepthWrapper): void {
  const w = wrapper as unknown as WrapperInternals;
  const make = w._makeEffect;
  w._makeEffect = function (subMesh, defines, generator, passId) {
    const orig = w._subMeshToEffect.get(subMesh);
    const byGenerator = w._subMeshToDepthWrapper.mm.get(subMesh);
    if (orig && orig[0].isReady() && !byGenerator?.has(generator)) {
      if (byGenerator) for (const g of byGenerator.keys()) if (!(g as { getShadowMap?(): unknown }).getShadowMap?.()) byGenerator.delete(g);
      // As Babylon makes the entry (`ShadowDepthWrapper._makeEffect`), with a token of our own.
      const main = new DrawWrapper(w._scene.getEngine());
      const defines0 = (subMesh as unknown as { _getDrawWrapper(id: number): DrawWrapper | undefined })._getDrawWrapper(orig[1])?.defines;
      main.defines = typeof defines0 === "string" ? null : (defines0 ?? null);
      const drawWrapper: DrawWrapper[] = [];
      drawWrapper[passId] = main;
      w._subMeshToDepthWrapper.set(subMesh, generator, { drawWrapper, mainDrawWrapper: main, depthDefines: "", token: `myco-graph-shadow-${orig[0].uniqueId}` });
    }
    return make.call(this, subMesh, defines, generator, passId);
  };
}
