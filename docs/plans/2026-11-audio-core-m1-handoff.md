# Audio core M1: handoff for refinement and kick-off

Written 2026-11-09 at the end of the planning session. **Next session:** make the owner's last refinement to the plan, then start the build at MS0/MS1.

## Where things are

- **On master:** ADR 0157 (Accepted, revision 3), 0156 (the withdrawn FMOD record), the design in `docs/design/0157-audio-core/`, the RFC in `docs/rfc/0157/`, the spikes in `spikes/audio-worklet/`, and the plan, in three files:

| File | What it holds |
|---|---|
| [2026-11-audio-core-m1.md](2026-11-audio-core-m1.md) | the milestones (MS0–MS8), the waves, the single-writer files, contracts K1–K13, the wave review checklist, the risks |
| [2026-11-audio-core-m1-tree.md](2026-11-audio-core-m1-tree.md) | the task tree: an Opus or Sonnet lead per task, about 80 Haiku leaves, the leaf protocol, the brief template, the collision audit (F1–F11) |
| this file | the handoff |

- The earlier [handoff](2026-11-audio-core-handoff.md) is done and historical. It still uses the old 0149 numbering.
- **No code exists yet.** Neither `native/audio/` nor `src/plugins/audio/` exists. `src/engine/audio/` still has the Howler, FMOD and `busGraph` files.
- **Branches.** `claude/fmod-integration-d19dbb` and `claude/audio-core-m1-plan-fa7a9f` are both merged and can be deleted. A worktree still holds `claude/fmod-integration-d19dbb` (`.claude/worktrees/frame-lag-gc-perf-e2fb1f`), so remove that worktree first.

## Read in this order

1. The milestone plan: "What shippable means", the milestone table, the critical path, "Who does what", single-writer files, contracts.
2. The tree: tiers, "How a task runs", "Running the tree with this tool", the leaf criteria, the brief template, then the MS1 table.
3. Only as needed: `api-and-models.md` §9 (the task table: acceptance criteria and days), §4 (wire), §5 (crates and ABI), §6 (file layout); `architecture.md` §4.7 (constants), §6 (budgets), §9 (platforms).

## Settled (don't reopen)

- **The design and estimate:** the technical design and the 155 person-days (ADR 0157 revision 3).
- **Milestones:** each is shippable. `"babylon"` keeps running Howler until BB2. `"core"` stays opt-in until B7. B7 is gated on MS5 and MS6, plus A0.6's fallback check.
- **The critical path:** A0.1 → A0.3 → A0.7 → A1.2 → A1.3b → A2.1 → A2.2b → A3.1 → A3.4a → B1 → B3 → C3. H0 starts on day 1. H1 starts as soon as A1.2 and A0.10 land, since the longest dependency chain runs through HRTF.
- **The collision fixes and contracts K1–K13.** In particular, A0.2 runs in MS1 wave 1, and A0.4 parses every §2 setting.
- **The tree:**
  - S tasks get Opus leads, M tasks Sonnet leads, and leaves run on Haiku.
  - Leaves fill in a skeleton and never reshape it; no leaf edits another leaf's file.
  - Every leaf gets its own worktree from the skeleton commit.
  - Subagents can't nest, so the coordinator starts every node: the lead writes the skeleton and leaf briefs, the coordinator starts the leaves, and `SendMessage` hands the lead the leaves' branches to merge.

## Open

- **The owner's refinement.** It's the first thing in the next session, and it hasn't been said yet. Apply it to whichever of the two plan files it concerns. If it changes ownership, re-check the collision audit and the leaf rules.
- **One-shot completion `Promise`.** The recommendation is no in M1: poll `handle.playing`. The owner decides before A1.6 (MS2 wave 3) and the answer goes into ADR 0157's open questions.
- **Owner-only items:**
  - H0: sending any letter to the HRIR rights holders;
  - A0.7: a Linux machine with WebKitGTK and audio output;
  - C3: the low-end Android phone and the Linux soak machine;
  - C4: the listening pass.
- **Staffing.** The tree assumes agents. With human staff, S tasks in a wave run back to back, critical path first.

## Starting the build (after the refinement)

1. **Baseline.** On a fresh worktree from master: `npm run typecheck`, `npm test`, and `npm run test:e2e`. Note any failures that are already there. Check the Rust toolchain: `rustup target add wasm32-unknown-unknown`, which `native/nav` already needs.
2. **MS0.** Start **H0** (a Sonnet agent, no leaves). It writes `docs/design/0157-audio-core/hrir-licence.md` and drafts any letter for the owner without sending it.
3. **MS1 wave 1** (milestone plan, MS1). Start the leads in one message:
   - **A0.1** (Opus): workspace, ABI stubs (K2), deterministic init, plus the leaf briefs for `build.mjs` and `build.rs` and the hash test;
   - **A0.2** (Sonnet): schema description and generator, plus five leaf briefs;
   - **A0.4** (Sonnet): plugin shell and selector (K3), plus the `settings.ts` leaf brief.

   Then start their Haiku leaves from the returned briefs, each in a worktree from its lead's skeleton commit.
4. **Coordinator-only edits during wave 1:** `package.json` (`build:audio`), the plugin lists after A0.4, and `implementation-status.md`.
5. **Review wave 1** (milestone plan, "Wave reviews"), merge it, start the log at `docs/design/0157-audio-core/build-log.md`, and go on to wave 2 (A0.3, A0.10, A0.5).

Commit each wave on its own, so a bad wave can be reverted alone. Ask the owner before merging each milestone to master.
