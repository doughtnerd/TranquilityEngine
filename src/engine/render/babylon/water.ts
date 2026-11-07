/**
 * Water surfaces on the Babylon backend (ADR 0072, 0075 stage 6). The counterpart of
 * `WaterRenderer`: one grid mesh and one PBR material per `WaterSurface`, updated each frame from
 * the component and the water clock. A material plugin splices the Gerstner wave sum (the same
 * maths as `gerstner.ts`, in WGSL) into Babylon's PBR vertex shader and the water colouring into
 * its fragment shader, so lights, shadows, the environment, probe reflections and the frame
 * graph's effects apply as on any material.
 *
 * Where the code goes:
 * - vertex: the wave function at CUSTOM_VERTEX_DEFINITIONS; the displacement and the analytic
 *   normal just before `worldPos` is computed (Babylon then derives `vNormalW` from the normal);
 *   two varyings of its own (`vMycoW`: rest x, rest z, height, Jacobian; `vMycoX`: the grid's
 *   world X axis), since WebGPU allows 16 vertex outputs and PBR with shadows uses most;
 * - fragment: ripple normals after `pbrBlockNormalFinal`, deep/shallow/foam colour at
 *   CUSTOM_FRAGMENT_UPDATE_ALPHA, roughness (rougher under foam) into `reflectivityBlock`.
 *
 * Waves are packed into vec4 uniforms (UBO arrays are avoided): `mycoWave0..7` hold
 * (direction x, direction z, wave number, amplitude) per wave and `mycoPhase0/1` the eight phases
 * (the fifth float of `WAVE_STRIDE`). The plugin has a GLSL twin for the WebGL2 fallback, whose
 * wave sum is `GERSTNER_BODY` itself: without it the fallback drew a flat plane at rest height
 * while ships rode the sampled waves, so troughs hid their hulls.
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Material } from "@babylonjs/core/Materials/material.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../core/World";
import { Graphics } from "../Graphics";
import { GERSTNER_BODY, MAX_WAVES, WAVE_STRIDE, maxAmplitude } from "../water/gerstner";
import { waterTime, type WaterSurface } from "../water/WaterSurface";
import { ALBEDO_ANCHOR } from "./graphMaterial";
import { useEngineLightFalloff } from "./materials";

/** A reflection probe's map and strength (ADR 0054), or null for the scene's environment only. */
export type BabylonWaterProbe = (x: number, y: number, z: number) => { texture: BaseTexture; intensity: number } | null;

/** The values a water material's plugin binds, refreshed by `sync` each frame. */
interface WaterState {
  /** Per wave: direction x, direction z, wave number, amplitude. */
  waves: Float32Array;
  phases: Float32Array;
  count: number;
  time: number;
  deep: [number, number, number];
  shallow: [number, number, number];
  foam: [number, number, number];
  foamAmount: number;
  normalDetail: number;
  maxHeight: number;
}

function createState(): WaterState {
  return { waves: new Float32Array(MAX_WAVES * 4), phases: new Float32Array(MAX_WAVES), count: 0, time: 0, deep: [0, 0, 0], shallow: [0, 0, 0], foam: [0, 0, 0], foamAmount: 0, normalDetail: 0, maxHeight: 0 };
}

const WAVE_UNIFORMS = Array.from({ length: MAX_WAVES }, (_, i) => `mycoWave${i}`);
const PHASE_UNIFORMS = ["mycoPhase0", "mycoPhase1"];

/** @internal The plugin's uniform buffer entries (all vec4). */
export function waterUniformBuffer(): { name: string; size: number; type: string }[] {
  const names = [...WAVE_UNIFORMS, ...PHASE_UNIFORMS, "mycoWaterA", "mycoWaterB", "mycoDeep", "mycoShallow", "mycoFoam"];
  return names.map((name) => ({ name, size: 4, type: "vec4" }));
}

