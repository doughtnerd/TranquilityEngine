# RFC review of ADR 0162: sound designer

Reviewer: game sound designer, 10 years of Wwise and FMOD (rooms and portals, occlusion, ambisonic ambiences). Record: `docs/decisions/0162-spatial-audio-ambisonic-bed-occlusion-and-reverb-zones.md` (0162).

## Verdict: approve with changes

The engineering is sound and the budget story is honest. For authoring, the record is thin. It says what the runtime does and almost nothing about what I touch every day. Three of my concerns need to be in the record before it is accepted.

**Top 3 concerns**
1. Reverb is a zone volume around the **listener** only, with no per-source room (0162:79-80). Two sources in different rooms hear the same reverb. That is a different model from Wwise rooms, and the record doesn't say so.
2. The occlusion model is a gain plus one low-pass per voice. It does not touch the wet path, and it has no obstruction (0162:22, 139). Behind a wall, the reverb of the sound's own room will be too loud and too bright.
3. Authoring and auditioning are a gizmo list (0162:100-102). There is no stated audition path (in-editor Play while hearing zones), no per-material tuning loop, and no way to hear a wrong default.

## Issues

1. **blocking. Zone weights come from the listener only.** 0162:79 computes weights "from the listener's position". Sends are "a bus's and a voice's `reverbSend` level times the zone weights" (0162:80). A footstep in a cave heard from the street gets the street's reverb. Fix: state this limit in the record. Add a source-side zone lookup (the zone containing the emitter picks the send target), which costs main-thread point-in-volume tests. Or declare it a non-goal and name the workaround.
2. **blocking. Occlusion ignores the reverb send.** 0162:75 outputs "occlusion gain and low-pass" per voice. Wwise occlusion also attenuates the wet path, and obstruction attenuates only the direct path. Fix: add a per-voice `wetOcclusion` factor, so a fully occluded source loses its send as well. Pull the cheap form of obstruction forward from the "later" list (0162:139): direct path occluded, send untouched.
3. **major. Zone limit and zone switching under authoring.** At most 2 zones blend (0162:80); 4 s IRs cost 6.1 MB each (0162:48). A corridor of 3 small rooms is normal level design. Fix: define what "weakest fade out" sounds like, and make the editor warn on overlap above the preset's limit. Say whether the zone tail rings out when you leave (it must, or the reverb cuts).
4. **major. Distance-based reverb is not specified.** Real rooms get a higher wet ratio with distance. A flat `reverbSend` (0162:80) sounds close-miked at every distance. Fix: a send-versus-distance curve per source or event, defaulting to a gentle rise from `minDistance` to `maxDistance`.
5. **major. Occlusion has no authoring loop for thickness and openings.** One centre ray, up to 3 extra rays for the top few, up to 3 occluders (0162:73). A door or window gap passes through nothing and so is open, which is right. A thin wall plus a thin door counts as two hits, which stacks. Fix: let `AudioOccluder` carry an optional thickness override, or document that transmission is per hit, not per metre. Say how a door opening (collider enabled and disabled) is handled. 0162:140 leaves it unmeasured, and doors are the first thing every level has.
6. **major. Ambisonic clips: orientation only, no authoring controls.** 0162:68 gives gain and bus. Missing: a rotation offset (so the recording's front lines up with the level), a send, and a low-pass for occlusion by an indoor/outdoor switch. Fix: add `yaw` offset and send to the clip's fields.
7. **major. The bed erases source size.** Distant voices lose spread and focus because encoding is a point source (0162:61). Fix: record `spread` (degrees) as deferred, and require that the bed encoder leaves room for an order-weighted spread (cheap in the SH domain).
8. **major. Hard switch from per-voice HRTF to the bed.** 0162:127 admits a 1-4 dB dip "to be listened to", and 16 to 8 HRTF voices (0162:61) means a 9th-nearest enemy is localised differently from the 8th. The ranking is by audibility (0162:75), so a loud far sound can steal a slot. Fix: add hysteresis (a minimum time in a panner kind) and show the kind in the debug panel per voice.
9. **minor. Elevation.** Below -45 degrees the data is wrong by 8-20 dB (0162:44, 63). In a multi-storey level, a sound under the player is the common case. Make SADIE II not an "open question" (0162:137) but a gate: listen to a floor-below case before accepting.
10. **minor. Event `filter` and `sends` shapes** (0162:89) don't say whether `sends` is per bus name or per effect bus, or whether `cutoff` is automatable per instance by distance. Fix: one example event JSON in the record.
11. **minor. Doppler.** Default 1 and ±1 octave clamp (0162:86) will make fast projectiles and teleports audibly glide. Add a teleport/jump guard (no Doppler on a position delta above N m/frame) and default Doppler to off for UI and one-shots.
12. **minor. Fallback parity.** Babylon gets 1 zone with gain blend, truncated ambisonics (0162:92). Acceptable, but the editor audition should show which backend it is running, since it will sound different.

## Workflow

A day on one level: place zones, place occluders, assign materials, listen.

- **Smooth:** components placed like colliders (0162:101), one IR asset per zone, sends on buses I already know (`docs/guide/audio-mixer.md:12-16`, the `reverb` bus effect with `send`). Event filters and sends (0162:89) mean I stop making one bus per wall type.
- **Painful, predicted:** (a) hearing the result requires Play and a walk-through; the record has no "listener at editor camera" audition. (b) The occlusion debug view is a viewport overlay (0162:102) but shows rays, not what I hear: I want the current occlusion dB and cutoff per voice in the Audio Debug panel. (c) IR assets are WAV/FLAC only with "a few procedural presets" (0162:79); I would want to audition IRs on a test sound inside the Inspector before assigning. (d) A material table of "wood, concrete, glass, metal, cloth…" (0162:74) with no way to edit the values per project is a trap; I will want to tune concrete up by 6 dB the first week.
- **Iteration speed:** no live editing statement. Changing a zone's wet level, blend distance or a material cutoff in the Inspector must apply while Play is running. The record is silent.

## What I can't express

| Wwise/FMOD | In 0162 | M3 matters? |
|---|---|---|
| Rooms and portals, with portal-to-portal propagation | No: zones are volumes, no portals (0162:79) | Wait, but document that zones are not rooms |
| Source-side room membership | No (issue 1) | **Yes** |
| Obstruction vs occlusion, wet path ducking | Occlusion only, direct path (0162:22, 139) | **Yes**, cheap form |
| Diffraction around corners | No | Wait. Fake with obstruction plus smoothing |
| Per-bus reverb sends (bus x zone) | Yes, via send levels (0162:80) | Fine |
| Distance-based wet | No (issue 4) | **Yes** |
| Listener-based vs emitter-based zones | Listener only | **Yes**, emitter side |
| Ambisonic bed order | Fixed 3rd (0162:61) | Fine, no need for selectable order |
| Spread / focus / source size | No (issue 7) | Wait, keep the encoder open |
| Height / elevation | Data gap below -45 degrees (0162:44) | **Yes** for multi-storey |
| Cone / directivity | Not mentioned | Wait |
| Early reflections per room | None (late tail only, IR) | Wait |
| Frequency-dependent transmission (3 bands) | Later (0162:54, 139) | Wait |

## Defaults

- **Zone wet level and blend distance.** Without defaults named, a new zone must start at a conservative wet and a blend distance of about 2 m, not 0 (a pop at the doorway) and not large.
- **Occlusion on by default for every spatial source** (0162:76), against an `AudioOccluder` layer that nothing is on, so the default is no change. Fine. But a default material: set "concrete" and not "none", or a placed occluder does nothing and the designer thinks it is broken.
- **Rolloff inconsistency.** `AudioSource` defaults to `maxDistance` 100 (`src/plugins/audio/runtime/AudioSource.ts:68-72`) while the event guide shows 30 (`docs/guide/sound-events.md:39`). The bed pulls the far voices in this range, so the same footstep changes panner at different distances. Align them.
- **Doppler on at 1** (0162:86) will be heard on every moving emitter, including music from a moving object. Off by default for events on the Music and UI buses.
- **Smoothing 100 ms** (0162:75) is right for a wall; a door that slams shut will feel late. Provide a per-material attack.
- **Budget default of 0.25 ms** (0162:73) means a 256-source scene refreshes in 5 frames; a fast-moving player will hear sources open up late. Acceptable.

## Listening tests

The owner's M2 pass (`docs/design/0157-audio-core/m2-listening-pass.md:3-46`) is a checklist of intentions, one item per feature. M3 needs the same, headphones on, plus:
1. Walk past a source crossing the 8-voice HRTF boundary, both directions: no dip, no jump in position (0162:127; `spikes/audio-spatial/README.md:18`).
2. A source above, below (the -45 degree gap), behind and at the sides; compare bed against per-voice HRTF.
3. Walk through wall, door (open and closed) and corner: no zipper, no late opening, wet path behaviour.
4. Walk from room A to B to C with 2 s and 4 s IRs: no tail cut, no pop, no stolen-zone surprise.
5. A source in room A heard from room B (issue 1).
6. Loud close source plus 200 quiet ones: the bed must not mask or smear the close one.
7. Ambisonic ambience: turn on the spot at 1st and 3rd order; level and image match with the fallback.
8. Doppler: a fast pass at 1x, and a teleport.
9. Babylon fallback, once, listing what is missing.
10. Silence check: nothing audible when everything is idle (bed decoder noise, denormals).
Record the same pass/fail format and sign-off block as M2.

## Cheaper alternatives

- Ship **obstruction** (direct only) before frequency-dependent anything: the same ray, one more gain.
- **Source-side zone** as a single lookup per source per 4 frames beats portals and costs nothing in the core.
- **Fixed-order selectable bed** is not needed; keep 3rd.
- **Spread** via SH-domain order weighting, not geometry.
- Material table as a project asset (data), not code, for free tuning.

## Questions for the author

1. Is the listener-only zone weight (0162:79) deliberate, and what do you recommend for a sound heard through a door from another room?
2. Does occlusion reduce the reverb send? If not, why not?
3. Can the Inspector edit zones, materials and wet levels live during Play?
4. What is audible when a third zone becomes relevant (0162:80)?
5. Is the material table user-editable, and what are the values?
6. How are opening and closing doors reported to the occluder (enabled flag, moving collider)?
7. Will the Audio Debug panel show per-voice panner kind, occlusion dB and cutoff, and zone weights?
8. What is the gate for the below-horizon data: who listens, and with what stimulus?
