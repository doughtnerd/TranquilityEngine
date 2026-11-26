# 0420. Tweening is a shared Rust crate, linked by the animation core and by a small standalone tween module that UI uses without the animation plugin

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0346, 0370, 0371, 0372, 0374, 0418, 0419

## Context

0418 wave 4 adds CSS transitions and keyframe animation to the UI core. 0419 has Svelte transitions and `animate:` run through a renderer `animate` hook. The plan was a JS tweener plus `bezier-easing`. But the engine already has tweening, in the animation core (0370, 0371, 0372):

- **The API:** `tween(target, field, to, { duration, from, relative, ease, delay, loops, loopMode, time, speed })`, plus `sequence()` and `parallel()`. Handles are awaitable, with `pause`/`resume`/`stop`.
- **Easing:** Penner eases by name, or any engine curve (0346).
- **Clocks:** scaled, unscaled or fixed time.
- **Where it runs:** in the Rust/wasm core, on any component's animatable fields. UI elements are components.

The API matches CSS animation one-to-one:

| CSS | Tween |
|---|---|
| duration, delay | `duration`, `delay` |
| iteration count | `loops` |
| `alternate` | `yoyo` |
| play state | `pause`/`resume` |
| multi-stop keyframes | a sequence |

The problem is size. `myco_anim_bg.wasm` is 879,303 bytes, 352,211 gzipped (measured), and a game with UI but no animation plugin shouldn't load it for a hover fade.

The tween code separates cleanly from the rest of the core:

- **The tween table and value function:** `native/anim/crates/anim-wasm/src/tweens.rs`, 537 lines.
- **What it uses:**
  - `anim-math::ease` (the named easings, 156 lines, used by nothing else);
  - `anim-math`'s quaternion nlerp/slerp (`AosQuat`, also used throughout `anim-graph`);
  - curve evaluation through `anim-sample` on `myco-curve`;
  - the `tween` wire family in `anim-wire` (420 lines);
  - two hooks into the core: the asset arena (curve-asset handles) and `init`'s memory sizing.
- **Sequences** live in `timeline.rs`, mixed with other timeline features.

There's a precedent for exactly this split: `native/common/curve` (`myco-curve`) is one crate linked into both the audio and the animation wasm modules.

## Decision

**We will extract tweening into a shared crate, `native/common/tween` (`myco-tween`), link it into the animation core unchanged in behaviour, and build a small standalone tween module from it. UI animation runs on whichever is loaded.**

- **The crate (`myco-tween`, its own workspace like `myco-curve`, `no_std`).** It holds:
  - the tween table (slots, generations, a fixed size set once, never allocating per frame);
  - `Spec` and its value function;
  - the named easings (moved from `anim-math::ease`);
  - sequences and parallel groups (moved out of `timeline.rs`; the rest of the timeline stays);
  - the `tween` wire family and its TypeScript generator (moved from `anim-wire`, which re-exports it).

  Its dependencies are `myco-curve`, and `anim-math` for `AosQuat`, which stays there because the graph uses it. A plain path dependency is enough; release builds link only what's used.
- **Interfaces to its host, generic and not dynamic.**
  - The curve lookup (a curve-asset handle to a curve) and the memory a host gives the table are type parameters, monomorphised into each module.
  - No trait objects on the per-frame path.
  - The animation core's tween table keeps sizing itself through `init`'s `bytes_needed`, as today.
- **The animation core links it** (`anim-wasm` depends on `myco-tween`). Its wire records, commands, views and timing stay as they are, and the TS-side tween API (`src/plugins/animation/runtime/features/tweens.ts`) doesn't change.
- **The standalone tween module** (`native/tween`, built by `npm run build:tween`) is committed like the other wasm outputs. It goes in `src/engine/tween/wasm/`, so the engine builds without Rust.
  - It exports the tween family only, with its own curve storage for curve eases.
  - Its size gate goes in its build script, like the audio module's.
