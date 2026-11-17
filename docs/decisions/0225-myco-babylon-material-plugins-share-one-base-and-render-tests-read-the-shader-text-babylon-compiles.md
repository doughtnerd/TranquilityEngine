# 0225. Myco's Babylon material plugins share one base, and render tests read the shader text Babylon compiles

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0075, 0188, 0222

## Context

Graph materials, water, probe blending and sprite UVs patch Babylon's PBR shaders through material plugins (ADR 0222 keeps the regex injection points in `render/babylon/pbrInjection.ts`). Two things about them were each done several ways.

**Registering.** Babylon's `MaterialPluginBase` constructor registers a plugin with its material, and registering asks the plugin for its code and defines before a subclass has set the fields that code reads. `probeBlend.ts`, `graphMaterial.ts`, `water.ts` and `layeredQuads.ts` each passed `false` to the base constructor, then cast to reach `_pluginManager._addPlugin(this)`, called `_enable(true)`, declared the languages they support and repeated a "register after the fields are set" comment.

**Testing what a plugin puts in the shader.** Render tests applied a plugin's `getCustomCode` to shader source themselves, and disagreed. `materialMaps.test.ts` and `physicalGraph.test.ts` replaced the `"!"` keys in Babylon's raw `pbrPixelShaderWGSL.shader`. The pin test (`pbrInjection.test.ts`) expanded includes first. `reflectionProbes.test.ts` fetched raw source by hand and counted matches. `babylonGraphMaterial.test.ts` searched raw source with a plugin's key and in one place spelled a private regex key in full. `babylonWater.test.ts` and `shaderAssets.test.ts` picked the `"!"` entry out of the code map. `spriteBatching.test.ts` checked that named points exist in raw source. Five tests made a WGSL NullEngine by writing the protected `_isWebGPU` through a cast. None of these reproduced Babylon's own application of the code: includes, every plugin's code in order, `$n` substitutions and the plugins' uniform declarations. Some read private spellings that ADR 0222 says only the injection module holds.

## Decision

We will give the engine's own field-dependent Babylon material plugins one base. Render tests will check plugin code in the shader text Babylon itself produces for a material.

- **`render/babylon/mycoMaterialPlugin.ts`: `MycoMaterialPlugin`.** It is an abstract subclass of `MaterialPluginBase`. Its constructor takes the material, name, priority and defines and does not register. A subclass sets its fields and calls the protected `register()` last, which adds the plugin to its material's plugin manager and enables it. Its `isCompatible` declares WGSL and GLSL. A plugin with code in fewer languages overrides that, as graph materials do (`graphSupports`). `MycoGraphPlugin`, `MycoWaterPlugin`, `MycoProbeBlendPlugin` and `SpriteUvPlugin` extend it and supply only their defines, uniforms, samplers, binding and code. Behaviour is unchanged. The sprite UV plugin's `isCompatible` used to return true for any language, and Babylon has only these two. The base is internal: Babylon stays out of the public API (ADR 0010).
- **`engine/tests/pbrShaderSource.ts` (test support).** `nullEngine(language)` returns a NullEngine whose materials are WGSL or GLSL. A NullEngine subclass sets the protected `isWebGPU` flag, which is the only thing Babylon reads to choose a material's language. `shaderText(material, mesh?)` puts the material on a mesh (a unit box by default). It waits until `material.isReadyForSubMesh` holds, then returns the effect's public `vertexSourceCode`, `fragmentSourceCode` and `defines`. The helper models nothing. On a NullEngine this text comes from Babylon's own processing:
  - `ShaderProcessor.Process` expands the includes.
  - The material's `processCodeAfterIncludes` runs `MaterialPluginManager._injectCustomCode`, which handles named `CUSTOM_*` points, `"!"` regular expressions with `$n` substitution, and `ADDITIONAL_*_DECLARATION` uniforms.
  - With no platform processor, the `#if` blocks stay unevaluated, so every branch is in the text.
  `graphPluginCode.ts` adds `graphShaders(compiled, language)`, which gives the text for a graph material and for its shadow-depth material. Each call uses a fresh engine, because Babylon caches effects per engine by defines and test graphs share a key.
