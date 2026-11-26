/**
 * The lit layered-quad material (ADR 0399): a material plugin on the 2D quad material (`layeredQuads.ts`, ADR 0186)
 * that reads its layer batch's light textures at the fragment's screen position and composes the blend styles, with
 * the sprite texture's normal map (the directional textures) and mask map (ADR 0414). Fog, tint and slice UVs stay the
 * quad material's. The maths is KSL (`render/lights2D/lightShader.ts`); this is Babylon's injection glue.
 *
 * A lit material belongs to one layer batch (the 2D materials, `materials2D.ts`, make a new one when the rig's layout changes), so its defines
 * (style count, directional, maps) are fixed while it lives. With no light textures for the camera drawing it yet (the
 * frame graph rebuilding), it reads white: drawn as if unlit for that frame.
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { LIGHT2D_SHADER } from "../lights2D/lightShader";
import { lights2DTextures } from "./frameGraph";
import { ACCURATE_FLOATS, lights2DOf } from "./lights2D";
import { SHADOW2D_LOOKUP } from "./lights2DShaders";
import { MycoMaterialPlugin } from "./mycoMaterialPlugin";

/** A lit 2D draw's setup: its layer batch, and its sprite texture's normal and mask maps. */
export interface LitQuadSetup {
  batch: number;
  normal: Texture | null;
  mask: Texture | null;
  /** The normal map's green channel points down (DirectX). */
  greenDown: boolean;
  /**
   * A sprite shader graph's part (ADR 0415; WGSL only): a Sprite Lit graph's own normal and mask (instead of the
   * texture's maps), or a Sprite Custom Lit graph, which reads the light through `mycoL2DLightColor` and
   * `mycoL2DLightDirection` and composes the colour itself.
   */
  graph?: { normal: boolean; mask: boolean; custom: boolean } | null;
}

/** The per-vertex 2D tangent attribute (the quad batches' deforming meshes, `quadBatches.ts`). */
export const TANGENT_2D_ATTRIBUTE = "mycoTangent";

const SLOTS = [0, 1, 2, 3] as const;
/** At most this many accurate lights per batch (the high tier's cap, `LIGHTS_2D_QUALITY.high.accurateLights`). */
const MAX_ACCURATE = 8;
const ACCURATE = Array.from({ length: MAX_ACCURATE }, (_, i) => i);
const ACC_VECS = ACCURATE_FLOATS / 4;
const accName = (i: number, k: number) => `mycoL2DAcc${i}_${k}`;
const MASK_CHANNEL = { none: -1, r: 0, g: 1, b: 2, a: 3 } as const;

