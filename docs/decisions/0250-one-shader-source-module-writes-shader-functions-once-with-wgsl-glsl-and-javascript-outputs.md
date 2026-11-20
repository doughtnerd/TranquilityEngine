# 0250. One shader source module writes shader functions once, with WGSL, GLSL and JavaScript outputs

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0072, 0081, 0094, 0110, 0112, 0225

## Context

Every Babylon shader the engine writes ships twice, WGSL for WebGPU and GLSL for the WebGL2 fallback, and
the two were kept in step by hand:

- The particle kernels already had one source language, KSL (`ksl()`, macros over the common subset of
  WGSL and GLSL, ADR 0094), but it lived privately in `render/particles/gpu/kernelShader.ts`.
- `render/water/gerstner.ts` documented `GERSTNER_BODY` (a `$float`/`$int` template) as shared by WGSL,
  GLSL and JavaScript, but only the GLSL plugin used it; the WGSL wave sum in `render/babylon/water.ts` was a
  hand-written twin, so the CPU buoyancy sampler's test checked only the GLSL text, while WebGPU (the main
  path) ran code no test compared. The water's ripple noise was a WGSL/GLSL pair whose comments pointed at a
  deleted `waterShader.ts`.
- Height fog (`heightFog.ts`), the finish pass (`finishShader.ts`, grading and the AgX/ACES/Neutral curves)
  and the procedural sky (`sky/skyShader.ts`, ~230 lines each way) were WGSL strings beside GLSL strings,
  "keep the two in step". Tests either checked the text or ran it through regular-expression translators in
  the test folder (`tests/shaderMaths.ts`, a WGSL/GLSL-to-JS rewrite in `babylonWater.test.ts`).
- The particle kernels' hashes and noise exist in TypeScript (`kernelMath.ts`, the JavaScript executor) and
  in KSL; their agreement was checked only in a browser bench.

## Decision

We will keep one **shader source module**, `src/engine/render/shaderSource/`, that turns one KSL text into
three outputs, and write each shader function once in it.

- **Interface.** `shaderSource(...parts)` joins KSL texts (or other sources) into a `ShaderSource` with
  `ksl` (the text), `text(dialect, { declarations })` (WGSL or GLSL; `declarations: "omit"` leaves
  `UNIFORM`/`TEXTURE2D` declarations to a material plugin's uniform buffer) and `js(options)` (a
  `KslProgram` whose functions are callable from JavaScript, with `defines`, `uniforms` and `textures`).
  `fl(n)` writes a float literal. Owning modules export `ShaderSource` values, not dialect strings.
- **Language.** KSL keeps 0094's rules (types `KF`…`KV4`, `KU`, `KI`, `KB`, `VAR`, `GLOBAL`, `FN`,
  `KBITU`, no ternaries, braces everywhere, no implicit int/float conversion) and adds what the render
  shaders need: `KM3`, fixed arrays `T[N]` and their constructors, `CONST`, `UNIFORM`/`UNI(name)`
  (`uniforms.name` in Babylon's WGSL, `name` in GLSL), `TEXTURE2D`/`KTEX` (level-0 sampling), scalar-condition
  `select` and `atan2` spelled per language. Preprocessor lines pass through to Babylon and are evaluated
  with `defines` in JavaScript. The language reference is the head of `shaderSource.ts`.
- **JavaScript output.** `kslJs.ts` parses KSL, checks its types (so text that one GPU compiler would refuse,
  such as `f32 + i32` or a multi-component swizzle write, fails in a unit test), and compiles each function
  to closures, without `eval` (strict CSP, as `kernelJs.ts`). Integer maths wraps like the GPU's (`KU` is a
  uint32, `KI` an int32); floats are doubles.
- **What moved onto it.**
  - The particle kernel shaders import `shaderSource`/`fl` (their private `ksl()` is gone); the hashes,
    noise and colour helpers moved next to their TypeScript twins as `kernelMath.ts`'s `KERNEL_MATH_SHADER`.
    Generated particle WGSL/GLSL is byte-identical to before.
  - `gerstner.ts`: `GERSTNER_SHADER` (`mycoGerstner(px, pz, count)`, reading the waves as vec4 uniforms) and
    `waveUniforms(packed)` (the packing the water plugin binds) replace `GERSTNER_BODY`. `water.ts` writes
    the ripple noise, ripple slope and shallow/foam amounts once in KSL; only Babylon's injection glue is
    per language.
  - Height fog: the amount, factor and fogged colour are KSL; `heightFogShader()` returns
    `{ source, uniforms }` and custom shaders (kernel particle draws) take `source.text(dialect)`.
  - Finish pass: the LUT lookup, tone curves, sRGB encode, grade/vignette/exposure and display steps are
    KSL; each language keeps only its entry point.
  - Sky: the whole `skyColor` body (atmosphere, clouds, stars, discs, fog) is one KSL text.
