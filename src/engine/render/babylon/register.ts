/**
 * Every Babylon.js side-effect module the backend relies on, in one place (ADR 0075). Babylon is
 * imported module by module, never from the `@babylonjs/core` barrel, and some features only work
 * once a module that registers them has been imported:
 *
 * - Engine methods (render targets, multi-render targets, queries, dynamic and raw textures…) are
 *   added to the engine's prototype by extension modules.
 * - A `.pure` module doesn't register its shaders; Babylon then fetches the shader over HTTP and
 *   gets the dev server's HTML page. Import the module's non-pure twin here instead.
 *
 * Import this before creating an engine.
 */
import "@babylonjs/core/Engines/WebGPU/Extensions/index.js";
// The WebGL2 fallback's twins of those (the WebGL engine has them on ThinEngine's prototype only once
// imported), the same set as `Engines/Extensions/index.js` less debugging, compute shaders (WebGPU only),
// multiview and transform feedback. Without them the frame graph throws on WebGL2 ("buildTextureLayout is
// not a function", from multiRender).
import "@babylonjs/core/Engines/Extensions/engine.alpha.js";
import "@babylonjs/core/Engines/Extensions/engine.alphaToCoverage.js";
import "@babylonjs/core/Engines/Extensions/engine.cubeTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.multiRender.js";
import "@babylonjs/core/Engines/Extensions/engine.query.js";
import "@babylonjs/core/Engines/Extensions/engine.rawTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.readTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.renderTarget.js";
import "@babylonjs/core/Engines/Extensions/engine.renderTargetCube.js";
import "@babylonjs/core/Engines/Extensions/engine.renderTargetTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.texture2DArrayImageSource.js";
import "@babylonjs/core/Engines/Extensions/engine.videoTexture.js";
import "@babylonjs/core/Engines/Extensions/engine.prefilteredCubeTexture.js"; // environment maps
import "@babylonjs/core/Engines/Extensions/engine.uniformBuffer.js";
import "@babylonjs/core/Engines/Extensions/engine.dynamicBuffer.js";
import "@babylonjs/core/Engines/Extensions/engine.textureSelector.js";
// Mesh methods: thin instances (mesh-mode particles, `particleMeshes.ts`).
import "@babylonjs/core/Meshes/thinInstanceMesh.js";

import { Effect } from "@babylonjs/core/Materials/effect.js";
// Keep compiled effects (shaders and their WebGPU pipelines) for the engine's life instead of
// reference counting them. Counted, an effect goes with the last material or particle system using
// it, and the next one compiles it again: in the pirates sample each volley's first splash and spray
// compiled the same shaders anew (a 100-180 ms frame). The variants a game uses are few; they're
// freed with the engine.
Effect.PersistentMode = true;
