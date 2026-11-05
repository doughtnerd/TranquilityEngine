# 0004. three.js owns the render pipeline

- **Status:** Superseded by [0075](0075-babylonjs-render-backend.md); was accepted, amended by [0010](0010-engine-graph-authoritative-over-threejs.md) (three.js is never exposed: no `Object3D` escape hatch, engine-owned math types, custom shaders as engine `Shader` assets)
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003, 0010, 0014

## Context

The legacy engine has a hand-written WebGL renderer: `rendering/SceneRenderer.js`, `Camera.js`, `Texture*.js`, two GLSL materials (`sprite-default`, `sprite-lit`) and gl-matrix for math. It draws textured quads and handles a basic orthographic/perspective camera. Everything beyond that (meshes, model loading, skeletal animation, shadows, post-processing, particles, UI) would have to be built from scratch, and it has open bugs (`// TODO: Fix loaded texture thingy`).

three.js is a mature, widely used WebGL renderer with a large plugin ecosystem, glTF loading, animation, lighting and shadows, post-processing, and a `WebGPURenderer` that can fall back to WebGL2.

## Decision

- **three.js renders everything**: game graphics, lighting, animation, particles and in-world UI. It is the only renderer.
- three.js is a **backend**. Game code uses engine components (`Camera`, `SpriteRenderer`, `MeshRenderer`, `Light`, `ParticleSystem`, `Animator`…), which create and sync three.js objects. Advanced users can reach the underlying `Object3D` through an explicit escape hatch (e.g. `meshRenderer.object3D`).
- Default renderer: `WebGLRenderer` (WebGL2). `WebGPURenderer` is allowed only where it falls back to WebGL2, because of the Tauri webview baseline (0003).
- Materials: three.js materials, plus custom shaders through `ShaderMaterial` (or TSL if WebGPURenderer is adopted). The legacy GLSL sprite shaders can be ported as `ShaderMaterial`s where still useful.
- Math: engine math types wrap or reuse three.js math (`Vector3`, `Quaternion`, `Matrix4`). gl-matrix is removed.
- Plugin candidates (to be confirmed in their own records when adopted):
  - Animation: three.js `AnimationMixer` (built in).
  - Particles: three.quarks or a custom GPU particle system.
  - Post-processing: three.js `EffectComposer` or pmndrs `postprocessing`.
  - UI: open; see [open questions](../architecture/open-questions.md).

## Alternatives considered

- **Keep the custom WebGL renderer.** Full control, but years of work to reach three.js feature parity, and it isn't the engine's differentiator.
- **Babylon.js.** A full engine with its own scene graph, physics plugins and editor. Strong, but it has opinions that overlap with the engine's own scene/scripting layer, and it is heavier. three.js is a renderer, which matches "engine on top of a renderer".
- **PixiJS for 2D + three.js for 3D.** Two renderers, two scene graphs, two asset paths. Rejected in favor of one pipeline (0014).
- **Raw WebGPU.** Not reliably available in all Tauri webviews.

## Consequences

**Positive**
- glTF models, PBR materials, shadows, skeletal animation and post-processing out of the box.
- A large community and examples.

**Negative / costs**
- three.js has its own scene graph (`Object3D` tree), which must be kept in sync with the engine's node graph (0010).
- Bundle size grows (tree-shaking helps).
- three.js releases often and makes breaking changes; pin the version and upgrade deliberately.

## Deprecates

- `src/engine/rendering/*` (SceneRenderer, Renderer, Camera, Screen, Sprite, SpriteRenderer, Texture, TextureLoader): replaced by three.js-backed components.
- `src/engine/materials/*`: replaced by three.js materials; sprite shaders ported only if needed.
- The `gl-matrix` and `@types/gl-matrix` dependencies.
- The `fastpriorityqueue` dependency (used only by the legacy `Camera.js` for draw ordering).
- `CameraObject.js`: becomes a node with a `Camera` component.

## Open questions

- ~~UI approach.~~ Resolved by [0020](0020-in-canvas-ui-with-uikit.md): in-canvas, pmndrs uikit.
- ~~`WebGPURenderer` vs `WebGLRenderer`.~~ Resolved: `WebGLRenderer` (WebGL2) only for v1; WebGPU revisited later.
- ~~Particles plugin.~~ Resolved by [0021](0021-particles-with-three-quarks.md): three.quarks.

## References

- https://threejs.org/docs/