/** The wave sum (`GERSTNER_BODY` in WGSL): a matrix whose columns are the displacement, tangent (dP/dx) and binormal (dP/dz). */
const WGSL_GERSTNER = /* wgsl */ `
fn mycoGerstner(px: f32, pz: f32) -> mat3x3f {
  var wv = array<vec4f, ${MAX_WAVES}>(${WAVE_UNIFORMS.map((n) => `uniforms.${n}`).join(", ")});
  var ph = array<f32, ${MAX_WAVES}>(uniforms.mycoPhase0.x, uniforms.mycoPhase0.y, uniforms.mycoPhase0.z, uniforms.mycoPhase0.w, uniforms.mycoPhase1.x, uniforms.mycoPhase1.y, uniforms.mycoPhase1.z, uniforms.mycoPhase1.w);
  let count = i32(uniforms.mycoWaterA.x);
  var g = vec3f(0.0);
  var t = vec3f(1.0, 0.0, 0.0);
  var b = vec3f(0.0, 0.0, 1.0);
  for (var i: i32 = 0; i < ${MAX_WAVES}; i++) {
    if (i >= count) { break; }
    let w = wv[i];
    let f = w.z * (w.x * px + w.y * pz) - ph[i];
    let c = cos(f);
    let s = sin(f);
    let st = w.z * w.w;
    g += vec3f(w.x * w.w * c, w.w * s, w.y * w.w * c);
    t += vec3f(-w.x * w.x * st * s, w.x * st * c, -w.x * w.y * st * s);
    b += vec3f(-w.x * w.y * st * s, w.y * st * c, -w.y * w.y * st * s);
  }
  return mat3x3f(g, t, b);
}
`;

/** Value noise (x) and its gradient (yz), as in `waterShader.ts`. */
const WGSL_NOISE = /* wgsl */ `
fn mycoHash(p0: vec2f) -> f32 {
  var p = fract(p0 * vec2f(123.34, 456.21));
  p = p + vec2f(dot(p, p + vec2f(45.32)));
  return fract(p.x * p.y);
}
fn mycoNoise(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  let a = mycoHash(i);
  let b = mycoHash(i + vec2f(1.0, 0.0));
  let c = mycoHash(i + vec2f(0.0, 1.0));
  let d = mycoHash(i + vec2f(1.0, 1.0));
  let v = a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  let g = du * vec2f(b - a + (a - b - c + d) * u.y, c - a + (a - b - c + d) * u.x);
  return vec3f(v, g);
}
`;

/**
 * The wave sum in GLSL (WebGL2): the vec4 uniforms unpacked into `GERSTNER_BODY`'s flat
 * `WAVE_STRIDE` layout, then `GERSTNER_BODY` itself (the text three.js's shader and the CPU sampler's
 * tests use), so the fallback draws exactly the waves `WaterSurface.sample` reports.
 */
const GLSL_GERSTNER = /* glsl */ `
void mycoGerstner(float px, float pz, out vec3 disp, out vec3 tangent, out vec3 binormal) {
  vec4 mycoWv[${MAX_WAVES}] = vec4[${MAX_WAVES}](${WAVE_UNIFORMS.join(", ")});
  float mycoPh[${MAX_WAVES}] = float[${MAX_WAVES}](mycoPhase0.x, mycoPhase0.y, mycoPhase0.z, mycoPhase0.w, mycoPhase1.x, mycoPhase1.y, mycoPhase1.z, mycoPhase1.w);
  float mycoWaves[${MAX_WAVES * WAVE_STRIDE}];
  for (int j = 0; j < ${MAX_WAVES}; j++) {
    mycoWaves[j * ${WAVE_STRIDE}] = mycoWv[j].x;
    mycoWaves[j * ${WAVE_STRIDE} + 1] = mycoWv[j].y;
    mycoWaves[j * ${WAVE_STRIDE} + 2] = mycoWv[j].z;
    mycoWaves[j * ${WAVE_STRIDE} + 3] = mycoWv[j].w;
    mycoWaves[j * ${WAVE_STRIDE} + 4] = mycoPh[j];
  }
  int mycoWaveCount = int(mycoWaterA.x + 0.5);
${GERSTNER_BODY.replace(/\$float/g, "float").replace(/\$int/g, "int")}
  disp = vec3(gx, gy, gz);
  tangent = vec3(tx, ty, tz);
  binormal = vec3(bx, by, bz);
}
`;

/** `WGSL_NOISE` in GLSL (the same as `waterShader.ts`'s). */
const GLSL_NOISE = /* glsl */ `
float mycoHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 mycoNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = mycoHash(i);
  float b = mycoHash(i + vec2(1.0, 0.0));
  float c = mycoHash(i + vec2(0.0, 1.0));
  float d = mycoHash(i + vec2(1.0, 1.0));
  float v = a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  vec2 g = du * vec2(b - a + (a - b - c + d) * u.y, c - a + (a - b - c + d) * u.x);
  return vec3(v, g);
}
`;

