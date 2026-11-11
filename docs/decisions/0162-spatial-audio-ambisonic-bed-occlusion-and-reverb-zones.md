# 0162. Spatial audio (M3): distant voices share a 3rd-order ambisonic bed, sources are occluded through physics rays on a frame budget, and reverb zones run on M1's convolver

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0157 (the high preset's HRTF voices and audio-thread total; "spatial (M3) is a separate lazy module"; architecture §10's rule that extra convolvers never share a tail quantum), 0158 (`myco.audioevent@1` gains optional `filter` and `sends`), 0074 (spatial sources gain Doppler and occlusion fields)
- **Related:** 0157 (roadmap M3; the core, voices, panner kinds, presets, budgets), 0158 (events; automation; effects per event deferred to M3), 0097 (buses, effects), 0040 (sidecars), 0133 (plugins), 0135 (World services: physics), 0143 (asset kinds), 0161 (Proposed: asset lookup caching)

## Glossary

Plain-language meanings of the terms this record uses.

- **Quantum:** the audio core's unit of work: 128 samples, 2.67 ms at 48 kHz. Every cost below is "per quantum" unless it says "per frame" (a game frame on the main thread).
- **Panner:** the stage that places a mono voice in the stereo (or headphone) image. M1 has two **panner kinds**: 0 equal-power (left/right by level) and 1 **HRTF**.
- **HRTF / HRIR:** a head-related transfer function describes how sound from one direction reaches each ear; the **HRIR** is the same thing as a pair of short impulse responses (one per ear). Convolving a voice with the HRIR pair for its direction makes it sound as if it came from there on headphones (**binaural**). M1 does this per voice for the nearest voices, with IRCAM's public HRIR set.
- **Ambisonics:** a way to describe a whole sound field, from every direction, as a fixed set of channels instead of as separate sources. The **order** sets the detail: 1st order has 4 channels, 2nd 9, **3rd order 16**. Higher orders place sources more sharply.
- **Bed:** one shared ambisonic mix that many voices are added into (**encoded**). Encoding a voice is cheap (16 gains); the bed is turned into headphone sound once (**decoded**) no matter how many voices it holds.
- **Binaural decode / MagLS:** turning the 16-channel bed into the two ear signals using HRIRs. **MagLS** ("magnitude least squares") is a decoding method that matches the HRIRs' timing at low frequencies and only their loudness at high frequencies, which keeps high frequencies sharp at 3rd order.
- **ACN / SN3D / AmbiX:** the standard channel order (ACN) and scaling (SN3D) of ambisonic signals; **AmbiX** is the file convention that uses both. **FuMa** is an older convention, converted on import.
- **Ambisonic clip (B-format):** a recording of a whole sound field (a forest, a city) stored as ambisonic channels. Playing it means rotating it as the listener turns and adding it into the bed.
- **Occlusion / obstruction / transmission:** **occlusion** is a sound muffled because something solid is between it and the listener; **transmission** is how much passes through (quieter, and duller: high frequencies are lost first, which a **low-pass** filter models). (**Obstruction**, where the direct path is blocked but reflections still arrive, is a later refinement.)
- **Ray cast:** asking the physics engine "what does a line from here to there hit first?"
- **Convolution reverb / impulse response (IR):** reverb made by convolving the sound with a recording of how a real or modelled room responds to a click (the **impulse response**). Long IRs (seconds) are expensive; **partitioned** convolution splits the IR into blocks, and **non-uniform** partitioning uses small blocks for the start (low latency) and large ones for the **tail** (cheap).
- **Reverb zone:** a region of the scene with its own reverb; as the listener moves between zones the reverbs **blend**.
- **Send:** a copy of a voice's sound routed to an effect (here, a reverb zone) at a chosen level.
- **Doppler:** the pitch rise of a sound moving toward the listener and fall moving away.
- **Worklet / main thread:** the core runs in the browser's **AudioWorklet** (the audio thread); scripts, physics and the voice table run on the **main thread**.
- **p50 / p99 / p99.9:** the cost that half, 99% and 99.9% of quanta (or frames) stay under.

## Context

0157's roadmap names M3: "A 3rd-order ambisonic bed for distant voices (per-voice HRTF moved into M1). Occlusion through physics ray queries under a frame-share budget. Reverb zones; non-uniform convolution; Doppler." 0158 deferred "effects per event (an event's own filter or send)" to M3 with reverb zones. Each roadmap milestone gets its own record; this is M3's.

**The owner's goal and constraints** (step 1, confirmed 2026-11-11, [docs/design/0162-audio-spatial/goal.md](../design/0162-audio-spatial/goal.md)): AAA spatial audio built in, open source only; scope is everything the roadmap and design docs name for M3 **plus ambisonic clips**; editor components for reverb zones and occluders; **best effort** on the Babylon fallback; the budget is option (c): M3 gets its own audio-thread budget **and** makes room by mixing fewer per-voice HRTF voices where the bed takes distant voices; phone numbers stay unverified for now.