function vertexCode(wgsl: boolean): { [point: string]: string } {
  const w = (s: string) => (wgsl ? s : s.replace(/vertexInputs\./g, "").replace(/vertexOutputs\./g, "").replace(/vec4f\(/g, "vec4(").replace(/vec2f\(/g, "vec2(").replace(/\blet\b/g, "vec2"));
  return {
    CUSTOM_VERTEX_DEFINITIONS: [
      "#ifdef MYCO_L2D_NORMAL",
      wgsl ? "varying vMycoL2DFrame: vec4f;" : "varying vec4 vMycoL2DFrame;",
      "#ifdef MYCO_L2D_TANGENT",
      wgsl ? `attribute ${TANGENT_2D_ATTRIBUTE}: vec2f;` : `attribute vec2 ${TANGENT_2D_ATTRIBUTE};`,
      "#endif",
      "#endif",
    ].join("\n"),
    CUSTOM_VERTEX_MAIN_END: [
      "#ifdef MYCO_L2D_NORMAL",
      "{",
      w("let mycoAx = (finalWorld * vec4f(1.0, 0.0, 0.0, 0.0)).xy;"),
      w("let mycoAy = (finalWorld * vec4f(0.0, 1.0, 0.0, 0.0)).xy;"),
      "#ifdef MYCO_L2D_TANGENT",
      w(`let mycoTx = normalize((finalWorld * vec4f(vertexInputs.${TANGENT_2D_ATTRIBUTE}, 0.0, 0.0)).xy + vec2f(0.00000001, 0.0));`),
      wgsl ? "let mycoH = sign(mycoAx.x * mycoAy.y - mycoAx.y * mycoAy.x);" : "float mycoH = sign(mycoAx.x * mycoAy.y - mycoAx.y * mycoAy.x);",
      w("vertexOutputs.vMycoL2DFrame = vec4f(mycoTx, vec2f(-mycoTx.y, mycoTx.x) * mycoH);"),
      "#else",
      w("vertexOutputs.vMycoL2DFrame = vec4f(normalize(mycoAx + vec2f(0.00000001, 0.0)), normalize(mycoAy + vec2f(0.0, 0.00000001)));"),
      "#endif",
      "}",
      "#endif",
    ].join("\n"),
  };
}

function fragmentCode(wgsl: boolean): { [point: string]: string } {
  const sampler = (n: string) => (wgsl ? `var ${n}Sampler: sampler;\nvar ${n}: texture_2d<f32>;` : `uniform sampler2D ${n};`);
  const lod = (n: string, uv: string) => (wgsl ? `textureSampleLevel(${n}, ${n}Sampler, ${uv}, 0.0)` : `texture2D(${n}, ${uv})`);
  const tex = (n: string, uv: string) => (wgsl ? `textureSample(${n}, ${n}Sampler, ${uv})` : `texture2D(${n}, ${uv})`);
  const u = (n: string) => (wgsl ? `uniforms.${n}` : n);
  const v = (t: string) => (wgsl ? t.replace(/^vec(\d)$/, "vec$1f") : t);
  const decl = (t: string, n: string, value: string) => (wgsl ? `var ${n}: ${v(t)} = ${value};` : `${t} ${n} = ${value};`);
  const mainUv = wgsl ? "fragmentInputs.vMainUV1" : "vMainUV1";
  const frame = wgsl ? "fragmentInputs.vMycoL2DFrame" : "vMycoL2DFrame";
  const style = (i: number) =>
    [
      `#if MYCO_L2D_STYLES > ${i}`,
      "{",
      decl("vec3", "mycoL", `${lod(`mycoL2DFlat${i}`, "mycoUv")}.rgb * ${u("mycoL2DScreen")}.w`),
      "#ifdef MYCO_L2D_DIR",
      `mycoL = mycoL + myco2DDirectional(${lod(`mycoL2DDirColor${i}`, "mycoUv")}.rgb * ${u("mycoL2DScreen")}.w, ${lod(`mycoL2DDirVec${i}`, "mycoUv")}.xyz, mycoN);`,
      "#endif",
      decl("float", "mycoM", `myco2DMask(mycoMask, ${u(`mycoL2DStyle${i}`)}.x)`).replace("float", wgsl ? "f32" : "float"),
      `mycoMul = mycoMul + mycoL * (mycoM * ${u(`mycoL2DStyle${i}`)}.y);`,
      `mycoAdd = mycoAdd + mycoL * (mycoM * ${u(`mycoL2DStyle${i}`)}.z);`,
      "}",
      "#endif",
    ].join("\n");
  const world = wgsl ? "fragmentInputs.vPositionW.xy" : "vPositionW.xy";
  const f32 = wgsl ? "f32" : "float";
  // An accurate light (ADR 0415): its attenuation, shadow and N·L at this fragment, into its blend style's sums.
  const accurate = (i: number) =>
    [
      `#if MYCO_L2D_ACC > ${i}`,
      "{",
      decl("vec4", "mycoA", u(accName(i, 0))),
      decl("vec4", "mycoB", u(accName(i, 1))),
      decl("vec4", "mycoC", u(accName(i, 2))),
      decl("vec2", "mycoD", `${world} - mycoA.xy`),
      decl("vec2", "mycoLocal", `${wgsl ? "vec2f" : "vec2"}(mycoB.x * mycoD.x + mycoB.z * mycoD.y, mycoB.y * mycoD.x + mycoB.w * mycoD.y)`),
      decl("float", "mycoK", `myco2DPointAtten(mycoLocal, ${u(accName(i, 3))}, mycoC.x)`).replace("float", f32),
      `if (mycoA.w > -0.5) { mycoK = mycoK * (1.0 - mycoC.y * myco2DShadow(mycoUv, mycoA.w, ${u("mycoL2DShadowTexel")}.xy, mycoC.z)); }`,
      decl("vec3", "mycoLa", `${u(accName(i, 4))}.rgb * (max(mycoK, 0.0) * max(dot(mycoN, myco2DLightDir(mycoA.xy, mycoA.z, ${world})), 0.0))`),
      decl("float", "mycoMa", `myco2DMask(mycoMask, mycoC.w)`).replace("float", f32),
      `mycoMul = mycoMul + mycoLa * (mycoMa * ${u(accName(i, 5))}.x);`,
      `mycoAdd = mycoAdd + mycoLa * (mycoMa * ${u(accName(i, 5))}.y);`,
      "}",
      "#endif",
    ].join("\n");
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: [
      ...(wgsl ? customLitFunctions() : []),
      "#ifdef MYCO_L2D",
      ...SLOTS.map((i) => [`#if MYCO_L2D_STYLES > ${i}`, sampler(`mycoL2DFlat${i}`), "#ifdef MYCO_L2D_DIR", sampler(`mycoL2DDirColor${i}`), sampler(`mycoL2DDirVec${i}`), "#endif", "#endif"].join("\n")),
      "#ifdef MYCO_L2D_NORMAL",
      "#ifdef MYCO_L2D_NORMAL_TEX",
      sampler("mycoL2DNormal"),
      "#endif",
      wgsl ? "varying vMycoL2DFrame: vec4f;" : "varying vec4 vMycoL2DFrame;",
      "#endif",
      "#ifdef MYCO_L2D_MASK",
      sampler("mycoL2DMask"),
      "#endif",
      LIGHT2D_SHADER.text(wgsl ? "wgsl" : "glsl"),
      "#if MYCO_L2D_ACC > 0",
      SHADOW2D_LOOKUP.text(wgsl ? "wgsl" : "glsl"),
      "#endif",
      "#endif",
    ].join("\n"),
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: [
      "#ifdef MYCO_L2D",
      "#ifndef MYCO_L2D_CUSTOM", // a Sprite Custom Lit graph composes its colour itself (ADR 0415)
      "{",
      decl("vec2", "mycoUv", `${wgsl ? "fragmentInputs.position.xy" : "gl_FragCoord.xy"} * ${u("mycoL2DScreen")}.xy`),
      decl("vec3", "mycoN", wgsl ? "vec3f(0.0, 0.0, 1.0)" : "vec3(0.0, 0.0, 1.0)"),
      "#ifdef MYCO_L2D_GRAPH_NORMAL",
      "{",
      decl("vec3", "mycoNt", "mycoSpriteN"), // a Sprite Lit graph's normal (ADR 0415), turned by the same frame
      `mycoN = normalize(${wgsl ? "vec3f" : "vec3"}(${frame}.xy * mycoNt.x + ${frame}.zw * mycoNt.y, mycoNt.z));`,
      "}",
      "#endif",
      "#if defined(MYCO_L2D_NORMAL_TEX) && defined(MAINUV1)",
      "{",
      decl("vec3", "mycoNt", `${tex("mycoL2DNormal", mainUv)}.xyz * 2.0 - 1.0`),
      `mycoN = normalize(${wgsl ? "vec3f" : "vec3"}(${frame}.xy * mycoNt.x + ${frame}.zw * (mycoNt.y * ${u("mycoL2DScreen")}.z), mycoNt.z));`,
      "}",
      "#endif",
      decl("vec4", "mycoMask", wgsl ? "vec4f(1.0)" : "vec4(1.0)"),
      "#if defined(MYCO_L2D_MASK) && defined(MAINUV1)",
      `mycoMask = ${tex("mycoL2DMask", mainUv)};`,
      "#endif",
      "#ifdef MYCO_L2D_GRAPH_MASK",
      "mycoMask = mycoSpriteMask;",
      "#endif",
      decl("vec3", "mycoMul", wgsl ? "vec3f(0.0)" : "vec3(0.0)"),
      decl("vec3", "mycoAdd", wgsl ? "vec3f(0.0)" : "vec3(0.0)"),
      ...SLOTS.map(style),
      ...ACCURATE.map(accurate),
      decl("vec3", "mycoBase", "finalAmbient + finalDiffuse"),
      `finalAmbient = ${wgsl ? "vec3f(0.0)" : "vec3(0.0)"};`,
      "finalDiffuse = myco2DCompose(mycoBase, mycoMul, mycoAdd);",
      "}",
      "#endif",
      "#endif",
    ].join("\n"),
  };
}

/**
 * A Sprite Custom Lit graph's light reads (ADR 0415; WGSL, as graphs are): the batch's light at a fragment (every style's
 * flat and directional light, summed, as it reaches a surface facing the viewer) and the direction it comes from (the
 * directional textures' sum; toward the viewer without). With no light textures they read white and toward the viewer.
 * Accurate lights aren't in the textures, so these don't see them.
 */
function customLitFunctions(): string[] {
  const lod = (n: string) => `textureSampleLevel(${n}, ${n}Sampler, uv, 0.0)`;
  const styles = (body: (i: number) => string) => SLOTS.map((i) => [`#if MYCO_L2D_STYLES > ${i}`, body(i), "#endif"].join("\n"));
  return [
    "#ifdef MYCO_L2D_CUSTOM",
    "fn mycoL2DLightColor(frag: vec2f) -> vec3f {",
    "#ifdef MYCO_L2D",
    "  let uv = frag * uniforms.mycoL2DScreen.xy;",
    "  var l = vec3f(0.0);",
    ...styles((i) => [`  l = l + ${lod(`mycoL2DFlat${i}`)}.rgb;`, "#ifdef MYCO_L2D_DIR", `  l = l + ${lod(`mycoL2DDirColor${i}`)}.rgb;`, "#endif"].join("\n")),
    "  return l * uniforms.mycoL2DScreen.w;",
    "#else",
    "  return vec3f(1.0);",
    "#endif",
    "}",
    "fn mycoL2DLightDirection(frag: vec2f) -> vec3f {",
    "#if defined(MYCO_L2D) && defined(MYCO_L2D_DIR)",
    "  let uv = frag * uniforms.mycoL2DScreen.xy;",
    "  var d = vec3f(0.0);",
    ...styles((i) => `  d = d + ${lod(`mycoL2DDirVec${i}`)}.xyz;`),
    "  if (length(d) > 0.00001) { return normalize(d); }",
    "#endif",
    "  return vec3f(0.0, 0.0, 1.0);",
    "}",
    "#endif",
  ];
}

/** @internal Lights a layered-quad material by its layer batch's 2D light textures (see the file comment). */
export class Light2DPlugin extends MycoMaterialPlugin {
  private lit = false;

  constructor(
    material: PBRMaterial,
    readonly setup: LitQuadSetup,
  ) {
    super(material, "MycoLight2D", 220, { MYCO_L2D: false, MYCO_L2D_STYLES: 1, MYCO_L2D_DIR: false, MYCO_L2D_NORMAL: false, MYCO_L2D_NORMAL_TEX: false, MYCO_L2D_MASK: false, MYCO_L2D_TANGENT: false, MYCO_L2D_ACC: 0, MYCO_L2D_GRAPH_NORMAL: false, MYCO_L2D_GRAPH_MASK: false, MYCO_L2D_CUSTOM: false });
    this.register();
  }

  override getClassName(): string {
    return "MycoLight2DPlugin";
  }

  override prepareDefines(defines: MaterialDefines, scene: Scene, mesh: AbstractMesh): void {
    const b = lights2DOf(scene)?.batch(this.setup.batch) ?? null;
    this.lit = !!b && b.styles.length > 0;
    defines.MYCO_L2D = this.lit;
    defines.MYCO_L2D_STYLES = b ? Math.min(4, Math.max(1, b.styles.length)) : 1;
    defines.MYCO_L2D_DIR = !!b?.directional;
    // Accurate lights (ADR 0415) are in no light texture: every lit draw adds them, a draw without a normal map facing the viewer.
    const acc = b ? Math.min(MAX_ACCURATE, b.accurate.length / ACCURATE_FLOATS) : 0;
    defines.MYCO_L2D_ACC = acc;
    const graph = this.setup.graph ?? null;
    const normals = (!!b?.directional || acc > 0) && (!!this.setup.normal || !!graph?.normal) && !graph?.custom;
    defines.MYCO_L2D_NORMAL = normals;
    defines.MYCO_L2D_GRAPH_NORMAL = normals && !!graph?.normal;
    defines.MYCO_L2D_NORMAL_TEX = normals && !graph?.normal;
    const rig = lights2DOf(scene);
    const masked = !!b?.styles.some((s) => rig?.style(s).mask !== "none");
    defines.MYCO_L2D_GRAPH_MASK = masked && !!graph?.mask;
    defines.MYCO_L2D_MASK = masked && !!this.setup.mask && !graph?.mask;
    defines.MYCO_L2D_CUSTOM = !!graph?.custom;
    defines.MYCO_L2D_TANGENT = normals && !!mesh?.isVerticesDataPresent(TANGENT_2D_ATTRIBUTE);
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (mesh?.isVerticesDataPresent(TANGENT_2D_ATTRIBUTE)) attributes.push(TANGENT_2D_ATTRIBUTE);
  }

  override getSamplers(samplers: string[]): void {
    for (const i of SLOTS) samplers.push(`mycoL2DFlat${i}`, `mycoL2DDirColor${i}`, `mycoL2DDirVec${i}`);
    samplers.push("mycoL2DNormal", "mycoL2DMask", "l2dShadow0", "l2dShadow1", "l2dShadow2", "l2dShadow3");
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: "mycoL2DScreen", size: 4, type: "vec4" },
        ...SLOTS.map((i) => ({ name: `mycoL2DStyle${i}`, size: 4, type: "vec4" })),
        { name: "mycoL2DShadowTexel", size: 4, type: "vec4" },
        ...ACCURATE.flatMap((i) => Array.from({ length: ACC_VECS }, (_, k) => ({ name: accName(i, k), size: 4, type: "vec4" }))),
      ],
      fragment: "",
    };
  }

  override isReadyForSubMesh(): boolean {
    const { normal, mask } = this.setup;
    return (!normal || normal.isReady()) && (!mask || mask.isReady());
  }

  /**
   * Every draw, even when Babylon skips rebinding a cached material (`hardBindForSubMesh` runs before its `mustRebind`
   * check): the light textures are the camera's this frame, and a material drawn by two cameras, or first drawn while the
   * frame graph was still building, would otherwise keep what it bound then.
   */
  override bindForSubMesh(ubo: UniformBuffer, scene: Scene, engine: AbstractEngine, subMesh: SubMesh): void {
    this.bindLights(ubo, scene, engine, subMesh);
  }

  override hardBindForSubMesh(ubo: UniformBuffer, scene: Scene, engine: AbstractEngine, subMesh: SubMesh): void {
    this.bindLights(ubo, scene, engine, subMesh);
  }

  private bindLights(ubo: UniformBuffer, scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    if (!this.lit) return;
    // Textures straight to the effect being drawn: here, before the material binds its uniform buffer to the effect,
    // the buffer may still point at another effect's.
    const effect = subMesh.effect;
    if (!effect) return;
    const setTexture = (name: string, texture: Parameters<typeof effect.setTexture>[1]) => effect.setTexture(name, texture);
    const rig = lights2DOf(scene);
    const b = rig?.batch(this.setup.batch);
    if (!rig || !b) return;
    const camera = scene.activeCamera;
    const textures = camera ? lights2DTextures(scene, camera) : null;
    const views = textures?.batches[this.setup.batch];
    const [w, h] = textures?.size ?? [scene.getEngine().getRenderWidth(), scene.getEngine().getRenderHeight()];
    ubo.updateFloat4("mycoL2DScreen", 1 / Math.max(1, w), 1 / Math.max(1, h), this.setup.greenDown ? -1 : 1, views ? rig.range : 1);
    const white = rig.whiteFallback();
    const black = rig.blackFallback();
    for (const i of SLOTS) {
      const style = rig.style(b.styles[i] ?? 0);
      ubo.updateFloat4(`mycoL2DStyle${i}`, MASK_CHANNEL[style.mask], views ? style.multiply : 1, views ? style.add : 0, 0);
      if (i >= b.styles.length) continue;
      setTexture(`mycoL2DFlat${i}`, views?.flat[i] ?? white);
      if (b.directional) {
        setTexture(`mycoL2DDirColor${i}`, views?.dirColor[i] ?? black);
        setTexture(`mycoL2DDirVec${i}`, views?.dirVec[i] ?? black);
      }
    }
    // Accurate lights (ADR 0415): their uniforms, and the shadow textures their slots read.
    const acc = Math.min(MAX_ACCURATE, b.accurate.length / ACCURATE_FLOATS);
    if (acc > 0) {
      const ls = textures?.lightSize ?? [w, h];
      ubo.updateFloat4("mycoL2DShadowTexel", 1 / Math.max(1, ls[0]), 1 / Math.max(1, ls[1]), 0, 0);
      for (let i = 0; i < acc; i++)
        for (let k = 0; k < ACC_VECS; k++) {
          const o = i * ACCURATE_FLOATS + k * 4;
          const a = b.accurate;
          ubo.updateFloat4(accName(i, k), a[o]!, a[o + 1]!, a[o + 2]!, a[o + 3]!);
        }
      for (let k = 0; k < 4; k++) setTexture(`l2dShadow${k}`, textures?.shadows[k] ?? black);
    }
    if (this.setup.normal && !this.setup.graph?.normal) setTexture("mycoL2DNormal", this.setup.normal);
    if (this.setup.mask) setTexture("mycoL2DMask", this.setup.mask);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    const wgsl = (shaderLanguage ?? ShaderLanguage.GLSL) === ShaderLanguage.WGSL;
    return shaderType === "vertex" ? vertexCode(wgsl) : fragmentCode(wgsl);
  }
}
