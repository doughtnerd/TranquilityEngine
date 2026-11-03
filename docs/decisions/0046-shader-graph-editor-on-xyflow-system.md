# 0046. The shader graph editor is a Preact panel on xyflow's framework-free core (`@xyflow/system`)

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010, 0025, 0026, 0043, 0047, 0048

## Context

We want a material editor that works like Unity's Shader Graph: nodes wired into a master node, compiled to a shader, previewed live, saved as an asset that materials use (0047 covers the asset and the compiler). The owner asked for an investigation into integrating an existing graph editor (a JS/TS library, or something compiled to WASM) before building one.

Constraints the choice must fit:

- The editor UI is DOM built with Preact (0025), themed through CSS tokens (`var(--panel)`, `var(--accent)`…) that Settings > Appearance changes. A graph that draws itself on a canvas in its own colours would ignore the theme.
- three.js stays out of the public API (0010), and the renderer is three's `WebGLRenderer` on WebGL2 (0003, 0004). Whatever the graph compiles to must plug into the material assets of 0043 and draw with the same lights, shadows and environment, in the editor and in exported web and desktop games (0041).
- Playwright e2e tests drive the editor through the DOM; panels follow the dock layout (`src/editor/layout/`).
- New dependencies need a record and should earn their size.

### What was evaluated (November 2026)

| Candidate | Licence | Maintenance | Size (min) | Fit |
| --- | --- | --- | --- | --- |
| **three.js node materials / TSL** (`three/webgpu`, `three/tsl`) and the three.js Playground node editor (sunag's `flow.js`) | MIT | Very active | ~1 MB more (`three.webgpu.js` builds on the core we already load) | Node materials target `WebGPURenderer`. r187 can run them in `WebGLRenderer` only through the experimental `examples/jsm/tsl/WebGLNodesHandler.js` (no VSM shadows, environment and fog don't update without `dispose`, instanced geometry can't be shared). The Playground editor is tied to TSL node classes, styled on its own, and not a library with a stable API. Adopting it means either moving the renderer to WebGPURenderer (a 0004-sized change) or shipping an experimental bridge. |
| **xyflow / React Flow 12, Svelte Flow** | MIT (some extras paid "Pro") | Active | ~150 KB with zustand and d3-zoom | The best general node-graph UI, but React or Svelte. React beside Preact (through `preact/compat` aliases in every Vite config and tsc paths, and React's types beside Preact's) was ruled out by the owner: one UI framework in the editor. |
| **`@xyflow/system`** (the framework-free core React Flow and Svelte Flow are built on) | MIT | Active (0.0.84, published 2026-11-02) | ~40 KB with d3-zoom, d3-drag, d3-selection | Plain DOM: `XYPanZoom` (zoom, pan, framing), `XYDrag` (dragging one or several selected nodes), `XYHandle` (drawing a connection from a port, connection radius, validation), `XYMinimap`, and edge path maths (`getBezierPath`). No components: nodes are ours. Pre-1.0 and undocumented as a public API. |
| **Rete.js 2** | MIT | Maintained, slower | ~60 KB core + area/connection plugins + a renderer | Framework-agnostic core with React, Vue, Angular, Svelte and Lit renderers; no Preact one (the React one through compat has the same costs as xyflow). Its data-flow engine evaluates in JS; it doesn't generate GLSL. |
| **LiteGraph.js** (jagenjo; Comfy-Org fork) | MIT | Original stalled; the maintained fork now lives inside ComfyUI's frontend | ~250 KB | Draws everything on a canvas in its own colours and fonts: no theme tokens, no DOM for e2e tests or accessibility. |
| **Baklava.js 2** | MIT | Maintained | ~100 KB + Vue 3 | Vue only. |
| **NodeToy** | Proprietary (hosted tool, runtime package for three) | Active | — | Not embeddable as an editor; shaders are authored on their site. |
| **Shaderfrog 2 / `@shaderfrog/core`** | Licence not clearly published at time of writing | Self-described experimental | — | A GLSL "hybrid graph" editor with three.js support; its own React UI and an unstable API. |
| **WASM**: egui-snarl / egui_node_graph (Rust, egui), imnodes / imgui-node-editor (C++, Dear ImGui via Emscripten) | MIT / MIT-Apache | Varies (egui_node_graph archived) | 1–3 MB of WASM plus a GL or WebGPU context of their own | Immediate-mode canvases: no theme tokens, no DOM, a second rendering stack and toolchain (Rust or Emscripten) in the build, and the GLSL generation would still be ours. |

Common finding: every graph-UI library solves panning, zooming and drawing wires; none generates GLSL for three's built-in materials, so the compiler, node library, typed ports, inline values, master node and preview are ours whichever we pick. The only candidate that does both (three's TSL stack) targets a different renderer.

