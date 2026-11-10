# 0157 audio core: system architecture (M1)

The architect's design for ADR 0157 (Accepted, revision 2). It was revised after round 2 under the coordinator's rulings, and the owner approved it in round 3 with these choices:
- Babylon's AudioEngineV2 is the fallback backend, replacing Howler. It's chosen automatically when the core can't load, and kept after M1.
- M1 includes a port of Chromium's HRTF panner, gated on its data licence.
- Web Audio's DSP is ported from Chromium, and microfft is the FFT. Its companion, `api-and-models.md` (the senior engineer's, cited as **[API §n]**), owns the public API, settings, data models, byte layouts, the Rust ABI, the file layout, the tests and the tasks. This file owns components, lifecycles, interactions, timing, memory, performance, failure handling, observability and platforms. It covers M1 in detail, and later milestones only where they plug in.

Numbers cite `spikes/audio-worklet/` (one Ryzen AI Max+ 395 core, 2026-11-09, mostly single runs): `README` is the top-level README, and `messaging/`, `decode/`, `spatial/` and `bookkeeping/` are the sub-READMEs. **(est.)** marks a number that wasn't measured. A quantum is 128 frames (2.667 ms at 48 kHz), and a frame is one sample frame at the context rate.

## 1. Overview

```mermaid
flowchart LR
  subgraph Main["Main thread"]
    direction TB
    Plugin["Audio plugin runtime<br/>components, audio system, World service"]
    System["Audio system<br/>per frame, World with the view"]
    Table["Voice table<br/>typed arrays, selection"]
    Mixer["Mixer model<br/>src/engine/audio/mixer.ts"]
    Host["AudioHost, one per page<br/>context, node, clock map, mirror, recovery"]
    Unlock["Unlock layer"]
    Loader["Loader and clip registry"]
  end
  subgraph Worklet["Audio thread: AudioWorklet"]
    direction TB
    Shell["Processor shell, JS<br/>onmessage, process, underrun probe"]
    Core["Wasm core<br/>scheduler, voices, buses, arena, rings"]
  end
  subgraph Worker["Decoder worker, M1b"]
    Dec["symphonia wasm<br/>clips and streams"]
  end
  subgraph Editor["Editor half"]
    Settings["Project Settings, Audio"]
    Meters["Bus meters, debug panel, play stats"]
  end
  Plugin --> System
  System --> Table
  Mixer --> System
  System -->|"one BATCH per frame"| Host
  Unlock --> Host
  Loader -->|"M1a: CLIP_BEGIN, CLIP_CHUNK"| Host
  Host -->|"node.port: BATCH, CLIP, RECYCLE, TIME_PING"| Shell
  Shell -->|"node.port: STATUS every 6 quanta, returned buffers"| Host
  Host -.->|"optional SAB ring, isolated pages only"| Shell
  Shell --> Core
  Host -->|"open, seek, stop, decode"| Dec
  Dec -->|"metadata, typed errors"| Host
  Dec <-->|"MessagePort: STREAM, CLIP chunks, STREAM_CREDIT"| Shell
  Host -->|"mirror, Audio.debug"| Meters
  Settings -->|"project.json audio"| Mixer
```

