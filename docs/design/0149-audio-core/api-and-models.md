# 0149 audio core: API, data models, formats and plan (M1), revision 3 (owner-approved)

Senior engineer's design for ADR 0149 (Accepted). Companion to `architecture.md` (the architect's: components §1, lifecycles §2, interactions §3, clock and timing §4, memory §5, performance §6, failure §7, observability §8, platforms §9). This file owns the concrete API, data, byte formats, Rust ABI, file layout, tests and tasks, and does not repeat architecture's rationale. Revision 3 records the owner's approval and choices (Babylon fallback, Chromium ports, microfft, Chromium HRTF in M1; section 10). Revision 2 applied the round-2 reviews and the coordinator's rulings (section 10 lists each). "M2" marks where the roadmap extends a structure.

All multi-byte values are little-endian. Units: seconds, metres, linear gain (1 = unity), frames (sample frames at the context rate), Hz. Line numbers cite the tree at 2026-11-09.

## 1. Public API

All additions are optional with defaults, exported from `src/myco.ts` (section 6).

```ts
/** Why a sound isn't audible right now; null while it is. */
export type AudioReason = "virtual" | "stolen" | "busMuted" | "locked" | "failed" | "waitingForData";
export type AudioStatus = "locked" | "running" | "failed";

/** One sound started with `playOneShot`. A value, safe to keep: once the voice ends or its slot is reused, every call is a no-op. */
export interface AudioHandle {
  /** True from the call to `playOneShot` until the sound ends or is stopped. Virtual, bus-muted, locked and waiting-for-data sounds are playing (they exist and keep time). Stolen and failed sounds are not. Natural ends are seen up to one frame late. */
  readonly playing: boolean;
  /** Why it isn't audible (while `playing`) or why it ended early ("stolen", "failed"); null when audible, or finished or stopped normally. */
  readonly reason: AudioReason | null;
  /** Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. A second call is a no-op. */
  stop(fadeSeconds?: number): void;
  /** Ease this sound's own gain multiplier to `to` (linear, 0..4) over `seconds` (0 = at once). */
  fade(to: number, seconds: number): void;
}

export interface OneShotOptions {
  volume?: number;       // linear, default 1
  position?: Vec3Like;   // world metres; omitted = flat
  pitch?: number;        // ratio, default 1, clamped 0.0625..16
  minDistance?: number;  // with position, metres, default 1
  maxDistance?: number;  // with position, metres, default 100
  bus?: string;          // default Master; unknown: Master plus the existing one-time warning
  /** 0..255, default 128. Mostly decides who is stolen when a limit is hit; it only mildly raises audibility (at most +6 dB in selection). */
  priority?: number;
  /** Start at this audio-clock time (seconds, the base of `Audio.time`). Past or omitted: as soon as possible. Ignored while `Audio.status` is "locked". Non-finite: warns, plays now. */
  at?: number;
}

export const Audio: {
  /** Start a clip once. A bare number is the volume. Always returns a handle (refused or failed plays give an inert one with `playing` false); never throws. */
  playOneShot(clip: string, options?: number | OneShotOptions): AudioHandle;
  bus(name: string): Bus;                              // unchanged
  readonly buses: readonly string[];                   // unchanged
  snapshot(name: string, fadeSeconds?: number): void;  // unchanged, default 0.5
  clearSnapshot(fadeSeconds?: number): void;           // unchanged, default 0.5
  /** Master volume 0..1. New alias of `masterVolume` (ADR delta D1). */
  volume: number;
  /** Same property as `volume`; kept. */
  masterVolume: number;
  /** Mute everything. Now readable. */
  muted: boolean;
  /** The heard audio clock in seconds (architecture 4.3): 0 before the context runs; independent of game pause and `Time.scale`; updated once per frame. */
  readonly time: number;
  readonly status: AudioStatus;
  /** A copy of the state for tools and "why is there no sound?". Allocates; never per frame. */
  debug(): AudioDebugInfo;
};

export interface AudioDebugInfo {
  status: AudioStatus; sampleRate: number; time: number; background: "mute" | "pause" | "play";
  counters: { underruns: number; lateCommands: number; minSlackFrames: number; workUnits: number; workUnitsMax: number; mixedVoices: number; mixedCap: number; logicalVoices: number; queuedPlays: number; droppedPlays: number; traps: number; refusedLoads: number; hrtfVoices: number; hrtfLoadFailure: number };
  buses: { name: string; gain: number; effectiveGain: number; peakL: number; peakR: number; voices: number; maxVoices: number | null }[];
  voices: { id: number; clip: string; bus: string; world: string | null; state: "playing" | "virtual" | "stolen" | "waitingForData" | "busMuted" | "locked"; priority: number; gain: number; pitch: number; audibility: number; playheadSeconds: number | null; owner: string | null }[];
  /** Architecture 8: context state, latencies, lookahead, transport, memory and health groups. */
  core: Record<string, number | string | boolean>;
}
```

`Bus` (`mixer.ts:34-57`) keeps its members and adds `readonly peak: number` (max of L and R over the newest status block, linear, decayed for display; 0 while locked). **`Bus.activeVoices` counts every live, non-ended voice on the bus, virtual and paused included**, exactly as today (`howlerBackend.ts:30-38` counts from play to end or stop) and as 0097's "voice activity" says, so cap-driven virtualisation never flaps a duck.

`AudioListener` (`AudioListener.ts:5`) is unchanged. `AudioSource` adds `@field(Number) priority = 128` (0..255) and has no handle in M1.

**Semantics.** No method throws; each clamps and warns once (as `mixer.bus`, `mixer.ts:96-99`). `playing`, `reason`, `Bus.activeVoices`, `Bus.peak`, `time` and `status` read the main-thread mirror, updated per frame and in the host's `onmessage` (architecture 4.2 gives the staleness bounds). `stop()` and `fade()` update the mirror at once. A script reading `playing` right after `playOneShot` sees `true`. `AudioSource.isPlaying` keeps its meaning (`AudioSource.ts:67-69`).

**Before and after** (`src/engine/audio/AudioSource.ts` today):

| Item | Today | M1 | Compatible |
|---|---|---|---|
| `Audio.playOneShot` | `void` (147) | returns `AudioHandle`; options `+priority`, `+at` | Yes |
| `bus`, `buses`, `snapshot`, `clearSnapshot` | 166-182 | same | Yes |
| `Audio.masterVolume` | 186-191 | kept; `volume` alias added | Yes |
| `Audio.muted` | setter only (193) | getter added | Yes (Howler's getter was always `false`, `howlerBackend.ts:133`) |
| `Audio.time`, `status`, `debug()` | none | new | Additive |
| `AudioSource` fields and methods | 45-90 | same; `priority` added | Yes; old scenes load as 128 |
| `Bus` | `mixer.ts:34-57` | `+peak` | Yes |
| Component ids `engine.AudioSource`, `engine.AudioListener` | | unchanged | Yes |
| Import path | `src/engine/index.ts:51-53` | `src/myco.ts` | Yes for game code; engine tests change imports |
| Spatial panning | HRTF (`howlerBackend.ts:64`, Web Audio `PannerNode`) | a port of Chromium's HRTF panner with its Composite HRIR data for the top `voices.hrtf` (16) spatial voices by audibility, equal-power for the rest; `audio.spatial: "equalPower"` turns HRTF off | Same sound for those voices if the data licence clears (task H0). **If it doesn't:** SADIE II data on the same panner, or the default becomes equal-power (a behaviour change for ADR delta D4) |
| Reverb send | one convolver, generated 1.8 s noise IR (`busGraph.ts:16`) | same design in the core: generated IR, a port of Chromium's staged convolver (`reverb_convolver`, `fft_convolver`), seeded noise | Matches within dB tolerance; the IR is reproducible, no longer `Math.random` |
| Filter `q` | Web Audio `Q` in dB for lowpass/highpass (`busGraph.ts:65`) | a port of Chromium's `biquad.cc`: the same meaning by construction | Yes |
| Compressor | Web Audio `DynamicsCompressor` (`busGraph.ts:72-76`) | a port of Chromium's `dynamics_compressor.cc` (makeup gain, knee, adaptive release, pre-delay) | Matches by construction; verified against an `OfflineAudioContext` |
| Fallback backend | Howler | Babylon `AudioEngineV2` behind 0098 (`BabylonBackend`); Howler is deleted | Same API. The fallback has **no effects** (reverb, filters, compressor are core-only), no priority or virtual voices, and plays spatial sound through Babylon's panner. Documented in the guide |
| Unlock and format fallback | Howler | the host's unlock layer for both backends (Babylon's own `resumeOnInteraction` and unmute UI are off, architecture §9); `decodeAudioData` until M1b | Yes |
| Bus tree change while playing | sounds keep old routing | voices remap by bus name; unknown names go to the root | Improvement |
| A World losing the view | its voices keep sounding | its voices go virtual (silent, keep time) | Minor change, ADR delta D8 |

## 2. Project settings and asset data

