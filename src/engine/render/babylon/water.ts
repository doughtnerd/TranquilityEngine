/**
 * Water surfaces on the Babylon backend (ADR 0072, 0075 stage 6). The counterpart of
 * `WaterRenderer`: one grid mesh and one PBR material per `WaterSurface`, updated each frame from
 * the component and the water clock. A material plugin splices the Gerstner wave sum
 * (`gerstner.ts`'s `GERSTNER_SHADER`) into Babylon's PBR vertex shader and the water colouring into
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
 * Wakes (ADR 0459): `wakes.ts` packs the World's `WaterWake`s once a frame, as trails or as a
 * simulated height field around the view camera's focus on the water; two float textures carry them
 * (`mycoWakeTrail`, `mycoWakeField`) and `WAKE_SHADER` reads them: the slope bends the normal after the
 * ripples, the foam joins the crest foam, its height lightens crests as the waves' own does, and in
 * "field" mode the vertex rises by the field's height.
 *
 * Waves are packed into vec4 uniforms (UBO arrays are avoided, `waveUniforms`): `mycoWave0..7` hold
 * (direction x, direction z, wave number, amplitude) per wave and `mycoPhase0/1` the eight phases
 * (the fifth float of `WAVE_STRIDE`). The wave sum, the ripple noise and the colouring maths are KSL
 * (ADR 0250), compiled to WGSL for WebGPU and GLSL for the WebGL2 fallback; only the injection glue is
 * written per language. (Without the GLSL the fallback drew a flat plane at rest height while ships
 * rode the sampled waves, so troughs hid their hulls.)
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../core/World";
import { Graphics } from "../Graphics";
import { shaderSource, type ShaderDialect } from "../shaderSource/shaderSource";
import { GERSTNER_SHADER, PHASE_UNIFORMS, WAVE_UNIFORMS, maxAmplitude, waveUniforms } from "../water/gerstner";
import { waterTime, type WaterSurface } from "../water/WaterSurface";
import { WAKE_SHADER, WAKE_TEXTURES, wakeModeNumber } from "../water/wakeShader";
import { MAX_WAKES, TRAIL_TEXELS, updateWakes, type WakeFrame, type WaterWakeMode } from "../water/wakes";
import { useEngineLightFalloff } from "./materials";
import { MycoMaterialPlugin } from "./mycoMaterialPlugin";
import { pbrInjections } from "./pbrInjection";

/** A reflection probe's map and strength (ADR 0054), or null for the scene's environment only. */
export type BabylonWaterProbe = (x: number, y: number, z: number) => { texture: BaseTexture; intensity: number } | null;

/** The values a water material's plugin binds, refreshed by `sync` each frame. */
interface WaterState {
  /** The wave uniforms (`waveUniforms`). */
  waves: Record<string, number[]>;
  count: number;
  time: number;
  deep: [number, number, number];
  shallow: [number, number, number];
  foam: [number, number, number];
  foamAmount: number;
  normalDetail: number;
  maxHeight: number;
  /** `mycoWake` and `mycoWakeArea` (`wakeShader.ts`), and the wake textures bound this frame. */
  wake: [number, number, number, number];
  wakeArea: [number, number, number, number];
  wakeTrail: BaseTexture | null;
  wakeField: BaseTexture | null;
}

function createState(): WaterState {
  return { waves: {}, count: 0, time: 0, deep: [0, 0, 0], shallow: [0, 0, 0], foam: [0, 0, 0], foamAmount: 0, normalDetail: 0, maxHeight: 0, wake: [0, 0, 0, 0], wakeArea: [0, 0, 1, 1], wakeTrail: null, wakeField: null };
}


/** The plugin's uniform buffer entries (all vec4). */
function waterUniformBuffer(): { name: string; size: number; type: string }[] {
  const names = [...WAVE_UNIFORMS, ...PHASE_UNIFORMS, "mycoWaterA", "mycoWaterB", "mycoDeep", "mycoShallow", "mycoFoam", "mycoWake", "mycoWakeArea"];
  return names.map((name) => ({ name, size: 4, type: "vec4" }));
}

/**
 * The water's maths in KSL: the wave sum (with the water's uniforms), the ripple noise (value noise in x,
 * its gradient in yz), the ripples' slope, and the shallow and foam amounts.
 */
