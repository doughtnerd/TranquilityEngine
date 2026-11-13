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
| D1 | `MIXER_LIMIT` raised 320 → 360 KB in W0 | the design projects ≈ 347–351 KB (R25); only ≈ 7.9 KB were left and `build.mjs` exits on the gate, so a task's own build would fail; a tripwire, raised with a reason (CLAUDE.md) | `MIXER_LIMIT = 320 * 1024` in `native/audio/build.mjs` |

## Wave 0 (2026-11-13, base `origin/master` `4e2303d`)

- **Toolchain:** `rustup` installed the pinned **1.99.1** here (M4 ran on 1.97), so metered counts should match `baseline.json` exactly. `wasm32-unknown-unknown` present. Playwright 1.64.1 with the pre-installed Chromium.
- **Baseline:** (filled in when the runs finish).
