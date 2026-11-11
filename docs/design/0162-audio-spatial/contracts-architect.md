# 0162 spatial audio: the architect's contracts for `api-and-models.md` (round 2B)

What [architecture.md](architecture.md) needs from the senior engineer's document, numbered **C1–C24**. This revision follows the coordinator's rulings R1–R17 ([rulings.md](rulings.md)). Byte offsets count from the record's first byte, head included (12 B: `u16 opcode; u16 words; u32 voiceId; u32 frameOffset`); everything is little-endian. The owner's round-3 decisions OD1–OD5 are applied.

## Wire (`audio-wire/src/schema/`)

**C1. Voice flags** (PLAY `flags` u16, SET_PARAMS `flags` u32). `panner` (bits 5–6) value **2 = bed**: the core resolves it through the voice's bus `bedSlot` and pans equal-power when that is 0xFF. Value 3 stays reserved. New bit **7 `ambisonic`**, read from PLAY only: order from the channel count (4/9/16); `spatial`, `panner` and `dir*` are ignored.

**C2. BED_CONFIG, 0x16** (R1; applies on arrival).
- At 12: `u32 busCount`. At 16: `u32 slotCount` (≤ `max_beds`).
- From 20: `u8 bedSlot[busCount]` (0xFF = none), padded to 4 B.
- Then `u16 hostBus[slotCount]` (0xFFFF = slot unused), padded to 4 B.
- Core validation: a slot's host must be the bus itself or an ancestor of every bus that feeds it. Otherwise those buses are treated as 0xFF and counted. Slot ids are stable across replans; a slot that keeps its host keeps its decoder state.
- Sent after BUS_CONFIG and on every bed-setting change; in REPLAY right after BUS_CONFIG.

**C3. SET_VOICE_FX, 0x0A, 52 B** (R2; stamped like SET_PARAMS).

| Offset | Type | Field |
|---|---|---|
| 12 | u32 | `mask`: bit0 `hpHz`, bit1 `sends`, bit2 `yaw`, bit3 `aux` |
| 16 | u32 | `rampFrames` |
| 20 | f32 | `hpHz`, ≤ 20 is off |
| 24 | f32 | `send[4]`, linear, per zone slot 0..3, pre-distance (main includes volume, curve, weight and wet factor) |
| 40 | f32 | `yaw`, radians, ambisonic voices |
| 44 | f32 | `auxLevel` |
| 48 | u16 | `auxBus`, 0xFFFF = none |
| 50 | u16 | reserved |

Sent after PLAY, and with SET_MIXED on promotion, when non-default; afterwards on a change past 0.5 dB, 1 Hz or 0.001 rad. The state lives in the core's **mixed-voice pool**; virtual voices hold none.

**C4. LISTENER, 0x20, 36 B** (R3; asap). At 12: `f32 qx, qy, qz, qw`, the **world → listener** rotation (normalised by the core; non-finite or zero is ignored). At 28: `u32 rampFrames`, the core slerps per quantum. At 32: `u32 flags`, bit0 **snap** (jump, no ramp). Sent when the rotation moves more than 0.001 rad, on a cut, and on the first ambisonic play. Axis map: (X, Y, Z)_ambix = (−z, −x, +y)_engine.

