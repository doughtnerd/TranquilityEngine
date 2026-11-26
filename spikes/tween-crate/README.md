# Tween crate split spike (ADR 0420)

The spike ADR 0420 calls for before it can be accepted. It is a prototype split, not finished engine code. It checks two things:

1. Does moving tweening out of the animation core into a shared crate cost the core anything? Speed, size and behaviour are all checked.
2. How big is a standalone tween module built from that crate? UI would load it when the animation plugin isn't enabled.

## What was built

| Where | What |
|---|---|
| `native/common/tween` (`myco-tween`) | Its own workspace, `no_std` + `alloc`. It holds the tween table (`table.rs`), `Spec` and its value function (`spec.rs`), and the Penner easings (`ease.rs`). It also holds the sequence and parallel *program* (`seq.rs`), the curve key parser and a small `CurveStore` (`curves.rs`), the `tween` wire family (`wire.rs`), and the status, pass and handle codes (`host.rs`). |
| `native/common/wire` (`myco-wire`) | The boundary-record mechanism (`record.rs`, `wire_record!`, `vector.rs`), moved out of `anim-wire` unchanged except `std` → `core` + `alloc`. |
| `native/anim` | `anim-wasm` links `myco-tween`. Its `tweens.rs` went from 537 lines to 31: the table's share of `init`'s memory, plus `impl Curves for Arena`. `timeline.rs` uses `myco_tween::seq`. `anim-wire` re-exports `myco_wire::{record, vector, wire_record}` and `myco_tween::wire as tween`. A compile-time assert holds `myco_tween::host`'s codes equal to the `core` family's. |
| `native/tween` (`myco-tween-wasm`) | The standalone module: the tween calls behind wasm-bindgen, with a `CurveStore` for curve eases. `node native/tween/build.mjs` builds it into `native/tween/pkg/` (gitignored) and prints the size table below. There is no `npm run build:tween`, nothing under `src/engine/tween/`, and no size gate yet. Those are for the real implementation. |

The wire format, the core's exports and its JS glue are unchanged. `npm run build:anim` regenerated every `wire/<family>.ts` byte for byte; only the `.wasm` files and `hash.json` changed. The TypeScript tween API wasn't touched.

## How the numbers were taken

- **Machine:** this session's container, a shared 4-vCPU VM, 2026-11-26 04:38–05:05 UTC. Nothing else heavy ran during the timed runs.
- **Before:** a clean checkout of `a6530aa8`, the commit that proposes 0420, in a separate worktree. Its `native/` and `src/plugins/animation/` are identical to this branch's base, `d73ad72d`.
- **After:** this branch.
- **Benches:** `cargo bench -p anim-bench --bench budgets`, natively, criterion defaults. Three rounds, alternating before and after (B, A, B, A, B, A), so drift hits both sides. A second set ran `tweens_1000` alone with `--measurement-time 10`, four alternating rounds. The tables show criterion's point estimates. The raw output is in [results/](results/) (`python3 results/summarise.py results/all`).
- **Noise:** the `characters_100` crowd scenarios run no tween code at all, yet they move ±10% between rounds of the *same* tree. Read every Δ below against that.
- **Sizes:** `npm run build:anim` in each tree. gzip is level 9 and brotli quality 11, both from Node's zlib. The rebuilt wasm was measured, then checked out again: it isn't committed here.

## Before and after: the benches (µs per frame)

All 13 budget benches, 3 alternating rounds:

