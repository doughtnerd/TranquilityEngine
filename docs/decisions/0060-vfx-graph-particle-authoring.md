# 0060. Particle effects are VFX-Graph-style graph assets, authored only in the Particle Graph

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** 0058; part of 0057 (the effect format, embedded effects, the effect editor in the Inspector)
- **Related:** 0004, 0021, 0046, 0047, 0057

## Context

ADR 0057 added particle effects (`*.particles.json`, played by three.quarks), each a list of emitters edited in foldouts in the Inspector. ADR 0058 planned a graph *view* of that same data, with the Inspector editor kept alongside. It wasn't started.

The owner wants Unity's functionality, not its Particle System UI:

- Effects are authored in a node graph that looks and works like Unity's VFX Graph:
  - **systems** are columns of **contexts** (Spawn, Initialize, Update, Output) holding stacks of **blocks**;
  - **operators** compute values and are wired into block inputs;
  - **events** link systems.
- Nothing about an effect's contents is crammed into the Inspector.
- When the engine later moves to WebGPU and GPU particles, the authoring UI and the saved assets shouldn't have to change; only the backend that runs them should.

0058's design can't meet the last point. A view of quarks-shaped data has no place for operators or for anything quarks can't run, so a GPU backend would force a new format and a new editor.

## Decision

### The graph is the asset

`*.particles.json` keeps its extension, asset kind and references, and becomes a graph document, format **`myco.particles@2`**. Files in `myco.particles@1` (0057) are read and migrated, one emitter to one system; they're written back as `@2` on the next save.

```jsonc
{
  "format": "myco.particles@2",
  "properties": [ { "name": "Tint", "type": "color", "value": "#ffffff", "exposed": true } ],
  "systems": [ {
    "id": "s1", "name": "Flames", "position": [0, 0],
    "settings": { "space": "world", "capacity": 500, "seed": null },
    "spawn":      { "settings": { "duration": 5, "looping": true, "startDelay": 0, "prewarm": false },
                    "blocks": [ { "id": "b1", "type": "spawn.rate", "inputs": { "rate": 40 } } ] },
    "initialize": { "blocks": [ { "id": "b2", "type": "init.lifetime", "inputs": { "lifetime": { "random": [0.6, 1.2] } } },
                                { "id": "b3", "type": "init.positionCone", "inputs": { "radius": 0.2, "angle": 20 } } ] },
    "update":     { "blocks": [ { "id": "b4", "type": "update.colorOverLife", "inputs": { "color": "@n1" } } ] },
    "output":     { "type": "quad", "settings": { "blending": "additive", "material": null, "texture": "asset:fx/flame.png" },
                    "blocks": [ { "id": "b5", "type": "output.flipbook", "inputs": { "tiles": [4, 4] } } ] }
  } ],
  "nodes": [ { "id": "n1", "type": "gradient", "position": [-320, 80], "settings": { "colors": [[0, "#ffd27a"], [1, "#ff3b00"]] } } ],
  "edges": [ { "from": "n1.out", "to": "s1.b4.color" } ],
  "events": [ { "from": "s1.onDeath", "to": "s2.spawn" } ],
  "notes": [], "groups": [], "editor": {}
}
```

- **Block inputs** are inline values, using 0057's value forms (number, `random`, `curve`, `randomCurves`, colour, `gradient`, `randomGradients`, vectors). An input can instead be wired from a node (`"@n1"`, with the wire in `edges`).
- **Positions** are part of the document: systems and nodes carry them, and notes and groups are kept. There's no separate layout file and no compile output on disk.
- **Block types are versioned by name** (`update.colorOverLife`). Unknown blocks, nodes and settings are kept on save and reported as problems, never dropped.

### Contexts and blocks

| Context | Settings | Blocks (v1) |
|---|---|---|
| **Spawn** | duration, looping, start delay, prewarm | Constant Rate, Rate over Distance, Burst, Periodic Burst; spawns on Play, stops on Stop, and is restarted by event wires |
| **Initialize** | — | Set Lifetime, Set Velocity (speed and direction), Set Size, Set Rotation, Set Colour; Position: Point, Sphere, Hemisphere, Cone, Circle, Donut, Rectangle, Grid (offset and rotation); Inherit Source Velocity |
| **Update** | — | Colour/Size/Rotation/Speed/Force over Life, Gravity, Point Gravity, Noise, Turbulence, Orbit, Limit Speed, Colour/Size by Speed, Flipbook Frame over Life, Collide with Plane, Trigger Event (On Birth, On Death, Rate) |
| **Output** | type: Quad, Stretched Quad, Horizontal, Vertical, Mesh, Trail; material or texture, blending, render order, trail length | Flipbook, Width over Length (trails) |

