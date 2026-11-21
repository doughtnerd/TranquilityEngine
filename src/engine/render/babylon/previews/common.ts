/**
 * What the editor's Babylon preview renderers share (ADR 0061, 0075 stage 7): a scene lit by the default
 * light rig, a World's own (`lighting.ts`, ADR 0277; their engines come from the engine factory,
 * `createEngine.ts`, ADR 0244), the studio environment, and a preview scene's material library (the World
 * renderer's, ADR 0127). Babylon types stay inside `render/babylon/` (ADR 0010).
 *
 * Previews draw straight into their engine's canvas and copy it (`drawImage`) into a 2D canvas in the
 * same task: a WebGPU canvas can't be read after it's presented, but it can be right after drawing.
 * Colours: the scene's own image processing converts linear light to sRGB with no tone mapping.
 */
import "../register";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import "../prefilterGuard";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../../scene/Assets";
import { parseMaterial, type MaterialSettings } from "../../../scene/material";
import { parseShaderGraph, type ShaderGraph } from "../../../scene/shaderGraph";
import type { GraphShared } from "../graphMaterial";
import { useDefaultStudio } from "../lighting";
import { lookAtRotation } from "../lookAt";
import { BabylonMaterialLibrary } from "../materialLibrary";

/** A scene in Babylon's default left-handed mode (the engine's convention, ADR 0164) that clears to transparent. */
export function createPreviewScene(engine: AbstractEngine): Scene {
  const scene = new Scene(engine);
  scene.autoClear = true;
  scene.clearColor = new Color4(0, 0, 0, 0);
  return scene;
}

/** The studio room's prefiltered cube, made in `scene` (see {@link useWhenReady}). */
export { createStudioTexture } from "../studioCube";

/**
 * Light `scene` with the studio room at the default rig's intensity (`useDefaultStudio`, ADR 0277) once it's ready:
 * prefiltering swaps a cube's GPU texture when it finishes, and a material that bound the first one on WebGPU
 * would keep drawing with it once it's destroyed (ADR 0075, stage 2). Resolves true when it was set, false if
 * it never got ready (or the scene went first).
 */
export function useWhenReady(scene: Scene, texture: BaseTexture, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (scene.isDisposed) return resolve(false);
      if (texture.isReady()) {
        useDefaultStudio(scene, texture);
        return resolve(true);
      }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(poll, 16);
    };
    poll();
  });
}

/** Resolves true when everything in `scene` can draw (materials compiled, textures loaded), false after `timeoutMs`. */
export function sceneReady(scene: Scene, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    scene.whenReadyAsync().then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** Draw one frame of `scene` into the engine's canvas. */
export function renderFrame(engine: AbstractEngine, scene: Scene): void {
  engine.beginFrame();
  scene.render();
  engine.endFrame();
}

/**
 * Draw one frame like {@link renderFrame}, and on WebGPU watch it for validation errors: a WGSL shader
 * that doesn't compile fails when its pipeline is made (Babylon only logs it, and `Effect.onErrorObservable`
 * never fires), so `onError` gets the compiler's message a moment later. On WebGL2 it's a plain frame.
 */
export function renderFrameChecked(engine: AbstractEngine, scene: Scene, onError: (message: string) => void): void {
  const device = engine instanceof WebGPUEngine ? engine._device : null;
  if (!device) return renderFrame(engine, scene);
  device.pushErrorScope("validation");
  renderFrame(engine, scene);
  device.popErrorScope().then((error: { message: string } | null) => error && onError(error.message), () => undefined);
}

/** Make the engine's canvas `w` × `h` pixels (a no-op if it is already, or the engine has no canvas, as under tests). */
export function ensureCanvasSize(engine: AbstractEngine, w: number, h: number): void {
  const canvas = engine.getRenderingCanvas();
  if (!canvas || (canvas.width === w && canvas.height === h)) return;
  engine.setSize(w, h);
}

/** Put `camera` at `eye` looking at `target`. */
export function aimCamera(camera: TargetCamera, eye: readonly number[], target: readonly number[]): void {
  camera.position.set(eye[0], eye[1], eye[2]);
  camera.rotationQuaternion = lookAtRotation(eye, target);
}

// --- materials and textures ------------------------------------------------------------------------

const warned = new Set<string>();

/**
 * A preview scene's material library (ADR 0127): the World renderer's materials and textures, built the
 * same way, as saved (no script Material values). Warnings show once per editor session; `quiet` drops
 * them (thumbnails, which warn once themselves when they can't draw an asset).
 */
export function previewMaterials(scene: Scene, shared: GraphShared, quiet = false): BabylonMaterialLibrary {
  return new BabylonMaterialLibrary(scene, {
    shared,
    scriptMaterials: false,
    warn: (key, message) => {
      if (quiet || warned.has(key)) return;
      warned.add(key);
      console.warn(`[myco] preview: ${message}`);
    },
  });
}

// --- assets -----------------------------------------------------------------------------------------

/** A material asset's settings, or null if it isn't a material. */
export function readMaterial(path: string): MaterialSettings | null {
  try {
    return parseMaterial(Assets.json(path), path).settings;
  } catch {
    return null;
  }
}

/** A shader graph asset, or null if it can't be read. */
export function readGraph(path: string): ShaderGraph | null {
  try {
    return parseShaderGraph(Assets.json(path), path).graph;
  } catch {
    return null;
  }
}

/** True if a shader graph reads the Time node, so its preview moves. */
export const usesTime = (graph: ShaderGraph | null): boolean => !!graph?.nodes.some((n) => n.type === "time");
