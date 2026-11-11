# 0162 spatial audio: the architect's contracts for `api-and-models.md`

What [architecture.md](architecture.md) needs from the senior engineer's document, numbered **C1–C24**. Each gives the exact shape the architecture assumes; the senior engineer may change a shape, as long as the change is written down where the coordinator merges both lists. Byte offsets are within the record **payload** (after the 12-byte record head, [A157] api §4.2); all little-endian. Names in `code` are the ones the architecture uses.

## Wire (`audio-wire/src/schema/`)

**C1. Voice flags (PLAY `flags` u16, SET_PARAMS `flags` u32).**
- `panner` (bits 5–6): value **2 = bed** (encode into the bus's target bed; the core falls back to equal-power when the bus's target is 0xFF or no bed region exists). Value 3 stays reserved.
- New bit **7 `ambisonic`**: the clip is B-format (ACN/SN3D, order from its channel count 4/9/16); `spatial` and `panner` are ignored; read from PLAY only.
- PLAY `reserved` (u16) stays reserved.

**C2. BED_CONFIG, opcode 0x16, variable.** `u32 busCount` then per bus `u8 bedSlot` (0..maxBeds−1, or 0xFF = none/equal-power), `u8 owns` (1: this bus decodes `bedSlot` into its own buffer), `u16 reserved`. Applies on arrival (like BUS_CONFIG). Core validation: exactly one owner per used slot; a slot with no owner, or a non-owner whose owner is not an ancestor or the first root, is treated as 0xFF and counted. Sent after BUS_CONFIG whenever the tree or a bed setting changes, and in REPLAY right after BUS_CONFIG.

**C3. SET_VOICE_FX, opcode 0x0A, fixed 44 B total.** `u32 mask` (bit0 `hpHz`, bit1 `sends`, bit2 `yaw`), `u32 rampFrames`, `f32 hpHz` (10 = off), `f32 send[4]` (per zone slot 0..3, linear 0..1; 0 = no send), `f32 yaw` (radians, ambisonic voices only). Stamped like SET_PARAMS. Sent right after PLAY in the same batch when any value differs from the defaults, and when a send moves > 0.5 dB or `hpHz` changes.

**C4. LISTENER, opcode 0x20, fixed 32 B total.** `f32 qx, qy, qz, qw` (world-to-listener rotation, unit quaternion), `u32 rampFrames`. `sent_in_m1` becomes "sent". asap; the core slerps per quantum over `rampFrames`.

**C5. ZONE_CONFIG, opcode 0x17, variable.** `u32 slotCount` (≤ 4), `f32 sharedReturnGain` (0..1, the shared reverb's return: 1 − the listener's zone weight), `u32 rampFrames`, then per slot: `u32 kernelId` (a reserved format-3 clip id, 0 = slot off), `u16 returnBus`, `u16 flags` (bit0 `active` — fade in over 100 ms when the kernel is resident; clear: sends are ignored and the tail rings out), `f32 wet` (linear 0..2), `u32 irFrames` (at the context rate; for the planner and the silence check). Applies on arrival; starting a slot runs the stagger planner.

**C6. Blobs and channel counts (envelope `CLIP_*`, `STREAM_*`).**
- CLIP_BEGIN `format` **3 = zone kernel**: reserved ids `0xFFFF0100..=0xFFFF01FF`; `channels` 2; `frames` = the IR's frames at the context rate; body = the partition spectra laid out as M1's convolver region expects (head 32 × 129 complex f32 per channel, tail partitions × 2,049 complex f32 per channel), or with CLIP_BEGIN `flags` bit0 `pcm`: interleaved f32 time-domain IR that the core prepares itself (one prepare unit per quantum).
- `format` **4 = MagLS filters**: id `0xFFFF0001`; time responses f32, 16 channels × 2 ears × `taps` (256 at 44.1/48 kHz, 512 above 88.2 kHz), at the context rate; the core transforms in `onmessage`.
- Both outside `clipMemoryMB`; format 3 counted in the zone kernel budget.
- `clip_reserve` accepts **1, 2, 4, 9, 16** channels for format 0/1 (int16/f32) clips.
- STREAM_OPEN `channels` 1–16; a stream with > 2 channels takes a **wide ring**; refused (`STATUS` stream event) when none is free.

