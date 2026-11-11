# Audio M3 (spatial): survey of prior art

Research input for ADR 0162 and the M3 technical design (`docs/design/0162-audio-spatial/goal.md`). Written 2026-11-11.

**Marks.** **[V]** = verified from a primary source I read this session (URL or repo path given). **[U]** = unverified (from memory, a search summary, or a secondary source). Search-engine summaries count as [U] unless noted.

**Access limits of this run.** Only `github.com` pages (via web fetch), `raw.githubusercontent.com` and web search worked. `valvesoftware.github.io` (Steam Audio docs), `york.ac.uk` and `openair.hosted.york.ac.uk` (SADIE II, OpenAIR), `datatracker.ietf.org` and `rfc-editor.org` (RFC 8486) did not resolve (the session's network allowlist), and `gh api` was refused for repos outside the session. Every claim that needed those sites is [U]. If the owner allows them, a second pass can close most of the "still unverified" list below.

## Summary table

| Item | Best candidate | Licence | Take how | Size / cost note | Mark |
|---|---|---|---|---|---|
| 1 Ambisonic bed | Own Rust encoder (ACN/SN3D, order 3) + decoder as SH-domain HRIR filters baked offline from M1's IRCAM set; SAF (ISC modules) and Resonance (Apache-2.0) as references | SAF core ISC; Resonance Apache-2.0; libspatialaudio LGPL-2.1+; IEM/ambix GPL | Write ourselves; **reference** SAF/Resonance; port small pieces (SH, rotation) with notices if wanted | Spike: 256 voices + decode 0.35 ms wasm (13%), 0.22 ms simd128 | V (licences), V (local spike), U (design) |
| 2 Ambisonic clips | AmbiX (ACN/SN3D) in multichannel WAV / Ogg Opus family 2/3 / FLAC | AmbiX and RFC 8486 are open specs | Support AmbiX only; FuMa to AmbiX at import | 4 / 9 / 16 channels; Symphonia reads Ogg, Vorbis, Opus, WAV, FLAC | V (Symphonia), U (spec details) |
| 3 Occlusion | Rapier `castRay` from the World service; Wwise-style occlusion value + low-pass + gain; Steam Audio for 3-band transmission idea | Steam Audio Apache-2.0; Rapier Apache-2.0 [U] | Own code, concept only | 1.5-4.3 us/ray (local spike); frame cost linear in sources x rays | V (local, Steam licence), U (rest) |
| 4 Reverb zones | One shared convolver per zone, per-voice/bus sends into zone sends, crossfade zone gains; M1 staged convolver reused | n/a; IRs: OpenAIR per entry (mostly CC BY 4.0 [U]) | Reuse M1 code; add tail phase offsets | 4 s stereo uniform 1.08 ms wasm, so non-uniform is required | V (local), U (OpenAIR) |
| 5 Doppler | Per-voice pitch factor from radial velocity, clamped and slewed; resampler already takes fractional pitch | n/a | Own code | 4-point Lagrange resampler, no band-limiting (#110) | V (local), U (formula) |
| 6 HRIR sets | Keep M1's IRCAM Listen IRC_Composite_C; SADIE II as the denser fallback | IRCAM "public, any use, acknowledgement requested"; SADIE II Apache-2.0 [U]; KEMAR/CIPIC permissive with attribution [U] | Data only | M1 blob 245,776 B | V (repo docs), U (others) |

## 1. Ambisonics: encoders and binaural decoders

### Candidates

| Project | Licence | Language | Maintained | Fits single-threaded wasm? | Take |
|---|---|---|---|---|---|
| Resonance Audio | Apache-2.0 [V: https://github.com/resonance-audio/resonance-audio/blob/master/LICENSE]; the LICENSE appendix has unfilled copyright placeholders, no copyright holder named [V same] | C++ [V: `.cc`/`.h` in https://github.com/resonance-audio/resonance-audio/tree/master/resonance_audio/ambisonics] | **Archived, read-only since 2023-11-11** [V: https://github.com/resonance-audio/resonance-audio] | Yes in principle (small, no threads needed) [U] | Reference, possibly port bits. Its `ambisonics/` has a binaural decoder, FOA and HOA rotators, associated Legendre generator and lookup tables [V: tree URL above]. Its README lists "SADIE Binaural Measurements" as a core dependency fetched by `clone_core_deps.sh` [V: repo page]. High-quality mode is 3rd order over 26 Lebedev virtual loudspeakers [U: Unreal API docs via search] |
| Spatial Audio Framework (SAF/SPARTA) | Default **ISC** for core modules (`saf_hoa`, `saf_sh`, `saf_vbap`, `saf_cdf4sap`, `saf_hrir`, `saf_reverb`, `saf_utilities`) and `saf_sofa_reader`; **GPLv2** only for optional `saf_tracker` and `saf_hades` [V: https://github.com/leomccormack/Spatial_Audio_Framework]. Third-party code inside uses MIT/BSD-like terms noted in comments [V: LICENSE.md page] | C / C++ | About 1,198 commits, 4 open issues; no recency date seen [V: repo page, recency U] | Needs CBLAS/LAPACK (OpenBLAS etc.) [V], so **not portable as-is** to wasm | Reference (algorithms: `ambi_bin` offers LS, SPR, time-alignment (TA) and MagLS decoding; `ambi_dec` offers SAD, AllRAD, EPAD, MMD [V repo page]). Port individual ISC functions (SH basis, rotation) with the ISC notice if useful |
| libspatialaudio | **LGPL-2.1 or later** (also commercial) [V: https://github.com/videolabs/libspatialaudio] | C++ | 331 commits, 7 open issues, no dates seen [V, recency U] | Plausible | **Do not port** (LGPL is outside "BSD/MIT-style"; keep reference only). Useful as a readable reference: encode, process, decode to 3rd order, ACN/SN3D, built-in MIT HRTF for binaural [V] |
| IEM plug-in suite, ambiX plug-ins | GPL (ambiX: GPL-2.0 [V: https://github.com/kronihias/ambix]; IEM [U]) | C++/JUCE | [U] | n/a | **Reference only**, never copy |
| Steam Audio ambisonics | Apache-2.0 [V: https://github.com/ValveSoftware/steam-audio/blob/master/LICENSE.md] | C++ (inferred from `core/src/core/ambisonics_*_effect.cpp` [V]) | 211 commits shown, v4.8.1 current [V] | Large codebase with embedded dependencies [U] | Reference; effects named: ambisonics encode, decode, binaural, panning, rotate [V: https://github.com/ValveSoftware/steam-audio/tree/master/core/src/core] |
| Rust crates | `ambisonic` 0.4.1 is first order only, built on rodio [U]; `voirs-spatial` has HOA encode/decode [U]; `audionimbus` wraps Steam Audio [U] | Rust | [U] | `ambisonic`: no (rodio, std) | No Rust crate found that does HOA-to-binaural with rotation [U]; write our own |

### Conventions [U unless noted]

- **ACN/SN3D (AmbiX):** ACN channel index `n = l*(l+1)+m`; SN3D normalisation. The Ogg Opus ambisonics RFC says family 2 channels are SN3D with ACN ordering, as defined in the ambiX spec section 2.1 [U: search summary of RFC 8486]. Order l has (l+1)^2 channels: 4, 9, 16.
- **SH rotation by listener orientation:** a (l+1)^2 block-diagonal rotation per order; Resonance ships FOA and HOA rotators [V: file list]. Cheap at order 3 (one 16x16 sparse matrix per quantum, or rotate the encode direction instead; for the bed, rotate the 16-channel bed once per quantum).

### How a binaural decode is built from an HRIR set [U: standard method, from memory]

1. **Virtual loudspeakers:** decode the bed to N speaker feeds with an ambisonic decoder (AllRAD, mode-matching), then convolve each feed with the HRIR pair for that direction. Cost: 16xN gain matrix + N x 2 convolutions. N >= 16 (Resonance uses 26).
2. **SH-domain HRTF (equivalent, cheaper):** fit the HRIR set as SH expansions offline (one filter per SH channel per ear). Runtime: **16 channels x 2 ears = 32 fixed convolutions**, independent of speaker count. The fit can be least squares (LS), or **MagLS**: LS below a cutoff (about 1-2 kHz) and magnitude-only matching above it, which removes most of the high-frequency colouration of order-3 LS decodes. MagLS comes from Schörkhuber, Zaunschirm and Höldrich (DAGA 2018) and Zaunschirm et al. (JASA 143, 2018, time alignment and diffuseness) [U: search summary only; I did not read the papers]. SAF's `ambi_bin` implements LS, SPR, TA and MagLS [V: SAF page]; it is ISC.
3. The spike's "fixed ~0.1 ms binaural decode" [V: `spikes/audio-worklet/spatial/README.md`] matches option 2.

### Can M1's HRIR data feed it? [V: repo docs unless marked]

- M1 ships **IRCAM Listen IRC_Composite_C**, as Chromium processed it: 240 directions (24 azimuths in 15 deg steps x 10 elevations from -45 deg up in 15 deg steps), 256-frame responses at 44.1 kHz, i16, plus an ear-delay table; blob `src/plugins/audio/runtime/wasm/myco_hrir.bin`, 245,776 B (`native/audio/crates/audio-dsp/src/hrtf/database.rs`; `docs/design/0157-audio-core/hrir-licence.md`, `hrir-attribution.md`). Terms: "public and available for any use", acknowledgement requested (taken from a Debian copyright file, since IRCAM's own page failed to load; hrir-licence.md).
- **Yes, it can**, with two caveats [U, my analysis]: (a) the grid has **no data below -45 deg**, so an SH fit is ill-conditioned for the lower cap; use Tikhonov regularisation or fill the cap by extrapolating (nearest-elevation copy with spectral roll-off), or choose virtual speakers only on measured directions; (b) Chromium's kernels carry ITD as a separate delay table (the format has `ear-delay` entries), so an SH-domain fit must either time-align (reintroduce the delay per direction before fitting, as in Zaunschirm's TA) or fit the delay-removed responses and accept a weaker ITD at the bed. Both are offline-tool decisions; the runtime stays 32 partitioned convolutions.
- A denser set (SADIE II, below) would fit more cleanly but changes the sound (the 0157 decision kept IRCAM for non-regression).

### Recommendation (scope 1)

Write the bed ourselves: ACN/SN3D order-3 encoder (16 gains per voice, trivially vectorised), per-quantum bed rotation, and an **offline tool** that produces SH-domain HRIR filters from `myco_hrir.bin` (LS first, MagLS if listening tests ask for it; use SAF's ISC `saf_hoa`/`saf_sh` as the algorithm reference, keep its notice if any code is ported). Runtime reuses the HRTF convolver partitions. Do not depend on any C++ library. Do not copy libspatialaudio or IEM (copyleft).

## 2. Ambisonic clips

- **AmbiX:** ACN ordering, SN3D normalisation; the convention used by YouTube/Opus/Resonance and by the ambiX plug-ins [V for plug-ins: https://github.com/kronihias/ambix; rest U]. **FuMa** (legacy): W X Y Z (first order only above FOA via Furse-Malham extensions), W scaled by 1/sqrt(2), MaxN normalisation [U]. FuMa to AmbiX at import: reorder to W Y Z X, scale W by sqrt(2), X/Y/Z by 1 (for FOA) [U, verify in tests].
- **Orders and channel counts:** 4 (FOA), 9 (2nd), 16 (3rd) channels; (N+1)^2 [U]. Common in the wild: FOA; 3rd order mainly from capture libraries and DAW renders.
- **Playback:** rotate the clip's B-format by the inverse listener orientation (listener-fixed or world-fixed per authoring choice), then add it into the same 16-channel bed as the encoded voices and decode once. Lower-order clips fill the first (N+1)^2 channels of the bed (zero-padded) [U, standard practice; Resonance ships an ambisonic soundfield path "decoding and binaural rendering of ambisonic soundfields" per its API header, U via search].
- **Containers:** multichannel WAV (4/9/16 ch; WAVE_FORMAT_EXTENSIBLE, no standard ambisonic flag, so the file or sidecar must say AmbiX) [U]; FLAC (up to 8 channels only, so FOA/2nd-order-subset only) [U, FLAC's 8-channel limit is from memory]; **Ogg Opus channel mapping family 2** (individual channels, SN3D/ACN) and **family 3** (with a demixing matrix: "projection" form) per RFC 8486 [U: search summary of https://www.rfc-editor.org/rfc/rfc8486.html; page not readable]. The Opus mapping families registry lists 2 as "Ambisonics as individual channels" and 3 as "with demixing matrix" [U: iana.org, from the search listing].
- **Our decoder (Symphonia):** reads Ogg, Vorbis, **Opus** (codec crate `symphonia-codec-opus`, enabled by default but with no stated status; third-party `symphonia-adapter-libopus` exists), WAV, PCM and FLAC; licence **MPL-2.0**; MSRV 1.85 for 0.6.x; page states no channel-count limit [V: https://github.com/pdeljanov/Symphonia]. **Unverified:** whether Symphonia's Opus decoder supports channel mapping family 2/3 (I could not confirm; most Opus decoders handle family 255 and 0/1 only). Fallback: WAV (16 ch) works regardless; for compression, Ogg Vorbis multichannel is supported in principle but Vorbis couples channels in fixed layouts up to 8, so 3rd order would need several streams [U].

### Recommendation (scope 2)

Accept AmbiX WAV (4, 9, 16 channels; PCM or float) and Ogg Opus family 2/3 **if** a test file proves Symphonia reads it; add a clip flag `ambisonic: { order, convention: "ambix" | "fuma" }`; convert FuMa to AmbiX at import. Make a spike (one 16-channel WAV, one Opus family-3 file) the first M3 task.

## 3. Occlusion and obstruction

- **Steam Audio:** Apache-2.0 [V: LICENSE.md URL above]. The README confirms platforms and integrations but states no licence [V: raw README]; the date it went open source is unclear (search summaries point to v4.5.2 and to Feb 2024; I could not reconcile) [U]. Transmission is frequency-dependent, 3-band EQ with band edges 800 Hz and 8 kHz [U: Unity plugin docs via search]; occlusion checks use raycasts from source to listener, optionally volumetric (several rays over a source radius) [U]. Material transmission coefficients attach to geometry [U]. Ray counts and update rates: not verified.
- **Wwise concepts [U: CryEngine and Audiokinetic Q&A via search; not Audiokinetic's official reference]:** *occlusion* = sound blocked on the direct and wet paths (volume + low-pass, wet also reduced); *obstruction* = direct path blocked but the reverb path open (volume + low-pass on the dry only); *exclusion* is not defined by any source I found. CryEngine's integration uses single-ray or multi-ray modes; with multiple rays, obstruction is derived when the centre ray differs from the outer rays' average; per-ray values are averaged over time [U]. The Unreal Wwise integration's default occlusion refresh interval is 0.2 s [U].
- **Resonance's occlusion:** per-source occlusion intensity (low-pass by amount) set by the host; no geometry queries in the library (the host raycasts) [U; not confirmed].
- **Smoothing:** no source found; standard practice is a one-pole or slew limiter on the target occlusion value (about 50-150 ms) plus a ramp on the low-pass cutoff to avoid zipper [U].
- **Rapier in this repo [V: `package.json` lines 47-48 list `@dimforge/rapier2d-compat` and `rapier3d-compat` ^0.21.0]:** the physics plugin is `src/plugins/physics-rapier/runtime/rapier3d.ts` and `rapier2d.ts`; the 3D runtime already calls `castRayAndGetNormal(ray, maxDistance, true, undefined, groups)` (line 377), with collision groups for filtering. The earlier spike measured `castRay` at about 2-4 us per ray, `intersectionsWithRay` 3-5 us (9-12 us on a mixed two-BVH scene), cost nearly independent of source count [V: `spikes/audio-worklet/occlusion/README.md`; single machine]. Rays run on the main thread; the audio thread only receives per-voice occlusion values (the wire format already has `lpHz`).

### Recommendation (scope 3)

Own code on the main thread: per audible voice, 1 centre ray plus (for the nearest few) 4 jittered rays on a source-radius disc; budget N rays per frame (round-robin, each voice refreshed at 5-10 Hz is enough for a 0.1-0.2 s response [U]); output `{occlusion, obstruction}` -> gain + lpHz + reverb-send factor; smooth in the core. Transmission through materials (Steam Audio's 3 bands) is a later addition: a per-collider material with a 3-band transmission, applied when the ray passes through (use `intersectionsWithRay`). Steam Audio is concept reference only (the code is large and C++).

## 4. Reverb zones

- **Blending [U: from documentation I remember, not read this session]:** Wwise: rooms and portals feed auxiliary busses, each voice has a send level per room (game-defined sends) with distance-based wet. FMOD: reverb zones are 3D spheres (min/max distance); the listener gets a blend of overlapping reverbs weighted by position, one global reverb DSP per channel group. Unity: Reverb Zones set the AudioListener's reverb preset by listener position (a listener-side effect, not per source). Steam Audio: baked reflections per probe or a runtime reverb estimate; one reverb per listener/zone with per-source send [U].
- **Per-voice vs per-zone:** the cheapest design is **per-zone convolver, per-voice send** (voice position decides which zone(s) it feeds) plus a listener-side zone crossfade on the wet gains. Convolver count stays at zones active near the listener (2 during a crossfade) not at voice count.
- **IR sources [U]:** OpenAIR: licences are chosen per entry, recent ones CC BY 4.0; B-format versions exist for some; no CC BY-SA entries found in the search results. Other open IRs (e.g., Voxengo free IRs, EchoThief, etc.) have their own terms; each needs checking. A **procedurally generated** IR (decaying noise with frequency-dependent T60) is licence-free and is what the old spike used.
- **Non-uniform partitioned convolution [U for the papers]:** Gardner, "Efficient convolution without input-output delay" (JAES 1995); Garcia, "Optimal filter partition for efficient convolution with short input/output delay" (AES 113th, 2002); Wefers, *Partitioned convolution algorithms for real-time auralization* (2015). Idea: short partitions first (zero latency), partition sizes doubling toward the tail so the number of large FFTs per quantum stays flat.
- **What M1 already has [V: `native/audio/crates/audio-dsp/src/convolver.rs` header]:** a port of Blink's staged `ReverbConvolver` on microfft: a zero-latency head (uniform 128-frame partitions over the first 4,096 frames, overlap-save on a 256-point FFT) plus tail stages at `max_fft_size` 4,096 sharing one forward and one inverse transform via a frequency-domain delay line (one spectrum multiply-add per stage); a per-channel render phase keeps channels' FFTs apart; stereo in/out; the response is normalised (`ir.rs`); budget stated as 0.1 ms average, 0.35 ms p99.9 per quantum. M3's "tail phase offsets" are an extension of that render phase.
- Old spike numbers (uniform partitions, **not** M1's convolver): 4 s stereo 1.08 ms Chromium wasm per quantum (40%) [V: spatial README] and non-uniform about 0.1 ms average with 1.67 ms maxima (goal.md) [V: goal.md; the spike itself is not in this README's scope].

### Recommendation (scope 4)

A zone is a convolver (M1's, phase-offset per zone) fed by sends; voices and buses pick zone sends by position; the listener crossfades between at most two zones. Ship procedurally generated default IRs; accept user IRs with their own licences. Do not depend on OpenAIR content in the engine (per-entry licences).

## 5. Doppler [U unless marked]

- **Formula:** observed frequency ratio `f'/f = (c + v_l.d) / (c - v_s.d)` with `d` the unit vector listener-to-source and `v_l`, `v_s` listener and source velocities (positive toward each other); c = 343 m/s. Clamp the ratio (e.g., 0.5-2) and clamp `v_s.d < c`. Smooth with a slew limiter (pitch changes of tens of ms), because a velocity estimated from position differences at 60 Hz is noisy and teleports must be zeroed.
- **Per-source factor:** Unity `AudioSource.dopplerLevel` (0 off, 1 realistic, scales the pitch effect) [U]. Web Audio's `PannerNode.dopplerFactor` and `AudioListener.speedOfSound` were removed from the spec (the engine's Babylon fallback cannot do it on the spec path) [U]; Babylon's own `Sound` Doppler is not verified.
- **Resampler interaction [V: `native/audio/crates/audio-dsp/src/resample.rs` header; `docs/design/0157-audio-core/build-log.md` line 379]:** voices read through a 4-point 3rd-order Lagrange kernel at `pitch * clipRate / contextRate`; no kernel band-limits, so pitch-ups of bright content alias (audible from about 1.5x); band-limited resampling (octave mipmaps built by a half-band filter at load, or pitch-scaled pre-filtering) is the open post-M1 option, issue #110. Doppler ratios stay within about 0.8-1.25 in games, where aliasing is minor, and the Doppler factor multiplies the voice's existing pitch.

### Recommendation (scope 5)

Compute the ratio on the main thread (or in the core from the voice's velocity, if the wire format carries velocities with `LISTENER`), clamp to 0.5-2, smooth, and multiply the voice pitch. Per-source `dopplerLevel`. No #110 dependency; revisit only if a listening pass hears aliasing. Open choice: velocity estimated on the main thread (simple) or sent as vectors (core extrapolates between updates, smoother at low update rates).

## 6. HRTF/HRIR datasets

| Set | Licence | Notes |
|---|---|---|
| IRCAM Listen IRC_Composite_C (M1) | "public and available for any use", acknowledgement requested [V: `docs/design/0157-audio-core/hrir-licence.md`, quoting a Debian copyright file; IRCAM's own page not read] | 240 directions, 256 frames at 44.1 kHz, 245,776 B as shipped; no data below -45 deg [V: database.rs] |
| SADIE II | Apache-2.0 per M1's own research (`hrir-licence.md`, `hrir-attribution.md`: original dataset must be referenced) [V repo docs]; York's current page not readable; a search summary says the old SADIE page states Apache 2.0 and I found no direct SADIE II licence statement [U for SADIE II itself] | 20 subjects (2 dummy heads with 8,802 measurement points, 18 humans), HRIR and BRIR [U: search summary of arXiv 2505.01369]; 256 taps at 48 kHz [V: `spikes/audio-worklet/spatial/README.md` header]. Resonance's README lists "SADIE Binaural Measurements" as its core dependency [V]. Dense full-sphere grid makes SH fitting and MagLS clean |
| MIT KEMAR | MIT Media Lab 1994, "free, no restrictions on use, provided the authors" (the condition is cut off) [U: Debian copyright file via search] | 710 positions, 44.1 kHz, 128 taps (compact) [U]; libspatialaudio embeds it [V] |
| CIPIC | UC Regents: use "for any purpose", written acknowledgement requested for commercial products [U: Debian copyright file via search] | 45 subjects, 1,250 directions each, 44.1 kHz [U] |
| Resonance SH-HRIRs | Apache-2.0 (the repo) [V]; format and order of the data files not found in the tree listing [U] | Pre-computed SH-domain filters for its ambisonic binaural decoder [U]. Reference for the method only |

### Recommendation (scope 6)

Keep IRCAM for M1 and the bed (single data set, single acknowledgement, no change in sound); build the SH-domain bed filters from it offline and bake them as a second small blob (16 x 2 x 256 taps ~ 16 KB as i16 [U arithmetic: 16 x 2 x 256 x 2 B = 16,384 B]). Keep SADIE II as the better-conditioned alternative if the lower hemisphere or MagLS fit proves audibly weak.

## Recommendation per scope item

1. **Bed:** own encoder, own offline SH-HRIR tool (LS then MagLS), SAF ISC / Resonance Apache as references; no library dependency.
2. **Ambisonic clips:** AmbiX only (FuMa converted at import); WAV 4/9/16 ch first; Opus family 2/3 after a Symphonia test.
3. **Occlusion:** main-thread Rapier rays, budgeted round-robin, per-voice occlusion/obstruction values to the core, smoothing in the core; Steam Audio's 3-band transmission as a later layer.
4. **Reverb zones:** per-zone M1 convolver with phase offsets, per-voice sends, 2-zone crossfade, procedural default IRs.
5. **Doppler:** clamped, smoothed pitch factor, per-source level; no resampler change.
6. **HRIR:** IRCAM stays; SADIE II is the fallback.
7. **Event effects, LISTENER command:** outside this survey (no external prior art needed).

## Still unverified

- Steam Audio: occlusion/transmission internals, ray counts, update rates, the exact open-source date (docs host not reachable).
- Resonance: occlusion model, SH-HRIR data format, actual high-quality order and speaker layout (only from search summaries).
- SADIE II: current licence text, sizes, sample rates, whether it carries SH or virtual-loudspeaker data.
- MIT KEMAR and CIPIC licence wording, direction counts, sizes.
- OpenAIR: per-entry licences, B-format availability and licence.
- RFC 8486 details (family 2 vs 3 channel counts, demixing matrix), and whether Symphonia's Opus decoder reads family 2/3.
- FuMa-to-AmbiX conversion factors, FLAC and Vorbis channel limits.
- MagLS and SH-domain decode papers (only secondary summaries read); whether LS with the IRCAM grid (no data below -45 deg) sounds acceptable.
- Wwise/FMOD/Unity blend and occlusion behaviour (from memory or CryEngine/Audiokinetic Q&A summaries); "exclusion" is undefined in any source found.
- Doppler formula and Unity/Web Audio facts (from memory).
- Maintenance dates for SAF, libspatialaudio and Steam Audio (the fetched pages show no dates).
- Rust crates `voirs-spatial` and `audionimbus` (search listing only).
- Rapier 0.21's ray API in wasm beyond the repo's own use and the earlier spike.
