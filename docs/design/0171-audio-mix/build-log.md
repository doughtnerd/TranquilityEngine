# Audio mix M5: build log

The coordinator's log of each wave review ([waves plan, "Wave reviews"](../../plans/2026-11-audio-mix-m5-waves.md#wave-reviews)): what landed, the numbers measured, deviations from the design, decisions taken while the owner was away, and reserve days used. Work merges into the M5 integration branch; each milestone goes to master as soon as it completes (owner item O2: a merge commit, not a squash).

**Integration branch:** `claude/loving-fermi-g98916` on origin (the build session's designated branch). It started at `origin/master` `4e2303d` ("M5 plan: owner decisions O1-O7 recorded"), which holds the design and the plan.

**What's merged and what's open** lives in [implementation-status.md](../../architecture/implementation-status.md) (the 0171 row) once M5-0 lands; until then, in this log.

## For the owner (summary, newest first)

**Owner decisions (2026-11-13, "Yes, merge it. Let's begin"):** O1–O7 of the [build handoff](../../plans/2026-11-audio-mix-m5-build-handoff.md) as recommended: three strongest and six mid leads; milestones to master as soon as each completes, by merge commit; the ≈ 14 d of plan-only work accepted as added; hardware as in M4 (an Android emulator, no real phone: real-device items deferred under 0169); one milestone-end check run when several milestones finish in one wave; the plan merged to master (done, `4e2303d`); a listening section at the end of M5-0, M5b and M5c. *Correct me if "yes" didn't cover O4.*

**Needs you:** nothing yet.

## Decisions

| # | Decision | Why | Revert |
|---|---|---|---|
| D3 | `MIXER_LIMIT` raised 360 → 400 KB after W2 (owner, 2026-11-13: "just log the reason") | after W2 the mixer is **341,168 B (95% of 360 KB)**: K1 ≈ +4 KB; B2's configuration queue and slot code, B1a's lanes and Cp1's counters ≈ +17 KB together. That is ≈ 15 KB above the design's whole-M5 projection (+27–31 KB including loudness), with loudness (≈ 21 KB) still to come, so M5 should land near 365–370 KB (est.). A tripwire, raised with this reason; nothing traded for size | `MIXER_LIMIT = 360 * 1024` in `native/audio/build.mjs` |
| D2 | K1: a bus with two or more reverb-send slots sums them in the send scratch before the convolver input (`rev + (a + b)` instead of `(rev + a) + b`): a possible last-bit difference no existing golden covers; one send stays bit-identical | the post-fader scratch the design asks for (R11) | sum each send straight into the convolver input in `sends::feed` |
| D1 | `MIXER_LIMIT` raised 320 → 360 KB in W0 | the design projects ≈ 347–351 KB (R25); only ≈ 7.9 KB were left and `build.mjs` exits on the gate, so a task's own build would fail; a tripwire, raised with a reason (CLAUDE.md) | `MIXER_LIMIT = 320 * 1024` in `native/audio/build.mjs` |

## Wave 0 (2026-11-13, base `origin/master` `4e2303d`)

- **Toolchain:** `rustup` installed the pinned **1.99.1** here (M4 ran on 1.97), so metered counts should match `baseline.json` exactly. `wasm32-unknown-unknown` present. Playwright 1.64.1 with the pre-installed Chromium.
- **Baseline** (base `770bcf1`, run while W1's first leads started, so under load): typecheck green; `npm test` **578 files, 6,253 passed, 7 skipped, 1 todo** (202 s); `cargo test` in `native/audio/` **908 passed, 0 failed, 6 ignored**; `npm run build` green; `check:audio-metered` **pass** (all scenes ±0.01%, matching `baseline.json` on 1.99.1); `npm run test:e2e` **254 passed, 8 failed, 10 skipped** (17.1 min): the M4 music specs `audio-music-a.spec.ts:34, 68, 163, 251`, `audio-music-b.spec.ts:282`, `audio-music-d.spec.ts:536` ×2 ("start from" entry cue), and S0's new `audio-mix-smoke.spec.ts:12`. All ran with five agents building; **to rerun alone on a quiet machine** at W1's end before any counts as known.

## Wave 1 (pilot; base `770bcf1`) — closed

Every W1 task merged into the integration branch. Wave-end checks on a quiet machine (no agent running): typecheck green; `npm test` **591 files, 6,644 passed, 10 skipped, 1 todo**; `npm run build` green; `check:audio-metered` **pass (+0.03%)**; `cargo test` **937 passed, 0 failed**; `npm run test:e2e` **261 passed, 2 failed, 9 skipped**. The two: the smoke spec's fade (written for the pre-split `Bus.volume`; fixed, 3 of 3) and `sound-lab-touch.spec.ts:99` (a runtime warning that a measured prime lead, 598 ms, exceeded one beat, 571 ms; 3 of 3 alone, so load). **The baseline's seven M4 music e2e failures all passed here: they were load, not regressions.**

| Task | Model | Merged | Notes |
|---|---|---|---|
| S0 | mid | `7e6de10` | live bus case; five fixmes |
| Ld3 + L-Ld3a | mid + cheapest | `a0c4498` | 19 tests; M and S exact against the spike's Rust |
| K1 + Wa1 merge 1 (one merge) | strongest + mid | `7c3d376` | stage hooks, regions, 256-B STATUS writer, opcode arms; no digest re-recorded |
| Wa1 merge 2 | mid | `c93cb47` | goldens at caps (17,824 B) and zero; ABI 0x400 assertion; L-Wa1a 9/9, L-Wa1b 8/8 |
| coordinator | — | `c78041e` | wasm rebuild (mixer **323,750 B**, gate 360 KB); `coreDriver.test.ts:131` ABI 0x400; the stale-wasm check verified (the pre-M5 wasm fails `sourceHash`) |
| K0 (incl. Mx1 `2be0799`) | strongest | `9d09504` | surface, per-concern modules, recorder tap, debug shape, `core.currentFrame` |
| Sm1 + L-Sm1a | mid + cheapest | `2cefa6e` | 200 seeds × 120 ops, no failure |
| L-Mx1b | cheapest | `c711a78` | 22 cases against a frozen copy of today's mixer |
| Sa1 + L-Sa1a | mid + cheapest | `a6601c1`, `6e22d01` | ducking parse; samples rewritten; 20 parse cases; 19 sample cases |
| Mo1 + L-Mo1a | strongest + cheapest | `126be68` | 17 op kinds; 600 seeded pairs; `addDucking` writes `mode: "presence"` |
| merge glue | coordinator | `ad3fea1`, `203368d`, the smoke fix | `mixer.lanes.test.ts` used Mx1's stand-in `MixOp`; the smoke spec's fade |

**Integration fixes by the coordinator:** the owner-approved zero-fill of the M5 STATUS fields in `mirror.ts`/`statusReader.ts` (`c86c4f9`); the four gate goldens' envelope byte 1.2 → 1.3 (`cf420df`, audio digests unchanged; existing goldens are the coordinator's single-writer files); the merge glue above.

**Pilot measures (W1):**
- **Leaf first pass: 7 of 7** (L-Ld3a, L-Wa1a, L-Wa1b, L-Mx1b, L-Sm1a, L-Mo1a, L-Sa1a). Every leaf was a test file; the leads (Ld3, Mx1, Sm1, Sa1) wrote the implementation in the "skeleton" because stub bodies would have broken live tests. **Change for later waves:** where a module is live code, the leaf is its test file and the lead fills the module; don't ask for stub bodies.
- **Skeleton fit: 3 changes** to K0's seams by later W1 tasks (Mo1: `invert` returns `MixOp[]`; the edit lives in `applyOpToSettings` because the engine can't import the editor plugin; Sm1: additive `deferred`, `onApplied`), plus one K0 fix of its own (the presence hook took a start frame and allocated per voice; now the slot).
- **Permission refusals: 3** (Wa1 on `mirror.ts`/`statusReader.ts`; K1 on `audio-wasm/` and on the gate goldens), each for a file a format change forced but the brief didn't list. **Change:** briefs list the tests and literals a format change forces.
- **Cheapest-model leaves called session tools 3 times** (`create_session`, `interrupt_session`, `send_message`), even with an explicit ban in the brief; every call was refused and did nothing. **Change:** keep the ban; use a leaf agent type without those tools if one becomes available.
- **Agent time:** K0 ≈ 49 min, K1 ≈ 47 min, against 2.5 table-days each (plan est.); leaves 3–8 min each.

