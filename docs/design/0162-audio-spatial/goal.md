# Audio M3 (spatial): goal and constraints

Step 1 of the design pipeline (goal interview), confirmed by the owner on 2026-11-11. The decision record (0162, to be written) and the technical design build on this; where they differ, this owner-confirmed statement wins until the owner changes it.

## Goal
AAA-quality spatial audio built into the engine, as part of ADR 0157's goal: "AAA-quality mixing and control built into the engine," for an engine meant for fully open-source use. M3 is the spatial milestone on 0157's roadmap.

## Scope (owner: "everything the roadmap and design docs mention for M3", plus ambisonic clips)
1. A 3rd-order ambisonic **bed** for distant voices: panner kind 2 (reserved in PLAY since M1), encoded per voice into one shared bed and decoded once through M1's HRIR set (architecture §10).
2. **Ambisonic clips** (recorded B-format ambiences that rotate with the listener): **in** (owner).
3. **Occlusion** through physics ray queries under a frame-share budget (the audio system's order is attenuation → occlusion slot → audibility → selection; per-voice low-pass exists; physics through a World service, 0135).
4. **Reverb zones** on M1's ported staged convolver, with **non-uniform convolution** (tail phase offsets so convolvers never share a tail quantum).
5. **Doppler.**
6. **Event effects** deferred from ADR 0158: an event's own filter or send.
7. The `LISTENER` command reserved for M3 in the wire format.

## Constraints
- **Licence:** open source only; no per-title licences. BSD/MIT (and similarly permissive) code may be ported in with its notices kept, as M1 did with Chromium's DSP.
- **Platforms:** the editor on desktop and web; published games on web, desktop and Android (system WebView). The Babylon fallback serves engines without AudioWorklet (macOS desktop today).
- **Fallback (owner):** **best effort** on Babylon; the full feature set on the core.
- **Authoring (owner):** reverb zones and occluders are **editor components**, placed and previewed in the scene like colliders.
- **Budget (owner: option c):** M3 gets its own audio-thread budget **and** makes room by mixing fewer per-voice HRTF voices where the bed takes distant voices, decided from measurements. Size gates are tripwires for bloat, not design limits (0158). The low end moves up rather than squeezing the design (0157).
- **Low-end device:** an Android phone on the lowest Android version Google Play accepts, playing the web build ("low" preset: 64 voices, one reverb; a starting point). **Phone numbers stay marked unverified for now** (owner); the reference-class numbers come from spikes here, and the lab-VM run is the owner's (as for M2, E5.5).
- **Users:** players hear it; developers script it; sound designers author it in the editor.

## What exists (M1, M2)
- Per-voice HRTF for the nearest voices (16 on high), Chromium's HRTF ported, panner kinds 0 equal-power / 1 HRTF; selection ranks voices and crossfades panner kinds.
- M1's ported staged convolver (one reverb per bus effect today); microfft as the FFT.
- Per-voice and per-bus low-pass; M2's automation (parameters, curves) in the core; event instances (`group`).
- Old spikes (`spikes/audio-worklet/spatial`, `occlusion`), mostly single runs on one machine: 3rd-order ambisonics + binaural decode at 256 voices 7–13% of a quantum (realfft, not microfft); 4 s stereo non-uniform convolution ≈ 0.1 ms average with rare maxima to 1.67 ms; Rapier `castRay` 1.5–4.3 µs. Not at this design's evidence bar.
