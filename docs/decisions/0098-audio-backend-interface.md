# 0098. An internal audio backend interface, with Howler as the default implementation

- **Status:** Proposed; amended by 0157 (the interface gains a status channel, handles and priority)
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0097, 0099, 0010, 0006

## Context

`AudioSource` and `Audio` called Howler directly. A second implementation (FMOD, 0099) or a test double needs a seam, and 0010 says no library types appear in the public API.

## Decision

- **`AudioBackend`** (`audio/backend.ts`, internal): `play(req)` returns an `AudioVoice` (`setVolume`, `setPitch`, `setAttenuation`, `setPosition`, `setBus`, `pause`, `resume`, `stop`, `playing`); `setListener(pose)`; `configureBuses(mixer)`; `applyMix(resolvedBuses)`; `masterVolume`, `muted`; optional per-frame `update`, `dispose`.
- **`HowlerBackend`** (`audio/howlerBackend.ts`) is the default and keeps 0074's behaviour; it registers itself, and `audioBackend()` creates it on first use.
- **Selection.** `audio.backend` in `project.json` is `"howler"` (default) or `"fmod"`; `setAudioBackend()` swaps it (tests, the FMOD adapter). A failed FMOD load warns and keeps Howler.
- The mixer model (0097) stays outside backends and tells them the resolved state; backends own how it sounds.

## Alternatives considered

- **Strategy at the Howl level only.** Would leave routing and listener code in `AudioSource`.
- **A public pluggable backend API.** Premature; keeps the surface small until a second backend is real (0010).

## Consequences

**Positive**
- Component code has no library imports; backend tests use a plain fake.

**Negative / costs**
- One more layer; the interface is shaped by Howler and a not-yet-verified FMOD mapping, so expect a revision when FMOD is wired for real.

## Deprecates

Direct Howler use in `AudioSource.ts`.

## Open questions

- Event-style playback (FMOD events with parameters) has no place in the interface yet; see 0099.

## References

- `src/engine/audio/backend.ts`
