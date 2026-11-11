# 0162. Spatial audio (M3): distant voices share a 3rd-order ambisonic bed, sources are occluded through physics rays on a frame budget, and reverb zones run on M1's convolver

- **Status:** Proposed (revision 2, after the RFC round in `docs/rfc/0162/`; see "RFC round" at the end)
- **Date:** 2026-11-11
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0157 ("spatial (M3) is a separate lazy module"; architecture §10's rule that extra convolvers never share a tail quantum; the presets gain M3's settings), 0158 (`myco.audioevent@1` gains optional `filter`, `sends` and `occlusion`), 0074 (spatial sources gain Doppler, occlusion and reverb-send fields)
- **Related:** 0157 (roadmap M3; the core, voices, panner kinds, presets, budgets), 0158 (events, automation, effects per event deferred to M3), 0097 (buses, effects), 0040 (sidecars), 0005 (physics layers), 0133 (plugins), 0135 (World services: physics), 0143 (asset kinds), 0161 (Proposed: asset lookup caching)

## Glossary

Plain-language meanings of the terms this record uses.

- **Quantum:** the audio core's unit of work: 128 samples, 2.67 ms at 48 kHz. Costs are "per quantum" unless they say "per frame" (a game frame on the main thread).
- **Panner:** the stage that places a mono voice in the stereo (or headphone) image. M1 has two **panner kinds**: 0 equal-power (left/right by level) and 1 **HRTF**.
- **HRTF / HRIR:** a head-related transfer function describes how sound from one direction reaches each ear; the **HRIR** is the same thing as a pair of short impulse responses (one per ear). Convolving a voice with the HRIR pair for its direction makes it sound as if it came from there on headphones (**binaural**). M1 does this per voice for the nearest voices, with IRCAM's public HRIR set.
- **Ambisonics:** a way to describe a whole sound field, from every direction, as a fixed set of channels instead of as separate sources. The **order** sets the detail: 1st order has 4 channels, 2nd 9, **3rd order 16**. Higher orders place sources more sharply.
- **Bed:** one shared ambisonic mix that many voices are added into (**encoded**). Encoding a voice is cheap (16 gains); the bed is turned into headphone sound once (**decoded**) however many voices it holds.
- **Binaural decode / MagLS:** turning the 16-channel bed into the two ear signals using HRIRs. **MagLS** ("magnitude least squares") matches the HRIRs' timing at low frequencies and only their loudness at high frequencies, which keeps high frequencies sharp at 3rd order.
- **ACN / SN3D / AmbiX:** the standard channel order (ACN) and scaling (SN3D) of ambisonic signals; **AmbiX** is the file convention that uses both. **FuMa** is an older convention, converted on import.
- **Ambisonic clip (B-format):** a recording of a whole sound field (a forest, a city) stored as ambisonic channels. Playing it means rotating it as the listener turns and adding it into the bed.
- **Occlusion / obstruction / transmission:** **occlusion** is a sound muffled because something solid is between it and the listener; **transmission** is how much passes through (quieter, and duller: high frequencies go first, which a **low-pass** filter models). **Obstruction** (the direct path blocked, reflections still open) is a later refinement.
- **Ray cast:** asking the physics engine "what does a line from here to there hit first?"
- **Convolution reverb / impulse response (IR):** reverb made by convolving the sound with a recording of how a room responds to a click (the **impulse response**). Long IRs are expensive; **partitioned** convolution splits the IR into blocks, and **non-uniform** partitioning uses small blocks for the start (low latency) and large ones for the **tail** (cheap).
- **Reverb zone:** a region of the scene with its own reverb.
- **Send / wet / dry:** a **send** is a copy of a voice's sound routed to an effect (here, a zone's reverb) at a chosen level; the reverb's output is the **wet** sound, the voice's own is the **dry** sound.
- **Doppler:** the pitch rise of a sound moving toward the listener and fall moving away.
- **Worklet / main thread:** the core runs in the browser's **AudioWorklet** (the audio thread); scripts, physics and the voice table run on the **main thread**.
- **p50 / p99 / p99.9:** the cost that half, 99% and 99.9% of quanta (or frames) stay under. 0157's budgets are set at **p99.9**.
- **Feature flag:** a project setting that turns a feature on; off means the engine behaves as before.