## Wave 2 (base `3b17a16`) — closed

Merged: Hk1 (`7f081e0`), Ld4 (`8d0d4a8`, leaf done by the lead), Ld5 + L-Ld5a (`2f7b567`), Bb2 (`773d821`), Rc1 + L-Rc1a + L-Rc1c (`65b3c0c`, `e0acedf`, `e7cd15c`), B2 + L-B2a (`4737787`, `34824d7`), Cp1 (`affcf59`), **B1a + Wa2 together** (`5b625c9`, `7467a2d`: the seven-lanes flip, every golden, loopback and parity digest unchanged on the rebuilt core with main sending `BUS_RAMP`), **R0** (`e920e63`: `BUS_MIX` retired from the wire, core, main and tests; `m4-s-bus.json` steps rewritten to `BUS_RAMP`, digest `fb0ccda9ffc65091` unchanged). Mixer **340,304 B** after R0 (tripwire raised to 400 KB, D3).

Wave-end checks (quiet machine): typecheck green; `npm test` **603 files, 6,825 passed** after two fixes (below) and one known flake (`piratesSample`, 3 of 3 alone); `npm run build` green; `check:audio-metered` pass; `cargo test` **970 passed**; `npm run test:e2e` **262 passed, 1 failed** → fixed; parity specs **7 of 7**.

