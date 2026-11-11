# 0162 spatial audio: API, data models, formats and plan (M3), revision 2

Senior engineer's design for ADR 0162 (Accepted direction, revision 3). Companion to `architecture.md` (cited **[ARCH §n]**: components, lifecycles, interactions, timing, memory, performance, failure, observability, platform matrix, industry practice), to 0157's `api-and-models.md` (**[0157 §n]**, not repeated) and to 0157's `architecture.md` (**[A157 §n]**). This file owns the public API, settings and asset data, internal data models, byte formats, native and TypeScript layout, editor integration, the Babylon mapping, the test plan and the task table. Revision 2 applies the coordinator's rulings (`rulings.md`, **R1-R17**) and both round-2A reviews; §12 lists every review item and what became of it.

Units as in 0157: seconds, world units (`audio.speedOfSound` is in units per second), linear gain, frames at the context rate, Hz, little-endian; degrees only where a field says so. Byte offsets are from the first byte of a record, head included. Line numbers cite the tree at 2026-11-11. Owner rules applied: follow Wwise, FMOD, Unity and Unreal (industry notes are inline, the full map is [ARCH §12]); no feature flags, no migration (the samples change, §1.6); no run that cannot change a decision (§9).

## 1. Public API

All additions are optional with defaults, exported from `src/myco.ts` (§6). Nothing names Babylon, three.js, Rapier or Howler (ADR 0010).

### 1.1 Types

```ts
export type AudioReason = /* 0157's six */ | "occluded";   // virtual or inaudible mainly because a wall took it under the floor
export type AudioPanner = "flat" | "equalPower" | "hrtf" | "bed" | "ambisonic";
/** A send's level against distance (0158 `Curve`): x = distance as a fraction of minDistance..maxDistance (clamped 0..1), y multiplies the send. */
export type SendCurve = Curve;
export const DEFAULT_SEND_CURVE: SendCurve = [[0, 1], [1, 0.5]];
```

`AudioHandle` gains `readonly panner: AudioPanner | null` and `readonly occlusion: number` (smoothed dry occlusion gain, 1 open), both read from the main-thread mirror.

### 1.2 `AudioSource` additions

Each field carries `description` (ADR 0159). `apply()`'s change signature (`AudioSource.ts:179`) and `applyEvent()` (`:161-173`) include all of them, so Play edits take effect next frame.

