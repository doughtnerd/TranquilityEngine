# 0095. Particle graphs gain per-particle attributes, sub-graph assets and custom block assets, inlined before compiling

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0060 (amends: its open questions on sub-graphs and custom blocks), 0094, 0047 (shader sub-graphs)

## Context

ADR 0060's particle graph has operator nodes, but every per-particle value came from a fixed source (Random Range, Curve, Gradient) feeding a block input, and per-particle operator chains couldn't run. With kernel backends (0094) they can, but the graph had no way to *read* a particle (its age, position, velocity) or to *write* one with a computed value. 0060 also left open "sub-graphs for reusable block stacks and operator groups" and "custom blocks written as project scripts".

Scripts can't run inside a GPU kernel, and a block written in JavaScript would only ever run on the CPU and couldn't be deterministic across executors.

## Decision

**Particle nodes** (category Particle, per-particle sources, `particleNodes.ts`): Age, Lifetime, Age over Lifetime, Particle Position, Particle Velocity, Particle Speed, Particle Size (start size), Particle Colour (start colour), Particle Index (slot), Particle Random (stable per particle, with a Seed setting). Only kernel backends evaluate them; the CPU compiler reports them as `cpuOnly` problems.

**Set Attribute blocks** (`attribute.position`, `.velocity`, `.color`, `.alpha`, `.size`, `.rotation`, `.lifetime`) write a value (any per-particle expression) into an attribute with a mode of set, add or multiply. Position and velocity fit Initialize and Update; colour, alpha and size also fit Output, where they change only that output's drawn value; lifetime fits Initialize. In Update, Set Velocity runs before the particle moves and the others after (0094's update order). Kernel backends only.

**Sub-graphs** are assets, `*.particlesubgraph.json`, format `myco.particlesubgraph@1`: `inputs` and `outputs` (name, type, default), `nodes` and `edges`, where an edge from `input.<name>` reads an input and an edge to `output.<name>` defines an output. A graph uses one as a `subgraph` node whose `settings.asset` names it; its ports are the asset's.

**Custom blocks** are assets, `*.particleblock.json`, format `myco.particleblock@1`: `label`, the `contexts` they fit, `inputs`, `nodes`, `edges` and `blocks` (any blocks, usually Set Attribute); an edge to `block.<blockId>.<input>` drives an inner block's input. A system uses one as a `custom` block whose `inputs.asset` names it; its other inputs are the asset's (the format doesn't warn about them).

**Expansion, not a runtime feature** (`scene/particleSubgraphs.ts`): `expandParticleGraph(graph, resolve)` inlines every sub-graph node and custom block before either compiler runs, prefixing inner ids with `<outer id>~` and turning unwired inputs into constant nodes; nesting works eight levels deep (deeper, or self-reference, is reported and dropped). Both the CPU and kernel compilers see a flat graph, so sub-graphs of uniform operators work on the CPU too. The World player re-expands when a referenced asset changes (`expansionDependencies`); the Particle Graph's problem list, the Inspector and thumbnails expand with the project's loaded assets.

## Alternatives considered

- **Custom blocks as project scripts** (0060's open question). Can't run on a GPU kernel, so a system using one would be stuck on the CPU, and JavaScript floats would differ from the shaders. Graph assets run on every backend that runs their blocks.
- **Custom WGSL/GLSL code blocks.** Powerful, but two languages to write per block (the WebGL2 path is GLSL) and unvalidated code in the kernel; left for later.
- **Sub-graphs evaluated at run time** (a call per node). The compilers would need a notion of scope; inlining gives the same result with no new runtime code, at the cost of compile time growing with use.
- **Embedding sub-graphs in the effect file.** Not reusable across effects, which is the point.

## Consequences

**Positive**
- VFX-Graph-style per-particle logic: read attributes, compute, write attributes, packaged as reusable sub-graphs and blocks.
- No new runtime: expansion is a pure graph-to-graph step with its own tests.

**Negative / costs**
- Set Attribute and Particle nodes need a kernel backend; a system using them on the CPU skips them (reported).
- Editing a sub-graph asset rebuilds every effect using it.
- The Particle Graph doesn't yet show a sub-graph node's ports from its asset or create sub-graph and block assets (they're written by hand or by tools); see open questions.

## Deprecates

0060's open questions on sub-graphs and custom blocks (answered here). Nothing is removed.

## Open questions

- Editor support: a Sub-graph node showing its asset's ports, "Save selection as sub-graph", a custom block editor, and a "Particle Sub-graph" / "Particle Block" asset kind in the Assets menu.
- Custom code blocks (WGSL only, with the kernel's KSL as the shared subset).

## References

- `src/engine/scene/particleSubgraphs.ts`, `particleNodes.ts` (Particle nodes), `particleBlocks.ts` (Set Attribute, Custom block)
- Tests: `src/engine/tests/particleSubgraphs.test.ts`, `particleKernel.test.ts`
