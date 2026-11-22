# 0344. Plugin glue, fuel and worklet compile rules follow the B0 spike

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0338)
- **Related:** 0338, 0157, 0179

## Context

ADR 0338 (third-party DSP effects as sandboxed wasm modules called inside the core's chains) asked for a spike before
building (B0). It ran in V8 (Node 22, Chromium 153); WebKit and Firefox builds couldn't be installed in the build
container. Results: `docs/design/audio-studio/spikes/0338-b0.md` (raw data in `tools/spikes/fx-plugin/results/`).
The architecture holds; several details of 0338 need the measured numbers.

## Decision

We will keep 0338's architecture and change these rules:

1. **Glue.** Copies use `TypedArray.set` on views cached per slot; the output scan (|x| ≤ 64, NaN) runs in a small
   trusted SIMD wasm helper per module that imports the plugin's memory. Budget ≈0.25 µs per call (measured 0.18–0.34
   µs; 32 instances ≈ 0.3% of a quantum). Multi-memory stays out of v1.
2. **Fuel.** An i32 global, decremented per segment (so counts stay exact) but checked only at function entries and
   loop headers, with a branch-free check (a byte load from `fuel >> 31`, which traps once fuel is negative). The
   `if … unreachable` form cost +157% on a tremolo in V8 12.4. Measured overhead 0–30% on realistic kernels (≤ 8% on a
   biquad cascade and a delay), replacing 0338's "20–50%". B1 keeps a tremolo-like kernel in its tests against the
   branch cliff, and `count` mode stays bit-identical to today's `meter()`.
3. **Budgets.** A per-quantum fuel cap shared by all plugin instances (default 5,000 instructions per frame across a
   chain level), and the per-effect maximum lowered from 20,000 to 5,000 per frame: 32 runaway instances could
   otherwise hold the audio thread ≈30 ms.
4. **Worklet compile.** The main thread validates and instruments, then transfers bytes; the worklet compiles with
   async `WebAssembly.compile` (falling back to sync), keeps the `Module` for every re-instantiation, and warms each new
   instance with one `create`/`process`/`destroy` on silence before it goes live (V8 compiles lazily: ≈1.2 ms per
   100 KB on first call). A compiled `Module` can't be posted over a node's port; it can arrive via `processorOptions`.
5. **Faults.** Memory growth during `process` is a module fault (re-instantiate; it detaches views). The SDK ships an
   allocator that frees. Recovery measured 0.04–0.16 ms per module.
6. **Engines.** Re-run the spike on JavaScriptCore and SpiderMonkey before B4 (worklet glue) merges; until then the
   capability stays off on non-Chromium engines if any of 1–5 fails there.
7. The spike report's home is `docs/design/audio-studio/spikes/0338-b0.md` (not the path 0338 named).

## Alternatives considered

- **Keep 0338 as written** — its fuel check and JS scan miss the measured costs (+157%, ≈300 ns a call).
- **i64 fuel** — never cheaper, and BigInt per call from JS.

## Consequences

**Positive**
- Plugin calls cost a fraction of a quantum; fuel is affordable; runaway plugins are bounded.

**Negative / costs**
- A per-module helper wasm; a stricter budget plugin authors must fit (measured kernels fit easily).
- Two engines unmeasured until a machine with them runs `tools/spikes/fx-plugin/run.mjs`.

## Deprecates

0338's fuel check form, its 20,000 per-frame maximum and its report path.

## Open questions

- JSC and SpiderMonkey numbers.

## References

`docs/design/audio-studio/spikes/0338-b0.md`; `tools/spikes/fx-plugin/`; `spikes/fx-plugin/`.