**C7. STATUS `spatial` section** (a new section, counted like the others): per bed slot `u16 ownerBus, u16 voices, u16 clips, u16 flags(bit0 decoding), u32 workUnits`; per zone slot `u32 kernelId, u16 state (0 off, 1 waiting kernel, 2 fading in, 3 active, 4 ringing out, 5 stopped), u16 quantaSinceInput, f32 inPeak, f32 wetPeak, u8 f[2], u8 i[2]`; then `u32 bedSwitches, u16 wideStarved, u16 irPrepInCore, u16 m3Shed, u16 reserved`; kernel events go in the existing clip-event list with codes `resident`/`refused`.

## Core ABI and layout

**C8. Init.** A new export `myco_audio_init_spatial(max_beds: u32, zone_slots: u32, zone_max_frames: u32, wide_streams: u32) -> i32`, called once after `myco_audio_init` and before the first `process` (like `set_limiter_lookahead`; refused after). New regions appended before `Arena` in `REGION_ORDER`: `Beds` (`max_beds` × 48 KB + `wide_streams` × 48 KB private decoders), `Zones` (`zone_slots` × state bytes for `zone_max_frames`), `WideStreams` (`wide_streams` × 16 × 38,400 × 4 B). Without the call every region is 0 bytes and kind 2 pans equal-power. ABI version **2.0 (0x200)** (new opcode meanings and init call; the engine is unpublished, so no compatibility path), schema hash regenerated.

**C9. Decoder worker.** Decoder ABI export `myco_decode_prepare_ir(handle: i32, context_rate: f32, max_frames: u32, out: *mut u8, out_len: u32) -> i32` (decode, cut to `max_frames` with a 50 ms fade, resample, normalise as `convolver::ir`, build spectra; returns bytes written or a negative code), and `myco_decode_ir_bytes(frames: u32, rate: f32) -> u32`. Protocol (`decoder/protocol.ts`): `{ kind: "prepareIr", token, assetUrl, contextRate, maxFrames, kernelId }` → worker sends CLIP_BEGIN/CLIP_CHUNK format 3 to the worklet port, then `{ kind: "irPrepared", token, kernelId, frames, truncated, prepareMs }` or `{ kind: "irFailed", token, code, message }` to main. STREAM_OPEN gains `convention: 0 ambix | 1 fuma` (the worker converts FuMa per chunk).

## Settings, components, formats

**C10. Settings** (`audio.*` in `project.json`; numbers stored, presets are editor bundles, low / default / high):

| Key | Type, range | Default (absent) | Presets |
|---|---|---|---|
| `audio.bed.maxBeds` | int 0..4 | 2 | 0 / 2 / 4 |
| bus `bed` | `"own" \| "parent" \| "none"` | `"parent"` | — |
| bus `bedPriority` | int 0..255 | 128 | — |
| `audio.voices.hrtf` | int 0..32 | 16 | 4 / 16 / 8 |
| `audio.ambisonic.maxClips` | int 0..4 | 1 | 1 / 1 / 2 |
| `audio.occlusion.budgetMs` | number 0.02..2 | 0.25 | 0.06 / 0.25 / 0.5 |
| `audio.occlusion.layers` | string[] (physics layer names) | absent = every layer | — |
| `audio.occlusion.defaultMaterial` | material name | `"concrete"` | — |
| `audio.occlusion.materials` | C12 rows | the shipped table | — |
| `audio.zones.maxActive` | int 0..3 | 2 | 1 / 2 / 2 |
| `audio.zones.maxIrSeconds` | number 0.5..8 | 2 | 1 / 2 / 4 |
| `audio.speedOfSound` | number > 0, world units/s | 343 | — |
| `audio.doppler.maxSpeed` | number > 0, world units/s | 150 | — |

No enable flags (owner decision 2). `audio.spatial: "equalPower"` keeps beds with the equal-power decode.

