# 0058. A particle graph editor: a node view of particle effect assets, on the shader graph's canvas

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0021, 0025, 0046, 0047, 0057

## Context

Particle effects (0057) are assets whose emitters are built from modules (main, emission, shape, behaviours over lifetime, sub-emitters, renderer) with values that can be constants, ranges, curves or gradients. An inspector of foldouts, as in Unity's Particle System, gets hard to read once an effect has several emitters linked by sub-emitters, or the same curve is reused across behaviours. Unity's VFX Graph and Unreal's Niagara show the alternative:
- each system is a column of stages ("contexts") holding stacks of blocks;
- systems are linked by events;
- value nodes feed block inputs.

The owner wants that kind of graph for authoring three.quarks effects, while keeping the WebGL2 renderer (0004) and deferring GPU simulation.

The shader graph editor (0046) already provides:
- a Preact panel on `@xyflow/system` (pan, zoom, drag, wiring, minimap);
- node search, typed ports, inline fields, undo/redo per asset, docking, a Blackboard of exposed properties;
- a live preview canvas.

There is one difference. The shader graph is a program: nodes are operations compiled to GLSL. A quarks effect is not: quarks runs a fixed set of behaviours on the CPU, configured by data. So a particle graph can't compute arbitrary per-particle maths. It is a structured editor for the effect's data.

## Decision

We will build a **Particle Graph** panel that edits `*.particles.json` effect assets (0057) as a graph, reusing the shader graph's canvas layer.

**The asset stays the source of truth.**
- The graph is a view of the effect's emitters, modules and values, not a second document compiled into it.
- Node positions, collapsed state and comments are stored in the asset's `editor` section, which the engine ignores.
- The inspector (0057) and the graph edit the same data; an edit in one shows in the other.
- There's no compile step beyond the runtime's translation into quarks.

**Layout: one column per emitter**, built from stage nodes with stacked blocks, as in VFX Graph:
- **Spawn:** emission rate over time and distance, bursts, start delay, duration and looping.
- **Initialize:** shape, and start lifetime, speed, size, rotation and colour.
- **Update:** the ordered behaviours over lifetime (colour, size, rotation, speed, forces, noise, orbit, flipbook, limit speed…).
- **Output:** render mode, material, blending, flipbook tiles, sorting, soft particles.

Within a stage:
- Blocks are added from a search popup filtered to that stage, reordered by drag, enabled or disabled with a toggle, and removed.
- Each block has the module's fields as inline inputs.
- Order matters in Update, since quarks applies behaviours in order.

**Value nodes**
- A block input can be wired from a value node instead of an inline value: Constant, Random Range, Curve, Random Between Curves, Colour, Colour Range, Gradient.
- One curve or gradient node can feed several blocks, even across emitters.
- In the asset, such values are named and referenced, so sharing survives a save.
- The curve and gradient editors are the same widgets the inspector uses (0057).

**Sub-emitters are wires.** An Update or Initialize stage has "On Birth" and "On Death" event ports. Wiring one to another emitter's Spawn stage makes that emitter its sub-emitter, which is how a firework or an impact with debris is built.

**Exposed properties**
- The Blackboard lists properties (number, colour, vector, curve, gradient, texture) that block inputs can be wired from.
- They show on every ParticleSystem using the effect, as per-instance overrides.
- Scripts set them with `particleSystem.setProperty(name, value)`.
- The runtime rebuilds only the affected quarks value generators when one changes.

**Preview**
- The panel has its own preview canvas: an engine-internal effect preview beside `MaterialPreview`, exposed through `src/engine/editor` and never the public API.
- It plays the effect live with Play, Pause, Restart, speed, a looping toggle, a background choice and an orbit camera.
- Edits apply without restarting the effect where quarks allows, and with a restart otherwise.

**Panel**
- A dockable panel (`particlegraph`, "Particle Graph"), opened by double-clicking a `*.particles.json` asset or by "Edit Effect" on a ParticleSystem.
- It follows the shader graph panel's conventions:
  - Space or right-click for search;
  - box select, Delete, copy and paste;
  - undo and redo per asset, saved as edits are made;
  - maximise;
  - theme tokens for every colour.

**Sharing with the shader graph**
- The `@xyflow/system` adapter, the canvas and wiring code, node search, the Blackboard and the preview frame are factored out of the shader graph panel into a shared graph-editor layer under `src/editor/graph/`, which both panels use.
- What's new is stage nodes with stacked, reorderable blocks.
- A future GPU VFX Graph would build on the same layer.

## Alternatives considered

- **Inspector foldouts only** (Unity's Particle System window). Cheaper, and kept for quick edits, but multi-emitter effects, sub-emitter chains and shared curves are hard to follow in a list.
- **A free-form operator graph compiled to quarks behaviours.** It would look like VFX Graph's operators, but quarks has no per-particle expression evaluation. Every operator would need a custom JavaScript behaviour evaluated per particle on the CPU: slow at scale, and a second runtime to maintain. Real per-particle maths belongs in a GPU VFX Graph, which is deferred.
- **quarks.nodes** (quarks' experimental node-based VFX package). It targets WebGPU compute, which conflicts with staying on WebGL2 (0004), and it's experimental.
- **Embedding quarks.art.** A separate web app with its own UI and JSON format: no theme, no docking or undo integration, and it writes quarks' format rather than ours (0057).
- **A separate graph document compiled into the effect asset.** Two files that can disagree. Keeping the effect as the single source with editor-only layout avoids that.

## Consequences

**Positive**
- Complex effects are readable: one column per emitter, events as wires, shared curves as nodes.
- Most of the canvas work is already done and tested in the shader graph; factoring it out also leaves less editor code overall.
- The graph and the inspector can't disagree, because they edit one asset.

**Negative / costs**
- Stacked, reorderable blocks inside nodes are new UI, beyond the shader graph's fixed rows.
- Factoring the canvas layer out of `ShaderGraphPanel.tsx` touches working code, so the shader graph e2e specs must keep passing through the refactor.
- Users who know VFX Graph may expect operators (maths nodes). The graph has value nodes only until GPU particles exist.

## Deprecates

Nothing. 0021's open question ("whether the editor gets a dedicated particle editing view in v1") is answered: yes, this graph, plus the inspector.

## Open questions

- Custom behaviours written as project scripts (quarks supports behaviour plugins) and shown as blocks.
- A GPU VFX Graph with operators, on WebGL2 texture simulation or WebGPU, reusing this editor layer.
- Sub-graphs for reusable block stacks (a "smoke trail" stack used in many effects).

## References

- 0046 (shader graph editor), 0057 (effect assets)
- Unity VFX Graph contexts and blocks; Unreal Niagara emitter stacks (layout references)
