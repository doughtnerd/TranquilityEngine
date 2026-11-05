// Babylon.js renderer spike (not engine code). Checks, on WebGPU:
//  1. a custom material written as a complete plain-WGSL vertex + fragment pair (ShaderMaterial);
//  2. a custom full-screen post-process written in plain WGSL, inside a frame graph;
//  3. built-in quality features: shadow-mapped volumetric lighting, HDR bloom, PCF shadows.
// Open /spikes/babylon/ on the dev server (npm run dev).
// Module-by-module imports (ADR 0075), never the "@babylonjs/core" barrel. The non-.pure modules
// apply the side effects (class registration, shader stores) the scene needs.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";
// Engine methods (render targets, multi-render, queries…) are added by side-effect extension modules.
import "@babylonjs/core/Engines/WebGPU/Extensions/index.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph.js";
import { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList.js";
import { backbufferColorTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes.js";
import { FrameGraphLightingVolumeTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/lightingVolumeTask.js";
import { FrameGraphBloomTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask.js";
import { FrameGraphCustomPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/customPostProcessTask.js";
import { FrameGraphVolumetricLightingTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/volumetricLightingTask.js";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask.js";
import { FrameGraphShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/shadowGeneratorTask.js";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
// The lighting volume task imports the .pure module, which doesn't register its WGSL compute shader.
import "@babylonjs/core/Lights/lightingVolume.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import type { Effect } from "@babylonjs/core/Materials/effect.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import { CreateTorusKnot } from "@babylonjs/core/Meshes/Builders/torusKnotBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";

const $ = (id: string) => document.getElementById(id)!;
const checked = (id: string) => ($(id) as HTMLInputElement).checked;

// --- 1. Plain WGSL material ------------------------------------------------------------------------
// Babylon's WGSL dialect: `attribute`/`varying`/`uniform` declarations, and it adds @group/@binding.
const plasmaVertex = /* wgsl */ `
#include<sceneUboDeclaration>
#include<meshUboDeclaration>
attribute position: vec3f;
attribute normal: vec3f;
varying vPosW: vec3f;
varying vNormalW: vec3f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let worldPos = mesh.world * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.position = scene.viewProjection * worldPos;
  vertexOutputs.vPosW = worldPos.xyz;
  vertexOutputs.vNormalW = normalize((mesh.world * vec4f(vertexInputs.normal, 0.0)).xyz);
}`;

const plasmaFragment = /* wgsl */ `
#include<sceneUboDeclaration>
uniform time: f32;
varying vPosW: vec3f;
varying vNormalW: vec3f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let t = uniforms.time;
  let p = fragmentInputs.vPosW * 2.0;
  let v = sin(p.x + t) + sin(p.y * 1.3 + t * 1.7) + sin(p.z * 0.7 - t * 1.1);
  let c = 0.5 + 0.5 * cos(vec3f(0.0, 2.1, 4.2) + v * 1.5);
  let viewDir = normalize(scene.vEyePosition.xyz - fragmentInputs.vPosW);
  let fres = pow(1.0 - abs(dot(normalize(fragmentInputs.vNormalW), viewDir)), 3.0);
  fragmentOutputs.color = vec4f(c * 2.5 * (0.25 + fres), 1.0);
}`;

// --- 2. Plain WGSL post-process: ACES tone map, warm grade, vignette, grain, sRGB encode ---------------
// Post-process sources live in the WGSL shader store under "<name>PixelShader".
ShaderStore.ShadersStoreWGSL["spikeGradePixelShader"] = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform exposure: f32;
uniform strength: f32;
uniform time: f32;
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}
#define CUSTOM_FRAGMENT_DEFINITIONS
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let hdr = textureSample(textureSampler, textureSamplerSampler, input.vUV).rgb * uniforms.exposure;
  let vig = smoothstep(0.85, 0.35, distance(input.vUV, vec2f(0.5)));
  var graded = aces(hdr) * mix(1.0, vig, 0.6) * vec3f(1.04, 1.0, 0.94);
  graded += (hash(input.vUV * 1000.0 + uniforms.time) - 0.5) * 0.03;
  let plain = clamp(hdr, vec3f(0.0), vec3f(1.0));
  let outColor = mix(plain, clamp(graded, vec3f(0.0), vec3f(1.0)), uniforms.strength);
  fragmentOutputs.color = vec4f(pow(outColor, vec3f(1.0 / 2.2)), 1.0);
}`;

async function createEngine(canvas: HTMLCanvasElement): Promise<AbstractEngine> {
  if (await WebGPUEngine.IsSupportedAsync) {
    // timestamp-query lets engine.enableGPUTimingMeasurements report GPU frame time.
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      adaptToDeviceRatio: true,
      deviceDescriptor: { requiredFeatures: ["timestamp-query"] },
    });
    await engine.initAsync();
    engine.enableGPUTimingMeasurements = true;
    return engine;
  }
  // The WebGL2 fallback (ADR 0075) is a lazy chunk: it only downloads where WebGPU is missing.
  const { Engine } = await import("@babylonjs/core/Engines/engine.js");
  return new Engine(canvas, false, { adaptToDeviceRatio: true });
}

function buildScene(engine: AbstractEngine) {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.025, 0.04, 1);

  const camera = new ArcRotateCamera("cam", -Math.PI * 0.2, Math.PI * 0.45, 26, new Vector3(0, 4, 0), scene);
  camera.lowerRadiusLimit = 8;
  camera.upperRadiusLimit = 80;
  camera.minZ = 0.1;
  camera.maxZ = 300;
  camera.attachControl(true);
  scene.cameraToUseForPointers = camera; // the frame graph clears scene.activeCamera

  const sun = new DirectionalLight("sun", new Vector3(-0.6, -0.55, 0.4).normalize(), scene);
  sun.position = sun.direction.scale(-100);
  sun.intensity = 1.6;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 250;
  sun.diffuse = new Color3(1, 0.92, 0.78);
  const sky = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
  sky.intensity = 0.05;
  sky.diffuse = new Color3(0.5, 0.6, 0.8);
  sky.groundColor = new Color3(0.1, 0.08, 0.06);

  const stone = new PBRMaterial("stone", scene);
  stone.albedoColor = new Color3(0.55, 0.52, 0.48);
  stone.metallic = 0;
  stone.roughness = 0.85;

  const metal = new PBRMaterial("metal", scene);
  metal.albedoColor = new Color3(0.9, 0.75, 0.45);
  metal.metallic = 1;
  metal.roughness = 0.3;

  const ground = CreateGround("ground", { width: 80, height: 80 }, scene);
  ground.material = stone;
  ground.receiveShadows = true;

  // A colonnade under a slatted roof: the gaps cut the sunlight into shafts.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const pillar = CreateCylinder(`pillar${i}`, { height: 12, diameter: 1.2, tessellation: 24 }, scene);
    pillar.position.set(Math.cos(a) * 10, 6, Math.sin(a) * 10);
    pillar.material = stone;
    pillar.receiveShadows = true;
  }
  for (let i = -6; i <= 6; i++) {
    const slat = CreateBox(`slat${i}`, { width: 24, height: 0.6, depth: 1.1 }, scene);
    slat.position.set(0, 12.3, i * 1.9);
    slat.material = stone;
    slat.receiveShadows = true;
  }
  for (let i = 0; i < 6; i++) {
    const box = CreateBox(`crate${i}`, { size: 1.6 }, scene);
    box.position.set(Math.sin(i * 2.3) * 6, 0.8, Math.cos(i * 1.7) * 6);
    box.rotation.y = i;
    box.material = i % 2 ? metal : stone;
    box.receiveShadows = true;
  }

  const plasma = new ShaderMaterial(
    "plasma",
    scene,
    { vertexSource: plasmaVertex, fragmentSource: plasmaFragment },
    {
      attributes: ["position", "normal"],
      uniformBuffers: ["Scene", "Mesh"],
      uniforms: ["time"],
      shaderLanguage: ShaderLanguage.WGSL,
    },
  );
  const knot = CreateTorusKnot("knot", { radius: 2, tube: 0.6, radialSegments: 192, tubularSegments: 32 }, scene);
  knot.position.y = 4.5;
  knot.material = plasma;

  const glow = new PBRMaterial("glow", scene);
  glow.albedoColor = Color3.Black();
  glow.emissiveColor = new Color3(1, 0.45, 0.15);
  glow.emissiveIntensity = 8; // HDR, so bloom picks it up
  const orb = CreateSphere("orb", { diameter: 1.2, segments: 32 }, scene);
  orb.position.set(5, 1.5, -4);
  orb.material = glow;

  return { scene, camera, sun, plasma, knot };
}

function buildFrameGraph(scene: Scene, camera: ArcRotateCamera, sun: DirectionalLight) {
  const fg = new FrameGraph(scene, false);
  const tm = fg.textureManager;
  const fullScreen = { width: 100, height: 100 };
  const color = tm.createRenderTargetTexture("hdrColor", {
    size: fullScreen,
    sizeIsPercentage: true,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_HALF_FLOAT], formats: [Constants.TEXTUREFORMAT_RGBA], useSRGBBuffers: [false], labels: ["hdrColor"] },
  });
  const depth = tm.createRenderTargetTexture("depth", {
    size: fullScreen,
    sizeIsPercentage: true,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_UNSIGNED_BYTE], formats: [Constants.TEXTUREFORMAT_DEPTH24_STENCIL8], useSRGBBuffers: [false], labels: ["depth"] },
  });

  // A snapshot, so the lighting volume mesh the graph adds to the scene isn't drawn as geometry.
  const objects = new FrameGraphObjectList();
  objects.meshes = scene.meshes.slice();
  objects.particleSystems = [];

  const clear = new FrameGraphClearTextureTask("clear", fg);
  clear.targetTexture = color;
  clear.depthTexture = depth;
  clear.color = new Color4(0.02, 0.025, 0.04, 1);
  clear.clearDepth = true;
  clear.clearStencil = true;
  fg.addTask(clear);

  const shadow = new FrameGraphShadowGeneratorTask("shadow", fg);
  shadow.light = sun;
  shadow.camera = camera;
  shadow.objectList = objects;
  shadow.mapSize = 2048;
  shadow.filter = ShadowGenerator.FILTER_PCF;
  shadow.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  shadow.bias = 0.002;
  fg.addTask(shadow);

  const main = new FrameGraphObjectRendererTask("main", fg, scene);
  main.targetTexture = clear.outputTexture;
  main.depthTexture = clear.outputDepthTexture;
  main.camera = camera;
  main.objectList = objects;
  main.shadowGenerators = [shadow];
  main.isMainObjectRenderer = true;
  main.disableImageProcessing = true; // keep it linear HDR; the WGSL grade tone maps
  fg.addTask(main);

  const lightingVolume = new FrameGraphLightingVolumeTask("lightingVolume", fg);
  lightingVolume.shadowGenerator = shadow;
  fg.addTask(lightingVolume);

  const volumetric = new FrameGraphVolumetricLightingTask("volumetric", fg, false);
  volumetric.targetTexture = main.outputTexture;
  volumetric.depthTexture = main.outputDepthTexture;
  volumetric.camera = camera;
  volumetric.lightingVolumeMesh = lightingVolume.outputMeshLightingVolume;
  volumetric.light = sun;
  volumetric.phaseG = 0.5;
  fg.addTask(volumetric);

  const bloom = new FrameGraphBloomTask("bloom", fg, 0.3, 64, 1.0, true, 0.5);
  bloom.sourceTexture = volumetric.outputTexture;
  fg.addTask(bloom);

  const grade = new FrameGraphCustomPostProcessTask("grade", fg, {
    name: "spikeGrade",
    fragmentShader: "spikeGrade",
    useShaderStore: true,
    shaderLanguage: ShaderLanguage.WGSL,
    uniforms: ["exposure", "strength", "time"],
  });
  grade.sourceTexture = bloom.outputTexture;
  grade.targetTexture = backbufferColorTextureHandle;
  fg.addTask(grade);

  return { fg, volumetric, bloom, grade };
}

async function start() {
  const canvas = $("c") as HTMLCanvasElement;
  const engine = await createEngine(canvas);
  $("backend").textContent = `${engine.isWebGPU ? "WebGPU" : "WebGL2"} — Babylon ${WebGPUEngine.Version}`;

  const { scene, camera, sun, plasma, knot } = buildScene(engine);
  if (!FrameGraphVolumetricLightingTask.IsSupported(engine)) $("err").textContent = "Volumetric lighting unsupported here";
  const { fg, volumetric, bloom, grade } = buildFrameGraph(scene, camera, sun);

  let time = 0;
  grade.onApplyObservable.add((effect: Effect) => {
    effect.setFloat("exposure", 1.0);
    effect.setFloat("strength", checked("grade") ? 1 : 0);
    effect.setFloat("time", time % 100);
  });

  await fg.buildAsync();
  scene.frameGraph = fg;
  engine.onResizeObservable.add(() => void fg.buildAsync());

  let sunAngle = 0;
  let frames = 0;
  let last = performance.now();
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    time += dt;
    plasma.setFloat("time", time);
    knot.rotation.y += dt * 0.3;
    if (checked("spin")) {
      sunAngle += dt * 0.15;
      sun.direction = new Vector3(Math.cos(sunAngle) * 0.7, -0.55, Math.sin(sunAngle) * 0.7).normalize();
      sun.position = sun.direction.scale(-100);
    }
    volumetric.lightPower = checked("vol") ? new Color3(0.12, 0.108, 0.09) : Color3.Black();
    bloom.bloom.weight = checked("bloom") ? 0.3 : 0;
  });

  engine.runRenderLoop(() => {
    scene.render();
    frames++;
    const now = performance.now();
    if (now - last > 500) {
      $("fps").textContent = `${((now - last) / frames).toFixed(2)} ms (${Math.round((frames * 1000) / (now - last))} fps)`;
      frames = 0;
      last = now;
    }
  });
  window.addEventListener("resize", () => engine.resize());
  Object.assign(window, { spike: { engine, scene, fg } });
}

start().catch((e: unknown) => {
  console.error(e);
  $("err").textContent = String(e instanceof Error ? e.stack ?? e.message : e);
});