/** Babylon's GLSL PBR fragment: the albedo block's declaration, just after the normal is final. */
const GLSL_ALBEDO_ANCHOR = "!albedoOpacityOutParams\\s+albedoOpacityOut\\s*;";

/**
 * @internal Where the water's code goes in Babylon's PBR shaders, by injection point (keys starting
 * with "!" are regular expressions Babylon replaces; see the file's header). WGSL on WebGPU, GLSL
 * on the WebGL2 fallback.
 */
export function waterCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.WGSL): { [point: string]: string } {
  if (language === ShaderLanguage.GLSL) return waterCustomCodeGLSL(shaderType);
  if (shaderType === "vertex") {
    return {
      CUSTOM_VERTEX_DEFINITIONS: `${WGSL_GERSTNER}\nvarying vMycoW: vec4f;\nvarying vMycoX: vec3f;`,
      // Replaces the world position's computation, so the displacement moves the vertex before it.
      "!var\\s+worldPos\\s*:\\s*vec4f\\s*=\\s*finalWorld\\s*\\*\\s*vec4f\\(\\s*positionUpdated\\s*,\\s*1\\.0\\s*\\)\\s*;": [
        "let mycoG: mat3x3f = mycoGerstner(positionUpdated.x, positionUpdated.z);",
        "let mycoRest: vec2f = positionUpdated.xz;",
        "#ifdef NORMAL",
        "normalUpdated = normalize(cross(mycoG[2], mycoG[1]));",
        "#endif",
        "positionUpdated = positionUpdated + mycoG[0];",
        "var worldPos: vec4f = finalWorld * vec4f(positionUpdated, 1.0);",
        "vertexOutputs.vMycoW = vec4f(mycoRest, mycoG[0].y, mycoG[1].x * mycoG[2].z - mycoG[1].z * mycoG[2].x);",
        "vertexOutputs.vMycoX = normalize((finalWorld * vec4f(1.0, 0.0, 0.0, 0.0)).xyz);",
      ].join("\n"),
    };
  }
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vMycoW: vec4f;\nvarying vMycoX: vec3f;\n${WGSL_NOISE}`,
    // Ripples bend the normal (in world space; the node is level, so its Z axis is X cross up), then
    // the colour and foam are worked out from the bent normal. Anchored on the albedo block's
    // declaration, just after the normal is final: Babylon expands its includes before plugin code
    // goes in, so "#include<pbrBlockNormalFinal>" isn't there to match.
    [ALBEDO_ANCHOR]: [
      "var mycoFoam: f32 = 0.0;",
      "var mycoShallow: f32 = 0.0;",
      "{",
      "  let rest = fragmentInputs.vMycoW.xy;",
      "  let t = uniforms.mycoWaterA.y;",
      "  let r1 = mycoNoise(rest * 0.35 + vec2f(t * 0.11, t * 0.07));",
      "  let r2 = mycoNoise(rest * 0.9 + vec2f(-t * 0.05, t * 0.13));",
      "  let slope = (r1.yz * 0.35 + r2.yz * 0.9 * 0.5) * uniforms.mycoWaterA.w * 0.25;",
      "  let axisX = normalize(fragmentInputs.vMycoX);",
      "  let axisZ = normalize(cross(axisX, vec3f(0.0, 1.0, 0.0)));",
      "  normalW = normalize(normalW - axisX * slope.x - axisZ * slope.y);",
      "  let view = normalize(scene.vEyePosition.xyz - fragmentInputs.vPositionW);",
      "  let facing = clamp(dot(normalW, view), 0.0, 1.0);",
      "  let maxH = uniforms.mycoWaterB.x;",
      "  let crest = select(0.5, clamp(fragmentInputs.vMycoW.z / max(maxH, 1e-6) * 0.5 + 0.5, 0.0, 1.0), maxH > 0.0);",
      "  mycoShallow = clamp(0.55 * crest + 0.45 * (1.0 - facing), 0.0, 1.0);",
      "  // Foam where the surface is compressed (the Jacobian falls toward 0 where crests fold).",
      "  let fold = 1.0 - fragmentInputs.vMycoW.w + (r1.x - 0.5) * 0.15;",
      "  let amount = clamp(uniforms.mycoWaterA.z, 0.0, 1.0);",
      "  let threshold = 1.0 - amount;",
      "  mycoFoam = select(0.0, smoothstep(threshold, threshold + 0.35, fold), amount > 0.0);",
      "}",
      "var albedoOpacityOut: albedoOpacityOutParams;",
    ].join("\n"),
    CUSTOM_FRAGMENT_UPDATE_ALPHA: "surfaceAlbedo = mix(mix(uniforms.mycoDeep.rgb, uniforms.mycoShallow.rgb, mycoShallow), uniforms.mycoFoam.rgb, mycoFoam);",
    // vReflectivityColor holds metallic, roughness, IOR and F0 in the metallic workflow.
    "!reflectivityBlock\\(\\s*uniforms\\.vReflectivityColor": "reflectivityBlock(vec4f(0.0, mix(uniforms.vReflectivityColor.y, 0.9, mycoFoam), uniforms.vReflectivityColor.zw)",
  };
}

/** `waterCustomCode` for Babylon's GLSL PBR shaders (WebGL2): the same steps, in GLSL. */
function waterCustomCodeGLSL(shaderType: string): { [point: string]: string } {
  if (shaderType === "vertex") {
    return {
      CUSTOM_VERTEX_DEFINITIONS: `${GLSL_GERSTNER}\nvarying vec4 vMycoW;\nvarying vec3 vMycoX;`,
      "!vec4\\s+worldPos\\s*=\\s*finalWorld\\s*\\*\\s*vec4\\(\\s*positionUpdated\\s*,\\s*1\\.0\\s*\\)\\s*;": [
        "vec3 mycoDisp; vec3 mycoTangent; vec3 mycoBinormal;",
        "mycoGerstner(positionUpdated.x, positionUpdated.z, mycoDisp, mycoTangent, mycoBinormal);",
        "vec2 mycoRest = positionUpdated.xz;",
        "#ifdef NORMAL",
        "normalUpdated = normalize(cross(mycoBinormal, mycoTangent));",
        "#endif",
        "positionUpdated = positionUpdated + mycoDisp;",
        "vec4 worldPos = finalWorld * vec4(positionUpdated, 1.0);",
        "vMycoW = vec4(mycoRest, mycoDisp.y, mycoTangent.x * mycoBinormal.z - mycoTangent.z * mycoBinormal.x);",
        "vMycoX = normalize((finalWorld * vec4(1.0, 0.0, 0.0, 0.0)).xyz);",
      ].join("\n"),
    };
  }
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vec4 vMycoW;\nvarying vec3 vMycoX;\n${GLSL_NOISE}`,
    [GLSL_ALBEDO_ANCHOR]: [
      "float mycoFoamK = 0.0;",
      "float mycoShallowK = 0.0;",
      "{",
      "  vec2 rest = vMycoW.xy;",
      "  float t = mycoWaterA.y;",
      "  vec3 r1 = mycoNoise(rest * 0.35 + vec2(t * 0.11, t * 0.07));",
      "  vec3 r2 = mycoNoise(rest * 0.9 + vec2(-t * 0.05, t * 0.13));",
      "  vec2 slope = (r1.yz * 0.35 + r2.yz * 0.9 * 0.5) * mycoWaterA.w * 0.25;",
      "  vec3 axisX = normalize(vMycoX);",
      "  vec3 axisZ = normalize(cross(axisX, vec3(0.0, 1.0, 0.0)));",
      "  normalW = normalize(normalW - axisX * slope.x - axisZ * slope.y);",
      "  vec3 view = normalize(vEyePosition.xyz - vPositionW);",
      "  float facing = clamp(dot(normalW, view), 0.0, 1.0);",
      "  float maxH = mycoWaterB.x;",
      "  float crest = maxH > 0.0 ? clamp(vMycoW.z / max(maxH, 1e-6) * 0.5 + 0.5, 0.0, 1.0) : 0.5;",
      "  mycoShallowK = clamp(0.55 * crest + 0.45 * (1.0 - facing), 0.0, 1.0);",
      "  float fold = 1.0 - vMycoW.w + (r1.x - 0.5) * 0.15;",
      "  float amount = clamp(mycoWaterA.z, 0.0, 1.0);",
      "  float threshold = 1.0 - amount;",
      "  mycoFoamK = amount > 0.0 ? smoothstep(threshold, threshold + 0.35, fold) : 0.0;",
      "}",
      "albedoOpacityOutParams albedoOpacityOut;",
    ].join("\n"),
    CUSTOM_FRAGMENT_UPDATE_ALPHA: "surfaceAlbedo = mix(mix(mycoDeep.rgb, mycoShallow.rgb, mycoShallowK), mycoFoam.rgb, mycoFoamK);",
    "!reflectivityBlock\\(\\s*vReflectivityColor": "reflectivityBlock(vec4(0.0, mix(vReflectivityColor.y, 0.9, mycoFoamK), vReflectivityColor.zw)",
  };
}