**What exists** (M1, M2): per-voice HRTF for the nearest voices (16 on the high preset), panner kinds 0 and 1 with crossfades and selection ranking, PLAY's `panner` bits 2–3 reserved for the bed and a reserved `LISTENER` command (0x20); M1's ported Chromium staged convolver (a bus effect today); per-voice and per-bus low-pass; M2's automation and event instances; physics as a World service with `Physics.raycast(origin, dir, maxDistance, layers?)` (first hit, layer mask).

**Measurements** ([spikes/audio-spatial/README.md](../../spikes/audio-spatial/README.md), idle container, ≥ 7 runs; p50/p99 are solid here, p99.9 and max are not: they track the shared VM's scheduling and wait for the lab VM):

| Item | Measured (wasm unless noted) |
|---|---|
| Bed, 256 voices + MagLS decode | p50 142 µs (Chromium worklet 175 µs), p99 262 µs; encode ≈ 0.5 µs per voice vs ≈ 13 µs per HRTF voice; decode alone ≈ 20 µs; bit-identical native / wasm / Chromium |
| Decode accuracy (MagLS on M1's HRIRs) | cues point the right way at 12/12 azimuths; within 1.7 dB of M1's per-voice HRTF below 2 kHz. Plain least-squares and virtual speakers lose 5–12 dB at the near ear above 2 kHz. **Below −45° elevation M1's HRIR set has no data**: the timing cue collapses and levels are off 8–20 dB above 4 kHz |
| 3rd-order ambisonic clip, rotate + decode | p50 23 µs (1st order 7 µs) |
| Doppler on 256 voices | no measurable cost over constant pitch |
| HRTF → bed crossfade, 16 voices | one quantum at ≈ 242 µs; a 1–4 dB dip for that quantum (not yet listened to) |
| Reverb zone, stereo 2 s / 4 s IR | p50 20 / 30 µs, p99 72 / 76 µs; linear in zones (8 × 2 s ≈ 263 µs p50); **3.1 / 6.1 MB per zone**; M1's convolver is already non-uniform |
| Preparing an IR | 1.3 / 2.5 / 5.3 ms at once (1 / 2 / 4 s): too long for the audio thread; spread over quanta +23 µs for 0.47 s or +84 µs for 0.12 s |
| Event filter and send | ≈ 0.85 µs per instance; a send ≈ 0.01 µs |
| Occlusion ray (engine physics, main thread) | 3.1–3.7 µs, ≈ 300 rays/ms; 0.25 ms/frame refreshes every source within 3 frames (64 sources), 5 (256), 22 (1,024) |
| Symphonia and ambisonic files | reads 4- and 16-channel WAV (file order); **no Opus decoder**; M1's clip arena refuses clips over 2 channels |

**Survey** ([research](../../spikes/audio-spatial/research/README.md)): no library to depend on. Spatial Audio Framework (core ISC) and Resonance Audio (Apache-2.0, archived 2023) as references; libspatialaudio (LGPL) and the IEM suite (GPL) reference only; Steam Audio (Apache-2.0) as a possible later layer for frequency-dependent transmission.

## Decision (proposed)

**Spatial audio is built in the core and on the main thread along 0157's and 0158's split: the core does everything continuous per quantum (the bed, decoding, convolution, smoothing, Doppler pitch), and main does event-driven and budgeted work (ray casts on a frame budget, zone weights, selection).**

### 1. The ambisonic bed (panner kind 2)
- A **3rd-order** bed (16 channels, ACN/SN3D) in the core. Spatial voices that selection doesn't give an HRTF slot are **encoded into the bed** (panner kind 2) instead of panned equal-power; the bed is decoded once per quantum to binaural with **MagLS** filters baked offline from M1's HRIR set and shipped as an asset (≈ 64 KB). Panner-kind crossfades between 1 and 2 reuse M1's mechanism.
- **HRTF voices on the high preset go from 16 to 8** (the owner's option c: the bed takes the rest at ≈ 0.5 µs a voice instead of ≈ 13). Low keeps its count; the preset table states the new numbers.
- Below −45° elevation (no HRIR data), the baked filters fill the missing directions under a regularisation term (the spike's method) for now; better data (SADIE II, Apache-2.0, already named as M1's fallback set) is an open question.
- Equal-power output (`audio.spatial: "equalPower"`) stays available; the bed then decodes to equal-power stereo instead of binaural.

### 2. Ambisonic clips
- **AmbiX** clips of 1st, 2nd and 3rd order (4, 9, 16 channels) in **WAV or FLAC**; FuMa clips are converted on import (sidecar flag). Opus ambisonics are out (no decoder).
- A clip plays as an ordinary voice whose channels are **rotated by the listener's orientation** and added into the bed (so it is decoded with everything else); it has a gain and a bus, no position.
- M1's clip arena and the decoder path grow from 2 to **16 channels**.
- The reserved **`LISTENER`** command (0x20) carries the listener's orientation (a quaternion) per frame for clip rotation; voices keep their listener-space directions from main.

### 3. Occlusion
- Main casts rays through the physics World service on a **frame budget: 0.25 ms by default, 0.5 ms on "high"** (`audio.occlusion.budgetMs`), inside 0157's "occlusion ≤ 6% of a frame". Each frame: one centre ray for each of the **16 most audible** occluded-capable sources, then **round-robin** over the rest; extra rays (up to 3, through up to 3 occluders) only for the top few.
- Rays hit only colliders on the **`AudioOccluder`** physics layer, which the new **`AudioOccluder` component** puts its collider on, with a **material** (transmission in dB and a low-pass cutoff from a table: wood, concrete, glass, metal, cloth…).
- The result is a per-voice **occlusion gain and low-pass** sent with the voice's parameters; the core smooths them (≈ 100 ms) so changes don't zipper; selection's audibility includes the occlusion gain (with M2's no-gap rule: the larger of current and target until the smoothing settles).
- `AudioSource.occlusion` (default on for spatial sources) and an event-level `occlusion` flag opt out.

### 4. Reverb zones
- The new **`AudioReverbZone` component**: a box or sphere volume, an **IR asset** (a stereo WAV/FLAC; a few procedural presets ship), a wet level and a **blend distance**. Main computes each zone's weight from the listener's position (overlaps blend equal-power) and sends zone weights with the frame's batch.
- Each active zone is one **M1 staged convolver** in the core (already non-uniform). Voices reach zones through **sends**: a bus's and a voice's (or event's) `reverbSend` level times the zone weights. **At most 2 active zones blend at a time** on high, 1 on low (presets), beyond which the weakest fade out.
- Zone convolvers' tail work is **staggered by load** (a planner balancing the modelled work per quantum), which replaces architecture §10's "extra convolvers never share a tail quantum" (true only up to 4 zones, and worse than balancing).
- **IRs are prepared off the audio thread** (in the decoder worker, which already runs wasm; the spectra are copied into the core's zone memory), or spread across quanta if the worker isn't available; never at once on the audio thread (1.3–5.3 ms).
- Zone memory is a preset budget (high: 2 zones × 4 s ≈ 12 MB; low: 1 × 2 s ≈ 3 MB), stated in the presets and visible in the debug panel.

### 5. Doppler
- Per-source **Doppler** from the relative radial velocity (main computes velocities from position deltas each frame for moving spatial voices), as a pitch factor clamped to ±1 octave and smoothed in the core; `AudioSource.dopplerLevel` (0 off, 1 physical, default 1) and a project-wide speed of sound (`audio.speedOfSound`, default 343 m/s).

### 6. Effects per event (from 0158)
- `myco.audioevent@1` gains two optional keys (additive; the format stays `@1`): `filter` (`{ type: "lowpass" | "highpass", cutoff, q? }`, automatable like volume) applied to the instance's voices, and `sends` (`{ reverb: level }` and named effect buses) per event or node. The core keeps one filter per instance (`group`).

### 7. The Babylon fallback (best effort)
- No bed: every spatial voice uses Babylon's panner (HRTF where it supports it). Reverb zones: one `ConvolverNode` per active zone (at most 1), blended by gain. Occlusion: the existing per-voice low-pass and gain. Doppler: playback rate. Ambisonic clips: 1st order decoded to stereo (W and Y), higher orders truncated to 1st order, with one warning. Event filters: a `BiquadFilterNode` per instance.

### 8. Budgets (provisional until the technical design's task table and the lab-VM run)
- **Audio thread (high preset):** a typical M3 scene (bed with ≈ 240 voices and its decode, one 3rd-order clip, two blending 2 s zones, 16 event filters) measures ≈ 0.23 ms p50 / ≈ 0.44 ms p99 on the container; with HRTF voices 16 → 8 saving ≈ 0.09 ms, **M3 adds ≈ 0.21 ms (est.)** beyond 0157's remaining reserve, so **the high preset's audio-thread total rises by that much**; the technical design states the new total against 0157's 75%-of-period rule and the 2× reference-machine assumption.
- **Main thread:** occlusion 0.25 ms per frame by default (0.5 ms high).
- **Memory:** zones as above; bed and decoder ≈ 110 KB.
- **Sizes:** the bed, clip rotation and zone management build **into the mixer wasm** (measured increments: convolver + preparation +27 KB; the bed's increment is measured in the design), not a separate lazy module: a second wasm module in the worklet would need its own memory and a copy of the bed every quantum. This amends 0157's "spatial (M3) is a separate lazy module"; the mixer's tripwire stays (0158).

### 9. Editor
- **`AudioReverbZone`** and **`AudioOccluder`** are components with gizmos (zone volumes and blend distances drawn; occluders tinted by material), placed like colliders; the Inspector edits them; New Reverb Zone in the create menu.
- An **occlusion debug view** (rays and results in the viewport, toggled from the Audio Debug panel) and zone weights and memory in the Audio Debug panel.

## Alternatives considered

- **Per-voice HRTF for every spatial voice** (no bed). Simplest, best per-voice accuracy, but ≈ 13 µs a voice: 256 spatial voices would take > 1 quantum's worth of budget. The bed exists for distant voices.
- **1st- or 2nd-order bed.** Cheaper decode (4 or 9 channels), but blurrier placement; the 3rd-order bed already costs ≈ 0.5 µs a voice.
- **Virtual-loudspeaker or plain least-squares decode.** Measured 5–12 dB too dull at the near ear above 2 kHz; MagLS costs the same at run time.
- **Steam Audio or Resonance as a dependency.** Steam Audio is C/C++ with threads and SIMD paths that don't fit the single-threaded worklet; Resonance is archived. Both stay references; Steam Audio's frequency-dependent transmission is a possible later layer.
- **Occlusion in the core** (ray casting in Rust). The physics world lives on main (Rapier through a World service); duplicating geometry into the core costs memory and sync for no gain at 300 rays/ms.
- **Occlusion against every collider.** Gameplay colliders (triggers, small props) would muffle sound wrongly; an explicit `AudioOccluder` layer is what designers expect and keeps rays cheap.
- **Algorithmic reverb (Freeverb-style) for zones.** Cheaper and memory-light, but a different sound from M1's convolution reverb (a behaviour change 0157's review already rejected for the bus reverb); a possible low-preset option later.
- **Preparing IRs at once on the audio thread.** 1.3–5.3 ms: a guaranteed underrun.
- **A separate lazy spatial wasm module** (0157's line). Would need its own memory and a per-quantum copy of the bed between modules; the increment is small.

## Consequences

**Positive**
- Hundreds of spatial voices with headphone placement at ≈ 0.5 µs each; ambisonic ambiences; walls that muffle; rooms that sound different; Doppler; per-event filters and sends.
- Designers place zones and occluders in the editor like colliders.
- Reuses M1's HRIR set, convolver, panner-kind crossfades and selection, and M2's automation and no-gap rule.

**Negative / costs**
- The high preset's audio-thread total rises (≈ 0.21 ms est.); the low preset gets 1 zone and fewer bed voices if the phone needs it.
- Reverb zones cost megabytes each.
- Below-horizon placement is approximate with M1's HRIR data.
- HRTF voices on high halve (16 → 8): the nearest 8 keep per-voice HRTF, the rest move to the bed (≈ 1–4 dB dip at the switch, to be listened to).
- Two new components, a physics layer, new project settings, wire changes (LISTENER, panner kind 2, zone and occlusion fields), and the clip arena's channel count.
- **Estimate (provisional; the technical design's task table sets the real one):** ≈ 13 person-weeks for the runtime (bed, clips, occlusion, zones, Doppler, event effects, fallback) and ≈ 4 for the editor (components, gizmos, debug views), plus a sample and the listening pass.

## Deprecates

Architecture §10's "extra convolvers never share a tail quantum" (replaced by load-balanced staggering). 0157's "spatial (M3) is a separate lazy module" (replaced by building into the mixer).

## Open questions

- **Better HRIR data below the horizon** (SADIE II) vs regularisation: the owner's listening pass decides.
- **IR preparation in the decoder worker** (unmeasured) vs spread across quanta.
- **Obstruction** (direct path blocked, reflections open) and frequency-dependent transmission (Steam Audio's 3 bands): later.
- **Occluders that move** (doors) and trimesh occluders: covered by the same rays, not yet measured.
- The lab-VM and phone numbers for every budget above.

## References

- [docs/design/0162-audio-spatial/goal.md](../design/0162-audio-spatial/goal.md) (owner-confirmed goal); [spikes/audio-spatial/README.md](../../spikes/audio-spatial/README.md) and its `bed/`, `convolution/`, `occlusion/`, `research/` READMEs.
- ADR 0157 (roadmap M3, sizes, budgets), `docs/design/0157-audio-core/architecture.md` §2.4, §6, §10; ADR 0158 (open question: effects per event).
- `native/audio/crates/audio-dsp/src/convolver.rs`, `hrtf/`; `src/plugins/audio/runtime/AudioSource.ts`; the physics plugin's `Physics.raycast`.
