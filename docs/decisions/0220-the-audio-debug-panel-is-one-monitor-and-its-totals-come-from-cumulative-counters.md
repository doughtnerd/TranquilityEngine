# 0220. The Audio Debug panel is one monitor, and its totals come from cumulative counters

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0157, 0162, 0166, 0171

## Context

The Audio Debug panel (`src/plugins/audio/editor/AudioDebugPanel.tsx`) coordinated two stateful watches (`CounterWatch`, `MusicWatch`) and about eight free functions from `audioDebugRows.ts` (`debugSections`, `mixSections`, `voiceRows`, `groupByEvent`, …). Its music totals (Groups held, Late groups, Groups abandoned, recoveries, refusals, stingers skipped) and "Clips started late" were sums over the instances still playing. So "Groups held" read 0 while a hold was in progress (a row counts a hold only when it resumes), and every total dropped when an instance ended. The core's cumulative group counters had been in `Audio.debug().musicTotals` since commit 9d71705, but nothing in the editor read them, and `MusicWatch.observe` ignored the totals it was given. Tests built `AudioDebugInfo` with `as unknown as` casts.

## Decision

- **One monitor.** `AudioDebugMonitor` (`src/plugins/audio/editor/audioDebugMonitor.ts`) has `observe(snapshot)` and `view()`. It owns the sampling history (per-second and per-minute rates, the 5 s sticky red) and builds everything the panel draws. The panel is one observe per sample and one view, with a fresh monitor at each Play. The old watches and builders are private.
- **The rule.** A total comes from a counter that outlives the instance that counted it. Per-instance values appear only in the per-instance (Music) table.
- **The core's totals:** Groups held, Late groups and Groups abandoned read `musicTotals.groupsHeld`, `groupsLate` and `groupsAbandoned`.
- **Main's totals where the core keeps none.** `MusicDebugTotals` gains `replans`, `refusals`, `recoveries` and `stingers`: `musicCounterTotals()` in `runtime/music/musicSystem.ts` folds each player's counters in when it is disposed, adds the players still running, and is cleared when the audio session is released (ADR 0218). `Audio.debug()` gains `eventTotals.lateStarts`, the event runtime's existing total. A snapshot without it falls back to the playing instances' sum, labelled "(playing instances)".
- **Deadline re-plans per 100 transitions** take re-plans from the total and still count transitions in the monitor, since no transition counter exists.

## Alternatives considered

- **The monitor adds up per-row rises.** It misses a refused player disposed between two 250 ms samples, an instance's last increments, and everything before the panel opened.
- **Keep the sums and label them "playing instances".** The §9 health thresholds judge totals, so a sum that drops is the wrong input; kept only as the late-starts fallback.

## Consequences

**Positive**
- "Groups held" turns red when a hold starts; no total drops when an instance ends.
- The panel's interface is two methods; tests feed typed snapshots (`editor/testing/debugSnapshot.ts`) and assert rows, with no casts.

**Negative / costs**
- `MusicDebugTotals` and `AudioDebugState` gain fields (additive for readers; whoever builds a `MusicDebugTotals` fills four more, only `core/debug.ts` and tests do).
- Main keeps one small set of cause-keyed counts per audio session.

## Deprecates

`audioDebugRows.ts` (replaced by `audioDebugMonitor.ts`) and its exports `CounterWatch`, `MusicWatch`, `debugSections`, `mixSections`, `voiceRows`, `groupByEvent`, `voiceCells`, `lateStartCount`, `VOICE_COLUMNS`, `HEALTH`, `MUSIC_HEALTH`, `MAX_VOICE_ROWS`, `formatBytes`: private or gone. Older plans and design notes that name `audioDebugRows` are history and stay as written.

## Open questions

- A transition counter in the core would let the re-plan rate stop counting transitions in the monitor.
- The panel has no Storybook stories yet (ADR 0219).

## References

`src/plugins/audio/editor/audioDebugMonitor.ts`, `AudioDebugPanel.tsx`, `editor/testing/debugSnapshot.ts`; `runtime/music/musicSystem.ts` (`musicCounterTotals`), `runtime/core/debug.ts`, `runtime/debugTypes.ts`, `runtime/Audio.ts`; e2e `tests/e2e/audio-spatial-play.spec.ts`.
