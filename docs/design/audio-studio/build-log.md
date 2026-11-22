# Audio Studio build log

Plan: [plan.md](plan.md). Ground rules for tasks: [ground-rules.md](ground-rules.md). Decisions: [decision-log.md](decision-log.md).

## Owner decisions (quote these in briefs)

- 2026-11-22: Studio replaces the editor's audio panels; prototype model wins with migration; sample edits in sidecars;
  take and profiler are separate screens, a take file carries the engine profile too; v1 no live link.
- 2026-11-22: snapshots = levels + any bus effect parameter; samples are files; take replay stands in for the game
  session; the Studio always uses the Rust core.
- 2026-11-22: build unattended; accept and implement records; follow industry practice where the prototype and engine
  are silent. Tests: unit tests and Storybook first; minimal e2e on core workflows only, written and run once at the very
  end; typecheck and unit tests always; never bypass interfaces.

## Machine and baseline

- 4 cores, 15 GB RAM, ~60 GB free disk. Rust 1.99.1 with `wasm32-unknown-unknown`. No `wasm-bindgen` (not needed by audio).
- Baseline at `6ee797a`+: `npm run typecheck` passes; full Vitest: see below.

## Waves

(entries added as waves merge)