| Field | Range | Default | Meaning |
|---|---|---|---|
| `occlusion` | boolean | `true` | Spatial sources: walls between source and listener muffle it. Inert in 2D worlds and without the 3D physics service |
| `dopplerLevel` | 0..5 | `1` | Spatial sources: scales the Doppler shift; 0 off |
| `reverbSend` | 0..2 | `1` | Spatial sources: how much of the source goes to the zones that hold it. The send is taken **before** the distance gain (R11, [ARCH §3.3] as amended in §4.5) |
| `reverbSendCurve` | `SendCurve` | `DEFAULT_SEND_CURVE` | Send against distance, independent of the dry rolloff (Wwise's model). `reverbSend` x curve is clamped to 4 |
| `ambisonicYaw` | -180..180 | `0` | Ambisonic clips: turns the recording about the vertical axis, degrees, positive to the right seen from above (ADR 0164; it was positive to the left before, and the format-4 migration negates saved values) |

Read-only: `velocity: Vector3` (world units per second, §3.2), `panner`, `occlusion`. A source whose clip has an `ambisonic` sidecar ignores `spatial`, the distance fields, `occlusion` and `dopplerLevel` (the Inspector greys them; one warning per source). `reverbSendCurve` is `@field(PlainObject)` (the registry has no curve kind) and is drawn with the SDK's `CurveEditor` in an Inspector section (§7). **Industry:** `reverbSend` is Unity's `reverbZoneMix` and Wwise's game-defined aux send, scale 0..2 not Unity's 0..1.1.

### 1.3 `playOneShot` options

```ts
interface OneShotOptions { // + 0157 §1 fields
  occlusion?: boolean;        // with position; default true
  dopplerLevel?: number;      // with position, listener motion only; 0..5, default 0 (opt in)
  reverbSend?: number;        // with position; 0..2, default 1
  reverbSendCurve?: SendCurve;
  lowpass?: number; highpass?: number;   // Hz; the lowest low-pass wins over automation's
  yaw?: number;               // ambisonic clips, degrees
}
```
A flat one-shot has no occlusion, send or Doppler; `lowpass` and `highpass` still apply. Bad values clamp and warn once.

### 1.4 `AudioListener`

```ts
class AudioListener extends Component {
  readonly velocity: Vector3;                 // units/s, from the node's motion (§3.2)
  setVelocity(v: Vec3Like | null): void;      // physics-driven velocity, or zero across a cut; null: estimate again
}
```
No new fields. The listener is the first enabled `AudioListener` in the World with the view, else the main camera; that World alone sends LISTENER, casts rays and plans zones, and other Worlds' sources keep their last occlusion values (R14, S19).

### 1.5 New components

Registered by the audio plugin as `engine.AudioReverbZone` and `engine.AudioOccluder`; both exist in the editor World and in play, and need no physics to exist.

```ts
@component("engine.AudioReverbZone")
class AudioReverbZone extends Component {
  @field(String, { choices: ["box", "sphere"], description: "The zone's shape." }) shape = "box";
  @field(Vector3, { description: "Offset of the volume from the node, local units." }) center = new Vector3(0, 0, 0);
  @field(Vector3, { description: "Box zones: edge lengths in local units, scaled by the node's world scale." }) size = new Vector3(10, 4, 10);
  @field(Number, { description: "Sphere zones: radius in local units, scaled by the node's largest scale axis." }) radius = 5;
  @field(String, { choices: ZONE_PRESETS, description: "Built-in reverb used when no impulse response is set." }) preset = "hall";
  @field(AssetRef, { kind: "audio", description: "An impulse response (mono or stereo WAV or FLAC). Overrides the preset. Past the preset's length limit it is cut with a fade." }) ir = "";
  @field(Number, { description: "Wet level, linear 0..2 (1 = the impulse response's calibrated level, as a reverb bus effect at send 1)." }) wet = 0.5;
  @field(Number, { description: "Distance outside the volume over which the zone fades in, world units. 0 is a hard edge." }) blendDistance = 2;
  @field(Number, { description: "Higher wins when more zones are in play than the preset has reverbs (0..100)." }) priority = 0;
  @field(String, { choices: (s) => ["", ...s.audio.buses.map((b) => b.name)], description: "The bus the reverb returns to (before its effects). Empty is Master." }) output = "";
}
const ZONE_PRESETS = ["room", "corridor", "hall", "cave", "open"] as const;   // R10

@component("engine.AudioOccluder")
class AudioOccluder extends Component {
  @field(String, { choices: (s) => ["", ...s.audio.occlusion.materials.map((m) => m.name)], description: "Material from Project Settings > Audio. Empty is the project's default material." }) material = "";
  @field(Number, { description: "Extra transmission loss for this wall, dB (negative muffles more), added to the material's." }) transmissionTrimDb = 0;
  @field(Number, { description: "Multiplies the material's low-pass cutoff (below 1 duller)." }) cutoffScale = 1;
  @field(Number, { description: "0 closed, 1 open: blends the wall's effect away. Script it for a door (R15)." }) openness = 0;
}
```

An occluder applies to the colliders of its node and of descendants without an occluder of their own (nearest up the parent chain, like `RigidBody`, `Collider.ts:31-37`); `material: "none"` makes colliders transparent. A collider on a layer outside `audio.occlusion.layers` is never hit. **R15:** a door is an `AudioOccluder` on the door's collider with a script moving `openness`; a moving collider uses the same rays, and a disabled collider is simply not hit. Transmission is per hit, not per metre. `enabled = false` skips a zone or occluder. **Industry:** the zone is Unity's `AudioReverbZone` crossed with Wwise's per-emitter room membership (weights **per source**, not per listener; no portals, [ARCH §12]); `AudioOccluder` is a Steam Audio material or Wwise acoustic texture with per-wall trims, one transmission figure rather than bands.

### 1.6 Ambisonic playback, debug additions, compatibility

An ambisonic clip is an ordinary clip path (`AudioSource.clip`, `playOneShot(path, { volume, bus, yaw, reverbSend, at })`); it is ambisonic only by its sidecar (§2.4). Behaviour: [ARCH §2.3]. Its `reverbSend` is its W channel sent to the zones that hold the **listener**.

`AudioDebugInfo` (a public type; 0157's versioning) gains: `counters` (`bedVoices, beds, bedDenied, bedSwitches, fxVoices, ambisonicVoices, zonesActive, zonesRinging, zonesFaded, zoneMemoryKB, kernelRefused, irFailures, irPrepInCore, occlusionRays, occlusionUsedMs, occlusionOverruns, occlusionSources, oldestOcclusionAgeFrames, dopplerClamps, dopplerTeleports, wideStarved, m3Shed`); `buses[]` (`bed`, `bedHost`, `bedLost`); `beds[]` (`slot, bus, sharing[], denied[{bus, reason}], voices, clips, costUs`); `zones[]` (`node, world, slot, state, ir, irSeconds, kernelKB, prepareMs, by: "worker" | "core", sendEnergy, rank, why`); `occlusion` (`enabled, note, budgetRays, rays, rayCostUs, oldestAgeFrames`); `memory` (`beds, zones, kernels, kernelBudget, wideRings`); `voices[]` (`panner, bed, kindDwellMs, doppler, occlusion{gain, cutoffHz, ageFrames, hits, material, collider}, filter{lowpassHz, highpassHz, lowpassBy: occlusion|event|automation|bus|snapshot|parent}, sends[{zone, level}], aux`). `zones[].why` carries the reason a zone is silent (`"faded: preset has 2 reverbs"`, `"IR failed: <message>"`, `"wet 0"`, `"no sources inside"`); the planner logs one warning when it fades a zone, naming it (mid review issue 3). Counters follow [ARCH §9] and its health thresholds (S8).

**Compatibility and the samples** (no migration):

| Item | Today | M3 | Sample impact |
|---|---|---|---|
| `AudioSource`, `OneShotOptions`, `AudioListener`, `AudioReason`, `AudioDebugInfo` | 0157 shapes | §1.1-§1.6, all defaulted | scenes load; `sound-lab` and `stress` orbiting sources now Doppler-shift: set `dopplerLevel: 0` on the pitch and bench sources |
| Distant spatial voices | equal-power beyond `voices.hrtf` | bed (kind 2) where the bus has one | sound changes by design; listening-pass items |
| `voices.hrtf` presets and default | low 4, default 16, **high 32** (`audioSettingsModel.ts:213`); `DEFAULT_VOICES.hrtf` 16 (`settings.ts`) | **8 where beds exist** (default and high), low 4; `DEFAULT_VOICES.hrtf` becomes 8; with `maxBeds` 0 the number is used as set | `sound-lab` (no `voices` key) gets 8; `stress` sets `hrtf: 32`: becomes the high preset's numbers (8, `maxBeds` 4) |
| `audio.bed`, bus `bed`/`bedPriority`, `audio.ambisonic`, `audio.zones`, `audio.occlusion`, `audio.doppler` | none | §2.1; root defaults to `own` priority 255 | `sound-lab` and `stress` get the keys; `sound-lab` marks Ambience `own` |
| `audio.spatial: "equalPower"` | no HRTF | no HRTF; **beds kept**, decoded by the baked 16 to 2 matrix (R9) | none |
| Positioned one-shots and sources | no occlusion, no zone send | on, send 1 | no change without colliders or zones |
| `myco.audioevent@1`, bus `reverb` effect | 0158 keys; shared convolver | additive keys (§2.5); the shared reverb stays and is the "outside any zone" reverb | `sound-lab` events unchanged |
| Babylon fallback, guides | 0157 | §8; `playing-sound.md`, `audio-mixer.md`, `sound-events.md`, `why-no-sound.md`, `audio-minimum-versions.md` amended, `spatial-audio.md` new | task E8 |

## 2. Settings and asset data

### 2.1 `audio` keys

```jsonc
"audio": {
  "buses": [ { "name": "Master", "bed": "own", "bedPriority": 255 },
             { "name": "Ambience", "parent": "Master", "bed": "own", "bedPriority": 200 },
             { "name": "SFX", "parent": "Master" } ],                     // bed absent: "parent"
  "bed": { "maxBeds": 4 }, "ambisonic": { "maxClips": 2 },
  "occlusion": { "layers": null, "budgetMs": 0.5, "defaultMaterial": "concrete", "smoothingMs": 100, "materials": [ /* §2.2 */ ] },
  "zones": { "maxActive": 2, "standby": 1, "maxIrSeconds": 4 },
  "doppler": { "maxSpeed": 150 }, "speedOfSound": 343,
  "voices": { "mixed": 256, "logical": 4096, "hrtf": 8 }
}
```

| Key | Type, range | Default | Parse rule (lenient, `problems[]`, `settings.ts:101-176`) |
|---|---|---|---|
| `bed.maxBeds` | integer 0..4 | 2 | clamp plus problem. 0: no beds |
| `buses[].bed` | `own`, `parent`, `none` | root `own`, others `parent` | unknown: default plus problem |
| `buses[].bedPriority` | integer 0..255 | 128; **root 255** (R8; no hard-coded "Master first") | round, clamp |
| `ambisonic.maxClips` | integer 0..4 | 1 (low 1, default 1, high 2) | clamp. Caps concurrent ambisonic voices, wide rings and private decoders; 0 refuses ambisonic clips with a warning |
| `occlusion.layers` | string list or null | null: every layer, sensors excluded | unknown names dropped plus problem; empty list: occlusion off |
| `occlusion.budgetMs` | number 0.02..2 | high 0.5, default 0.25, low 0.06 | clamp. Converted to a ray **count** per frame [ARCH §3.2] |
| `occlusion.defaultMaterial`, `smoothingMs`, `materials` | name, 10..1000, list (<= 32) | `"concrete"`, 100, §2.2 | unknown material: the first plus problem; duplicate names dropped |
| `zones.maxActive` | integer 0..2 | 2 (low 1) | clamp. 0: zones inert |
| `zones.standby` | integer 0..1 | high 1, default 1, low 0 | clamp. Slots = `maxActive + standby`; the standby slot lets a released zone's tail ring out. Without it (low) a third zone evicts a ringing slot with a 150 ms fade |
| `zones.maxIrSeconds` | number 0.5..8 | high 4, default 2, low 1 | clamp; longer IRs cut with a 50 ms fade |
| `doppler.maxSpeed`, `speedOfSound` | number > 0, 10..100000 | 150, 343 | default plus problem / clamp |
| `voices.hrtf` | integer 0..32 | low 4, default 8, high 8 | as 0157 §2; with `maxBeds` 0 used as set |

Presets stay editor bundles (`VOICE_PRESETS`, `audioSettingsModel.ts:210-214`, `as const`; `voicesPreset()` compares numbers exactly, so the new keys join the comparison). **low** `{ mixed 64, logical 1024, hrtf 4, clipMemoryMB 64, maxBeds 0, maxClips 1, zones 1 x 1 s, budgetMs 0.06 }`; **default** `{ 128, 4096, 8, unset, 2, 1, 2 + 1 standby x 2 s, 0.25 }`; **high** `{ 256, 4096, 8, 256, 4, 2, 2 + 1 standby x 4 s, 0.5 }`; low has no standby slot.

**Bed resolution** is [ARCH §2.1] (candidates sorted by `bedPriority` then depth then index; losers share; `bedDenied`). Deltas: ties at the default 128 go to the shallowest bus, so Master wins by depth and by its default 255; when nobody asks `own` and `maxBeds > 0` the root is granted slot 0 implicitly. Output: `bedSlot[b]` per bus (0xFF none) and `hostBus[slot]` (§4.2).

### 2.2 Occluder materials

`{ name, transmissionDb (-80..0), cutoffHz (100..22000), wetOcclusion (0..1), attackMs?, releaseMs? (0..2000, else `smoothingMs`) }`. Defaults, **starting points for the listening pass**: `none` 0 / 22000 / 1; `cloth` -4 / 8000 / 0.3; `glass` -8 / 5000 / 0.4; `wood` -12 / 2500 / 0.5; `metal` -25 / 1200 / 0.6; `concrete` -30 / 800 / 0.6 (the architect's numbers for the five shared rows; `none` is mine). Several hits on one ray add dB, take the lowest cutoff, floor -60 dB [ARCH §3.2]. `openness` blends a hit's dB toward 0 and its cutoff toward the top (log scale). The cutoff at or above 20,000 Hz means off.

### 2.3 Zone impulse responses

An IR is an `audio` asset (0143; no new kind or sidecar key). Mono feeds both channels' kernels, stereo uses channel 0 left and 1 right, more than two channels is refused ("IR failed" in the zone). Presets are **generated in the decoder worker** (seeded `mulberry32` as `convolver/ir.rs`; main never holds a time-domain IR): `{ rt60 s, hfDamping, predelayMs }`: `room` 0.45 / 0.5 / 4, `corridor` 1.1 / 0.6 / 6, `hall` 2.2 / 0.4 / 18, `cave` 3.6 / 0.3 / 30, `open` 0.9 / 0.8 / 40. Every IR passes the shared reverb's normalisation (`1/rms`, -58 dB calibration, `44100/rate`), so `wet = 1` compares across zones and with the bus reverb.

### 2.4 Sidecar `ambisonic` (0040)

`myco.import@1` gains `"ambisonic": { "order": 3, "convention": "ambix" | "fuma" }` (`importSettings.ts` header, `ImportSettings`, parse, serialise). **Required for any clip over 2 channels**: 4, 9 or 16 channels without it is refused ("4-channel audio needs an ambisonic import setting (ADR 0162); multichannel mixes aren't supported"). `order` is inferred (4 gives 1, 9 gives 2, 16 gives 3); a given `order` that disagrees with `(order+1)^2` fails the load with both numbers. Orders 2-3 are WAV only (FLAC stops at 8 channels; no Opus decoder). **FuMa** is converted in the decoder worker (clips and, per chunk, streams: `STREAM_OPEN.convention`): reorder, then scale to SN3D and **down by the order's largest factor into int16 headroom**, folding the inverse into the clip's import volume, so the clip stays `i16` (architect issue 9; orders whose factor exceeds 4 keep f32). `stream` is honoured; when `ambisonic` is set and `stream` absent the registry streams clips over 5 s. A sidecar on a 1-2 channel clip is ignored with a problem. The Asset Inspector gains the block (E6).

### 2.5 `myco.audioevent@1` additions

Additive, format stays `@1`; an older engine's lenient parser drops the keys silently.

```jsonc
"spatial": { "minDistance": 1, "maxDistance": 30, "rolloff": "inverse",
             "occlusion": true, "dopplerLevel": 0, "reverbSendCurve": [[0, 1], [1, 0.5]] },
"filter": { "lowpass": 9000, "highpass": 80 },
"sends": { "reverb": 0.5, "Cave": 0.3 }
```
- `filter.lowpass`/`highpass` (Hz 10..24000; lowpass at or above 20000 and highpass at or below 20 are off) apply **per voice** through the shared per-voice filter (lowest low-pass wins; `lowpassBy` names the stage).
- `sends.reverb` (0..2, default 1) is the event's `reverbSend`; any other key is an **aux send** to that bus (0..2), post the voice's bus-chain gain, **one per voice** (the first in key order; the parse reports the rest). An unknown bus is dropped with a problem when the event plays.
- `spatial.occlusion` (default true), `spatial.dopplerLevel` (0..5, default 0), `spatial.reverbSendCurve` (§1.1). The record names `occlusion` as an event key without a place; it lives in `spatial` (flagged, §11). A flat event takes `filter` and `sends.<bus>` and ignores the spatial keys.
Parse rules follow `eventFormat.ts` (clamp, `problems`, never throw); the writer emits keys only when set.

## 3. Internal data models

Who writes: **main**, **sys** (the per-frame audio system's passes), **status** (the mirror), **core** (the worklet).

### 3.1 Core tables (one writer, the core)

Behaviour is [ARCH §2.1, §2.2, §4]; the tables and their sizes are here. Regions are laid out by `InitParams` before the arena (R6; `layout.rs` is append-only, new regions go before `Arena`).

| Table | Region | Contents | Size (high / default / low, 48 kHz) |
|---|---|---|---|
| Beds | `Beds` | per bed and per private decoder: `acc[16][128]` f32 (8 KB) + decoder history (40 KB); shared MagLS spectra 64 KB (16 ch x 2 ears x 2 partitions x 128 bins) | (4 + 2) x 48 + 64 = 352 KB / (2 + 1) x 48 + 64 = 208 KB / 1 x 48 + 64 = 112 KB |
| Mixed-voice pool | `Fx` | one entry per **mixed** voice (R12), taken at promote, so it cannot run out: lp and hp `Biquad` (120 B each), their log-Hz ramps, 4 send ramps, aux ramp and bus, yaw, bed share ramp, 16 f32 bed gains: about 448 B | 112 / 56 / 28 KB |
| Zones | `Zones` | `slots x state(maxIrSeconds)`: frequency-domain delay lines, input and accumulation rings, per-slot stereo input buffer, state, `ring_left`, stagger phase. Kernels stay in the IR clip blocks (arena), read in place | state 9.2 / 4.8 / 0.9 MiB for 3 / 3 / 1 slots (18.0 / 9.2 / 1.6 MiB with kernels: the standby slot is on high and default, not on low) |
| Wide rings | `Wide` | `maxClips` rings of 16 ch x (16,384 + 2,048 chunk + 1,536 seek tail) f32 = 1.22 MiB each; 2.22 MiB if the ring grows to 32,768 (R16) | 2.44 / 1.22 / 1.22 MiB |
| Listener, fold table | core state | quaternion, matrix, per-bus chain gains (<= 32 buses) | 3 KB |

The voice slot (`VoiceSlot`, `voices.rs:117`, 192 B) gains only `flags2: u8` (ambisonic) and `fx: u16` (pool entry plus 1); an assert decides whether `VOICE_SLOT_BYTES` must grow (S6). `PannerState` gains kind 2 and a `bed` ramp; the equal-power `matrix` is computed for every kind. The automation low-pass **migrates into the pool entry** (`VoiceAuto.filter` goes), cutoff `min(lpHz, lpAuto)`; M2's goldens must not change. **Mono-once** (R12): a mono clip is filtered on one channel before it is copied to both (bit-identical to M2's stereo biquad for mono input); clips are never filtered; the filtered-voice term is at most the mixed voices.

### 3.2 Main tables

| Field (voice table, struct-of-arrays, 0157 §3) | Type | Writer |
|---|---|---|
| `panner` (0/1/2), `pannerSince` | u8, u32 | sys (`pannerPick.ts`) |
| `flags2` (ambisonic, occlusion, zone sends, aux), `yaw` (rad), `dopplerLevel`, `dopplerFactor`, `velXYZ`, `prevXYZ` | | main, sys |
| `occTargetGain/Cut`, `occGain/Cut` (smoothed), `occWet`, `occAge` u16, `occHits`, `occMaterial` | | sys (`occlusion.ts`) |
| `audibility0` (pre-occlusion, from selection), `reverbSend`, `sendCurve` (interned index), `sendLevel[4]`, `sentSend[4]`, `auxBus`, `auxLevel` | | main, sys |
| `lpHz` (the lowest of occlusion, event static, **sharing-chain snapshot low-pass folded by main**) + `lpBy`, `hpHz` | | sys |

**Velocity estimate:** `(p - prev) / dt` with `dt` from game time (zero when `Time.scale` is 0), one-pole 60 ms; a step faster than `audio.doppler.maxSpeed` is a teleport (velocity 0 for 3 frames, `dopplerTeleports`); `dt` above 0.25 s resets every velocity (hidden tab). `setVelocity` bypasses both. **Panner kind dwell (R13, S14):** a voice keeps a kind for at least 500 ms of game time (30 frames at 60 Hz; main tests the later of the two) on top of the 1.2x hysteresis and the 3-frame mixing dwell; a promotion from bed to HRTF is exempt (a near source should sharpen).
**Zone registry** (`zones.ts`): per World, live components with cached world volumes (box: centre, half extents, inverse rotation; sphere: centre, radius) recomputed on the node's world-matrix version; capacity 64, extra zones are inert with a warning naming each; IR state and slot assignment per zone. **Occlusion state** (`occlusion.ts`): top-16 candidate list, round-robin cursor, ray-cost EMA, collider-to-material cache (cleared every 120 frames and on component add or remove), compiled material arrays [ARCH §3.2].

## 4. Binary formats

One schema (`audio-wire/src/schema/*.rs`), generated into Rust and TypeScript. Record head 12 B as 0157 §4.2 (`u16 opcode; u16 words; u32 voiceId; u32 frameOffset`), asap = 0xFFFFFFFF.

### 4.1 PLAY and SET_PARAMS

PLAY `flags` (u16 at 18) keeps bits 0-6 (`panner` at 5-6; the record's Context says bits 2-3, the code has 5-6, `batch.rs:22`). **Value 2 = bed**; 3 reserved. **Bit 7 `ambisonic`** (new): a B-format clip voice, 4, 9 or 16 channels; `spatial`, `panner`, `dir*` ignored; `lpHz`, `hpHz` and sends other than the W send ignored; stream voices may be ambisonic; read from PLAY only. Bits 8-15 reserved. SET_PARAMS is unchanged in layout; `flags` reads the panner bits (2 accepted); `lpHz` is **applied to every voice** below the top, ramped in log-Hz over `rampFrames`. Main puts occlusion in `gain` and `lpHz` and Doppler in `pitch`; no new field carries them.

### 4.2 New records

**0x0A SET_VOICE_FX** (52 B, stamped like SET_PARAMS; sent after PLAY when any value is non-default and when one moves past its epsilon: send 0.5 dB, hp 1 Hz, yaw 0.001 rad):

| Off | Type | Field |
|---|---|---|
| 12 | u32 | `mask`: bit0 `hpHz`, bit1 `sends`, bit2 `yaw`, bit3 `aux` |
| 16 | u32 | `rampFrames` |
| 20 | f32 | `hpHz` (<= 20 off) |
| 24 | f32[4] | `send[0..3]`: linear level into zone slot `k` (R2: four, whatever the slot ruling) |
| 40 | f32 | `yaw`, radians |
| 44 | f32 | `auxLevel`, linear |
| 48 | u16 | `auxBus` (0xFFFF none) |
| 50 | u16 | reserved |

**0x16 BED_CONFIG** (applies on arrival; R1): `u32 busCount` at 12, `u32 slotCount` (<= `MAX_BEDS` 4) at 16, `u8 bedSlot[busCount]` from 20 (0xFF none), padded to 4 B, then `u16 hostBus[slotCount]` padded to 4 B. Total `20 + pad4(busCount) + pad4(2 x slotCount)`. A bus's voices encode into slot `bedSlot[b]` and are folded through the buses from `b` up to, excluding, `hostBus[slot]`; the slot decodes into its host bus before that bus's effects. The core validates (host must be an ancestor of, or equal to, every bus using the slot; else those buses become 0xFF and `bedsRefused` counts), keeps the state of a slot whose number and host stay, and frees a slot whose host left after its history drains. Sent after BUS_CONFIG and whenever the tree or a bed setting changes. Stable slot ids carry decoder state across replans.

**0x17 ZONE_CONFIG** (applies on arrival; R4): `u32 slotCount` (<= 4) at 12, `f32 sharedReturnGain` at 16 (the shared reverb's return, 1 minus the listener's zone weight), `u32 rampFrames` at 20, then per slot 16 B from 24: `u32 kernelId` (0 off), `u16 returnBus`, `u8 state` (1 active: sends accepted, wet fades in over 100 ms once the kernel is resident; 2 release: sends ignored, the tail rings out, then the slot is off), `u8` reserved, `f32 wet`, `u32 irFrames`. Total `24 + 16n` (n = 3: 72 B). **Idempotent**: the core diffs it, starts a slot (running `plan_stagger`) only when a `kernelId` appears in a free slot, and refuses a new `kernelId` in a slot that is not off (counted; main reads the slot state from STATUS before assigning). A missing kernel is the state "waiting for kernel", so REPLAY needs no ordering. The per-frame `sharedReturnGain` and `wet` ramps do not re-plan.

**0x20 LISTENER** (36 B; R3): `f32 qx, qy, qz, qw` at 12..27 (the rotation **world to listener**, unit; non-finite or zero ignored), `u32 rampFrames` at 28 (slerped per quantum; the same `rampFrames` as that frame's directions, so clips and point voices turn together), `u32 flags` at 32 (bit0 **snap**: a camera cut, no ramp). Sent when the rotation moved more than 0.001 rad, on a listener change and when an ambisonic voice first plays. **Axis map** (S2): listener space is the engine's (forward -Z, up +Y, right +X); AmbiX is X forward, Y left, Z up, so `(X, Y, Z)_ambix = (-z, -x, +y)_engine`; a clip rotates by `Rz_ambix(yaw) x R_listener` (the world-to-listener rotation already is the inverse of the head's turn).

BUS_CONFIG and BUS_MIX are unchanged. RESET clears beds, zone slots, the pool and the listener. Records for an inaudible World are unaffected.

### 4.3 STATUS growth

Header 112 to **144 B** (`HEADER_BYTES`; the 0157 §4.3 section offsets follow):

| Off | Type | Field |
|---|---|---|
| 112 | u16 | `bedVoices` |
| 114 | u16 | `bedsActive` |
| 116 | u16 | `fxVoices` (pool entries with an active filter) |
| 118 | u16 | `ambisonicVoices` |
| 120 | u16 | `zonesActive` |
| 122 | u16 | `zonesRinging` |
| 124 | u16 | `zoneEventCount` |
| 126 | u16 | `bedsRefused` (cumulative, saturating) |
| 128 | u32 | reserved (there is no pool-full counter: the pool is one entry per mixed voice) |
| 132 | u32 | `zoneUsedKB` (kernels resident) |
| 136 | u32 | `workBed` (work units, last quantum: encode, decode, ambisonic) |
| 140 | u32 | `workZones` (convolvers, sends, aux) |

Sections after `peaks`: `beds {u16 bus; u16 voices; u32 work}[bedsActive]` (<= 4), `zones {u32 kernelId; u8 state; u8 pad; u16 quantaSinceInput; f32 wetPeak}[slotCount]` (state 0 off, 1 waiting kernel, 2 fading in, 3 active, 4 ringing out; <= 4), `zoneEvents {u8 slot; u8 code; u16 reserved}[zoneEventCount]` (<= 16; code 1 refused kernel, 2 refused slot, 3 bad blob). Clip event code 5 `refusedFormat`. Worst case 15,728 - 112 + 144 + 32 + 48 + 64 = **15,904 B** of 16,384 (S9). `flags` bit 6 `bedDecoderReady`.

### 4.4 What a send is

A zone send into slot `k` is `send[k] x (resampled voice samples after the voice's own filters: occlusion low-pass, event filter, automation low-pass, mono-once) x fade x automation gainMul`, mono-summed into **both** inputs of the slot (the voice's dry `gain` ramp is **not** applied: the tap is after the filters and before the distance gain, R11 as clarified; [ARCH §3.3]), times the **bus-chain gain to the root** (volumes, mutes, ducking, automation of the voice's bus and ancestors, at the quantum; effects excluded). `send[k]` is computed on main: `volume x reverbSend x reverbSendCurve(d) x weight_k x wetFactor(occlusion)`, clamped to 4 in the product with the curve. An aux send is the same signal into `auxBus`'s input buffer. An ambisonic clip sends its W channel. This amends [ARCH §3.3, §4]: the sends see neither the dry distance gain nor the occlusion low-pass (the wet path carries occlusion only through `wetOcclusion`), nor the event's static filter (flagged for the architect, §11). The send of a voice on a sharing bus uses its own bus's chain gain to the root, not the fold.

**Bed fold** is [ARCH §4.3] (gains and automation multipliers from the voice's bus to, excluding, the host, at the quantum's two ends); the sharing chain's **snapshot low-pass is folded by main into `lpHz`** (`lpBy` parent), so the core folds gains only (the two reviews both landed here, S3).

### 4.5 Clip formats and ids (R5, R7)

HRIR keeps format 2 and ids `0xFFFF0000..=0xFFFF00FF` (`envelope.rs:19`). None adds a CLIP_BEGIN word; each is a format value. None is a voice's source.

| Format | Content | Ids |
|---|---|---|
| 3 zone kernel (prepared) | header 32 B: `u32 magic 0x5249594D ("MYIR")`, `u32 version 1`, `u32 irFrames`, `f32 sampleRate`, `u32 headParts` (<= 32), `u32 tailParts`, `u32 flags` (bit0 source mono), `u32 reserved`; then f32 **packed** spectra: head kernels `[2 ch][headParts][128 bins][re, im]`, tail `[2][tailParts][2048 bins][re, im]` (bin 0 = DC in `re`, Nyquist in `im`, as `convolver.rs`); normalisation baked. `channels` 1, `frames` = bytes / 4 | `0xFFFF0200..=02FF` (256 kernels) |
| 4 MagLS | header 32 B (`"MYBD"`, version 1, order 3, taps 256, `f32 sampleRate`, 12 reserved), then f32 `[16][2][taps]` time responses; the core transforms at commit (`bedDecoderReady`) | `0xFFFF0100` |
| 5 zone IR PCM | interleaved stereo f32 at the context rate, `channels` 2: the core prepares the kernel itself, one prepare unit per quantum into the block reserved for the id, then reports `resident` | as format 3 |

Sizes: a format 3 blob is `32 + 8 x (headParts x 256 + tailParts x 4096)` B per channel pair: 1.5 MB at 2 s, 3.0 MB at 4 s. **The worker sends kernels straight to the worklet** over the worker-to-worklet port (as M1b clips), main gets `irPrepared` with timings only (R12, architect issue 6). `MagLS` is `engine/audio/magls-o3.bin` (32,800 B at the HRIR's rate; main resamples like the HRIR, sends on first bed use, re-sends on rebuild).

### 4.6 Streams, versioning, hash

`STREAM_OPEN` gains `u32 convention` (0 ambix, 1 fuma; the worker converts per chunk) and channels 1-16; a stream of more than 2 channels takes a **wide ring** (§3.1), refused (`streamEvent` 3 and a warning) when none is free. Envelope version **1.1**; **ABI 2.0 (0x200)** (init signature, R6); decoder ABI 0x102. `gen_wire` emits the new packers, constants (`MAX_BEDS` 4, `MAX_ZONE_SLOTS` 4, `BED_CHANNELS` 16, `PANNER_BED`, `AMBI_FLAG`, ids, magics, `HEADER_BYTES` 144, `LP_TOP` 20,000, `HP_BOTTOM` 20) and readers; `vectors/wire.json` gains one golden record per new opcode and a golden STATUS; the 1,000-batch fuzz adds truncated SET_VOICE_FX, BED_CONFIG with a bad host, ZONE_CONFIG with a slot count above 4, a LISTENER with NaN. The architect quotes constants by name (S20).

## 5. Native layout

### 5.1 Crates and modules

| Where | New | Changed |
|---|---|---|
| `audio-wire/src/schema/` | `spatial.rs` (records, flags, constants, STATUS growth) | `batch.rs`, `status.rs`, `envelope.rs` (formats, `STREAM_OPEN`), `schema.rs` |
| `audio-dsp/src/` | `ambisonic.rs` (SN3D encode 1-3, Ivanic rotation, baked 16 to 2 matrix), `bed_decoder.rs`, `convolver/kernel.rs` (`prepare_ir`), `convolver/instance.rs` (state with kernel references, `plan_stagger`), `convolver/presets.rs`, `fxfilter.rs` (log-Hz ramped mono pair over `Biquad`) | `convolver.rs` (the shared reverb becomes instance 0, **bit-identical**), `convolver/ir.rs`, `resample.rs` (N <= 16 channels) |
| `audio-core/src/` | `bed.rs`, `zones.rs`, `fxpool.rs`, `listener.rs` | `voices.rs`, `panner.rs` (kind 2, equal-power law for any change involving a bed [ARCH §3.1]), `bus.rs`, `clips.rs`, `stream.rs` (wide ring class), `status.rs`, `counters.rs`, `layout.rs`, `params.rs`, `automation.rs`, `core.rs` |
| `audio-decode/src/` | `ir.rs` (decode, resample, normalise, trim, partition, presets), `ambisonic.rs` (FuMa) | `lib.rs`, `decoder.rs` (channels 2 to 16) |
| `audio-wasm/src/` | | `lib.rs` (init, ABI), `memory.rs` (size function takes the new parameters) |
| `audio-bench`, `tools/` | scenes `m3-high`, `m3-worst-high/default/low`, `bed-64`, `bed-256`, `bed-xfade`, `ambi-o3`, `zones-2x2s`, `zones-swap`, `filters-256` (C19); `native/audio/tools/bake-magls` | `mode=fit` sweeps for the `cap::wu` terms of C18, `mode=memory` |

**Build plan additions (2026-11-11, [waves plan](../../plans/2026-11-audio-spatial-m3-waves.md)).** The plan splits a few files so tasks in one wave don't share them. The table above stays as the design's content; these files hold parts of it:
- `audio-dsp/src/bed_matrix.rs`: the baked 16 to 2 matrix (A3), out of `ambisonic.rs`.
- `audio-dsp/src/convolver/stagger.rs`: `plan_stagger` (C1), out of `instance.rs`.
- `audio-core/src/sends.rs`: the send tap and aux add (C4), called from `voices.rs` and `bus.rs` hooks.
- `audio-core/src/chain.rs`: the bus-chain gain to the root, shared by the bed's gain fold (A4) and the sends (C4).

FuMa conversion is in `audio-decode/src/ambisonic.rs` as the table above says (owner, 2026-11-11), applied in the decode loop before the int16 rounding so the headroom scale of §2.4 doesn't lose precision; task B2 owns it, and B1's `decoder/ambisonic.ts` isn't created.

### 5.2 Convolver, IR preparation, ABI, arena, rings, size

**Convolver** [ARCH §4.4]: `kernel.rs::prepare_ir` produces §4.5's layout (the seeded 1.8 s shared reverb is prepared by it at `Core::new`, so its output stays bit-identical); `instance.rs` holds one stereo convolver's mutable state with a stagger `phase`; `plan_stagger` (the spike's load balancer) runs when a slot starts and replaces architecture §10's "never share a tail quantum".

**IR preparation:** decoder exports `myco_ir_prepare(src, len, hint, target_rate, max_frames)`, `myco_ir_generate(preset, target_rate, max_frames)`, `myco_ir_blob_ptr/len` (decode, mix to 2 channels or duplicate mono, resample, trim a tail under -80 dBFS, cut with a 50 ms fade, normalise, partition, transform). The worker keeps the encoded bytes so a rebuild or rate change re-prepares without main holding blobs. 1.3 / 2.5 / 5.3 ms for 1 / 2 / 4 s [S]; decode and resample unmeasured (C2a measures). `microfft`'s 4,096-point code adds about 28 KB to the decoder (749,095 B of 900 KB; AAC 1,073 KB of 1,280 KB). Without the worker, main uploads format 5 and the core prepares (task C3b).

**ABI 2.0 (R6):** `myco_audio_init(sample_rate, max_logical, max_mixed, max_buses, arena_initial_bytes, max_beds, max_zone_slots, zone_max_frames, max_wide) -> i32`, deterministic. There is no second init call: regions sit before the arena. No other export changes: records go through `submit`, blobs through `clip_reserve`/`chunk_ptr`/`commit` with formats 3-5.

**Arena to 16 channels:** `clip_reserve` accepts 1, 2, 4, 9 and 16 channels (others refused with the registry's message); `Source` generalises to N <= 16 into one shared 8 KB planar scratch. **Wide rings (R16):** ring class `Wide`, 16-channel, 16,384 frames, chunks of 2,048 frames (128 KB), `maxClips` of them; B4's acceptance includes a **300 ms decoder stall** (14,400 frames) with no underrun, else the ring becomes 32,768 frames (memory in §3.1). `STREAM_RING_FRAMES_WIDE` is a wire constant.

**Size and gates:** mixer 178,598 B after M2 against `MIXER_LIMIT` 256 KB; estimate +40 to 50 KB (before `wasm-opt`, not installed here), warning at 230 KB in `build.mjs`, the M2 precedent (the owner may move a gate with a reason). `npm run build:audio` also runs `bake-magls --check`. The metered gate (`check:audio-metered`) gains C19's scenes at 10%.

## 6. TypeScript layout

```
src/engine/audio/        settings.ts (+bed, ambisonic, occlusion, zones, doppler, speedOfSound, bus bed/bedPriority)
                         eventFormat.ts (+filter, sends, spatial additions)   occlusionMaterials.ts (new: table, parse, compile)
src/engine/scene/importSettings.ts   (+ambisonic)
src/engine/core/worldServices.ts     the ray query interface (D0, R12)
src/plugins/audio/runtime/
  AudioReverbZone.ts AudioOccluder.ts   Audio.ts AudioSource.ts AudioListener.ts audioSystem.ts backend.ts   (§1)
  core/ beds.ts pannerPick.ts (replaces hrtfPick.ts) zones.ts zoneIr.ts occlusion.ts doppler.ts listener.ts voiceFx.ts
        voiceTable.ts commandWriter.ts coreBackend.ts replay.ts mirror.ts statusReader.ts debug.ts spatial.ts   (changed)
  decoder/ ambisonic.ts irPrepare.ts protocol.ts    wire.generated.ts (regenerated)
src/myco.ts   + AudioReverbZone, AudioOccluder, ZONE_PRESETS, DEFAULT_SEND_CURVE, SendCurve, AudioPanner
```
The audio system's order keeps 0157's (attenuation, doppler, zones, occlusion slot, audibility from `audibility0` x smoothed occlusion with M2's no-gap rule, selection, `pannerPick`, fx staging, listener). `pannerPick` keeps `hrtfPick`'s tests and adds the bed cases. **Plugin boundary** (`plugins.test.ts`): the audio plugin imports nothing from `plugins/physics`; the ray query is a **core-level interface in `worldServices.ts`** beside `WorldRayHit`: `raycastInto(world, out, origin, dir, maxDistance, query)` with a preallocated `out { node, distance, point }`, `query { groups, excludeNodes (the source's subtree, the listener's node), includeSensors: false }`; `groupsFor(layers)` is computed once per settings change. Implemented by the physics service (`services.ts`, `systems3d.ts`) with Rapier's group, sensor and predicate filters; no allocation per call (`Physics.ts:83-85` allocates today). That is an engine-core and physics change the record does not name (flagged).

**Build plan additions (2026-11-11).** New main-side files from the plan's seams:
- `runtime/core/initParams.ts`: ABI 2.0 init parameters, one region function per feature file.
- `runtime/core/zoneWeights.ts`: zone weights and the send curve (C5).
- `runtime/core/occlusionMath.ts`: smoothing, wet folding, lateral rays (D2a).
- `plugins/audio/editor/audioDebugRows.ts`: the debug panel's new rows (E4).

`src/engine/audio/occlusionMaterials.ts` is created in wave 1 (table and parse) and extended by D2b (compile, combine).

## 7. Editor integration

Through `src/editor/sdk` only. **No new SDK contribution point:** `registerViewportTool` (overlay polylines, pickable handles, `onPress` drags, undoable `edit`, `editorViewport.ts:51-58`), `registerComponentHeaderAction` and `registerInspectorSection` already carry physics' and navigation's gizmos.

| Change | How | Files (`plugins/audio/editor/`) |
|---|---|---|
| Zone gizmo: volume and a `blendDistance` shell, face handles while **Edit Zone** is on, undoable edits, faded zones tinted | viewport tool `myco.audio.zones`, header action | `AudioReverbZoneGizmo.ts`, `EditZoneButton.tsx`, `zoneMath.ts` |
| Occluder gizmo: the node's collider fields drawn and tinted by material, dimmed by `openness` | viewport tool `myco.audio.occluders` | `AudioOccluderGizmo.ts` |
| Inspector sections: zone (IR state, length, memory, live `why`, overlap warning, audition burst on the editor listener), occluder (material read-outs, no-collider and no-service warnings), AudioSource (curve widget from the SDK's `CurveEditor`, greyed ambisonic fields) | `registerInspectorSection` | `ZoneInspector.tsx`, `OccluderInspector.tsx`, `AudioSourceSections.tsx` |
| **Project Settings > Audio** (`AudioSettingsSection.tsx`): the file is a set of sub-components over `Num`, `OptionalNum`, `Choice`, `TextField` (`BusRow`, `Effects`, `Snapshots`, `Ducking`, `Parameters`, `Automation`, `Playback`). `BusRow` gains `bed` (a `Choice`) and `bedPriority` (a `Num`) with the resolved host ("shares Master's bed") and the lost-bed warning; new sub-components `Beds` (`maxBeds`, `ambisonic.maxClips`), `Occlusion` (layers as checkboxes from `physics.layers`, `budgetMs`, `defaultMaterial`, a **material table** as cards in the `Parameters` pattern), `Zones`, and Doppler and speed of sound in `Playback`; the "Voices preset" select (`applyVoicesPreset`) sets every §2.1 preset number | edit the section | `AudioSettingsSection.tsx`, `audioSettingsModel.ts` (`setBed`, `setBusBed`, `setMaxClips`, `setOcclusion`, `setMaterial`, `setZones`, `setDoppler`; `VOICE_PRESETS` and `voicesPreset` gain the keys) |
| **Audio Debug panel** (`AudioDebugPanel.tsx`: a counters table, a `Buses` table, a `Voices` table limited to `voiceRows`' most audible, `groupByEvent`): new counter rows, `Beds`, `Zones` and `Occlusion` sections beside `Buses`, new voice columns (panner, dwell, occlusion gain and cutoff, `lowpassBy`, sends); its pure helpers keep their tests | edit the panel | `AudioDebugPanel.tsx`, `audioDebugPanel.css` |
| Occlusion overlay: rays to occluded sources, hits, coloured by age, toggled from the panel | viewport tool | `OcclusionOverlay.ts` |
| Event editor: `filter`, `sends` (reverb and one aux bus), `spatial` additions; the audition names its backend and listens from the editor camera | node properties | `event/nodeFields.ts`, `NodeProperties.tsx`, `Audition.tsx` |
| Asset Inspector audio block: Ambisonic checkbox, order, convention (clips of 4, 9, 16 channels) | the shell's audio `importSettings` view (0143) | `src/editor/ui/AssetInspector.tsx` |

**Live tuning:** zone fields, material values, occluder fields and AudioSource fields apply during Play; a Playwright spec edits `wet`, `blendDistance` and a material cutoff in Play and watches the panel (E9).

## 8. Babylon fallback

Checked against `babylonBackend.ts` (785 lines, Babylon 9.32.0). Best effort (owner decision 4).

| Feature | On the fallback | What the file shows |
|---|---|---|
| Bed, `bed`/`bedPriority`, panner kinds | none: Babylon's own panner (`spatialSoundOptions`) | settings parse; rows say `hrtf` or `equalPower` |
| Occlusion | **gain only**: main runs the rays and smoothing, the backend takes `volume x occGain` through the existing `setVolume` (line 308); the cutoff is dropped; one warning | no filter code exists (header comment line 10: "effects, a snapshot's low-pass ... skipped") |
| Doppler | the factor multiplies `playbackRate` (`setPitch`, line 329) | **only for decoded clips**: `playbackRate` is set `if (!this.req.stream)` (lines 193, 329), and a streamed clip plays flat as HTML5 audio (`warnFlatStream`), so streams get no Doppler |
| Event filters, `lowpass`/`highpass`, aux sends | skipped, one warning per asset (as `lowpass` automation today, `sound-events.md:319`) | |
| Ambisonic clips | channel 0 (W) as mono at the clip's gain, one warning; no rotation. **The backend must ignore `stream` for them**: HTML5 audio downmixes 4 or 16 channels unpredictably. It decodes with `decodeAudioData`, copies channel 0 into a mono `AudioBuffer` and passes that to `createSoundAsync` (which accepts an `AudioBuffer`). Peak memory is the decoded 16 channels (about 3.1 MB per second at 48 kHz, f32), so clips decoding to over 64 MB (about 21 s of 3rd order, 83 s of 1st) are **refused with a warning** | `createSoundAsync(name, ArrayBuffer \| AudioBuffer \| ...)` in the pinned `audioEngineV2.d.ts` |
| Reverb zones | **inert, one warning** (F2). The record's "one `ConvolverNode`" needs a public insertion point: the V2 API exposes bus and sound nodes only as `_inNode`/`_outNode` (`webAudioBus.d.ts:21-23`), which 0157 declined to use; `audioEngineV2` has no send or node-insertion API. Decided: inert (owner) | grep of the pinned package |
| LISTENER, `AudioListener.velocity` | listener pose as today; velocity feeds Doppler | |

The guides' tables (`audio-mixer.md` 42-48, `sound-events.md` 319) gain these rows (E8). macOS desktop defaults to this backend, so those users get walls that only lower volume and no zones; the panel and the Event editor's audition say so [ARCH §10].

## 9. Test plan

Layers as 0157 §8; M3 additions. **Cadence (owner rule):** per task, typecheck, the affected unit tests (`vitest related` or the file's tests) and `cargo test` for the touched crate only. **Wave end:** full `npm test`, `npm run build`, the Chromium e2e specs, the metered gate and the benches. **Milestone end, before the merge to master:** `@slow` e2e, WebKit and Firefox (Docker), long benches and soaks. A layer below runs where its row says; no task runs the full suite.

| Layer | What |
|---|---|
| Unit (cargo) | SN3D encode against analytic harmonics (64 directions per order); Ivanic rotation equals rotating the direction then encoding (1e-5); the baked 16 to 2 matrix within 2 dB of `EqualPowerPanner` except within 10 degrees of the +-90 fold (an order-3 projection cannot follow the fold); partitioned decode against direct convolution; `prepare_ir` against a naive DFT; `plan_stagger` never above the sequential peak; pool entry take and free per mixed voice; log-Hz ramp monotone; zone slot machine (waiting kernel, fade in, active, release, ring out, off, refused); BED_CONFIG validation (cycle, non-ancestor host); chain-gain fold against the tree for a ducked chain (< 0.05 dB); parse refusal for every new record |
| Bake check | `bake-magls --check` reproduces `magls-o3.bin`; cues right at 12 of 12 azimuths, within 1.7 dB of M1's HRTF below 2 kHz |
| Wire | round trip, fuzz, golden vectors, hashes, STATUS worst case 15,904 B |
| Golden (Node, real wasm) | 256 voices into a bed; HRTF to bed to equal-power crossfade continuity (dip recorded, not asserted); a sharing bus with ducking; a 3rd-order clip rotated by a 90 degree turn (image moves, level constant); two blending zones; ring-out then slot off; a rebuild REPLAY with zones and beds; per-voice filter ramp click bound; **M2 automation goldens and every M1/M2 parity digest unchanged** (shared reverb, automation low-pass and mono-once are bit-identical) |
| Loopback | bed planner follows a bus edit; ambisonic AudioSource rotates with the listener; zone planner walks A to B to C (high and default with the standby slot, low with the 150 ms eviction fade: both paths); IR re-prepared on a rate change; PCM IR prepared in the core (worker stopped); occlusion on a fake 3D service (a wall appears: age, smoothing, wet fraction, `occluded`, `lowpassBy`, own-collider exclusion); Doppler pass, teleport guard, hidden-tab reset; event `filter` and `sends`; `setVelocity` |
| Fake backend | bed resolution table (maxBeds, priority, ties, losers, root default, `none`); kind dwell and hysteresis; material combine; send curve, weights and clamp; velocity estimator; settings and event parse rules; `apply` includes the new fields; every `@field` has a `description` |
| Babylon | each §8 row against the Babylon mocks: gain-only occlusion, Doppler on decoded clips only, warnings once, W-only ambisonic and the size refusal, zones inert |
| Bench, metered (wave end) | C19's scenes, **`m3-typical`** (the record's scene) paced; `mode=fit` sweeps; the metered 10% gate; `bench:audio-spatial` runs `occlusion.ts` under the real `audioSystem.ts` with a fake 3.7 µs ray at 64 / 256 / 1,024 sources (ages near 3 / 5 / 22 frames) |
| Stall test | wide ring with a 300 ms decoder stall: no underrun, else 32,768 frames (R16); a unit-level test, run with B4's crate tests |
| Playwright (wave end) | zone and occluder gizmos draw and drag (undoable), settings sections edit and persist, debug panel sections, Inspector warnings, live tuning |
| Lab VM and `@slow` (milestone end; the lab VM is the owner's) | `m3-typical` and `m3-worst-high`, p99.9 against 0157's 1.3 ms and the modelled net (§10.3); sets the presets. Container tails are not asked for |
| Listening pass (owner) | per milestone below, headphones, the M2 format and sign-off block |

**Exit checks:** **M3a** a source crossing the 8-voice HRTF boundary both ways (no dip or jump); above, below (the -45 degree gap: a floor-below sound, failure opens R1) behind and sides, bed against HRTF; a loud close source plus 200 quiet ones; idle silence. **M3b** an ambience turned on the spot at 1st and 3rd order. **M3c** rooms A, B, C with 2 s and 4 s IRs; a source in A heard from B. **M3d** wall, door open and closed, corner; a fast Doppler pass and a teleport. **M3e** Babylon once.

## 10. Task breakdown

Level S/M/J. Days are focused human effort, not agent-wave days. **Critical path in bold.** Every task's acceptance is the **per-task cadence** of §9: typecheck, the affected unit tests and `cargo test` of the touched crate green, M1/M2 goldens that the crate owns unchanged unless said, the committed wasm matching its hash. E2e, the full suite, the metered gate and benches are covered by the **wave-end** run; `@slow`, WebKit and soaks by the **milestone-end** run. A row that names a bench or spec is satisfied by that wave-end or milestone-end run, not by running it per task.

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| **M3a bed** | | | | | | |
| A1 | Wire: SET_VOICE_FX, BED_CONFIG (R1), ZONE_CONFIG (R4), LISTENER (R3), PLAY bit, STATUS growth, formats 3-5 and ids (R5, R7), single init (R6), `STREAM_OPEN.convention`, vectors, fuzz | `audio-wire/*`, `wire.generated.ts`, tests | none | M | 5 | round trip and fuzz of every record; stale wasm fails `npm test`; STATUS 15,904 B |
| A2 | `ambisonic.rs`, `bed_decoder.rs` | `audio-dsp` | **A1** | S | 5 | analytic tests; bit-identical native and wasm; 256 voices decode within the spike's 142 µs p50 |
| A3 | `bake-magls` + `magls-o3.bin` + loader + the baked 16 to 2 matrix (R9) and its test | `native/audio/tools`, `core/hrir.ts`, `build.mjs` | A1 | S | 4 | 12 of 12 azimuths; within 1.7 dB below 2 kHz; matrix test of §9 |
| A4 | Core bed: slots and hosts, pool, kind 2, equal-power crossfade law, decode before host effects, gain fold, RESET, counters | `bed.rs`, `panner.rs`, `bus.rs`, `voices.rs`, `layout.rs`, `status.rs` | **A2**, A3 | S | 7 | bed, crossfade and ducked-chain goldens (< 0.05 dB); the shedding ladder's bed-idle step (1 quantum) and `m3Shed` counter |
| A5 | Main bed: `beds.ts`, `pannerPick.ts` with the 500 ms dwell, commands, replay, debug rows (the core resolves a bus without a bed to equal-power) | `core/*` | A1, A4 | M | 3.5 | resolution tests; loopback follows a bus edit |
| A6 | Settings: bed, bus `bed`/`bedPriority` (0..255, root 255), `ambisonic.maxClips`, presets | `settings.ts`, `audioSettingsModel.ts` | none | M | 2.5 | every §2.1 row |
| A7 | Bed bench, goldens, metered baselines, `mode=fit` sweeps for bed and ambisonic terms, size check | `audio-bench`, `golden/` | A4 | M | 4.5 | `bed-64/256/xfade` recorded at wave end; mixer under 230 KB |
| **M3b clips** | | | | | | |
| B1 | Sidecar `ambisonic`, registry validation, FuMa (int16 headroom scaling, per-chunk for streams) | `importSettings.ts`, `decoder/ambisonic.ts` | none | M | 3.5 | §2.4 rules; FuMa twin equals AmbiX within 1e-6 |
| B2 | N-channel resampler, arena to 16, decoder channel limit, 16-channel WAV through `audio-decode` | `resample.rs`, `clips.rs`, `audio-decode` | none | S | 4 | 4, 9, 16 channels load and play; 5 refused |
| B3 | Core ambisonic voice: rotation by LISTENER, yaw, into bed, **private decoders**, W send, `maxClips` stealing in the core | `voices.rs`, `listener.rs`, `bed.rs` | **A4**, B2 | S | 6 | 90 degree turn moves the image; rotation within 0.1 dB at head speeds |
| B4 | `Wide` ring class, chunking, worker streams, 300 ms stall test | `stream.rs`, `decoder/streams.ts` | B2 | S | 5.5 | 16-channel stream 60 s with seeks and loops, no underrun, stall test passes (else 32,768) |
| B5 | Main: `listener.ts`, ambisonic `AudioSource` and `yaw`, `maxClips` stealing by priority, stream default | `listener.ts`, `AudioSource.ts`, `Audio.ts` | B1, **B3** | M | 3.5 | source rotates with the camera; greyed fields warn once |
| B6 | Test clip generator and tests | `samples/sound-lab/tools`, loopback | **B3** | M | 3 | image at the right azimuth, bed and private decoder |
| **M3c zones** | | | | | | |
| C1 | Convolver split (`prepare_ir`, `instance`, `plan_stagger`) | `audio-dsp/convolver*` | none | S | 6 | shared reverb **bit-identical**; planner as the spike |
| C2a | IR preparation in the decoder, presets, ABI 0x102 | `audio-decode/ir.rs` | C1 | S | 4 | blob equals `prepare_ir`; times measured; decoder under 900 KB |
| C2b | Worker handler, worker-to-worklet kernel send, `zoneIr.ts`, cache, rate change, failure | `decoder/irPrepare.ts`, `core/zoneIr.ts` | C2a | M | 3.5 | rate change re-prepares; kernels never touch main |
| C3 | Core zones: fixed `Zones` region, ZONE_CONFIG table and state machine, return buses, shared-return scale, STATUS slots, formats 3 and 5 | `zones.rs`, `clips.rs`, `bus.rs`, `audio-wasm` | A1, **C1** | S | 9 | blend, ring-out, rebuild goldens; 3.1 / 6.1 MB per slot at 2 / 4 s; **standby slot** (+1: slots = `maxActive` + `standby`, ring-out in the spare) and **eviction fade** paths both tested (low uses the fade); **shedding ladder** (+1: cut releasing tails, one active zone fewer after the cap sits at its floor and underruns continue 1 s; never beds or HRTF) |
| C3b | In-core PCM IR preparation spread over quanta (was reserve R3) | `zones.rs` | C3 | S | 3 | a worker-less run prepares a 2 s IR, +23 µs a quantum at most |
| C4 | Core sends and aux: pre-distance tap, bus-chain gain, aux add | `voices.rs`, `bus.rs`, `zones.rs` | **C3** | S | 3 | send follows a ducked bus; muted bus mutes its reverb |
| C5 | Main zones: component, registry, weights, curve, planner, kernel LRU and proximity preload, 5 s timeout, listener weight for the shared return, commands | `AudioReverbZone.ts`, `core/zones.ts`, `voiceFx.ts` | C2b, **C4** | S | 8.5 | loopback A to B to C on both slot paths (+2: standby assignment, ring-out tracking, eviction wait on low); each fade warning logged once |
| C6 | Settings: zones keys, memory accounting, warning data | `settings.ts`, model | none | M | 2.5 | every row, incl. `zones.standby` and the slots memory accounting (+0.5) |
| C7 | Zone tests, `zones-2x2s`/`zones-swap`, `m3-high`, fit sweeps | `golden/`, loopback, `audio-bench` | **C5** | M | 4.75 | `zones-2x2s` p50 about 47 µs, p99 about 107 µs (recorded at wave end) |
| **M3d** | | | | | | |
| D0 | Ray query (R12): core interface, `raycastInto`, node exclusion, sensors off, reused `out`, `groupsFor` | `worldServices.ts`, physics `services.ts`, `systems3d.ts` | none | M | 3.5 | source's capsule never occludes it; no allocation per call; particles unchanged |
| D1 | Core per-voice filters: mixed-voice pool, lp+hp, log-Hz ramps, mono-once, `lpHz` for every voice, automation migrated | `fxpool.rs`, `voices.rs`, `automation.rs`, `fxfilter.rs` | A1 | S | 4 | M2 goldens unchanged; click-free; clips never filtered |
| D2a | `occlusion.ts`: ray count from `budgetMs` and EMA, overrun halving, ranking by `audibility0`, round-robin, lateral rays (top 4 on high), 3 hits, smoothing, wet folding | `core/occlusion.ts`, `audioSystem.ts` | D0, A5 | S | 5.5 | ages near 3 / 5 / 22 frames; overrun test |
| D2b | `AudioOccluder`, materials, `openness`, cache, debug rows, 2D note | `AudioOccluder.ts`, `occlusionMaterials.ts` | D0 | M | 3 | two-hit combine, trims, `none`, openness |
| D3 | Doppler | `core/doppler.ts`, `listener.ts` | B5 | M | 3 | formula; teleport guard; one-shots default 0 |
| D4 | Event effects incl. aux | `eventFormat.ts`, `events/eventRuntime.ts`, `voiceFx.ts` | D1, C4 | M | 3 | every §2.5 rule |
| D5 | API surface, handle members, debug additions, exports | `AudioSource.ts`, `Audio.ts`, `myco.ts`, `debug.ts` | D2a, C5, D3 | M | 3.5 | each §1 row tested; every `@field` described; `m3Shed` and ladder state in `Audio.debug()` (+0.5) |
| D6 | Occlusion and filter tests and benches (`filters-256`, `bench:audio-spatial`, `m3-worst-*`) | tests, `audio-bench` | D2a, D1 | M | 3.75 | benches recorded at wave end; ages as the spike |
| **Fallback** | | | | | | |
| F1 | Babylon: gain-only occlusion, Doppler on decoded clips, filter and aux warnings, W-only ambisonic via the decode path with the 64 MB refusal | `babylonBackend.ts`, `babylonMapping.ts` | D2a, D3, B5 | M | 3 | §8 rows against the mocks |
| F2 | Babylon zones: inert, one warning (decided) | `babylonBackend.ts` | C5 | M | 0.5 | warning once; rows tested |
| **M3e** | | | | | | |
| E1 | Zone gizmo, handles, Edit Zone | `AudioReverbZoneGizmo.ts` | C5 | M | 4 | draw, drag, undo |
| E2 | Occluder gizmo; Inspector sections; `output` bus field | `*Inspector.tsx` | D2b, E1 | M | 3.5 | warnings for no collider, no service, overlap |
| E3 | Project Settings > Audio (§7) incl. `maxClips` and `bedPriority` | `AudioSettingsSection.tsx` | A6, C6, D2b | M | 5.5 | edits persist; lost-bed warning; material cards |
| E4 | Debug panel sections and occlusion overlay | `AudioDebugPanel.tsx`, `OcclusionOverlay.ts` | D5, C5 | M | 4 | §7 rows against the loopback host |
| E5 | Event editor | `event/*` | D4 | M | 3 | round trip (unit); backend label; e2e at wave end |
| E6 | Asset Inspector ambisonic block | `AssetInspector.tsx` | B1 | M | 2 | writes only non-default keys |
| E7 | Live tuning check | | E1, E3 | M | 1 | covered by the wave-end e2e run |
| E8 | Samples and guides: `sound-lab` spatial scene (zone corridor, occluders, **a door example with a script moving `openness`**, ambisonic ambience, Doppler pass-by), `stress` and `sound-lab` settings, `dopplerLevel: 0` where benches need it, guide edits and `spatial-audio.md` with the door recipe, `implementation-status.md` | `samples/*`, `docs/guide/*` | C7, D6, B6 | M | 6.5 | samples load warning-free and non-silent; `check:links` |
| E9 | Playwright specs | `tests/e2e/` | E1 to E4 | M | 4 | specs written and passing in the wave-end run; 3 of 3 repeats at milestone end |
| E10 | Listening pass document, scenes, lab-VM instructions | `listening-pass.md`, `ListeningBench.ts` | E8 | J | 2 | every item has a key or scene |

**Critical path (about 45 days of chain):** A1 5, A2 5, A4 7, B3 6, B6 3 (spine, 26) feeding E8; the zone spine beside it: C1 6, C3 9, C4 3, C5 8.5, C7 4.75 = 31.25 (C3 needs A1, done by day 6), then D5 3.5, E4 4, E9 4, E10 2. Seniors carry about 70 days (A2-A4, B2-B4, C1-C5 incl. C3b, D1, D2a), so two seniors are the floor: **about 9 weeks to M3e with two seniors and three mids, 10 to 11 with the reserve and the owner's gates.** D0, D1 and D2 do not depend on B or C, so occlusion can ship first.

### 10.1 Owner decisions folded into the base tasks

| Decision | Where | d |
|---|---|---|
| Standby zone slot on high and default; 150 ms eviction fade on low (both paths tested) | C3 +1, C5 +2, C6 +0.5 | +3.5 |
| Load-shedding ladder | C3 +1, A4 +0.5, D5 +0.5 | +2 |
| Default-preset HRTF 8 where beds exist | A6 (one number, `DEFAULT_VOICES`, a test) | about 0 |
| Estimate accepted; Babylon zones inert with one warning (F2) | | 0 |

### 10.2 Total and reserve

Tasks, summed from the rows: A 31.5, B 25.5, C 44.25 (incl. C3b), D 29.25, F 3.5, E 35.5 = **169.5 days**. **Named reserve 14 days:** R1 SADIE II below the horizon if the floor-below check fails 4 d; R2 lab-VM tuning of presets, the cap and wasm size (a `wasm-opt` pass) 5 d; R4 listening-pass fixes (kind dwell, crossfade length, material values, send curve default) 5 d. (Round 1's R3, the in-core IR fallback, is task C3b.) **Total 183.5 days, about 36.7 person-weeks** (against round 1's 32.7 and the record's 22).

### 10.3 Line by line against round 1 (32.7 pw) and the record (22 pw)

| Line | Record pw | Round 1 d | Round 2 d (base) | pw |
|---|---|---|---|---|
| Bed (A1-A7) | 4.5 | 27 | 31.5 | 6.3 |
| Ambisonic clips (B) | 3 | 23 | 25.5 | 5.1 |
| Zones (C incl. C3b) | 5.5 | 33 | 44.25 | 8.85 |
| Occlusion with filters (D0, D1, D2a, D2b, D6) | 3 | 16 | 19.75 | 3.95 |
| Doppler and event effects (D3, D4, D5) | 1 | 9 | 9.5 | 1.9 |
| Fallback (F) | 0.5 | 4.5 | 3.5 | 0.7 |
| Editor (E1-E7, E9) | 4 | 26 | 27 | 5.4 |
| Samples, guides, listening pass (E8, E10) | 0 | 8 | 8.5 | 1.7 |
| Reserve | 0.5 | 17 | 14 | 2.8 |
| **Total** | **22** | **163.5 (32.7)** | **183.5 (36.7)** | |

Round 1 to round 3: +20 days net, roughly (+14.5 in round 2, +5.5 from the owner's decisions): the architecture's needs (private decoders and `maxClips` +2, separate wide rings and FuMa per chunk +1.5, shared-return scaling +1, baked equal-power matrix +1.2, the ray query with exclusion +1.5, lateral rays and ray-count EMA +1.5, the equal-power crossfade +0.5, zone return bus and STATUS telemetry +1, `mode=fit` sweeps and worst-case scenes +3) less in-core IR preparation moved from reserve (+3 / -3) less the mono-once and pool simplifications and the inert fallback zones (-1.5 net on F2). Against the record: **+14.7 pw**, of which about 5 is priced tests and tooling, 3.5 the wire, ray query, convolver split and 16-channel generalisation, 1.7 samples and listening, and the rest the architecture's additions; the reserve is named, not 0.5.

**Cost model:** [ARCH §7.2] is the one cost model (coordinator verification: the two drafts' worst-high figures, 0.42 and 0.63 ms, differed only in per-pass filter and send costs, all estimates that task C3's bench measures). Its HRTF figure (32 → 8 removes 24 × 7.4 ≈ 178 µs, with those voices counted in the bed at 0.5 µs each) is the same saving as 24 × (7.4 − 0.5) ≈ 166 µs net.

## 11. Where the record is wrong, under-specified, or the rulings need a second look

1. **High preset `voices.hrtf` is 32, not 16** (confirmed by the coordinator); with 32 to 8 the net cost is lower than the record's 0.22 ms.
2. **Ray query and `WorldRayHit`**: the record's `Physics.raycast` is not reachable from the audio plugin; D0 adds a core interface (confirmed).
3. **Default occlusion layers make every collider an occluder** (characters, props); the samples set layers explicitly and Settings says so.
4. **Event keys**: `sends` holds `reverb` plus one aux bus; `occlusion` lives in `spatial`.
5. **Babylon zones**: the record's `ConvolverNode` is not reachable through the public API (§8); the owner decided: inert with one warning.
6. **Sends skip the dry gain, the occlusion low-pass and the event's static filter** (R11 consequences); [ARCH §3.3, §4] state the send "post-filter" and need the amendment of §4.4.
7. **R13 says 30 frames; the architect's issue 10 asks 500 ms.** §3.2 uses 500 ms of game time (30 frames at 60 Hz), tested as the later of the two. Coordinator to confirm.
8. **R16 labels "a separate region" as the senior engineer's design;** it was the architect's (mine reused the narrow slots). The ruling's content (a separate `Wide` region sized by `maxClips`) is what this file implements.
9. **R2's "filter state in the pool at ≈ 120 B"** is one biquad; the entry holds two plus send and bed state (about 448 B, §3.1).
10. **Beds memory:** the record's "about 110 KB" is one bed plus the decoder; §3.1 gives 112 / 208 / 352 KB by preset.
11. **Kernel budget:** with a kernel per slot, a third zone's kernel cannot be prepared until a slot's kernel is released (an extra 50-200 ms); a spare kernel would add 3.0 MB at high. Accepted (the standby slot is on high and default).
12. **Reverb return** is now a per-zone bus (R17): the record's "added to the output" changes; ruled (R17).

## 12. Resolutions: every item of `review-round2-architect.md`

| Item | Outcome | Reason |
|---|---|---|
| Issue 1: zone state from the arena | **Taken** (R12) | `Zones` is a fixed region sized at init (§3.1); only kernels live in the arena |
| Issue 2: occlusion budget by timer | **Taken** (R12) | `budgetMs` becomes a ray count with an EMA of ray cost (§2.1, D2a) |
| Issue 3: own-collider skip, allocation | **Taken** (R12) | D0 excludes nodes and sensors inside the query and fills a reused `out` (§6) |
| Issue 4: pool `max_mixed / 2` | **Taken with changes** (R12) | one entry per mixed voice (taken at promote), so it cannot run out; about 448 B an entry, not 320 |
| Issue 5: filter 0.85 µs | **Taken** | 1.2 µs per biquad pass; mono-once is an estimate until C3 measures |
| Issue 6: IR blobs through main | **Taken** (R12) | worker to worklet; main gets timings (§4.5) |
| Issue 7: send before the distance gain | **Taken** (R11) | §4.4; default curve 1 to 0.5; clamp 4 |
| Issue 8: defaults agreed | **Taken** | no change |
| Issue 9: FuMa f32 | **Taken with changes** | scaled into int16 headroom with the inverse in the import volume; orders whose factor exceeds 4 keep f32 (§2.4) |
| Issue 10: 500 ms dwell | **Taken with changes** | 500 ms of game time, at least 30 frames' worth at 60 Hz (§3.2; §11 item 7) |
| Issue 11: send scale to 8x | **Taken** (R8) | product with the curve clamped to 4 |
| Issue 12: eviction cuts a ringing tail | **Taken** | standby slot on high and default; low evicts with a 150 ms fade; both paths tested (C3, C5) |
| Issue 13: 64-zone cap | **Taken** | zones past 64 warn by name (§3.2) |
| Section 3 S1: add "zone set re-plans every 4 frames" | **Taken with changes** | the active set re-plans every 4 frames with 1.5x for 500 ms; weights update each frame |
| S2 axis map and 0.001 rad | **Taken** | §4.2 |
| S3 foldLp to main | **Taken** | main folds the snapshot low-pass, the core folds gains (§4.4) |
| S4 300 ms stall test | **Taken** (R16) | B4 and §9 |
| S5 stereo decode when MagLS is missing | **Taken** (R9) | beds decode through the baked matrix until MagLS is resident |
| S6 memory numbers | **Taken with changes** | §3.1 (pool 448 B an entry, rings 1.22 MiB, zones fixed region) |
| S7 cost model | **Taken** | §10.3 |
| S8 health column | **Taken** | [ARCH §9] carries it; counters in §1.6 |
| S9 STATUS size | **Taken** | 15,904 B (§4.3) |
| S10 one standalone decoder | **Taken** (R8) | private decoders sized by `maxClips`; low has one |
| S11 rebuild gap | **Taken** | zones silent until resident, 100 ms fade (state "waiting for kernel") |
| S12-S20 | **Taken** | S13 score order unchanged, no bed-first rule; S14 500 ms; S17 rates 44.1 to 96 kHz, zones refused above with a warning; S18 allocation-free and exclusion; S19 in §1.4; S20 constants named in `schema.rs` |
| Section 2 C2-C5 (adopt my shapes) | **Taken with changes** (R1-R4) | BED_CONFIG per-bus slot plus per-slot host; SET_VOICE_FX 52 B with four sends and aux; LISTENER 36 B world-to-listener with a snap flag; one ZONE_CONFIG table, not CREATE/UPDATE/DESTROY |
| C6 ids and formats | **Taken with changes** (R5, R7) | MagLS 0xFFFF0100, kernels 0xFFFF0200..02FF, formats 3-5, packed bins |
| C7-C9, C14 | **Taken** | §4.3, §5.2, §6 |
| C10 `maxClips` dropped | **Rejected** (R8) | ruled kept: caps private decoders and wide rings |
| C10 `bedPriority`, `doppler.maxSpeed` | **Taken with changes** (R8) | 0..255 default 128, root 255; 150 (the architect's 100 proposal and my round-1 100 both rejected by ruling) |
| C11, C12, C13 | **Taken with changes** | `output` bus field (R17); `reverbSendCurve`; `openness` (R15); materials as §2.2 |
| C15-C24 | **Taken** | §1.6, §5.1; C18 coefficients (`SEND` 300, `AMBI_ROTATE` 2,000) adopted in the cost model |
| Section 5 conflicts | **Taken** | all resolved by the rulings; the table at §4 reflects them |
| Section 6 owner list | **Taken** (owner decisions, round 3) | folded into the base tasks (§10.1): HRTF 8, standby on high and default, ladder in, root owns a bed, zone return bus |
