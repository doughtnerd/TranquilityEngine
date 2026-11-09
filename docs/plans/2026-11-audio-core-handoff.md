# Audio core (ADR 0149): handoff for milestone planning

> **Done.** The milestone plan is [2026-11-audio-core-m1.md](2026-11-audio-core-m1.md). The records were renumbered to 0156 and 0157 in `919ac1d`; references to 0149 below are historical.

Written 2026-11-09 at the end of the design session. **Next step:** break M1 into shippable milestones and waves of parallel tasks.

## Where things are

- **Branch:** `claude/fmod-integration-d19dbb`. It's five commits ahead of where it branched and not merged: `a0a9c86` spikes, `ff7c6f4` ADR accepted, `5fd12f8` design and revision 3, `e7189bf` and `2e7588d` owner settlements.
- **Master has moved since.**
- **Number clash.** Master already has its own **0148** and **0149**, plus records up to 0154; the separate Android export ADR took **0155** (branch `claude/sad-engelbart-d18b71`, Proposed).
- **Renumber on merge,** as this repo does. Next free numbers, probably 0156 for the withdrawn FMOD record and 0157 for the audio core. This touches:
  - the files themselves;
  - `docs/rfc/0149/` and `docs/design/0149-audio-core/`;
  - the status lines of 0006, 0074, 0097, 0098 and 0099;
  - `docs/README.md` and `implementation-status.md`;
  - every "0149" cross-reference.

## Read these, in order

1. `docs/decisions/0149-audio-runs-on-an-engine-owned-rust-core-in-an-audioworklet.md`: Accepted, revision 3. Read its end section for the revision 3 changes.
2. `docs/design/0149-audio-core/README.md`: the design index, the owner's choices, the review fixes, and the estimate delta.
3. `docs/design/0149-audio-core/api-and-models.md` §9: **the M1 task table** (IDs A0.x–A3.x, H0–H4, BB1–BB2, B1–B7, C1–C5; level, dependencies, days, acceptance criteria) and the critical path. This is the input for milestones.
4. `docs/design/0149-audio-core/architecture.md`: components, lifecycles, timing constants (§4.7), memory, budgets (§6), failures (§7), platforms (§9).
5. `spikes/audio-worklet/README.md`: the measured evidence behind every number.

Also: `docs/rfc/0149/` (the RFC reviews), and the design folder's review files.

## Settled (don't re-open)

- **The core:** Rust in `native/audio/`, compiled to wasm (plain C ABI, no wasm-bindgen, `simd128`), committed like `native/nav`. It mixes in an AudioWorklet. Audio becomes a **first-party plugin** (`src/plugins/audio/`), as 0133 lists.
- **Threads:**
  - the main thread owns intent: the typed-array voice table and selection, plus one versioned command batch per frame;
  - the audio thread owns playback and posts status every 6 quanta;
  - a decoder worker (symphonia 0.6.1) streams straight to the worklet.
- **The fallback is Babylon AudioEngineV2,** internal only, replacing Howler.
  - It's chosen **automatically when the core can't load**, and kept after M1.
  - A core that loaded and then exhausts 3 recoveries in 60 s stays silent.
  - Howler is deleted when the Babylon backend lands.
- **Reuse:**
  - **port** from Chromium Web Audio (BSD, notices kept): biquad, compressor, staged convolver, HRTF panner, equal-power panner, distance, cone;
  - **adopt** microfft (14 KB of wasm, measured);
  - **borrow designs** from Kira, Firewheel and SoLoud;
  - **don't adopt** Kira, Firewheel or FMOD as the core.
- **HRTF is in M1** for the nearest 16 spatial voices, matching today's sound. It's **gated on task H0** (the Composite HRIR data licence); the fallbacks are SADIE II data, or equal-power.
- **Cross-platform is required.**
  - The editor targets desktop and the web browser only.
  - Published games target web, desktop and **Android** (Tauri).
  - The low end is an Android phone on the lowest Android version Google Play accepts for publishing. It's a **starting point**: raise it if the gaps are significant.
  - macOS is a release gate only.
- **The owner runs the human listening pass,** backed by automated objective checks.
- **Estimate:** 155 person-days (about 31 person-weeks) with a 10% reserve. That's about 15–17 calendar weeks with one senior, two mid-level and one junior engineer.

## Gotchas found in the design

- The worklet has no `performance` clock, `TextDecoder`, `fetch` or `setTimeout`.
- The first `AudioContext` on Windows takes 250–490 ms, so create it early.
- rustfft breaks the 150 KB size gate, hence microfft.
- Never relay streams through the main thread: the spike lost 23–83 quanta that way.
- Use typed arrays, not objects, for the voice table (10× faster).
- The high preset is at 1.19 of its 1.3 ms budget: the reserve for M2–M4 is nearly spent.

## Open

- Renumbering and merging this branch (above).
- ADR 0155, Android export: Proposed, awaiting the owner, on its own branch.
- One-shot completion: whether a `Promise` on `AudioHandle` is acceptable, given the engine avoids event systems.

## Next step

Turn api-and-models §9 into milestones and waves:
- each milestone shippable behind `audio.backend: "core"`;
- the critical path first: A0.1 → A0.3 → A0.7 (webview smoke check) → A1.2 → A1.3b → A2.1 → A2.2b → A3.1 → A3.4a → B1 → B3 → C3;
- H0 (licence) early, since it blocks the HRTF tasks;
- tasks in each wave on disjoint files (the `coordinate-subagents` skill), with a review after each wave.

Write the plan in `docs/plans/` and add an `implementation-status.md` note.
