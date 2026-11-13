# Audio mix M5: the stubs the skeletons left, and who fills them

From K0's and K1's reports (W1, 2026-11-13). Each later brief quotes its rows. A task that needs a different signature asks the coordinator before changing it (the pilot's "skeleton fit" measure). Plan: [waves](2026-11-audio-mix-m5-waves.md).

## Main side (K0, `src/plugins/audio/runtime/`, `src/engine/audio/`)

| Tag | File | Signature | State |
|---|---|---|---|
| Mo1 | `src/engine/audio/mixOps.ts` | `applyOpToSettings`, `applyOpToDraft<D extends MixDraft>(d, op)`, `opClass(op, settings)`, `invert(op, before): MixOp[]` (Mo1 changed it from `MixOp`), `diffOps(before, after)`, `encodeMixOp`, `decodeMixOp` | **filled** (W1) |
| Sm1 | `src/engine/audio/slotTable.ts` | `SlotTable`: `add(name, parent): number \| SlotDeferred`, `remove(name, frame)` (frame = the dip-end frame), `rename`, `move`, `resurrect(name)`, `recycle(frame, liveVoicesOn, onRecycled?, onApplied?)`, `slotOf`, `configWire(settings)`, `replay(settings)`, `busRef(slot)`, `reset(settings)`, `deferred` | **filled** (W1) |
| Wa2 (H1), then Mx2 | `core/laneWriter.ts` | `rampLane(r: BusLaneRamp)` throws; `applyMix`, `master`, `refreshBusGain` hold today's code | Wa2 W2 (interim `BUS_RAMP` body), Mx2 W3 |
| Ma1, Ma2 | `core/busIndex.ts` | `BusIndex.configureBuses`, `busConfigWire`, `planBeds`, `replanBedsOnSettings` (today's code) | Ma1 W5, Ma2 W6 |
| Dp1 | `core/presence.ts` | `configured(mixer, busLive)`, `voiceStarted(bus, slot)`, `voiceStopped(bus, slot)` (no-ops; they take the voice's slot, not its start frame — an object per start broke the voice-start allocation gate); `writeDucking(rules)` throws | W4 |
| Ma1 | `core/liveMix.ts` | `apply(op)` answers `{ ok: false, class: "none", restartRequired }`; `flushNow()`; `writeSlot(w)`, `writeLoudnessConfig(c)` throw | W5 |
| Ma2 | `core/structuralDip.ts` | `apply(op)` throws; `inFlight`, `update(framesNow)`, `replayEndState()` | W6 |
| Ma3 | `core/deferredAdds.ts` | `defer(op, msg)` throws; `retry(slots)`, `clear()`, `count`, `pending` | W8 |
| Rc4 | `capture/capture.ts` | `AudioCapture` (`state`, `seconds`, `bytes`, `truncated`, `start`, `stop`, `mark`, `save`); `_setRecorderLoader` (a rejecting stand-in; Rc4 replaces it with `import("./recorder")` — the only import of `recorder.ts` allowed) | W7 |
| Rc4 (from Rc6, W5) | `capture/recorder.ts` | `Recorder.startLive({ post, head, id, nextId? })` after `begin()`, with the saver's head (`assembleCapture(header, meta, [])`); `stopLive()` at stop. Flow: `open {source: "live"}` → `opened`; one `appendSegment` per sealed segment (seals when the next keyframe opens, so the view lags ≤ 1 s) → `appended`; an evicted-before-posted segment sets `liveLost` and stops the feed | Rc4 wires it (W7) |
| Rc2 | `core/context.ts` | `CoreLink.recorderTap: RecorderTap \| null`, called between the STATUS decode and the RECYCLE | W4 |
| Rc3 | `mix/profileSink.ts` | `ProfileSink` (all §5.6 kinds, `epoch`, `gap`, `marker`), `NULL_PROFILE_SINK`; `CoreBackend.setProfileSink` | W6 |
| Ld4 | `mix/loudnessHub.ts` | `LoudnessHub.feed(status)`, `target` get/set; registers on the mixer through `setLoudnessSource` (Mx1) | W2 |
| Cp2 | `core/coreBackend.ts` | `cpu()` (null figure) — the body moves to `mix/cpuMeter.ts`; the coordinator wires it | W3 |
| Dbg1 | `core/coreBackend.ts` | `mixDebug()` (identity slots, zero counters); `mixCaps` | W4 |
| Dp1 | `core/coreBackend.ts` | `duckGain(bus)` → 1 | W4 |
| Mx2 | `backend.ts` bus rows | `lastRampStartFrame?` (undefined until Mx2) | W3 |
| Ld2 (granted lines in `coreBackend.ts`) | `mix/loudnessHub.ts` (Ld4, filled) | wire the hub: `configure(...)` on project load and on a live edit of meters, targets or `loudnessResetOnPlay`; `feed(status)` in the STATUS handler; `epoch()` on an EPOCH; `play()` at the editor's Play; `attach(mixer)` once; `setGateSink` to re-send `LOUD_CONFIG`'s gate. Mixer panel inputs (Mp1b): `noteMonitorMute`, `noteMonitorSolo`, `setCompare`, `setMonitorActive`; backend inputs: `setMasterNotUnity`, `setMuted`. Babylon (Bb2): `configure({ available: false, ... })` | W6 (Ld2), Mp1b, Bb2 |
| Ma1 | `editor/mix/opLog.ts` (Hk1) | `startOpLog(getMixer)` must be called once with the running mixer (wire it where the editor's Play starts the audio backend); `recordMixOps(value, entry, base)` tags an edited section value with its ops — the Mixer panel's edits (Mp1a) pass `base` so the log trusts them instead of diffing | W5 (Ma1), Mp1a |
| — | `backend.ts` | optional `AudioBackend` members: `mixCaps`, `cpu`, `applyOp`, `flushNow`, `rampLane`, `writeSlot`, `writeDucking`, `writeLoudnessConfig`, `duckGain`, `recorderTap`, `setProfileSink`; `AudioDebugInfo`: `mixCaps`, `cpu`, `mix`, `recorder`; `core.currentFrame` filled | declared |

`MixOp`, `ApplyResult` and `LoudnessTarget` aren't exported from `src/myco.ts`; Ma1 or Ld4 adds them if `Bus.apply` becomes public (a public API change, with the coordinator).

**`coreBackend.ts` stubs (Cp2, Dbg1, Dp1):** `coreBackend.ts` is the coordinator's after W1. Those tasks write their logic in their own module (`mix/cpuMeter.ts`, `core/debug.ts`, `core/presence.ts`) and the coordinator replaces the one-line stub with a call when merging, or grants that line in the brief by name.

## Core (K1, `native/audio/crates/`)

"Region" means a slice of that module's own region in `Regions`; each module sizes its own region, so nobody edits `layout.rs`.

| Hook | Receives | Returns | Filled by |
|---|---|---|---|
| `lanes::apply` | `&mut BusLanes`, the bus gain `&mut Ramp`, `Option<&BusAuto>`, the duck curve `Option<&[f32;128]>`, `l`, `r`, `&mut [f32;128]` curve out | `Gain::{Unity, Scalar(g), Curve}` | B1a, B1b |
| `lanes::apply_master` | the output's `&mut BusLanes`, `&mut Ramp`, `out_l`, `out_r` | — | B1a |
| `lanes::settle`, `lanes::settle_master` | lane entry + the slot or master ramp (RESET) | — | B1a |
| `lanes::gain_ramp` | `&BusSlot` | `&Ramp` (what `chain.rs` reads) | B1a |
| `lanes::on_ramp` | core, msg, off, `at: Option<u64>` | — | B1a, B1b |
| `lanes::mix` | `BUS_MIX` (moved from `bus.rs`) | — | retired by R0 |
| `bus_slots::apply` | slot, `fresh`, parent, effects iterator, rate | `(dropped, has_reverb)` | B2 |
| `bus_slots::on_slot` | core, msg, off, `at` | — | B2 |
| `bus_order::compute` | `&[BusSlot]`, `&mut [u8]` order out | — | B3 (adds a rules parameter) |
| `duck::detect` | `&mut DuckArea`, bus, `l`, `r` (the pre-fader tap) | — | Sc1 |
| `duck::gain` | `&mut DuckArea`, bus, `&mut [f32;128]` | `bool` (false = identity; the gain stage skips the multiply) | Dp1, Sc1 |
| `duck::on_rules` | `BUS_DUCK` | — | B3 |
| `duck::on_presence` | `BUS_PRESENCE`, `at` | — | Dp1 |
| `duck::status` | core, `&mut MixSections` (fills `busDuck`) | — | Dp1 |
| `duck::reset`, `duck::init` | core | — | Dp1, Sc1 |
| `loudness::tap` | region, bus or `OUTPUT_TAP`, `l`, `r` | — | Ld2, Ld7 |
| `loudness::on_config` | `LOUD_CONFIG` | — | Ld2 |
| `loudness::status` | core, `&mut MixSections` (fills `loudBuses`, `loudEnergies`; must not advance the cursor) | — | Ld2 |
| `loudness::taken` | core, `&MixSections` (after a successful take) | — | Ld2 |
| `loudness::meter` | region, meter index | `(state 1,512 B, ring 128 B)` | Ld2 |
| `loudness::init`, `loudness::reset` | core | — | Ld2 |
| `sends::feed` | `&mut SendArea`, `Gain`, curve, `rev_l`, `rev_r` (adds unscaled today) | — | Rv1 (scales; skips on `Unity`) |
| `sends::convolver_should_run` | `&mut SendArea`, reverb region, `has_reverb`, `sent` | `bool` | Rv1 (the run-out) |
| `*_is_well_formed` (scheduler) | msg, off, len | `bool` | done (count checks for `BUS_DUCK`, `BUS_SLOT`, `LOUD_CONFIG`) |

**Counters:** `Counters::mix` (`MixCounters`): `wu_*` (f64), `loud_sub_block_frames`, `loud_shed`, `bus_records_early`, `sidechain_late`, the shell fields, `live_deferred`, core-only counts with `note_*` helpers.
**Regions:** lanes (max_buses + 1) × 128 B (the last is the output); duck ≈ 1.4 KB (`DuckArea`); loudness 14,824 B; sends 1,088 B (the 1 KB scratch + a 64-B run-out header).