**C5. ZONE_CONFIG, 0x17** (R4; idempotent; applies on arrival; matches [API §4.2]).
- At 12: `u32 slotCount` (≤ 4). At 16: `f32 sharedReturnGain` (0..1, ramped). At 20: `u32 rampFrames`.
- Then per slot, 16 B: `u32 kernelId` (0xFFFF0200..=0xFFFF02FF; 0 = off), `u16 returnBus` (the zone's `output`, R17), `u8 state` (1 active, 2 release: sends ignored, the tail rings out, then the slot is off), `u8` reserved, `f32 wet` (0..2), `u32 irFrames`. Total `24 + 16n`.
- `state` 3 = evict (sends ignored, wet fades out over 150 ms, then the slot is off). Used on the low preset, which has no standby slot (OD2).
- The core holds an active slot whose kernel isn't resident as "waiting for kernel" and fades it in over 100 ms once the kernel arrives. It refuses a new `kernelId` in a slot that isn't off.
- The stagger planner runs only when a slot starts, never for a `wet` or `sharedReturnGain` change.

**C6. Clip formats and ids** (R5, R7).

| Format | Id | Content |
|---|---|---|
| 3, prepared zone kernel | 0xFFFF0200..=0xFFFF02FF | `channels` 1, `frames` = bytes / 4; packed spectra as `convolver.rs` (head 32 partitions × 128 bins, tail partitions × 2,048 bins, bin 0 holding DC and Nyquist), normalisation baked in; header as [API §4.6] |
| 4, MagLS filters | 0xFFFF0100 | time responses f32, 16 channels × 2 ears × taps (256 at ≤ 48 kHz, 512 above 88.2 kHz) at the context rate |
| 5, zone IR PCM | 0xFFFF0200..=0xFFFF02FF | interleaved f32 at the context rate; the core prepares it into the same block, one unit per quantum (the worker-missing path) |

- Formats 3–5 are outside `clipMemoryMB`; formats 3 and 5 count against the zone kernel budget.
- `clip_reserve` accepts 1, 2, 4, 9 and 16 channels for formats 0 and 1.
- STREAM_OPEN accepts `channels` 1–16. More than 2 takes a wide ring (C8); with none free the open is refused with a stream event. A `convention` field gives AmbiX 0 or FuMa 1; the worker converts FuMa per chunk.

**C7. STATUS** (as [API §4.3]):
- The header grows from 112 to 144 B: `bedVoices`, `bedsActive`, `fxVoices`, `ambisonicVoices`, `zonesActive`, `zonesRinging`, `zoneEventCount`, `bedsRefused`, `zoneUsedKB`, `workBed`, `workZones`.
- Sections follow: `beds {u16 bus, u16 voices, u32 work}` (≤ 4), `zones {u32 kernelId, u8 state, u8 pad, u16 quantaSinceInput, f32 wetPeak}` (≤ 4; state 0 off, 1 waiting for kernel, 2 fading in, 3 active, 4 ringing out, plus 5 evicting, low preset), and `zoneEvents` (≤ 16).
- Worst case 15,904 B of 16,384 B. Main adds `bedSwitches`, `zonesFaded` and the occlusion counters (C24).

## Core ABI and layout

**C8. One init** (R6): `myco_audio_init(sample_rate, max_logical, max_mixed, max_buses, arena_initial_bytes, max_beds, max_zone_slots, zone_max_frames, max_wide) -> i32`.
- New regions go before `Arena` in `REGION_ORDER`, each a pure function of `InitParams`:
  - `Beds`: `max_beds` × 48 KB, plus `max_wide` × 48 KB of private decoders;
  - `Zones`: `max_zone_slots` × convolver state at `zone_max_frames`;
  - `Wide`: `max_wide` × 16 × (16,384 + 2,048 + 1,536) × 4 B = 1.22 MiB each (2.22 MiB with a 32,768-frame ring if the R16 stall test fails), 2,048-frame chunks of 128 KB;
  - `Fx`: `max_mixed` × ≈ 448 B (the mixed-voice pool: 28 / 56 / 112 KB).
- `max_zone_slots` = `maxActive + 1` on default and high (the standby slot includes its kernel) and `maxActive` on low (eviction fade; an incoming zone's kernel waits 50–200 ms for the free slot) (OD2).
- ABI 2.0 (0x200); schema hash regenerated. `myco_audio_zone_kernel_budget_bytes(max_zone_slots, zone_max_frames)` lets the shell size the memory maximum (fixed regions + `clipMemoryMB` + the kernel budget).

**C9. Decoder worker.**
- Exports `myco_ir_prepare(...)` and `myco_ir_generate(preset, rate, max_frames)` ([API §5.3]), with a 50 ms cut fade.
- Protocol: `prepareIr` / `generateIr { token, assetUrl | preset, contextRate, maxFrames, kernelId }`. The **worker** sends CLIP_BEGIN/CLIP_CHUNK format 3 **to the worklet port**, then posts `irPrepared { token, kernelId, frames, truncated, prepareMs }` or `irFailed { token, code, message }` to main.
- The worker keeps the encoded bytes for re-preparation; main never holds kernels or time-domain IRs.

## Settings, components, formats

**C10. Settings** (R8; numbers stored; presets are editor bundles, low / default / high).

| Key | Range | Default | Presets |
|---|---|---|---|
| `audio.bed.maxBeds` | 0..4 | 2 | 0 / 2 / 4 |
| bus `bed` | `own` \| `parent` \| `none` | `parent`; the root `own` | — |
| bus `bedPriority` | 0..255 | 128; the root 255 | — |
| `audio.voices.hrtf` | 0..32 | 8 | 4 / 8 / 8 (OD1: 8 where beds exist) |
| `audio.ambisonic.maxClips` | 0..4 | 1 | 1 / 1 / 2 |
| `audio.occlusion.budgetMs` | 0.05..2 | 0.25 | 0.06 / 0.25 / 0.5 |
| `audio.occlusion.layers`, `defaultMaterial`, `smoothingMs`, `materials` | as [API §2.1] | all layers, `concrete`, 100, [API §2.2] | — |
| `audio.zones.maxActive` | 0..2 | 2 | 1 / 2 / 2 |
| `audio.zones.maxIrSeconds` | 0.5..8 | 2 | 1 / 2 / 4 |
| `audio.speedOfSound` | > 0 | 343 | — |
| `audio.doppler.maxSpeed` | > 0 | 150 | — |
| `audio.spatial: "equalPower"` | — | — | keeps beds with the baked 16 → 2 decode (R9) |

**C11. Components.**
- `AudioSource` gains `occlusion` (true), `dopplerLevel` (0..5, 1 for spatial sources), `reverbSend` (0..2, default 1; send × curve clamped to 4) and `reverbSendCurve` (an absolute send-versus-distance curve, taken **pre-distance**, R11; default 1 at `minDistance` → 0.5 at `maxDistance`, est.), plus `ambisonicYaw` (degrees). All new fields go in `apply()` and `applyEvent()`.
- `AudioReverbZone` as [API §1.5] plus **`output`** (bus name, default Master, R17). Presets: `room`, `corridor`, `hall`, `cave`, `open` (R10).
- `AudioOccluder` as [API §1.5] (`material`, `transmissionTrimDb`, `cutoffScale`, `openness`; R10, R15).

**C12. Materials:** [API §2.2], with `none`, attack and release.

**C13. One-shots and events:** [API §1.3, §2.5], with event `sends.reverb` as the zone send and `sends.<bus>` as the one aux send (R2).

**C14. Physics ray query** (R12; as [API §6]): a core-level interface in `src/engine/core/worldServices.ts`, so the audio plugin needs no physics import: `raycastInto(world, out, origin, dir, maxDistance, query): boolean`.
- `out` is a preallocated `{ node, distance, point }`.
- `query` is `{ groups, excludeNodes, includeSensors: false }`; `excludeNodes` holds the source's subtree and the listener's node.
- Exclusion happens **inside the query** (Rapier's predicate filter), so the first hit returned is never an excluded collider.
- No allocation per call. `groupsFor(layers?)` is computed once per settings change. Audio never starts the service.

**C15. `AudioDebugInfo`:** [API §1.6], plus `beds[].denied`, `zones[].prepareMs` and `zones[].by` (`worker` | `core`), `occlusion.rayCostUs`, the `memory.*` fields and the C24 counters.

**C16. Sidecar `ambisonic`:** [API §2.4].

## Core internals the architecture relies on

**C17. The mixed-voice pool.**
- One entry per mixed slot (`max_mixed`, ≈ 448 B): low-pass and high-pass `Biquad`, log2 cutoff ramps, `send[4]` and aux ramps, `auxBus`, `yaw`, bed share ramp, 16 f32 bed gains. Reset on promotion.
- `VoiceAuto.filter` migrates here, bit-identically.
- Mono voices are filtered once before the copy to two channels.
- Ambisonic voices are never filtered.
- **Send tap (R11 as clarified):** after the voice's own filters (occlusion low-pass, event filter, automation low-pass; mono-once) and before the distance gain. `send[k]` from main carries `wetOcclusion` and the send curve. A voice with sends runs filter → send tap → dry gain; one without keeps M2's order. [API §4.4] still says pre-filter and must change to match. Voice filters are off at ≥ 20,000 Hz and ≤ 20 Hz; the bus snapshot keeps `lowpass_on`.

**C18. Work units** (`cap::wu`, informational): `BED_DECODE` 20,000, `BED_VOICE` 500, `AMBI_ROTATE` 5,000, `AMBI_READ` 8,000, `ZONE_BASE` 8,500, `ZONE_PER_S` 4,500, `BIQUAD` 1,200, `BIQUAD_MONO` 600, `REVERB_SEND` 150, `AUX_SEND` 300, `ZONE_PREP_UNIT` 20,000 (est.). Kind-2 voices don't count `MOVING_VOICE` and don't get credit for skipping it.

**C19. Benchmarks:** [API §9]'s scenes plus `m3-worst-high`, `m3-worst-default`, `m3-worst-low`, all `pace=1`; `mode=fit` for every C18 term; a 16-channel stream test with a 300 ms decoder stall (R16).

**C20. Voice table (main):** [API §3.2]'s columns. Selection's audibility = `audibility0 × occGain`, with the no-gap rule. The panner pick enforces a 500 ms kind dwell in game time (R13 as clarified). Send, high-pass, yaw and aux targets are re-sent with SET_MIXED on promotion.

**C21. Babylon fallback:** [API §8] (gain-only occlusion, `playbackRate` Doppler, W-only clips, **zones inert with one warning** (OD5)).

**C22. Editor:** [API §7]'s `registerViewportTool` and Inspector contributions; no new SDK point.

**C23. Presets:** each editor bundle writes C10's preset values together with M1's.

**C24. Counters:** `bedsRefused`, `bedSwitches`, `bedFilterLoadFailure`, `belowHorizonVoices`, `zonesFaded`, `irTruncated`, `irFailures`, `kernelRefused`, `irPrepInCore`, `irPrepares`, `occlusionNoPhysics`, `occlusionRays`, `occlusionOverruns`, `oldestOcclusionAgeFrames`, `wideStarved`, `dopplerGuardTrips`, `dopplerClamps`, `m3Shed` (the ladder, OD3).
