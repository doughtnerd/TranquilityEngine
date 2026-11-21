# 0315. One particle-effect compile turns an effect into its program, problems and dependencies, for the game and the editor alike

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0060, 0095, 0153, 0185 (amends: compiling moves out of the effect player)

## Context

`compileParticleGraph` (`scene/particleCompile.ts`) needs a graph whose sub-graphs and custom blocks are already
inlined (ADR 0095). Only the Babylon effect player ran the whole sequence (`EffectResources.compile`: parse, expand
with `projectAssets`, collect the expansion's dependencies, compile, warn about the merged problems); the game, the
warm-up and the thumbnails go through it. The editor repeated the sequence three times with its own resolvers:

- the Inspector expanded with `projectAssets` and compiled, keeping only the compiler's problems;
- the Particle Graph expanded with `project.assets.get` and compiled for its problems list;
- the Graph editor's preview compiled the **raw document graph**, unexpanded. A custom block hit the kernel's
  "unknown block" skip, and a wire from a sub-graph output threw in `lowerNode` and fell back to the inline value. So
  any effect with a sub-graph or custom block previewed differently from the game, while the problems list,
  computed from the expansion, stayed clean (confirmed in review 11).

Separately, `scene/particles.ts` kept its own `evalCurve` beside the core's (`core/curve.ts`), whose header already
says a particle curve is a valid `Curve`.

## Decision

We will have one renderer-neutral module say what "the effect as the game sees it" is.

- **The module:** `src/engine/scene/particleEffect.ts`,
  `compileParticleEffect(source, resolve): CompiledParticleEffect`. `source` is `{ raw, where? }` (an effect's JSON)
  or `{ graph }` (a document already parsed); `resolve` is an `AssetResolver` for sub-graph and custom block assets.
  It parses (raw only), expands, compiles and returns `{ graph, program, problems, dependencies }`: `graph` is the
  expanded graph the program was compiled from, `problems` every problem once (parse, expansion, compile, in that
  order), `dependencies` the assets the expansion reads, nested ones included. Nothing throws: a resolver that
  throws reads as a missing asset.
- **The effect player:** `EffectResources.compile(raw, where)` is that call with `projectAssets`, plus warning once
  per problem and its kernel plan. Its callers (`BabylonParticles`, the warm-up, thumbnails) don't change.
- **The editor:** the Particles plugin has one resolver, `projectParticleAssets(project)`, and one call,
  `compileEffectGraph(project, graph)` (`plugins/particles/editor/particleAssets.ts`). The Inspector's problems, the
  Particle Graph's problems and wire types (`graph`), and the preview all read it. The Graph editor hands the
  preview its compiled `program`; `ParticleGraphPreview` takes a program and no longer compiles. An open sub-graph or
  custom block document isn't an effect: the Graph editor only expands it, for the wire rules.
- **Curves:** particle curves are evaluated by `core/curve.ts` `evalCurve`; the particle copy is deleted. Curve and
  gradient node settings are sorted by key on read (`curveSetting`, `gradientSetting`), since the core's evaluator
  needs sorted keys; block input values were sorted already by `parseParticleNumber`.

## Alternatives considered

- **Pass the expanded graph to the preview and let it compile.** Fixes the bug but leaves four copies of the
  sequence, and two compiles per edit in the Graph editor.
- **Make `compileParticleGraph` expand itself.** It would need the resolver and the parse problems; the Graph editor
  also needs the expanded graph for its wire rules, so the sequence wants one interface that returns it.
- **Keep the module in the render layer.** The editor imports nothing from Babylon for this; parsing, expanding and
  compiling are scene-layer work.

## Consequences

**Positive**
- The preview plays what the game plays for sub-graphs and custom blocks, and follows a sub-graph asset edited in
  the project (it recompiles on the project's version).
- One place to change what compiling an effect means; tests drive it through the same call the game makes.
- The Inspector now also lists expansion problems (a missing sub-graph), not only the compiler's.
- One curve evaluator in the engine.

**Negative / costs**
- At a key's exact `t` where two keys share it (a jump), the core evaluator takes the later key's value where the
  particle one took the earlier; a NaN `t` reads the first key, not the last. Neither is reachable from the editor's
  curve tools in practice.

## Deprecates

- The particle `evalCurve` in `scene/particles.ts` (removed; callers import `core/curve.ts`).
- The hand-made parse/expand/compile sequences in `EffectResources.compile`, `ParticleInspector.tsx`,
  `GraphEditor.tsx` and `PreviewPane.tsx` (removed).

## Open questions

None.

## References

- `src/engine/scene/particleEffect.ts`, `particleEffect.test.ts`
- `src/engine/render/babylon/effectPlayer.ts` (`EffectResources.compile`)
- `src/plugins/particles/editor/particleAssets.ts`, `ui/ParticleInspector.tsx`, `ui/particleGraph/GraphEditor.tsx`,
  `ui/particleGraph/PreviewPane.tsx`
- Architecture review 11, candidate 1 and small fix 8 (duplicates).