- Blocks in Update apply in order (top first).
- Each block can be enabled or disabled, reordered by drag, and removed.
- One Output per system for now. The format allows more, and extra outputs are flagged "needs GPU backend" (quarks gives an emitter one renderer).

### Operators and values

- **Value nodes:** Constant (number, vector, colour), Random Range, Curve, Random Between Curves, Gradient, Random Between Gradients, Property (from the Blackboard).
- **Operators** (v1, evaluated **once per frame per system** on the CPU):
  - time: Time, Delta Time, Play Time;
  - arithmetic: Add, Subtract, Multiply, Divide, Negate, Abs, Min, Max, Clamp, Lerp, Remap, Step, Smoothstep;
  - trigonometry: Sine, Cosine;
  - sampling: Sample Curve, Sample Gradient, Noise (1D over time);
  - vectors: Compose, Split, Length, Normalize;
  - colour: Colour from HSV, Multiply Colour.
- **Ports have a rate:** *uniform* (one value per system per frame) or *per-particle* (Random Range, Curve and Gradient fed into an over-life block, which quarks evaluates per particle).
  - Uniform chains feed any input.
  - A per-particle source wired straight into an input that takes one works.
  - An operator chain that combines per-particle values is valid in the format, but the CPU backend reports "needs GPU backend" on the wire and uses the input's inline value.
  - Ports and wires show their rate.
- **Exposed properties** (number, vector, colour, curve, gradient, texture) are listed on the Blackboard. They show on each ParticleSystem as per-instance overrides, and scripts set them with `particleSystem.setProperty(name, value)`.

### Events

- Trigger Event blocks (On Birth, On Death, Rate) in Update have an event output.
- Wiring one to another system's Spawn makes that system spawn from each triggering particle. This is the sub-emitter mechanism (a firework, an impact with debris).
- **Event nodes** feed Spawn's start and stop:
  - On Play (the default), On Stop, and Custom (by name).
  - A Custom event starts or bursts a system when a script calls `particleSystem.sendEvent(name)`.

### Compiling: graph → IR → backend

`compileParticleGraph(doc)` validates the graph and lowers it to a backend-neutral IR (`ParticleProgram`):

- systems with resolved blocks, in order;
- a uniform expression DAG per system, with property and time inputs;
- per-particle sources;
- event routes;
- problems, each pointing at a node, block or wire.

**Backends consume the IR.** The **quarks backend** (today) maps blocks to quarks emitters, shapes and behaviours. Each frame it evaluates the uniform expressions and writes the results into its value generators *in place*, so animated and property-driven values don't rebuild the effect. Structural edits (blocks added or removed, wires changed) rebuild it. A future **GPU backend** consumes the same IR, and per-particle operator chains start working there with no editor or format change. The editor shows the compiler's problems on the graph, as the shader graph does.

### Editor

**The Particle Graph panel** (`particlegraph`), dockable and maximisable, follows Unity VFX Graph's layout:

- **Systems:** each system is a titled frame holding its four contexts stacked top to bottom, linked by flow connectors.
- **Contexts:** each context is a wide node with a coloured header (by kind, from theme tokens) and its settings in the header. Its block stack sits below.
- **Blocks:** each block is a row with a title, an enable toggle, a drag handle, and its inputs as ports with inline fields beside them. Curves and gradients open the existing curve and gradient editors (0057) in a popover.
- **Operators and value nodes** float freely and wire into block inputs. Event wires are drawn in a separate style.
- **Search:** Space or right-click opens it, filtered to where you are: over a context it lists that context's blocks; on empty canvas it lists operators, value nodes, events and "New System" templates (empty, Simple Loop, Burst, Trail).
- **Blackboard:** exposed and internal properties.
- **Preview:** the panel's own preview, an orbit view with Play, Pause, Restart, Speed, looping and background. The scene view also plays every instance of the effect live as you edit.
- **Toolbar:** Play controls, problem count, and a "Show in Scene" button that selects an instance of the effect.
- **Editing:** box select, Delete, copy and paste (also across effects), groups, notes and a minimap. Undo and redo are kept per asset, and edits save as they're made.
- **Opening:** double-click a `*.particles.json` asset, or click "Open in Particle Graph" on a ParticleSystem or in the Asset Inspector.