| Component | Thread | Owns | Does |
|---|---|---|---|
| Audio plugin runtime | main | registration | Registers the components, the audio system and a `myco.audio` World service. The service's `load` dynamic-imports the host at scene load, before the first presented frame; its `runs` is false on servers and in headless Worlds, which therefore never fetch the core |
| Audio system (built-in, `lateUpdate`) | main | per-frame intent | Listener pose, attenuation, direction, audibility, selection, `mixer.update(dt)`, mirror apply, batch write and flush |
| Voice table [API §3] | main | **intent**: clip, parameters, priority, owner World, `startFrame`; virtual-voice selection | The source for replay after a rebuild |
| Mixer model | main | bus volumes, solo, snapshots, ducking (0097, unchanged) | `CoreBackend` calls `voiceStarted`/`voiceEnded` on play, free and `setBus`. Every live voice counts toward ducking, including virtual and paused ones, as today |
| AudioHost | main, page singleton | context, node, ports, clock map, mirror, buffer pools, recovery, background policy | Shared by the editor's Engine and play mode's, and lives for the page |
| Unlock layer | main | gesture listeners, the pre-unlock queue | Arms when locked, resumes the context inside the gesture, disarms; re-arms when a resume needs a gesture |
| Loader and clip registry [API §3] | main | clip state, refcounts, ceiling accounting, **encoded bytes for rebuilds** | M1a: fetch, `decodeAudioData`, int16 conversion, paced chunks. M1b: asks the worker |
| Processor shell | audio | message intake, copy budget, underrun probe, trap catch | Copies into wasm memory, calls `process`, posts STATUS |
| Wasm core | audio | **playheads, voice lifetime, buses, effects, the clock, the clip arena, the HRIR set, stream rings** | Renders one quantum per call; applies records; reports ends. Never allocates or grows memory in `process()`. Per voice: resample → distance/cone gain → filter → gain ramp → **panner (equal-power or HRTF)** → bus |
| Decoder worker (M1b) | worker | decoders, stream cursors | Decodes clips (whole) and streams (4096-frame chunks), pulled by credits |
| Editor half | main | settings UI | Settings section, meters, debug panel, underrun play stat; reads the mirror |
| Fallback backend (`audio.backend: "babylon"`, and automatic when the core can't load) | main | Babylon AudioEngineV2 objects behind 0098 | Plays through Babylon's static and streaming sounds, `AudioBus` tree and `PannerNode`, on the **host's** `AudioContext`. It has no effect nodes, so 0097's effects aren't applied (documented). Internal; never public (0010). Howler is deleted when it lands |

| Channel | Direction | Carries | Rate | Mode |
|---|---|---|---|---|
| `node.port` | main → worklet | BATCH, CLIP_* (M1a), TIME_PING, RECYCLE | 1 batch per frame; clips credit-paced | transferred buffers from pools |
| `node.port` | worklet → main | STATUS plus returned BATCH and CLIP buffers | every 6 quanta; every 48 after 250 ms without a batch | transferred |
| Worker `postMessage` | main ↔ worker | open, seek, stop, decode; metadata; typed errors | events | clone (small) |
| `MessageChannel` port | worker ↔ worklet | STREAM_*, worker-sourced CLIP_*; STREAM_CREDIT and returned buffers back | ~11 chunks/s per stream | transferred, `epoch`-tagged |
| SAB ring (optional) | main → worklet | the same BATCH bytes | 1 per frame | SPSC with `Atomics`, drained at each `process()` start |

Main is never on a stream's PCM path. Relaying through main lost 23–83 quanta under jank, and the direct port lost none (`messaging/` §5). The Babylon fallback uses none of these channels: it is plain Web Audio on the main thread.

**DSP sources.** These are ports, so their notices are kept in the file headers and in `THIRD_PARTY_NOTICES.md`.

| Part | Source | Why |
|---|---|---|
| Biquad (lowpass, highpass), dynamics compressor | ported from Chromium's Web Audio (BSD) | exact parity with today's 0097 effects, including Q in dB and the compressor's makeup gain and 6 ms pre-delay |
| Reverb convolver | Chromium's staged non-uniform `ReverbConvolver` design (BSD) | Chromium runs its tail stages on a background thread; the core runs them inline instead, spread over quanta (§6.1) |
| Equal-power panner, distance and cone effects | Chromium (BSD) | today's 0074 sound |
| HRTF panner and database logic | Chromium's `HRTFPanner`/`HRTFDatabase` (BSD), Composite HRIR data **behind a licence gate** (§11) | today's Web Audio HRTF sound |
| FFT | microfft (MIT): 256- and 4,096-point real FFTs and the 4,096-point complex inverse, 14 KB of wasm (built and measured by the coordinator) | the convolver and HRTF |
| Designs borrowed, no code | Kira (clocks, tweens), Firewheel (main-side context and audio-side processor split), SoLoud (virtual voices) | |

## 2. Lifecycles

### 2.1 Context and core

```mermaid
stateDiagram-v2
  [*] --> Locked: audio needed, autoplay blocked
  [*] --> Starting: audio needed, autoplay allowed
  Locked --> Starting: first pointerdown or keydown
  Starting --> Running: context running and first STATUS
  Starting --> Failed: load error, old engine, 5 s timeout
  Running --> Suspended: hidden with pause policy
  Suspended --> Running: visible and resume resolved
  Running --> Interrupted: context state interrupted
  Interrupted --> Running: resume resolved
  Interrupted --> Locked: resume needs a new gesture
  Interrupted --> Recovering: closed, or not resumed in 2 s
  Running --> Recovering: trap, processorerror, stall, context closed
  Recovering --> Running: rebuilt and replayed
  Recovering --> Failed: 4th recovery inside 60 s
  Failed --> [*]
```

The core loads **while Locked**, into a suspended context, so the gesture only calls `resume()`. A0.6 must confirm that WebKit and Firefox accept `addModule` and node creation on a suspended context; the coded fallback is to create the context inside the gesture. `Audio.status` maps Locked and Starting to `"locked"`, Failed to `"failed"`, and the rest to `"running"`. If the core can't load, the host switches to the Babylon backend automatically, with one warning. A core that loaded but exhausts its recoveries stays silent with `"failed"`. `audio.backend` is a setting, `"babylon"` or `"core"`; Fallback rule (coordinator): an engine that can't load the core (no AudioWorklet or `simd128`, fetch or compile failure, ABI mismatch, no first STATUS in 5 s) switches to the Babylon backend **automatically at load**, with one warning. A core that loaded and then traps more than 3 times in 60 s goes **silent** (`"failed"`), with no switch mid-session. The Babylon backend stays after M1 as this permanent fallback, so older engines still get basic sound. With `"babylon"`, the host still creates the context and runs the unlock layer, and Babylon's engine is handed that context (§9). This lifecycle is then context-only, with no core states.

### 2.2 Voice

```mermaid
stateDiagram-v2
  state "Queued before unlock" as Queued
  state "Pending data" as Pending
  [*] --> Requested: play or playOneShot
  Requested --> Queued: status locked
  Requested --> Pending: clip not resident, or stream empty
  Requested --> Mixed: selected
  Requested --> Virtual: not selected
  Queued --> Pending: unlocked
  Queued --> Dropped: one-shot older than 1 s, or past 32
  Pending --> Mixed: data ready and selected
  Pending --> Virtual: data ready, not selected
  Pending --> Ended: decode error or load refused
  Mixed --> Virtual: outranked, demoted, World lost the view
  Virtual --> Mixed: promoted, 5 ms fade-in
  Mixed --> Paused: pause
  Virtual --> Paused: pause
  Paused --> Virtual: resume, then selection
  Mixed --> Stopping: stop with fade
  Mixed --> Ended: clip end, or stop without fade
  Virtual --> Ended: clip end, or any stop
  Paused --> Ended: stop
  Stopping --> Ended: fade done
  Mixed --> Stolen: logical cap or bus maxVoices, lower priority
  Virtual --> Stolen: logical cap or bus maxVoices, lower priority
  Paused --> Stolen: logical cap or bus maxVoices, lower priority
  Ended --> [*]
  Stolen --> [*]
  Dropped --> [*]
```

| State | Decided by | Lives in |
|---|---|---|
| Requested, Queued, Dropped, Stolen | main | voice table. Queued applies the 32 and 1 s rule to one-shots only; `AudioSource`-owned and looping voices wait without a timeout ([API §10] issue 4) |
| Pending, clip | main (registry) | voice table; nothing is sent until the clip is resident |
| Pending, stream (M1b) | core | core slot; the first chunk starts it |
| Mixed, Virtual | main selects; the core may demote (§6.3) | both; the core owns the playhead in both |
| Paused | main | both; the playhead holds |
| Stopping, Ended | the core ends the voice; main learns through STATUS | core, then mirror |

Virtual voices keep time in the core: +0.03 ms for 4,096 logical with 256 mixed (`README`). Promotion and demotion use a 5 ms fade, and promotion resets filter state.

**Behaviour change (0074):** when a World loses the view, its voices go virtual (in time, silent). Today they keep sounding, because only the start is gated (`AudioSource.ts:72`). A World that's torn down stops its voices.

### 2.3 Stream (M1b)

```mermaid
stateDiagram-v2
  [*] --> Opening: PLAY on a stream clip, main asks the worker
  Opening --> Buffering: STREAM_OPEN reached the worklet
  Opening --> Failed: fetch or probe error
  Buffering --> Playing: first 4096-frame chunk
  Playing --> Starved: ring empty before the end
  Starved --> Playing: chunk arrives, 5 ms fade-in
  Playing --> Seeking: SEEK at its frame
  Seeking --> Buffering: ring flushed, new epoch
  Playing --> Draining: last chunk received
  Draining --> Ended: ring empty
  Playing --> Failed: decode error
  Failed --> Ended: 50 ms fade-out
  Ended --> Closed: STREAM_CLOSE, ring back to the pool
  Closed --> [*]
```

Loops never leave Playing: the worker wraps to `loopStart` (gapless trimming on), so the ring sees one continuous signal. A starved stream holds its position.

### 2.4 Panner kind and HRTF (M1)

| Aspect | Design |
|---|---|
| Pipeline place | the last per-voice stage before the bus: a per-slot **panner kind**, 0 equal-power or 1 HRTF (2–3 reserved for M3's ambisonic bed). Both use the voice's listener-space direction (C5) |
| Who gets HRTF | with `audio.spatial: "hrtf"`, selection ranks the mixed spatial voices by audibility and gives HRTF to the top *N* (`audio.voices.hrtf`: 16 by default and high, 4 low, 0 = none), with the same 1.2× hysteresis as mixing. All other spatial voices use equal-power; non-spatial voices use none |
| Kind change | the core runs both panners and crossfades over 45 ms, as long as Chromium's kernel crossfade, then drops the old one |
| Algorithm | Chromium's: azimuth and elevation interpolation over the database, per-ear frame delays (interaural time difference) through small delay lines, and two kernel sets crossfaded over ~45 ms when the direction changes enough to switch kernel. Chromium convolves a 256-sample IR with FFT size 512 in 256-frame blocks. The core uses **uniform 128-frame partitions with microfft's 256-point FFT** instead (two partitions per IR), so the work is flat per quantum, matching the spike's measured case. The output is the same convolution to float rounding, not bit-identical to Chromium |
| Kernels | computed on demand per voice: one FFT per partition and ear on a kernel switch, into the slot's two kernel sets. At most 4 kernel computations per quantum; further switches wait a quantum, masked by the crossfade |
| HRIR data | ~1.5 MB as f32 PCM at 44.1 kHz. Resampled to the context rate and converted to **int16 (~0.75 MB)** on the loader (M1a) or the worker (M1b), then uploaded as a data blob through the clip path into the arena, outside the clip ceiling. int16 is ample for kernels: −96 dB quantisation, under the IRs' own noise floor |
| When it loads | lazily: the first time a spatial voice is selected for HRTF. Until the blob is resident, those voices use equal-power, then crossfade to HRTF. `"equalPower"` never fetches it. A rebuild re-uploads it with the clips |
| Licence gate | the Composite set (derived from IRCAM Listen) ships only once its licence is cleared. Otherwise, use SADIE II (Apache-2.0) resampled onto the same grid with the same code, or set `"equalPower"` as the default |

## 3. Interactions

### 3.1 Start-up and unlock

```mermaid
sequenceDiagram
  participant E as Engine
  participant H as AudioHost
  participant U as Unlock layer
  participant C as AudioContext
  participant S as Worklet shell and core
  E->>H: World service load at scene load
  H->>H: fetch wasm, compile on main, 0.5 to 4 ms
  H->>C: new AudioContext, latencyHint interactive
  Note over C: suspended if autoplay is blocked. First context on Windows 250 to 490 ms
  H->>C: audioWorklet.addModule, 6 to 28 ms
  H->>S: new AudioWorkletNode, module or bytes, imported Memory, preset
  S->>S: instantiate, myco_audio_init, 2 to 23 ms
  S-->>H: first STATUS with ready flag, ABI version and hashes
  alt context already running
    H->>H: status running
  else locked
    H->>U: arm pointerdown and keydown, capture, passive
    E->>H: plays become locked voices
    U->>C: resume inside the gesture
    C-->>H: statechange running
    H->>U: disarm
  end
  H->>S: BATCH with surviving queued plays, flagged asap
```

Desktop webviews relax the autoplay policy (§9), so Tauri builds normally start in Running.

### 3.2 playOneShot to voice end and the mirror

```mermaid
sequenceDiagram
  participant G as Script
  participant T as Voice table
  participant Y as Audio system
  participant H as AudioHost
  participant S as Shell
  participant K as Core
  G->>T: playOneShot, slot with index and gen, handle returned
  Note over T: playing true at once
  Y->>T: lateUpdate, attenuation, audibility, selection
  Y->>H: PLAY flagged asap, SET_MIXED as selected
  H->>S: BATCH, transferred
  S->>K: copy to inbox, submit
  K->>K: start at the next quantum, at its gain, no ramp from zero
  K->>K: clip end at frame E, slot freed, id into ended
  S-->>H: STATUS, ended ids, returned buffers
  H->>H: merge into the mirror in onmessage, recycle the STATUS buffer at once
  Y->>T: next frame, free slot, gen plus 1
  Y->>Y: mixer.voiceEnded for ducking
  G->>T: handle.playing is false
```

### 3.3 A frame's batch: asap and stamped records

```mermaid
sequenceDiagram
  participant Y as Audio system
  participant H as AudioHost clock
  participant S as Shell
  participant K as Core
  Y->>H: frame time p from the rAF timestamp hook
  H->>H: F_now from the clock map, firstFrame is F_now plus L
  Y->>H: asap records, and stamped records for at, synced starts and replays
  H->>S: BATCH
  Note over S: arrives about 1 quantum later at p50, 3 to 5 at p99
  S->>K: submit, slack is firstFrame minus currentFrame
  loop each quantum
    K->>K: asap records apply at the first quantum after arrival
    K->>K: stamped PLAY and STOP at the sample offset
    K->>K: SET_PARAMS and BUS_MIX ramp from the quantum start over rampFrames
  end
  alt stamped record frame already past
    K->>K: apply at offset 0, lateCommands plus 1
  end
  S-->>H: STATUS with minSlackFrames
```

### 3.4 Streaming (M1b)

```mermaid
sequenceDiagram
  participant H as AudioHost
  participant W as Decoder worker
  participant S as Shell
  participant K as Core
  H->>W: open stream, asset url, startFrame, loop, epoch 1
  H->>S: BATCH with PLAY flagged stream
  K->>K: voice waits for data
  W->>W: fetch, probe, decode 4096 frames, p99 0.37 ms
  W->>S: STREAM_OPEN epoch 1
  W->>S: STREAM_CHUNK, transferred
  S->>K: copy via stream_chunk_ptr into the ring, voice starts
  loop until 32768 frames are buffered or in flight
    W->>S: STREAM_CHUNK
  end
  Note over W: idle, no timers, waits for credit
  S-->>W: STREAM_CREDIT every 4096 frames consumed, buffers returned
  W->>S: next STREAM_CHUNK
  H->>W: seek to frame X, epoch 2
  H->>S: BATCH with SEEK epoch 2 at frame F
  W->>S: STREAM_OPEN epoch 2, chunks from X, leading frames discarded
  K->>K: at F, 5 ms fade-out, flush ring, drop epoch 1 chunks
  K->>K: first epoch 2 chunk, 5 ms fade-in
  W->>W: loop end, wrap to loopStart, chunk flagged wrapped
  W->>H: on error, typed error with asset
  W->>S: STREAM_CLOSE
  K->>K: 50 ms fade-out, voice ended
```

The worker keeps `buffered + inFlight ≤ 32,768` frames (0.68 s), which survived a 300 ms decoder stall (`messaging/` §5). Chunk buffers circulate, so neither side allocates per chunk.

### 3.5 Clip load into the arena

```mermaid
sequenceDiagram
  participant L as Loader
  participant H as AudioHost
  participant S as Shell
  participant K as Core arena
  L->>L: fetch, keep encoded bytes, decodeAudioData (M1a)
  L->>L: check the ceiling, refuse and warn if over
  L->>H: CLIP_BEGIN clipId, frames, channels, rate, i16
  H->>S: CLIP_BEGIN
  S->>K: clip_reserve in onmessage, size class, may grow memory
  alt reserve fails
    S-->>H: STATUS clip event refused
  else reserved
    loop credit window of 4 chunks of 256 KB
      L->>L: convert one slice to interleaved i16
      H->>S: CLIP_CHUNK, transferred
      S->>K: clip_chunk_ptr, one copy, at most 256 KB per quantum
      S-->>H: STATUS returns buffers and credit
    end
    S-->>H: STATUS clip event resident
    H->>L: ready, start voices waiting on it
  end
```

About 64 MB/s, so the 64 MB benchmark set uploads in about 1 s. In M1b the worker decodes and sends the chunks to the shell itself; main sees only metadata. An MP3 without a Xing header has no known length, so the worker decodes it fully before CLIP_BEGIN [API §4].

### 3.6 Trap recovery: the hard rebuild

```mermaid
sequenceDiagram
  participant S as Old shell
  participant H as AudioHost
  participant N as New node and core
  participant L as Clip registry
  participant T as Voice table
  S->>S: trap caught around process, output silence
  S-->>H: STATUS flag trap
  H->>H: count against 3 per 60 s, else Failed and one warning
  H->>S: disconnect the old node
  H->>N: new AudioWorkletNode in the same context, new imported Memory, init
  N-->>H: first STATUS, ready
  H->>N: RESET 0, BUS_CONFIG, BUS_MIX, MASTER
  H->>L: resident clips, ordered by their live voices' priority
  L->>N: re-decode from kept bytes or through the worker, CLIP_BEGIN and chunks
  H->>T: walk live voices
  T->>H: voices whose clip is back
  H->>N: stamped PLAY with startOffsetFrames from the last playhead
  Note over H,N: one-shots under 1 s pending longer than 250 ms are dropped
```

A `processorerror` (a failure outside the trap catch) takes the same path.

### 3.7 Device change, sample-rate change, interruption

```mermaid
sequenceDiagram
  participant B as Browser
  participant H as AudioHost
  participant C as Old context
  participant N as New context and core
  B->>H: devicechange, or statechange
  H->>H: classify by state, sampleRate, STATUS heartbeat
  alt running and heartbeat fresh
    H->>H: nothing, Chromium follows the default device
  else interrupted
    H->>C: resume, retried for 2 s
  else closed, stalled 1 s, or resume failed
    H->>C: close
    H->>N: new context at the device rate, addModule, node, init
    H->>N: the hard rebuild of section 3.6
  end
```

Each clip keeps its own rate, and the voice resampler absorbs a new context rate, so a rate change alone forces no re-decode beyond the rebuild's.

### 3.8 Tab hidden and visible

```mermaid
sequenceDiagram
  participant D as document
  participant H as AudioHost
  participant S as Shell and core
  participant C as AudioContext
  D->>H: visibilitychange hidden
  alt background mute, the default
    H->>S: MASTER gain 0 over 50 ms, flushed now
  else pause
    H->>S: MASTER gain 0 over 30 ms
    H->>C: suspend after the fade
  else play
    H->>H: nothing
  end
  Note over S: no BATCH arrives, ramps reach their targets and hold, streams stay pulled by credits
  S-->>H: STATUS every 48 quanta, ends freed in onmessage
  D->>H: visibilitychange visible
  H->>C: resume if suspended
  H->>H: re-anchor the clock map, reset the underrun probe
  H->>S: MASTER back over 50 ms in the next BATCH
```

### 3.9 Editor play and stop; several Worlds on one context

```mermaid
sequenceDiagram
  participant Ed as Editor Engine
  participant P as Play mode Engine
  participant H as AudioHost
  participant S as Core
  Ed->>H: edit World registers, no voices
  P->>H: Play, the play World with the view registers as owner
  H->>S: BATCH per frame, flushed by the audible owner's step
  P->>H: view passes to another World
  H->>H: old owner inaudible, its voices forced virtual
  P->>H: Stop, releaseWorld for each play World
  H->>S: STOP its voices with 10 ms fades
  H->>S: CLIP_UNLOAD for clips with no refs
  S->>S: last block freed, arena resets to empty
  Note over H,S: the context and core stay alive for the page
```

Worlds exist only on main (the voice table's `owner`); the core has no namespaces. Other owners' records ride the next flush. When no Engine steps, the host flushes on a 50 ms `setTimeout`. `Engine.ts:176` reconfigures the one mixer for both Engines. BUS_CONFIG with live voices remaps each voice's bus by name, and unknown names go to the root [API §3]. That's a listed improvement over today, where playing sounds keep their old routing.

## 4. Threading and timing

### 4.1 State ownership

| State | Owner (writes) | Copy elsewhere |
|---|---|---|
| Voice intent | main (voice table) | PLAY, SET_PARAMS |
| Mixed or virtual choice | main; the core only demotes | demotions mirrored |
| Playhead, lifetime, ramps, filter state | core | playheads mirrored when requested |
| Bus tree and parameters | main (mixer) | BUS_CONFIG, BUS_MIX |
| Bus DSP state, meters | core | peaks in STATUS |
| Audio clock | core (`currentFrame`) | `Audio.time` through the clock map |
| Clip PCM | core arena | encoded bytes on main (M1a), the worker's cache (M1b) |
| Stream cursor | worker | positions in chunk headers |
| Context state, recovery count | host | `Audio.status` |

One owner per row. The one shared case, mixed versus virtual, is resolved by direction: the core can only demote, and main honours `mixedCap` so it never re-promotes against the core.

### 4.2 Staleness bounds

| Value | Normal bound | Under a main-thread stall of *s* |
|---|---|---|
| `playing` and `reason` after a natural end | ≤ 1 frame + 16 ms + ~1 ms transfer | *s* |
| `playing` after `play()` or `stop()` | 0 (main writes it) | 0 |
| Playheads, peaks, counters | ≤ 16 ms + 1 frame | *s* |
| Heard vs rendered | the mirror describes the render clock; the speaker lags it by Λ (~50 ms, `README`) | — |
| An asap command's effect | next quantum after arrival: 1 quantum p50, 3–5 p99 | *s* |
| A stamped command's effect | its frame, if it arrives within L | late by *s* − L |

### 4.3 Clock map, lookahead and ramps

Inputs come through a `HostClock` (§4.6). Per frame, *p* is the frame's rAF time.

| Symbol | Definition |
|---|---|
| *H*(*p*) | heard frame = *sr*·(*T* + (*p* − *P*)/1000), with (*T*, *P*) from `getOutputTimestamp()` |
| *o* | offset filter: *o* ← *o* + 0.1·(*o*_obs − *o*), where *o*_obs = *H*(*p*) − *p*·*sr*/1000. Reject a sample more than 5 ms off; after 10 rejections in a row, re-anchor |
| Λ | render lead, an upper envelope of λ_obs = `currentTime`·*sr* − *H*(*p*): attack at once, release 1% per frame |
| *F*_now | *p*·*sr*/1000 + *o* + Λ |
| `Audio.time` | (*p*·*sr*/1000 + *o*)/*sr*, the heard clock [API §1]. Frame *f* is heard when `Audio.time` = *f*/*sr* |
| L | clamp(2·Δ̄, 1,024 frames (8 quanta), 100 ms); Δ̄ is an EMA (0.1) of frame intervals |
| `firstFrame` | max(round(*F*_now + L), the previous batch's `firstFrame`) |
| `rampFrames` | round(clamp(Δ̄, 5 ms, 50 ms)·*sr*), for SET_PARAMS and BUS_MIX. PLAY starts at its gain |

Fallback before Running, or where `getOutputTimestamp` is missing: *F*_now = the newest STATUS `currentFrame` + (`Date.now()` − `dateMs`)·*sr*/1000 + 512.

**Which records are stamped.** Un-timestamped sounds carry the `asap` flag [API §4.2]. They apply at the first quantum after arrival and are never counted late. Expected latency is Λ + 1–5 quanta ≈ 53–63 ms. Only `at` records, starts that must line up (loop restarts kept in sync, M4 music) and replays are stamped at `firstFrame` + offset. L's floor exists because Chromium renders 3–4 quanta per ~10 ms callback and postMessage's tail is 3–5 quanta (`messaging/` §2–4); without it, two frames at 144 Hz (13.9 ms) would make stamped records late.

### 4.4 Late commands

A stamped record whose frame is before the current quantum applies at offset 0, and `lateCommands` and max lateness are counted. PLAY starts from its start (or `startOffsetFrames`), not skipped ahead, since a clipped transient sounds worse than a late one. M4 can add a "sync" flag that skips ahead.

### 4.5 When frames stop

Batches stop. Ramps finish within ≤ 50 ms and hold. Voices play on (`mute`, `play`) or freeze (`pause`). Streams stay credit-pulled. STATUS slows to every 48 quanta and is merged in the host's `onmessage`, and its buffer is recycled at once (otherwise the worklet's pool runs dry). On return, 0011 clamps the first `dt`, the clock map re-anchors, and `firstFrame` jumps forward, still monotonic.

### 4.6 Testability: `HostClock` and the loopback

| Seam | Contract |
|---|---|
| `HostClock` (main) | `rafTime()`, `outputTimestamp()` (contextTime and performanceTime, or null), `currentTime()`, `dateNow()`, injected into the host. Production wraps the browser; tests use a fake that advances explicitly |
| Shell logic | `coreDriver` [API §6] takes `currentFrame` and `dateNow` as arguments on every call. No globals, so Node drives it |
| Loopback | `renderQuanta(n)` renders *n* quanta and delivers the STATUS blocks synchronously at their 6-quantum points |
| Traces | the clock map and underrun probe have replay tests over recorded `(p, T, P, C)` and `(currentFrame, dateNow)` traces, including a suspend, a 300 ms main stall and a `Date.now` jump |

### 4.7 Constants

| Area | Constant |
|---|---|
| STATUS | every 6 quanta; every 48 after 250 ms without a batch; pool of 8 × 16 KB buffers; each list capped at 1,024 entries per block, overflow carried |
| BATCH | pool of 4 × 64 KB; a RESET (replay) batch may use up to the 1 MiB inbox |
| Clock | offset EMA 0.1; reject 5 ms; re-anchor after 10; Λ release 1% per frame; fallback lead 512 frames |
| Lookahead and ramps | L = clamp(2·Δ̄, 1,024 frames, 100 ms); ramps clamp(Δ̄, 5, 50 ms) |
| Underrun probe | below |
| Adaptive cap | §6.3 |
| Lifecycle | unlock queue 32 one-shots / 1 s; Starting timeout 5 s; stall 1 s; interrupted retry 2 s; recovery 3 per 60 s; idle flush 50 ms |
| Fades | promote and demote 5 ms; `releaseWorld` 10 ms; stream error 50 ms; mute 50 ms; pause 30 ms; seek 5 ms out and in |
| Copies | 256 KB per quantum; credit window 4 × 256 KB |
| Streams | 4,096-frame chunks; ring 32,768 frames; credit every 4,096 consumed; start on the first chunk |

**Underrun probe** (in the shell, per `process()` call; *sr* is the context rate):

```
on (re)anchor:  t0 = dateNow; f0 = currentFrame; warmUntil = dateNow + 1000; buckets = 8 × +inf
each call:
  if dateNow < lastDate or dateNow - lastDate > 500: anchor(); return   // clock jump or suspension
  d = (dateNow - t0) * sr / 1000 - (currentFrame + 128 - f0)           // frames behind wall clock
  bucket[floor(dateNow / 125) % 8] = min(that bucket, d)               // a stale bucket resets first
  if dateNow < warmUntil: return
  dMin = min(buckets)
  if d - dMin > 0.024 * sr:                                            // 24 ms
    underruns += 1; underrunFrames += round(d - dMin); anchor()
```

24 ms covers twice Chromium's 10 ms device period, plus the 1 ms clock and margin. Shorter glitches go unseen, and the doc says so. Clock drift (≤ 100 ppm, 0.1 ms/s) stays well under the threshold within the 1 s window. Re-anchor on resume, on becoming visible, and on rebuild. Chromium's `renderCapacity` underrun ratio is reported beside it where it exists (confirm).

## 5. Memory

### 5.1 The worklet's wasm heap

The shell creates the `Memory` and imports it, with `maximum` = fixed size + the clip ceiling. `myco_audio_init` allocates deterministically, and everything but the arena is sized there and never grows. (Imported memory with deterministic init is in M1, so the future soft-recovery path in §7 needs no ABI break.)

Measured by A3.5 (`audio-bench mode=memory`: `Layout::new` for each preset at 48 kHz with 32 buses, and the sizes of the HRTF bank and table). The block is what `myco_audio_init` lays out; the first four rows are outside it.

| Region | Formula | Default preset (48 kHz) |
|---|---|---|
| Code and data | — | mixer wasm 143.9 KB (147,356 B, A3.5) of 150 KB (ADR gate), name section stripped |
| Shadow stack | fixed | 256 KB; a test asserts the stack high-water mark under the stress scene |
| Inbox | fixed | 1 MiB (BATCH and control only; chunks go direct) |
| STATUS staging | 16 KB | 16 KB |
| Output, core state, scheduler | 1 KB + 64 KB + 8,192 pending × 48 B | 450 KB (460,800 B) |
| Voice slots, mixed list | *L* × 192 B + *M* × 4 B | 4,096 / 128 → 768.5 KB |
| Bus graph | *B* × 4,224 B (`BusSlot`: stereo quantum buffer, one compressor with its 6 ms pre-delay, four effect slots) | 32 → 132 KB |
| Reverb | the shared 1.8 s stereo convolver: non-uniform partition spectra and frequency-domain delay lines; grows with the rate | 2.88 MiB (3,015,744 B) |
| Stream rings | *S* × (32,768 ring + 4,096 chunk + 1,536 seek-tail frames, B3 and B3b) × 2 channels × 4 B = *S* × 307,200 B; *S* = clamp(*M* ÷ 16, 4, 16) | 8 → 2.34 MiB |
| Clip directory | 4,096 × 32 B + 32 × 8 B | 128 KB |
| **Block before the arena** | | **6.69 MiB** (7,012,352 B); low (1,024 / 48, 4 rings) 4.94 MiB; high (8,192 / 256, 16 rings) 9.81 MiB |
| Clip arena | initial reserve, growing to the ceiling | 16 → 128 MB |
| HRTF bank (H3, owner-review 12) | 32 panners, built in the arena when the HRIR table arrives; outside `clipMemoryMB` | 683 KB (699,200 B) up to 88.2 kHz; 1.04 MiB (1,092,416 B) above |
| HRIR table (lazy) | int16 responses at the context rate plus the delay table, in the arena under a reserved id; outside `clipMemoryMB` | 263 KB (269,776 B) at 48 kHz; about 0.51 MB at 96 kHz |
| **Initial memory** | block + the four rows outside it | **22.7 MiB block** (23,789,568 B) + ≈ 1.4 MB; low 12.9 MiB + 1.4 MB; high 41.8 MiB + 1.4 MB; + ≈ 0.95 MB once HRTF loads |

### 5.2 Clip arena (M1)

| Aspect | Policy |
|---|---|
| Format | interleaved int16 by default (11.25 MB per stereo minute at 48 kHz, half of f32); `audio.clipFormat: "f32"` opts out [API §2]. Each clip keeps its own rate |
| Classes | four size classes per power of two from 4 KB up to the ceiling's class ([API §5]); a request rounds up to its class |
| Allocate | pop the class's free list; else take a free block from up to two classes larger; else carve from the arena's bump pointer; else grow memory |
| Growth | only in `onmessage` (`clip_reserve`): by max(block, 4 MB, 25% of the arena), within the memory `maximum`. The shell refreshes views after any call that may grow |
| Free | the block goes back to its class list; no splitting, merging or compaction |
| Reset | when the last block is freed (every clip unloaded, as after `releaseWorld` on play stop), the bump pointer returns to the base and the lists clear. Memory isn't returned to the browser |
| Ceiling | counted in class bytes (what's actually taken). Rounding wastes at most 25% per clip and ~12% on mixed content (est.), so a 128 MB ceiling holds roughly 110 MB of PCM |
| Refusal | ceiling passed, or `memory.grow` fails: refuse, keep playing, one warning, a STATUS clip event |
| Later | compaction, only if `refusedWithFreeBytes` (a refusal while enough free bytes exist in total) shows up in the stress sample |

### 5.3 Presets

In M1, presets are named bundles the editor offers. The file stores numbers [API §2]: `voices` and `clipMemoryMB`. A project value is the ceiling. The effective mixed count is min(project, adaptive cap). M1 doesn't pick presets from a runtime device measurement. "Low" is set in the lab from the low-end soak machine.

| | Low | Default | High |
|---|---|---|---|
| Mixed / logical voices | 64 / 1,024 | 128 / 4,096 | 256 / 4,096 |
| Streams | 4 | 8 | 16 |
| Arena initial / ceiling | 8 / 64 MB | 16 / 128 MB | 32 / 256 MB |
| Initial memory | ≈ 13.5 MB | ≈ 23.6 MB | ≈ 41.5 MB |
| Defined by | the low-end soak device: an Android phone on the lowest Android version Google Play accepts for publishing, running the web build in Chrome/WebView. Its numbers here are a starting point to lower after measuring | — | the reference class |

## 6. Performance

### 6.1 Cost per quantum

*T*_q = *M*·*c*_v + *F*·*c*_src + *M*_mov·*c*_mov + (*L*_live − *M*)·*c*_virt + *N*·*c*_hrtf + *K*·*c*_kern + Σ_bus (*c*_bus + Σ *c*_fx) + *c*_rev + *c*_lim + *R*·*c*_rec

*F* is the source frames the mixed voices read (pitch × 128 each), *M*_mov the mixed voices whose pan matrix is ramping (a direction change), *N* the HRTF voices and *K* the HRTF kernel computations (at most `KERNEL_BUDGET` = 2 a quantum). The core's work-unit model (`cap::model`, §6.3) is this formula with the `wu::` coefficients; the render notes *F*, *M*_mov, *K* and the panners crossfading for it (A3.5).

**Frozen by A3.5 (2026-11-10).** Measured with `audio-bench` (`native/audio/crates/audio-bench`; wasm in Node through `tools/audio-bench/run.mjs`, built `+simd128` in release like the mixer). Each coefficient is the least-squares slope of the mean quantum time over a sweep that varies only that term (3 runs × 10 s per point; two wasm sweeps and two native sweeps, the ranges below). **Lab machine:** a shared 4-core 2.1 GHz Xeon VM (260 MB L3), Node 22, load average 1.0–1.5 during the runs (the bench's own core). No reference machine was available; every number here is to be re-measured on it (§6.5).

| Term | wasm (Node) | native | `cap::wu` | Before A3.5 |
|---|---|---|---|---|
| *c*_v, mixed voice (4-point resampler, int16 stereo, gain, fade, equal-power pan, mix) | 3.0–3.8 µs | 2.5–2.7 µs | `MIXED_VOICE` 3,400 | 1.15 µs (linear, spike) |
| *c*_src, per 128 source frames (pitch) | 0.03 µs (second sweep: within the noise of 0) | 0.035–0.05 µs | `SOURCE_QUANTUM` 30 | not modelled |
| *c*_mov, moving mixed voice (pan matrix per frame) | 0.78–0.94 µs | 1.2 µs | `MOVING_VOICE` 860 | not modelled |
| *c*_virt, virtual voice | 0.059–0.070 µs | 0.035–0.040 µs (0.17 before A3.5's O(1) advance) | `VIRTUAL_VOICE` 65 | 0.008 µs (spike) |
| *c*_hrtf, HRTF voice (convolution and delays) | 6.9–7.8 µs | 8.6–8.9 µs | `HRTF_VOICE` 7,400 | 6.6 µs |
| *c*_kern, HRTF kernel computation | 67–84 µs | 55–58 µs | `HRTF_KERNEL` 75,000 | not modelled (owner-review 13) |
| kernel crossfade (two sets convolved) | −4 to +7 µs, collinear with *c*_kern | 0.1–8 µs | no term | 3.8 µs |
| *c*_bus | 0.8–0.9 µs | within the noise of 0 (±0.2) | `BUS` 800 | 1.5 µs |
| biquad (lowpass, highpass, snapshot low-pass) | 0.3–1.2 µs | 0.7–1.5 µs | `BIQUAD` 1,200 | 0.5 µs |
| compressor | 5.5–5.6 µs | 2.5–3.3 µs | `COMPRESSOR` 5,500 | 4.5 µs |
| reverb send | within the noise (±0.6 µs) | within the noise | `REVERB_SEND` 150 (est.) | 0.15 µs |
| *c*_rev, the shared 1.8 s convolver, average | 20–40 µs (±11 per sweep) | 24–28 µs | `REVERB` 30,000 | 70 µs |
| *c*_lim, limiter at 1.5 ms look-ahead | 1.8 µs (A2.9) | 0.9–1.8 µs | `LIMITER` 2,000 | 5 µs |
| *c*_rec, record applied | within the noise (±1.5 µs at 43 a quantum) | within the noise | `RECORD` 100 (est.) | 0.1 µs |
| stream voice over a clip voice | within the noise (±1 µs) | within the noise | counted as a mixed voice | |
| 64 MB of distinct clips against 1 MB (cache-cold reads) | within the noise | within the noise | none: the lab VM's L3 holds them; **re-measure on the reference machine** | |
| starts (200 a second) | within the noise | within the noise | none | |

`NS_PER_WU` stays 1: the coefficients are the lab machine's wasm nanoseconds, and the lab machine stands in for the reference machine. The model matches the measured means of the full scenes within 4% (wasm: default 1.42 ms modelled against 1.48 measured, high 2.34 against 2.36). These runs render back to back; a short paced run (`pace=1`, one quantum per 2.67 ms, so caches cool between quanta as on a device) measured the default scene's mean 11% (wasm) to 18% (native) higher, which the soak's numbers will include.

**The frozen scenes** (§6.5's content): the preset's mixed voices as one-shots of 64 MB of distinct int16 stereo clips in shuffled order, restarted as they end (about 170 starts a second), pitch 0.5–2, the preset's streams among them, the rest of the logical voices virtual and looping, 32 buses each with lowpass, highpass, compressor and snapshot low-pass, the reverb fed by 8 of them, the limiter at 1.5 ms, every HRTF voice turning at 120° a second, and a batch every 6 quanta with gain and direction for every mixed voice (≈ 22 records a quantum at default, 43 at high). Time per quantum is the audio thread's whole work: the batch's `submit`, stream chunk copies, `process`, `after_quantum`, the clip events and a STATUS take every 6 quanta. Default and high: 5 runs × 60 s after a 5 s warm-up; the variants 3 runs × 30 s. Median of the runs, [range]; ms.

| Scene (lab VM) | Target | p50 | p99 | **p99.9** | mean | modelled mean |
|---|---|---|---|---|---|---|
| **Default**: 128 mixed / 4,096 logical, 16 HRTF, 8 streams | wasm | 1.30 [1.24–1.36] | 2.42 [2.32–2.64] | **3.90** [3.74–5.74] | 1.48 | 1.42 |
| | native | 1.05 [1.01–1.33] | 1.89 [1.77–1.93] | 3.52 [3.22–3.85] | 1.18 | |
| **High**: 256 mixed / 8,192 logical, 32 HRTF, 16 streams | wasm | 2.07 [2.04–2.41] | 3.81 [3.69–3.94] | **5.45** [5.33–6.07] | 2.36 | 2.34 |
| | native | 1.85 [1.73–2.26] | 3.20 [2.96–3.47] | 4.60 [4.31–6.27] | 2.03 | |
| High, HRTF voices still | wasm | 2.01 | 3.50 | 5.51 | 2.25 | 2.17 |
| High, 16 HRTF voices | wasm | 2.55 [1.95–2.81] | 4.19 | 5.87 | 2.61 | 2.23 |
| | native | 1.72 | 2.88 | 4.77 | 1.88 | |
| High, 192 mixed | wasm | 1.85 | 3.60 | 4.93 | 2.16 | 2.07 |
| High, pitch 1–16 | wasm | 2.08 | 3.82 | 5.94 | 2.35 | 2.34 |
| High with the adaptive cap (production budget) | wasm | 1.35 | 2.36 | 4.62 | 1.44 | 1.28; the cap fell to 16 and stayed |
| Default with the adaptive cap | wasm | 0.88 | 1.54 | 3.01 | 0.98 | 0.95; the cap fell to 16 and stayed |
| Low: 48 mixed / 1,024 logical, 4 HRTF, 4 streams | wasm | 0.59 | 1.07 | 2.35 | 0.66 | 0.68 |

The high-16-HRTF wasm runs ran slower than the 32-HRTF ones (one run 2.74 ms mean): the lab VM's run-to-run spread is about ±15% on the mean; native shows the expected 0.15 ms saving.

**The high preset at p99.9 (4-point resampler), frozen.** The attribution is the model's (the measured coefficients at the high scene's counts, wasm, lab VM). The ADR budget is 1.3 ms at p99.9 on the reference machine.

| High preset (wasm, lab VM) | mean ms | Count |
|---|---|---|
| Mixed voices | 0.87 | 254 × 3.4 µs, plus 0.01 for their source reads |
| Moving mixed voices | 0.22 | 255 × 0.86 µs |
| Virtual voices | 0.51 | 7,872 × 0.065 µs |
| HRTF voices | 0.24 | 32 × 7.4 µs |
| HRTF kernels | 0.15 | 2 a quantum × 75 µs |
| Buses and effects | 0.32 | 32 × (bus 0.8 + 3 biquads 3.6 + compressor 5.5 µs), 8 sends |
| Reverb, limiter, records | 0.04 | |
| **Total, mean** | **2.34** (measured 2.36) | |
| **Measured p99.9** | **5.45** | **4.15 ms over the 1.3 ms budget** |

**It doesn't fit on the lab machine** — at either preset: default is 3.9 ms at p99.9 (1.48 mean), high 5.45 (2.36 mean), and even low is 2.35 at p99.9. Two things are behind that, and only measurement on the reference machine separates them:

- **The lab VM's tail.** Fixed workloads with nothing varying (128 looping voices; 32 compressors) still show p99 1.4–2× and p99.9 2–4× their p50, with no phase pattern (quanta by index mod 16 and mod 6 have the same spread), so most of the p99.9 is the shared VM (neighbours, steal), not the core. The means (and the model) are trustworthy; the p99.9 column is an upper bound to replace on an idle reference machine.
- **The costs themselves.** The mean alone is 1.8× the budget at high and 1.1× at default on this 2.1 GHz server core. A desktop core at 4–5 GHz is commonly about twice as fast single-threaded, which would put high at ≈ 1.2 ms mean (no headroom for a p99.9 of 1.3) and default at ≈ 0.75 ms mean.

**Proposals (for the coordinator; savings are wasm means on the lab VM at high):**

| Change | Saves | Cost |
|---|---|---|
| Budget effects realistically: the frozen scene puts a compressor and three biquads on all 32 buses. A budget of ≤ 8 compressors and ≤ 32 biquads at high | ≈ 0.21 ms | a documented content limit (the model counts what is configured, so the cap already sees it) |
| High preset at 4,096 logical voices (as §5.3's table says; owner-review 1 chose 8,192) | 0.27 ms | fewer tracked voices at high |
| Virtual voices without a per-quantum walk (keep time from the start frame; advance only on promote, end, or a pitch change) | ≈ 0.45 ms | a core change, post-M1 |
| 16 HRTF voices at high (as default) | 0.12 ms | fewer HRTF voices |
| `KERNEL_BUDGET` 1 instead of 2 | 0.075 ms | each turning voice's crossfades start half as often |
| A vectorised ramped pan (the moving path) | up to ≈ 0.2 ms | a core change (output must stay bit-exact or goldens re-recorded) |
| A SIMD 4-point resampler | up to ≈ 0.4 ms | a core change (same) |

Without core changes (the effects budget, 4,096 logical voices, 16 HRTF voices, a kernel budget of 1), high would be ≈ 1.67 ms mean on the lab VM, ≈ 0.85 ms on a 2× faster reference core. The three core changes would take the lab VM to ≈ 0.85 ms mean (≈ 0.45 ms on the reference), which leaves room for a 1.3 ms p99.9. M3's ambisonic bed (0.18–0.35 ms, `spatial/`) is not in these numbers.

**Re-measure** (`native/audio/crates/audio-bench`, §6.5): every row of the first table and both scene tables on the reference machine; the cache-cold row on a machine whose last-level cache is smaller than 64 MB; the p99.9 columns in C3's soak (the browser's real audio thread, other tabs, GC); the low preset on the low-end Android device.

### 6.2 Worst case

Chromium on Windows renders 3–4 quanta back to back per ~10 ms device period (`messaging/` §2). Rule: **a 4-quantum burst finishes within 75% of the period (7.5 ms).** M1 on the reference machine, if the budget holds: 4 × 1.3 + 0.86 (a worklet GC scavenge, ~once per 10 s at 1,024 voices, `messaging/` §6) + ~0.1 (copy, submit, STATUS) ≈ **6.2 ms**. On the lab VM (A3.5) a burst of four high-preset quanta averages 4 × 2.36 = 9.4 ms and misses; four default quanta average 5.9 ms and fit only without a tail quantum. M3's convolver tail maximum (1.67 ms, `spatial/`) would add to that, hence phase-staggered tails. A CPU 2.5× slower than the reference misses the deadline at the high preset, which is why "low" exists and the cap adapts.

### 6.3 Adaptive voice cap (M1)

> **Owner decision (2026-11-10):** the work-unit model is informational. Only underruns and qualifying late commands move the cap (`MODEL_DRIVES_CAP = false`); the model's p99 rows of the table below apply only in model-driven mode (tests and the bench's `-cap` scenes). See `owner-review.md` entry 35.

| Element | Design |
|---|---|
| Signals | underrun increments (§4.7); `lateCommands` increments with negative `minSlackFrames`, counted only when batches are arriving on time (gap between `firstFrame`s ≤ 2 × Δ̄; otherwise main is the cause); modelled WU p99 as a ceiling against a fixed budget, 1.3 ms ÷ *k*, with *k* (µs per WU) a lab constant per build |
| Window | 250 ms, in the core |
| Decrease | any underrun, or a qualifying late command, or WU p99 > 70% of budget: cap ← max(16, ⌊0.85·cap⌋); hold 1 s |
| Increase | nothing qualifying and WU p99 < 55% for 5 s: cap ← min(configured, cap + max(2, configured/32)), once per second |
| Effect | the core demotes the lowest-`score` mixed voices and reports `demoted` and `mixedCap`; selection uses min(configured, `mixedCap`) |
| Model (A3.5) | §6.1's formula with the frozen `wu::` coefficients and *k* = 1 (lab-machine wasm ns). The cap only sheds mixed voices: what the model counts outside them (virtual voices, HRTF, buses and effects) is a floor it can't lower. In the frozen scenes that floor is about 1.15 ms at high and 0.87 ms at default (their work-unit p99 1.67 and 1.07 ms), above the 70% line (0.91 ms), so the cap goes to 16 and stays (measured: high 1.44 ms mean, 4.6 ms p99.9 with the cap; default 0.98 ms, 3.0 ms). On a 2× faster reference those models would read the same: the model is a fixed ceiling for content, so scenes like these are capped on every machine until the coefficients are replaced with the reference machine's |
| Future (not M1) | start-up calibration of *k*, a time-based load estimate from `Date.now()` probes (`loadPermille`, reserved as 0), an emergency per-quantum demote, and device-class preset selection |

### 6.4 Main thread and GC

| Item per frame | Budget | Evidence |
|---|---|---|
| Bookkeeping and selection | ≤ 0.25 ms | 0.08 p50 / 0.22 p99 ms at 4,096 (`bookkeeping/`) |
| Batch pack and post | ≤ 0.1 ms | ~0.1 ms at 1,024 voices (`messaging/` §3) |
| STATUS merge, clock map | ≤ 0.04 ms (est.) | |

Main allocates nothing per frame. The voice table and scratch are preallocated typed arrays; batch and STATUS buffers circulate in pools (allocation happens only when a pool is empty, and is counted); chunk buffers circulate. The one per-call object is an `AudioHandle` per `playOneShot`. On the worklet, postMessage's envelope still allocates (one 0.55–0.86 ms scavenge per ~10 s at 1,024 voices); the transfer-list array is preallocated, and the SAB ring removes the envelope.

### 6.5 Benchmarks

| Track | When | What | Gate |
|---|---|---|---|
| Lab | from M1a.3; A3.5's harness | `audio-bench` (`native/audio/crates/audio-bench`): per-quantum wall time natively (`cargo run --release -p audio-bench -- mode=scene name=default,high`) and as wasm in Node (`node tools/audio-bench/run.mjs mode=scene …`, built `+simd128` like the mixer); `mode=fit` runs the coefficient sweeps, `mode=memory` §5.1's sizes. ≥ 5 runs × 60 s after a 5 s warm-up; p50, p99, **p99.9**, max, the modelled work units; `pace=1` sleeps to each 2.67 ms deadline (caches go cold between quanta, as on a device). Still to do: a browser main thread on a COOP/COEP page, the reference and low-end machines | froze §6.1 and *k* (A3.5, lab VM); re-run on the reference machine to replace them |
| Content | | 4-point resampler, ≥ 64 MB of distinct clips in shuffled order (cache-cold where the last-level cache is smaller), 32 buses with effects, the reverb, the limiter at 1.5 ms, 4,096 / 8,192 logical voices, ≈ 170 starts per second, pitch 0.5–2 (and 1–16), HRTF still and turning, streams, a parameter batch every 6 quanta | |
| CI | **M1c** | a metered wasm (an instruction counter injected after linking, test-only) over fixed scenes in Node; Rust isn't needed in CI | +10% fails |
| Before M1c | | modelled WU totals and lab numbers are informational only | none |
| Live | soak | 30 min of the stress sample with the underrun probe | 0 underruns |

## 7. Failure modes and recovery

| Failure | Detection | Handling | User-visible | Counters |
|---|---|---|---|---|
| Before the first gesture | context suspended after creation | core preloaded; unlock layer armed; one-shots queued 32 / 1 s; `AudioSource` and looping voices wait | `"locked"`, `reason` `"locked"` | `queuedPlays`, `droppedPlays` |
| Trap in `process()` | the shell's `try` around `myco_audio_process`; `processorerror` for anything else | silence, then the **hard rebuild** (§3.6): a new node and new Memory in the same context, RESET 0, clips re-sent by priority (re-decoded from kept bytes in M1a, or by the worker in M1b), stamped replay. 3 per 60 s, then Failed | a gap ≈ re-decode + upload: ~1–3 s for 64 MB (est.) | `traps`, `recoveries` |
| Core fails to load | fetch or compile error, hash or ABI mismatch, missing AudioWorklet or `simd128`, no first STATUS in 5 s one warning naming the cause and the minimum versions, then an **automatic switch to the Babylon backend** (basic playback, no effects, no priority) | `"running"` on the fallback, with `Audio.debug().core.backend = "babylon"` | `loadFailure` |
| HRIR blob fails to load | fetch error or a refused upload | one warning; spatial voices stay equal-power | flatter 3D | `hrtfLoadFailure` |
| Device or rate change, `interrupted` | `statechange`, `devicechange`, heartbeat older than 1 s while running and visible | classify (§3.7): leave, resume, or rebuild at the device rate | 0 to ~3 s gap on rebuild | `rebuilds`, `interruptions` |
| Tab hidden, window minimised | `visibilitychange`; the desktop host forwards Tauri minimise | the policy (§3.8); ramps complete; streams pulled; STATUS slows | per policy | `backgroundEnters` |
| Underruns, late commands | the probe (§4.7); stamped records past their frame | counted; they feed the cap | `Audio.debug()`, editor play stat | `underruns`, `underrunFrames`, `lateCommands`, `minSlackFrames` |
| Decode error, truncated stream | worker typed error | 50 ms fade-out, one warning naming the asset | that sound stops | `decodeErrors` |
| Clip ceiling, failed `memory.grow` | loader accounting; `clip_reserve` error | refuse, keep playing, warn once; waiting voices end with `"failed"` | that clip silent | `refusedLoads`, `refusedWithFreeBytes` |
| Unknown codec | worker probe | one warning naming the clip and `audio.codecs.aac` | that clip silent | `decodeErrors` |
| Stream starvation | ring empty before end of stream | hold, silence, 5 ms fade-in on refill | dropout | `starved` |
| Worklet stall | no STATUS for 1 s while running and visible | hard rebuild | gap | `rebuilds` |
| Version mismatch | envelope major differs | refused, a flag, one warning (stale wasm) | silent | `versionMismatch` |

**Replay order:** RESET → BUS_CONFIG → BUS_MIX → MASTER → live voices by priority. Each PLAY is stamped, with `startOffsetFrames` = the last mirrored playhead + elapsed frames × pitch (wrapped for loops). One-shots that would have ended are dropped. Future `at` times are re-stamped. Paused voices replay paused. Streams reopen with a new epoch.

**Future extension, soft recovery (not M1):** keep the arena across a trap by re-instantiating over the same imported memory and adopting a checksummed clip directory (`myco_audio_adopt_arena`). M1's imported memory and deterministic init keep that option open without an ABI break. Build it only if the soak shows traps.

## 8. Observability

**Work units:** modelled costs the core adds per operation. 1 WU ≈ 1 ns on the reference machine (a u32 per quantum), in five categories (mixed voices, virtual voices, buses and effects, records, copied bytes). STATUS carries each period's last and max totals. Categories are computed only while the debug panel asks. WU drive the cap's ceiling and the informational benchmarks; the metered build (M1c) is what gates CI.

| Group | Counters |
|---|---|
| Timing | `underruns`, `underrunFrames`, `lateCommands`, max lateness, `minSlackFrames`, L, Λ |
| Load | `workUnits`, `workUnitsMax`, p99 over 250 ms (computed on main), budget, `mixedCap` |
| Voices | live, mixed, virtual, paused, waiting, HRTF-panned, `demoted`, `stolen`, `queuedPlays`, `droppedPlays` |
| Memory | arena used, reserved and ceiling; class-rounding waste; clips resident; `refusedLoads`, `refusedWithFreeBytes`; streams; `starved` |
| Health | `traps`, `recoveries`, `rebuilds`, `interruptions`, `decodeErrors`, `versionMismatch`, pool allocations, skipped STATUS posts |

`Audio.debug()` [API §1] adds a `core` block: context state, rate, `baseLatency` and `outputLatency`, L and Λ, transport (`postMessage` or ring), preset numbers, the groups above, and per voice the owner World and audibility in dB. **Bus meters:** per-bus, per-channel peaks over each STATUS period, decayed on main at −20 dB/s. **Editor (M1):** a meter strip in Project Settings > Audio during play (30 Hz), the debug panel (4 Hz, a copy), and an underrun play stat that turns red on any increment.

## 9. Cross-platform matrix

Versions were recalled at design time; **A0.6 and A0.7 confirmed them on 2026-11-09** (MDN browser-compat-data 8.1.8, Playwright WebKit and Firefox in a Linux container, WebKitGTK 2.52.6 in Docker, WebView2 on Windows; details in `docs/guide/audio-minimum-versions.md` and the build log). The loader probes features, not versions.

**Platforms by product (owner, 2026-11-09).** The editor targets desktop and the web browser only. Published games also target Android through Tauri, whose export is a future record extending 0041; the core runs there in the Android System WebView, on the same AudioWorklet path.

**Android (owner, 2026-11-09).** The low end is a starting point, not an absolute: significant gaps raise the low end to a more capable device class. The low-end soak device is an Android phone on the lowest Android version Google Play accepts for publishing apps, playing the web build in Chrome and the Android System WebView. A0.6 checks whether that version's browser and WebView get AudioWorklet and `simd128` (Chromium 91+). If not, the device runs the Babylon fallback and the soak measures that. Expect a phone CPU several times slower than the reference machine, and higher output latency than desktop. The "low" preset is sized from it.

| | Chrome / Edge | Firefox | Safari | WebView2 | WKWebView | WebKitGTK |
|---|---|---|---|---|---|---|
| AudioWorklet | 66 | 76 | 14.1 | evergreen | system Safari | yes (2.52.6) |
| wasm `simd128` (binding) | 91 | 89 | 16.4 | evergreen | Safari ≥ 16.4 | yes (2.52.6) |
| `getOutputTimestamp`, `outputLatency` | 57, 102 | 70, 70 | 14.1 (getOutputTimestamp) | yes | system Safari | present (Playwright WebKit) |
| Load into a suspended context | yes | yes (Playwright) | yes (Playwright WebKit) | yes | system Safari | yes (loads Locked, plays after the click) |
| Autoplay without a gesture | no | no | no | **yes by default** (running at load, no flags) | `mediaTypesRequiringUserActionForPlayback` none (confirm) | **no by default**: starts `interrupted` and needs the unlock layer's gesture; `media-playback-requires-user-gesture` off doesn't lift it; a construct-only website autoplay policy of ALLOW does, which wry/Tauri doesn't expose |
| `interrupted` state | no | no | yes | no | yes | confirm |
| SAB ring (isolation) | COOP/COEP | COOP/COEP | COOP/COEP | Tauri headers (confirm) | confirm | confirm |
| Spike evidence | real-time on Windows hardware | Linux container (157) | not run | A0.7: tone confirmed by WASAPI loopback (440 Hz) | not run | A0.7: tone confirmed in Docker by recording a PulseAudio null sink (440 Hz, the expected RMS); container timing, not a soak |

| Quirk | Source | Handling |
|---|---|---|
| First `AudioContext` takes 250–490 ms on Windows | `README` round 2 | create it at scene load, before the first presented frame |
| 3–4 quanta per ~10 ms callback | `messaging/` §2 | the burst rule, L's floor, Λ |
| The worklet has no `performance`, `TextDecoder`, `setTimeout` or `fetch`; it has `Date.now` (1 ms) | `messaging/` §1 | plain C ABI; the 24 ms probe; host-side timers |
| Playwright's Windows WebKit has no Web Audio | `README` | WebKit and Firefox tests run in Docker |
| Linux containers had no audio device | `README` | WebKitGTK real time is unverified until A0.7 and the soak |
| Output latency ~50 ms | `README` | Λ; documented |
| `isomp4` seek after EOF fails (symphonia 0.6.1) | `decode/` §5 | reopen for AAC loops |
| Seeks land up to 103 ms early | `decode/` §8 | the worker discards leading frames |
| Tauri minimise may not fire `visibilitychange` | confirm | the desktop host forwards window events |

**Babylon fallback (kept after M1 as the automatic fallback for engines that can't load the core).** The host builds AudioEngineV2 (`@babylonjs/core` 9.32.0) with `audioContext` set to the host's shared context, `resumeOnInteraction: false` and `resumeOnPause: false`, and with the unmute UI off. Unlock, `interrupted` handling and background policy therefore stay with the host, as with the core. Babylon modules are imported one by one, never from the barrel (CLAUDE.md). Spatial sound uses each browser's own `PannerNode`, so 3D sound differs by engine, which the core path avoids. `maxInstances` maps to bus `maxVoices` only approximately.

## 10. Extension points

| Milestone | M1 provides |
|---|---|
| M2 events and parameters | Containers run on main and play voices. Stamped records and `rampFrames` give automation; the id scheme can cover groups (a `group` field is added when M2's record needs it). `AudioHandle` has the right shape |
| M3 ambisonic bed | HRTF is already in M1 (§2.4). The bed becomes panner kind 2: the voice encodes into a shared 3rd-order bed, decoded once through the same HRIR set and microfft. Panner-kind crossfades and selection ranking already exist. The reserve is nearly spent (§6.1), so M3 re-budgets |
| M3 occlusion | The audio system's order is attenuation → occlusion slot → audibility → selection; per-voice `lpHz` exists; physics is reached through a World service key (0135) |
| M3 convolution (reverb zones) | M1's ported staged convolver; the scheduler knows the quantum index, so extra convolvers take tail phase offsets and never share a tail quantum |
| M4 music | stamped records, `at`, the heard clock |
| M5 profiler | STATUS sections are versioned and counted; WU categories |

## 11. Resolutions and open decisions

| Round-2 item (senior's review) | Resolution |
|---|---|
| C1 imported memory, `adopt_arena` | **Taken with change** (ruling 1): imported memory with `maximum` and deterministic init in M1; soft path documented as future (§7) |
| C2 `clip_chunk_ptr`, `stream_chunk_ptr` | Taken (§3.4, §3.5) |
| C3 STATUS, lists capped at 1,024 | Taken (§4.7); `loadPermille` reserved as 0 in M1 |
| C4 underrun constants | Taken: pseudocode and constants in §4.7, trace tests in §4.6 |
| C5 direction, `spatial` bit | Taken |
| C6 `owner`, main-only | Taken |
| C7 epoch, STREAM_CREDIT, MP3 without Xing | Taken (§3.4, §3.5) |
| C8 ready flag | Taken (§3.1) |
| C9 project ceiling not lowered by device class | Taken; M1 has no device-class selection anyway (§5.3) |
| C10 `audioFrameTime` hook | Taken (`HostClock.rafTime`) |
| C11 `maxVoices` steals | Taken (§2.2) |
| 1 soft trap recovery | Taken (ruling 1) |
| 2 lookahead on every sound | **Taken** (ruling 5): `asap` by default; L only for stamped records; no `audio.latency` setting in M1 |
| 3 metered wasm | **Taken with change** (ruling 3): kept, scheduled in M1c; informational benchmarks before then |
| 4 compacting arena | **Taken with change** (ruling 2): power-of-two slabs, reset on empty, no compaction (§5.2) |
| 5 adaptive cap and calibration | **Taken with change** (ruling 4): underruns, qualifying lates and `minSlackFrames`, with a WU ceiling; calibration and the load estimate are future |
| 6 `HostClock`, loopback | Taken (§4.6) |
| 7 STATUS buffer size | Taken: 16 KB × 8, and recycled in `onmessage` (my round-2 issue 1) |
| 8 view loss goes virtual; BUS_CONFIG while live | Taken: listed as a behaviour change (§2.2); remap by name (§3.9); owner decision 3 |
| 9 1 ms clock pseudocode | Taken (§4.7) |
| 10 suspended-context load | Taken: A0.6 verifies, with create-on-gesture as the fallback; load at scene load (§2.1, §9) |
| 11 shadow stack | Taken: 256 KB plus a high-water test |
| 12 no `group` field | **Changed by the coordinator:** a reserved `u16 group` stays in PLAY and the voice table with no meaning until M2, so M2 needs no wire version bump ([API §4.2]) |
| 13 PLAY doesn't ramp from zero | Taken (§4.3) |
| 0097 ducking counts every live voice | Taken (§1) |
| 0097 `CoreBackend` calls `voiceStarted/Ended` | Taken (§1) |
| 0098 failed backend, no automatic fallback | **Changed by the coordinator (round 3):** an automatic switch to Babylon at load when the core can't load; still silent after exhausted recoveries mid-session (§2.1, §7) |
| 0097 reverb: Freeverb vs the 1.8 s convolver | **Changed by the coordinator:** M1 keeps 0097's generated-IR convolver, using the spike's **non-uniform** convolver (0.07 ms average, ~0.3 ms p99.9 for 2 s stereo, `spatial/`), so there's no behaviour change. The uniform figure (~0.5 ms) doesn't apply. Round 3: Chromium's staged design, ported, on microfft (256 and 4,096 points, 14 KB), since rustfft's planners (300–400 KB) would break the 150 KB gate |
| 0097 filter Q in dB, compressor makeup | Taken: parity is a null test against an `OfflineAudioContext`, within the ADR's dB tolerance |
| 0097 bus remap while playing | Taken as a listed improvement |
| 0074 HRTF loss | **Decided (round 3):** M1 ports Chromium's HRTF panner (§2.4), gated on the data licence |
| 0098 fallback backend | **Decided (round 3):** Babylon AudioEngineV2 replaces Howler as the M1 fallback (§1, §9) |

**Decided by the owner (round 3)**

1. **HRTF in M1:** a port of Chromium's HRTF panner with its Composite HRIR data, for the nearest 16 spatial voices, on the condition that the data licence clears first. The fallbacks are SADIE II with the same code, or equal-power. Budget in §6.1, memory in §5.1.
2. **Estimate accepted:** the senior's revised plan ([API §9]), about 27 person-weeks, against the ADR's 16–18.
3. **Fallback backend:** Babylon AudioEngineV2 behind 0098, internal; `audio.backend` is `"babylon" | "core"`; Howler is deleted when it lands. Fallback rule (coordinator): an engine that can't load the core (no AudioWorklet or `simd128`, fetch or compile failure, ABI mismatch, no first STATUS in 5 s) switches to the Babylon backend **automatically at load**, with one warning. A core that loaded and then traps more than 3 times in 60 s goes **silent** (`"failed"`), with no switch mid-session. The Babylon backend stays after M1 as this permanent fallback, so older engines still get basic sound.
4. **Sound quality:** a manual listening pass backed by automated checks. Parity for the biquad, compressor, panner, distance, cone and HRTF is a null test against an `OfflineAudioContext` (Chromium), within the ADR's dB tolerance.
5. **Reuse:** port Chromium's Web Audio DSP (BSD, notices kept); microfft for FFTs; Kira, Firewheel and SoLoud for designs only.
6. **Also settled:** the reverb stays today's convolver design; Worlds that lose the view go virtual (a listed behaviour change); macOS stays a release gate only.

**ADR follow-up for the coordinator:** ADR 0157 names Howler as the M1 fallback and puts HRTF in M3. Both round-3 choices change accepted text, so per CLAUDE.md they need an amending record (or a revision note on 0157) before M1a.0.

**Still open**

Both owner items are now settled (2026-11-09):
1. **Listening pass:** the owner runs it, per effect, preset, resampler mode and HRTF, before each milestone ships.
2. **Low-end soak device:** an Android phone on the lowest Android version Google Play accepts for publishing apps (see §9). It defines the low preset's numbers (§5.3) and is part of the soak gate.