- **What tests assert.** Tests assert on that text: code present, in order (`indexOf`), a replaced uniform read gone, a define on or off in `defines`. The probe-blend define check goes through a material's compiled defines instead of calling `prepareDefines` through a cast. Outside `pbrInjection.test.ts`, no test reads a `"!"` key or spells an injection pattern, and none writes `_isWebGPU`. Tests may still read Babylon's named `CUSTOM_*` entries from `getCustomCode`, which is Babylon's public plugin contract.
- **The pin test reads the same text.** `pbrInjection.test.ts` takes Babylon's expanded PBR shaders from `shaderText` of a plain PBR material, and still checks that every point matches where the module says (ADR 0222).

## Alternatives considered

- **Model `_injectCustomCode` once in a test helper.** That would mean expanding includes with `ProcessIncludes` and replacing keys the way Babylon does. A copy of Babylon's logic drifts on upgrade without failing. The effect's source text runs Babylon's real code through public getters.
- **A factory (`X.attach(material, ...)`) in place of `register()`.** It has the same one call per feature, and a plain `new X()` would still produce an unregistered plugin. The protected call keeps construction as callers already write it.
- **Composition: one plugin class fed a spec object of hooks.** It re-wraps most of Babylon's plugin interface for four users.
- **Move height fog, soft particles and kernel particles onto the base now.** They register inside the base constructor and read the material, or a module-level `constructing` slot, instead of their own fields. Moving them is a separate change, and nothing here needs it.

## Consequences

**Positive**
- A plugin's code is tested where Babylon actually puts it, after other plugins, with includes and declarations. A pattern that stops matching, or code that never registers, fails the feature's own test as well as the pin.
- Registration, enabling and language support live in one place. The cast to `_addPlugin` is gone, because the method is declared on `MaterialPluginManager`.
- WGSL test engines have one spelling.

**Negative / costs**
- Render tests that read shader text are async, and each builds an effect, which takes a few milliseconds.
- The text has `#if` blocks unevaluated, so a test of which branch compiles reads `defines`, not the text.
- A subclass that forgets `register()` gets a plugin that never attaches. Its tests catch that, the compiler does not.

## Deprecates

Removed: the per-test injection copies (`inject` in `materialMaps.test.ts` and `physicalGraph.test.ts`, the raw-source matching in `reflectionProbes.test.ts`, `babylonGraphMaterial.test.ts` and `spriteBatching.test.ts`), `codeAt` in `graphPluginCode.ts`, the `ProcessIncludes` call in `pbrInjection.test.ts`, every test's `_isWebGPU` cast, and the four plugins' own `_addPlugin` casts, `_enable` calls and `isCompatible` overrides (graph materials keep theirs).

## Open questions

- Whether height fog, soft particles and kernel particles should move onto `MycoMaterialPlugin`. For kernel particles this would replace the module-level `constructing` slot with ordinary fields.

## References

`src/engine/render/babylon/mycoMaterialPlugin.ts`, `graphMaterial.ts`, `water.ts`, `probeBlend.ts`, `layeredQuads.ts`; `src/engine/tests/pbrShaderSource.ts`, `graphPluginCode.ts`, `pbrInjection.test.ts`, `materialMaps.test.ts`, `physicalGraph.test.ts`, `reflectionProbes.test.ts`, `babylonGraphMaterial.test.ts`, `babylonWater.test.ts`, `babylonParticles.test.ts`, `shaderAssets.test.ts`, `spriteBatching.test.ts`. Babylon 9.32: `Materials/materialPluginManager.pure.js` (`_addPlugin`, `_injectCustomCode`), `Engines/Processors/shaderProcessor.js` (`Process`), `Materials/effect.pure.js` (`vertexSourceCode`, `fragmentSourceCode`).
