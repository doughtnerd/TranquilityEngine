# Interactive music M4: the stubs the skeletons left, and who fills them

Written by the coordinator from Q2's report (wave 1) and Q1's skeleton. Every later brief quotes its rows from here. The waves plan's single-writer table still decides who may *edit* a file; this table says which functions each task fills. Plan: [waves](2026-11-audio-music-m4-waves.md), [tree](2026-11-audio-music-m4-tree.md), [ground rules](2026-11-audio-music-m4-ground-rules.md).

## Main side (Q2, `src/plugins/audio/runtime/`)

| File | Functions | Owner |
|---|---|---|
| `core/musicOps.ts` | `admitGroup`, `primeGroup`, `primedState`, `stampGroup`, `cancelGroup`, `releaseInstance`, `protect`, `primeEmaMs`, `beginFrame`, `ownsVoice`, `ownsStream`, `adoptMember`, `decoratePlay`, `memberFreed`, `fadeShaped`, `onStreamEvent`, `debugView` | P1 |
| `core/musicOps.ts` | `reopenGroups` | P9 |
| `music/segmentRun.ts` | `createSegmentRun`, `groupRequest`, `nextGroupId`, `primeRun`, `pollPrimed`, `stampRun`, `cancelRun`, `stopPlayerRuns`, `routeGroupEvent` | P1 |
| `music/planner.ts` | `requestStart`, `cancelPlanned`, `planTick`, `primeLeadSeconds` | P2 |
| `music/anchors.ts` | `anchorRun`, `heardTimeOf`, `ticksAt`, `predictWrap`, `applySlip`, `rebaseAnchors` | P3 |
| `music/playlist.ts` | `createPlaylistState`, `peekNext`, `tickPlaylist` | P4 |
| `music/playlistOrder.ts` | `createOrder`, `nextIndex`, `peekIndex` | L-P4a |
| `music/stems.ts` | `releaseSilentRing`, `soloStem`, `tickStems` | P5 |
| `music/stems.ts` | `quantizedRamp` | R6 |
| `music/handle.ts` | the getters, `nextGrid`, `audioHorizon`, `audioTimeAt` | P7 |
| `music/handle.ts` | `positionAt`, `judgedOffset` | K3 |
| `music/musicSystem.ts` | `beginMusicFrame` | P7 |
| `music/musicSystem.ts` | `dispatchMusic` | K2 |
| `music/musicSystem.ts` | `subscribeMusic` | K5 |
| `music/reload.ts` | `noteAssetChanged`, `applyReloads` | P8 |
| `music/background.ts` | `noteHidden`, `tickHidden`, `recoverGroups`, `groupAbandoned` | P9 |
| `music/transitionRules.ts` | `ruleIndexOf`, `findRule`, `exitTime`, `enterFrame`, `resolveFades` | R1 |
| `music/musicSwitch.ts` | `createSwitchState`, `childFor`, `tickSwitch` | R2 |
| `music/transition.ts` | `requestTransition`, `planImmediate` (H5), `cancelTransition`, `tickTransition` | R3a (bridges: R3b) |
| `music/loopTail.ts` | `tickLoopTails` | R4a |
| `music/regions.ts` | `tickRegions` | R4b |
| `music/stingers.ts` | `triggerStinger`, `tickStingers` | R5 |
| `music/stingerPolicy.ts` | `decideStinger` | L-R5a |
| `music/seek.ts` | `parseSeekPosition`, `seekMusic` | R7 |
| `music/beatClock.ts` | `predictDue`, `resyncBeats` | K1 |
| `music/calibration.ts` | `audioLatency`, `rhythmModeSetting` | Rh1 |
| `music/calibration.ts` | `fromTaps`, `getCalibration`/`setCalibration`, `isCalibrationStale` | Rh2 |

Q2's notes for the fillers: every player ticks in a fixed order (`musicSystem.ts` `tickPlayer`); each sub-state type lives in its owner's file; `Audio.horizon`, `timeAt`, `latency` and `rhythmMode` already delegate to simple real bodies; `CoreMusicOps` is built over closures into `CoreBackend`, so P1 and P9 never edit `coreBackend.ts`; a group member's PLAY uses a stream `musicOps` already opened (`CorePlayRequest.music`), and `decoratePlay` runs on every PLAY to set or clear the gate. P1: `PlayArgs` needs a gate field (ask the coordinator; `coreBackend.ts` is single-writer after Q2).

## Core (Q1, `native/audio/crates/`)

| File | Owner |
|---|---|
| `audio-core/src/due.rs` (due list, classes G and S, parked records, `rebase` incl. the scheduler's pending queue) | Z2a |
| `audio-core/src/curves.rs` (pool, `due_gain`, control-rate retarget, start phase) | Z2b |
| `audio-dsp/src/equal_power.rs` (the checked-in 1,024-point table, point `i` = `sin(π/2·i/1023)`) | L-Z2ba |
| `audio-dsp/src/curve_laws.rs` (law values; 4–7 read as linear) | L-Z2bb |
| `audio-core/src/voice_split.rs` (`boundaries`) | Z2c |
| `audio-core/src/groups.rs` (table, gate decision, give-up; entry stores `held_frames: u32`) | C2a, then C2b |
| `audio-core/src/group_hold.rs` (`on_starve`) | C2c |
| `audio-core/src/group_rebase.rs` (`apply(slip)`) | C2d |
| `audio-core/src/stream.rs` pools behind `StreamStore::over(region, wide, music_rings)` (today `music_rings` is ignored and passed 0) | C1 |