/** The material plugin carrying the water shader. */
class MycoWaterPlugin extends MaterialPluginBase {
  constructor(
    material: PBRMaterial,
    private readonly state: WaterState,
  ) {
    // Registered after the fields are set: registering reads the plugin's code.
    super(material, "MycoWater", 200, { MYCO_WATER: true }, false);
    (this._pluginManager as unknown as { _addPlugin(p: MaterialPluginBase): boolean })._addPlugin(this);
    this._enable(true);
  }

  override getClassName(): string {
    return "MycoWaterPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.WGSL || shaderLanguage === ShaderLanguage.GLSL;
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[] } {
    return { ubo: waterUniformBuffer() };
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.state;
    for (let i = 0; i < MAX_WAVES; i++) ubo.updateFloat4(WAVE_UNIFORMS[i], s.waves[i * 4], s.waves[i * 4 + 1], s.waves[i * 4 + 2], s.waves[i * 4 + 3]);
    ubo.updateFloat4(PHASE_UNIFORMS[0], s.phases[0], s.phases[1], s.phases[2], s.phases[3]);
    ubo.updateFloat4(PHASE_UNIFORMS[1], s.phases[4], s.phases[5], s.phases[6], s.phases[7]);
    ubo.updateFloat4("mycoWaterA", s.count, s.time, s.foamAmount, s.normalDetail);
    ubo.updateFloat4("mycoWaterB", s.maxHeight, 0, 0, 0);
    ubo.updateFloat4("mycoDeep", s.deep[0], s.deep[1], s.deep[2], 1);
    ubo.updateFloat4("mycoShallow", s.shallow[0], s.shallow[1], s.shallow[2], 1);
    ubo.updateFloat4("mycoFoam", s.foam[0], s.foam[1], s.foam[2], 1);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    return shaderLanguage === ShaderLanguage.WGSL || shaderLanguage === ShaderLanguage.GLSL ? waterCustomCode(shaderType, shaderLanguage) : null;
  }
}

