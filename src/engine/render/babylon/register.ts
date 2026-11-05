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