**Wave-end fixes (coordinator, `9ed49d2`):**
- **A real regression from Ld5:** the Meter checkbox sat in the bus row's `<summary>`, which moved the summary's centre onto it, so opening a bus row toggled metering instead (`audio-spatial-settings.spec.ts:44` failed 3 of 3; passes on the commit before Ld5's merge, found by bisecting). The toggle now sits in the row's body beside the bed. **Lesson:** an editor task runs the e2e specs of the panel it edits, not only its unit tests (added to later editor briefs).
- `wireMainM5.test.ts`'s heap-delta bound failed under the parallel suite (3 of 3 alone); now a structural identity check across 3,000 reads.
- The capture sample fixture stores `SCHEMA_HASH`; R0 changed it (patched; Rc1b makes the test stamp the current hash).

**Decisions in W2:** Bb2's `mixCaps` uses §1.3's fields, no new loudness-reason field (the panel's text is Pf2's). Wa2 and B1a merged together so the TS goldens could prove the flip; R0 was delegated to a strongest agent (larger than the plan's 0.5 d: 36 files, re-estimated 1.5 d).

**Pilot measures (W2):** leaf first pass **6 of 6** (L-Ld5a, Bb2 after one correct stop for a decision, L-Rc1a, L-Rc1c, L-B2a; L-Ld4a done by its lead); leaf session-tool calls: 2 more (one `Claude_Docs.guide` read, one denied), down from 3 in W1 with the explicit ban. Skeleton fit: Ld4 widened its hub's API (additive), B2 added scheduler hooks for B1b (planned).

**Follow-ups carried to W3 briefs:** Mx2 sends master on `LANE_RUNTIME` (B1a); `BUS_CONFIG` doesn't reset a re-added slot's lanes (Mx2's replay resends them); stale `BUS_MIX`-as-current comments in TS core files (coordinator sweep with Mx2); Rc5 fixes `RecordTable.ROW_BYTES` (26 vs 28 B per row in the reader's allocation count).

## Wave 3 (base `9f82a8d`) — closed

Merged: Cp2 + L-Cp2a (`1517ba2`), B1b + L-B1ba (`6a47563`, `2e18633`), B4 + L-B4a (`174195e`), B3 (`aa6f0ea`, lead did L-B3a) + the coordinator's `bus.rs` line (`3fa559a`: `BUS_CONFIG` re-runs the order with level rules), Bn1 (`fb7dd8f`), Rv1 + L-Rv1a (`4e672de`: **post-fader sends**, one named new golden `m5/bus-mute-send` `e24525251d302e4e`, every other digest unchanged), the parity wet-only fix (`7929177`). **Mx2 is done and held** (`4a212c1`), merging with Dp1 and G1 in W4 (base `m5/w4-base` `4f413ab`). Mixer **355,970 B** (400 KB tripwire).

Wave-end checks: typecheck, build, `check:audio-metered` pass; `cargo test` **1,021 passed**; `npm test` 605 files with 4 failures → fixed (below); `npm run test:e2e` 261 passed, 2 failed (M4 music specs: `audio-music-a.spec.ts:307` passed alone; `audio-music-d.spec.ts:536` fails ≈ 1 in 7 even alone and failed at the pre-M5 baseline too — **now a work item**, a W4 fix task); browser parity specs 7 of 7 after the fix.

**A harness break from the post-fader decision:** the Web Audio parity "wet only" scenes made the dry signal silent with a bus at gain 0, which only worked while the send was pre-fader (`tests/e2e/audio-parity/scenes.ts`: "The send taps the bus before its gain"). With owner decision 1, a bus at gain 0 feeds nothing (−180 dB). The core render now isolates the wet signal as (send) − (send 0) from identical input; the Web Audio reference, whose send still taps before the gain, was unaffected (`reference.json` unchanged); no tolerance loosened. **Lesson:** a task that changes sound runs `src/plugins/audio/testing/webAudioParity.test.ts` and the `@slow` parity specs, not only the goldens (added to later briefs).

**Measured against the design's cost model (§7.1), logged, nothing traded:**
- a ramping lane ≈ **5.3k instructions per quantum** (Bn1) against the model's 1.7–1.8k — about today's ramping bus (5.4k); stamped ≈ +0.35k per bus over asap. The worst scene's projected lane saving (−101k) won't materialise; the typical scene (2 lanes) is unaffected;
- a gliding compressor ≈ **+12.8k per quantum for 8 quanta** per edit (B4) against "≈ 0"; the snapshot filter blend +250 per filter (S4: +370);
- the post-fader send ≈ 1.4–1.6k per bus with a send, ≈ today's unscaled add (Rv1).

**Design corrections found in W3:** §4.3's 32-sample CPU ring can't span 384 quanta at a 6-quantum cadence → 128 (Cp2); the compressor's click came from the makeup gain applied unsmoothed per quantum, now ramped during a glide (B4: abrupt 0.15 on the real core, 0.996 before); the snapshot low-pass already blended per quantum since M3 (B4); a resonant per-quantum sweep can't occur (every per-quantum filter ramp runs at Q 1 dB; resonant Q edits are direct), its 5.3× overshoot recorded for the record (B4).

**Pilot measures (W3):** leaves L-Cp2a, L-B1ba, L-B4a (one reachability question, resolved), L-Rv1a first pass; cheapest-model leaves made two more session-tool calls (`read_documentation`, `archive_session`, both refused) → **leaves moved to the mid model** from L-Rv1a on (no stray calls since). Skeleton fit: B3 needed a coordinator line in `bus.rs`; Cp2 needed three `coreBackend.ts` lines (granted).

**Follow-ups:** Mx2 found that main's fade `Ramp` starts at the heard "now" while the core starts it at the stamp, so getters read ahead of the sound by about the lookahead — Dp1 (W4, owner of `mixer.ts`) fixes it before the M5-0 listening section. RESET doesn't clear the send run-out's `live` flag (harmless: a cleared reverb outputs zero) — `bus.rs`, coordinator, with a later core change.
