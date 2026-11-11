**Verdict: approve with changes.** Top concerns: (1) positions stored in seconds, with no pre-entry/post-exit semantics, so a tempo fix drifts every cue and pickups and tails aren't defined; (2) no way to vary or sequence music inside a segment, no tempo ramps, and no grid-quantised stem or parameter changes, so "explore to combat" is expressible but a living score is not; (3) the iteration loop (DAW export to hearing it in play mode) and the live monitor are unspecified.

Read: record 0166 (full), goal.md, spikes/audio-music/README.md, research/README.md, and the 0158 event format code (`src/engine/audio/eventFormat.ts`, `mixer.ts`, `eventRuntime.ts`, `audioSystem.ts`, `voices.rs` at the lines cited). I did not read 0157, 0158 and 0162 in full, so I raise no point against them.

## Issues

1. **Positions in seconds (major).** Record §1 stores tempo markers and cues in seconds, as events do (`eventFormat.ts:103`). I author in bars. If I correct a stem set from 120 to 120.4 BPM, or re-bounce with a different pickup, every cue and region moves in seconds but not in bars. Change: store cues, regions and tempo markers as bar:beat:tick against the tempo map (seconds derived), as Wwise and FMOD both show them. Keep seconds only for the audio file's start offset.
2. **Pre-entry and post-exit are not defined (major).** The glossary says the part before the entry cue "plays early", but §1 gives no rule for the overlap. Change: say that a transition's start time is the entry cue minus the pre-entry length, that the planner's lead (§2) applies to that earlier start (not the grid point), and that a post-exit tail keeps ringing under the next segment until it ends, on its own ramp-less path. Without this the first bar after every cut is wrong.
3. **Loop tails (major).** "Stems must share one length" (§1) plus streamed loop regions means a reverb tail past the loop end is either cut or must be hand-baked. DAW bounces carry the tail. Change: a loop region may declare a wrap-overlap (tail mixed over the loop start), or a region's tail is the post-exit.
4. **MP3/Vorbis padding (major).** §3 recommends MP3 or Vorbis for stems. MP3 adds encoder delay and padding; a gapless trim is needed or stems drift against each other and loops click. Change: validation reads the LAME/Xing delay or Vorbis granule trim, and the record says whether the segment length is the trimmed length. The decoder README doesn't mention it.
5. **Stinger timing (minor).** §2 takes "the following grid point" if the next is closer than the lead (≈100 ms). A bar stinger can then be a whole bar late with no warning. Change: per stinger, `ifTooLate: nextGrid | playNow | skip`, and the stinger's own pre-entry so its hit lands on the grid.
6. **Ducking is frame-rate and voice-counting (minor).** `mixer.ts:155-210` and goal.md:89. Music ducking under dialogue lands off the beat and a duck can't follow signal. Change: record the limit and allow duck ramps on music buses to start on a stamped grid point through the in-voice ramp (§4).
7. **Rule scope in nested containers (minor).** §1 allows playlists and switches nested, but not which container's table applies when from and to sit under different parents. Change: state it (Wwise: the nearest common parent's matrix).

## My workflow

1. **Export stems from the DAW.** Eight 16-bit 48 kHz stems per cue, same length, with tails. Breaks at item 3 (tails) and item 4 (MP3 padding). I'd bounce WAV, so the editor must encode.
2. **Drop the files onto a new segment** (§9 import). The `acid` chunk gives BPM only if my bounce wrote it; Reaper and Logic bounces usually don't. I need a "set tempo from length and bar count" field (type 8 bars, get BPM) and tap-tempo. Breaks if I must type seconds.
3. **Set the tempo map.** Fine for 4/4 then 7/8. Breaks for an accelerando or a ritardando, which a step-marker map can't describe (see next section).
4. **Place cues:** entry, exit, "combat-hit", "tag". Snap to bars. Breaks on the seconds storage (item 1).
5. **Build explore and combat segments** with 4 stems each. Group stems under one lane colour. Breaks if I can't name a stem group for reuse.
6. **Intensity layers.** Fade stems 2-4 by a parameter with M2 curves. Works. Breaks when the fade lands mid-bar: I want "stem 3 enters at the next bar" and the record has no grid-quantised parameter response.
7. **Transitions.** Rules table: explore to combat on `exitCue` with a 1-bar crossfade; combat to explore through a bridge outro. The model is right here, and the Godot/Wwise precedence order is what I expect.
8. **Stingers.** A "secret found" hit at the next beat. Works for decoded clips. Breaks on timing (item 5).
9. **Audition in the editor**, through the real backend. I need to start A at bar 9 and trigger the rule, not only "audition this transition" from the top.
10. **Iterate in play mode.** I re-bounce one stem and want to hear it without restarting the game or the music. The record says nothing about reloading a primed or playing stem (rings are held, §3). This is the slowest step in Wwise too, so doing it well is a selling point.

