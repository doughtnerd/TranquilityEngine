# M2 listening pass: the Sound Lab events page (ADR 0158, task E7.1)

The owner's listening pass for audio events, M2's exit item E7.1. Written by E5.1 from what the page is built to do; **nobody has auditioned it yet**, so every line below is an intention to check, not a finding. Mark each item pass or fail with a note, then sign at the end.

## Before you start
- `npm run dev`, open `/editor.html?sample=sound-lab`, press Play, click the game view once (sound starts after a gesture), then press **E** to open the events page (**B** goes back).
- Use headphones. Run it on the core backend (the default) and once with `audio.backend: "babylon"` in `samples/sound-lab/project.json` (the fallback: no per-voice low-pass, streamed clips loop whole).
- The music starts about 2 s after the page loads (it waits for Intensity to settle at 0, by design).

## Footsteps (keys 1–4, W, Shift+W)
`footstep.audioevent.json`: a switch on the global labelled parameter `Surface`, each surface a random of 3 clips (`avoidRepeat` 1) with random pitch and volume, on the Foley bus.
- [ ] Keys 1–4 pick a surface and take one step: grass a soft swish, gravel a crunch of grains, wood a hollow knock, metal a ringing clang.
- [ ] Hold W to walk, Shift+W to run (faster, a touch higher): no obvious repeat; pitch varies slightly from step to step.
- [ ] Change surface while walking: the next step is on the new surface.

## Engine, blended (E, Up, Right)
`engine.audioevent.json`: a sustain container: start clip, then a loop that blends idle/mid/high clips on `RPM` (with pitch automation), then an engine-off clip on release (`release: "now"`, 0.12 s crossfade).
- [ ] E: a starter whine, ragged firing, settling into idle.
- [ ] Hold Up (full throttle) and Right (half): a smooth idle → mid → high crossfade with rising pitch; no pulsing, no seam at the loop point (0.15–1.15 s).
- [ ] E again: the loop fades over about 0.12 s into the spin-down and thump.

## Engine, single clip (T)
`engine-single.audioevent.json`: one clip with a sustain loop region (0.5–1.5 s): run-up, loop, then the tail on release.
- [ ] T: run-up, a steady loop; T again: it plays on into the spin-down with no click at the join.
- [ ] Compare with the blended engine.

## Music (N, M)
`music-intensity.audioevent.json` through an `AudioSource`: pad, pulse and lead layers; the global `Intensity` (0–1, seek 0.5/s) fades the pulse in over 0.2–0.6 and the lead over 0.6–1; the Music bus also gets louder (0.45 → 1) and brighter (low-pass 900 Hz → 18 kHz).
- [ ] At intensity 0: a dull, quiet pad.
- [ ] Each M press glides smoothly (about 2 s), with no zipper noise; N goes back down.
- [ ] The pulse arrives around 0.5, the lead around 0.75–1, and the bus opens up brighter; the three layers stay in time.

## Notes and known behaviours
- Starting the other engine, or a new one while a tail plays, cuts the old one with a 0.1 s fade (the events' `limit` is one instance).
- The event cooldown runs on wall-clock time, not the audio clock.

## Sign-off
- Core backend: pass / fail, date, machine:
- Babylon fallback: pass / fail, date, machine:
- Signed:
