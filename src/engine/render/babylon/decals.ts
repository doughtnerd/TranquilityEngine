/**
 * Decal volumes on Babylon (ADR 0395): the backend half of `DecalHost`.
 *
 * Each batch is one unit box (-0.5..0.5) drawn as thin instances, one per decal, with a material carrying
 * `MycoDecalPlugin`. The box draws its back faces in the render pass, after the opaque meshes (`placeDecal`'s band,
 * ADR 0186), with depth test off and no depth write, so it works with the camera inside it and the geometry pass never
 * draws it (Babylon's geometry pass skips materials that don't write depth). In the fragment shader the plugin reads
 * the scene depth (ADR 0109) where the box covers the screen, rebuilds the world position of the surface behind it,
 * moves it into the decal's box, discards it outside the box or where nothing was drawn, and hands Babylon's PBR shader
 * that surface's position, a normal from the position's screen derivatives and the decal's UV in place of the box's
 * own varyings. So the scene's lights, image-based lighting, fog and height fog shade the decal where it lands, and a
 * shader graph's nodes see the surface's UV.
 *
 * Shadow maps are not applied (Babylon works their coordinates out per vertex, from the box): the decal mesh doesn't
 * receive shadows. While a camera has no scene depth yet the material binds a 1×1 stand-in and discards everything,
 * so it is always ready and never holds a World's first frames. `multiply` and `additive` decals are unlit: multiply darkens what is lit there, additive adds light.
 *
 * Materials: the built-in decal material (lit, rough, the texture's colour and alpha) per (texture, blend), or one copy
 * of a material asset or shader graph per (asset, blend) from the material library (ADR 0127), never the asset.
 */
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js"; // Mesh.thinInstance*
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { DecalBatch, DecalBlend, DecalHost, DecalLook } from "../decals";
import { requestSceneDepth, sceneDepth } from "./frameGraph";
import { placeDecal } from "./layeredQuads";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import { pbr } from "./materials";
import { MycoMaterialPlugin } from "./mycoMaterialPlugin";

/** The per-instance attributes beside Babylon's `matrix` and `instanceColor`: the box's inverse (rows 0..2), UV scale and offset, angle fade. */
const ATTR = { r0: "mycoDecalR0", r1: "mycoDecalR1", r2: "mycoDecalR2", uv: "mycoDecalUv", ang: "mycoDecalAng" } as const;

class DecalDefines extends MaterialDefines {
  MYCO_DECAL = true;
  MYCO_DECAL_MULTIPLY = false;
}

/** GLSL: a varying's declaration isn't a read (`varying vec3 vPositionW;`), nor is a `#define`'s name. */
const notDeclared = (type: string): string => `(?<!(?:varying|in)\\s+(?:(?:highp|mediump|lowp)\\s+)?${type}\\s+)(?<!#define\\s+)`;

/** The UV varyings Babylon's PBR fragment shader samples textures with: the main UV, and each texture's own (`vAlbedoUV`…). */
const UV_NAMES = "(?:vMainUV1|v[A-Z][A-Za-z0-9]*UV)";

/**
 * The decal's shader code for Babylon's PBR shaders (see the file comment). Vertex: the box's world position and the
 * instance's inverse, UV and angle fade go to the fragment shader. Fragment: the surface is rebuilt at the start of
 * `main`, and every read of the box's position, normal and UV varyings reads the surface's instead.
 */
export function decalCode(shaderType: string, language: ShaderLanguage): { [point: string]: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  if (shaderType === "vertex") {
    return wgsl
      ? {
          CUSTOM_VERTEX_DEFINITIONS: [
            `attribute ${ATTR.r0}: vec4f;`, `attribute ${ATTR.r1}: vec4f;`, `attribute ${ATTR.r2}: vec4f;`, `attribute ${ATTR.uv}: vec4f;`, `attribute ${ATTR.ang}: vec4f;`,
            "varying vMycoBox: vec3f;", "varying vMycoR0: vec4f;", "varying vMycoR1: vec4f;", "varying vMycoR2: vec4f;", "varying vMycoUvT: vec4f;", "varying vMycoAng: vec4f;",
          ].join("\n"),
          CUSTOM_VERTEX_MAIN_END: [
            "vertexOutputs.vMycoBox = worldPos.xyz;",
            `vertexOutputs.vMycoR0 = vertexInputs.${ATTR.r0};`, `vertexOutputs.vMycoR1 = vertexInputs.${ATTR.r1};`, `vertexOutputs.vMycoR2 = vertexInputs.${ATTR.r2};`,
            `vertexOutputs.vMycoUvT = vertexInputs.${ATTR.uv};`, `vertexOutputs.vMycoAng = vertexInputs.${ATTR.ang};`,
          ].join("\n"),
        }
      : {
          CUSTOM_VERTEX_DEFINITIONS: [
            `attribute vec4 ${ATTR.r0};`, `attribute vec4 ${ATTR.r1};`, `attribute vec4 ${ATTR.r2};`, `attribute vec4 ${ATTR.uv};`, `attribute vec4 ${ATTR.ang};`,
            "varying vec3 vMycoBox;", "varying vec4 vMycoR0;", "varying vec4 vMycoR1;", "varying vec4 vMycoR2;", "varying vec4 vMycoUvT;", "varying vec4 vMycoAng;",
          ].join("\n"),
          CUSTOM_VERTEX_MAIN_END: [
            "vMycoBox = worldPos.xyz;",
            `vMycoR0 = ${ATTR.r0};`, `vMycoR1 = ${ATTR.r1};`, `vMycoR2 = ${ATTR.r2};`, `vMycoUvT = ${ATTR.uv};`, `vMycoAng = ${ATTR.ang};`,
          ].join("\n"),
        };
  }
  // Multiply: towards white as the decal fades (Babylon's multiply blend ignores alpha); else alpha fades.
  const fade = (v4: string, v3: string): string =>
    ["#ifdef MYCO_DECAL_MULTIPLY", `finalColor = ${v4}(mix(${v3}(1.0), finalColor.rgb, clamp(finalColor.a * mycoDecalFade, 0.0, 1.0)), 1.0);`, "#else", `finalColor = ${v4}(finalColor.rgb, finalColor.a * mycoDecalFade);`, "#endif"].join("\n");
  if (wgsl) {
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: [
        "varying vMycoBox: vec3f;", "varying vMycoR0: vec4f;", "varying vMycoR1: vec4f;", "varying vMycoR2: vec4f;", "varying vMycoUvT: vec4f;", "varying vMycoAng: vec4f;",
        "var mycoDecalDepth: texture_2d<f32>;",
        "var mycoDecalDepthSampler: sampler;",
        "var<private> mycoDecalPos: vec3f;",
        "var<private> mycoDecalNormal: vec3f = vec3f(0.0, 0.0, 1.0);",
        "var<private> mycoDecalUV: vec2f;",
        "var<private> mycoDecalFade: f32 = 1.0;",
      ].join("\n"),
      CUSTOM_FRAGMENT_MAIN_BEGIN: `{
  let mycoDims = vec2f(textureDimensions(mycoDecalDepth));
  let mycoPx = vec2i(clamp(fragmentInputs.position.xy, vec2f(0.0), mycoDims - 1.0));
  let mycoD = abs(textureLoad(mycoDecalDepth, mycoPx, 0).r);
  let mycoPv = (scene.view * vec4f(fragmentInputs.vMycoBox, 1.0)).xyz;
  var mycoSv = mycoPv * (mycoD / max(abs(mycoPv.z), 1e-6));
  if (scene.projection[3][3] > 0.5) { mycoSv = vec3f(mycoPv.xy, sign(mycoPv.z) * mycoD); }
  let mycoW = (uniforms.mycoDecalInvView * vec4f(mycoSv, 1.0)).xyz;
  var mycoN = cross(dpdx(mycoW), dpdy(mycoW));
  mycoN = mycoN / max(length(mycoN), 1e-12);
  if (dot(mycoN, scene.vEyePosition.xyz - mycoW) < 0.0) { mycoN = -mycoN; }
  let mycoP4 = vec4f(mycoW, 1.0);
  let mycoL = vec3f(dot(fragmentInputs.vMycoR0, mycoP4), dot(fragmentInputs.vMycoR1, mycoP4), dot(fragmentInputs.vMycoR2, mycoP4));
  let mycoFacing = dot(mycoN, -normalize(fragmentInputs.vMycoR2.xyz));
  mycoDecalFade = smoothstep(fragmentInputs.vMycoAng.y, fragmentInputs.vMycoAng.x, mycoFacing);
  if (uniforms.mycoDecal.x < 0.5 || mycoD == 0.0 || any(abs(mycoL) > vec3f(0.5)) || mycoDecalFade <= 0.0) { discard; }
  mycoDecalPos = mycoW;
  mycoDecalNormal = mycoN;
  mycoDecalUV = (mycoL.xy + vec2f(0.5)) * fragmentInputs.vMycoUvT.xy + fragmentInputs.vMycoUvT.zw;
}`,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: fade("vec4f", "vec3f"),
      "!fragmentInputs\\.vPositionW\\b": "mycoDecalPos",
      "!fragmentInputs\\.vNormalW\\b": "mycoDecalNormal",
      [`!fragmentInputs\\.${UV_NAMES}\\b`]: "mycoDecalUV",
    };
  }
  return {
    // Before `precision highp float`, so with explicit precision; before every function that may read them.
    CUSTOM_FRAGMENT_BEGIN: "highp vec3 mycoDecalPos;\nhighp vec3 mycoDecalNormal;\nhighp vec2 mycoDecalUV;\nhighp float mycoDecalFade;",
    CUSTOM_FRAGMENT_DEFINITIONS: [
      "varying vec3 vMycoBox;", "varying vec4 vMycoR0;", "varying vec4 vMycoR1;", "varying vec4 vMycoR2;", "varying vec4 vMycoUvT;", "varying vec4 vMycoAng;",
      "uniform sampler2D mycoDecalDepth;",
    ].join("\n"),
    CUSTOM_FRAGMENT_MAIN_BEGIN: `{
  mycoDecalFade = 1.0;
  float mycoD = abs(texture2D(mycoDecalDepth, gl_FragCoord.xy / mycoDecal.yz).r);
  vec3 mycoPv = (view * vec4(vMycoBox, 1.0)).xyz;
  vec3 mycoSv = mycoPv * (mycoD / max(abs(mycoPv.z), 1e-6));
  if (projection[3][3] > 0.5) { mycoSv = vec3(mycoPv.xy, sign(mycoPv.z) * mycoD); }
  vec3 mycoW = (mycoDecalInvView * vec4(mycoSv, 1.0)).xyz;
  vec3 mycoN = cross(dFdx(mycoW), dFdy(mycoW));
  mycoN = mycoN / max(length(mycoN), 1e-12);
  if (dot(mycoN, vEyePosition.xyz - mycoW) < 0.0) { mycoN = -mycoN; }
  vec4 mycoP4 = vec4(mycoW, 1.0);
  vec3 mycoL = vec3(dot(vMycoR0, mycoP4), dot(vMycoR1, mycoP4), dot(vMycoR2, mycoP4));
  float mycoFacing = dot(mycoN, -normalize(vMycoR2.xyz));
  mycoDecalFade = smoothstep(vMycoAng.y, vMycoAng.x, mycoFacing);
  if (mycoDecal.x < 0.5 || mycoD == 0.0 || any(greaterThan(abs(mycoL), vec3(0.5))) || mycoDecalFade <= 0.0) { discard; }
  mycoDecalPos = mycoW;
  mycoDecalNormal = mycoN;
  mycoDecalUV = (mycoL.xy + vec2(0.5)) * vMycoUvT.xy + vMycoUvT.zw;
}`,
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: fade("vec4", "vec3"),
    [`!${notDeclared("vec3")}\\bvPositionW\\b`]: "mycoDecalPos",
    [`!${notDeclared("vec3")}\\bvNormalW\\b`]: "mycoDecalNormal",
    [`!${notDeclared("vec2")}\\b${UV_NAMES}\\b`]: "mycoDecalUV",
  };
}

/** @internal A decal on one (unshared) PBR material (see the file comment). */
export class MycoDecalPlugin extends MycoMaterialPlugin {
  private readonly invView = new Matrix();

  constructor(
    material: Material,
    private readonly blend: DecalBlend,
    /**
     * What the depth sampler binds while the camera drawing has no scene depth yet (its first frames, a graph
     * rebuild): the plugin then discards every fragment. Always ready, so a decal never holds a World's first frames
     * (ADR 0120) waiting for the depth those frames make.
     */
    private readonly fallback: (() => BaseTexture | null) | null = null,
  ) {
    super(material, "MycoDecal", 240, new DecalDefines());
    this.register();
  }

  override getClassName(): string {
    return "MycoDecalPlugin";
  }

  override prepareDefines(defines: DecalDefines): void {
    defines.MYCO_DECAL = true;
    defines.MYCO_DECAL_MULTIPLY = this.blend === "multiply";
  }

  override getAttributes(attributes: string[]): void {
    attributes.push(ATTR.r0, ATTR.r1, ATTR.r2, ATTR.uv, ATTR.ang);
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("mycoDecalDepth");
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return { ubo: [{ name: "mycoDecal", size: 4, type: "vec4" }, { name: "mycoDecalInvView", size: 16, type: "mat4" }], fragment: "" };
  }

  override bindForSubMesh(ubo: UniformBuffer, scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const camera = scene.activeCamera;
    const depth = camera ? sceneDepth(scene, camera as TargetCamera) : null;
    if (!camera || !depth) {
      ubo.updateFloat4("mycoDecal", 0, 1, 1, 0); // discard everything this frame
      const stand = this.fallback?.();
      if (stand) ubo.setTexture("mycoDecalDepth", stand);
      return;
    }
    camera.getViewMatrix().invertToRef(this.invView);
    ubo.updateFloat4("mycoDecal", 1, depth.width, depth.height, 0);
    ubo.updateMatrix("mycoDecalInvView", this.invView);
    ubo.setTexture("mycoDecalDepth", depth.texture);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    return decalCode(shaderType, shaderLanguage ?? ShaderLanguage.GLSL);
  }
}

/** Set a decal material's draw state: back faces, no depth test or write, blended by `blend` (unlit unless `alpha`). */
export function asDecalMaterial(m: Material, blend: DecalBlend, fallback: (() => BaseTexture | null) | null = null): void {
  m.backFaceCulling = true;
  m.cullBackFaces = false; // the box's back faces: it draws with the camera inside it too
  m.disableDepthWrite = true; // also keeps it out of the geometry pass (it skips materials that don't write depth)
  m.depthFunction = Constants.ALWAYS;
  m.alphaMode = blend === "multiply" ? Constants.ALPHA_MULTIPLY : blend === "additive" ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE;
  if (m instanceof PBRMaterial) {
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    if (blend !== "alpha") m.unlit = true;
  }
  new MycoDecalPlugin(m, blend, fallback);
}

/** What the decals borrow from the renderer. */
export interface BabylonDecalDeps {
  readonly scene: Scene;
  readonly materials: BabylonMaterialLibrary;
  warnOnce(key: string, message: string): void;
}

interface SharedLook {
  material: Material | null;
  dispose: (() => void) | null;
  ready: boolean;
  users: number;
}

/** @internal */
export class BabylonDecals implements DecalHost {
  private readonly looks = new Map<string, SharedLook>();
  private readonly batches = new Set<BabylonDecalBatch>();
  /** While any batch has decals, every camera keeps a depth pass (ADR 0109); this releases it. */
  private releaseDepth: (() => void) | null = null;
  /** A 1×1 texture the decal materials bind while a camera has no scene depth yet (made on first use). */
  private standIn: BaseTexture | null = null;
  private readonly fallback = (): BaseTexture => (this.standIn ??= RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, this.deps.scene, false));

  constructor(private readonly deps: BabylonDecalDeps) {}

  createBatch(name: string, look: DecalLook): DecalBatch {
    const b = new BabylonDecalBatch(this, name, look);
    this.batches.add(b);
    return b;
  }

  /** @internal */
  get scene(): Scene {
    return this.deps.scene;
  }

  /** @internal Keep the scene depth on while any batch draws decals. */
  updateDepth(): void {
    let any = false;
    for (const b of this.batches) if (b.count > 0) any = true;
    if (any && !this.releaseDepth) this.releaseDepth = requestSceneDepth(this.deps.scene, this);
    else if (!any && this.releaseDepth) {
      this.releaseDepth();
      this.releaseDepth = null;
    }
  }

  /** @internal The shared material for `look`, made (or retried, while its asset loads) now. */
  acquire(look: DecalLook): { key: string; look: SharedLook } {
    const key = `${look.material}|${look.texture}|${look.blend}`;
    let shared = this.looks.get(key);
    if (!shared) {
      shared = { material: null, dispose: null, ready: false, users: 0 };
      this.looks.set(key, shared);
    }
    shared.users++;
    this.build(shared, look);
    return { key, look: shared };
  }

  /** Build a look's material if it isn't yet. */
  build(shared: SharedLook, look: DecalLook): void {
    if (shared.material) return;
    if (look.material) {
      const copy = this.deps.materials.copy(look.material, `decal:${look.material}:${look.blend}`);
      if (!copy) {
        if (!this.deps.materials.loading()) this.deps.warnOnce(`decal-material|${look.material}`, `decal material "${look.material}" couldn't be loaded; the decal doesn't draw.`);
        return;
      }
      asDecalMaterial(copy.material, look.blend, this.fallback);
      shared.material = copy.material;
      shared.dispose = () => copy.dispose();
      shared.ready = true;
      return;
    }
    const m = pbr(`decal:${look.texture || "plain"}:${look.blend}`, this.deps.scene);
    m.metallic = 0;
    m.roughness = 1;
    m.useAlphaFromAlbedoTexture = true;
    asDecalMaterial(m, look.blend, this.fallback);
    shared.material = m;
    let gone = false;
    shared.dispose = () => {
      gone = true;
      m.dispose(false, false);
    };
    shared.ready = !look.texture;
    if (look.texture) {
      const apply = (t: Texture | null): void => {
        if (!t || gone) return;
        t.hasAlpha = true;
        m.albedoTexture = t;
        shared.ready = true;
      };
      apply(this.deps.materials.texture(look.texture, "color", apply));
    }
  }

  /** @internal */
  release(key: string): void {
    const shared = this.looks.get(key);
    if (!shared || --shared.users > 0) return;
    shared.dispose?.();
    this.looks.delete(key);
  }

  /** @internal */
  forget(b: BabylonDecalBatch): void {
    this.batches.delete(b);
    this.updateDepth();
  }

  dispose(): void {
    for (const b of [...this.batches]) b.dispose();
    for (const s of this.looks.values()) s.dispose?.();
    this.looks.clear();
    this.releaseDepth?.();
    this.releaseDepth = null;
    this.standIn?.dispose();
    this.standIn = null;
  }
}

class BabylonDecalBatch implements DecalBatch {
  private mesh: Mesh | null = null;
  private readonly key: string;
  private readonly shared: SharedLook;
  private capacity = 0;
  count = 0;
  private buffers: { matrix: Float32Array; color: Float32Array; r0: Float32Array; r1: Float32Array; r2: Float32Array; uv: Float32Array; ang: Float32Array } | null = null;
  private order = 0;
  private visible = false;
  private disposed = false;

  constructor(
    private readonly owner: BabylonDecals,
    private readonly name: string,
    private readonly look: DecalLook,
  ) {
    const { key, look: shared } = owner.acquire(look);
    this.key = key;
    this.shared = shared;
  }

