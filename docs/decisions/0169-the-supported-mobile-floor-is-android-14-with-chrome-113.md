# 0169. The supported mobile floor is Android 14 (API 34) with Chrome 113, on a Pixel 8 profile

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0155's "Android 7.x low-end phone that moves up on evidence")
- **Related:** 0155, 0157, 0166

## Context

ADR 0155 set the Android export's `minSdk` to 24 (Tauri's floor) and named an Android 7.x low-end phone as the reference device, to move up on evidence. The M4 listening pass (`docs/design/0166-audio-music/listening-pass.md`) gave the first evidence, on Android Emulator devices because no real phone is available:

- An emulated **Pixel 8, Android 14 (API 34), Chrome 113.0.5672.136, 2 GB RAM, 4 cores** runs the exported Flappy and Sound Lab with the audio core and the interactive music. Start-up under load clicks before settling (build log F-37, being fixed).
- An emulated **Pixel 4** on an older system image, also with 2 GB (the real phone has 6 GB), doesn't load the page at all (F-38). The likely causes are its system-image browser and the memory, not the engine; no engine change was made for it.

Chrome 113 is above every minimum the engine already documents (the audio core needs Chrome or WebView 91 for AudioWorklet and WebAssembly SIMD, `docs/guide/audio-minimum-versions.md`; the build targets ES2022, Chrome 94).

## Decision

We will support, and test against, this mobile floor:

- **Android 14 (API 34)** with **Chrome 113** (113.0.5672.136) or later, or an Android System WebView of the same version in an exported app;
- the reference profile is a **Pixel 8** with **2 GB RAM and 4 cores** (the owner's emulator), the smallest configuration known to run the engine.

"Supported" means: the samples load and play, bugs found there are fixed, and mobile claims in the guide refer to this floor. Below it the engine may still run (the audio core falls back to Babylon with one warning where it can't start), but it isn't tested and its bugs aren't fixed unless they also reproduce at the floor.

The Android export's `minSdk` stays 24: installing on an older phone isn't blocked, it just isn't supported. Raising `minSdk` would cut those phones off from games that work on them, which this decision doesn't need.

## Alternatives considered

- **Keep 0155's Android 7 reference phone.** No device or emulator for it was run, and the emulated Pixel 4 already fails to load; promising Android 7 would promise what nobody tests.
- **Raise `minSdk` to 34 as well.** It would match support to installability, but blocks working phones, and a game author can raise it in their own export when they choose.
- **Wait for a real device.** None is available; an emulated floor now beats none, and a real device can move it later.

## Consequences

**Positive**
- Mobile support claims match what has run. Chrome 113 leaves room for every feature the engine uses today.
- Older-phone reports have a clear rule: reproduce at the floor first.

**Negative / costs**
- The floor is an emulator, so its audio timing isn't a phone's: the listening pass's real-device items (P1, R1 to R9) stay deferred until a real device runs them.
- Android 14 and later is a minority of Android phones in use today; games still install below it, unsupported.

## Deprecates

0155's reference to an Android 7.x low-end phone as the supported device. Its `minSdk` 24 is kept.

## Open questions

- A real device at or near the floor, to move it on evidence (and to run the deferred real-device items).
- Whether an engine feature should ever require more than Chrome 113; if so, it amends this record.

## References

- `docs/design/0166-audio-music/build-log.md`: the owner's phone results, F-35, F-37, F-38.
- `docs/guide/audio-minimum-versions.md`: the audio core's own minimums (Chrome and WebView 91).
- ADR 0155: Android export through Tauri 2 mobile.