- **Tests run the JavaScript output of the very text the GPU compiles,** through the owning module's
  interface: `GERSTNER_SHADER.js()` against `gerstner()` (exact, and within float precision on f32
  uniforms), the water plugin's bound uniforms against `WaterSurface.sample`, `heightFogShader().source.js()`
  against the analytic fog integral, and `KERNEL_MATH_SHADER.js()` against `krand`, `particleSeed`,
  `noise3`, `valueNoise`, `hsv` and `srgbToLinear`. Text tests check the plugins splice
  `source.text(dialect)` in, and render tests still read the shader Babylon compiles (0225).
- **Glue stays per language.** `probeBlend.ts` is left as two strings: it is only calls into Babylon's own
  per-language helpers (`computeCubicCoords`, `sampleReflectionTexture`, whose GLSL form takes an out
  parameter), with no maths of its own to share. `graphMaterial.ts`'s `glslCustomCode` is likewise injection
  glue for the shader graph compiler's own GLSL output (0106).

## Alternatives considered

- **Keep the twins and add parity tests per pair** — every pair would need its own WGSL-to-JS and GLSL-to-JS
  translator (as the tests had grown), and a fix would still be two edits.
- **Write everything in WGSL and translate to GLSL with a WGSL parser (naga/Tint in the browser)** — a large
  dependency or a much bigger translator; it doesn't give a JavaScript output; Babylon's WGSL dialect
  (`uniform`, `varying`, `#ifdef`) isn't plain WGSL anyway.
- **JavaScript output as source text run with `new Function`** — smaller, but unusable at runtime under the
  player's strict CSP, which rules out the kernel executor reusing it (0251).

## Consequences

**Positive**
- A shader maths fix is one edit; the WebGL2 fallback can't drift from WebGPU on the moved functions.
- The CPU twins (buoyancy sampler, kernel hashes and noise, fog) are checked against the shader text in
  `npm test`, without a browser.
- KSL is now a render library rather than a particle detail, and a target the shader graph could compile to.

**Negative / costs**
- KSL is a subset: authors work without ternaries, vector comparisons or implicit conversions, and
  `select` takes a scalar condition. Generated WGSL uses `var` everywhere.
- The JavaScript output is an interpreter of closures, far slower than hand-written JavaScript; CPU paths
  that run per frame (`sampleWaves`) keep their TypeScript twin, tested against it.
- `water.ts` binds wave uniforms from a record (`waveUniforms`) instead of two typed arrays.

## Deprecates

`GERSTNER_BODY`; `kernelShader.ts`'s exported `ksl()`, `fl()` and `ShaderDialect` (now the shader source
module's); `heightFogShader(language)`'s `decl` string (now `heightFogShader().source`); the hand-written
WGSL/GLSL twins in `water.ts`, `heightFog.ts`, `finishShader.ts` and `sky/skyShader.ts`; the
regular-expression shader translators in `babylonWater.test.ts` and `heightFog.test.ts`. `tests/shaderMaths.ts`
stays for the soft-particle plugin's snippet test (its text is Babylon glue, not KSL).

## Open questions

- **WebGL2 graph materials (0081's open question):** shader graphs compile to WGSL, plus GLSL for shader
  assets (0106). Whether the graph compiler should target KSL to get WGSL, GLSL and a JavaScript preview from
  one output is left for a graph record.
- The particle kernel's KSL emitter still writes some dialect-specific KSL (`select` vs ternary, `equal()`
  for vector conditions); 0251 decides whether the steps' JavaScript comes from KSL.

## References

- `src/engine/render/shaderSource/shaderSource.ts`, `kslJs.ts`; `src/engine/tests/shaderSource.test.ts`
- `src/engine/render/water/gerstner.ts`, `render/babylon/water.ts`, `heightFog.ts`, `finishShader.ts`,
  `sky/skyShader.ts`, `render/particles/gpu/kernelMath.ts`, `kernelShader.ts`
- Migration check: every generated WGSL/GLSL string was diffed against the shipped one (particle shaders
  identical; the others equivalent), and the WGSL compiled in Chromium's WebGPU (SwiftShader) and the GLSL in
  its WebGL2, before and after.