  setInstances(count: number, matrices: Float32Array, colors: Float32Array, uvs: Float32Array, angles: Float32Array): void {
    if (this.disposed) return;
    this.count = count;
    if (count > 0 && !this.mesh) {
      const mesh = CreateBox(`decals:${this.name}`, { size: 1 }, this.owner.scene);
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      mesh.alwaysSelectAsActiveMesh = true; // thin instances anywhere: no box culling
      placeDecal(mesh, this.order);
      mesh.setEnabled(this.visible);
      this.mesh = mesh;
    }
    const mesh = this.mesh;
    if (mesh) {
      if (count > this.capacity) {
        this.capacity = Math.max(8, count * 2);
        const n = this.capacity;
        this.buffers = { matrix: new Float32Array(n * 16), color: new Float32Array(n * 4), r0: new Float32Array(n * 4), r1: new Float32Array(n * 4), r2: new Float32Array(n * 4), uv: new Float32Array(n * 4), ang: new Float32Array(n * 4) };
        const b = this.buffers;
        mesh.thinInstanceSetBuffer("matrix", b.matrix, 16, false);
        mesh.thinInstanceSetBuffer("instanceColor", b.color, 4, false);
        mesh.thinInstanceSetBuffer(ATTR.r0, b.r0, 4, false);
        mesh.thinInstanceSetBuffer(ATTR.r1, b.r1, 4, false);
        mesh.thinInstanceSetBuffer(ATTR.r2, b.r2, 4, false);
        mesh.thinInstanceSetBuffer(ATTR.uv, b.uv, 4, false);
        mesh.thinInstanceSetBuffer(ATTR.ang, b.ang, 4, false);
      }
      const b = this.buffers!;
      for (let i = 0; i < count; i++) {
        b.matrix.set(matrices.subarray(i * 16, i * 16 + 16), i * 16);
        Matrix.FromArrayToRef(matrices as unknown as number[], i * 16, tmp);
        tmp.invertToRef(inv);
        // Babylon's matrices are row-vector (p' = p · M), so the column-vector rows of the inverse are its columns.
        const m = inv.m;
        b.r0.set([m[0]!, m[4]!, m[8]!, m[12]!], i * 4);
        b.r1.set([m[1]!, m[5]!, m[9]!, m[13]!], i * 4);
        b.r2.set([m[2]!, m[6]!, m[10]!, m[14]!], i * 4);
        b.color[i * 4] = Math.pow(colors[i * 4]!, 2.2);
        b.color[i * 4 + 1] = Math.pow(colors[i * 4 + 1]!, 2.2);
        b.color[i * 4 + 2] = Math.pow(colors[i * 4 + 2]!, 2.2);
        b.color[i * 4 + 3] = colors[i * 4 + 3]!;
        b.uv.set(uvs.subarray(i * 4, i * 4 + 4), i * 4);
        const start = angles[i * 2]!, end = Math.min(angles[i * 2 + 1]!, start - 1e-4);
        b.ang.set([start, end, 0, 0], i * 4);
      }
      mesh.thinInstanceCount = count;
      for (const kind of ["matrix", "instanceColor", ATTR.r0, ATTR.r1, ATTR.r2, ATTR.uv, ATTR.ang]) mesh.thinInstanceBufferUpdated(kind);
      this.owner.build(this.shared, this.look);
      if (this.shared.material && mesh.material !== this.shared.material) mesh.material = this.shared.material;
      mesh.setEnabled(this.visible && count > 0 && !!this.shared.material);
    }
    this.owner.updateDepth();
  }

  setOrder(order: number): void {
    this.order = order;
    if (this.mesh) placeDecal(this.mesh, order);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh?.setEnabled(visible && this.count > 0 && !!this.shared.material);
  }

  loaded(): boolean {
    return this.shared.ready && !!this.shared.material;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh?.dispose(false, false);
    this.mesh = null;
    this.count = 0;
    this.owner.release(this.key);
    this.owner.forget(this);
  }
}

const tmp = new Matrix();
const inv = new Matrix();