| Bench | Before (3 rounds) | After (3 rounds) | Before median | After median | Δ |
|---|---|---|---:|---:|---:|
| characters_100/one_clip/60_bones | 416.1 / 396.9 / 367.3 | 371.6 / 389.4 / 386.6 | 396.9 | 386.6 | −2.6% |
| characters_100/crossfade/60_bones | 464.4 / 528.6 / 479.4 | 508.4 / 518.8 / 465.0 | 479.4 | 508.4 | +6.0% |
| characters_100/locomotion/60_bones | 772.6 / 755.3 / 729.5 | 799.2 / 785.6 / 771.9 | 755.3 | 785.6 | +4.0% |
| characters_100/locomotion_rig/60_bones | 989.1 / 955.9 / 922.8 | 1050.1 / 898.8 / 937.4 | 955.9 | 937.4 | −1.9% |
| characters_100/one_clip/80_bones | 451.0 / 437.6 / 460.0 | 496.0 / 454.4 / 454.7 | 451.0 | 454.7 | +0.8% |
| characters_100/crossfade/80_bones | 606.6 / 633.3 / 578.0 | 613.3 / 656.7 / 599.3 | 606.6 | 613.3 | +1.1% |
| characters_100/locomotion/80_bones | 899.8 / 870.5 / 835.4 | 920.3 / 929.3 / 959.4 | 870.5 | 929.3 | +6.8% |
| **characters_100/locomotion_rig/80_bones** (budget 1.5 ms) | 1035.5 / 1172.2 / 1061.4 | 1128.1 / 970.0 / 1138.1 | 1061.4 | 1128.1 | +6.3% |
| **matching_20/kd_tree/6_frames** (budget 0.6 ms per frame) | 458.9 / 451.6 / 411.2 | 454.6 / 444.2 / 435.3 | 451.6 | 444.2 | −1.7% |
| matching_20/brute_force/6_frames | 10193.0 / 9455.7 / 9667.5 | 9002.9 / 9304.4 / 9070.5 | 9667.5 | 9070.5 | −6.2% |
| tweens_1000/linear | 14.1 / 13.2 / 13.5 | 13.7 / 15.4 / 14.2 | 13.5 | 14.2 | +5.2% |
| tweens_1000/eased | 20.1 / 19.3 / 21.8 | 20.8 / 21.9 / 19.9 | 20.1 | 20.8 | +3.5% |
| tweens_1000/vec3_quat | 48.3 / 48.2 / 47.3 | 42.4 / 42.0 / 49.2 | 48.2 | 42.4 | −12.0% |

`tweens_1000` alone, 10 s measurements, 4 alternating rounds:

| Bench (budget 200 µs) | Before (4 rounds) | After (4 rounds) | Before median | After median | Δ |
|---|---|---|---:|---:|---:|
| tweens_1000/linear | 15.0 / 13.5 / 14.2 / 14.8 | 14.6 / 14.3 / 14.1 / 14.3 | 14.8 | 14.3 | −3.0% |
| tweens_1000/eased | 22.9 / 20.6 / 21.3 / 23.8 | 21.0 / 21.4 / 21.8 / 20.0 | 22.9 | 21.4 | −6.7% |
| tweens_1000/vec3_quat | 46.8 / 45.9 / 48.4 / 47.7 | 46.0 / 46.2 / 49.7 / 46.5 | 47.7 | 46.5 | −2.5% |

The previous run's log recorded 14.8 µs (linear) and 22.0 µs (eased) on the unmodified tree, in line with the "before" column.

**Reading:** no change beyond the noise. The rounds overlap on every row, and the tween rows, the only code that moved, land at or below the baseline with the longer measurement. All three scenarios stay far inside their budgets: 1,000 tweens take 14–47 µs against 200 µs.

## Before and after: size, tests, fuel pass

| Check | Before | After |
|---|---|---|
| `myco_anim_bg.wasm` raw | 879,335 B | **879,015 B (−320)** |
| gzip -9 | 352,956 B | 352,789 B (−167) |
| brotli 11 | 273,526 B | 273,747 B (+221) |
| `myco_anim_editor_bg.wasm` raw | 1,036,664 B | 1,036,855 B (+191) |
| `cargo test --workspace` in `native/anim` | 580 passed, 3 ignored | 574 passed, 3 ignored |
| `cargo test` in `native/common/tween` | — | 8 passed (the 5 easing tests moved from `anim-math`, 3 table and curve-store tests) |
| `cargo test` in `native/common/wire` | — | 1 passed (the `wire_record!` doctest, moved from `anim-wire`) |
| `cargo test` in `native/tween` | — | 2 passed |
| Fuel pass: `cargo test --release -p anim-meter` | 14 of 14 | 14 of 14 |
| `anim-wasm --test plugin_fixtures` (metered sample node) | 1 of 1 | 1 of 1 |
| `npx vitest run src/plugins/animation`, with the rebuilt wasm | — | 96 files, 748 tests pass |

