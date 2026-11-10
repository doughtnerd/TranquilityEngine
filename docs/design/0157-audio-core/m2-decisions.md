# Decisions for the owner's review (ADR 0158, audio events M2)

The coordinator's calls during the M2 build ([plan](../../plans/2026-11-audio-events-m2-waves.md)), each with how to revert it, newest last. The owner's own rulings are in the build log's "M2" entries and quoted in the plan. Confirmed entries are marked "(confirmed)"; superseded ones are marked in their title, not rewritten.

## Summary (read first)

M2 is in wave 1 (the pilot). E1, E2 and E3a are on master with the plan.

**Needs you:**
1. E2's deviations (entry 1): accept, or ask for changes.
2. The lab-VM run of the native automation cost (E5.5), once E5.3 lands.

**Biggest calls so far:** none beyond the plan.

**Proposals waiting for your yes/no:** none.

## Entries

### 1. E2's deviations from ADR 0158, logged rather than changed (wave 0)
- **Question:** E2 (merged before planning) departs from 0158 in six places; accepted records aren't rewritten.
- **Chosen:** logged in the build log and here; no task changes them. (a) Only voices with a low-pass binding are filtered (M1 never applied per-voice `lpHz`; unbound voices stay bit-identical). (b) AUTOMATE, PARAM and CURVES apply on arrival, not stamped; the writer orders AUTOMATE after its PLAY. (c) Pitch automation ramps per frame; virtual voices advance at the block's mean pitch. (d) A voice past `loopEnd` when SET_LOOP arrives plays on to the end. (e) Curve uploads over the 256 KB staging area are dropped past ≈ 660 full curves (upload per asset; E3.1 spreads its replay over batches). (f) STATUS carries no `group` (0158 §6's line); main knows each voice's group.
- **Why:** each keeps M1's goldens bit-identical or avoids a wire record that can't hold eight bindings.
- **If changed:** (a) is `audio-core/src/automation.rs` and `voices.rs`'s filter gate; (f) would need a STATUS voice section, which STATUS doesn't have.
