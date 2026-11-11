# 0162 spatial audio: API, data models, formats and plan (M3), round 1

Senior engineer's design for ADR 0162 (Accepted direction, revision 3). Companion to the architect's `architecture.md` (components, lifecycles, timing, memory, performance, failure, observability). This file owns the public API, settings and asset data, internal data models, byte formats, native and TypeScript layout, editor integration, the Babylon mapping, the test plan and the task table. It extends [0157's api-and-models.md](../0157-audio-core/api-and-models.md) and does not repeat it: section numbers `0157 §n` point there. Where the architect and this file must agree, the text says `(S<n>)`, a contract listed in `contracts-senior.md`.

Units as in 0157: seconds, world units (the record says metres; the engine's unit is whatever the project uses, `audio.speedOfSound` is in units per second), linear gain, frames at the context rate, Hz, little-endian. Degrees only where a field says so (Inspector-facing angles). Line numbers cite the tree at 2026-11-11.

**Owner rules applied.** Follow Wwise, FMOD, Unity and Unreal in shape and naming and say where M3 differs (the "Industry" column in §1.6 and the notes in each section). No feature flags and no compatibility defaults: every M3 feature is on in the presets that afford it, the three samples that use audio are updated (§1.7), and no migration code exists. No run that cannot change a decision: the only measurements this design asks for are the lab-VM run and the metered gate (§9).

## 1. Public API

All additions are optional with defaults and exported from `src/myco.ts` (§6). Nothing here names Babylon, three.js, Rapier or Howler (ADR 0010).

### 1.1 Types

```ts
/** 0157 §1's AudioReason gains "occluded": virtual or inaudible mainly because a wall took it below the audibility floor. */
export type AudioReason = "virtual" | "stolen" | "busMuted" | "locked" | "failed" | "waitingForData" | "occluded";

/** How a voice reaches the stereo output (debug rows and `AudioHandle.panner`). */
export type AudioPanner = "flat" | "equalPower" | "hrtf" | "bed" | "ambisonic";

/** A curve of a send's level against distance (0158's `Curve`, `src/engine/core/curve.ts`): x is the distance as a fraction of
 *  minDistance..maxDistance (0 at minDistance, 1 at maxDistance, clamped), y multiplies the send (0..4). */
export type SendCurve = Curve;
export const DEFAULT_SEND_CURVE: SendCurve = [[0, 1], [1, 3]];
```

`AudioHandle` (0157 §1) gains two read-only members: `readonly panner: AudioPanner | null` (what the core last confirmed for this voice; null while virtual) and `readonly occlusion: number` (the voice's smoothed dry occlusion gain, 1 = open; 1 for flat voices and without physics). They are read from the main-thread mirror; no call into the core.

### 1.2 `AudioSource` additions

`AudioSource.ts` today (lines 45-90 plus 0157's `priority`) gains the fields below. Each carries `description` (ADR 0159). `apply()`'s change signature (`AudioSource.ts:179`) and `applyEvent()` (`:161-173`) include every new field, so editing one during Play takes effect at the next frame (live tuning).

| Field | Type, range | Default | Meaning |
|---|---|---|---|
| `occlusion` | boolean | `true` | Spatial sources only. Walls (colliders on the occlusion layers) between the source and the listener muffle the source. Inert in 2D worlds and without the 3D physics service. |
| `dopplerLevel` | number 0..5 | `1` | Spatial sources only. Scales the Doppler pitch shift; 0 turns it off. |
| `reverbSend` | number 0..2 | `1` | Spatial sources only. How much of the source goes to the reverb zones that hold it (1 = the zone's own wet level). |
| `sendCurve` | `SendCurve` | `DEFAULT_SEND_CURVE` | Send level against distance (see §1.1). The default rises 1 to 3 (+9.5 dB) from `minDistance` to `maxDistance`, because the send follows the source's own distance gain (§4.5), so this keeps the wet-to-dry ratio rising with distance as in a real room. |
| `ambisonicYaw` | number -180..180 | `0` | Ambisonic clips only. Turns the recording about the vertical axis, degrees, positive to the left seen from above, so its front lines up with the level. |

Read-only members (not fields): `velocity: Vector3` (the node's world velocity in units per second, estimated from position deltas, §3.2), `panner` and `occlusion` as for the handle. An `AudioSource` whose clip has an `ambisonic` sidecar ignores `spatial`, `minDistance`, `maxDistance`, `rolloff`, `occlusion` and `dopplerLevel` (the Inspector greys them; one warning per source); `volume`, `pitch`, `loop`, `output`, `priority`, `reverbSend` and `ambisonicYaw` apply. `@field(PlainObject)` carries `sendCurve` (the registry has no curve kind); the editor draws it with the SDK's `CurveEditor` through an Inspector section (§7).

**Industry.** `reverbSend` is Unity's `AudioSource.reverbZoneMix` and Wwise's game-defined aux send; `dopplerLevel` is Unity's; `occlusion` is Wwise's per-emitter occlusion switch. M3 differs: the send has a distance curve on the source (Wwise has one per aux bus, Unity none), and the send scale is 0..2, not Unity's 0..1.1.

### 1.3 `playOneShot` options

```ts
export interface OneShotOptions {
  // ... 0157 §1 fields unchanged ...
  /** With `position`: walls between the sound and the listener muffle it. Default true. */
  occlusion?: boolean;
  /** With `position`: Doppler from the listener's motion (a one-shot's position is fixed). 0..5, default 0. */
  dopplerLevel?: number;
  /** With `position`: send to the reverb zones that hold the position. 0..2, default 1. */
  reverbSend?: number;
  /** With `position`: send level against distance. Default `DEFAULT_SEND_CURVE`. */
  sendCurve?: SendCurve;
  /** Low-pass and high-pass cutoffs in Hz for this sound (lowest low-pass wins over automation's). Default: none. */
  lowpass?: number;
  highpass?: number;
  /** Ambisonic clips: turn the recording about the vertical axis, degrees. Default 0. */
  yaw?: number;
}
```

Doppler is opt-in for one-shots and events (the record): a footstep or UI click never glides. A flat one-shot (no `position`) has no occlusion, send, or Doppler; `lowpass` and `highpass` still apply. Unknown values clamp and warn once, as 0157's.

### 1.4 `AudioListener`

```ts
@component("engine.AudioListener")
export class AudioListener extends Component {
  /** World velocity in units per second, estimated from the node's motion (§3.2); read by Doppler. */
  readonly velocity: Vector3;
  /** Use `v` instead of the estimate (a physics body's own velocity, or zero across a camera cut). `null` goes back to the estimate. */
  setVelocity(v: Vec3Like | null): void;
}
```

No new fields. The listener that counts is unchanged (the first enabled `AudioListener` in the World with the view, else the main camera, `AudioListener.ts:2-4`); without a component, `velocity` comes from the camera node. The same listener's pose feeds `LISTENER` (§4.4), occlusion rays and zone containment.

### 1.5 New components

Both are registered by the audio plugin (`engine.AudioReverbZone`, `engine.AudioOccluder`), work in the editor World and in play, and need no physics to exist (an occluder only does something when the 3D service runs).

```ts
/** A volume of the scene with its own reverb. Sources inside it (and, fading in, within `blendDistance` outside) send to it. */
@component("engine.AudioReverbZone")
export class AudioReverbZone extends Component {
  @field(String, { choices: ["box", "sphere"], description: "The zone's shape." }) shape: "box" | "sphere" = "box";
  @field(Vector3, { description: "Offset of the volume from the node, in local units." }) center = new Vector3(0, 0, 0);
  @field(Vector3, { description: "Box zones: edge lengths in local units, scaled by the node's world scale." }) size = new Vector3(10, 4, 10);
  @field(Number, { description: "Sphere zones: radius in local units, scaled by the node's largest scale axis." }) radius = 5;
  @field(String, { choices: ZONE_PRESETS, description: "The built-in reverb used when no impulse response is set." }) preset = "hall";
  @field(AssetRef, { kind: "audio", description: "An impulse response (a mono or stereo WAV or FLAC). Overrides the preset. Longer than the preset's limit is cut with a fade." }) ir = "";
  @field(Number, { description: "Wet level, linear 0..2 (1 is the impulse response's own calibrated level, as a reverb bus effect at send 1)." }) wet = 0.5;
  @field(Number, { description: "Distance outside the volume over which the zone fades in, in world units. 0 is a hard edge." }) blendDistance = 2;
  @field(Number, { description: "Higher wins when more zones are in play than the preset has reverbs (0..100)." }) priority = 0;
  @field(Boolean, { description: "Let the reverb tail ring out after the zone stops being used, instead of cutting it." }) ringOut = true;
}
export const ZONE_PRESETS = ["room", "corridor", "hall", "cave", "open"] as const;

/** Tells audio what a wall is made of. Put it on a node with a collider, or on a parent of colliders. */
@component("engine.AudioOccluder")
export class AudioOccluder extends Component {
  @field(String, { choices: (s) => ["", ...s.audio.occlusion.materials.map((m) => m.name)], description: "Material from Project Settings > Audio. Empty uses the project's default material." }) material = "";
  @field(Number, { description: "Extra transmission loss for this wall in dB (negative muffles more), added to the material's." }) transmissionTrimDb = 0;
  @field(Number, { description: "Multiplies the material's low-pass cutoff (1 = as the material, below 1 duller)." }) cutoffScale = 1;
  @field(Number, { description: "0 closed, 1 open: blends the wall's effect away. Animate it for a door." }) openness = 0;
}
```

An `AudioOccluder` applies to every collider on its node and on descendants that have no occluder of their own (the nearest one up the parent chain wins, like `RigidBody` attachment, `Collider.ts:31-37`). `material = "none"` marks colliders (a character) as transparent. Colliders with no occluder anywhere above use `audio.occlusion.defaultMaterial`. A collider on a layer outside `audio.occlusion.layers` is never hit, whatever its node holds. Zones with `enabled = false` (the Component flag) are skipped; an occluder does the same.

**Industry.** The zone is Unity's `AudioReverbZone` (volume and fade-in) crossed with Wwise's per-emitter room membership: M3 weights **per source**, as Wwise rooms do, where Unity weights per listener. It is not a Wwise room: no portals, no room-to-room propagation (ADR open question). `AudioOccluder` is a Steam Audio material or Wwise acoustic texture on geometry, with per-wall trims; occlusion is a single transmission figure per hit, not frequency bands (later).

### 1.6 Ambisonic clip playback, `Audio.debug()` additions, industry map

An ambisonic clip is an ordinary clip path: `AudioSource.clip` or `playOneShot(path, { volume, bus, yaw, reverbSend, at })`. The clip is ambisonic only by its sidecar (§2.4). It rotates with the listener's orientation, takes `ambisonicYaw`, and is added into its bus's bed (§3.1), or decoded on its own (§3.1's standalone decoders). Its `reverbSend` is the clip's W channel sent to the zones that hold the **listener**.

```ts
export interface AudioDebugInfo {
  // ... 0157 §1 fields unchanged; counters gains:
  counters: { /* ... */ bedVoices: number; beds: number; bedsRefused: number; fxVoices: number; fxPoolFull: number;
              ambisonicVoices: number; zonesActive: number; zonesRinging: number; zoneMemoryKB: number;
              occlusionRays: number; occlusionUsedMs: number; occlusionOverruns: number; occlusionSources: number; oldestOcclusionAgeFrames: number;
              dopplerGuardTrips: number };
  buses: { /* ... */ bed: "own" | "parent" | "none"; bedHost: string | null; bedLost: boolean }[];
  /** One row per bed. `workUs` is modelled from work units (S12). */
  beds: { bus: string; voices: number; workUs: number }[];
  zones: { node: string; world: string | null; slot: number | null; state: "idle" | "loading" | "active" | "ringing" | "faded" | "failed"; ir: string; irSeconds: number; memoryKB: number; sendEnergy: number; why: string | null }[];
  occlusion: { enabled: boolean; note: string | null; budgetMs: number; rays: number; oldestAgeFrames: number };
  voices: { /* ... */ panner: AudioPanner | null; kindDwellMs: number; doppler: number;
            occlusion: { gain: number; cutoffHz: number; ageFrames: number; hits: number; material: string | null; collider: string | null } | null;
            filter: { lowpassHz: number | null; highpassHz: number | null; lowpassBy: "occlusion" | "event" | "bus" | "snapshot" | "automation" | "parent" | null };
            sends: { zone: string | null; level: number }[]; aux: { bus: string; level: number } | null }[];
}
```

`filter.lowpassBy` names the stage that set the lowest cutoff (mid review: "muffled, I don't know why"). `zones[].why` carries the reason a zone is not heard: `"faded: preset has 2 reverbs"`, `"no listener in range"`, `"IR failed: <message>"`, `"wet 0"`, `"no sources inside"`. A zone also logs one console warning when the planner fades it for lack of a slot (mid review issue 3). `AudioDebugInfo` is a public type, so this list is the API change 0157's versioning asks for.

**Industry map.**

| M3 name | Unity | Wwise | FMOD | Unreal | Differs |
|---|---|---|---|---|---|
| `AudioReverbZone` | AudioReverbZone | Room (emitter-side) | Reverb3D (listener-side) | Audio Volume | per source like Wwise; no portals |
| `reverbSend` | `reverbZoneMix` | aux send | reverb level | submix send | plus a distance curve |
| `dopplerLevel` | `dopplerLevel` | Doppler (attenuation) | `dopplerLevel` | Doppler (Attenuation) | teleport guard, listener velocity |
| `AudioOccluder.material` | n/a | acoustic texture | n/a | physical material (UE5 Audio Occlusion) | one transmission figure, not bands |
| bus `bed` own/parent/none | n/a | bus ambisonic config, child buses mix to parent | n/a | n/a | priority overflow rule |
| `audio.speedOfSound` | fixed 343 | fixed | `set3DSettings` | project setting | world units per second |

### 1.7 Compatibility with today's API, and what the samples change

No migration exists; this table says what moves and which sample changes with it.

| Item | Today | M3 | Sample impact |
|---|---|---|---|
| `AudioSource` fields | 0157 set | `+occlusion +dopplerLevel +reverbSend +sendCurve +ambisonicYaw`, all defaulted | Scenes load; `sound-lab`'s orbiting sources now Doppler-shift (set `dopplerLevel: 0` on the pitch and bench sources, `Orbit.ts` users in `sound-lab` and `stress`) |
| `playOneShot` options | 0157 set | `+occlusion +dopplerLevel +reverbSend +sendCurve +lowpass +highpass +yaw` | none needed |
| `AudioListener` | no members | `+velocity +setVelocity` | none |
| `AudioReason` | six values | `+"occluded"` | none |
| `AudioDebugInfo` | 0157 shape | §1.6 | `AudioDebugPanel` updated (§7) |
| Distant spatial voices | equal-power beyond the nearest `voices.hrtf` | encoded into a bed (kind 2) where the bus has one | sound changes by design; listening pass items |
| `voices.hrtf` presets | low 4, default 16, **high 32** (`audioSettingsModel.ts:210-214`) | low 4, default 16, high **8** | `stress` sets `hrtf: 32` explicitly: becomes the high preset's numbers (8, `maxBeds: 4`) |
| `audio.bed`, bus `bed`, `bedPriority` | none | §2.1; Master defaults to `own` | `sound-lab` and `stress` get `audio.bed`; `sound-lab` marks Ambience `own` |
| Positioned one-shots, `AudioSource` | no occlusion, no zone send | occlusion on, send 1 | nothing changes without colliders or zones |
| `myco.audioevent@1` | 0158 keys | `+filter +sends +spatial.occlusion/dopplerLevel/reverbSend/sendCurve` (additive, stays `@1`) | `sound-lab` events unchanged |
| Bus `reverb` effect | one shared convolver | unchanged; what a voice hears when no zone holds it | none |
| `audio.spatial: "equalPower"` | no HRTF | no HRTF, **no beds** (kind 0 everywhere); ambisonic clips use the stereo decode | none |
| Babylon fallback | 0157's | §8 | guides amended |
| Guides | `playing-sound.md`, `audio-mixer.md`, `sound-events.md`, `why-no-sound.md`, `audio-minimum-versions.md` | amended, plus a new `spatial-audio.md` (task E8) | |

## 2. Settings and asset data

### 2.1 `audio` keys

```jsonc
"audio": {
  "buses": [ { "name": "Master", "bed": "own", "bedPriority": 0 },
             { "name": "Ambience", "parent": "Master", "bed": "own", "bedPriority": 5 },
             { "name": "SFX", "parent": "Master" } ],           // bed absent: "parent"
  "bed": { "maxBeds": 4 },
  "occlusion": { "layers": null, "budgetMs": 0.5, "defaultMaterial": "concrete", "smoothingMs": 100, "materials": [ /* §2.2 */ ] },
  "zones": { "maxActive": 2, "maxSeconds": 4 },
  "doppler": { "maxSpeed": 100 },
  "speedOfSound": 343,
  "voices": { "mixed": 256, "logical": 4096, "hrtf": 8 }
}
```

| Key | Type, range | Default | Parse rule (lenient, `problems[]`, as `settings.ts:101-176`) |
|---|---|---|---|
| `bed.maxBeds` | integer 0..4 | 2 (the default preset) | clamp, problem if clamped. 0: no beds anywhere |
| `buses[].bed` | `own`, `parent`, `none` | root `own`, others `parent` | unknown: default plus problem. A root with `parent` is `own` without a problem |
| `buses[].bedPriority` | integer -100..100 | 0 | round, clamp |
| `occlusion.layers` | string list or null | null: every layer, triggers excluded | unknown layer names dropped plus problem (the list is checked against `physics.layers` when the physics section is known); an empty list turns occlusion off |
| `occlusion.budgetMs` | number 0.05..2 | high 0.5, default 0.25, low 0.06 | clamp, problem if clamped |
| `occlusion.defaultMaterial` | material name | `"concrete"` | unknown: the first material plus problem |
| `occlusion.smoothingMs` | number 10..1000 | 100 | clamp; per-material `attackMs`/`releaseMs` override |
| `occlusion.materials` | list | the table in §2.2 | names unique (later dropped plus problem), at most 32; the table is project data, edited in Settings |
| `zones.maxActive` | integer 0..2 | high 2, default 2, low 1 | clamp. 0: zones are inert (a note in the debug panel) |
| `zones.maxSeconds` | number 0.5..8 | high 4, default 2, low 1 | clamp. Longer IRs are cut with a 100 ms fade |
| `doppler.maxSpeed` | number > 0 | 100 | non-positive: default plus problem |
| `speedOfSound` | number 10..100000 | 343 | clamp. World units per second |
| `voices.hrtf` | integer 0..32 | low 4, default 16, high 8 | as 0157 §2; with `maxBeds` 0 the number is used as set |

The file stores numbers; presets stay bundles the editor offers (`VOICE_PRESETS`, `audioSettingsModel.ts:210`). M3's preset table: **low** `{ mixed 64, logical 1024, hrtf 4, clipMemoryMB 64, maxBeds 0, zones 1 x 1 s, budgetMs 0.06 }`; **default** `{ 128, 4096, 16, unset, maxBeds 2, zones 2 x 2 s, 0.25 }`; **high** `{ 256, 4096, 8, 256, maxBeds 4, zones 2 x 4 s, 0.5 }`. The default preset keeps `hrtf` 16 (the record fixes 8 only for high; flagged, §11).

**Bed resolution** (`beds.ts`, pure, main). Input: the bus tree, each bus's `bed` and `bedPriority`, `maxBeds`. (1) `requests` = buses asking `own` (the root counts as `own` unless `none`). (2) If `maxBeds` is 0, every bus is `none`. (3) Sort requests by `bedPriority` descending, ties by bus index (tree order); the first `maxBeds` are **hosts**; the rest are **losers** and become `parent`. (4) For each bus `b`: `own` host: itself; `parent` (declared or lost): the nearest ancestor that is a host, else `none`; `none`: none. A bus with no ancestor host falls back to the root's bed if the root is a host (the nearest-ancestor walk reaches it anyway). (5) Output `hostOf[b]` (0xFFFF none) goes to the core as BED_CONFIG (§4.2); `bedLost[b]` (a requester that lost) goes to the debug rows and the Settings warning ("Footsteps asked for its own bed but only 2 are allowed; it shares Master's").

### 2.2 Occluder materials

A material is `{ name, transmissionDb, cutoffHz, wetOcclusion, attackMs?, releaseMs? }`. `transmissionDb` is the dry loss of one hit (-80..0); `cutoffHz` the dry low-pass behind it (100..22000); `wetOcclusion` how much of the dry loss also applies to the reverb send (0 = none, 1 = as dry; the record's default 0.5); `attackMs`/`releaseMs` (0..2000) override `smoothingMs` when the occlusion rises or falls (a door that slams wants a short attack). The default table; **values are starting points for the listening pass**, not measurements:

| name | transmissionDb | cutoffHz | wetOcclusion |
|---|---|---|---|
| `none` | 0 | 22000 | 1 |
| `cloth` | -3 | 6000 | 0.8 |
| `glass` | -10 | 4000 | 0.6 |
| `wood` | -14 | 2500 | 0.5 |
| `metal` | -24 | 1500 | 0.4 |
| `brick` | -28 | 900 | 0.3 |
| `concrete` | -34 | 600 | 0.3 |

Several hits on one ray (up to 3) add their dB (so two walls muffle twice) and take the lowest cutoff; the total is clamped at -60 dB, where the voice is silent and selection may virtualise it. Transmission is per hit, not per metre of thickness (documented; `transmissionTrimDb` is the per-wall control). `openness` blends a hit's dB toward 0 and its cutoff toward 22 kHz (log scale) linearly.

### 2.3 Zone impulse responses

An IR is an `audio` asset (0143's existing kind; no new kind, no `ir: true` sidecar key: a zone's `ir` field names a clip and the zone, not the clip, makes it an IR). Mono IRs feed both channels' kernels; stereo IRs use channel 0 for the left input and channel 1 for the right (as `convolver.rs` header). More than two channels is refused (the zone shows "IR failed"). **Procedural presets** are generated in the decoder worker from a seeded generator (the same `mulberry32` as `convolver/ir.rs`), each `{ rt60 (s), hfDamping, predelayMs }`: `room` 0.45 / 0.5 / 4, `corridor` 1.1 / 0.6 / 6, `hall` 2.2 / 0.4 / 18, `cave` 3.6 / 0.3 / 30, `open` 0.9 / 0.8 / 40 (a sparse tail: late echoes of a courtyard). `hfDamping` sweeps a one-pole low-pass down over the tail so highs decay faster. Every IR, file or preset, passes through the same normalisation as the shared reverb (`1/rms`, `-58 dB` calibration, `44100/rate`), so `wet = 1` is level-comparable across zones and with the bus reverb at send 1.

### 2.4 Sidecar `ambisonic` (0040)

`myco.import@1` gains one optional key (`importSettings.ts` header, `ImportSettings`, `parse`, `serialise` at lines 98-127, 243-261, 397-399):

```jsonc
"ambisonic": { "order": 3, "convention": "ambix" }   // convention: "ambix" (ACN order, SN3D) or "fuma"
```

Rules. The key is **required for any clip with more than 2 channels** (a 4-channel WAV without it is refused with "4-channel audio needs an ambisonic import setting (ADR 0162); multichannel mixes aren't supported"). `order` is optional and inferred from the file's channel count (4 gives 1, 9 gives 2, 16 gives 3); a given `order` whose `(order+1)^2` differs from the file's channels is a problem and the clip fails to load, with the message naming both numbers. `convention` defaults to `"ambix"`. Orders 2 and 3 are WAV only (FLAC stops at 8 channels, Opus has no decoder: loading either refuses with the same reason the registry gives for any unsupported combination). FuMa is converted in the decoder worker before the clip reaches the core (§5.4), at f32 (clips converted from FuMa are stored f32 whatever `clipFormat` says: the X, Y, Z scale factor exceeds 1). `stream` is honoured; **ambisonic clips stream by default**: when `ambisonic` is set and `stream` is absent the registry streams clips longer than 5 s (a 3rd-order minute is about 92 MB at 16-bit). A sidecar on a clip with 1 or 2 channels is ignored with a problem. The Asset Inspector's audio block gains an Ambisonic checkbox, order and convention (E6).

### 2.5 `myco.audioevent@1` additions

Additive; the format stays `@1`. An older engine's lenient parser drops the new keys silently (0158 header), so a new event played by an old engine loses its filter and sends without error (stated, not defended: the engine is unpublished).

```jsonc
{
  "format": "myco.audioevent@1", "bus": "SFX", "volume": 1,
  "spatial": { "minDistance": 1, "maxDistance": 30, "rolloff": "inverse",
               "occlusion": true, "dopplerLevel": 0, "reverbSend": 1, "sendCurve": [[0, 1], [1, 3]] },
  "filter": { "lowpass": 9000, "highpass": 80 },
  "sends": { "reverb": 0.5, "Cave": 0.3 },
  "root": { "type": "clip", "clip": "sfx/step.ogg" }
}
```

- `filter.lowpass` and `filter.highpass`: Hz 10..24000 (lowpass above 20000 and highpass below 20 are off). They apply **per voice** of the instance through the same per-voice filter as occlusion and `lowpass` automation (the lowest low-pass wins; `lowpassBy` says which).
- `sends.reverb` (0..2, default absent: 1) is the event's `reverbSend`; any other key names a bus and is an **aux send**: `level` 0..2 added to that bus's input, post the voice's own bus gain chain, equal-power panned (§4.5). **One aux send per voice in M3**: with two named buses the first in key order is kept and the parse reports the other ("one aux send per event; <name> ignored"). An unknown bus name is dropped with a problem (the check happens when the event plays, as 0158's global parameter names).
- `spatial.occlusion` (default true), `spatial.dopplerLevel` (0..5, default 0, per 1.3), `spatial.reverbSend` is **not** a key: the one send is `sends.reverb`; `spatial.sendCurve` as 1.1. The record names `occlusion` as an event-level key without a place; it lives in `spatial` here, as the senior review proposed (flagged, §11), since it only means anything for a spatial event.
- A flat event (no `spatial`) takes `filter` and `sends.<bus>` and ignores the spatial ones.

Parse rules follow `eventFormat.ts`: bad numbers clamp to the range and report in `problems`, an unknown key is ignored, nothing throws. `formatAudioEvent` writes the keys only when set. The Event editor's node properties gain the controls (E5).

## 3. Internal data models

Who writes: **main** (play, stop, per-frame audio system), **sys** (the per-frame audio system's passes: selection, occlusion, zones, Doppler), **status** (the mirror), **core** (the worklet, which owns every audio-thread table).

### 3.1 Core tables (audio-thread; one writer, the core)

**Beds** (`audio-core/src/bed.rs`, region `Beds`, sized from `max_beds`): one `BedSlot` per host bus.

| Field | Type | Meaning |
|---|---|---|
| `host` | u16 | the bus index the bed decodes into; 0xFFFF free |
| `acc` | `[[f32;128];16]` | the 16 ACN/SN3D channels, cleared each quantum (8 KB) |
| `history` | decoder partition history | frequency-domain history of the 16 channels for the partitioned decode (about 40 KB, S6) |
| `voices`, `work` | u16, u32 | voices encoded and work units this quantum (STATUS) |

Shared across beds: the decoder spectra (16 channels x 2 ears x 2 partitions x 128 bins x 8 B = 64 KB), built when the bed-decoder blob (clip format 4, §4.6) is committed, and the rotation scratch. **Per bed voice** a `BedVoice` entry (64 B: 16 f32 last-quantum gains) from a free list of `max_mixed` entries; the voice slot holds `bed_slot: u16`. A voice enters the bed when its kind is 2 or it is an ambisonic clip; the entry is freed when the voice leaves the kind, goes virtual, or ends.

The **standalone decoders** are the beds' decoder states not hosting a bus: a clip whose bus has no host takes a free one (up to `max_beds`), else it uses the **stereo decode** `L = 0.5(sqrt(2) W + Y)`, `R = 0.5(sqrt(2) W - Y)` (two cardioids at +-90 degrees, centre level equal to the equal-power centre; hard sides differ from `EqualPowerPanner` by up to about 2 dB, accepted: used only for ambisonic clips without a bed, and for everything on `maxBeds` 0). With `maxBeds` 0 (low preset) all ambisonic clips use the stereo decode (documented limitation, S10).

**Voice slot** (`voices.rs`, `VOICE_SLOT_BYTES` 192): gains `bed_slot: u16`, `fx_slot: u16` (index into the fx pool plus 1, 0 none), `aux_bus: u16`, `send: [f32; 2]` with ramps (`Ramp` 16 B each: the 2 sends cost 32 B), `aux: Ramp`, `yaw: f32`, `hp_hz: f32`. If the slot's current size plus these does not fit 192 B the constant becomes 256 (the assert at `voices.rs:152` decides; every bench's memory line moves by 64 B x logical voices = 256 KB at 4,096; S6 asks the architect to carry the number). `PannerState` gains a `bed: Ramp` (the bed share, as the HRTF slot's `x`) and kind 2; for kinds 0, 1 and 2 `matrix` always holds the equal-power coefficients from the direction (also the sends' pan). `flag::AMBISONIC` is a new slot flag bit in a new `flags2: u8` (the 8 bits of `flags` are all used, `voices.rs:93-108`).

**Voice filters** (`audio-core/src/fxpool.rs`, region `Fx`, `max_fx = max(16, max_mixed / 2)` entries): per entry `lp: Biquad`, `hp: Biquad`, `lp_ramp: Ramp` and `hp_ramp: Ramp` in log-Hz, `idle: u16` quanta since both went off. A mixed voice takes an entry the first quantum its target low-pass is below `LP_OFF` (`wire::BUS_LP_OFF_HZ`, 24000) or its high-pass above 20 Hz, or automation binds a lowpass; it frees the entry 8 quanta (21 ms) after both are off (so a closing filter finishes ramping to open before it vanishes). **The automation low-pass migrates here**: `VoiceAuto.filter` (`automation.rs:151`) goes; the cutoff is `min(lpHz, lpAuto)`; goldens of M2 must not change (same `Biquad`, same coefficients, same order of operations: the first acceptance check of D1). A full pool leaves the voice unfiltered and counts `fxPoolFull`.

**Zone slots** (`audio-core/src/zones.rs`, region `Zones` for headers, state in the arena): `max_zones` (0..2) `ZoneSlot`: `state` (0 free, 1 active, 2 ringing, 3 fading), `ir_clip: u32`, `wet: Ramp`, `in_l/in_r: [f32;128]` (the quantum's summed sends, cleared each quantum), `state_block: Block` (the convolver's frequency-domain delay lines, input and accumulation rings, from the arena at ZONE_CREATE: 3.1 MB at 2 s, 6.1 MB at 4 s per the spike, S6), `ring_left: u32` (frames until a ringing tail ends), `phase: u8` (the stagger planner's offset, §5.2). The kernels are **not copied**: the slot reads them in place from the IR clip's arena block (the same way the HRIR bank reads its table).

**Listener** (`listener.rs`): `q` (current unit quaternion), `q_target`, `ramp_left`, and the derived `R: [[f32;16];16]`-sparse block-diagonal rotation (1+3+5+7 blocks) recomputed once per quantum (about 2 us, spike: rotation 7 us at order 1 inclusive of decode, 23 us at order 3 with decode).

### 3.2 Main tables

**Voice table additions** (`voiceTable.ts`, struct-of-arrays, allocated once at `L = voices.logical`; 0157 §3 conventions). New columns, with the writer of each:

| Field | Type | Units / values | Writer |
|---|---|---|---|
| `panner` (existing) | Uint8Array | 0 equal-power, 1 HRTF, **2 bed** (the kind the core was last told); with `pannerSince` below | sys (`pannerPick.ts`) |
| `pannerSince` | Uint32Array | frame number the kind last changed; kind changes need 30 frames (0.5 s) of dwell (sound-designer review item 8; the 1.2x hysteresis and 3-frame mixing dwell stay) | sys |
| `flags2` | Uint8Array | bit0 ambisonic clip, bit1 occlusion wanted, bit2 zone sends wanted, bit3 aux send | main |
| `yaw` | Float32Array | radians | main |
| `dopplerLevel` | Float32Array | 0..5 | main |
| `dopplerFactor` | Float32Array | 0.5..2, last sent | sys (`doppler.ts`) |
| `velX/Y/Z`, `prevX/Y/Z` | Float32Array | world u/s; last position | sys |
| `occTargetGain`, `occGain` | Float32Array | linear dry gain from the last ray; the smoothed value sent | sys (`occlusion.ts`) |
| `occTargetCut`, `occCut` | Float32Array | Hz, same | sys |
| `occWet` | Float32Array | wet-path factor from the hits' `wetOcclusion` | sys |
| `occAge` | Uint16Array | frames since the last ray result (saturating) | sys |
| `occHits`, `occMaterial` | Uint8Array | hits on the last ray (0..3); the first hit's material index (255 none) | sys |
| `occCollider` | Int32Array | index into the occlusion system's collider-name ring (debug only) | sys |
| `reverbSend` | Float32Array | 0..2 | main |
| `sendCurve` | Uint16Array | index into the curve table (a source's curve is interned; 0 default) | main |
| `zoneLevel0/1` | Float32Array | linear send into zone slot 0 and 1 as last sent (voice gain x curve x weight x wetOcc folded; the core multiplies the voice's chain gain) | sys (`zones.ts`) |
| `auxBus`, `auxLevel` | Uint8Array, Float32Array | the aux send (events, one per voice) | main |
| `lpHz`, `hpHz` (existing `lpHz`) | Float32Array | the **lowest** cutoff after the sources below; `lowpassBy` code | sys |
| `lpBy` | Uint8Array | 0 none, 1 occlusion, 2 event, 3 bus, 4 snapshot, 5 automation, 6 parent (sharing) | sys |
| `bedHostWhenSent` | Uint8Array | the bed host bus index the voice was placed for (to notice a re-plan) | sys |

`occlusion` state is per **voice**, not per source component: a source that re-plays starts open (gain 1) and is among the next rays' first candidates (age 0xFFFF sorts first). Sources are not tracked across voices.

**Velocity estimate** (`doppler.ts`): for each spatial voice and for the listener, `v = (p - prev) / dt` with `dt` the game frame's delta from `Time` (game time: when `Time.scale` is 0 nothing moves and velocity decays to 0; the audio clock is not used); smoothed by a one-pole with a 60 ms time constant; **teleport guard**: when `|p - prev| / dt` exceeds `audio.doppler.maxSpeed`, that entity's velocity is set to 0 and held for 3 frames and `dopplerGuardTrips` counts; a frame whose `dt` exceeds 0.25 s (a hidden tab, a debugger) resets every velocity to 0 (hidden-tab reset, record). A listener whose node has no motion over several frames reads 0. `AudioListener.setVelocity` bypasses the estimate and the guard.

**Zone registry** (`zones.ts`): per World, the live `AudioReverbZone` components with their cached world-space volume: for a box, the centre, half extents and the node's world rotation inverse (a 3x3); for a sphere the centre and radius. Recomputed when the node's world matrix version changes. The registry also holds each zone's IR state (`idle`, `loading`, `ready`, `failed`), the interned blob id, and the **slot assignment** table (zone to slot 0/1 or none). Capacity: 64 zones per World (extra zones are inert with one warning; broad-phase is a linear AABB test per voice: 256 voices x 64 zones is about 16 k tests a frame, under 0.05 ms).

**Occlusion state** (`occlusion.ts`): the candidate ranking (a fixed `Uint16Array` of voice indices, the top 16 by audibility-before-occlusion refreshed each frame by `selectTopK`, then a round-robin cursor over the rest), the **frame budget** timer (`performance.now()` around each ray, stop when `budgetMs` is spent, the cursor continues next frame), the collider-to-occluder cache (`WeakMap<collider, material index>`, cleared every 120 frames and on component add or remove), and the material table compiled to `Float32Array`s (transmission linear, cutoff, wet, attack and release coefficients).

## 4. Binary formats

Everything here lives in the one schema (`audio-wire/src/schema/*.rs`) and is generated into Rust and TypeScript (§5.5). All records follow 0157 §4.2's head (12 B: `u16 opcode; u16 words; u32 voiceId; u32 frameOffset`), `frameOffset` 0xFFFFFFFF asap. Offsets below are from the record's first byte, head included, so the first payload word is at 12.

### 4.1 PLAY and SET_PARAMS (changed meanings, same layout)

PLAY's `flags` (u16 at offset 16, within the payload at 12: `u32 clip` 12..15, `u16 bus` 16..17, `u16 flags` 18..19) keeps bits 0-6 (`loop`, `stream`, `wantsPlayhead`, `mixed`, `spatial`, `panner` at bits 5-6). The record says panner "bits 2-3" in its Context; the code and 0157 have **bits 5-6** (`batch.rs:22`, two bits wide, values 0..3). M3:

| Field | Bits | Change |
|---|---|---|
| `panner` | 5-6 | `2` = bed (encode into the bus's resolved bed); `3` reserved. Ignored for non-spatial voices |
| **`ambisonic`** | **7** | **new: a B-format clip voice.** The clip must have 4, 9 or 16 channels; the core derives the order. `spatial`, `panner` and `dir*` are ignored; `lpHz`, SET_FX `hpHz` and sends other than the W send are ignored. A stream voice (`stream` bit 1) may also be ambisonic |
| bits 8-15 | | reserved, 0 |

SET_PARAMS (56 B) is unchanged in layout; `flags` still reads only the panner bits (value 2 now accepted). `lpHz` is **applied to every voice** whose target is below `LP_OFF`, ramped in log-Hz over `rampFrames` (§3.1). `gain` and `lpHz` are where main puts occlusion (the dry gain and cutoff after smoothing) and Doppler goes in `pitch`; no new fields carry them.

### 4.2 New voice and bus records

**0x0A SET_FX** (stamped like any voice record; 44 B, 11 words). Sent after PLAY when any field is non-default, and when a field moves past its epsilon (hp 1 Hz, sends 0.002, aux 0.002, yaw 0.001 rad).

| Off | Type | Field |
|---|---|---|
| 12 | u32 | `mask`: bit0 `hpHz`, bit1 `send0`, bit2 `send1`, bit3 `yaw`, bit4 `aux` |
| 16 | f32 | `hpHz` (<= 20 off) |
| 20 | f32 | `send0`: linear level into zone slot 0 |
| 24 | f32 | `send1`: linear level into zone slot 1 |
| 28 | f32 | `yaw`: radians, ambisonic voices |
| 32 | f32 | `aux`: linear level into `auxBus` |
| 36 | u16 | `auxBus` (0xFFFF none) |
| 38 | u16 | reserved |
| 40 | u32 | `rampFrames` (sends, aux, hp; yaw jumps with the next listener ramp) |

**0x16 BED_CONFIG** (applies on arrival; 20 + 4 x ceil(busCount / 2) B): `u32 busCount` at 12, `u32 reserved` at 16, then `u16 host[busCount]` from 20, padded to 4 B. `host[b] == b` is an own bed, another index a share, 0xFFFF none. The core validates (a host must be the bus or an ancestor; invalid becomes none), allocates one `BedSlot` per distinct host up to `max_beds` (extra hosts are none and count `bedsRefused`), keeps the state of a host that stays, and frees a bed whose host left. Sent after BUS_CONFIG and again whenever the bus tree or `maxBeds` changes.

**0x17 ZONE_CREATE** (28 B, applies on arrival; `voiceId` = zone slot 0..1): `u32 irClip` at 12 (a clip id of format 3), `f32 wet` at 16, `u32 fadeInFrames` at 20, `u32 reserved` at 24. Allocates the slot's state from the arena (refused: clip event code 3 `refusedGrow`, STATUS `zoneEvent` 3). **0x18 ZONE_UPDATE** (20 B): `f32 wet` at 12, `u32 rampFrames` at 16. **0x19 ZONE_DESTROY** (20 B): `u32 mode` at 12 (0 fade out and free, 1 ring out), `u32 fadeFrames` at 16 (mode 0 only). Ring-out closes the input at once (the slot's sends are ignored) and keeps the output at full wet until the IR's frames have played (`ring_left`), then frees the slot and reports `zoneEvent` 2. A ZONE_CREATE onto a slot that is not free is refused (main waits for `zoneEvent` 2 or 4: planner eviction costs the fade, at most 150 ms).

**BUS_CONFIG and BUS_MIX** are unchanged. RESET clears beds, zone slots (state blocks freed), the fx pool and the listener (back to identity).

### 4.3 STATUS growth

The header grows from 112 to **144 bytes** (new `HEADER_BYTES`; the section offsets of 0157 §4.3 follow from it) and two sections are appended after `peaks`.

| Off | Type | Field |
|---|---|---|
| 112 | u16 | `bedVoices` (voices encoded, last quantum, all beds) |
| 114 | u16 | `bedsActive` |
| 116 | u16 | `fxVoices` (pool entries in use) |
| 118 | u16 | `ambisonicVoices` |
| 120 | u16 | `zonesActive` |
| 122 | u16 | `zonesRinging` |
| 124 | u16 | `zoneEventCount` |
| 126 | u16 | `bedsRefused` (cumulative, saturating) |
| 128 | u32 | `fxPoolFull` (cumulative) |
| 132 | u32 | `zoneUsedKB` (arena KB held by zone state) |
| 136 | u32 | `workBed` (work units last quantum: encode, decode, ambisonic) |
| 140 | u32 | `workZones` (convolvers, sends, aux) |

Sections in order after `peaks`: `beds {u16 bus; u16 voices; u32 work}[bedsActive]` (at most 4, 8 B each) and `zoneEvents {u8 slot; u8 code; u16 reserved}[zoneEventCount]` (at most 16, 4 B each; code 1 ready, 2 ringOutDone, 3 refused, 4 fadeDone). Clip event codes gain 5 `refusedFormat` (a malformed IR or decoder blob). Worst case 15,728 - 112 + 144 + 32 + 64 = **15,856 bytes**, inside the 16,384-byte pool buffer (S9: the architect confirms no other growth is planned). `flags` gains bit 6 `bedDecoderReady`.

### 4.4 LISTENER (0x20), byte-exact

36 B, 9 words, `voiceId` 0, applies on arrival, sent by the World with the view.

| Off | Type | Field |
|---|---|---|
| 12 | f32 | `qx` |
| 16 | f32 | `qy` |
| 20 | f32 | `qz` |
| 24 | f32 | `qw`: the listener's world rotation as a unit quaternion (rotates listener-space vectors to world space); the core normalises, and a non-finite or zero quaternion is ignored |
| 28 | u32 | `rampFrames`: the core slerps from the current to the new quaternion over this many frames (one game frame, about 800 at 60 Hz; 0 jumps) |
| 32 | u32 | `flags`: bit0 snap (a camera cut: no ramp, no clip crossfade) |

Position is not sent: voices keep listener-space directions from main (0157). Sent every frame in which the rotation moved more than 0.001 rad from the last sent, on the frame an ambisonic voice first plays, and on a listener change. **Axis convention** (S2): listener space is the engine's (forward -Z, up +Y, right +X); AmbiX is X forward, Y left, Z up. Ambisonic channel `ACN` vectors map by `(X, Y, Z)_ambix = (-z, -x, +y)_engine`. An ambisonic voice with `yaw` is rotated by `R = Rz_ambix(yaw) * R_listener^-1` (the inverse because turning the head right turns the field left). A **bed voice's** SH encode uses the listener-space direction through the same map. The 16x16 rotation is the Ivanic-Ruedenberg recurrence on the 3x3 matrix, applied block-wise (blocks 1, 3, 5, 7) once per quantum with the matrix interpolated linearly in the quaternion's slerp steps (one matrix per quantum, error under 0.1 dB at head-turn speeds, a golden checks it).

### 4.5 What a send is (the signal the core adds)

A voice's **zone send** into slot `k` is `send_k x (voice samples after resample, pitch and filter) x equalPowerMatrix(direction)`, added to the slot's `in_l/in_r`, where `send_k` (SET_FX) is what main computed and the core multiplies by the **bus-chain gain to the root** (the product of the gains and automation multipliers of the voice's bus and its ancestors, evaluated at the quantum like the bed fold below, effects not included): muting SFX mutes its reverb. The send is taken **after the voice's own gain and fade** (so it follows the dry distance gain; the default `sendCurve` compensates, §1.2) and uses the equal-power matrix whatever the panner kind. An ambisonic clip sends its W channel with the centre matrix. An **aux send** is the same signal with `aux` added to bus `auxBus`'s input buffer. Sends never see the occlusion low-pass (the wet path is dull anyway): main already folds `wetOcclusion` into `send_k`.

**Bed fold** (the record's "sharing folds bus volume, mute and ducking into per-voice gain", exactness checked): for a voice on bus `b` encoding into host `h != b`, the core multiplies the encode gain by `F = product of gain(b'), automationMul(b')` over the buses from `b` up to but **excluding** `h`, with each factor taken at the quantum's start and end and the product interpolated linearly across the quantum. This is the same set of ramps the tree applies to a signal that reaches `h` through those buses, **minus their effects, their snapshot low-pass and their meters**. The product of two 45 ms ramps differs from the tree's per-frame product by under 0.05 dB (a unit test with a ducked sharing bus asserts it). Ducking is main-side (`Mixer.update`) and arrives as BUS_MIX gains, so it is in `gain(b')` already: no main fold is needed, which settles the record's check. A sharing bus's **snapshot low-pass** is folded by main into the voice's `lpHz` (the lowest wins, `lpBy` 6) because the cutoff is a filter, not a gain; its effects and meter are lost for the voice (the record's stated loss).

### 4.6 Clip formats 3 and 4 (CLIP_BEGIN `format`, 0157 §4.1)

Neither is a voice's source; they follow the HRIR precedent (the clip store parses at commit and reports an event).

- **3, prepared IR** (any clip id outside the reserved range; `channels` 1, `frames` = blob bytes / 4, `sampleRate` the context rate). Blob header, 32 B: `u32 magic 0x5249594D ("MYIR")`, `u32 version 1`, `u32 irFrames`, `f32 sampleRate`, `u32 headParts` (at most 32), `u32 tailParts`, `u32 flags` (bit0 source was mono), `u32 reserved`. Then f32 spectra: head kernels `[2 channels][headParts][128 bins][re, im]` (256 f32 each), then tail kernels `[2][tailParts][2048 bins][re, im]` (4,096 f32 each, bin 0 packing DC in `re` and Nyquist in `im`, as `convolver.rs`). Normalisation is baked in. Size: `32 + 4 x 2 x (headParts x 256 + tailParts x 4096)`: 1.5 MB at 2 s, 3.2 MB at 4 s (48 kHz). The decoder worker produces it (§5.3); main sends it as ordinary CLIP_CHUNKs at the existing 256 KB per quantum.
- **4, bed decoder** (reserved id 0xFFFF0100). Header, 32 B: `u32 magic 0x4442594D ("MYBD")`, `u32 version 1`, `u32 order 3`, `u32 taps 256`, `f32 sampleRate`, 12 B reserved. Then f32 time-domain responses `[16 channels][2 ears][taps]` (32 KB) at the context rate; the core partitions and transforms them at commit (`bedDecoderReady` flag and `resident` event). The asset is **`engine/audio/magls-o3.bin`**, baked offline from M1's HRIR set by `native/audio/tools/bake-magls` and committed beside `hrir` (S5); main resamples to the context rate (the same code path as the HRIR) and re-sends it on a rebuild.

### 4.7 Versioning, hash, generation

Envelope version **1.1** (minor: new opcodes, appended payload fields, header growth; the generated constant and a unit test pin it). **ABI export version 2.0 (0x200)**: `myco_audio_init` changes signature (§5.4), a major change by 0157's rule, harmless as both halves ship and hash together. Decoder ABI 0x102. `SCHEMA_HASH` regenerates with `npm run build:audio`; `wire.schemaHash.test.ts` and `sourceHash.test.ts` fail until it does. `gen_wire` emits the new packers (`packSetFx`, `packBedConfig`, `packZoneCreate/Update/Destroy`, `packListener`), constants (`MAX_BEDS = 4`, `MAX_ZONE_SLOTS = 2`, `BED_CHANNELS = 16`, `AMBI_FLAG`, `PANNER_BED`, `STATUS_HEADER_BYTES = 144`, `IR_MAGIC`, `BED_MAGIC`) and the status readers; `native/audio/vectors/wire.json` gains one golden record per new opcode and a golden status block. `wire.roundtrip.test.ts` adds the new records to its round trip and its 1,000-batch fuzz (truncated SET_FX, BED_CONFIG with a bad host, ZONE_* on a slot out of range, a LISTENER with NaN: each refused without an out-of-bounds read).

## 5. Native layout

### 5.1 Crates and modules

| Where | New | Changed |
|---|---|---|
| `audio-wire/src/schema/` | `spatial.rs` (the new records, flags, constants, STATUS growth) | `batch.rs` (PLAY flags, LISTENER payload, opcode table, tests), `status.rs`, `envelope.rs` (clip formats 3, 4), `schema.rs` (versions) |
| `audio-dsp/src/` | `ambisonic.rs` (SN3D real SH encode orders 1-3, rotation, stereo decode), `bed_decoder.rs` (partitioned 16 to 2 FFT-domain FIR), `convolver/kernel.rs` (`prepare_ir`, spectra layout), `convolver/instance.rs` (state with kernel references, `plan_stagger`), `convolver/presets.rs` (procedural generator), `fxfilter.rs` (log-Hz ramped lp/hp pair over `Biquad`) | `convolver.rs` (the shared reverb becomes one instance of `instance.rs`: **bit-identical output**), `convolver/ir.rs` (generator shared), `resample.rs` (N <= 16 channels), `biquad.rs` (highpass setter exists, kernel reused) |
| `audio-core/src/` | `bed.rs`, `zones.rs`, `fxpool.rs`, `listener.rs` | `voices.rs` (ambisonic render path, per-voice filter, sends, aux), `panner.rs` (kind 2, three-way crossfade), `bus.rs` (bed decode before the host's effects, chain gain, zone output into the output after the bus tree and before MASTER), `clips.rs` (formats 3, 4, N channels), `stream.rs` (wide rings), `arena.rs` (zone budget), `status.rs`, `counters.rs`, `layout.rs` (regions `Beds`, `Zones`, `Fx`, `BedVoices` inserted before `Arena`; **append-only**), `params.rs` (`InitParams +max_beds +max_zones +zone_max_frames +max_fx`), `core.rs` |
| `audio-decode/src/` | `ir.rs` (decode an IR, resample, normalise, trim, partition, FFT; presets), `ambisonic.rs` (FuMa to AmbiX; the channel-count check) | `lib.rs` (exports below), `decoder.rs` (channel limit 2 to 16) |
| `audio-wasm/src/` | | `lib.rs` (init signature, ABI 0x200, exports), `memory.rs` (maximum = fixed regions + `clipMemoryMB` + zone budget) |
| `audio-bench/src/` | scenes `m3-bed`, `m3-clip`, `m3-zones`, `m3-typical`, `m3-filters` | `lib.rs` memory mode lists the new regions |
| `native/audio/tools/` | `bake-magls/` (Rust bin: the spike's solver over `hrir` data; deterministic; `--check` verifies the committed `magls-o3.bin`) | |

### 5.2 The convolver split and the stagger planner

0157 `convolver.rs` is one global convolver with a **fixed schedule** over 16 quanta. M3 refactors it without changing its sound: `kernel.rs::prepare_ir` produces the spectra layout of §4.6 (the existing seeded 1.8 s reverb is prepared by the same function at `Core::new`, so the shared reverb's output stays **bit-identical**, which the existing goldens and parity digests prove); `instance.rs` holds one stereo convolver's mutable state (delay lines, rings, accumulation) with a `phase` that offsets its 16-quantum tail schedule. `plan_stagger(instances) -> phases` is the spike's load balancer (modelled work per quantum, minimising the peak, lowering p99 by 25-35% in `spikes/audio-spatial/convolution`), run in `submit` when a zone is created or destroyed. It **replaces** architecture §10's "never share a tail quantum" (the record's Deprecates). The shared reverb is instance 0 (always present when a bus has a reverb send); zones are instances 1 and 2.

### 5.3 Decoder worker and IR preparation

`audio-decode` gains `myco_ir_*` exports (decoder ABI 0x102): `myco_ir_prepare(src_ptr, src_len, hint, target_rate, max_frames) -> i32` (decode via the existing symphonia path to f32, mix to 2 channels or duplicate mono, resample with `audio_dsp::resample` to `target_rate`, trim a silent tail under -80 dBFS, cut to `max_frames` with a 100 ms fade, normalise as the shared reverb, then partition and transform), `myco_ir_generate(preset, target_rate, max_frames) -> i32`, `myco_ir_blob_ptr() -> *const u8`, `myco_ir_blob_len() -> u32`. The worker's wasm memory grows by the blob (up to 7 MB at 4 s) while preparing and releases it after posting (the transfer is the hand-off). Linking `microfft`'s 4,096-point transform adds about 28 KB to the decoder; the decoder gate (900 KB, 749,095 B today) and AAC gate (1,280 KB) are re-checked (§5.6). Preparation takes 1.3 / 2.5 / 5.3 ms for 1 / 2 / 4 s on the spike, plus decode and resample (unmeasured: the first thing task C2a measures). The worker keeps the **encoded bytes** (as the M1b clip path does) so a rebuild or a sample-rate change re-prepares without main holding 3 MB blobs; main keeps only the id and state.

### 5.4 ABI changes, clip arena and stream rings

`myco_audio_init(sample_rate, max_logical, max_mixed, max_buses, arena_initial_bytes, max_beds, max_zones, zone_max_frames, max_fx) -> i32`, deterministic as before (regions in `REGION_ORDER`, new ones before `Arena`). New or changed exports: `myco_audio_abi_version` returns 0x200; `myco_audio_zone_budget_bytes(max_zones, zone_max_frames) -> u32` (the shell sizes the memory `maximum` from it: fixed regions + clip ceiling + this). No other export changes: BED_CONFIG, SET_FX, ZONE_* and LISTENER arrive through `submit`, the IR and bed-decoder blobs through the existing `clip_reserve`, `clip_chunk_ptr` and `clip_commit` with formats 3 and 4.

**Clip arena to 16 channels.** `clips.rs::Entry.channels: u8` already holds 16; `reserve` refuses `channels > 2` today and now accepts 1, 2, 4, 9 and 16 (and nothing else: a 5-channel clip is refused with the registry's message). `audio_dsp::resample::Source` generalises from 1-2 to N <= 16 channels and writes planar `[N][128]` into a voice scratch (`16 x 128 x 4 = 8 KB`, one, shared: ambisonic voices render one after another into it and add into their bed before the next). At pitch 1 and equal rates the resampler copies. Memory: a 10 s 3rd-order clip at i16 is 15.4 MB, against `clipMemoryMB`.

**Wide stream rings.** `stream.rs` has `RING_CHANNELS = 2` and `RING_FRAMES = 32,768` (`STREAM_RING_FRAMES` in the wire), `RING_BYTES` about 270 KB per ring slot. Rule: a stream of more than 2 channels takes `k = ceil(channels x 16,384 x 4 / RING_BYTES)` **adjacent** ring slots (4 channels: 1, 9: 3, 16: 4) and a ring of **16,384 frames** (0.34 s at 48 kHz: a bounded latency budget for the worker round trip, S4), laid out as one interleaved ring across the slots. `chunkFramesFor(channels) = 4096 x 2 / channels` (512 frames at 16 channels, 64 KB buffers). The credit protocol (STREAM_CREDIT, `buffered + inFlight` against the ring) is unchanged, sized by the stream's own ring frames; the wire gains `STREAM_RING_FRAMES_WIDE = 16384`. Slot counts: high 16 rings (four 3rd-order streams at once), default 8 (two), low 4 (one 1st-order stream). A wide stream that finds no adjacent free slots fails to open with `streamEvent` 3 (error) and a warning naming the count.

### 5.5 Build scripts and the size tripwire

`npm run build:audio` (`native/audio/build.mjs`) additionally: runs `bake-magls --check` (fails if `magls-o3.bin` is stale against `hrir`), builds the new decoder exports into both decoder builds, writes the new hash. Gates stay: `MIXER_LIMIT` 256 KB (`build.mjs:23`; the mixer is **178,598 B** after M2), `DECODER_LIMIT` 900 KB, `DECODER_AAC_LIMIT` 1,280 KB. **Estimated** M3 mixer increase +40..50 KB (SH encode and rotation ~12, bed decode ~8, zone instances and sends ~10, voice filter pool ~5, N-channel resample ~6, wire parse ~8): 220-230 KB, 84-88% of the gate. The build prints a **warning above 230 KB** and fails at 256 KB; crossing the warning means the owner is told and the M2 precedent applies (size gates signal bloat; the owner may move the gate with a reason). `wasm-opt` is not installed here, so the figures are pre-optimisation upper bounds. The metered gate (`npm run check:audio-metered`, `tools/audio-bench/metered-gate.mjs`) gains the `m3-*` scenes' instruction counts with a 10% gate, baselines recorded in the build log.

## 6. TypeScript module and file layout

New files, then changed. Names follow the existing `runtime/core/` split (0157 §6).

```
src/engine/audio/
  settings.ts                  + bed, occlusion (+ materials parse), zones, doppler, speedOfSound, bus bed/bedPriority
  eventFormat.ts               + filter, sends, spatial.occlusion/dopplerLevel/sendCurve; format and parse
  occlusionMaterials.ts        the default table, parse, compile to arrays (shared by settings and the runtime)
src/engine/scene/importSettings.ts            + ambisonic
src/engine/core/worldServices.ts              WorldRayHit + node, _worldRaycast(options) (D0)
src/plugins/audio/runtime/
  AudioReverbZone.ts  AudioOccluder.ts        the components (§1.5)
  Audio.ts AudioSource.ts AudioListener.ts audioSystem.ts backend.ts    + the §1 members; the system runs the new passes in order:
      attenuation, doppler, zones (weights), occlusion, audibility, selection, pannerPick, fx staging, listener
  core/
    beds.ts          bed resolution (§2.1), BED_CONFIG packing, host lookup per bus
    pannerPick.ts    replaces hrtfPick.ts: HRTF top-N, then bed or equal-power, 30-frame kind dwell
    zones.ts         registry, per-voice weights and send levels, slot planner (energy, hysteresis 1.5x, dwell 0.5 s, eviction wait), ZONE_* commands, REPLAY order
    zoneIr.ts        IR preparation requests to the worker, blob cache by (path, rate, maxSeconds), re-prepare on rate change, failure states, memory accounting
    occlusion.ts     rays on a frame budget, ranking, smoothing, material combine, age; reads the 3D service through `_worldRaycast`
    doppler.ts       velocity estimates, factor (OpenAL form), teleport guard, folding into `pitch`
    listener.ts      listener pose to LISTENER, velocity for Doppler
    voiceFx.ts       stages lpHz (min of occlusion, event, bus, snapshot, automation) with `lpBy`, hpHz, sends, aux, yaw into SET_FX and SET_PARAMS
    voiceTable.ts commandWriter.ts coreBackend.ts replay.ts mirror.ts statusReader.ts debug.ts spatial.ts   changed
  decoder/ambisonic.ts   FuMa to AmbiX at f32, channel and order validation
  decoder/irPrepare.ts   worker handler for `prepareIr` and `generateIr`, protocol messages added to protocol.ts
  wire.generated.ts      regenerated
src/plugins/audio/editor/  (see §7)
src/myco.ts                exports AudioReverbZone, AudioOccluder, ZONE_PRESETS, DEFAULT_SEND_CURVE, SendCurve, AudioPanner
```

`hrtfPick.ts` and its test become `pannerPick.ts`; the HRTF-only behaviour (top `voices.hrtf` with 1.2x hysteresis) is a subset: the test file keeps its cases and adds the bed cases. The audio system's order (the record, 0157: attenuation, then the occlusion slot, then audibility, then selection) is preserved: **audibility reads the smoothed occlusion gain with M2's no-gap rule**, so an occluded voice is not dropped before its fade-out completes, and the occlusion candidate ranking uses audibility **before** occlusion (the mid review's circularity point). `AudioBackend` (`backend.ts`) gains `listener(pose)`, `setReverbZones(zones)` and `occlusion` hooks only on the core backend; the Babylon backend implements §8's subset and ignores the rest.

Plugin boundary (`plugins.test.ts`, build-log lesson 3): the audio plugin imports nothing from `src/plugins/physics`. It reaches physics through `_worldRaycast`, which today returns point, normal and distance and takes no layers and returns no collider (`worldServices.ts:36-41, 266`). Task D0 extends it: `_worldRaycast(world, origin, dir, maxDistance, options?: { layers?: readonly string[]; includeTriggers?: boolean })` and `WorldRayHit.node?: GameObject` (the collider's node), implemented in the physics service's `raycast` (Rapier groups from `layerGroups`, sensors excluded unless asked). That is an engine-core and physics-plugin change the record does not name (flagged, §11).