interface WaterEntry {
  mesh: Mesh;
  material: PBRMaterial;
  state: WaterState;
  /** The size and vertex count the geometry was built for. */
  built: { size: number; resolution: number };
  probe: BaseTexture | null;
}

/** The vertices per side a surface is drawn with on the active tier ("low" shader level: half). */
export function babylonWaterResolution(resolution: number, shaderLevel: string): number {
  const r = Number.isFinite(resolution) ? resolution : 128;
  const scaled = shaderLevel === "low" ? r * 0.5 : r;
  return Math.max(2, Math.min(1024, Math.round(scaled)));
}

/** A flat grid of `size`, `resolution` vertices per side, in the XZ plane facing +Y (counter-clockwise from above). */
export function waterGridData(size: number, resolution: number): VertexData {
  const n = resolution;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = j * n + i;
      positions[v * 3] = (i / (n - 1) - 0.5) * size;
      positions[v * 3 + 2] = (j / (n - 1) - 0.5) * size;
      normals[v * 3 + 1] = 1;
      uvs[v * 2] = i / (n - 1);
      uvs[v * 2 + 1] = j / (n - 1);
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = (j + 1) * n + i, c = (j + 1) * n + i + 1, d = j * n + i + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = d;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  return data;
}

const IDENTITY = Matrix.Identity();

export class BabylonWater {
  private readonly entries = new Map<WaterSurface, WaterEntry>();

  constructor(
    private readonly scene: Scene,
    private readonly probeAt: BabylonWaterProbe = () => null,
  ) {}

