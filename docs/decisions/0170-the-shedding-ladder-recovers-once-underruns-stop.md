# 0170. The shedding ladder recovers once underruns stop

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0162 OD3, "steps last the session")
- **Related:** 0162, 0157, 0166 (build log D22, task F-39)

## Context

ADR 0162's load-shedding ladder (OD3, revision 4's owner decision 9; architecture §7.3) is the audio core's last resort once the adaptive voice cap sits at its floor of 16 and underruns go on for a second. It has three steps: beds go idle after one silent quantum instead of their decoder's partitions (`bed.rs`), releasing reverb-zone tails are cut with a 100 ms fade (`zones.rs` step 1), and one active zone fewer is allowed, the weakest fading out over 150 ms (step 2). Its steps lasted the session (RESET kept them), while the adaptive cap itself climbs back (5 s of calm, then `configured / 32` voices a second).

F-37 found an emulated phone left at "shedding (3 steps)" by false underruns (fixed at the probe since). Real ones happen too: a page load on a slow device or a background app can trip the ladder once, and the mix then stays thinned until a reload. The owner decided (2026-11-12, build log D22) that the ladder must come back once underruns stop.

## Decision

We will give the ladder's steps back one at a time, in reverse order, after a sustained clean period, with a back-off so it doesn't oscillate:

- **Clean hold:** 20 s without an underrun and without a ladder move (a step taken or given back) gives the step taken last back. Each give-back starts a fresh hold, so three steps are all back 60 s after the last underrun. 20 s is four times the cap's 5 s calm and lands during or after its climb (16 → 128 takes ≈ 33 s, 16 → 32 ≈ 13 s), so the cheap voices return first and each ladder step is a small increment on a machine that has stayed clean.
- **Order:** zone step 2 (the active-slot limit lifts), then zone step 1 (releases ring out in full again), then the bed-idle step.
- **Re-trip:** a step taken after a step was given back, before the ladder has sat idle and clean for a whole hold, doubles the hold (20, 40, 80, then 160 s at most). Idle and clean for 160 s returns the hold to 20 s.
- **No audible jump:** each give-back changes only what comes next. A lifted zone limit lets main start the zone again on its next ZONE_CONFIG, which fades it in over the slots' usual 100 ms; a tail already cut stays cut; beds already idle stay reset until something encodes into them.
- **Where:** a pure `LadderRecovery` beside the cap's controller (`cap_controller.rs`), stepped from `cap::after_render` only while a step is in force, a back-off is running or an underrun came, so an idle ladder costs two compares a quantum. STATUS `m3Shed` now counts the steps **in force** (it can fall); the wire is unchanged. Main's zone manager lifts its own "one zone fewer" when `m3Shed` falls (the zone step is always given back first).
- **Debug:** `Audio.debug().core.ladderState` reads "shedding (n steps)" while underruns continue and "recovering (n steps)" once a second has passed without one; `core.ladderRecoveries` counts the steps given back. The debug panel shows recovering in amber.

## Alternatives considered

- **Keep the steps for the session (0162 OD3).** Rejected by the owner: one bad stretch leaves the mix thinned until a reload.
- **Give everything back at once after a clean period.** One large load increase on a machine that just struggled; the likeliest way to trip again, and audibly a jump of several features at once.
- **Restore only after the cap is back at its preset.** Ties the ladder to the cap's climb rate, which depends on the preset (13 s at 32 voices, 33 s at 128); a fixed hold is easier to reason about and still follows the cap's calm.
- **Report recovery on the wire (a STATUS field or flag).** The wire belongs to the M4 coordinator after W1 and main can derive "recovering" from `underruns` and `m3Shed`; left for a wire revision if the debug view ever needs the core's own clock.

## Consequences

**Positive**
- A transient overload costs at most a minute of thinned mix (longer only if it keeps coming back).
- `m3Shed` reads as "what is shed now", which is what the debug panel's red/amber meant.

**Negative / costs**
- A machine that is genuinely too slow may shed, recover and shed again; the back-off bounds this to one attempt every 160 s at worst.
- `ladderState` "recovering" is main's estimate (no underrun for a second), not the core's hold.

## Deprecates

0162 OD3's "steps last the session" and the zone manager's session-long `shed`. `m3Shed` no longer counts steps taken cumulatively.

## Open questions

None.

## References

- `docs/design/0166-audio-music/build-log.md` D22, F-37.
- `native/audio/crates/audio-core/src/cap_controller.rs` (`LadderRecovery`), `cap.rs`, `bed.rs`, `zones.rs`; `src/plugins/audio/runtime/core/{debug,mirror,zones}.ts`.
- Tests: `cap_controller.rs` `ladder_tests`, `tests/beds.rs`, `tests/zones_golden.rs`, `runtime/core/ladderRecoveryLoopback.test.ts`.
