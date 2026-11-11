# Mid-engineer review: 0162 spatial audio (M3)

**Verdict: approve with changes.** The goal reads clearly and the glossary helps. The record describes the engine's internals more than the designer's workflow, and one section contradicts the current guides.

**Top 3 concerns**
1. §7 promises a Babylon fallback with an occlusion low-pass and event filters. The guides say the fallback has neither, and macOS desktop builds default to the fallback.
2. A reverb zone can sit there doing nothing. The record gives no default send level, no AudioSource field name, and no reason code the debug panel would show.
3. "My sound is muffled" has five possible causes, and the planned debug view cannot tell them apart.

## Issues

1. **blocking**: §7 contradicts the shipped docs. It says the fallback keeps "the existing per-voice low-pass" and adds "a `BiquadFilterNode` per instance". `docs/guide/sound-events.md:319` says there is "No per-voice low-pass" there, and `docs/guide/audio-mixer.md:48` says filters are skipped. `audio-mixer.md:42` makes the macOS desktop build default to Babylon, so Mac users would get walls that make sound quieter but not duller. **Change:** a per-feature table for the fallback (occlusion: gain only; reverb zones: one convolver; event filters: state which), and list the guides as files this record amends.

2. **major**: the reverb send is undefined. §4 (line 80) says voices reach zones through "a voice's (or event's) `reverbSend` level", but gives no default, and `AudioSource` (`src/plugins/audio/runtime/AudioSource.ts:59-77`) has no such field. The bus reverb is already called `reverb` with a `send` key (`audio-mixer.md:12,20`), so two "reverb sends" will be confused. **Change:** name the field, its default, its Inspector label and its event key; say whether a bus send is also needed; rename or explain the difference.

3. **major**: silent-zone cases are not handled. §4 fades the weakest of more than two zones with no warning. Wet at 0, the listener outside the box, and no `AudioListener` are not discussed. "Blend distance" is undefined (outside the box, or inside?). An IR that fails to load has no stated effect. **Change:** a console warning for each zone faded out, and a row in `why-no-sound.md` §4 (lines 48-55) for zones.

4. **major**: occlusion ranking is circular. §3 (line 73) rays the "16 most audible" sources, and audibility includes the occlusion gain (line 75). A muffled source ranks lower, so it is recast less often (up to 5 frames at 256 sources, 22 at 1,024, per `spikes/audio-spatial/README.md:24`). A door that opens may stay muffled for several frames. The spike measured "wrong" only for moving sources, not this lag. **Change:** rank by occlusion-free audibility, or recast any source whose occlusion changed last frame, and state the lag.

5. **major**: the opt-outs are missing from the user surface. `AudioSource.occlusion` and `dopplerLevel` (§3, §5) are not in `AudioSource.ts` or `docs/guide/playing-sound.md:41-49`, and `playOneShot` (`playing-sound.md:12-20`) gets no option. §3 says occlusion is "default on for spatial sources", so it is unclear what a flat source does. **Change:** list the fields in the field table, add the one-shot options, and state that `apply()`'s change signature (`AudioSource.ts:179`) and `applyEvent()` (`:161-173`) must include them.

6. **major**: ambisonic clips have no import contract. §2 says FuMa is "converted on import (sidecar flag)" but gives no key. Nothing says how a 4-channel WAV is recognised as ambisonic rather than a quad mix, what the author sees on import, or whether `spatial` on such a clip is ignored or refused. Loop behaviour is also silent. **Change:** name the sidecar key, the import message, and the spatial rule.

7. **minor**: Doppler units. §5 uses `audio.speedOfSound` in m/s, but game units are not stated. Also unclear: whether listener motion counts, what happens on a teleport (a pitch jump clamped to an octave), and the smoothing time.

8. **minor**: §8 gives 0.25 ms per frame, but the spike's p99 is 0.3-0.9 ms (`spikes/audio-spatial/README.md:49`). The record does not say what happens on overrun. **Change:** say rays are skipped and the source keeps its last occlusion, and show the age in debug.

9. **minor**: the HRTF default changes. `playing-sound.md:92` documents a default of 16. §1 cuts the high preset to 8. Say whether existing projects change.

10. **minor**: `why-no-sound.md:52` reports `virtual` for "too quiet to hear", so a fully occluded source would look like a distance problem. **Change:** an `occluded` reason, or a sub-cause on `virtual`.

