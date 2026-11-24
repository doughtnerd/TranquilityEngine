/**
 * Internal (ADR 0370, generalising 0094's two particle runners): the GPU kernel executor. "Run this
 * kernel over N items, from these inputs, into these outputs", with a WebGPU and a WebGL2 backend,
 * renderer-neutral (raw GPUDevice / WebGL2 context; no Babylon types). Two layers:
 *
 * - **Passes** (`webgpu.ts`, `webgl2.ts`): `GpuKernel` is a WGSL compute module with entry points over an
 *   explicit bind group layout, cached bind groups and one compute pass per `dispatch`; `GlKernel` is a
 *   GLSL fragment program drawn as a full-screen pass into `FloatTargets` (RGBA32F MRT), one fragment per
 *   item. Their owners allocate the buffers and textures, so a renderer's draws can bind them (a
 *   `BufferFactory` on WebGPU). Shared arithmetic in `layout.ts` (workgroups, texture grids, ping-pong).
 *   The particle runners (`render/particles/gpu/webgpuRun.ts`, `webgl2Run.ts`) sit on this layer with
 *   their own shader text (`kernelShader.ts`), byte for byte as before.
 * - **Item kernels** (`itemKernel.ts`): a KSL body (`render/shaderSource`) written once, wrapped as WGSL
 *   compute, GLSL fragment, GLSL transform-feedback vertex and JavaScript; run by `GpuItemKernel` (output
 *   in a vertex-bindable storage buffer), `GlItemKernel` (output in float textures for vertex pulling),
 *   `GlFeedbackItemKernel` (output captured into an ordinary vertex buffer, laid out like WebGPU's) or
 *   `JsItemKernel` (CPU, tests). Inputs are tables of vec4 rows; a table several kernels share (a
 *   skeleton's bone palette) is bound with `bindInput`. Skinning (`render/skinning`, `mycoSkin`, T16)
 *   runs on `GpuItemKernel` and `GlFeedbackItemKernel`.
 *
 * Every runner has `dispatch` (per frame), `resize`, `dispose` and reports a lost device or context
 * (`lost`; work stops, the owner rebuilds). WebGL2 passes change GL state: the caller restores its own.
 */
export * from "./layout";
export * from "./webgpu";
export * from "./webgl2";
export * from "./itemKernel";
export { GpuItemKernel, type GpuItemKernelOptions } from "./itemKernelWebgpu";
export { GlItemKernel } from "./itemKernelWebgl2";
export { GlFeedbackBatch, GlFeedbackItemKernel } from "./itemKernelFeedback";
export { RangeAllocator, type Range } from "./rangeAllocator";