- **Tests:** the 6 missing in `native/anim` are accounted for. Six easing tests left `anim-math`, which gained 1 for `exp2`, and the `wire_record!` doctest left `anim-wire`. In total the suite went from 580 to 583 tests.
- **Committed wasm:** the before tree's own rebuild differs from its committed wasm, 879,303 B with hash `d177e8…`. So the committed module doesn't reproduce exactly in this container. That is unrelated to this spike, and both columns above are rebuilds made here.
- **Source hash:** it covers `native/common/`, so the split changes the core's source hash (`2ed1fb…`). With the committed, un-rebuilt wasm checked out, `sourceHash.test.ts` fails on this branch, as expected. Adopting the split means committing a rebuilt core.

## The standalone module

`node native/tween/build.mjs`, release profile as the core's (`lto`, `codegen-units = 1`, `opt-level = 3`, `panic = "abort"`), `+simd128`, names and producers stripped:

| Build | Raw | gzip -9 | brotli 11 |
|---|---:|---:|---:|
| **wasm-bindgen output** | **30,077 B** | **13,789 B** | **11,856 B** |
| `wasm-opt -O3` (Binaryen 108) | 27,988 B | 12,854 B | 11,152 B |
| `wasm-opt -Oz` | 27,702 B | 12,855 B | 11,198 B |
| JS glue (`myco_tween.js`) | 8,486 B | 2,135 B | 1,848 B |

- **Against the core:** wasm plus glue is about 16 KB gzip, **4.5% of the animation core's 353 KB**, so a UI-only game saves about 337 KB gzip. That is well under any size where the JS alternative would win back much. A JS tweener plus `bezier-easing` would still be a few KB, but it would be a second implementation.
- **wasm-opt:** saves 7% raw and gzip. That's worth having once the build pins Binaryen, but it doesn't change the answer.
- **What the code is**, by function, before wasm-bindgen strips its describe functions (about 31.6 KB):
  - about 10.8 KB is the tween code (`update` alone 3.0 KB with the easings and quaternion maths inlined, `parse_keys` 1.9 KB);
  - about 10.3 KB is the allocator (dlmalloc) and `Vec` growth;
  - about 5.9 KB is panic and formatting machinery;
  - about 3.4 KB is wasm-bindgen glue.

  A smaller allocator, or `panic = "abort"` with `panic_immediate_abort`, could take off up to half. That isn't needed.
- **Sequences:** the module doesn't export them (see below). A sequence player would add a few KB.

## Wrinkles

- **What moved out of `timeline.rs`:** only the *program*. That is `Member` (a `Spec` at an offset with a host id and a done flag), `seq::duration`, and `seq::eval`, which evaluates every member at a sequence time and lists the members that completed, in end-time order. Playback stays in the core's timeline, because a sequence there *is* a timeline instance. That covers the playhead, wrap modes, speed, seek, pause, the `SEQ_CREATE`/`SEQ_MEMBER` records, the value and weight blocks, and `CHANGE_MEMBER_DONE`. `timeline.rs` went from 1,436 to 1,418 lines. `seq::eval` writes values through a closure, monomorphised like the curve lookup, so the core keeps its own block layout. The ADR's "sequences and parallel groups (moved out of `timeline.rs`)" overstates what can move. For UI sequences without the animation plugin, the standalone module needs a small sequence player of its own on `myco_tween::seq`. Keyframes could instead be built as delayed tweens, which needs nothing new.
- **The curve-asset handle interface:** `trait Curves { fn curve(&self, handle: u32) -> Option<&[Key<f32>]>; }`.
  - It's a type parameter of `Spec::eval`, `Tweens::update` and `seq::eval` (`C: Curves + ?Sized`), so there's no `dyn` on the per-frame path.
  - The animation core implements it on its `Arena`. The standalone module implements it on `CurveStore`, a generation-checked handle table. `()` means "no curves".
  - **Constraint:** a curve handle must be at least `1 << 16`. That holds for both handle layouts (`generation << 16 | index`, generations from 1). It is how an `ease` field tells a curve handle from an easing id (≤ 30), and `host.rs` documents it.
  - A released or wrong-kind handle eases linearly in both modules, as before.
