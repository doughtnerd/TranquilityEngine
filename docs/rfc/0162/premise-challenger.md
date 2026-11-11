# 0162 premise challenger

**Verdict: approve with changes.** The measurements are good and the bed is cheap. But the record never shows that a listener hears the difference at any step, and it commits about 17 person-weeks (record line 129) plus an amendment to 0157's budget. It does so before any listening test.

**Top 3 concerns**
1. Nothing in the record is a perceptual result. Bed vs equal-power, the 1–4 dB crossfade dip, below-horizon decode, and the reverb choice all say "not yet listened to" (bed README 279; spikes README "Still unverified").
2. The scope is the whole roadmap plus ambisonic clips. Several items (Doppler, event filters, trimesh and moving occluders, multi-zone blends) have no named game need and no M3 acceptance test.
3. The record amends two accepted ADRs (0157 on the lazy module and budget, and architecture §10) with a provisional "≈0.21 ms (est.)" figure (lines 95, 98). The "typical scene" is also never defined as a game.

## Issues

1. **(blocking) The bed's value is a cost argument, not a hearing argument.** Measured: encode ≈0.5 µs vs ≈13 µs per HRTF voice (line 43). The alternative that matters is equal-power for non-HRTF voices, at ≈1.7 µs (spikes README, "HRTF voices 16 → 8" row: bed16 28 µs). That is already M1's behaviour for voices 17 and up (0157 line 161). Beyond a few metres, a mono point source's HRTF cue is mostly ITD/ILD, which a cheap pan approximates. Cost of the bed over equal-power for ~240 voices: ≈120 µs p50 plus decode, ≈25% of the M3 subtotal. Change: run a blind A/B (distant-voice scene, 20/40/80 m, headphones) before acceptance. Make the bed a feature gated on that result.
2. **(major) Halving HRTF voices (16→8) has no listening evidence.** Option (c) trades the 8 voices that were HRTF today for bed voices. Selection ranks by audibility, so voices 9–16 are the ones near enough to be localised. The measured crossfade dip is 1–4 dB (bed README 183, 259). The bed's own README recommends trying equal-power crossfade first, but the record keeps M1's mechanism (line 61). Change: keep 16 until the A/B passes. Take the 0.09 ms saving only from that evidence.
3. **(major) Below −45° the HRIR set has no data** (line 44: 8–20 dB wrong above 4 kHz). The bed's placement is "as good as the data". AAA claims for vertical placement are therefore false for the below-listener hemisphere, and the record defers the fix (line 63). Change: decide SADIE II before M3 ships, or document it as a limit in the manual.
4. **(major) Ambisonic clips are out of proportion to a v1 audience.** They need a 16-channel arena (line 69), a `LISTENER` command, FuMa conversion, and a WAV/FLAC-only format because Opus has no decoder (README answers row 4). A 3rd-order WAV is 16 channels of PCM, so a 60 s loop is ~184 MB at 48 kHz/32-bit float. That is not shippable on web or Android. Change: ship 1st order only (4 channels, ~46 MB per minute, still large). Or defer clips and offer pre-rendered stereo loops.
5. **(major) Reverb zone memory (3.1 / 6.1 MB per stereo zone) is the real cost** and is pushed to the phone, which is explicitly unverified (goal.md). The alternative (Freeverb-style) is rejected because "different sound from M1's reverb" (line 112). But zones are a new feature, not a regression, and a bus reverb already exists as a convolver. Change: ship zones as parameter presets on one global reverb bus (wet, decay, damping). That gives interior/exterior blends for ~0 MB and ~0 CPU. Offer convolution zones as an upgrade.
6. **(major) Ray-cast occlusion is the most defensible piece but over-built.** Round-robin over 1,024 sources, 3 extra rays, 3 occluders, material tables, `AudioOccluder` layer, debug view. Measured 3 frames to refresh 64 sources (occlusion README). Moving sources are ≈1% wrong at 256. Change: M3 ships one centre ray, top-16 only, one transmission value per material. Multi-ray and trimesh are already "later" (line 140).
7. **(minor) Doppler and event filters are "free" (≈0 CPU) but not free to maintain.** Doppler needs main-side velocity estimation, which is noisy at low frame rate and teleports. The ±1 octave clamp and smoothing hide that. Event `filter`/`sends` extend a format (`myco.audioevent@1`) that is already public. Change: Doppler defaults off (`dopplerLevel` 0) for non-vehicle sources; defer event filters to M4.
8. **(minor) Web Audio's own `PannerNode`/`ConvolverNode` are dismissed in one sentence.** 0157's reasons (determinism, headless tests, sample-accurate commands, no main-thread dependency) are valid for the mixer. But spatial output on the *fallback* already uses them (line 92). The record never states whether the core's HRTF and the fallback's HRTF match perceptually. Change: add a parity test or state that they differ.
9. **(minor) The budget is circular.** "M3 adds ≈0.21 ms" is a container figure, ×0.5 for an assumed reference machine (spikes README headroom). The p99.9 is untrustworthy on this VM and the phone is untested. The amendment to 0157's total (line 95) should wait for the lab-VM run.