**C11. Components.**
- `AudioSource` gains `occlusion: boolean` (default true; inert for non-spatial sources and without the 3D physics service), `dopplerLevel: number` (0..5, default 1 for spatial, ignored for non-spatial), `reverbSend: number` (0..1, default 1 for spatial, 0 for non-spatial), `reverbSendCurve?: Curve` (absent = the default rise), `ambisonicYaw: number` (degrees, ambisonic clips only). All must be in `apply()`'s change signature and `applyEvent()`.
- `AudioReverbZone`: `shape: "box" | "sphere"`, `size: Vector3` (box), `radius: number` (sphere), `ir: AssetRef<audio> | ""`, `preset: string` (procedural IR name when `ir` is empty: `"room"`, `"hall"`, `"cave"`, `"plate"`), `wet: number` (linear 0..2, default 1, like bus gains), `blendDistance: number` (m, default 2), `priority: number` (0..255, tie-break of send energy), `output: string` (bus name, default Master).
- `AudioOccluder`: `material: string` (a C12 name), optional overrides `transmissionDb?`, `cutoffHz?`, `wetOcclusion?`. Declares it needs `myco.physics3d` only for the editor's note, never to start it.

**C12. Occluder material table** (project data, editable in Project Settings > Audio): rows `{ name: string, transmissionDb: number (≤ 0), cutoffHz: number (20..20000), wetOcclusion: number (0..1) }`. The shipped rows (values est., for the listening pass to tune): wood −12 dB / 2,500 Hz / 0.5; concrete −30 / 800 / 0.6; glass −8 / 5,000 / 0.4; metal −25 / 1,200 / 0.6; cloth −4 / 8,000 / 0.3.

**C13. One-shots and events.** `OneShotOptions` gains `occlusion?: boolean` (default true when `position` is given), `dopplerLevel?: number` (default 0: one-shots opt in), `reverbSend?: number` (default 1 with `position`). `myco.audioevent@1` gains optional `filter: { lowpass?: number, highpass?: number }` (Hz), `sends: { reverb?: number }` (the zone send scale; other keys reserved), and under `spatial`: `occlusion?: boolean`, `dopplerLevel?: number` (default 0), `reverbSend?: number`. The event's `filter.lowpass` is the static floor of the `lowpass` target (lowest wins).

