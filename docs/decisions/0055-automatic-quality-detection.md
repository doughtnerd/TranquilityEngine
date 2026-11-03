# 0055. Automatic graphics quality: a first guess from the GPU, then adjusting to the frame rate

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0050

## Context

Quality tiers (0050) start at the project's default until the player picks one. A game shipped to everything from integrated laptop GPUs to gaming desktops needs a better start than "High for everyone". ADR 0050 left automatic detection open. Browsers expose a little about the GPU (`WEBGL_debug_renderer_info`, where available), core count (`navigator.hardwareConcurrency`) and, in Chromium, `navigator.deviceMemory`. The most reliable signal is the frame rate the game actually reaches.

## Decision

- `project.json`'s `graphics` section gains `autoDetect` (default **false**, so existing projects behave as before). With it on, and no saved player choice, the Engine picks the tier itself.
- **First guess, at start**, from `guessTier(info)`, a pure function over the GPU renderer string, core count, device memory and screen pixels:
  - Software renderers (SwiftShader, llvmpipe, Microsoft Basic Render) get the lowest tier.
  - Known integrated or mobile GPUs (Intel UHD/Iris, Mali, Adreno, PowerVR, Apple below the M-series Pro/Max) get the second lowest, or the lowest on small memory.
  - Known discrete or high-end GPUs (NVIDIA RTX/GTX, AMD Radeon RX, Apple M Pro/Max/Ultra) get the default tier, and the top tier on 8+ cores with 8+ GB.
  - Anything unknown gets the project's default.
  - The guess is mapped onto the project's own tiers by position (lowest, second, default, highest).
- **Then adjust, during play.** A `FrameMonitor` watches frame times for the first 10 seconds after the first scene finishes loading. Load hitches are skipped.
  - If the median stays above 1.4× the target (60 fps by default, `targetFrameRate` in the section), it steps down one tier, waits 3 seconds, and checks again, down to the lowest tier.
  - It never steps up on its own.
  - The chosen tier is saved as `graphics.autoQuality` in Storage. Unlike a player's own choice, this marks it as detected: a later player choice replaces it, and detection never overrides a player's choice.
- `Graphics.detectQuality()` runs the GPU guess on demand (for a "Detect" button in a game's options), and `Graphics.autoDetected` says whether the active tier came from detection.
- The editor never auto-detects; the scene view's Quality menu keeps the preview tier.

## Alternatives considered

- **A benchmark scene at start.** Accurate, but it delays start and needs content; the first seconds of the real game are a better benchmark.
- **Continuous adaptive quality (stepping up and down all the time).** Visible quality flicker; one-way, early stepping down is the common practice.
- **Detection on by default.** Surprising for existing projects, and headless test browsers (software rendering) would always drop to Low.

## Consequences

**Positive**
- Games start at a sensible tier and settle within seconds; players can still choose.

**Negative / costs**
- GPU strings are coarse, masked by some browsers, and change over time; the frame monitor is the safety net.
- The step-down can happen during play, a few seconds in, which may cause a short hitch as shadows or effects change.

## Deprecates

Nothing.

## Open questions

- Per-platform defaults for desktop and web builds; stepping up after sustained headroom.