`audio` in `project.json` (types stay in `src/engine/audio/settings.ts`, a core module like navigation's settings: `Engine.ts:14`, `core/settings.ts:3`):

```jsonc
"audio": {
  "buses":   [{ "name": "SFX", "parent": "Master", "volume": 1, "mute": false, "effects": [], "maxVoices": 16 }],
  "snapshots": [], "ducking": [],
  "voices":  { "mixed": 128, "logical": 4096, "hrtf": 16 },
  "background": "mute",                 // "mute" | "pause" | "play"
  "clipMemoryMB": 128,                  // arena ceiling
  "clipFormat": "i16",                  // "i16" | "f32"
  "codecs":  { "aac": false },
  "spatial": "hrtf",                    // "hrtf" | "equalPower"
  "backend": "babylon"                  // "babylon" | "core"; the host also falls back to Babylon automatically when the core can't load
}
```

| Key | Type, range | Default | Parse rule (lenient, `problems[]`, as `settings.ts:101-176`) |
|---|---|---|---|
| `buses[].maxVoices` | integer 1..`voices.logical` | unlimited | rounds; clamps; `null`/absent unlimited; wrong type dropped plus problem |
| `voices.mixed` | integer 8..512 | 128 | clamp, problem if clamped |
| `voices.logical` | integer `mixed`..8192 | 4,096 | clamp; below `mixed` raises to it |
| `background` | enum | `"mute"` | unknown: default plus problem |
| `clipMemoryMB` | integer 16..1024 | the preset's ceiling (architecture 5.3) | clamp. When set it is the ceiling and the device class does not lower it |
| `clipFormat` | enum | `"i16"` | unknown: default plus problem |
| `codecs.aac` | boolean | false | non-boolean: false plus problem |
| `voices.hrtf` | integer 0..32 | 16 (low preset 4) | clamp; problem if clamped; 0 behaves as `"equalPower"` |
| `spatial` | `"hrtf"` or `"equalPower"` | `"hrtf"` (becomes `"equalPower"` if neither the Composite licence nor SADIE II clears, task H0) | unknown: default plus problem |
| `backend` | enum | `"babylon"` until M1b passes, then `"core"` | `"howler"` (the old default, `settings.ts:169`): problem `"howler" was replaced by "babylon" (ADR 0149); using "babylon"`; `"fmod"`: problem `"fmod" was removed (ADR 0149); using <default>`, the `fmod` object dropped silently |

`AudioSettings` gains `voices` (now with `hrtf`), `background, clipMemoryMB?, clipFormat, codecs, spatial`; `fmod?` goes and `backend` becomes `"babylon" | "core"`. Presets are named bundles the editor offers; the file stores numbers. **Fallback.** When the core cannot load (no AudioWorklet or `simd128`, a fetch or hash failure) or reaches `failed` after its recoveries, the host warns once and switches to `BabylonBackend`, so there is still sound (0098's "a failed load keeps the fallback"); `Audio.debug().core.fallback` says `"babylon"`. This extends the ADR's failure table (delta D10). A project can also choose `"babylon"` outright.

**Migration: none.** (a) Every new key is optional with the defaults above. (b) Every old parse branch is kept, so inputs without new keys give the old buses, snapshots and ducking plus default new fields; `audioSettings.compat.test.ts` runs a corpus of pre-0149 shapes (those in `audioMixer.test.ts`) and asserts it. (c) No sample project has an `audio` key or "fmod" (checked over `samples/*/project.json`), and `samples/pirates` uses only `AudioSource` and `playOneShot`. (d) Only `backend: "fmod"` and `"howler"` change meaning; both degrade to a warning (`"howler"` maps to `"babylon"`).

**Sidecars (0040) after M1b.** `volume` unchanged (`AudioSource.ts:27`). `stream` becomes a hint to decode incrementally on the worker (4096-frame chunks); streamed clips are routable, spatial and gapless, so `warnStream` (`AudioSource.ts:30-34`) and `spatial && !stream` (`:102`) go. In M1a `stream` is read and ignored: the clip decodes whole and plays routable, never as HTML5 audio. The value is read once when the clip loads; a sidecar edit applies on the next load.

## 3. Internal data models

**Voice table** (`runtime/core/voiceTable.ts`), struct-of-arrays, capacity `L = voices.logical`, allocated once, no per-frame allocation. Writers: main (play/stop), sys (audio system per frame), status (mirror apply).

| Field | Type | Units / values | Writer |
|---|---|---|---|
| `gen` | Uint16Array | 1..65535, bumped on free | main |
| `state` | Uint8Array | 0 free, 1 locked, 2 playing (mixed), 3 virtual, 4 waitingForData, 5 stopping, 6 ending | main, status |
| `panner` | Uint8Array | 0 equal-power, 1 HRTF (selection gives HRTF to the top `voices.hrtf` spatial voices by audibility, with 1.2x hysteresis; a change goes as SET_PARAMS `flags`) | sys |
| `flags` | Uint8Array | bit0 loop, 1 spatial, 2 stream, 3 oneShot, 4 wantsPlayhead, 5 paused, 6 stopOnFadeEnd | main |
| `reason` | Uint8Array | 0 none, 1 virtual, 2 stolen, 3 busMuted, 4 locked, 5 failed, 6 waitingForData | sys, status |
| `bus` | Uint8Array | 0..31 | main |
| `world` | Uint8Array | World key (main-only, never sent to the core); voices of an inaudible World are forced virtual | main |
| `group` | Uint16Array | 0 = none; reserved for M2 event instances | main |
| `clip` | Uint32Array | clip registry id | main |
| `priority` | Uint8Array | 0..255 | main |
| `volume`, `pitch`, `fadeGain` | Float32Array | linear, ratio, linear | main |
| `minDist`, `maxDist` | Float32Array | m | main |
| `rolloff` | Uint8Array | 0 linear, 1 inverse, 2 exponential | main |
| `posX`, `posY`, `posZ` | Float32Array | world m | sys |
| `gain`, `dirX`, `dirY`, `dirZ`, `lpHz` | Float32Array | computed gain; listener-space unit direction; low-pass Hz | sys |
| `audibility` | Float32Array | `gain * (1 + priority/255)`: at most 2x | sys |
| `startFrame` | Float64Array | audio frame the PLAY was stamped for; 0 if asap | main |
| `playhead` | Uint32Array | clip frames, from status, only for `wantsPlayhead` | status |
| `epoch` | Uint32Array | stream seek epoch, incremented per seek | main |
| `owner` | Int32Array | index into `ownerRefs` (an `AudioSource`), or -1 | main |

Free list: `freeStack: Uint16Array(L)` plus `freeTop`; free pushes and bumps `gen`, skipping 0. A full table or a full bus (`maxVoices`) steals the lowest-priority, then lowest-audibility voice, unless every candidate has priority at or above the new sound's (then the new sound is refused with an inert handle). Bus limits apply before the global one.

**Handle encoding.** `id = (gen << 16 | index) >>> 0`; 0 is invalid. `AudioHandle` holds `id` and the table; each method checks `gen[index] === id >>> 16`. The same id is the `voiceId` in every command and status record; the core keeps `slotGen[index]` and drops commands whose generation differs.

**Mixer counting (0097/0098).** `CoreBackend` calls `mixer.voiceStarted(bus)` on play, `mixer.voiceEnded(bus)` on free (end, stop, steal, failed load) and both on `setBus`, as the Howler backend did (`howlerBackend.ts:30,38,72-74`), as `BabylonBackend` does, and as the fake in `audioBackend.test.ts:11` does. Ducking in `Mixer.update` (`mixer.ts:140-143`) is unchanged.

**Selection (`selection.ts`).** Per frame: compute `gain`, direction, `lpHz`, `audibility` for live voices; quickselect (O(L), no sort, no allocation) the top `min(configured, mixedCap)` (`mixedCap` from status); hysteresis 1.2x and a dwell of **3 frames** (selection runs per frame); emit SET_MIXED for changes and SET_PARAMS for mixed voices whose parameters moved more than epsilon (gain 0.001, direction 0.005 per component, pitch 1e-4, lp 1 Hz). Voices of an inaudible World are forced virtual.

**Status mirror (`mirror.ts`).** Written in the host's `onmessage` for every STATUS block (the buffer is returned at once, section 4.3): ended ids queue, peaks and counters take the newest, `minSlackFrames` takes the minimum since the last frame, `framePair {audioFrame, dateMs}` feeds the clock map. The per-frame system applies the queues; when the page is hidden, `onmessage` frees ended slots itself (architecture 3.8).

**Clip registry (`clipRegistry.ts`)**, keyed by asset path (no `asset:` prefix):

| Field | Type | Meaning |
|---|---|---|
| `id` | uint32 | slot id sent to the core (recycled with an 8-bit generation in the high bits to reject stale chunks) |
| `state` | enum | `idle, fetching, decoding, copying, ready, failed, unloading` (`copying -> ready` on the core's `resident` clip event, section 4.3) |
| `refs` | int | live voices + pending plays + holding Worlds |
| `frames, channels, sampleRate, format, bytes` | numbers | from decode; `bytes` for the ceiling |
| `holders` | Set of world keys | `releaseWorld(key)` drops one |
| `encoded` | Uint8Array or null | M1a: the encoded file, kept (up to 32 MB total, else refetched from the HTTP cache) so a rebuild can re-decode and resend; M1b: the worker re-decodes |

A voice on a non-ready clip exists at once (reason `waitingForData`) and starts when the clip is resident; its `at` is dropped if past. Unload happens when `refs` is 0 and no World holds the clip, deferred one frame.

**Bus state serialisation.** `mixer.resolveAll()` (`mixer.ts:217`) gives `ResolvedBus[]`, root first. Topology and effects go as BUS_CONFIG on `mixer.configure` and on effect edits; `gain` and `snapshotLowpass` go as BUS_MIX from `mixer.onChange` (`backend.ts:333`), once per frame. `effectiveGain` is not sent: the core multiplies down the tree. `Engine.ts:176` reconfigures the one mixer for each Engine (editor, play mode); a BUS_CONFIG while voices are live bumps `busEpoch` and the table remaps `bus` by name, unknown names to the root.

## 4. Binary formats

### 4.1 Envelope and kinds

Every message to or from the worklet is one `ArrayBuffer` with a 16-byte envelope:

| Off | Type | Field |
|---|---|---|
| 0 | u32 | magic `0x4D594131` |
| 4 | u16 | `version` (high byte major, low byte minor; 1.0) |
| 6 | u16 | `kind` |
| 8 | u32 | `seq` (per sender, wraps) |
| 12 | u32 | `bodyBytes` |

| Kind | Name | Direction | Body |
|---|---|---|---|
| 1 | BATCH | main to worklet | 4.2 |
| 2 | CLIP_BEGIN | main (M1a) or worker (M1b) to worklet | below |
| 3 | CLIP_CHUNK | same | below |
| 4 | CLIP_UNLOAD | main to worklet | `u32 clipId` |
| 5 | CLIP_CHUNK, HRIR | for `format = 2`, clip ids `0xFFFF0000..0xFFFF00FF` are reserved; the first chunk begins with a header `u32 elevations; u32 azimuths; u32 irLength; f32 rate;` then the per-direction ear-delay table `f32[elevations * azimuths * 2]`, then the int16 impulse responses. The core reports clip event code 4 `hrtfReady` when complete |
| STREAM_OPEN | worker to worklet | below |
| 6 | STREAM_CHUNK | worker to worklet | below |
| 7 | STREAM_CLOSE | main or worker to worklet | `u32 streamId` |
| 8 | TIME_PING | main to worklet | `u32 pingSeq` |
| 9 | STATUS | worklet to main | 4.3 |
| 10 | RECYCLE | main to worklet (a returned STATUS buffer; the transfer is the message) | none |
| 11 | STREAM_CREDIT | worklet to worker | `u32 streamId; u32 epoch; u32 consumedFrames; u32 returnedBuffers` (the buffers ride in the transfer list) |
| 12 | REPLAY | main to worklet | 4.2 |

A core refuses a different `version` major (counted, one STATUS flag) and skips an unknown `kind` or opcode of the same major (records carry their length). New opcodes or appended payload words are minor; changing a field's meaning is major.

| Kind | Body layout (word aligned) |
|---|---|
| CLIP_BEGIN | `u32 clipId; u32 frames; u32 channels; f32 sampleRate; u32 format (0 f32, 1 i16, 2 HRIR: int16, already at the context rate)` |
| CLIP_CHUNK | `u32 clipId; u32 frameOffset; u32 frames; u32 reserved;` then `frames * channels` interleaved samples |
| STREAM_OPEN | `u32 streamId; u32 channels; f32 sampleRate; u32 totalFrames (0xFFFFFFFF unknown); u32 loopStart; u32 loopEnd (0 whole); u32 flags (bit0 loop); u32 epoch; u32 startFrame` |
| STREAM_CHUNK | `u32 streamId; u32 chunkSeq; u32 frames; u32 flags (bit0 last, bit1 wrapped); u32 epoch;` then `frames * channels` f32 interleaved |

A decoder error is not a wire kind: the worker posts `{type:"error", streamId, asset, message}` to the main thread, which sends STOP with a 0.05 s fade and warns.

**Stream seek protocol (epochs).** Main picks `epoch = ++epoch[voice]`, then (1) posts `seek(streamId, frame, epoch)` to the worker and (2) sends a SEEK record carrying the same epoch in the next batch. The worker answers with STREAM_OPEN (that epoch, `startFrame`) and chunks tagged with it. On SEEK the core sets its expected epoch, fades out 5 ms, flushes the ring and **drops every chunk whose epoch differs** (returning those buffers through STREAM_CREDIT), then fades in on the first chunk of the new epoch. A chunk of an old epoch can never reach the ring.

### 4.2 Command batch (kind 1) and REPLAY (kind 12)

Body header, 16 B: `f64 firstFrame` (offset 0: the earliest absolute frame among the batch's stamped records, or the host's current estimate if none), `u32 count` (8), `u32 flags` (12: bit0 overflowed, bit1 first chunk, bit2 last chunk of a REPLAY). Records follow.

Record head, 12 B: `u16 opcode; u16 words` (total length in u32 words; lets old cores skip unknown records); `u32 voiceId` (voice, or bus index, or 0); `u32 frameOffset`. **`frameOffset = 0xFFFFFFFF` means asap**: apply on arrival at the next quantum, never counted late. Any other value is the frame after `firstFrame` at which to apply; if that frame is already past, apply at once and count it late. Only records with an explicit time (`at`, restamped replays) use stamped offsets.

| Op | Name | Payload | Total B |
|---|---|---|---|
| 0x01 | PLAY | `u32 clip; u16 bus; u16 flags (bit0 loop, bit1 stream, bit2 wantsPlayhead, bit3 mixed, bit4 spatial, bits5-6 `panner`: 0 equal-power, 1 HRTF, 2-3 reserved for M3's ambisonic bed; spatial voices only, ignored otherwise); u16 group; u16 reserved; f32 gain; f32 pitch; f32 dirX, dirY, dirZ; f32 lpHz; f32 score; u32 startOffsetFrames` | 12+44 = 56 |
| 0x02 | STOP | `u32 fadeFrames (0 now); u32 reason` | 20 |
| 0x03 | SET_PARAMS | `u32 mask (bit0 gain, 1 pitch, 2 dir, 3 lpHz, 4 score, 5 bus, 6 flags); f32 gain; f32 pitch; f32 dirX, dirY, dirZ; f32 lpHz; f32 score; u32 bus; u32 rampFrames; u32 flags` (only bits5-6, the `panner`, are read from `flags`; same positions as PLAY). The core crossfades 45 ms on a panner change | 12+44 = 56 |
| 0x04 | FADE | `f32 target; u32 frames; u32 flags (bit0 stop at end)` | 24 |
| 0x05 | SET_MIXED | `u32 mixed (0 virtual, 1 mixed); f32 gain; f32 dirX, dirY, dirZ; f32 lpHz` | 12+24 = 36 |
| 0x06 | SET_PAUSED | `u32 paused` | 16 |
| 0x07 | SEEK | `u32 clipFrame; u32 epoch` (streams: the epoch above; clips: 0) | 20 |
| 0x10 | BUS_CONFIG | `u32 busCount; per bus: u16 parent (0xFFFF root); u16 effectCount; per effect: u32 type (0 lowpass, 1 highpass, 2 compressor, 3 reverb send); f32 p[7]`. lp/hp: `p0 frequency, p1 q` where **q is in dB** (Web Audio convention; the core uses linear Q = 10^(q/20)); compressor: `threshold dB, knee dB, ratio, attack s, release s`; reverb: `send`. Unused p = 0 | 12+4+per bus (4 + 32*effects) |
| 0x11 | BUS_MIX | `u32 busCount; u32 rampFrames; per bus: f32 gain; f32 lpHz (24000 off)` | 12+8+8n |
| 0x12 | MASTER | `f32 volume; u32 muted; u32 rampFrames` | 24 |
| 0x20 | LISTENER | reserved for M3; not sent in M1 (the main thread sends listener-space directions) | |
| 0x30 | RESET | `u32 keepClips` (0 also resets the arena and slab classes; the first record of a rebuild's REPLAY) | 16 |

PLAY does not ramp: a clip starts at its gain. Only SET_PARAMS, FADE, BUS_MIX and MASTER ramp. `rampFrames` is chosen by the host (architecture 4.3).

**Sizing and carry-over.** 128 mixed voices of SET_PARAMS per frame is 7.2 KB; 1,024 is 57 KB. A BATCH is capped at 64 KB; excess records stay in the writer and go in the next batch **with their absolute frame preserved** (the next batch's `firstFrame` is their earliest stamp, asap records stay asap). Records are stable-sorted by frame by insertion sort.

**REPLAY (kind 12)** is a rebuild's state transfer: it has the same body as a BATCH, is never truncated or carried over, and may be split into several messages, each at most 1 MiB minus 32 bytes (the inbox), in order, with `flags` bit1 on the first and bit2 on the last. The first chunk begins with RESET. Records apply in arrival order at the next quantum (asap, or a stamped offset for an `at` still ahead). 4,096 voices at 56 B is 229 KB, one message.

### 4.3 STATUS (kind 9)

Posted every 6 quanta (every 48 when no batch has arrived for 250 ms), from `process()`. **The host copies each block into the mirror in `onmessage` and returns the buffer at once with RECYCLE** (never waiting for a frame). The shell holds a pool of **8** buffers of 16,384 bytes with a preallocated transfer-list array; if the pool is empty it skips the post (the core keeps its queues, the next block carries them). Header, 112 B (envelope included):

| Off | Type | Field |
|---|---|---|
| 16 | f64 | `currentFrame` after the last rendered quantum |
| 24 | f64 | `dateMs` (`Date.now()` at the post) |
| 32 | u32 | `pingSeq` echoed; 36 `u32 pingFrameLo` |
| 40 | u32 | `underruns` (cumulative, by the drift method, architecture 7) |
| 44 | u32 | `lateCommands` (cumulative) |
| 48 | u32 | `workUnits` (last quantum); 52 `u32 workUnitsMax` since the last block |
| 56 | u16 | `mixedVoices`; 58 `u16 liveVoices` |
| 60 | u32 | `flags`: bit0 version mismatch, 1 arena full, 2 inbox overflow, 3 adaptive cap active, 4 ready (init done), 5 trap caught |
| 64 | u16 | `endedCount`; 66 `u16 demotedCount` |
| 68 | u16 | `starvedCount`; 70 `u16 playheadCount` |
| 72 | u16 | `busCount`; 74 `u16 clipEventCount` |
| 76 | u16 | `streamEventCount`; 78 `u16 mixedCap` |
| 80 | u16 | `loadPermille` (0 = not measured; unmeasured in M1); 82 `u16 traps` |
| 84 | i32 | `minSlackFrames` (minimum since the last block) |
| 88 | u32 | `underrunFrames`; 92 `u32 arenaUsedKB` |
| 96 | u32 | `arenaLargestFreeKB`; 100 `u32 abiVersion` (first block only, else 0) |
| 104 | u32 | `maxLatenessFrames`; 108 `u16 hrtfVoices` (voices rendered with HRTF), 110 `u16 hrtfLoadFailure` (0 none, 1 fetch, 2 data) |

Sections in order: `ended u32[]`, `demoted u32[]` (virtualised by the adaptive cap), `starved u32[]` (each at most 1,024 per block, the rest carried), `playheads {u32 id; u32 clipFrame}[]` (at most 256, round-robin), `clipEvents {u32 clipId; u32 code}[]` (code 1 resident, 2 refusedCeiling, 3 refusedGrow, 4 hrtfReady; at most 64), `streamEvents {u32 id; u32 code}[]` (1 starved, 2 eos, 3 error; at most 64), `peaks {f32 l; f32 r}[busCount]`. Worst case 112 + 4,096 x 3 + 2,048 + 512 + 512 + 256 = 15,728 bytes. `wantsPlayhead` voices are loops, streams and clips over 5 s.

### 4.4 One definition for Rust and TypeScript

The schema is data in `audio-wire/src/schema.rs` (envelope, records, status offsets, enums, constants). `cargo run -p audio-wire --bin gen_wire` writes `src/plugins/audio/runtime/wire.generated.ts` (constants, offsets, packers, `readStatus`) and `native/audio/vectors/wire.json` (a golden byte string per record). `build:audio` runs it; outputs are committed. The generated TS embeds the schema hash; the wasm exports `myco_audio_schema_hash()`; a test fails on mismatch. **Round-trip test** (`wire.roundtrip.test.ts`, Node): pack each record in TS and compare bytes with `wire.json`; feed batches to the `test-hooks` wasm's `myco_audio_debug_decode_batch` and compare decoded values; fuzz 1,000 random batches (truncated, oversize and unknown records refused without out-of-bounds reads); REPLAY chunking and asap sentinel cases. `cargo test` in `audio-wire` uses the same vectors.

## 5. Rust crate layout (`native/audio/`)

Workspace, resolver 2, edition 2021, Apache-2.0 OR MIT, release profile as `native/nav/Cargo.toml:25-34` (opt 3, lto, one codegen unit, `panic = "abort"`, dev too). `native/audio/rust-toolchain.toml` pins stable (exact version at A0.1) with the wasm target.

| Crate | Content |
|---|---|
| `audio-wire` | `schema.rs`, generated readers, `gen_wire`, vectors |
| `audio-dsp` | Ports from Chromium (below): `biquad`, `compressor`, `convolver`, `pan` (equal-power), `hrtf`. Written here: `resample` (linear, then the M1a.3 choice), `ramp`, `limiter`, `meter`, `workunits`. FFT from the `microfft` crate. Uses `libm` for transcendentals so native and wasm are bit-identical |
| `audio-core` | `Core`: voice slots, bus tree, slab arena, scheduler, command and REPLAY apply, status writer, adaptive cap. No I/O, no globals |
| `audio-wasm` | `cdylib`: the ABI, static inbox and status buffers, `build.rs` source hash |
| `audio-decode` (M1b) | `cdylib` `myco_audio_decode.wasm`: symphonia 0.6.1, feature `aac`; own ABI |
| `audio-bench` | native benches printing work units (informational until the metered build, task C1b) |

**Ports and dependencies.** Each ported file keeps Chromium's BSD-3-Clause copyright notice and an SPDX header naming the upstream path and commit; `native/audio/PORTS.md` lists them, and `THIRD_PARTY_NOTICES.md` gets an entry (task A0.10). The `audio-dsp` licence expression is `(Apache-2.0 OR MIT) AND BSD-3-Clause`. Upstream is `third_party/blink/renderer/platform/audio/`.

| Upstream (Chromium Blink) | Rust module | Used by |
|---|---|---|
| `biquad.cc` (filters; Q in dB) | `biquad` | A2.2a |
| `dynamics_compressor.cc` (makeup gain, knee, adaptive release, pre-delay) | `compressor` | A2.2a |
| `reverb_convolver`, `fft_convolver` (staged non-uniform) | `convolver` | A2.2b |
| `equal_power_panner` | `pan` | A1.2 |
| `distance_effect`, `cone_effect` | `runtime/core/spatial.ts` (main thread, TypeScript; the cone is ported but unused until `AudioSource` gains cone fields) | A1.5 |
| `hrtf_panner`, `hrtf_kernel`, `hrtf_elevation`, `hrtf_database` and the Composite HRIR data | `hrtf`: Chromium's interpolation, interaural delay and two-kernel crossfade are kept; the convolution is re-done in uniform 128-frame partitions on `microfft`'s 256-point FFT (not Chromium's 512 in 256-frame blocks); kernels are computed on a direction change, at most 4 per quantum. Output matches Chromium to float rounding, not bit-exactly | H1, H2 |

| Dependency | Licence | Notes |
|---|---|---|
| `microfft` | MIT | real FFTs of 256 and 4,096 points and the complex 4,096 inverse: 14 KB of wasm (built by the coordinator); replaces the hand-written FFT planned for A2.2b |
| `libm` | MIT/Apache-2.0 | |
| symphonia 0.6.1 (M1b) | MPL-2.0 | file-level, as the ADR says |

Borrowed as designs only, no code: Kira (command queue, clocks, tweens), Firewheel (processor and context split, pools), SoLoud (virtual voices).

**Wasm size.** The spike mixer was 55 KB. The ports (compressor, convolver, HRTF code) plus microfft's 14 KB should land near 110-130 KB (estimate). The 150 KB gate is checked at A2.2b and H1; if HRTF breaks it, `hrtf` moves to a lazily loaded second module `myco_audio_spatial.wasm` sharing the imported memory (one reason memory is imported). The HRIR data is not in the wasm: it ships as a lazily fetched engine asset beside the wasm (about 0.75 MB as int16, per the architect), sent with CLIP_BEGIN/CLIP_CHUNK `format = 2` into a region of its own, **not counted against `clipMemoryMB`**. The loader (M1a) or the worker (M1b) resamples and converts it to the context rate, and it is re-sent on a rebuild. Voices use equal-power until `hrtfReady`.

**Arena.** Size-class slabs, no compaction: 4 classes per power of two from 4 KB (internal waste at most 25%, about 12% on average), a free list per class, whole slabs returned on unload; a failed class allocation grows the arena (in `onmessage` only) up to the ceiling. `RESET 0` between editor play sessions returns everything. Architecture 5.2 has the policy and its limits.

**C ABI** (all `#[no_mangle] pub extern "C"`; `i32` results: 0 ok, negative codes in `schema.rs`). Memory is **imported** (`--import-memory`; the shell creates `WebAssembly.Memory({initial, maximum})`, maximum = the fixed regions plus the clip ceiling, architecture 5.1); linker stack 256 KB.

| Export | Signature | Notes |
|---|---|---|
| `myco_audio_abi_version` | `() -> u32` | `(major << 8) | minor` |
| `myco_audio_schema_hash`, `myco_audio_source_hash` | `() -> *const u8` | 16 bytes each |
| `myco_audio_init` | `(sample_rate: f32, max_logical: u32, max_mixed: u32, max_buses: u32, arena_initial_bytes: u32) -> i32` | **deterministic**: allocates in a fixed order, so a fresh instance lands on the same addresses (a test asserts the addresses; post-M1 soft recovery needs it). May grow memory |
| `myco_audio_inbox_ptr`, `_cap` | `() -> *mut u8`, `() -> u32` | fixed 1 MiB, holds BATCH, REPLAY and small control messages |
| `myco_audio_submit` | `(len: u32) -> i32` | parses the inbox message; never inside `process` |
| `myco_audio_clip_reserve` | `(clip: u32, frames: u32, channels: u32, src_rate: f32, format: u32) -> i32` | `onmessage` only; may grow |
| `myco_audio_clip_chunk_ptr` | `(clip: u32, frame_offset: u32, bytes: u32) -> *mut u8` | the shell copies straight from the transferred buffer (one copy), at most 256 KB per quantum, then: |
| `myco_audio_clip_commit` | `(clip: u32, frame_offset: u32, bytes: u32) -> i32` | marks the range written; the last range emits a `resident` clip event |
| `myco_audio_clip_write` | `(clip: u32, frame_offset: u32, len: u32) -> i32` | copies from the inbox; tests only |
| `myco_audio_clip_free` | `(clip: u32) -> i32` | |
| `myco_audio_stream_chunk_ptr`, `_commit` | `(stream: u32, frames: u32) -> *mut u8`, `(stream: u32, frames: u32, epoch: u32, flags: u32) -> i32` | M1b: into the stream ring (32,768 frames); a stale `epoch` is dropped |
| `myco_audio_process` | `(frame_lo: u32, frame_hi: u32) -> *const f32` | exactly 128 frames, planar stereo `[L;128][R;128]`; never allocates or grows |
| `myco_audio_status_take` | `() -> u32` | writes the STATUS body at `status_ptr`, returns bytes |
| `myco_audio_status_ptr` | `() -> *const u8` | |
| `myco_audio_work_units` | `() -> u32` | |
| `myco_audio_dispose` | `() -> void` | drops state for tests; a rebuild makes a new global scope and reuses nothing |
| `myco_audio_debug_decode_batch` | `(len: u32) -> u32` | `test-hooks` feature only |

**Ownership.** wasm owns every buffer; JS views only the inbox, status and output pointers and re-creates views after `init`, `clip_reserve` and `stream_open` (growth detaches them; spike `processor.js:35`). Nothing in `process()` pushes past a preallocated capacity; a test runs 1,000 quanta of the stress scenario and asserts `memory.buffer.byteLength` is unchanged and the stack high-water mark is under 128 KB. `panic = "abort"` makes a panic a trap. **Trap handling in M1:** the shell wraps `process` in `try`, outputs silence for that quantum, flags `trap caught` and tells the host, which performs a **hard rebuild** (new node and core in the same context, REPLAY, clips re-sent from the main-side registry). `myco_audio_adopt_arena` and soft recovery are deferred after M1 (the deterministic init and imported memory keep the door open).

**Source hash.** `build.rs` hashes (SHA-256, first 16 bytes) the sorted bytes of every `*.rs`, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` under `native/audio/` (not `target/`, `vectors/`, `tests/`), embeds it, and `wasm/hash.json` records it. `sourceHash.test.ts` recomputes it with `node:crypto` and fails with "run `npm run build:audio`" (skipped when `native/audio` is absent).

**`npm run build:audio`** (`native/audio/build.mjs`, modelled on `native/nav/build.mjs` without the wasm-bindgen steps): checks the toolchain; runs `gen_wire`; builds `audio-wasm` for `wasm32-unknown-unknown` with `RUSTFLAGS="-C target-feature=+simd128 -C link-arg=--import-memory"`; builds the `test-hooks` wasm into `tests/`; copies `myco_audio.wasm` (and `myco_audio_decode.wasm` from M1b) to `src/plugins/audio/runtime/wasm/`; writes `hash.json`; fails above 150 KB (mixer) or 900 KB (decoder); runs `wasm-opt` if present. From task C1b it also emits the metered test wasm. Script: `"build:audio": "node native/audio/build.mjs"` beside `build:nav` (`package.json:24`).

## 6. TypeScript module and file layout

```
src/plugins/audio/
  manifest.ts                      "myco.audio" (add to manifests.ts, runtime.ts, editorPlugins.ts)
  runtime/
    index.ts                       audioRuntimePlugin + public exports; registers components, the audio system and the `myco.audio` World service
    Audio.ts AudioSource.ts AudioListener.ts audioSystem.ts backend.ts babylonBackend.ts
    core/ service.ts coreBackend.ts voiceTable.ts selection.ts clipRegistry.ts commandWriter.ts
          statusReader.ts mirror.ts clock.ts hostClock.ts unlock.ts loader.ts context.ts bufferPool.ts recovery.ts
    worklet/ processor.ts coreDriver.ts     (coreDriver shared with Node tests)
    decoder/ decoder.worker.ts decoderClient.ts     (M1b)
    wire.generated.ts testing.ts            (fake backend and loopback host: @internal)
    wasm/ myco_audio.wasm myco_audio_decode.wasm hash.json
  editor/ index.ts AudioSettingsSection.tsx audioSettingsModel.ts BusMeters.tsx AudioDebugPanel.tsx audioSettings.css
```

- **The host** (architecture section 1) is created by `service.ts`, the `myco.audio` World service's lazy `load` (dynamic import): servers and headless Worlds never load the core, so "servers never load the core" holds. One host per page serves every Engine and World.
- **Stays in `src/engine/audio/`:** `settings.ts`, `mixer.ts` (with `export const mixer` moved from `backend.ts:316`, so `Engine.ts:176` works without importing the plugin), and nothing else: `busGraph.ts` leaves with `BabylonBackend` (below).
- **Moves:** `AudioSource.ts`, `AudioListener.ts`, `backend.ts`. `howlerBackend.ts` does not move; it is deleted. Component ids unchanged; `activate` calls `registerComponents`, `registerEngineSystems`, `registerWorldService`.
- **Deleted in M1a.0:** `fmodBackend.ts`, `tests/fmodBackend.test.ts`, `docs/guide/fmod.md`, `Engine.ts:13,177`, `fmod` settings and editor model parts. **With `BabylonBackend` (task BB2), not M1c:** `howlerBackend.ts` and the `howler` dependency (`package.json:55,68`, `vite.engine.config.ts:56`). Babylon exposes a bus's Web Audio nodes only through the underscore-prefixed `_inNode`/`_outNode` (`@babylonjs/core/AudioV2/webAudio/webAudioBus.d.ts:21-23`), internals we won't hang effects on, so the fallback runs without effects and `busGraph.ts` is **moved**, not reused, to `src/plugins/audio/testing/webAudioReference.ts`, a test-only reference graph for the parity spec outside the engine bundle. `BabylonBackend` imports Babylon module by module (`@babylonjs/core/AudioV2/...`, CLAUDE.md) and lazily.
- **Re-exports.** `src/engine/index.ts:51-53` lose audio; `src/myco.ts` gains (as navigation, lines 175-198) `Audio, AudioSource, AudioListener, type AudioHandle, type AudioStatus, type AudioReason, type AudioDebugInfo, type OneShotOptions, type Rolloff, type Bus`. Tests importing from `"../index"` (`audioBackend.test.ts:2`, `spatialAudio.test.ts:35`) import the plugin and activate it via `src/plugins/testSetup.ts`.
- **`AudioBackend` changes** (`backend.ts:299-313`): `PlayRequest +volume, pitch, priority, oneShot, at?, attenuation?, position?`; `AudioVoice +id, reason, fade(to, seconds), setPriority(p), stop(fadeSeconds?)`; `AudioBackend +status, time, debug(), setBackground(mode)`, `update(dt)` required. `BabylonBackend` implements them minimally (status `running`, `reason` null, priority ignored, per-sound `maxInstances` for limits (only roughly `maxVoices`), `time` from the engine's context). It maps buses to `AudioBus` (parent through `outBus`), applies `Mixer` snapshot and ducking gains as bus volumes in `applyMix`, uses `StaticSound` (and `StreamingSound` for `stream` clips), the sound's spatial panner (distance model, min/max, rolloff) and stereo pan, and Babylon's unlock and unmute. The core backend registers as the alternative; `audio.backend` picks. It is internal behind 0098 and never in the public API (0010).
- **Frame time hook (C10).** `audioSystem.ts` reads the frame's rAF time through an `@internal` `Engine` accessor, falling back to `performance.now()` in headless and tests.
- **`HostClock`** (`hostClock.ts`): an interface over rAF time, `getOutputTimestamp`, `Date.now`. The host, clock map and the shell's underrun logic take it, so tests inject a fake. Calibration-like estimators are disabled under the fake clock.
- **Fakes.** One `makeFakeBackend()` in `testing.ts` replaces `audioBackend.test.ts:6-17` and the Howler mock (`spatialAudio.test.ts:4-31`); `createLoopbackHost()` runs the real wasm in Node with `renderQuanta(n)`, delivering STATUS synchronously after its quanta and taking time from the injected `HostClock`.

## 7. Editor integration (M1)

| Change | Files |
|---|---|
| Project Settings > Audio moves into the plugin via `registerProjectSettingsSection` (as `navigation/editor/index.ts:35-41`); `src/editor/ui/AudioSettingsSection.tsx` and `src/editor/audioSettingsModel.ts` move; `projectSettingsModel.ts:6` keeps `parseAudioSettings` | `plugins/audio/editor/*` |
| New controls: `maxVoices`, voices preset and numbers, `background`, `clipMemoryMB`, `clipFormat`, `codecs.aac`, `backend` (babylon/core), `spatial`, `voices.hrtf`; fmod removed | `AudioSettingsSection.tsx`, model: `setBusMaxVoices`, `setVoices`, `setBackground`, `setClipMemory`, `setCodec` |
| Bus meters from `Bus.peak` during play; an underruns `registerPlayStatsCounter` | `BusMeters.tsx`, `editor/index.ts` |
| `Audio.debug()` panel via `registerPanel` | `AudioDebugPanel.tsx` |
| Registration | `src/plugins/editorPlugins.ts` |

Play and stop (architecture 3.9): stop calls `releaseWorld` and `RESET 0` when no World holds clips; the context and core stay for the page.

## 8. Test plan

| Layer | What | Where | Docker |
|---|---|---|---|
| Unit (cargo) | biquad against analytic response (Q in dB), resampler, ramp, direction to pan, compressor static curve, convolver against direct convolution, command parse refusal, scheduler order, late and asap, stale-id drop, slab alloc/free, adaptive cap, deterministic init addresses | `native/audio/crates/*/tests` | No |
| Wire | round trip, schema hash, source hash | `wire.roundtrip.test.ts`, `sourceHash.test.ts` | No |
| Golden (Vitest, Node) | `coreDriver.ts` loads the wasm by `readFile(new URL(...))` and `new WebAssembly.Instance` (as `src/engine/nav/loader.ts:25-30`), plays scripted scenarios, renders N quanta, compares SHA-256 of the f32 bytes plus RMS and peak. Exact across wasm engines (once proven in Chromium); `libm` makes native match too, with an absolute 1e-6 fallback tolerance | `audioGolden.test.ts`, `golden/` | No |
| Web Audio parity | the same scenes rendered by an `OfflineAudioContext` with the reference graph (`testing/webAudioReference.ts`, the old `busGraph.ts`) in Chromium, compared with the core within the ADR's dB tolerance: lowpass/highpass sweeps (Q in dB), the compressor on tones and noise (static curve, makeup, pre-delay), the reverb send (energy decay), pan law, HRTF against `PannerNode` with `panningModel: "HRTF"` (Composite set) at fixed directions as null tests, plus a moving-source golden that crosses a panner-kind change | `@slow` Playwright spec `audio-parity.spec.ts`; reference renders committed for Node | WebKit and Firefox runs: yes |
| Objective quality | resampler THD+N and alias level (thresholds set at M1a.3, then ratcheted), unity null (< -120 dBFS), pan power constant within 0.01 dB, limiter at or below 0 dBFS, preset loudness | `audio-dsp/tests/quality.rs` | No |
| Babylon backend | `BabylonBackend` against mocked `@babylonjs/core/AudioV2` modules (as the old Howler mock): bus mapping, snapshot and ducking gains on bus volumes, spatial attributes, `maxInstances`, unlock; a `@slow` spec plays sound-lab with `backend: "babylon"` in Chromium | `babylonBackend.test.ts`, `audio-babylon.spec.ts` | WebKit and Firefox: yes |
| Ports | each ported DSP module against reference values taken from Chromium's own unit data or an `OfflineAudioContext` render, within float tolerance; header check that every ported file carries its notice | `audio-dsp/tests/ports.rs`, `portsNotices.test.ts` | No |
| Fake backend | handle semantics, priority, limits, locked queue, `at` and asap, mirror staleness, `activeVoices` counts all live voices, `voiceStarted/Ended` pairing, ducking from the mirror | `audioBackend.test.ts`, `spatialAudio.test.ts`, `audioHandle.test.ts` | No |
| Loopback | real wasm, fake `HostClock`: an `AudioSource` plays a generated WAV, ends reach `playing = false`, virtual voices promote, REPLAY restores voices, seek epoch drops old chunks, status buffers return at once (no starvation at 20 Hz frames or hidden) | `audioLoopback.test.ts` | No |
| `@slow` Playwright | `audio-core.spec.ts`: sound-lab through the real worklet (or an offline render of the same processor), levels, no underruns, `Audio.debug()` shape | Chromium default | WebKit and Firefox: yes |
| Platform smoke | `tauri:dev` on Windows (WebView2) and a WebKitGTK build play the A0.3 tone, with the autoplay policy per webview, and play mode's second Engine shares the host (task A0.7) | scripted where possible, results logged | No (real machines) |
| Soak | stress sample 30 min, zero underruns (ADR gate) | `samples/stress`, results in the review log | No |

Samples: `samples/sound-lab` (M1a.2) and `samples/stress`. `flappy` and `pirates` load on the loopback host with no warnings and a non-silent render. Benchmarks: `audio-bench` work-unit totals are **informational** until task C1b (the metered build) turns the 10% gate on.

## 9. M1 task breakdown

Level: S senior, M mid, J junior. Days are focused effort. `||` marks tasks parallel to others in the iteration given their dependencies. Ports from Chromium (section 5) keep their notices.

| ID | Task (files) | Dep | Who | Days | Acceptance |
|---|---|---|---|---|---|
| **M1a.0** | | | | | |
| H0 | **Clear the HRIR data licence** `||` (first, from day 1): IRCAM Listen "IRC_Composite_C" terms ("public and available for any use", with acknowledgement) against Chromium's processed `Composite.flac`, which ships with no licence file; write to the rights holders if needed; decide: Composite, or SADIE II (Apache-2.0) on the same panner, or equal-power | | M | 2 | A written decision with the licence text and the acknowledgement wording for `THIRD_PARTY_NOTICES.md` |
| A0.1 | Workspace, toolchain, `audio-core` skeleton, `audio-wasm` ABI with imported memory and deterministic init, `build.rs` hash, `build.mjs`, `build:audio`, `microfft` in the workspace | | S | 3 | 150 KB gate; `cargo test`; init addresses stable |
| A0.2 | `audio-wire`: schema, generator, vectors, REPLAY, `panner` flags, HRIR format, round-trip and hash tests `||` | A0.1 | M | 3 | tests pass; stale wasm fails `npm test` |
| A0.3 | Loader, worklet shell and `coreDriver`, context, unlock, STATUS with immediate RECYCLE and a pool of 8, `bufferPool` | A0.1 | S | 3 | tone after a click; ping echoed; status flows with frames stopped |
| A0.4 | Plugin shell: manifest, activation, moves, `mixer` singleton, `myco.ts`, lists, `audio.backend` selector (`babylon`/`core`, `howler` mapped with a problem) `||` | A0.1 | M | 3 | `npm test`, typecheck green |
| A0.5 | Remove FMOD | A0.4 | J | 1 | no "fmod" in `src/` |
| A0.6 | Minimum versions: feature probes, refusal message and the Babylon fallback trigger, doc; suspended-context `addModule` check in WebKit and Firefox | A0.3 | M | 2 | one clear warning on a stubbed old engine, then fallback |
| A0.7 | WebView2 and WebKitGTK smoke: `tauri:dev` and a WebKitGTK build play the tone; autoplay policy per webview; second Engine shares the host | A0.3 | M | 3 | tone audible in both; findings logged |
| A0.8 | Host and World-service lifecycle across two Engines, `releaseWorld`, `Engine.ts:176` reconfigure with live voices | A0.4 | S | 3 | play, stop, replay cycles keep one context; voices remap |
| A0.9 | Unlock re-arm after `interrupted` and resume failure | A0.3 | M | 1 | simulated interrupt re-arms the listener |
| A0.10 | Ports intake `||`: copy the Blink files to a `third_party/` staging folder with provenance, `native/audio/PORTS.md`, SPDX headers, `THIRD_PARTY_NOTICES.md` entries (BSD-3-Clause, microfft, libm) | A0.1 | J | 1 | every ported file has its notice; CI check greps for headers |
| **M1a.1** | | | | | |
| A1.1 | Voice table, ids, `AudioHandle`, mirror with `onmessage` apply | A0.4 | S | 3 | generation tests; no per-frame allocation |
| A1.2 | Core voices: PLAY/STOP/SET_PARAMS/FADE, slots, linear resampler, ramps, loop, **port of `equal_power_panner`** from the direction, asap vs stamped `||` | A0.1, A0.2, A0.10 | S | 3 | goldens: one-shot, pitch, loop, moving source; pan matches Blink's values |
| A1.3a | Clip registry, `decodeAudioData` loader, int16 conversion, paced chunks, encoded-bytes cache | A1.1 | M | 3 | clip loads; refcounts |
| A1.3b | Slab arena in the core, `chunk_ptr/commit`, clip events, ceiling refusal | A1.2 | S | 3 | resident event; refused load warns; reset reclaims |
| A1.4 | Command writer, status reader, `coreBackend` (incl. `mixer.voiceStarted/Ended`), clock map v1 | A1.1, A1.2 | M | 3 | loopback plays a WAV |
| A1.5 | Distance and cone on main: port of `distance_effect` and `cone_effect` to `spatial.ts`, listener-space direction | A1.1, A0.10 | M | 1 | `spatialAudio` tests ported; values match Blink's |
| A1.6 | API surface, locked queue (one-shots 32 / 1 s; AudioSource and loops wait), warnings | A1.4 | M | 3 | each row of section 1 tested |
| A1.7 | `testing.ts` fakes, `HostClock`, loopback host, rewrite of `audioBackend`/`spatialAudio` tests | A1.1 | M | 3 | tests green on fake and loopback |
| BB1 | **`BabylonBackend`**: `AudioEngineV2` created lazily with module-by-module imports; buses to `AudioBus`; `StaticSound`/`StreamingSound`; volume, pitch, stereo pan; spatial panner (distance models, min/max, rolloff) and listener; `maxInstances`; runs on the host's `AudioContext` with Babylon's `resumeOnInteraction` and `resumeOnPause` off and its unmute UI disabled (the host's unlock layer stays in charge); implements the new `AudioBackend` members minimally; effects not supported (documented) | A0.4, A1.6 | M | 4 | the `audioBackend` and `spatialAudio` suites run against it with Babylon mocked; plays in a browser with `backend: "babylon"` |
| BB2 | Snapshot and ducking gains onto bus volumes through `applyMix`, counters, `busGraph.ts` moved to `testing/webAudioReference.ts`, **delete `howlerBackend.ts` and the `howler` dependency**, default backend `babylon`, guide text on the fallback's limits | BB1 | M | 3 | `npm run build` green with no Howler; `audioMixer.test.ts` ducking passes; flappy and pirates play |
| **M1a.2** | | | | | |
| A2.1 | Core buses: tree, ramps, BUS_CONFIG/MIX, meters | A1.2 | S | 3 | duck and snapshot goldens |
| A2.2a | **Ports** of `biquad.cc` (Q in dB) and `dynamics_compressor.cc` (makeup gain, knee, adaptive release, pre-delay) | A2.1, A0.10 | S | 2 | sweeps and compressor curve equal Blink's reference values to float tolerance |
| A2.2b | **Port** of `reverb_convolver`/`fft_convolver` on `microfft`, seeded generated IR, shared return | A2.1, A0.10 | S | 3 | matches direct convolution to 1e-6; at most 0.1 ms average and 0.35 ms p99.9 per quantum; wasm at most 150 KB |
| A2.2c | Web Audio parity harness (`OfflineAudioContext` references; tuning is small because the ports match by construction) `||` | A2.2a | M | 2 | the parity spec passes |
| A2.3 | Ducking from mirror counts (all live voices), `Bus.peak` | A2.1 | M | 2 | `audioMixer.test.ts` ducking cases unchanged |
| A2.4 | Editor settings section and meters `||` | A2.1 | M | 3 | model tests green |
| A2.5 | `Audio.debug()` and panel | A2.1 | J | 2 | panel lists voices and reasons |
| A2.6 | `samples/sound-lab` and the `@slow` spec | A2.2a | M | 3 | spec passes |
| A2.7 | Quality harness and golden runner `||` | A2.2a | M | 3 | CI runs them |
| **M1a.3** | | | | | |
| A3.1 | Selection: audibility, quickselect, hysteresis, dwell, priority steal, `maxVoices`, inaudible Worlds | A1.1 | S | 3 | 4,096 voices at most 0.25 ms p99 in Node |
| A3.2 | Clock and `at`: map, lookahead (stamped records only), `getOutputTimestamp`, late counting | A1.4 | S | 3 | `at` lands within one quantum in loopback |
| A3.3 | Adaptive cap: modelled work-unit ceiling plus underrun, late and `minSlackFrames` feedback; `mixedCap` in status | A3.1 | S | 3 | cap drops and recovers in a loaded loopback |
| A3.4a | Hard rebuild: trap catch, new node, REPLAY chunked, clips re-sent from the registry, 3 per 60 s, then silent `"failed"` (no mid-session switch) | A3.1, A1.3b | S | 3 | simulated trap restores voices; the 4th goes silent with one warning |
| A3.4b | Background modes, `devicechange` classification, hidden-tab behaviour `||` | A3.1 | M | 3 | mute, pause, play verified; ends freed hidden |
| A3.5 | Re-measure: 4-point resampler, 64 MB of clips, pitch up to 16x cost, HRTF cost, freeze budgets | A3.3, H3 | S | 2 | table frozen in architecture |
| H1 | **Port of the HRTF panner** (`hrtf_panner`, `hrtf_kernel`, `hrtf_elevation`, `hrtf_database`) to `audio-dsp/hrtf`: Chromium's interpolation, interaural delay and two-kernel crossfade, uniform 128-frame partitions on `microfft`'s 256-point FFT, kernels on direction change (at most 4 per quantum) | A1.2, A0.10 | S | 5 | output matches Chromium on fixed azimuth/elevation sweeps to float rounding (not bit-exact); size gate checked (lazy `myco_audio_spatial.wasm` if over) |
| H2 | HRIR asset: convert the cleared dataset to the int16 blob at about 0.75 MB, ship it as a lazily fetched asset beside the wasm, `format = 2` load by the loader (M1a) or worker (M1b) with resampling, header and ear-delay table, `hrtfReady` event, re-send on rebuild, state its final size, attribution in the guide and notices | H0, H1 | M | 3 | `hrtfReady` after the first spatial play; voices equal-power until then; not counted in `clipMemoryMB` |
| H3 | Integration: top `voices.hrtf` spatial voices by audibility get `panner = 1` from main with 1.2x hysteresis (SET_PARAMS `flags`), core 45 ms crossfade, `hrtfVoices` and `hrtfLoadFailure` counters in STATUS and `Audio.debug()`, `audio.spatial` and `voices.hrtf` parse and editor controls | A3.1, H2 | S | 3 | at most `voices.hrtf` HRTF voices; no clicks across a change; cost in budget |
| H4 | HRTF parity and quality: null tests against `OfflineAudioContext` with `panningModel: "HRTF"` (Composite set), ITD and level checks, and a moving-source golden crossing a panner-kind change | H3, A2.2c | M | 3 | within the ADR's dB tolerance on fixed directions; golden digest stable |
| **M1b** | | | | | |
| B1 | `audio-decode` and ABI, size gates | A0.1 | S | 3 | decodes the fixtures; at most 900 KB |
| B2 | Decoder worker and client, clip decode off main | B1 | M | 3 | clips decode on the worker |
| B3 | Streaming: STREAM_OPEN/CHUNK/CREDIT, ring, waiting state, starvation | B1, B2 | S | 3 | zero underruns under a 300 ms main stall |
| B3b | Seek epochs: flush, stale chunk drop, tests | B3 | M | 2 | no old audio after a seek |
| B4 | Gapless loops, AAC opt-in, unknown-codec warning | B3 | M | 3 | loop golden bit-exact across the seam |
| B5 | Worker-sourced clips including unknown-length MP3s (decode whole, then send) | B2 | M | 2 | VBR MP3 without a header loads |
| B6 | Remove `decodeAudioData` from the core path; sidecar `stream` semantics; guide | B5 | M | 2 | none left in `src/plugins/audio/runtime/core` |
| B7 | Default `backend` to `core` | B6 | J | 1 | samples run on core |
| **M1c** | | | | | |
| C1 | Stress sample and informational benches | A3.5 | M | 3 | runs |
| C1b | Metered wasm build and the 10% CI gate | C1 | S | 3 | CI fails on +10% |
| C2 | Docs ("Playing sound", "Why is there no sound?", contributor note), `implementation-status.md`, notices review | B7 | J | 2 | links resolve |
| C3 | Soak runs on the gate machines: Windows (WebView2, Chromium), Linux (WebKitGTK), and the low-end Android phone (lowest Android version Google Play accepts; web build in Chrome/WebView), sizing the "low" preset from it | C1 | M | 3 | 0 underruns; low preset numbers recorded |
| C4 | Listening-pass checklist and objective thresholds; the owner runs the listening pass | A2.7 | S | 3 | checklist signed by the owner |

**Totals.** Senior 60 days, mid 74, junior 7: **141 days**. The named **10% quirk reserve is 14 days**, giving **155 person-days, 31.0 person-weeks**. Senior load, 66 days with its share of the reserve, is the constraint: with one senior, two mid and one junior the calendar is roughly 15-17 weeks (estimate). The ADR estimates 16-18 person-weeks for one engineer; the owner accepted the larger figure. Porting C++ to Rust has its own risk (Blink's helpers around `AudioBus` and `VectorMath` come along); the port estimates are the savings the coordinator verified in part, and an overrun is a first call on the reserve.

**Delta against the previous 136-day plan** (124 days plus a 12-day reserve):

| Line | Change | Days |
|---|---|---|
| A2.2a filters and compressor | ports of `biquad.cc` and `dynamics_compressor.cc`: 3 to 2 (S) | -1 |
| A2.2b convolver | `microfft` and the staged-convolver port replace the hand-written FFT: 5 to 3 (S) | -2 |
| A2.2c parity harness | tuning shrinks, ports match by construction: 3 to 2 (M) | -1 |
| A1.5 distance and cone | ports of `distance_effect` and `cone_effect`: 2 to 1 (M) | -1 |
| A0.10 ports intake | notices, `PORTS.md`, provenance (J) | +1 |
| A1.8 HRTF row and guide text | replaced by H0 to H4 (J) | -1 |
| H0 data licence | (M) | +2 |
| H1 HRTF panner port | (S) | +5 |
| H2 HRIR asset and loader | (M) | +3 |
| H3 integration and setting | (S) | +3 |
| H4 HRTF parity and quality | (M) | +3 |
| BB1 `BabylonBackend` | (M) | +4 |
| BB2 mixer gains, Howler and `busGraph` removal | (M) | +3 |
| C5 Howler deletion | folded into BB2, gate on "one release after" dropped (J) | -1 |
| **Task subtotal** | 124 to 141 | **+17** |
| Reserve (10%) | 12 to 14 | +2 |
| **Total** | 136 to 155 days; 27.2 to 31.0 person-weeks | **+19** |

Parallel groups: A0.1 then {A0.2, A0.3, A0.4, A0.10}, with H0 from day 1; {A1.1, A1.2} then {A1.3a, A1.3b, A1.4, A1.5}; BB1 and BB2 once A1.6 lands; A2.1 then {A2.2a, A2.2b, A2.3, A2.4, A2.5}; {A3.1, A3.2}; H1 can start once A1.2 and A0.10 land; B1 can start during M1a.3. Critical path: A0.1, A0.3, A0.7, A1.2, A1.3b, A2.1, A2.2b, A3.1, H3, A3.4a, B1, B3, C3. A0.7 gates M1a.1.

## 10. Resolutions and decisions

**Architect's round-2 review, item by item**

| Item | Resolution |
|---|---|
| C1 imported memory, re-init | Done in M1 (section 5): imported memory, deterministic init. `adopt_arena` and soft recovery deferred after M1; hard rebuild with registry re-send |
| C2 chunk copy | Done: `clip_chunk_ptr/commit`, `stream_chunk_ptr/commit`; `clip_write` tests only |
| C3 STATUS fields | Done (4.3); `loadPermille` 0 in M1 |
| C4 underrun method | Done: drift method; fields written by the shell |
| C5 direction | Done: PLAY, SET_PARAMS, SET_MIXED carry `dir` |
| C6 `world` | Done: `world` and `owner` in the voice table |
| C7 streams | Done: epochs, `startFrame`, STREAM_CREDIT (kind 11), worker-sourced clips |
| C8 READY | Done: flag bit4 plus `abiVersion` in the first block |
| C9 ceiling and format | Done: `clipMemoryMB`, `clipFormat` |
| C10 frame time | Done: internal `Engine` accessor with fallback |
| C11 `maxVoices` | Done: documented as stealing |
| 1 status starvation (blocking) | Fixed: copy in `onmessage`, RECYCLE at once, pool of 8, skip rule |
| 2 trap loses clips (blocking) | Imported memory in M1; clip-keeping recovery deferred; hard rebuild specified |
| 3 seek epochs | Fixed (4.1) |
| 4 platform check | Task A0.7, before M1a.1 |
| 5 CI benchmark | Metered build is task C1b; benches informational before it |
| 6 estimate | 155 person-days incl. reserve, 31.0 person-weeks (section 9); the owner accepted it |
| 7 replay size | REPLAY kind 12, chunked, never truncated; BATCH carry-over keeps absolute stamps |
| 8 post from `process` | Preallocated transfer list; skip when the pool is empty |
| 9 dwell | 3 frames |
| 10 priority weight | Documented: it mostly governs stealing |
| 11 `dispose` wording | Fixed |
| 12 pitch 16x cost | Counted in A3.5 |
| 13 lazy load, servers | Stated in section 6 |
| 14 M2 `group` | Reserved `group` u16 in PLAY and the table |
| Virtual voices and ducking | Every live voice counts (0097's wording, today's behaviour); both documents agree |

**Decided by the owner (round 3)**
- **Fallback backend:** Babylon `AudioEngineV2` behind 0098, not Howler. Howler and its dependency are deleted when `BabylonBackend` lands (BB2).
- **HRTF:** a port of Chromium's HRTF panner in M1, gated by the data-licence task H0; fallback SADIE II on the same panner, or equal-power.
- **Estimate:** accepted (155 person-days with reserve, 31.0 person-weeks).
- **Sound quality:** a manual listening pass, backed by the automated objective checks.
- **Reuse:** Chromium ports (notices kept), `microfft` as the FFT, designs only from Kira, Firewheel and SoLoud.
- Earlier rulings stand: ducking counts every live voice; reverb is 0097's convolver; hard rebuild in M1.

**ADR deltas** (wording for the ADR)
- **D1** Public API: `Audio.masterVolume` is the existing name; `Audio.volume` is added as an alias.
- **D2** Clock: commands carry a frame stamp, but plays without `at` are applied as soon as they arrive (asap); the lookahead is clamp(2 frames, 8 quanta, 100 ms) on top of the burst lead and applies only to `at`-stamped and replayed records.
- **D3** Status is posted every 6 quanta (every 48 when frames stop), not "once per frame", and the host returns buffers at once.
- **D4** Behaviour-change table: spatial sound keeps HRTF for the top 16 voices (`audio.voices.hrtf`) through the ported panner, with `audio.spatial` to turn it off, conditional on the data licence (if it fails, SADIE II or equal-power, and the row becomes a regression); reverb and compressor match Web Audio by construction; the fallback backend has no effects; a World that loses the view goes virtual; `Audio.muted` is readable.
- **D5** Pre-unlock queue: one-shots queue 32 for 1 s; `AudioSource`-owned and looping voices wait without a timeout.
- **D6** Recovery: M1 recovery is a hard rebuild; "recreate and replay" is a chunked REPLAY message from the voice table with clips re-sent from the main-side registry.
- **D7** `audio.clipMemoryMB`, `audio.clipFormat`, `audio.spatial`, `audio.voices.hrtf` and a World-aware voice table join the settings and data lists.
- **D8** Estimate: M1 is about 31 person-weeks (155 person-days with reserve) for one engineer, not 16-18.
- **D9** Lookahead wording, `devicechange` rebuild only on close or stall, and the metered CI gate.
- **D10** Fallback: `audio.backend` is `"babylon" | "core"` (`"howler"` maps to `"babylon"` with a problem); the Babylon backend replaces Howler as 0098's second backend; Howler is deleted when it lands, not in M1c; a core that cannot load falls back to it automatically at load (extends the failure table), while a core that exhausts its recoveries mid-session stays silent; the Babylon backend stays after M1 as the permanent fallback; `busGraph.ts` is kept only as a test reference.
- **D11** Reuse and Licences: ported Chromium files (BSD-3-Clause) and `microfft` (MIT) join the licence list, with notices; Kira, Firewheel and SoLoud are design references only.
- **D12** HRTF moves from M3 into M1 (nearest voices, Composite data or SADIE II); M3 keeps the ambisonic bed, convolution zones and occlusion.
- **D13** 0098 amendment: the interface also covers `BabylonBackend`; the "failed load keeps the fallback" rule applies to the core.

**Owner items: all settled (2026-11-09)**
1. The owner runs the human listening pass (task C4).
2. The low-end soak device is an Android phone on the lowest Android version Google Play accepts for publishing, running the web build in Chrome/WebView (task C3). A0.6 checks AudioWorklet and `simd128` there; without them, it runs the Babylon fallback.
3. macOS stays a release gate.