## Context

0157's roadmap names M3: "A 3rd-order ambisonic bed for distant voices (per-voice HRTF moved into M1). Occlusion through physics ray queries under a frame-share budget. Reverb zones; non-uniform convolution; Doppler." 0158 deferred "effects per event (an event's own filter or send)" to M3. Each roadmap milestone gets its own record; this is M3's.

**The owner's goal and constraints** (confirmed 2026-11-11, [docs/design/0162-audio-spatial/goal.md](../design/0162-audio-spatial/goal.md)): AAA spatial audio built in, open source only; scope is everything the roadmap and design docs name for M3 **plus ambisonic clips**; editor components for reverb zones and occluders; **best effort** on the Babylon fallback; budget option (c): M3 gets its own audio-thread budget **and** makes room with fewer per-voice HRTF voices where the bed takes distant voices; phone numbers unverified for now.

**What exists** (M1, M2): per-voice HRTF for the nearest voices (`voices.hrtf`, default 16), panner kinds 0 and 1 with crossfades and selection ranking; PLAY's `panner` field (flags bits 5–6) with values 2–3 reserved and a reserved `LISTENER` command (0x20); voices mix into their **bus**, where effects, ducking, meters and gain run (`audio-core/src/bus.rs`), and M1's HRTF output joins the voice's bus (`panner.rs`); M1's staged non-uniform convolver (one shared reverb fed by bus `reverb` effects); per-voice low-pass **only for voices with an automation binding** (M2, E2; `voices.rs` "`lpHz` not applied yet" otherwise); M2's automation and event instances; physics as a World service with `Physics.raycast(origin, dir, maxDistance, layers?)` (3D; first hit; a collider has **one** layer, ≤ 16 layers, `Collider.ts`); 2D games use a separate `Physics2D` service.