**C14. Physics World service ray query** (`myco.physics3d`, a physics-plugin change): `raycastInto(out: RayHitOut, ox, oy, oz, dx, dy, dz, maxDistance: number, groups: number, flags: number, excludeA: number, excludeB: number): boolean` with `flags` bit0 `excludeSensors`; `out` a preallocated `{ colliderId: number, node: GameObject | null, distance: number, px, py, pz }`; no allocation per call; `excludeA/B` collider-id ranges or node ids to skip (the source's subtree and the listener). Plus `groupsFor(layers: string[] | undefined): number` (from `layers.ts`). The audio plugin reaches it through `_worldServiceOf(world, PHYSICS_3D)` and never starts the service.

**C15. `AudioDebugInfo` additions** (public type, 0157 versioning): `voices[].panner: 0 | 1 | 2`, `voices[].bed?: number`, `voices[].occlusion?: { gainDb, cutoffHz, ageFrames, material?, node? }`, `voices[].lowpass?: { hz, by: "occlusion" | "event" | "automation" | "bus" | "snapshot" }`, `voices[].sends?: { zone: string, level: number }[]`, `voices[].doppler?: number`, reason `"occluded"`; `beds: { slot, owner, sharing: string[], denied: { bus, reason }[], voices, clips, costUs, state }[]`; `zones: { name, state, weightSum, energy, rank, slot?, kernelBytes, irSeconds, prepareMs?, by: "worker" | "core", error? }[]`; `occlusion: { rays, budgetRays, rayCostUs, tier, candidates, oldestAgeFrames, overruns, noPhysics }`; `memory.beds, memory.zones, memory.kernels, memory.kernelBudget, memory.wideRings`; counters of C24.

**C16. Ambisonic clips' sidecar** (0040): `ambisonic: { order: 1 | 2 | 3, convention: "ambix" | "fuma" }`, required to treat a > 2-channel clip as ambisonic. A > 2-channel clip without it is quad or surround, which M3 doesn't play: refused with a warning naming the key (the senior engineer may choose a downmix instead). Import checks: channels = (order+1)²; FLAC only for order 1; Opus refused; `stream` defaults to true for ambisonic clips. An `AudioSource` with such a clip ignores `spatial`.

## Core internals the architecture relies on

**C17. Per-voice filters.** `VoiceAuto` gains a second `Biquad` (`hp`) and a field `fold_lp`; a voice joins the dense active list when `min(lpHz, lpAuto, foldLp) < 20,000` or `hpHz > 10`; `auto_gain_and_filter` (`voices.rs`) applies the low-pass at that minimum and the high-pass, coefficients at most once per quantum, log2-ramped over `rampFrames`. Voices with neither stay bit-identical to M2 (goldens unchanged).

**C18. Work-unit coefficients** (`cap::wu`, informational): `BED_DECODE` 20,000, `BED_VOICE` 500, `AMBI_ROTATE` 5,000, `AMBI_READ` 8,000, `ZONE_BASE` 8,500, `ZONE_PER_S` 4,500, `ZONE_PREP_UNIT` 20,000 (est.); render notes gain *B*, *N*_bed, *A*, *A*_solo, *P*_lp, *P*_hp, *S* and zone seconds; `MOVING_VOICE` is not counted for kind-2 voices. Replaced by A3.5-style sweeps (§7.5).

**C19. Benchmarks.** `audio-bench mode=scene name=m3-high,m3-worst-high,m3-worst-default,m3-worst-low`; `mode=fit` sweeps for C18's terms; `mode=memory` covers C8's regions. Metered CI scenes: `bed-64`, `bed-256`, `bed-xfade`, `ambi-o3`, `zones-2x2s`, `zones-swap`, `filters-256`, `m3-high`.

**C20. Voice table and selection (main).** New typed arrays per slot: `occGain`, `occLp`, `occTargetGain`, `occTargetLp`, `occAge` (u16 frames), `occFlags` (enabled, cast this frame), `dopplerF`, `prevPos[3]`, `sendLevel[4]`, `sentSend[4]`, `hpHz`, `yaw`; a per-World listener `prevPos`. Selection's audibility = pre-occlusion audibility × `occGain`; a mixed voice's keep key uses `max(occGain, occTargetGain)` (no-gap); the occlusion pass reads the pre-occlusion audibility, which selection exposes as `audibility0`.

**C21. Babylon fallback.** `AudioVoice`/backend gains `setOcclusionGain(g)` (gain only), `setDopplerFactor(f)` (into `playbackRate`), and a backend-level `setReverbZone(irClip | null, wet)` driving one `ConvolverNode` (the zone with the most send energy); ambisonic clips play channel 0 mono with one warning; event filters and per-voice sends warn once.

**C22. Editor SDK.** A gizmo contribution in `src/editor/sdk` (volume shapes with blend shells for `AudioReverbZone`; material tint for `AudioOccluder`'s collider), an occlusion debug overlay contribution (rays, results, ages), and the material table editor in Project Settings > Audio; all through the SDK (`plugins.test.ts`).

**C23. Presets in the editor.** The Audio preset bundles (low / default / high) set C10's per-preset values together with M1's (`voices`, `clipMemoryMB`), so choosing "high" writes `maxBeds` 4, `voices.hrtf` 8, `budgetMs` 0.5, `maxActive` 2, `maxIrSeconds` 4, `ambisonic.maxClips` 2.

**C24. Counters** (STATUS or main, all in `Audio.debug().core` counters): `bedDenied`, `bedSwitches`, `bedFilterLoadFailure`, `belowHorizonVoices`, `zonesSuppressed`, `irTruncated`, `irFailures`, `kernelRefused`, `irPrepInCore`, `irPrepares`, `occlusionNoPhysics`, `occOverruns`, `occOldestAgeFrames`, `wideStarved`, `dopplerClamps`, `dopplerTeleports`, `m3Shed`.