const WATER_SHADER = shaderSource(
  GERSTNER_SHADER,
  WAKE_SHADER,
  /* KSL */ `
UNIFORM(KV4, mycoWaterA);
UNIFORM(KV4, mycoWaterB);
FN(KF, mycoHash, KV2 p0) {
  VAR(KV2, p) = fract(p0 * KV2(123.34, 456.21));
  p = p + KV2(dot(p, p + KV2(45.32)));
  return fract(p.x * p.y);
}
FN(KV3, mycoNoise, KV2 p) {
  VAR(KV2, i) = floor(p);
  VAR(KV2, f) = fract(p);
  VAR(KV2, u) = f * f * (3.0 - 2.0 * f);
  VAR(KV2, du) = 6.0 * f * (1.0 - f);
  VAR(KF, a) = mycoHash(i);
  VAR(KF, b) = mycoHash(i + KV2(1.0, 0.0));
  VAR(KF, c) = mycoHash(i + KV2(0.0, 1.0));
  VAR(KF, d) = mycoHash(i + KV2(1.0, 1.0));
  VAR(KF, v) = a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  VAR(KV2, g) = du * KV2(b - a + (a - b - c + d) * u.y, c - a + (a - b - c + d) * u.x);
  return KV3(v, g);
}
FN(KM3, mycoWaves, KF px, KF pz) {
  return mycoGerstner(px, pz, KI(UNI(mycoWaterA).x + 0.5));
}
FN(KV3, mycoRipples, KV2 rest) {
  VAR(KF, t) = UNI(mycoWaterA).y;
  VAR(KV3, r1) = mycoNoise(rest * 0.35 + KV2(t * 0.11, t * 0.07));
  VAR(KV3, r2) = mycoNoise(rest * 0.9 + KV2(-t * 0.05, t * 0.13));
  VAR(KV2, slope) = (r1.yz * 0.35 + r2.yz * 0.9 * 0.5) * UNI(mycoWaterA).w * 0.25;
  return KV3(slope, r1.x);
}
FN(KV2, mycoShallowFoam, KV4 w, KF facing, KF r1x) {
  VAR(KF, maxH) = UNI(mycoWaterB).x;
  VAR(KF, crest) = select(0.5, clamp(w.z / max(maxH, 1e-6) * 0.5 + 0.5, 0.0, 1.0), maxH > 0.0);
  VAR(KF, shallow) = clamp(0.55 * crest + 0.45 * (1.0 - facing), 0.0, 1.0);
  // Foam where the surface is compressed (the Jacobian falls toward 0 where crests fold).
  VAR(KF, fold) = 1.0 - w.w + (r1x - 0.5) * 0.15;
  VAR(KF, amount) = clamp(UNI(mycoWaterA).z, 0.0, 1.0);
  VAR(KF, threshold) = 1.0 - amount;
  return KV2(shallow, select(0.0, smoothstep(threshold, threshold + 0.35, fold), amount > 0.0));
}
`,
);

/** The water's functions in `dialect` (its uniforms are the plugin's uniform buffer; its wake textures are the plugin's samplers, declared here). */
const waterFunctions = (dialect: ShaderDialect): string => WAKE_TEXTURES.text(dialect) + WATER_SHADER.text(dialect, { declarations: "omit" });

/**
 * Where the water's code goes in Babylon's PBR shaders, by injection point (the regular-expression
 * ones are `pbrInjection.ts`'s, ADR 0222). WGSL on WebGPU, GLSL on the WebGL2 fallback.
 */
function waterCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.WGSL): { [point: string]: string } {
  if (language === ShaderLanguage.GLSL) return waterCustomCodeGLSL(shaderType);
  if (shaderType === "vertex") {
    return {
      CUSTOM_VERTEX_DEFINITIONS: `${waterFunctions("wgsl")}\nvarying vMycoW: vec4f;\nvarying vMycoX: vec3f;`,
      // Before the world position's computation, so the displacement moves the vertex first.
      ...pbrInjections("wgsl", "vertex", { worldPosition: { before: [
        "let mycoG: mat3x3f = mycoWaves(positionUpdated.x, positionUpdated.z);",
        "let mycoRest: vec2f = positionUpdated.xz;",
        "#ifdef NORMAL",
        "normalUpdated = normalize(cross(mycoG[2], mycoG[1]));",
        "#endif",
        "positionUpdated = positionUpdated + mycoG[0];",
        "positionUpdated.y = positionUpdated.y + mycoWakeHeight((finalWorld * vec4f(positionUpdated, 1.0)).xz);",
      ].join("\n"), after: [
        "vertexOutputs.vMycoW = vec4f(mycoRest, mycoG[0].y, mycoG[1].x * mycoG[2].z - mycoG[1].z * mycoG[2].x);",
        "vertexOutputs.vMycoX = normalize((finalWorld * vec4f(1.0, 0.0, 0.0, 0.0)).xyz);",
      ].join("\n") } }),
    };
  }
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vMycoW: vec4f;\nvarying vMycoX: vec3f;\n${waterFunctions("wgsl")}`,
    // Ripples bend the normal (in world space; the node is level, so its Z axis is X cross up), then
    // the colour and foam are worked out from the bent normal. Before the albedo block, just after
    // the normal is final.
    ...pbrInjections("wgsl", "fragment", {
      albedoBlock: [
        "var mycoFoam: f32 = 0.0;",
        "var mycoShallow: f32 = 0.0;",
        "{",
        "  let ripples = mycoRipples(fragmentInputs.vMycoW.xy);",
        "  let axisX = normalize(fragmentInputs.vMycoX);",
        "  let axisZ = normalize(cross(axisX, vec3f(0.0, 1.0, 0.0)));",
        "  normalW = normalize(normalW - axisX * ripples.x - axisZ * ripples.y);",
        "  let wake = mycoWakeAt(fragmentInputs.vPositionW.xz);",
        "  normalW = normalize(normalW - vec3f(wake.x, 0.0, wake.y));",
        "  let view = normalize(scene.vEyePosition.xyz - fragmentInputs.vPositionW);",
        "  let amounts = mycoShallowFoam(fragmentInputs.vMycoW, clamp(dot(normalW, view), 0.0, 1.0), ripples.z);",
        "  mycoShallow = clamp(amounts.x + wake.w * 2.5, 0.0, 1.0);",
        "  mycoFoam = max(amounts.y, wake.z);",
        "}",
      ].join("\n"),
      // vReflectivityColor holds metallic, roughness, IOR and F0 in the metallic workflow.
      reflectivity: "vec4f(0.0, mix(uniforms.vReflectivityColor.y, 0.9, mycoFoam), uniforms.vReflectivityColor.zw)",
    }),
    CUSTOM_FRAGMENT_UPDATE_ALPHA: "surfaceAlbedo = mix(mix(uniforms.mycoDeep.rgb, uniforms.mycoShallow.rgb, mycoShallow), uniforms.mycoFoam.rgb, mycoFoam);",
  };
}

/** `waterCustomCode` for Babylon's GLSL PBR shaders (WebGL2): the same steps, in GLSL. */
function waterCustomCodeGLSL(shaderType: string): { [point: string]: string } {
  if (shaderType === "vertex") {
    return {
      CUSTOM_VERTEX_DEFINITIONS: `${waterFunctions("glsl")}\nvarying vec4 vMycoW;\nvarying vec3 vMycoX;`,
      ...pbrInjections("glsl", "vertex", { worldPosition: { before: [
        "mat3 mycoG = mycoWaves(positionUpdated.x, positionUpdated.z);",
        "vec2 mycoRest = positionUpdated.xz;",
        "#ifdef NORMAL",
        "normalUpdated = normalize(cross(mycoG[2], mycoG[1]));",
        "#endif",
        "positionUpdated = positionUpdated + mycoG[0];",
        "positionUpdated.y = positionUpdated.y + mycoWakeHeight((finalWorld * vec4(positionUpdated, 1.0)).xz);",
      ].join("\n"), after: [
        "vMycoW = vec4(mycoRest, mycoG[0].y, mycoG[1].x * mycoG[2].z - mycoG[1].z * mycoG[2].x);",
        "vMycoX = normalize((finalWorld * vec4(1.0, 0.0, 0.0, 0.0)).xyz);",
      ].join("\n") } }),
    };
  }
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: `varying vec4 vMycoW;\nvarying vec3 vMycoX;\n${waterFunctions("glsl")}`,
    ...pbrInjections("glsl", "fragment", {
      albedoBlock: [
        "float mycoFoamK = 0.0;",
        "float mycoShallowK = 0.0;",
        "{",
        "  vec3 ripples = mycoRipples(vMycoW.xy);",
        "  vec3 axisX = normalize(vMycoX);",
        "  vec3 axisZ = normalize(cross(axisX, vec3(0.0, 1.0, 0.0)));",
        "  normalW = normalize(normalW - axisX * ripples.x - axisZ * ripples.y);",
        "  vec4 wake = mycoWakeAt(vPositionW.xz);",
        "  normalW = normalize(normalW - vec3(wake.x, 0.0, wake.y));",
        "  vec3 view = normalize(vEyePosition.xyz - vPositionW);",
        "  vec2 amounts = mycoShallowFoam(vMycoW, clamp(dot(normalW, view), 0.0, 1.0), ripples.z);",
        "  mycoShallowK = clamp(amounts.x + wake.w * 2.5, 0.0, 1.0);",
        "  mycoFoamK = max(amounts.y, wake.z);",
        "}",
      ].join("\n"),
      reflectivity: "vec4(0.0, mix(vReflectivityColor.y, 0.9, mycoFoamK), vReflectivityColor.zw)",
    }),
    CUSTOM_FRAGMENT_UPDATE_ALPHA: "surfaceAlbedo = mix(mix(mycoDeep.rgb, mycoShallow.rgb, mycoShallowK), mycoFoam.rgb, mycoFoamK);",
  };
}

/** The material plugin carrying the water shader. */
class MycoWaterPlugin extends MycoMaterialPlugin {
  constructor(
    material: PBRMaterial,
    private readonly state: WaterState,
  ) {
    super(material, "MycoWater", 200, { MYCO_WATER: true });
    this.register();
  }

  override getClassName(): string {
    return "MycoWaterPlugin";
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[] } {
    return { ubo: waterUniformBuffer() };
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("mycoWakeTrail", "mycoWakeField");
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.state;
    for (const name of [...WAVE_UNIFORMS, ...PHASE_UNIFORMS]) {
      const v = s.waves[name] ?? [0, 0, 0, 0];
      ubo.updateFloat4(name, v[0], v[1], v[2], v[3]);
    }
    ubo.updateFloat4("mycoWaterA", s.count, s.time, s.foamAmount, s.normalDetail);
    ubo.updateFloat4("mycoWaterB", s.maxHeight, 0, 0, 0);
    ubo.updateFloat4("mycoDeep", s.deep[0], s.deep[1], s.deep[2], 1);
    ubo.updateFloat4("mycoShallow", s.shallow[0], s.shallow[1], s.shallow[2], 1);
    ubo.updateFloat4("mycoFoam", s.foam[0], s.foam[1], s.foam[2], 1);
    ubo.updateFloat4("mycoWake", s.wake[0], s.wake[1], s.wake[2], s.wake[3]);
    ubo.updateFloat4("mycoWakeArea", s.wakeArea[0], s.wakeArea[1], s.wakeArea[2], s.wakeArea[3]);
    if (s.wakeTrail) ubo.setTexture("mycoWakeTrail", s.wakeTrail);
    if (s.wakeField) ubo.setTexture("mycoWakeField", s.wakeField);
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
function babylonWaterResolution(resolution: number, shaderLevel: string): number {
  const r = Number.isFinite(resolution) ? resolution : 128;
  const scaled = shaderLevel === "low" ? r * 0.5 : r;
  return Math.max(2, Math.min(1024, Math.round(scaled)));
}

/** A flat grid of `size`, `resolution` vertices per side, in the XZ plane facing +Y (wound as Babylon's left-handed default: right-hand-rule normal -Y). */
function waterGridData(size: number, resolution: number): VertexData {
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
      indices[k++] = a; indices[k++] = d; indices[k++] = b;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
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
  /** The wake textures (ADR 0459): a 1×1 stand-in bound while a mode's texture isn't in use, and the uploaded version. */
  private wakeBlank: RawTexture | null = null;
  private wakeTrail: RawTexture | null = null;
  private wakeField: RawTexture | null = null;
  private wakeFieldResolution = 0;
  private wakeVersion = -1;

  constructor(
    private readonly scene: Scene,
    private readonly probeAt: BabylonWaterProbe = () => null,
  ) {}

  /**
   * Bring every surface's mesh up to date for this frame. `camera` is the view's: its focus on the
   * water picks which wakes are drawn and where the wake height field is centred.
   */
  sync(world: World, surfaces: readonly WaterSurface[], camera: TargetCamera | null = null): void {
    const seen = new Set<WaterSurface>();
    const time = waterTime(world);
    const level = Graphics.tier.shaderLevel;
    const first = surfaces.find((w) => w.isActiveAndEnabled);
    const wakes = first ? this.syncWakes(world, first, camera) : null;
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
      this.applyWakes(entry, wakes, time);
      this.applyMaterial(w, entry);
    }
    for (const w of [...this.entries.keys()]) if (!seen.has(w)) this.release(w);
  }

  /**
   * The World's wakes for this frame (ADR 0459), in the first surface's `wakeMode` (every surface draws
   * them that way), uploaded to the wake textures when they changed.
   */
  private syncWakes(world: World, surface: WaterSurface, camera: TargetCamera | null): WakeFrame {
    const mode: WaterWakeMode = surface.wakeMode === "field" || surface.wakeMode === "off" ? surface.wakeMode : "trail";
    const frame = updateWakes(world, mode, this.focus(camera, surface));
    if (frame.version === this.wakeVersion) return frame;
    this.wakeVersion = frame.version;
    if (frame.mode === "trail") {
      this.wakeTrail ??= RawTexture.CreateRGBATexture(new Float32Array(TRAIL_TEXELS * MAX_WAKES * 4), TRAIL_TEXELS, MAX_WAKES, this.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
      this.wakeTrail.update(frame.trail);
    } else if (frame.mode === "field" && frame.field) {
      const n = frame.fieldResolution;
      if (this.wakeFieldResolution !== n) {
        this.wakeField?.dispose();
        this.wakeField = RawTexture.CreateRGBATexture(new Float32Array(n * n * 4), n, n, this.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
        this.wakeFieldResolution = n;
      }
      this.wakeField!.update(frame.field);
    }
    return frame;
  }

  /** Where the camera looks on the water (its view ray meeting the surface's plane), else straight below it; null without a camera. */
  private focus(camera: TargetCamera | null, surface: WaterSurface): { x: number; z: number } | null {
    if (!camera) return null;
    const p = camera.globalPosition;
    const d = camera.getDirection(Vector3.Forward(this.scene.useRightHandedSystem));
    const y = surface.node.transform?.worldPosition.y ?? 0;
    const t = d.y < -0.05 ? (y - p.y) / d.y : -1;
    return t > 0 && t < 500 ? { x: p.x + d.x * t, z: p.z + d.z * t } : { x: p.x, z: p.z };
  }

  private applyWakes(entry: WaterEntry, frame: WakeFrame | null, time: number): void {
    const s = entry.state;
    const mode = frame ? wakeModeNumber(frame.mode) : 0;
    s.wake = [mode, frame?.trailCount ?? 0, time % 10000, 0];
    s.wakeArea = frame ? [frame.fieldOrigin[0], frame.fieldOrigin[1], frame.fieldSize, frame.fieldResolution] : [0, 0, 1, 1];
    this.wakeBlank ??= RawTexture.CreateRGBATexture(new Float32Array(4), 1, 1, this.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
    s.wakeTrail = mode === 1 && this.wakeTrail ? this.wakeTrail : this.wakeBlank;
    s.wakeField = mode === 2 && this.wakeField ? this.wakeField : this.wakeBlank;
    if (mode === 2 && !this.wakeField) s.wake[0] = 0;
  }

  private entry(w: WaterSurface): WaterEntry {
    let entry = this.entries.get(w);
    if (!entry) {
      const state = createState();
      const material = new PBRMaterial("myco-water", this.scene);
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
    waveUniforms(packed, s.waves);
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

  /** The surfaces drawn now (enabled) and their meshes (ADR 0276). */
  *drawn(): Iterable<{ surface: WaterSurface; mesh: Mesh }> {
    for (const [surface, e] of this.entries) if (e.mesh.isEnabled()) yield { surface, mesh: e.mesh };
  }

  /** The drawn surfaces (diagnostics). */
  state(): { surfaces: number } {
    return { surfaces: this.entries.size };
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
    for (const t of [this.wakeBlank, this.wakeTrail, this.wakeField]) t?.dispose();
    this.wakeBlank = this.wakeTrail = this.wakeField = null;
    this.wakeFieldResolution = 0;
    this.wakeVersion = -1;
  }
}

function linearRgb(c: { r: number; g: number; b: number }): [number, number, number] {
  const l = new Color3(c.r, c.g, c.b).toLinearSpace();
  return [l.r, l.g, l.b];
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}
