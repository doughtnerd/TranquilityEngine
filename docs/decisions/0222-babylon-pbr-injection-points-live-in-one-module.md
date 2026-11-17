# 0222. Babylon's PBR injection points live in one module, asked for by name

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0047, 0052, 0072, 0075, 0081

## Context

Graph materials (`render/babylon/graphMaterial.ts`), water (`water.ts`) and probe blending (`probeBlend.ts`) put code into Babylon's PBR shaders through material plugins. Where Babylon has no named `CUSTOM_*` point, the code goes where a regular expression (a `"!…"` key) matches the include-expanded shader source, and the replacement must restate what it matched. These anchors were spread around: `graphMaterial.ts` exported `ALBEDO_ANCHOR` and `GLSL_ALBEDO_ANCHOR` and kept others private, `water.ts` imported the WGSL one but kept its own copy of the GLSL one, and the GLSL export's only outside user was a test. Each feature held part of the knowledge of what Babylon's expanded PBR shader looks like in WGSL and GLSL, and a Babylon upgrade that moved a statement failed silently: the material drew as plain PBR.

## Decision

We will keep every regex injection point into Babylon's PBR shaders in `src/engine/render/babylon/pbrInjection.ts`.

- **Named points.** `PBR_POINTS` names each point and its stage (`worldPosition`, `albedoBlock`, `reflectivity`, `clearcoatNormal`, `reflectanceFactors`, `probeReflection`, and WGSL-only reads of the layer uniforms). Callers ask by name with `pbrInjections(language, stage, { point: code })` and spread the result beside Babylon's own `CUSTOM_*` keys. No pattern is exported.
- **The module re-declares.** How a point takes code is the module's rule, not the caller's: a *statement* point takes code before (and optionally after) Babylon's statement, which the module restates; an *argument* point takes the call's argument; a *value* point takes a variable's value; an *after* point appends; a *read* point replaces reads of a uniform.
- **Loud misses.** `pbrInjections` throws for a point asked of the wrong stage, for code of the wrong shape, and for a point with no spelling in the asked language (the layer uniforms are function parameters in GLSL).
- **Pinned to Babylon.** `engine/tests/pbrInjection.test.ts` expands Babylon's shipped PBR shaders (both stages, both languages) with Babylon's own include processor and checks that every point matches, so an upgrade that moves one fails there.

## Alternatives considered

- **Keep the anchors with each feature, de-duplicated by export.** It removes the copy but leaves the restate-what-you-matched rule in every caller, and an export only tests use.
- **Fork Babylon's PBR shader source.** Total control, but every Babylon upgrade becomes a merge, against ADR 0075's use of Babylon's material as is.

## Consequences

**Positive**
- A Babylon upgrade that breaks a point fails one test file, in one module.
- Callers write only what they add; the test-only export and water's copy are gone.

**Negative / costs**
- A new kind of patch needs a new point in the module before a feature can use it.
- The WGSL-only reads mean graph materials' physical layers can't move to GLSL without call-site patterns there.

## Deprecates

`ALBEDO_ANCHOR`, `GLSL_ALBEDO_ANCHOR` and `physicalCustomCode`'s raw keys (now the private `physicalPoints`, which names points): removed.

## Open questions

None.

## References

`src/engine/render/babylon/pbrInjection.ts`, `graphMaterial.ts`, `water.ts`, `probeBlend.ts`; `src/engine/tests/pbrInjection.test.ts`, `shaderAssets.test.ts`, `babylonWater.test.ts`.
