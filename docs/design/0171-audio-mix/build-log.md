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
| D2 | K1: a bus with two or more reverb-send slots sums them in the send scratch before the convolver input (`rev + (a + b)` instead of `(rev + a) + b`): a possible last-bit difference no existing golden covers; one send stays bit-identical | the post-fader scratch the design asks for (R11) | sum each send straight into the convolver input in `sends::feed` |
| D1 | `MIXER_LIMIT` raised 320 → 360 KB in W0 | the design projects ≈ 347–351 KB (R25); only ≈ 7.9 KB were left and `build.mjs` exits on the gate, so a task's own build would fail; a tripwire, raised with a reason (CLAUDE.md) | `MIXER_LIMIT = 320 * 1024` in `native/audio/build.mjs` |

## Wave 0 (2026-11-13, base `origin/master` `4e2303d`)

- **Toolchain:** `rustup` installed the pinned **1.99.1** here (M4 ran on 1.97), so metered counts should match `baseline.json` exactly. `wasm32-unknown-unknown` present. Playwright 1.64.1 with the pre-installed Chromium.
- **Baseline** (base `770bcf1`, run while W1's first leads started, so under load): typecheck green; `npm test` **578 files, 6,253 passed, 7 skipped, 1 todo** (202 s); `cargo test` in `native/audio/` **908 passed, 0 failed, 6 ignored**; `npm run build` green; `check:audio-metered` **pass** (all scenes ±0.01%, matching `baseline.json` on 1.99.1); `npm run test:e2e` **254 passed, 8 failed, 10 skipped** (17.1 min): the M4 music specs `audio-music-a.spec.ts:34, 68, 163, 251`, `audio-music-b.spec.ts:282`, `audio-music-d.spec.ts:536` ×2 ("start from" entry cue), and S0's new `audio-mix-smoke.spec.ts:12`. All ran with five agents building; **to rerun alone on a quiet machine** at W1's end before any counts as known.

## Wave 1 (pilot; base `770bcf1`)

| Task | Model | Branch | State |
|---|---|---|---|
| S0 | mid | `m5/s0` | **merged** `7e6de10` (live bus case 3 of 3; five fixmes) |
| Ld3 + L-Ld3a | mid + cheapest | `m5/ld3` | **merged** `a0c4498` (19 tests; M and S exact against the spike's Rust, I within 7e-15 LU) |
| Wa1 | mid | `m5/wa1` | merge 1 `da835e6`; L-Wa1a `151c4ae` (9/9); coordinator zero-fill `c86c4f9` (owner-approved); merge 2 and two audio-wasm fixes running; L-Wa1b running |
| K1 | strongest | `m5/k1` | stage A `30440fa` (every Rust golden unchanged; TS goldens 33/33 on the rebuilt wasm; mixer 321,711 B, +1,912 B); stage B running |
| K0 | strongest | `m5/k0` | first commit `5d75912` (types); `00afcd7` surface and modules; running |
| Mx1 | strongest | `m5/mx1` | done `2be0799` (lead did L-Mx1a itself); L-Mx1b running; merges with Sa1 |
| Sa1, Mo1, Sm1 | mid, strongest, mid | — | started on K0's first commit (Sa1 on `849ed9a` = K0 types + Mx1) |

**Pilot measures so far:** leaf first pass 2 of 2 (L-Ld3a, L-Wa1a). Leads doing more than a skeleton: Ld3 and Mx1 wrote the whole implementation before handing off (stub bodies would have broken live tests), so their leaves were test files only. **Skeleton fit:** two refusals by the agents' own permission checks for edits just outside a brief (Wa1: `mirror.ts`/`statusReader.ts`; K1: `audio-wasm/`). Fixed by an owner-approved coordinator commit and by re-granting the wasm lines to their owner (Wa1). Lesson for later briefs: list the tests and literals a format change forces, not only the format files. A cheapest-model leaf called a session tool once (denied, no effect): later leaf briefs say to use only the tools the file needs.
**Coordinator slip:** a merge command read its message from stdin, which `git merge` doesn't support, and the cleanup chained after it deleted the branch; the commit was recovered by hash and merged. Merge messages now go through a file, and cleanup runs only after a confirmed merge.