**The Inspector** shows a ParticleSystem's own fields:

- effect asset, play on awake, time scale, tint, emission scale, destroy on finish;
- its overrides of the effect's exposed properties, each with a revert;
- "Open in Particle Graph".

Nothing of the effect's systems or blocks appears there.

**The Asset Inspector** shows an effect's summary (systems, problems) and the same button.

**The effect editor in the Inspector (0057) is removed.** Its value inputs and the curve and gradient editors are reused inside the graph.

**A shared graph-editor layer** (`src/editor/graph/`) is factored out of the shader graph panel and used by both panels:

- the `@xyflow/system` adapter (pan, zoom, drag, wiring);
- box select and the minimap;
- notes and groups;
- node search;
- the clipboard;
- per-asset history;
- the Blackboard shell and the preview frame.

The shader graph moves onto this layer first, and its e2e specs must keep passing.

### Effects are always assets

- `ParticleSystem.embeddedEffect` is deprecated.
- Create > Particle System makes a new effect asset from the Simple Loop template, beside the scene's folder in `effects/`, and points the component at it.
- When the editor opens a scene with embedded effects, it moves each into an asset file, points the component at it, and says so in the status bar. This is undoable, and the scene is marked unsaved.
- The runtime still plays embedded effects in scenes that were never re-saved, so exported games keep working.

### Public API

- `ParticleSystem` gains:
  - `setProperty(name, value)` and `getProperty(name)`;
  - `sendEvent(name)`;
  - an `overrides` field of property values.
- `embeddedEffect` stays readable and is deprecated.
- No three.quarks types are exposed (0010).

## Alternatives considered

- **ADR 0058 (a graph view of the 0057 data, the Inspector editor kept).** No operators or events beyond sub-emitters, and a GPU backend would need a new format and editor. It also keeps the Inspector editor the owner doesn't want.
- **Full per-particle operators on the CPU now** (custom quarks behaviours evaluating the graph per particle). Most VFX-Graph-like today, but slow at scale and a second runtime to maintain. Per-particle maths belongs to the GPU backend.
- **Several outputs per system now** (duplicate quarks emitters with the same seed). The duplicates wouldn't match exactly, at twice the cost. Deferred to the GPU backend, which can share one simulation.
- **Keep embedded effects, edited in the graph.** Two places to find effects, and harder sharing. VFX Graph has none either.
- **quarks.nodes / quarks.art.** WebGPU-only and experimental, or a separate app with its own format and UI (as 0058 found).

## Consequences

**Positive**
- One authoring UI, VFX Graph's, that survives the move to GPU particles: the format and the editor already hold operators, events and multiple outputs.
- The Inspector stays short: a component and its overrides.
- Property-driven and time-animated values update without rebuilding effects, which they currently do on every change.
- Most canvas work is shared with the shader graph.

**Negative / costs**
- **Big build:** the format, the compiler and IR, the quarks backend changes, the panel with stacked reorderable blocks, the shared-layer refactor, migrations, and e2e.
- **CPU-backend limits:** some graphs are valid but limited on the CPU backend (per-particle operator chains, several outputs). The editor must make that obvious.
- **Migration:** the 0057 Inspector editor and embedded effects go away. Existing effects (the 3D Playground's campfire) migrate, and old files stay readable.

## Deprecates

- `myco.particles@1` (still read).
- `ParticleSystem.embeddedEffect` (still played).
- The Inspector's particle effect editor (removed).
- ADR 0058 as a whole.

## Open questions

- **Sub-graphs** for reusable block stacks and operator groups ("smoke trail"), like VFX Graph's subgraph blocks.
- **Custom blocks** written as project scripts.
- **GPU backend:** WebGPU compute versus WebGL2 texture simulation, and when to start (0004 keeps WebGL2 for now).
- **Bounds and culling settings** per system (VFX Graph's bounds), once there's a culling pass for effects.

## References

- Unity VFX Graph: systems, contexts, blocks, operators, GPU events, Blackboard. Unreal Niagara emitter stacks.
- 0046/0047 (shader graph editor and its canvas), 0057 (effect runtime and value forms).
