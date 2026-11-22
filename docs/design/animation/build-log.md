# Animation build: build log

Wave results, measurements (marked measured or estimated) and gate changes.

## Planning (2026-11-22)

- **Plan:** [plan.md](plan.md), with 13 waves (W0–W12); W11 is behind gate A (the audio branch merges).
- **Machine:** 4 cores, 15 GB, about 59 GB disk free; Rust 1.99.1 with the wasm target; wasm-bindgen-cli 0.2.130.
- **Revision 2 (2026-11-22):** after an independent review (50 findings, answered in plan.md) and the owner's ordering decision: Phase R (Rust core) now, Phase B after the audio merge. `origin/master` merged at `1773b414`.

## R-W0 (T02), merged 2026-11-22

- Anim workspace and boundary. First wasm **25,206 B** (measured; stubs with `init` and `source_hash`), size gate set to **30 KB** (first build + 20%, rounded) in `native/anim/build.mjs`.
- Pilot measures (measured, 4 cores): cold wasm build 8.6 s; cold `cargo test` 8.7 s (18.8 s with nothing cached); incremental rebuilds under 1 s; `target/` about 380 MB per worktree. Well under the 10-minute line: no shared `CARGO_TARGET_DIR` needed. First-pass success: yes (one typecheck error came from `node-datachannel` missing after the master merge; fixed by `npm ci`). Agent time about 17 minutes.
- Coordinator: added `build:anim` to `package.json`; `rustfmt` and `clippy` added to the pinned toolchain's components; wasm rebuilt and committed; typecheck and the animation tests green.
- **Seam notes for later tasks:** the wire mechanism is `anim-wire/src/record.rs`; `FAMILIES` in `anim-wire/src/lib.rs` is written once. A Rust task commits its family's `wire/<family>.ts` **and** `crates/anim-wire/vectors/<family>.json`. `anim-wasm` features add their memory needs through `bytes_needed` in their own file.

## R-W1: T10 merged 2026-11-22

- `anim-math` with bit-identical simd128 and scalar paths, verified on wasm in Node (the task's own runner), plus f64 reference and golden hash. First pass green; agent time about 16 minutes. Wasm unchanged in size (25,206 B; the core doesn't use the maths yet).
- **T03r merged:** the four binary formats, 25 tests including 2,000 random bit-flips per buffer. First pass green; agent time about 20 minutes. It adopted T10's u16 parent layout from a coordinator note mid-task.