## What I can't express

Listed against what I use in Wwise and FMOD. Each is in, partial or out.
- **Pre-entry, post-exit:** partial (undefined, issue 2).
- **Transition offsets and "sync to same time":** in (`enter: sameTime`, fade offset).
- **Random and sequence music tracks inside a segment** (a different tom fill or ostinato per bar, Wwise music tracks): out. Playlists work at segment level only, so variation means cutting segments into bars. Ask for a `random`/`sequence` track kind, picked at bar boundaries.
- **Nested music events:** in (containers nest), scope unclear (issue 7).
- **Music-driven ducking** (duck SFX on the kick, or side-chain): out. Only voice-count ducking exists (`mixer.ts:155-210`).
- **Per-stem effects** (reverb send, filter, a distortion insert per stem): partial. A stem has a bus and low-pass automation (§1), and events already carry `filter` and `sends` (`eventFormat.ts:238-240`). No per-stem send automation.
- **Multiple time signatures:** in (tempo map `beatsPerBar` and `beatUnit`).
- **Tempo ramps:** out. Markers are steps. Audio isn't time-stretched, so a ramp only matters for the grid under rubato or accelerando recordings. Ask for a marker flag `ramp: linear` to the next marker; the grid maths is still closed-form.
- **MIDI-driven tempo:** out. I'd want to import a tempo and marker track from a MIDI or DAW export (Reaper regions CSV). §1 reads only `acid`, `cue`, `smpl` and Ogg comments.
- **Stinger look-ahead:** partial (issue 5).
- **Quantised parameter changes** (stem on at next bar, state change held to a beat): out. Needs a quantisation field on the automation or switch.
- **Per-region conditional exits** (leave the loop only once the boss phase flag is set): in (`while`).
- **Sample-accurate chord and key tags for stingers** (pick the stinger by current harmony): out. Fine to defer; cue tags with a switch would cover it.

## What the editor must do

- **Show bars, not seconds.** Rulers in bar:beat with the tempo and metre lane; cues and regions snap to bars; seconds as a hover.
- **Stems:** stacked waveforms with solo, mute and per-stem gain in the segment view, loop-region audition including the wrap and its tail, and a meter.
- **Audition from anywhere:** play from a cue or a bar, trigger a parameter or a stinger while playing, and hear the real rule. Pick the "from" position, not just the rule.
- **Rules table:** a from by to grid with wildcards, the **effective rule highlighted** for any pair, and a "why this rule" readout showing which precedence step matched. Warn on shadowed or unreachable rules.
- **Validation lint on import:** length mismatch across stems, sample rate, channel layout, MP3 padding, silent stems, a tail longer than the loop.
- **Live monitor in play mode** (in the debug panel): current segment, bar and beat, the pending transition and its planned grid point, each stem's primed state, and `streamStartsLate`. If a transition fires late I must be able to see why.
- **Hot reload:** a changed stem or event file re-primes and swaps at the next bar while the game keeps running.
- **Tap tempo, tempo-from-length, and DAW import** (tempo and marker tracks) so a score doesn't start by typing numbers.
- **Undo and redo everywhere, and copy of a rule or a stem group** between segments.

## Cheaper alternatives

- Skip tempo ramps; allow a ramp only as steps of one bar each, authored by the composer.
- Skip random and sequence tracks in M4; ship variation as playlists with bar-length segments, and add tracks in M5.
- Skip MIDI import; ship CSV marker import (Reaper regions), which also serves cues.
- Skip music-driven ducking; the in-voice ramp plus a stinger-triggered duck on a bus covers most mixes.

## Questions for the author

1. Are cues and regions stored in bars (with the tempo map), and if not, what happens to them when a marker's BPM is edited?
2. What exactly is the planner's lead measured against when a segment has pre-entry?
3. Do MP3 and Vorbis stems get gapless trimming, and is the trimmed length the segment length?
4. Can a parameter or stem change be quantised to the grid in M4, and where is the field?
5. Does hot reload of a primed or playing stem exist in M4a, or only in M4d?
6. Which container's rule table applies for a transition between two nested containers?