- **One backend interface in TypeScript** (`src/engine/tween/`, internal): create, control and per-frame update a tween table, reading values and change records.
  - The animation plugin provides it from its core when enabled. The UI core then uses that table, so UI and game tweens share `sequence()`/`parallel()`, and the animation core's wasm loads once.
  - Without the animation plugin, the UI core loads the standalone module the first time a UI animation starts. A game with no UI animation loads neither.
  - Both run the same crate through the same wire records, so results are identical either way.
- **UI timing.** The UI core updates its UI tweens in its own sync step, on the World's unscaled clock, right after it resolves styles. A class change therefore starts its transition in the same frame, with no wait for `animation.Gather`. When the animation plugin's table is the backend, the UI core runs that table's update for UI tweens itself, in a separate time-mode pass, so game tweens keep their lateUpdate order (0370).
- **CSS easing on engine curves.** `ease`, `ease-in`, `ease-out`, `ease-in-out` and `cubic-bezier()` become engine curves with Bezier keys (0346), cached per distinct function. `steps()` becomes a step curve. `bezier-easing` isn't added.
- **Proof that the animation core doesn't slow down.** Before and after the split:
  - the `anim-bench` budget benches: locomotion and rig, matching, and "1,000 tweens ≤ 0.2 ms" (linear and eased);
  - the `anim-meter` fuel pass;
  - the tween tests (`anim-wasm/tests/tweens.rs`, `src/plugins/animation` tween specs);
  - the core's wasm size.

  Results go in the build log. Release builds use `lto = true`, `codegen-units = 1`, `opt-level = 3`, so the crate boundary should leave the generated code unchanged; the benches confirm it.
- **Spike first.** A prototype split measures the standalone module's size (raw and gzip) and runs the benches before this record is accepted. It needs the `wasm32-unknown-unknown` target.

## Alternatives considered

- **UI requires the animation plugin.** Simplest, but every game with UI animation pays 352 KB gzip, even with no skeletal animation.
- **A JS tweener in the UI core, plus `bezier-easing`** (0418 as written). Small, but two tweening engines whose easing and loop behaviour must be kept equal, and UI tweens couldn't join game sequences.
- **Build the animation core in two feature-gated variants** (a tween-only build of `anim-wasm`). It avoids a new crate, but couples the tween module's build to the whole core's crate graph and `init`, and needs conditional compilation through the core.

## Consequences

**Positive**
- One tween implementation for game code, UI transitions, keyframes and Svelte transitions, with one easing vocabulary and one curve editor.
- UI-only games load a small tween module, not the animation core. Games with both load the core once.
- `bezier-easing` isn't needed, and there's no JS tweener to keep in step with Rust.

**Negative / costs**
- A cross-workspace crate move in the animation core, with benches, the fuel pass and size checks to prove it costs nothing.
- One more committed wasm output and build script (`build:tween`).
- Curve eases in the standalone module need their own small curve store, since it has no asset arena.

## Deprecates

- `anim-math::ease` and the tween parts of `anim-wasm/src/tweens.rs`, `timeline.rs` (sequences) and `anim-wire/src/tween.rs`: moved into `myco-tween`. The animation core uses them from there.
- 0418 wave 4's `bezier-easing` and JS tweener: not built.

## Open questions

- The standalone module's size, which the spike measures. If it comes out unexpectedly large, revisit the JS alternative.
- Whether scripts get a UI-facing `tween()` without the animation plugin (`element.animate(...)`, 0418's open question) on the same backend.

## References

- `native/anim/Cargo.toml` (crates, release profile), `native/anim/crates/anim-wasm/src/{tweens,timeline,curves}.rs`, `native/anim/crates/anim-math/src/ease.rs`, `native/anim/crates/anim-wire/src/tween.rs`, `native/anim/crates/anim-bench/benches/budgets.rs`
- `native/common/curve` (`myco-curve`, the shared-crate precedent), `native/audio/build.mjs` (size gates)
- `src/plugins/animation/runtime/{api,types}.ts`, `features/tweens.ts`
- 0346 (curves), 0370 (animation core), 0371 (tracks and tweens), 0372 (scripting API), 0418 wave 4, 0419 (`animate` hook)
