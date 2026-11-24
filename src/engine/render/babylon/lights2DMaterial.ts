/**
 * The lit layered-quad material (ADR 0399): a material plugin on the 2D quad material (`layeredQuads.ts`, ADR 0186)
 * that reads its layer batch's light textures at the fragment's screen position and composes the blend styles, with
 * the sprite texture's normal map (the directional textures) and mask map (ADR 0401). Fog, tint and slice UVs stay the
 * quad material's. The maths is KSL (`render/lights2D/lightShader.ts`); this is Babylon's injection glue.
 *
 * A lit material belongs to one layer batch (its owner keys materials by batch and the rig's `version`), so its defines
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
import { lights2DOf } from "./lights2D";
import { MycoMaterialPlugin } from "./mycoMaterialPlugin";

/** A lit 2D draw's setup: its layer batch, and its sprite texture's normal and mask maps. */
export interface LitQuadSetup {
  batch: number;
  normal: Texture | null;
  mask: Texture | null;
  /** The normal map's green channel points down (DirectX). */
  greenDown: boolean;
}

/** The per-vertex 2D tangent attribute (`QuadBatch.setTangents`). */
export const TANGENT_2D_ATTRIBUTE = "mycoTangent";

const SLOTS = [0, 1, 2, 3] as const;
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
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: [
      "#ifdef MYCO_L2D",
      ...SLOTS.map((i) => [`#if MYCO_L2D_STYLES > ${i}`, sampler(`mycoL2DFlat${i}`), "#ifdef MYCO_L2D_DIR", sampler(`mycoL2DDirColor${i}`), sampler(`mycoL2DDirVec${i}`), "#endif", "#endif"].join("\n")),
      "#ifdef MYCO_L2D_NORMAL",
      sampler("mycoL2DNormal"),
      wgsl ? "varying vMycoL2DFrame: vec4f;" : "varying vec4 vMycoL2DFrame;",
      "#endif",
      "#ifdef MYCO_L2D_MASK",
      sampler("mycoL2DMask"),
      "#endif",
      LIGHT2D_SHADER.text(wgsl ? "wgsl" : "glsl"),
      "#endif",
    ].join("\n"),
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: [
      "#ifdef MYCO_L2D",
      "{",
      decl("vec2", "mycoUv", `${wgsl ? "fragmentInputs.position.xy" : "gl_FragCoord.xy"} * ${u("mycoL2DScreen")}.xy`),
      decl("vec3", "mycoN", wgsl ? "vec3f(0.0, 0.0, 1.0)" : "vec3(0.0, 0.0, 1.0)"),
      "#if defined(MYCO_L2D_NORMAL) && defined(MAINUV1)",
      "{",
      decl("vec3", "mycoNt", `${tex("mycoL2DNormal", mainUv)}.xyz * 2.0 - 1.0`),
      `mycoN = normalize(${wgsl ? "vec3f" : "vec3"}(${frame}.xy * mycoNt.x + ${frame}.zw * (mycoNt.y * ${u("mycoL2DScreen")}.z), mycoNt.z));`,
      "}",
      "#endif",
      decl("vec4", "mycoMask", wgsl ? "vec4f(1.0)" : "vec4(1.0)"),
      "#if defined(MYCO_L2D_MASK) && defined(MAINUV1)",
      `mycoMask = ${tex("mycoL2DMask", mainUv)};`,
      "#endif",
      decl("vec3", "mycoMul", wgsl ? "vec3f(0.0)" : "vec3(0.0)"),
      decl("vec3", "mycoAdd", wgsl ? "vec3f(0.0)" : "vec3(0.0)"),
      ...SLOTS.map(style),
      decl("vec3", "mycoBase", "finalAmbient + finalDiffuse"),
      `finalAmbient = ${wgsl ? "vec3f(0.0)" : "vec3(0.0)"};`,
      "finalDiffuse = myco2DCompose(mycoBase, mycoMul, mycoAdd);",
      "}",
      "#endif",
    ].join("\n"),
  };
}

/** @internal Lights a layered-quad material by its layer batch's 2D light textures (see the file comment). */
export class Light2DPlugin extends MycoMaterialPlugin {
  private lit = false;

  constructor(
    material: PBRMaterial,
    readonly setup: LitQuadSetup,
  ) {
    super(material, "MycoLight2D", 220, { MYCO_L2D: false, MYCO_L2D_STYLES: 1, MYCO_L2D_DIR: false, MYCO_L2D_NORMAL: false, MYCO_L2D_MASK: false, MYCO_L2D_TANGENT: false });
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
    defines.MYCO_L2D_NORMAL = !!b?.directional && !!this.setup.normal;
    const rig = lights2DOf(scene);
    defines.MYCO_L2D_MASK = !!this.setup.mask && !!b?.styles.some((s) => rig?.style(s).mask !== "none");
    defines.MYCO_L2D_TANGENT = !!b?.directional && !!this.setup.normal && !!mesh?.isVerticesDataPresent(TANGENT_2D_ATTRIBUTE);
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (mesh?.isVerticesDataPresent(TANGENT_2D_ATTRIBUTE)) attributes.push(TANGENT_2D_ATTRIBUTE);
  }

  override getSamplers(samplers: string[]): void {
    for (const i of SLOTS) samplers.push(`mycoL2DFlat${i}`, `mycoL2DDirColor${i}`, `mycoL2DDirVec${i}`);
    samplers.push("mycoL2DNormal", "mycoL2DMask");
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return { ubo: [{ name: "mycoL2DScreen", size: 4, type: "vec4" }, ...SLOTS.map((i) => ({ name: `mycoL2DStyle${i}`, size: 4, type: "vec4" }))], fragment: "" };
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
    if (this.setup.normal) setTexture("mycoL2DNormal", this.setup.normal);
    if (this.setup.mask) setTexture("mycoL2DMask", this.setup.mask);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    const wgsl = (shaderLanguage ?? ShaderLanguage.GLSL) === ShaderLanguage.WGSL;
    return shaderType === "vertex" ? vertexCode(wgsl) : fragmentCode(wgsl);
  }
}
