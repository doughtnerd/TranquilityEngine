# 0320. An event instance's sounding voices come from one walk

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0158, 0166, 0248

## Context

`EventInstance` (`src/plugins/audio/runtime/events/eventRuntime.ts`) is the one instance for 0158 events and for music events (0166 P6). Nine of its members (`panner`, `occlusion`, `reason`, `hasVoices`, `voiceCount`, `playing`, `fade`, `pause`, `resume`) each branched "if music, iterate `musicVoices()`, else `this.voices`", so each rule (what "the first voice's reason" means, what a fade reaches) was written twice. `musicVoices()` built a new array on every call, and the per-frame getters (`panner`, `occlusion` from `AudioSource`, `hasVoices` from the event system's holding list, `voiceCount` from the debug rows) called it. `playing` walked the music player a second way (`musicPlaying`: stems, then stingers, then loop tails into another new array). A new kind of music voice (stingers came with R5, loop tails and ringing runs with R4a) had to be added to both walkers, and the second walker had already drifted (stingers counted as live while `alive`, stems and tails only while `playing`).

## Decision

We will read an instance's sounding voices from one walk.

- **The music module decides which voices sound** (`music/soundingVoices.ts`): `soundingMusicVoices(player, out)` appends the playing and successor runs' stems, then each sub-state owner's voices: `stingerVoices` (`stingers.ts`, R5) and `loopTailVoices` (`loopTail.ts`, R4a: tails and ringing outgoing runs). `musicSounds(player, voices)` answers whether the music sounds or is about to: pending (`musicPending`), a stinger queued for its point, or any of those voices `playing`; a refused or stopped player is over. A new kind of music voice is added to `soundingMusicVoices` once. The instance only reads (0248's one-way seam).
- **The instance walks one list** (`EventInstance.sounding()`, private): its own 0158 voices, then its music's, into a scratch array the instance owns and refills on each call, so the per-frame reads allocate nothing. Every voice read and control (`panner`, `occlusion`, `reason`, `hasVoices`, `voiceCount`, `fade`, `pause`, `resume`, and the music half of `playing`) goes through it, with one rule each.
- **One liveness rule for "still playing":** a voice counts while `playing`, for every kind (stingers no longer count while merely `alive`); `hasVoices` still counts a fading voice (`alive`), for every kind.

## Alternatives considered

- **A visitor callback (`someVoice(fn)`) instead of a scratch list** — no shared buffer to clobber, but a closure per call on the per-frame getters is an allocation too, and early exit needs a sentinel return. The scratch list is read only inside the loop that asked for it; voice methods never call back into the instance.
- **Fold the music voices into `this.voices` as records** — `VoiceRec` carries 0158 state (bindings, loop, node, pitch) a stem does not have, and the music would no longer own its voices' lifetime.
- **Keep two walkers, only cache `musicVoices()`** — removes the allocation but keeps the second rule and the second place to add a voice kind.

## Consequences

**Positive**
- One place to add a music voice kind; the instance's reads and controls agree by construction.
- No allocation on the per-frame reads.

**Negative / costs**
- The scratch list is valid only until the next read; a future caller holding it across a voice call that re-enters the instance would see it refilled.
- A stinger that has been stopped (fading out) no longer keeps the instance `playing` (it still keeps its group held through `hasVoices`).

## Deprecates

`EventInstance.musicVoices()` and `musicPlaying()` (removed); the direct import of `loopTailVoices` and `musicPending` in `eventRuntime.ts`.

## Open questions

None.

## References

- Architecture review, pass 11, card 6.
- Test: `src/plugins/audio/runtime/music/soundingVoices.loopback.test.ts` (a music event with a stem, a loop tail and a stinger: count, pause, resume, fade on the core's output).