  /** Bring every surface's mesh up to date for this frame. */
  sync(world: World, surfaces: readonly WaterSurface[]): void {
    const seen = new Set<WaterSurface>();
    const time = waterTime(world);
    const level = Graphics.tier.shaderLevel;
    for (const w of surfaces) {
      seen.add(w);
      const entry = this.entry(w);
      const resolution = babylonWaterResolution(w.resolution, level);
      const size = Math.max(Math.abs(w.size), 1e-3);
      if (entry.built.size !== size || entry.built.resolution !== resolution) {
        entry.mesh.dispose(false, false);
        entry.mesh = this.makeMesh(entry.material, size, resolution);
        entry.built = { size, resolution };
      }
      const mesh = entry.mesh;
      const visible = w.isActiveAndEnabled;
      mesh.setEnabled(visible);
      if (!visible) continue;
      const e = w.node.entity;
      mesh.freezeWorldMatrix(w.node.transform ? Matrix.FromArray(world.worldMatrix(e) as unknown as number[], e * 16) : IDENTITY);
      this.applyState(w, entry, time);
      this.applyMaterial(w, entry);
    }
    for (const w of [...this.entries.keys()]) if (!seen.has(w)) this.release(w);
  }

  private entry(w: WaterSurface): WaterEntry {
    let entry = this.entries.get(w);
    if (!entry) {
      const state = createState();
      const material = new PBRMaterial("myco-water", this.scene);
      material.sideOrientation = Material.CounterClockWiseSideOrientation;
      material.maxSimultaneousLights = 8;
      useEngineLightFalloff(material);
      material.albedoColor.set(1, 1, 1);
      material.metallic = 0;
      material.roughness = 0.08;
      new MycoWaterPlugin(material, state);
      entry = { mesh: this.makeMesh(material, 1, 2), material, state, built: { size: -1, resolution: -1 }, probe: null };
      this.entries.set(w, entry);
    }
    return entry;
  }

  private makeMesh(material: PBRMaterial, size: number, resolution: number): Mesh {
    const mesh = new Mesh("myco-water", this.scene);
    waterGridData(size, resolution).applyToMesh(mesh);
    mesh.material = material;
    // Displaced vertices leave the flat grid's bounds; the grid is usually on screen anyway.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    return mesh;
  }

  private applyState(w: WaterSurface, entry: WaterEntry, time: number): void {
    const packed = w._pack(time);
    const s = entry.state;
    for (let i = 0; i < MAX_WAVES; i++) {
      const o = i * 5;
      s.waves[i * 4] = packed.data[o];
      s.waves[i * 4 + 1] = packed.data[o + 1];
      s.waves[i * 4 + 2] = packed.data[o + 2];
      s.waves[i * 4 + 3] = packed.data[o + 3];
      s.phases[i] = packed.data[o + 4];
    }
    s.count = packed.count;
    s.time = time % 10000;
    s.deep = linearRgb(w.deepColor);
    s.shallow = linearRgb(w.shallowColor);
    s.foam = linearRgb(w.foamColor);
    s.foamAmount = clamp01(w.foamAmount);
    s.normalDetail = Math.max(0, w.normalDetail);
    s.maxHeight = maxAmplitude(packed);
  }

  private applyMaterial(w: WaterSurface, entry: WaterEntry): void {
    const m = entry.material;
    m.roughness = clamp01(w.roughness);
    // three's `reflectivity` is a remap of the index of refraction.
    const r = clamp01(w.reflectivity);
    m.indexOfRefraction = (1 + 0.4 * r) / (1 - 0.4 * r);
    const opacity = clamp01(w.opacity);
    m.alpha = opacity;
    const mode = opacity < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
    if (m.transparencyMode !== mode) m.transparencyMode = mode;
    // A reflection probe whose box holds the surface's centre (ADR 0054).
    const p = entry.mesh.getAbsolutePosition();
    const probe = this.probeAt(p.x, p.y, p.z);
    const tex = probe?.texture ?? null;
    if (entry.probe !== tex) {
      m.reflectionTexture = tex;
      entry.probe = tex;
    }
    m.environmentIntensity = probe ? probe.intensity : 1;
  }

  /** The drawn surfaces (tests, diagnostics). */
  state(): { surfaces: number } {
    return { surfaces: this.entries.size };
  }

  /** @internal Tests: the drawn meshes. */
  meshes(): Mesh[] {
    return [...this.entries.values()].map((e) => e.mesh);
  }

  release(w: WaterSurface): void {
    const e = this.entries.get(w);
    if (!e) return;
    e.mesh.dispose(false, false);
    e.material.dispose();
    this.entries.delete(w);
  }

  dispose(): void {
    for (const w of [...this.entries.keys()]) this.release(w);
  }
}

function linearRgb(c: { r: number; g: number; b: number }): [number, number, number] {
  const l = new Color3(c.r, c.g, c.b).toLinearSpace();
  return [l.r, l.g, l.b];
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}