- **Init sizing:** the core's table still sizes itself through `init`'s `bytes_needed` (`Tweens::bytes_for(DEFAULT_MAX_TWEENS)`), unchanged. The standalone module has no `init`. Its table starts empty and `tweens_configure(max)` sizes it, with `tween_bytes_for(max)` to say what that costs. A create before then answers `STATUS_FULL`, where the core would answer `STATUS_NOT_INITIALIZED`. **The ADR says "the memory a host gives the table" is a type parameter. The spike didn't do that and recommends against it.** Both hosts allocate from the global allocator once, when the table is sized, and never per frame. A storage type parameter would only reshape that one allocation.
- **Why `native/common/wire` was introduced:** the `tween` family is declared with `anim-wire`'s `wire_record!` macro and record types.
  - If `myco-tween` depended on `anim-wire`, `anim-wire` couldn't re-export the family. That re-export is what keeps `anim_wire::tween` and the generator's family table working unchanged, and the two dependencies would form a cycle.
  - It would also tie the standalone module to the core's boundary crate, which is `std`-only and holds every family.
  - So the mechanism went one level down, into `myco-wire`, used by both. Only `record.rs` (the `WireRecord` trait, `wire_record!`, the descriptors) and `vector.rs` moved.
  - **The TypeScript generator stays in `anim-wire`.** It walks `anim-wire`'s `FAMILIES` table, which still lists `tween` through the re-export, so `wire/tween.ts` is generated exactly as before. The ADR said the generator moves with the family. It doesn't need to.
- **Why `anim-math` and `anim-match` changed:**
  - `anim-math::ease` moved to `myco_tween::ease`, as the ADR says. But the ADR's "used by nothing else" missed that `ease.rs` also held the deterministic `exp2`, which `anim-match`'s springs use.
  - `exp2` stayed in `anim-math`, moved to `anim_math::trig::exp2` beside `sin_cos`. `anim-match` changed its import, and `anim-math` keeps an `exp2` test.
  - `AosQuat` stays in `anim-math`, as the ADR says. So `myco-tween` has a cross-workspace path dependency on `native/anim/crates/anim-math`, and through it on glam with `std`. The crate is `no_std` in its own source but not in its dependency graph. On `wasm32-unknown-unknown` that is harmless.
- **Why `anim-sample` changed:** the standalone `CurveStore` needs the curve key parser (`parse_keys`, 7 floats per key → baked `myco_curve::Key`), and the module mustn't link `anim-sample` (which pulls in `anim-format`). The parser moved to `myco_tween::curves`, and `anim_sample::curve` re-exports it unchanged. The dependency now runs from `anim-sample` to `myco-tween`, which reads oddly. `parse_keys` is pure curve code, and its natural home is `myco-curve` (behind an `alloc` feature, since the audio core doesn't need it). That touches the crate the audio core links, so the spike left it for the record to decide.
- **Bit-identical results:** the standalone module builds with `+simd128` like the core, so glam's quaternion maths takes the same code path in both. Both modules return the same statuses, because `anim-wire` asserts `myco_tween::host` against its `core` family at compile time.

## Recommendation

**Accept 0420, with changes.** The split costs the animation core nothing measurable:

- benches within noise;
- 320 B smaller raw;
- the wire format, exports and glue byte-identical;
- every test passing.

The standalone module is about 14 KB gzip (16 KB with its glue), against 353 KB for the core. Before acceptance, amend the record so it says what can actually be built:

1. **Add `native/common/wire` (`myco-wire`)**, the record mechanism under both `anim-wire` and `myco-tween`. The TypeScript generator stays in `anim-wire`, with `tween` in its family table through the re-export.
2. **Drop "the memory a host gives the table" as a type parameter.** Memory is the global allocator's, taken once at sizing. `Tweens::bytes_for` feeds `init`'s `bytes_needed` in the core. The standalone module sizes its table with `tweens_configure` and has no `init`. Only the curve lookup is generic (`Curves`).
3. **Sequences: only the program moves** (`myco_tween::seq`). Playback stays a timeline instance in the core. Decide whether the standalone module gets its own small sequence player, or whether UI keyframes become delayed tweens when the animation plugin is off.
4. **`exp2` stays in `anim-math`** (`trig::exp2`), because `anim-match` uses it. Record where the curve key parser lives: in `myco-tween` (as the spike has it, re-exported by `anim-sample`) or in `myco-curve` behind an `alloc` feature (cleaner, but it touches the audio core's crate).
5. **Size gate for `build:tween`:** 30,077 B + 20% ≈ **36 KB**, following the core's rule. Whether the build runs `wasm-opt` (−7%) follows the pending decision on pinning Binaryen.