## The cheapest credible M3

Ships:
- Per-voice HRTF kept at 16 and equal-power beyond that (M1 as is).
- Occlusion: top-16 sources, one centre ray, `AudioOccluder` component with 4 materials, gain plus low-pass, smoothed. Budget 0.25 ms.
- Reverb zones as **presets on the existing bus reverb**: a component with box/sphere, per-zone wet/decay/damping, blended on main. One convolver as today. No per-zone IR memory.
- 1st-order ambisonic clip (W,Y,Z,X) decoded to the existing stereo path, optional.
- Doppler as an opt-in field (pitch factor only).

Costs: roughly 5–7 person-weeks runtime and 2 editor (vs 13 + 4). No `LISTENER` 16-channel arena, no bed, no IR preparation, no staggered convolver planner, no §10 amendment.

Loses: hundreds of simultaneously localised distant voices (still plain equal-power pan), 3rd-order ambiences, per-room IR character, frequency-dependent event effects.

## When the premise is wrong

- **Bed (1):** wrong if a blind A/B with ≥10 listeners can't tell bed from equal-power at ≥20 m (p>0.05, ABX). Also wrong if the 16→8 switch is audible as a level step ≥1 dB in a moving-source test, or if the typical game has ≤16 simultaneous spatial voices (bed never engages).
- **Ambisonic clips (2):** wrong if the target games' ambiences fit in stereo loops at the same size, or no shipped sample uses B-format. Also wrong if a 1-minute 3rd-order loop (~184 MB uncompressed) exceeds the web/Android asset budget.
- **Ray occlusion (3):** wrong if hand-placed volumes per room (a box with a low-pass) give the same designer result in a sample level, or if the physics world isn't present (2D, no colliders) in >50% of target projects.
- **Convolution zones (4):** wrong if a blind A/B can't tell a convolved 2 s zone from an algorithmic one with matching RT60/damping, or if the low-end phone cannot spare 3 MB per active zone.
- **Doppler/event filters (5):** wrong if no sample or user request needs them in M3 (check the flappy sample and the feedback list).
- **Core-only spatial (6):** wrong if the fallback's `PannerNode` HRTF is perceptually equivalent to the core's and platform coverage of AudioWorklet+simd128 drops the fallback to a footnote.
- **Scope (7):** wrong if the schedule is unconstrained and the owner's goal ("everything in the roadmap") is a hard requirement. In that case sequence the work, not cut it.

## Cheaper alternatives

- Pre-rendered stereo ambience loops authored in a DAW, at 1/10 the size of B-format.
- Occlusion volumes (designer-placed boxes setting a low-pass and gain while the listener is inside) with no ray casts.
- One global reverb bus with parameter presets per zone.
- 1st-order bed only (4 channels, decode ≈ 5 µs) if a bed survives the A/B.
- Reuse Chromium's HRTF for all spatial voices up to a measured cap; extend the cap instead of adding a path.

## Questions for the author

1. Which sample game needs more than 16 simultaneously localised spatial voices, and who has listened to voices 9–16 under the bed?
2. What is the uncompressed and shipped size of a 3rd-order ambient loop, and where does it live in a web build?
3. Why does M3 need convolved zones rather than reverb parameter presets, given 3.1–6.1 MB per zone and an unverified phone?
4. Is the 0157 amendment (line 98, no lazy module) approved by the owner independent of the budget numbers? Does the wasm size gate still pass?
5. Which acceptance test decides "done" for occlusion: rays per frame, or a listener hearing a wall?
6. Does the ≈0.21 ms estimate include the arena growth to 16 channels and the 8 KB bed per quantum?