**Measurements** ([spikes/audio-spatial/README.md](../../spikes/audio-spatial/README.md), idle container, ≥ 7 runs). p50 and p99 are solid on this container; **p99.9 and max are not** (single quanta of 1–30 ms track the shared VM's scheduling, native code included). On the lab VM, 0157's high preset already measures **5.45 ms p99.9 against the 1.3 ms budget** (architecture §6.1: "it doesn't fit on the lab machine"; the owner's decision for M1 was an adaptive cap that moves only on real trouble).

| Item | Measured (wasm unless noted) |
|---|---|
| Bed encode | ≈ 0.5 µs per voice (encode only; each bed voice is still a mixed voice at 3.0–3.8 µs, architecture §6.1) |
| Bed, 256 voices + MagLS decode | p50 142 µs (Chromium worklet 175 µs), p99 262 µs; decode alone ≈ 20 µs; bit-identical native / wasm / Chromium |
| Decode accuracy | cues right at 12/12 azimuths; within 1.7 dB of M1's HRTF below 2 kHz; plain least-squares and virtual speakers lose 5–12 dB at the near ear above 2 kHz. **Below −45° M1's HRIR set has no data**: timing cue collapses, levels off 8–20 dB above 4 kHz |
| HRTF voices 16 → 8 | saves ≈ 55 µs (the spike's 94 µs counted kernel work that M1 caps per quantum, `KERNEL_BUDGET`) |
| 3rd-order ambisonic clip | rotate + decode p50 23 µs; 1st order 7 µs |
| Doppler | no measurable cost over constant pitch |
| HRTF → bed switch | a 1–4 dB dip for one quantum (not yet listened to) |
| Reverb zone, stereo 2 s / 4 s | p50 20 / 30 µs, p99 72 / 76 µs; linear in zones; **3.1 / 6.1 MB each**; M1's convolver is already non-uniform; its size is set at the context's rate |
| Preparing an IR | 1.3 / 2.5 / 5.3 ms at once (1 / 2 / 4 s): never on the audio thread |
| Event filter | ≈ 0.85 µs per instance (spike: 4 unpanned voices summed) |
| Occlusion ray | 3.1–3.7 µs, ≈ 300 rays/ms (main thread); 0.25 ms/frame refreshes every source within 3 frames (64), 5 (256), 22 (1,024) |
| Files | symphonia reads 4- and 16-channel WAV; **no Opus decoder**; **FLAC holds at most 8 channels**; a 16-channel minute is ≈ 92 MB (16-bit); M1's clip arena refuses > 2 channels |

**Survey** ([research](../../spikes/audio-spatial/research/README.md)): no library to depend on. Spatial Audio Framework (core ISC) and Resonance Audio (Apache-2.0, archived) as references; libspatialaudio (LGPL) and IEM (GPL) reference only; Steam Audio (Apache-2.0) as a possible later layer for frequency-dependent transmission.

## Decision (proposed)

**Spatial audio follows 0157's and 0158's split: the core does everything continuous per quantum (beds, decoding, convolution, filters, gains), and main does event-driven and budgeted work (ray casts on a frame budget, smoothing of occlusion, zone weights, Doppler pitch, selection). Every M3 feature sits behind a feature flag; existing projects sound as before until a flag is on; the defaults flip only after the owner's listening pass.**

### 1. The ambisonic bed (panner kind 2), one per bus
- A **3rd-order** bed (16 channels, ACN/SN3D). With `audio.bed` on, spatial voices that selection doesn't give an HRTF slot are **encoded into their bus's bed** (panner kind 2) instead of panned equal-power; each bed is **decoded once per quantum into its bus's stereo buffer, before the bus's effects, ducking and meter**, so buses keep working as today. Beds exist only on buses that hold bed voices, up to a preset limit (high: 4, default: 2, low: 0, where voices stay equal-power); a bus beyond the limit pans its voices equal-power.
- The decode uses **MagLS** filters baked from M1's HRIR set (≈ 64 KB), prepared at the context's sample rate at load.
- **HRTF voices:** with the bed on, the high preset's `voices.hrtf` is 8 (saving ≈ 55 µs); a project's stored number isn't changed, and with the bed off nothing changes.
- **Below −45°** the filters fill the missing directions under regularisation. Whether that's acceptable, or SADIE II (Apache-2.0, M1's named fallback set) replaces the data, is decided by the owner's listening pass (a sound on the floor below), **before** `audio.bed` defaults on.
- Equal-power output (`audio.spatial: "equalPower"`) decodes beds to equal-power stereo.
- The panner change from HRTF (kind 1) to the bed (kind 2) reuses M1's crossfade; the dip it measures is a listening-pass item.
- Source **spread** (size) is deferred; the encoder leaves room for an order-weighted spread.

### 2. Ambisonic clips
- **AmbiX** clips: 1st order (4 channels) in WAV or FLAC; 2nd and 3rd order (9, 16 channels) in **WAV only** (FLAC stops at 8 channels). Opus is out (no decoder).
- A clip is ambisonic only by its sidecar: `ambisonic: { order, convention: "ambix" | "fuma" }` (0040); a 4-channel WAV without it is quad. FuMa is converted on import.
- A clip plays as a voice of a new kind (a PLAY flag bit) whose channels are **rotated by the listener's orientation** and added into its bus's bed; it has a gain, a bus, a **yaw offset** (so the recording's front lines up with the level) and a reverb send. Without a bed on its bus it decodes to binaural on its own.
- Ambisonic clips **stream by default** (a 3rd-order minute is ≈ 92 MB): the stream path and M1's clip arena grow from 2 to **16 channels**.
- The reserved **`LISTENER`** command (0x20) carries the listener's orientation for clip rotation; voices keep their listener-space directions from main.

### 3. Occlusion
- With `audio.occlusion` on, main casts rays through the **3D** physics World service on a **frame budget: 0.25 ms by default, 0.5 ms on high, 0.06 ms (≈ 16 rays) on low** (`audio.occlusion.budgetMs`), inside 0157's "occlusion ≤ 6% of a frame". Rays go to the **16 sources with the highest audibility before occlusion** each frame (so a muffled source isn't recast less often), then **round-robin** over the rest; one ray per source by default, up to 3 through up to 3 occluders for the top few on high. When a frame's budget runs out, the rest keep their last result; the debug view shows each result's age.
- **What occludes:** rays test the physics layers in `audio.occlusion.layers` (default: every layer except triggers), so no collider changes layer; a hit collider's material comes from an optional **`AudioOccluder` component** on its node (transmission in dB and a low-pass cutoff from a table: wood, concrete, glass, metal, cloth…), else the project's default occluder material (`audio.occlusion.defaultMaterial`).
- **Main owns the smoothing** (≈ 100 ms, ≈ 60 ns per source): it sends each voice's occlusion gain and low-pass with ramps, and selection's audibility uses the smoothed value with M2's no-gap rule.
- Occlusion attenuates the **dry** path fully and the **wet** (reverb send) by `wetOcclusion` (per material, default 0.5), so a sound behind a wall in a reverberant room still sounds reverberant.
- The core applies **per-voice low-pass to every voice whose cutoff is below the top** (today only automation-bound voices are filtered), sharing the filter with 0158's `lowpass` automation (lowest cutoff wins).
- `AudioSource.occlusion` (default on for spatial sources), a `playOneShot` option, and an event-level `occlusion` flag opt out. A 2D game, or a scene without the 3D physics service, has no occlusion (one note in the debug panel if `AudioOccluder` components exist); audio never starts the physics service.
- `Audio.debug()` gives an **`occluded`** cause on voices, and the debug view says which of occlusion, bus, snapshot or automation set a voice's low-pass.

### 4. Reverb zones
- The new **`AudioReverbZone` component**: a box or sphere volume, an **IR** (an `audio` clip; a few procedural presets ship), a wet level and a **blend distance** (outside the volume, over which the zone fades in).
- **Zone weights are per source** (owner decision 1, recommended): each voice sends to the zone(s) containing **its** position (blending at boundaries), so a footstep in a cave heard from the street sounds like the cave. The send level is the voice's `reverbSend` (default 1 for spatial sources) times a **send-versus-distance curve** (0158's curve type; default a gentle rise from `minDistance`), times the zone weight, times `wetOcclusion`.
- Each active zone is one **M1 staged convolver**; at most **2 active zones** on high and default, **1 on low** (a 1 s IR); with more zones in use, the two with the most send energy play and the editor warns when a scene's layout needs more. Zone convolvers' tail work is **staggered by load** (a planner balancing modelled work per quantum), replacing architecture §10's "never share a tail quantum".
- **IRs are prepared off the audio thread** (in the decoder worker, at the context's sample rate; spread across quanta if the worker isn't available); never at once on the audio thread. A rate change or a hard rebuild re-prepares them; zones are part of the rebuild's REPLAY.
- The bus `reverb` effect (M1's shared reverb) keeps working; it is what a voice hears when no zone holds it.
- Zone memory is a preset budget (high 2 × 4 s ≈ 12 MB; default 2 × 2 s ≈ 6 MB; low 1 × 1 s ≈ 1.7 MB), shown in the debug panel.

### 5. Doppler
- With `audio.doppler` on, main computes a Doppler factor from the source's and **listener's** velocities (position deltas each frame), clamped to ±1 octave, with a **teleport guard** (no Doppler for a delta beyond `audio.doppler.maxSpeed`), and folds it into the voice's existing `pitch` with a ramp (no new core state; the playhead tracker stays right). `AudioSource.dopplerLevel` (default 1 for spatial sources; `playOneShot` and events opt in), `audio.speedOfSound` in **world units per second** (default 343). A hidden tab resets it.

### 6. Effects per event (from 0158)
- `myco.audioevent@1` gains optional keys (additive; the format stays `@1`): `filter: { lowpass?, highpass? }` (cutoffs in Hz; `lowpass` combines with automation's `lowpass` target, lowest wins), `sends: { reverb?: level, <effect bus name>?: level }`, and `occlusion` (on/off). Filters apply **per voice** of the instance (voices are panned one by one, so a filter can't follow panning); the core uses the per-voice filter of §3.

### 7. The Babylon fallback (best effort)
- No bed: every spatial voice uses Babylon's panner (HRTF where available). Reverb zones: one `ConvolverNode` for the zone with the most send energy. **Occlusion is gain only** (the fallback has no per-voice filter today; owner decision 4). Doppler: playback rate. Ambisonic clips: W played as mono, one warning. Event filters: skipped, one warning, as `lowpass` automation is today.

### 8. Budgets
- **The statistic is p99.9 (0157).** This container can't give it, so M3's acceptance needs the **lab-VM run** (owner, as for M2) of an integrated `audio-bench` M3 scene (paced, with beds, a clip, zones and filters) plus the **metered gate**'s instruction counts in CI.
- **The cost, modelled from p50/p99 on the container (est.):** a typical M3 scene (2 beds with ≈ 240 voices, one 3rd-order clip, 2 blending 2 s zones, per-voice filters on ≈ 32 voices) ≈ 0.27 ms p50, ≈ 0.5 ms p99; with HRTF voices 16 → 8 saving ≈ 0.055 ms, **≈ 0.22 ms net (est.)**. The high preset already exceeds 0157's 1.3 ms on the lab VM; M3 adds to it, and the adaptive cap (the owner's M1 decision) keeps protecting the output. The presets' M3 numbers are set from the lab-VM run, not from this estimate.
- **Main thread:** occlusion 0.25 ms per frame by default; main's smoothing and Doppler ≈ 60 ns per source.
- **Memory:** zones as above; beds and decoder ≈ 110 KB.
- **Sizes:** beds, clip rotation and zone management build **into the mixer wasm**, not a separate lazy module (a second module in the worklet would need its own memory and a per-quantum copy of every bed). This amends 0157's line; the mixer's tripwire stays.

### 9. Editor
- **`AudioReverbZone`** and **`AudioOccluder`** are components with gizmos (zone volumes and blend distances; occluders tinted by material), through `src/editor/sdk` (a gizmo contribution the audio plugin doesn't have yet); the occluder material table is editable in Project Settings > Audio.
- An **occlusion debug view** (rays, results and their age) and zone weights and memory in the Audio Debug panel; occlusion, zones and Doppler respond to edits during Play (live tuning), and the Event editor's audition shows which backend is playing.

## Alternatives considered

- **Equal-power for distant voices, no bed.** ≈ 1.7 µs a voice, no decode. Loses headphone placement for everything beyond the nearest HRTF voices; whether listeners hear the difference at distance is the listening pass's first A/B, and `audio.bed` stays off until it does.
- **Per-voice HRTF for every spatial voice.** ≈ 13 µs a voice; 256 voices exceed a quantum.
- **One bed for the whole mix.** Bypasses bus effects, ducking and meters for bed voices; one bed per bus keeps the bus tree intact.
- **1st- or 2nd-order bed.** Cheaper, blurrier; the 3rd-order encode is already ≈ 0.5 µs.
- **Virtual-loudspeaker or plain least-squares decode.** Measured 5–12 dB too dull above 2 kHz; MagLS costs the same at run time.
- **Steam Audio or Resonance as a dependency.** Threads and SIMD paths that don't fit the worklet; Resonance is archived.
- **Occlusion in the core.** The physics world lives on main.
- **A dedicated `AudioOccluder` physics layer.** A collider has one layer, so walls would leave their gameplay layer; a layer list plus an optional material component doesn't touch collisions.
- **Listener-based zone weights** (FMOD-style 3D reverb zones). Simpler (one weight set per frame), but a sound in another room takes the listener's room's reverb; per-source weights are what Wwise rooms do (owner decision 1).
- **Algorithmic reverb for zones.** Lighter on memory, a different sound from M1's convolution reverb; a possible low-preset option later.
- **A per-instance event filter after mixing an instance's voices.** Can't follow per-voice panning.
- **A separate lazy spatial wasm module.** Its own memory and a per-quantum copy of the beds.

## Consequences

**Positive**
- Headphone placement for hundreds of voices at ≈ 0.5 µs of encoding each; ambisonic ambiences; walls that muffle without killing the room's reverb; per-room reverb by source; Doppler; per-event filters and sends.
- Designers place zones and occluders in the editor like colliders; the occluder material table is project data.
- Reuses M1's HRIR set, convolver, crossfades and selection, and M2's automation, curves, per-voice filter and no-gap rule.
- Every feature is behind a flag, so M3 can ship piece by piece without changing how existing projects sound.

**Negative / costs**
- The high preset's cost rises (≈ 0.22 ms est.) on a preset already over 0157's budget on the lab VM; the low preset gets no bed, 1 small zone and few rays.
- Reverb zones cost megabytes each; ambisonic clips need streaming and a 16-channel arena.
- Below-horizon placement is approximate with M1's HRIR data until the listening pass decides.
- Nearest-8 HRTF with the bed on (a 1–4 dB switch dip, to be listened to).
- Two components, a gizmo contribution, new settings, wire changes (panner kind 2, a clip voice kind, `LISTENER`, zone and occlusion fields), per-voice filters for every filtered voice, per-bus beds.
- **Estimate (provisional; the technical design's task table sets the real one):** ≈ 22 person-weeks: the bed with per-bus beds (≈ 4.5), ambisonic clips with 16-channel streaming (≈ 3), reverb zones by source with off-thread preparation and REPLAY (≈ 5.5), occlusion with per-voice filters (≈ 3), Doppler and event effects (≈ 1), the fallback (≈ 0.5), the editor (≈ 4), and a reserve (≈ 0.5); plus a sample and the listening pass. Milestones M3a (bed), M3b (clips), M3c (zones), M3d (occlusion, Doppler, event effects), M3e (editor), each behind its flag.

## Deprecates

Architecture §10's "extra convolvers never share a tail quantum" (replaced by load-balanced staggering). 0157's "spatial (M3) is a separate lazy module" (replaced by building into the mixer).

## Open questions

- Owner decisions listed below.
- Obstruction (direct blocked, reflections open), frequency-dependent transmission (Steam Audio's 3 bands), rooms and portals, diffraction, spread, cones: later.
- Moving and trimesh occluders: the same rays, not yet measured.
- IR preparation in the decoder worker: unmeasured.
- The lab-VM and phone numbers for every budget.

## Owner decisions (for acceptance)

1. **Zone weights per source** (recommended: what Wwise rooms do; a sound in another room keeps its room) or per listener (simpler, FMOD-style).
2. **Feature flags off until the listening pass** (recommended: existing projects unchanged; each feature defaults on after its listening items pass) or on by default as each lands.
3. **HRTF voices 8 with the bed** on the high preset, a project's stored `voices.hrtf` untouched (recommended), or keep 16 and take the ≈ 55 µs.
4. **Babylon occlusion gain only** (recommended: best effort) or add a per-voice `BiquadFilterNode` on the fallback (≈ +0.5 person-week).
5. **Below the horizon:** listen first, SADIE II if a floor-below sound fails (recommended), or switch to SADIE II now.
6. **Beds per bus** up to 4 on high (≈ +20 µs per extra bed; recommended) or beds only on buses without effects.

## RFC round (revision 2)

Five reviews in `docs/rfc/0162/` (architect, senior engineer, mid-level engineer, sound designer, premise challenger); all "approve with changes". Each code claim was checked against the code.

| Point (reviewer) | Outcome |
|---|---|
| A single bed bypasses the bus tree: effects, ducking, meters (architect, blocking; checked: `bus.rs` mixdown, `panner.rs` adds HRTF to the voice's bus) | **Taken:** one bed per bus, decoded into the bus before its effects; a preset limit; owner decision 6 |
| Budgets must be p99.9 (0157, 0158); the high preset is already 5.45 ms p99.9 on the lab VM (architect, senior, challenger; checked: architecture §6.1) | **Taken:** §8 states p99.9 as the statistic, acceptance needs the lab-VM run and the metered gate, the estimate is labelled modelled |
| Bed voices still pay mixing; "0.5 µs a voice" is encode only (architect) | **Taken:** corrected in Context and Consequences |
| The HRTF saving is ≈ 55 µs, not 94 (kernel budget) (architect; checked against `KERNEL_BUDGET`) | **Taken** |
| Per-voice low-pass isn't applied in the core (architect, mid; checked: `voices.rs`) | **Taken:** §3 adds per-voice filters for every filtered voice, shared with automation's `lowpass` |
| FLAC holds at most 8 channels (architect) | **Taken:** orders 2–3 in WAV only |
| A collider has one layer; an `AudioOccluder` layer changes gameplay collisions (architect, senior; checked: `Collider.ts:21`) | **Taken:** a layer list for rays plus an optional material component; a default material |
| Occlusion needs the 3D physics service; 2D games (senior) | **Taken:** 3D only in M3; no occlusion without the service; audio never starts it |
| Who owns occlusion smoothing (architect) | **Taken:** main |
| Ranking by audibility after occlusion is circular (mid) | **Taken:** rank by audibility before occlusion |
| Overrun behaviour; result age (mid) | **Taken** |
| Zone weights from the listener only (sound designer, blocking) | **Taken as the recommendation**, owner decision 1 |
| Occlusion ignores the wet path (sound designer, blocking) | **Taken:** `wetOcclusion` |
| Distance-based reverb send; `reverbSend` default; silent zones (sound designer, mid) | **Taken:** a send curve, default 1 for spatial sources, the shared reverb when no zone holds a voice, editor warnings |
| Per-instance filter can't follow per-voice panning (architect) | **Taken:** per-voice filters for event voices |
| Event `filter` overlaps automation's `lowpass` (senior) | **Taken:** lowest wins; one filter |
| Ambisonic clip identity, yaw offset, send (senior, sound designer, mid) | **Taken:** a sidecar `ambisonic` key, yaw and send |
| A 16-channel minute is ≈ 92 MB (architect, challenger: "184 MB" assumed float) | **Taken:** clips stream by default |
| Zone state in REPLAY; 48 kHz-only spectra and filters (architect; checked: `convolver.rs` sizes by rate) | **Taken:** prepared at the context's rate, re-prepared on change, in REPLAY |
| Doppler on main into `pitch`; listener velocity; teleport guard; units; hidden tab (architect, senior, sound designer, mid) | **Taken** |
| Behaviour changes for existing projects (HRTF 16 → 8, occlusion and bed on) (senior, mid) | **Taken:** feature flags; owner decisions 2 and 3 |
| Babylon has no per-voice low-pass today (mid, blocking; checked: guides and `babylonBackend.ts`) | **Taken:** §7 corrected; owner decision 4 |
| Wire changes under-specified; panner bits 5–6 (architect, senior) | **Taken:** the bit corrected; byte layouts go to the technical design (step 6) |
| Zone IR asset kind; bus `reverb` vs zones; gizmos through the SDK (senior) | **Taken:** an `audio` clip; the shared reverb stays; a gizmo contribution |
| An `occluded` debug cause; which stage set a low-pass (mid) | **Taken** |
| Live tuning in Play; backend shown in audition (sound designer) | **Taken** |
| Spread; rooms and portals; obstruction; diffraction (sound designer) | **Deferred**, listed in Open questions; the encoder leaves room for spread |
| Below-horizon data as a gate (sound designer, challenger) | **Taken:** owner decision 5, decided by listening before `audio.bed` defaults on |
| No listening evidence for the bed or 16 → 8 (challenger, blocking) | **Taken:** flags stay off until the listening pass's A/B items pass |
| Ambisonic clips out of proportion for v1 (challenger) | **Not taken:** the owner put them in scope (goal.md) |
| Zones as presets on one global reverb; algorithmic reverb (challenger) | **Not taken:** keeps M1's convolution sound (0157's review); the low preset gets 1 small zone; algorithmic is a later option |
| A half-size M3 (challenger: 5–7 + 2 person-weeks) | **Not taken as scope** (the owner's scope); the flags let any part ship first |
| Estimate ≈ 20 person-weeks in milestones behind flags (senior) | **Taken with changes:** ≈ 22 with per-bus beds, per-voice filters, 16-channel streaming and source zones added |
| Doppler and event filters not needed in M3 (challenger) | **Not taken:** in the roadmap and 0158; ≈ 1 person-week together |