## Decision

We will build the graph editor as a Preact panel (`src/editor/ui/ShaderGraphPanel.tsx`) whose canvas interactions come from **`@xyflow/system`**, xyflow's framework-free core, and write our own graph-to-GLSL compiler (0047) that extends three's built-in materials from inside the render backend. No React, no second UI framework.

- `@xyflow/system` is pinned to an exact version (0.0.84) and imported in one adapter module (`src/editor/shaderGraph/xyflow.ts`), so an upstream change touches one file. We use `XYPanZoom` for the canvas, `XYDrag` for nodes, `XYHandle` for wiring, and `getBezierPath` for wires; ports, nodes, inline fields, the search popup and the Blackboard are our Preact components, themed with the editor's tokens. Port positions come from a fixed row layout and are handed to xyflow as handle bounds, so nothing waits on DOM measurement.
- The panel is a dockable editor panel (`shadergraph`, "Shader Graph"), a tab beside the scene view by default, opened by double-clicking a `*.shadergraph.json` asset. It can be maximised to fill the window.
- Interactions follow Unity's Shader Graph: drag from a port to connect (dropping on empty canvas opens the node search, filtered to nodes that fit, and connects the new node); Space or right-click opens node search; drag nodes, box-select, Delete; inline fields for unconnected inputs; a Blackboard of exposed properties; graph settings (lit or unlit, opaque or transparent, double-sided); a live preview; the generated GLSL on demand.
- Edits are pure functions over the graph JSON (`src/editor/shaderGraph/graphEdit.ts`, unit-tested), saved to the file as they're made, with an undo/redo history per graph.
- The preview is an engine-internal `MaterialPreview` (exposed through `src/engine/editor`, not the public API) that draws a mesh with the graph's material in its own small canvas.

## Alternatives considered

- **React Flow through `preact/compat`.** Ruled out: two UI frameworks in one editor.
- **Migrating the editor to Svelte and using Svelte Flow.** Reuses the most for the graph, but means rewriting every editor panel (0025); worth it only for reasons beyond this feature, as its own decision.
- **Pan, zoom, drag and wiring written from scratch.** No dependency, but it re-solves what xyflow's core already handles (trackpads, pinch, auto-pan while wiring, connection radius, multi-node drag).
- **three.js TSL node materials (and its node editor).** Not chosen because they need `WebGPURenderer`, or an experimental bridge with known gaps, plus about a megabyte more of three; and TSL graphs are code objects, not a file format we control. Revisit if the engine moves to WebGPURenderer: the compiler's back end could emit TSL instead of GLSL with the same asset format.
- **Rete.js, LiteGraph, Baklava, WASM node editors.** Framework mismatch (Vue, React-only renderers), canvas drawing that ignores the theme and the DOM tests, or a second toolchain and rendering stack, each for a UI we'd still have to extend.
- **NodeToy, Shaderfrog.** External tools or unstable, unclearly licensed code; neither is a component we can embed and own.

## Consequences

**Positive**
- One UI framework; the canvas interactions are xyflow's, tested by its users; the panel themes with the rest of the editor and is testable through the DOM.
- The compiler targets exactly the materials, lights and shadows the engine already draws with, so graphs look right in exported games.
- The asset format and the compiler are independent of the UI, so the UI can be swapped later without touching saved graphs.

**Negative / costs**
- A new dependency (with d3-zoom, d3-drag, d3-selection) on a pre-1.0 package whose API is internal to xyflow: upgrades are deliberate and confined to the adapter.
- xyflow's core finds ports through its own DOM conventions (`<lib>-flow__handle` classes and `data-*` attributes), which our port elements follow.

## Deprecates

Nothing. New dependency: `@xyflow/system` (exact version).

## Open questions

- Per-node previews (Unity shows one on most nodes); groups, sticky notes, sub-graphs, copy and paste between graphs.
- Replacing `@xyflow/system` with our own code if its internal API churns.

## References

- three.js WebGPURenderer manual (node materials, TSL): https://threejs.org/manual/en/webgpurenderer
- three.js r187 `examples/jsm/tsl/WebGLNodesHandler.js` (its limitations are listed at the top of the file)
- three.js forum, node materials in WebGLRenderer: https://discourse.threejs.org/t/r164-nodes-no-longer-working-with-webgl-webgl2/64909
- xyflow and `@xyflow/system`: https://github.com/xyflow/xyflow (packages/system) · Rete.js: https://retejs.org · LiteGraph: https://github.com/jagenjo/litegraph.js · Baklava: https://github.com/newcat/baklavajs
- Shaderfrog core: https://github.com/ShaderFrog/core