## What was unclear

Terms with no definition, even after the glossary: **selection** and "selection ranking" (§1, §3); **panner kind** 0/1/2 and "HRTF slot"; **preset** (low/high, and what it sets); **M1/M2/M3**, **0157/0158**; **audibility** and "occluded-capable"; **tier**; **arena** (§2); **sidecar**; **zipper** (§3); **no-gap rule** (§3); **tripwire** (§8); **lazy module**; **LISTENER (0x20)** and "panner bits 2-3" (Context); **stagger/planner** (§4); **decoder worker** (§4); **material** (§3), which is never said to be user-editable; **blend distance** (§4).

Sentences:
- §3, line 73: "extra rays (up to 3 ...) only for the top few". Which few?
- §4, line 79: "overlaps blend equal-power". Blend between what, and by what weight?

Plain definitions I would want:
- **Selection:** the core's choice of which spatial voices get per-voice HRTF; the rest go to the bed or to equal power.
- **Blend distance:** the width outside a zone's box over which its weight fades from 0 to 1.
- **Occluder material:** a named preset for how much a wall lets through and how much it dulls the sound.
- **Ambisonic clip:** a recording of a whole sound field. It plays once, rotated to the listener, and has no position.

## Using it

- **Reverb zone (expected):** add an empty node, add `AudioReverbZone`, set the box, pick an IR (a preset name?), set wet and blend distance, set `reverbSend` on the source or event, play and walk in. **Not in the record:** the default send, the field's Inspector name, the procedural preset names, and whether the zone needs an `AudioListener`.
- **Wall muffles sound:** put `AudioOccluder` on the wall's collider and choose a material. The source must be spatial. **Not in the record:** what happens when the wall has no collider, whether a source standing inside a collider (a character) hits itself, and whether materials can be added.
- **Ambisonic ambience:** import a 4- or 16-channel WAV, mark it ambisonic in its sidecar, add an `AudioSource` with the clip, set gain, bus and loop. **Not in the record:** the sidecar key, what the import reports, whether the clip rotates to the camera or to the `AudioListener`, and whether `spatial` is allowed.
- **Doppler off for one source:** set `dopplerLevel = 0` on the `AudioSource`. **Not in the record:** whether it is an Inspector field, whether it reaches event instances, and how a one-shot would turn it off (it has no option).

## Tasks I could take

Suited to my level: a sample scene with one zone and one wall; a script that sets `reverbSend` and `occlusion` on existing sources; tests for the new debug fields and reasons; updating `playing-sound.md`, `why-no-sound.md` and `sound-events.md` once fields land; a listening checklist for the bed crossfade.

Risky for my level, pair with a senior: the bed encoder and decoder, the panner crossfade, occlusion ranking, worker IR preparation, ambisonic rotation (the maths), the wasm rebuild, and the arena's channel-count change.

## Debugging

- **"Reverb zone, nothing happens":** the debug panel needs each voice's reverb send, each zone's weight and whether it is active or faded, the IR load state, and a warning for each faded zone. Without these I would guess at the send and the box.
- **"Muffled, I don't know why":** a per-voice view of occlusion gain and cutoff, bus low-pass, snapshot low-pass, event low-pass automation, and whether the voice is in the bed or on HRTF. For occlusion, the ray's hit collider and its material. Five causes can each lower the top end. `why-no-sound.md` needs an occlusion section alongside its §9.

## Cheaper alternatives

- **Trigger volumes:** a designer-placed box sets a source's low-pass and bus send when the listener enters it. No rays, no ranking, and easy to debug. Keep the physics occluders for later.
- **Gain-only occlusion first:** ship the walls as volume drops, and add the low-pass once the fallback story is settled.
- **Ambisonic ambience as a first-order (4-channel) clip only:** smaller arena change, and cheaper to test.

## Questions for the author

1. What is the default `reverbSend`, and what sets it?
2. Is the §7 low-pass on Babylon intended? Will the two guides change?
3. What does a designer see when a third zone is placed?
4. What is the sidecar key for ambisonic clips, and what does import report?
5. Does an existing project's HRTF default move from 16 to 8?
6. Is `occlusion` per source, per event, or both? Does `playOneShot` get it?
7. What units does `speedOfSound` use, and does listener motion count for Doppler?
8. Does occlusion apply to one-shots with a `position`?
