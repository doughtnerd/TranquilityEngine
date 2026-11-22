# 0325. The particle kernel's operators and set statement are written once, in one catalogue, with one width-fit rule

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0094, 0095, 0250, 0251

## Context

0251 put the kernel steps side by side in `render/particles/gpu/kernelSteps.ts` and a unit test holds each
step's KSL to its JavaScript. The kernel IR's expression operators (`KOp`: add … smoothstep, safe division,
remap, normalize, hsv, toLinear; 21) and the `set` statement were still written twice: as KSL emission in
`kernelShader.ts` (`Emitter.op`, `Emitter.stmt`), whose header said it "mirrors `kernelJs.ts` line for line",
and as closures in `kernelJs.ts` (`JsKernel.op`, `JsKernel.stmt`). They were compared only by
`npm run bench:particles` in a browser, whose page no longer runs (0251).

They had drifted where a value is used at another width:

- **A narrower vector written to a wider attribute.** JavaScript padded zeros (`v[i] ?? 0`); `Emitter.fit`
  emitted a prefix swizzle, so a vec2 written to `position` became `v.xyz` on a vec2, which neither WGSL nor
  GLSL compiles. `particleKernel.ts` produces it: a Set Position or Set Velocity block whose value is an
  inline 2-vector or a Compose 2 node (`input(…, "vector")` keeps the value's width). Set Attribute sends
  a system to a GPU executor (`KernelSystem.needs`), whose shader then didn't compile.
- **`toLinear` on anything but a vec4.** KSL fitted the argument to 4 (the same bad swizzle for a vec3, a
  vec4 bound to a scalar temporary for a number); JavaScript converted the first three components. Multiply
  Color with a number or vector input produces it.
- The vector forms of safe division and smoothstep were written per dialect (WGSL `select` with a vector
  condition, GLSL `mix` over `equal`), outside KSL, so the KSL → JavaScript path (0250) couldn't run them.

## Decision

We will write each operator and the set statement once per language in one catalogue, with one width-fit rule
both executors read, and test every one KSL against JavaScript.

- **One operator catalogue.** `render/particles/gpu/kernelOps.ts` holds `KERNEL_OPS: Record<KOp, KernelOp>`,
  each a `{ ksl, js }` pair side by side: `ksl(e, args, w, emitter)` returns the operator's KSL over its
  arguments' KSL (raw and fitted to the result's width; it may bind temporaries), `js(e, args, out)` returns the
  closure over the arguments' closures. Component-wise operators are written as one lane function
  (`lanes(…)`) with the 1-, 2- and n-argument closures the executor had. `KERNEL_OPS_KSL` holds the KSL
  helpers they call: `k_div1..4`, `k_remap1..4`, `k_smooth1..4`, written in KSL (scalar `select`, no vector
  comparisons) so all three outputs of the shader source module run them. `kernelShader.ts`'s `Emitter`
  calls `KERNEL_OPS[e.op].ksl` and `setKsl`; `kernelJs.ts` calls `KERNEL_OPS[e.op].js` and `setJs`; neither
  keeps a copy, and the Emitter no longer takes a dialect.
- **The set statement** is `setKsl` (one write per component, as KSL has no swizzle writes) and `setJs`
  beside it, with the set, add and multiply modes.
- **One width-fit rule.** `fitSource(from, to)`: component i of the fitted value is the value's only
  component when it is a number (it broadcasts), its component i when it has one (a wider value is cut), else
  0 (a narrower vector is padded with zeros). `fitKsl` emits KSL from it (as is, a splat, a prefix swizzle,
  or a constructor padding `0.0`s); the closures index through its map. So a vec2 set into `position` writes
  z = 0 on every executor, and `toLinear` fits to a vec4 and back.
- **The test.** `src/engine/tests/kernelOps.test.ts` runs every operator's KSL as JavaScript (0250's third
  output, which type checks it, so a bad swizzle fails) against its closure, at every result width
  `resultWidth` gives and with arguments of every width that reaches it (numbers that broadcast, wider vectors
  that are cut), on random values including 0 and equal edges; and every set target (each attribute and
  local) in each mode from values of widths 1-4, checking the padded components are 0.
- **The hand-written JavaScript stays** (0251's measurement: the KSL's JavaScript output is ~25× slower).
- The expression leaves (constants, uniforms, attributes, locals, random, look-up rows, swizzle) stay in the
  two executors: they read the executors' own state layouts.

## Alternatives considered

- **Generate the JavaScript operators from KSL** — one text, but 0251 measured the closure interpreter about 25×
  slower per call, and operators run per particle per frame.
- **Keep the prefix swizzle and reject narrower values in `particleKernel.ts`** — would break a Set Position fed
  by a Compose 2 that runs today on JavaScript, and still leave two copies.
- **Keep the per-dialect `select`/`mix` vector forms** — slightly shorter shaders, but they aren't KSL, so no
  test can run them.

## Consequences

**Positive**
- A new operator is one entry in one module, in two languages a unit test keeps in agreement.
- Systems setting a narrower vector into position or velocity, or multiplying a number or vector colour, now
  compile on WebGPU and WebGL2, with the JavaScript executor's result.

**Negative / costs**
- Vector safe division, remap and smoothstep call per-width helper functions (twelve small functions in every
  kernel shader) where they were inline expressions. Not measured on a GPU.
- The component-wise closures read their argument through the fit map (an `Int32Array` index per component)
  instead of a width test. Not measured.

## Deprecates

`Emitter.fit`, `Emitter.sel`, `Emitter.eq`, `Emitter.safeDiv` and `Emitter.op` in `kernelShader.ts`;
`JsKernel.op` and the set branch of `JsKernel.stmt` in `kernelJs.ts`. Removed (2026-11-22).

## Open questions

- Whether to move the expression leaves into the catalogue too (they need a shared frame/globals adapter in the
  test, as the steps have).

## References

- `src/engine/render/particles/gpu/kernelOps.ts`, `kernelShader.ts`, `kernelJs.ts`; `src/engine/tests/kernelOps.test.ts`.
